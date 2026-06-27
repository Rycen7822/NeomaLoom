import { rename, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { InventoryFile } from '../files/file-inventory.js';
import { assertWritableStatePath, appendFileInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { redactText } from '../safety/redaction.js';
import { applySpanMigrations } from '../spans/db.js';
import {
  byteLengthUtf8,
  MAX_REPO_SPAN_INDEXED_TEXT_BYTES,
  sha1Text,
  truncateIndexedText,
  truncatedIndexedTextRelocationMetadata
} from '../spans/indexed-text-bounds.js';
import { buildRetrievalCoreRecords } from '../spans/retrieval-core.js';
import type { RepoEdge, RepoSpan } from '../spans/types.js';
import { cleanupOldStateFiles } from './retention.js';
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
  return sha1Text(value);
}

const MAX_REPO_SPAN_LABEL_BYTES = 1024;
const MAX_REPO_SPAN_SUMMARY_BYTES = 2048;
const MAX_REFRESH_REVISIONS = 50;
const MAX_REFRESH_LOG_BYTES = 1_048_576;
const MAX_ROTATED_REFRESH_LOGS = 5;

function boundedIndexedText(span: RepoSpan): { indexedText: string; metadata: Record<string, unknown> } {
  const redaction = redactText(span.indexedText);
  const metadata: Record<string, unknown> = redaction.hasSensitiveContent
    ? { ...span.metadata, redactedAtIndexWrite: true, redactedKinds: redaction.redactedKinds }
    : span.metadata;
  const originalBytes = byteLengthUtf8(redaction.redactedText);
  if (originalBytes <= MAX_REPO_SPAN_INDEXED_TEXT_BYTES) {
    return { indexedText: redaction.redactedText, metadata };
  }
  return {
    indexedText: truncateIndexedText(redaction.redactedText),
    metadata: {
      ...metadata,
      indexedTextTruncatedAtWrite: true,
      originalIndexedTextBytes: byteLengthUtf8(span.indexedText),
      originalIndexedTextHash: sha1(span.indexedText),
      ...truncatedIndexedTextRelocationMetadata({
        text: redaction.redactedText,
        lineCount: Math.max(1, span.endLine - span.startLine + 1)
      })
    }
  };
}

function boundedField(value: string, maxBytes: number): string {
  const redacted = redactText(value).redactedText;
  return byteLengthUtf8(redacted) <= maxBytes ? redacted : truncateIndexedText(redacted, maxBytes);
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyFor(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
    DROP TABLE IF EXISTS repo_symbols;
    DROP TABLE IF EXISTS repo_symbol_aliases;
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

export type LatestRefreshSummary = {
  graphRevision: string;
  target: string;
  startedAt: number;
  finishedAt: number;
  fileCount: number;
  spanCount: number;
  edgeCount: number;
  warnings: string[];
};

function parseWarnings(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((warning): warning is string => typeof warning === 'string') : [];
  } catch {
    return [];
  }
}

function readExistingRevisions(db: Database): RevisionRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json
         FROM refresh_revisions
         ORDER BY finished_at DESC
         LIMIT ?`
      )
      .all(Math.max(0, MAX_REFRESH_REVISIONS - 1)) as RevisionRow[];
    return rows.reverse();
  } catch {
    return [];
  }
}

async function rotateRefreshLogIfLarge(projectRoot: string, logPath: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    info = await stat(logPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!info.isFile() || info.size <= MAX_REFRESH_LOG_BYTES) {
    return;
  }
  const paths = resolveNoemaLoomPaths(projectRoot);
  const rotated = assertWritableStatePath(
    paths.projectRoot,
    path.join(paths.logsDir, `refresh.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  );
  await rename(logPath, rotated);
  await cleanupOldStateFiles({
    projectRoot,
    directory: paths.logsDir,
    keepNewest: MAX_ROTATED_REFRESH_LOGS,
    match: fileName => /^refresh\..+\.jsonl$/.test(fileName)
  });
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
      spans: [...new Set(input.spans.map(span => span.spanId))].sort(),
      edges: [...new Set(input.edges.map(edge => edge.edgeId))].sort()
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

export async function readLatestRefreshSummary(projectRoot: string): Promise<LatestRefreshSummary | undefined> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const dbPath = path.join(paths.spansDir, 'spans.db');
  if (!(await fileExists(dbPath))) {
    return undefined;
  }
  try {
    const db = openDatabase(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT graph_revision, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json
           FROM refresh_revisions
           ORDER BY finished_at DESC
           LIMIT 1`
        )
        .get() as RevisionRow | undefined;
      if (!row?.graph_revision) {
        return undefined;
      }
      return {
        graphRevision: row.graph_revision,
        target: row.target,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        fileCount: row.file_count,
        spanCount: row.span_count,
        edgeCount: row.edge_count,
        warnings: parseWarnings(row.warnings_json)
      };
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

type StoredSpanRow = {
  span_id: string;
  path: string;
  kind: string;
  role: string;
  label: string;
  start_line: number;
  end_line: number;
  start_column: number | null;
  end_column: number | null;
  parent_span_id: string | null;
  language: string;
  heading_path_json: string;
  symbol_path_json: string;
  anchor: string | null;
  stable_locator_json: string;
  text_hash: string;
  indexed_text: string;
  summary: string;
  metadata_json: string;
  source: string;
  updated_at: number;
};

type StoredEdgeRow = {
  edge_id: string;
  source_span_id: string;
  target_span_id: string;
  relation: string;
  confidence: number;
  source: string;
  evidence_json: string;
  updated_at: number;
};

export type StoredGraphSnapshot = {
  spans: RepoSpan[];
  edges: RepoEdge[];
};

function parseJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function readStoredGraphSnapshot(projectRoot: string): Promise<StoredGraphSnapshot | undefined> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  const dbPath = path.join(paths.spansDir, 'spans.db');
  if (!(await fileExists(dbPath))) {
    return undefined;
  }
  try {
    const db = openDatabase(dbPath);
    try {
      const spanRows = db.prepare(
        `SELECT span_id, path, kind, role, label, start_line, end_line, start_column, end_column, parent_span_id, language,
                heading_path_json, symbol_path_json, anchor, stable_locator_json, text_hash, indexed_text, summary,
                metadata_json, source, updated_at
         FROM repo_spans
         ORDER BY path ASC, start_line ASC, span_id ASC`
      ).all() as StoredSpanRow[];
      const edgeRows = db.prepare(
        `SELECT edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json, updated_at
         FROM repo_edges
         ORDER BY edge_id ASC`
      ).all() as StoredEdgeRow[];
      return {
        spans: spanRows.map(row => ({
          spanId: row.span_id,
          path: row.path,
          kind: row.kind as RepoSpan['kind'],
          role: row.role as RepoSpan['role'],
          label: row.label,
          startLine: Number(row.start_line),
          endLine: Number(row.end_line),
          startColumn: row.start_column ?? undefined,
          endColumn: row.end_column ?? undefined,
          parentSpanId: row.parent_span_id ?? undefined,
          language: row.language,
          headingPath: parseJsonValue<string[]>(row.heading_path_json, []),
          symbolPath: parseJsonValue<string[]>(row.symbol_path_json, []),
          anchor: row.anchor ?? undefined,
          stableLocator: parseJsonValue<RepoSpan['stableLocator']>(row.stable_locator_json, {
            path: row.path,
            kind: row.kind as RepoSpan['kind'],
            headingPath: [],
            blockOrdinal: 0,
            normalizedTextHash: row.text_hash,
            nearbyHeadingHash: row.text_hash
          }),
          textHash: row.text_hash,
          indexedText: row.indexed_text,
          summary: row.summary,
          metadata: parseJsonValue<Record<string, unknown>>(row.metadata_json, {}),
          source: row.source,
          updatedAt: Number(row.updated_at)
        })),
        edges: edgeRows.map(row => ({
          edgeId: row.edge_id,
          sourceSpanId: row.source_span_id,
          targetSpanId: row.target_span_id,
          relation: row.relation as RepoEdge['relation'],
          confidence: Number(row.confidence),
          source: row.source,
          evidence: parseJsonValue<Record<string, unknown>>(row.evidence_json, {}),
          updatedAt: Number(row.updated_at)
        }))
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function writeRefreshRevisionDelta(input: {
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
  replacedPaths: string[];
  deletedPaths: string[];
}): Promise<string> {
  const paths = await ensureStateDir(input.projectRoot);
  const dbPath = assertWritableStatePath(paths.projectRoot, path.join(paths.spansDir, 'spans.db'));
  if (!(await fileExists(dbPath))) {
    throw new Error('Cannot run changed delta writer without an existing spans.db');
  }
  const db = openDatabase(dbPath);
  let transactionActive = false;
  const uniqueSpans = uniqueBy(input.spans, span => span.spanId);
  const uniqueEdges = uniqueBy(input.edges, edge => edge.edgeId);
  const replacedPaths = [...new Set(input.replacedPaths)].sort();
  const deletedPaths = [...new Set(input.deletedPaths)].sort();
  const touchedPaths = [...new Set([...replacedPaths, ...deletedPaths])].sort();

  try {
    db.exec('PRAGMA temp_store = MEMORY; BEGIN IMMEDIATE;');
    transactionActive = true;
    const upsertFile = db.prepare(
      `INSERT OR REPLACE INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSpan = db.prepare(
      `INSERT OR REPLACE INTO repo_spans
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
      `INSERT OR IGNORE INTO repo_edges
        (edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSymbol = db.prepare(
      `INSERT INTO repo_symbols
        (symbol_fqn, span_id, path, language, symbol_name, symbol_kind, parent_symbol_fqn, module_path, signature,
         exported, deprecated, deprecated_message, superseded_by, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSymbolAlias = db.prepare(
      `INSERT INTO repo_symbol_aliases
        (alias_fqn, target_fqn, alias_kind, path, line, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertRevision = db.prepare(
      `INSERT OR REPLACE INTO refresh_revisions
        (graph_revision, project_root, target, started_at, finished_at, file_count, span_count, edge_count, warnings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertMetadata = db.prepare(
      `INSERT INTO index_metadata (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    );

    for (const file of input.files) {
      upsertFile.run(
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

    for (const deletedPath of deletedPaths) {
      db.prepare('DELETE FROM repo_files WHERE path = ?').run(deletedPath);
    }
    for (const repoPath of touchedPaths) {
      db.prepare('DELETE FROM repo_spans_fts WHERE path = ?').run(repoPath);
      db.prepare('DELETE FROM repo_spans WHERE path = ?').run(repoPath);
    }
    db.prepare('DELETE FROM repo_edges').run();
    db.prepare('DELETE FROM repo_symbols').run();
    db.prepare('DELETE FROM repo_symbol_aliases').run();

    const touched = new Set(touchedPaths);
    for (const span of uniqueSpans.filter(span => touched.has(span.path))) {
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

    for (const edge of uniqueEdges) {
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

    const retrievalCore = buildRetrievalCoreRecords(uniqueSpans);
    for (const symbol of retrievalCore.symbols) {
      insertSymbol.run(
        symbol.symbolFqn,
        symbol.spanId,
        symbol.path,
        symbol.language,
        symbol.symbolName,
        symbol.symbolKind,
        symbol.parentSymbolFqn ?? null,
        symbol.modulePath,
        symbol.signature,
        symbol.exported ? 1 : 0,
        symbol.deprecated ? 1 : 0,
        symbol.deprecatedMessage ?? null,
        symbol.supersededBy ?? null,
        JSON.stringify(symbol.metadata)
      );
    }
    for (const alias of retrievalCore.aliases) {
      insertSymbolAlias.run(
        alias.aliasFqn,
        alias.targetFqn,
        alias.aliasKind,
        alias.path,
        alias.line,
        JSON.stringify(alias.metadata)
      );
    }

    insertRevision.run(
      input.graphRevision,
      paths.projectRoot,
      input.target,
      input.startedAt,
      input.finishedAt,
      input.files.length,
      uniqueSpans.length,
      uniqueEdges.length,
      JSON.stringify(input.warnings)
    );
    db.prepare(
      `DELETE FROM refresh_revisions
       WHERE graph_revision NOT IN (
         SELECT graph_revision FROM refresh_revisions ORDER BY finished_at DESC LIMIT ?
       )`
    ).run(MAX_REFRESH_REVISIONS);
    if (input.coverage) {
      const updatedAt = input.coverage.updatedAt ?? input.finishedAt;
      upsertMetadata.run('coverage', JSON.stringify({ ...input.coverage, updatedAt }), updatedAt);
    }
    upsertMetadata.run(
      'retrievalCore',
      JSON.stringify({
        state: 'ready',
        symbols: retrievalCore.symbols.length,
        aliases: retrievalCore.aliases.length,
        revision: sha1(`${input.graphRevision}:${retrievalCore.symbols.length}:${retrievalCore.aliases.length}`),
        updatedAt: input.finishedAt
      }),
      input.finishedAt
    );
    db.exec('COMMIT');
    transactionActive = false;
  } finally {
    if (transactionActive) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Best effort rollback for changed delta writes.
      }
    }
    db.close();
  }

  await writeFileInsideStateDir(
    paths.projectRoot,
    path.join(paths.logsDir, 'latest-revision.json'),
    `${JSON.stringify({ graphRevision: input.graphRevision, target: input.target, coverage: input.coverage ?? null }, null, 2)}\n`
  );
  const refreshLogPath = path.join(paths.logsDir, 'refresh.jsonl');
  await rotateRefreshLogIfLarge(paths.projectRoot, refreshLogPath);
  await appendFileInsideStateDir(
    paths.projectRoot,
    refreshLogPath,
    `${JSON.stringify({
      graphRevision: input.graphRevision,
      target: input.target,
      fileCount: input.files.length,
      spanCount: uniqueSpans.length,
      edgeCount: uniqueEdges.length,
      coverage: input.coverage ?? null,
      warnings: input.warnings,
      writer: 'changed_delta'
    })}\n`
  );
  return dbPath;
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
  const uniqueSpans = uniqueBy(input.spans, span => span.spanId);
  const uniqueEdges = uniqueBy(input.edges, edge => edge.edgeId);

  try {
    resetSchema(db);
    db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = OFF; PRAGMA temp_store = FILE; BEGIN IMMEDIATE;');
    transactionActive = true;
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSpan = db.prepare(
      `INSERT OR IGNORE INTO repo_spans
        (span_id, path, kind, role, label, start_line, end_line, start_column, end_column, parent_span_id, language,
         heading_path_json, symbol_path_json, anchor, stable_locator_json, text_hash, indexed_text, summary, metadata_json, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSpanFts = db.prepare(
      `INSERT OR IGNORE INTO repo_spans_fts
        (span_id, path, kind, role, label, heading_path, symbol_path, indexed_text, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO repo_edges
        (edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSymbol = db.prepare(
      `INSERT INTO repo_symbols
        (symbol_fqn, span_id, path, language, symbol_name, symbol_kind, parent_symbol_fqn, module_path, signature,
         exported, deprecated, deprecated_message, superseded_by, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertSymbolAlias = db.prepare(
      `INSERT INTO repo_symbol_aliases
        (alias_fqn, target_fqn, alias_kind, path, line, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)`
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
    const retrievalCore = buildRetrievalCoreRecords(uniqueSpans);

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
    for (const span of uniqueSpans) {
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
    for (const edge of uniqueEdges) {
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
    for (const symbol of retrievalCore.symbols) {
      insertSymbol.run(
        symbol.symbolFqn,
        symbol.spanId,
        symbol.path,
        symbol.language,
        symbol.symbolName,
        symbol.symbolKind,
        symbol.parentSymbolFqn ?? null,
        symbol.modulePath,
        symbol.signature,
        symbol.exported ? 1 : 0,
        symbol.deprecated ? 1 : 0,
        symbol.deprecatedMessage ?? null,
        symbol.supersededBy ?? null,
        JSON.stringify(symbol.metadata)
      );
    }
    for (const alias of retrievalCore.aliases) {
      insertSymbolAlias.run(
        alias.aliasFqn,
        alias.targetFqn,
        alias.aliasKind,
        alias.path,
        alias.line,
        JSON.stringify(alias.metadata)
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
      uniqueSpans.length,
      uniqueEdges.length,
      JSON.stringify(input.warnings)
    );
    if (input.coverage) {
      const updatedAt = input.coverage.updatedAt ?? input.finishedAt;
      upsertMetadata.run('coverage', JSON.stringify({ ...input.coverage, updatedAt }), updatedAt);
    }
    upsertMetadata.run(
      'retrievalCore',
      JSON.stringify({
        state: 'ready',
        symbols: retrievalCore.symbols.length,
        aliases: retrievalCore.aliases.length,
        revision: sha1(`${input.graphRevision}:${retrievalCore.symbols.length}:${retrievalCore.aliases.length}`),
        updatedAt: input.finishedAt
      }),
      input.finishedAt
    );
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
  const refreshLogPath = path.join(paths.logsDir, 'refresh.jsonl');
  await rotateRefreshLogIfLarge(paths.projectRoot, refreshLogPath);
  await appendFileInsideStateDir(
    paths.projectRoot,
    refreshLogPath,
    `${JSON.stringify({
      graphRevision: input.graphRevision,
      target: input.target,
      fileCount: input.files.length,
      spanCount: uniqueSpans.length,
      edgeCount: uniqueEdges.length,
      coverage: input.coverage ?? null,
      warnings: input.warnings
    })}\n`
  );
  return dbPath;
}
