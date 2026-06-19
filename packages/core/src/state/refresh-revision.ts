import { rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { InventoryFile } from '../files/file-inventory.js';
import { assertWritableStatePath, appendFileInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { applySpanMigrations } from '../spans/db.js';
import type { RepoEdge, RepoSpan } from '../spans/types.js';
import { ensureStateDir } from './state-dir.js';
import { resolveNoemaLoomPaths } from './paths.js';

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

export type IndexCoverage = {
  inventory: 'missing' | 'full';
  deepSpans: 'none' | 'scoped' | 'full';
  hotsetRevision: string | null;
  hotFiles: number;
  coldFiles: number;
  unindexedCandidateCount?: number;
  updatedAt?: number;
};

export const EMPTY_INDEX_COVERAGE: IndexCoverage = {
  inventory: 'missing',
  deepSpans: 'none',
  hotsetRevision: null,
  hotFiles: 0,
  coldFiles: 0,
  unindexedCandidateCount: 0
};

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

const MAX_REPO_SPAN_INDEXED_TEXT_BYTES = 8192;
const MAX_REPO_SPAN_LABEL_BYTES = 1024;
const MAX_REPO_SPAN_SUMMARY_BYTES = 2048;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const suffix = '\n…[truncated]';
  const suffixBytes = byteLength(suffix);
  let output = '';
  let used = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (used + charBytes + suffixBytes > maxBytes) {
      break;
    }
    output += char;
    used += charBytes;
  }
  return `${output}${suffix}`;
}

function boundedIndexedText(span: RepoSpan): { indexedText: string; metadata: Record<string, unknown> } {
  const originalBytes = byteLength(span.indexedText);
  if (originalBytes <= MAX_REPO_SPAN_INDEXED_TEXT_BYTES) {
    return { indexedText: span.indexedText, metadata: span.metadata };
  }
  return {
    indexedText: truncateUtf8(span.indexedText, MAX_REPO_SPAN_INDEXED_TEXT_BYTES),
    metadata: {
      ...span.metadata,
      indexedTextTruncatedAtWrite: true,
      originalIndexedTextBytes: originalBytes,
      originalIndexedTextHash: sha1(span.indexedText)
    }
  };
}

function boundedField(value: string, maxBytes: number): string {
  return byteLength(value) <= maxBytes ? value : truncateUtf8(value, maxBytes);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function unlinkIfExists(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function unlinkSqliteTempIfExists(targetPath: string): Promise<void> {
  for (const candidate of [targetPath, `${targetPath}-journal`, `${targetPath}-wal`, `${targetPath}-shm`]) {
    await unlinkIfExists(candidate);
  }
}

function resetSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS repo_files;
    DROP TABLE IF EXISTS repo_spans;
    DROP TABLE IF EXISTS repo_edges;
    DROP TABLE IF EXISTS repo_evidence;
    DROP TABLE IF EXISTS refresh_revisions;
    DROP TABLE IF EXISTS index_metadata;
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
  const paths = resolveNoemaLoomPaths(projectRoot);
  const dbPath = path.join(paths.spansDir, 'spans.db');
  if (!(await fileExists(dbPath))) {
    return undefined;
  }
  try {
    const db = openDatabase(dbPath);
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

export async function readIndexCoverage(projectRoot: string): Promise<IndexCoverage | undefined> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const dbPath = path.join(paths.spansDir, 'spans.db');
  if (!(await fileExists(dbPath))) {
    return undefined;
  }
  try {
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT value_json AS valueJson FROM index_metadata WHERE key = 'coverage'").get() as
        | { valueJson?: string }
        | undefined;
      if (!row?.valueJson) {
        return undefined;
      }
      const parsed = JSON.parse(row.valueJson) as Partial<IndexCoverage>;
      if (parsed.inventory !== 'full' && parsed.inventory !== 'missing') {
        return undefined;
      }
      if (!['none', 'scoped', 'full'].includes(String(parsed.deepSpans))) {
        return undefined;
      }
      return {
        inventory: parsed.inventory,
        deepSpans: parsed.deepSpans as IndexCoverage['deepSpans'],
        hotsetRevision: typeof parsed.hotsetRevision === 'string' ? parsed.hotsetRevision : null,
        hotFiles: Number(parsed.hotFiles ?? 0),
        coldFiles: Number(parsed.coldFiles ?? 0),
        unindexedCandidateCount: Number(parsed.unindexedCandidateCount ?? 0),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined
      };
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
  coverage?: IndexCoverage;
}): Promise<string> {
  const paths = await ensureStateDir(input.projectRoot);
  const dbPath = assertWritableStatePath(paths.projectRoot, path.join(paths.spansDir, 'spans.db'));
  const tempDbPath = assertWritableStatePath(
    paths.projectRoot,
    path.join(paths.spansDir, `spans.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp.db`)
  );
  let existingRevisions: RevisionRow[] = [];
  if (await fileExists(dbPath)) {
    const existingDb = openDatabase(dbPath);
    try {
      existingRevisions = readExistingRevisions(existingDb);
    } finally {
      existingDb.close();
    }
  }
  await unlinkSqliteTempIfExists(tempDbPath);
  const db = openDatabase(tempDbPath);
  let wroteSuccessfully = false;
  let transactionActive = false;

  try {
    resetSchema(db);
    db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA temp_store = MEMORY; BEGIN IMMEDIATE;');
    transactionActive = true;
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
    const upsertMetadata = db.prepare(
      `INSERT INTO index_metadata (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
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
      const bounded = boundedIndexedText(span);
      const boundedLabel = boundedField(span.label, MAX_REPO_SPAN_LABEL_BYTES);
      const boundedSummary = boundedField(span.summary, MAX_REPO_SPAN_SUMMARY_BYTES);
      insertSpan.run(
        span.spanId,
        span.path,
        span.kind,
        span.role,
        boundedLabel,
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
        bounded.indexedText,
        boundedSummary,
        JSON.stringify(bounded.metadata),
        span.source,
        span.updatedAt
      );
      insertSpanFts.run(
        span.spanId,
        span.path,
        span.kind,
        span.role,
        boundedLabel,
        JSON.stringify(span.headingPath),
        JSON.stringify(span.symbolPath),
        bounded.indexedText,
        boundedSummary
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
    if (input.coverage) {
      const updatedAt = input.coverage.updatedAt ?? input.finishedAt;
      upsertMetadata.run('coverage', JSON.stringify({ ...input.coverage, updatedAt }), updatedAt);
    }
    db.exec('COMMIT');
    transactionActive = false;
    wroteSuccessfully = true;
  } finally {
    if (transactionActive) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Best effort: failed temp databases are removed below.
      }
    }
    db.close();
    if (!wroteSuccessfully) {
      await unlinkSqliteTempIfExists(tempDbPath);
    }
  }

  await rename(tempDbPath, dbPath);

  await writeFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, 'latest-revision.json'),
    `${JSON.stringify({ graphRevision: input.graphRevision, target: input.target, coverage: input.coverage ?? null }, null, 2)}\n`
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
      coverage: input.coverage ?? null,
      warnings: input.warnings
    })}\n`
  );
  return dbPath;
}
