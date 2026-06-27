import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type SqliteStatement = {
  run?: (...params: unknown[]) => unknown;
  get?: (...params: unknown[]) => unknown;
  all?: (...params: unknown[]) => unknown[];
};

export type SqliteDatabase = {
  exec?: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

export function openSqliteDatabase<TDatabase extends SqliteDatabase = SqliteDatabase>(filename: string): TDatabase {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => TDatabase };
  return new sqlite.DatabaseSync(filename);
}
