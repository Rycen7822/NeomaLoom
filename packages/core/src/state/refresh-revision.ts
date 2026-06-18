import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { InventoryFile } from '../files/file-inventory.js';
import { assertWritableStatePath, appendFileInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { applySpanMigrations } from '../spans/db.js';
import type { RepoEdge, RepoSpan } from '../spans/types.js';
import { ensureStateDir } from './state-dir.js';

type Statement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function resetSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS repo_files;
    DROP TABLE IF EXISTS repo_spans;
    DROP TABLE IF EXISTS repo_edges;
    DROP TABLE IF EXISTS repo_evidence;
    DROP TABLE IF EXISTS refresh_revisions;
    DROP TABLE IF EXISTS repo_spans_fts;
  `);
  applySpanMigrations(db);
}

type RevisionRow = {
  graph_revision: string;
  project_root: string;
  target: string;
  started_at: number;
  finished_at: number;
  file_count: number;
  span_count: number;
  edge_count: number;
  warnings_json: string;
};

function readExistingRevisions(db: Database): RevisionRow[] {
  try {
    return db
      .prepare(
        `SELECT graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json
         FROM refresh_revisions
         ORDER BY finished_at ASC`
      )
      .all() as RevisionRow[];
  } catch {
    return [];
  }
}

export function createGraphRevision(input: {
  target: string;
  files: InventoryFile[];
  spans: RepoSpan[];
  edges: RepoEdge[];
  nonce?: string | number;
}): string {
  return `rev-${sha1(
    JSON.stringify({
      target: input.target,
      nonce: input.nonce,
      files: input.files.map(file => [file.path, file.contentHash]).sort(),
      spans: input.spans.map(span => span.spanId).sort(),
      edges: input.edges.map(edge => edge.edgeId).sort()
    })
  ).slice(0, 16)}`;
}

export async function readLatestRevision(projectRoot: string): Promise<string | undefined> {
  const paths = await ensureStateDir(projectRoot);
  try {
    const db = openDatabase(path.join(paths.spansDir, 'spans.db'));
    try {
      const row = db
        .prepare('SELECT graph_revision AS graphRevision FROM refresh_revisions ORDER BY finished_at DESC LIMIT 1')
        .get() as { graphRevision?: string } | undefined;
      return row?.graphRevision;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function writeRefreshRevision(input: {
  projectRoot: string;
  graphRevision: string;
  target: string;
  startedAt: number;
  finishedAt: number;
  files: InventoryFile[];
  spans: RepoSpan[];
  edges: RepoEdge[];
  warnings: string[];
}): Promise<string> {
  const paths = await ensureStateDir(input.projectRoot);
  const dbPath = assertWritableStatePath(paths.projectRoot, path.join(paths.spansDir, 'spans.db'));
  const db = openDatabase(dbPath);

  try {
    const existingRevisions = readExistingRevisions(db);
    resetSchema(db);
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSpan = db.prepare(
      `INSERT INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, start_column, end_column, parent_span_id, language,
         heading_path_json, symbol_path_json, anchor, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSpanFts = db.prepare(
      `INSERT INTO repo_spans_fts
        (span_id, path, kind, role, label, heading_path, symbol_path, indexed_text, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEdge = db.prepare(
      `INSERT INTO repo_edges
        (edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertRevision = db.prepare(
      `INSERT INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const file of input.files) {
      insertFile.run(
        file.path,
        file.absolutePath,
        file.role,
        file.language,
        file.contentHash,
        file.sizeBytes,
        file.modifiedAt,
        file.indexedAt,
        file.generated ? 1 : 0,
        file.ignored ? 1 : 0,
        JSON.stringify({ oversized: file.oversized, fileOnlySpan: file.fileOnlySpan })
      );
    }
    for (const span of input.spans) {
      insertSpan.run(
        span.spanId,
        span.path,
        span.kind,
        span.role,
        span.label,
        span.startLine,
        span.endLine,
        span.startColumn ?? null,
        span.endColumn ?? null,
        span.parentSpanId ?? null,
        span.language,
        JSON.stringify(span.headingPath),
        JSON.stringify(span.symbolPath),
        span.anchor ?? null,
        JSON.stringify(span.stableLocator),
        span.textHash,
        span.indexedText,
        span.summary,
        JSON.stringify(span.metadata),
        span.source,
        span.updatedAt
      );
      insertSpanFts.run(
        span.spanId,
        span.path,
        span.kind,
        span.role,
        span.label,
        JSON.stringify(span.headingPath),
        JSON.stringify(span.symbolPath),
        span.indexedText,
        span.summary
      );
    }
    for (const edge of input.edges) {
      insertEdge.run(
        edge.edgeId,
        edge.sourceSpanId,
        edge.targetSpanId,
        edge.relation,
        edge.confidence,
        edge.source,
        JSON.stringify(edge.evidence),
        edge.updatedAt
      );
    }
    for (const revision of existingRevisions) {
      insertRevision.run(
        revision.graph_revision,
        revision.project_root,
        revision.target,
        revision.started_at,
        revision.finished_at,
        revision.file_count,
        revision.span_count,
        revision.edge_count,
        revision.warnings_json
      );
    }
    insertRevision.run(
      input.graphRevision,
      paths.projectRoot,
      input.target,
      input.startedAt,
      input.finishedAt,
      input.files.length,
      input.spans.length,
      input.edges.length,
      JSON.stringify(input.warnings)
    );
  } finally {
    db.close();
  }

  await writeFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, 'latest-revision.json'),
    `${JSON.stringify({ graphRevision: input.graphRevision, target: input.target }, null, 2)}\n`
  );
  await appendFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, 'refresh.jsonl'),
    `${JSON.stringify({
      graphRevision: input.graphRevision,
      target: input.target,
      fileCount: input.files.length,
      spanCount: input.spans.length,
      edgeCount: input.edges.length,
      warnings: input.warnings
    })}\n`
  );
  return dbPath;
}
