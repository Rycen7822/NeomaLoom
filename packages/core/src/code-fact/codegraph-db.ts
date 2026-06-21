import { readdir, rename, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { assertWritableStatePath } from '../safety/path-guard.js';
import { ensureStateDir } from '../state/state-dir.js';
import type { CodeFactEdge, CodeFactSpan } from './extractor.js';

type Statement = {
  run: (...params: unknown[]) => unknown;
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

function createSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS facts_nodes;
    DROP TABLE IF EXISTS facts_edges;
    DROP TABLE IF EXISTS facts_files;
    DROP TABLE IF EXISTS codegraph_nodes_fts;

    CREATE TABLE facts_files (
      path TEXT PRIMARY KEY,
      language TEXT NOT NULL
    );

    CREATE TABLE facts_nodes (
      span_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      signature TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE facts_edges (
      edge_id TEXT PRIMARY KEY,
      source_span_id TEXT NOT NULL,
      target_span_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE codegraph_nodes_fts USING fts5(
      span_id UNINDEXED,
      kind UNINDEXED,
      path UNINDEXED,
      label,
      qualified_name,
      signature
    );
  `);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleCodeGraphTemps(factDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(factDir);
  } catch {
    return;
  }
  const now = Date.now();
  const staleBases = new Set<string>();
  for (const entry of entries) {
    const match = /^codegraph\.(\d+)\..+\.tmp\.db(?:-(?:journal|wal|shm))?$/.exec(entry);
    if (!match) {
      continue;
    }
    const base = entry.replace(/-(?:journal|wal|shm)$/, '');
    const targetPath = path.join(factDir, entry);
    let oldEnough = false;
    try {
      const info = await stat(targetPath);
      oldEnough = now - info.mtimeMs > 60 * 60 * 1000;
    } catch {
      oldEnough = true;
    }
    if (!processIsAlive(Number(match[1])) || oldEnough) {
      staleBases.add(base);
    }
  }
  for (const base of staleBases) {
    await unlinkSqliteTempIfExists(path.join(factDir, base));
  }
}

export async function writeCodeGraphDb(input: {
  projectRoot: string;
  files: Array<{ path: string; language: string }>;
  spans: CodeFactSpan[];
  edges: CodeFactEdge[];
}): Promise<string> {
  const paths = await ensureStateDir(input.projectRoot);
  await cleanupStaleCodeGraphTemps(paths.factDir);
  const dbPath = assertWritableStatePath(paths.projectRoot, path.join(paths.factDir, 'codegraph.db'));
  const tempDbPath = assertWritableStatePath(
    paths.projectRoot,
    path.join(paths.factDir, `codegraph.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp.db`)
  );
  await unlinkSqliteTempIfExists(tempDbPath);
  const db = openDatabase(tempDbPath);
  let wroteSuccessfully = false;
  let transactionActive = false;

  try {
    db.exec('PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY; PRAGMA temp_store = MEMORY; BEGIN IMMEDIATE;');
    transactionActive = true;
    createSchema(db);
    const insertFile = db.prepare('INSERT INTO facts_files (path, language) VALUES (?, ?)');
    const insertNode = db.prepare(
      `INSERT INTO facts_nodes
        (span_id, kind, path, label, qualified_name, signature, start_line, end_line, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = db.prepare(
      `INSERT INTO codegraph_nodes_fts
        (span_id, kind, path, label, qualified_name, signature)
        VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertEdge = db.prepare(
      `INSERT INTO facts_edges
        (edge_id, source_span_id, target_span_id, relation, confidence, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const file of input.files) {
      insertFile.run(file.path, file.language);
    }
    for (const span of input.spans) {
      const qualifiedName = String(span.metadata.qualifiedName ?? `${span.path}:${span.label}`);
      const signature = String(span.metadata.signature ?? span.label);
      const metadataJson = JSON.stringify(span.metadata);
      insertNode.run(
        span.spanId,
        span.kind,
        span.path,
        span.label,
        qualifiedName,
        signature,
        span.startLine,
        span.endLine,
        metadataJson
      );
      insertFts.run(span.spanId, span.kind, span.path, span.label, qualifiedName, signature);
    }
    for (const edge of input.edges) {
      insertEdge.run(
        edge.edgeId,
        edge.sourceSpanId,
        edge.targetSpanId,
        edge.relation,
        edge.confidence,
        JSON.stringify(edge.evidence)
      );
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
  return dbPath;
}

export type CodeFactSearchResult = {
  spanId: string;
  kind: string;
  path: string;
  label: string;
  qualifiedName: string;
  signature: string;
};

function safeFtsQuery(term: string): string | undefined {
  const cleaned = term.trim().replace(/"/g, '""');
  if (!cleaned || /[\u0000-\u001f]/.test(cleaned)) {
    return undefined;
  }
  return `"${cleaned}"`;
}

export function searchCodeGraphDb(input: { dbPath: string; query: string; limit?: number }): CodeFactSearchResult[] {
  const db = openDatabase(input.dbPath);
  try {
    const exactRows = db
      .prepare(
        `SELECT span_id AS spanId, kind, path, label, qualified_name AS qualifiedName, signature
         FROM facts_nodes
         WHERE label = ? AND kind != 'code.callsite'
         LIMIT ?`
      )
      .all(input.query, input.limit ?? 10);
    if (exactRows.length > 0) {
      return exactRows as CodeFactSearchResult[];
    }

    const ftsQuery = safeFtsQuery(input.query);
    if (!ftsQuery) {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT span_id AS spanId, kind, path, label, qualified_name AS qualifiedName, signature
         FROM codegraph_nodes_fts
         WHERE codegraph_nodes_fts MATCH ? AND kind != 'code.callsite'
         LIMIT ?`
      )
      .all(ftsQuery, input.limit ?? 10);
    return rows as CodeFactSearchResult[];
  } finally {
    db.close();
  }
}
