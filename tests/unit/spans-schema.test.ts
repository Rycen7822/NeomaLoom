import { createRequire } from 'node:module';

import { applySpanMigrations, INITIAL_MIGRATION_SQL } from '../../packages/core/src/spans/db.js';
import { assertEdgeRelation, assertFileRole, assertSpanKind } from '../../packages/core/src/spans/enums.js';

type SQLiteStatement = {
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  get: () => Record<string, unknown> | undefined;
};

type SQLiteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SQLiteStatement;
  close: () => void;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => SQLiteDatabase;
};

describe('span schema migration', () => {
  it('creates the canonical tables and FTS virtual table', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applySpanMigrations(db);
      const expectedNames = [
        'index_metadata',
        'refresh_revisions',
        'repo_edges',
        'repo_evidence',
        'repo_files',
        'repo_spans',
        'repo_spans_fts'
      ].sort();

      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name IN (${expectedNames.map(() => '?').join(',')}) ORDER BY name`
        )
        .all(...expectedNames) as Array<{ name: string }>;
      const fts = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'repo_spans_fts'")
        .get() as { sql: string };

      expect(rows.map(row => row.name)).toEqual(expectedNames);
      expect(fts.sql).toContain('USING fts5');
      expect(INITIAL_MIGRATION_SQL).toContain('CREATE TABLE repo_files');
      expect(INITIAL_MIGRATION_SQL).toContain('CREATE TABLE index_metadata');
      expect(INITIAL_MIGRATION_SQL).toContain('CREATE VIRTUAL TABLE repo_spans_fts');
    } finally {
      db.close();
    }
  });

  it('rejects invalid span kinds, file roles, and edge relations', () => {
    expect(assertSpanKind('doc.paragraph')).toBe('doc.paragraph');
    expect(assertFileRole('canonical_api_doc')).toBe('canonical_api_doc');
    expect(assertEdgeRelation('documents')).toBe('documents');

    expect(() => assertSpanKind('doc.block')).toThrow('invalid_span_kind');
    expect(() => assertFileRole('business_doc')).toThrow('invalid_file_role');
    expect(() => assertEdgeRelation('writes')).toThrow('invalid_edge_relation');
  });
});
