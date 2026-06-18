import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INITIAL_MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)),
  'utf8'
);

export type SqlExecutor = {
  exec: (sql: string) => void;
};

export function applySpanMigrations(db: SqlExecutor): void {
  db.exec(INITIAL_MIGRATION_SQL);
}
