import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeRefreshRevision } from '../../packages/core/src/state/refresh-revision.js';
import type { InventoryFile } from '../../packages/core/src/files/file-inventory.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    close: () => void;
  };
};

async function createProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-refresh-revision-'));
}

function inventoryFile(projectRoot: string): InventoryFile {
  return {
    path: 'src/index.ts',
    absolutePath: path.join(projectRoot, 'src/index.ts'),
    role: 'source_file',
    language: 'typescript',
    contentHash: 'hash',
    sizeBytes: 1,
    modifiedAt: 1,
    indexedAt: 1,
    generated: false,
    ignored: false,
    oversized: false,
    fileOnlySpan: false,
    spanKind: 'file',
    indexedText: ''
  };
}

async function writeRevision(projectRoot: string, index: number): Promise<void> {
  await writeRefreshRevision({
    projectRoot,
    graphRevision: `rev-${index}`,
    target: 'all',
    startedAt: index,
    finishedAt: index,
    files: [inventoryFile(projectRoot)],
    spans: [],
    edges: [],
    warnings: [],
    coverage: {
      inventory: 'full',
      deepSpans: 'none',
      hotsetRevision: null,
      hotFiles: 0,
      coldFiles: 1,
      unindexedCandidateCount: 1,
      updatedAt: index
    }
  });
}

function scalar(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get() as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

describe('refresh revision persistence', () => {
  it('retains only the most recent refresh revisions', async () => {
    const projectRoot = await createProject();
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src/index.ts'), 'export const value = 1;\n');

    for (let index = 0; index < 55; index += 1) {
      await writeRevision(projectRoot, index);
    }

    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(50);
    expect(scalar(dbPath, 'SELECT MIN(finished_at) AS value FROM refresh_revisions')).toBe(5);
    expect(scalar(dbPath, 'SELECT MAX(finished_at) AS value FROM refresh_revisions')).toBe(54);
  }, 15_000);

  it('rotates oversized refresh jsonl logs before appending', async () => {
    const projectRoot = await createProject();
    const logsDir = path.join(projectRoot, '.noemaloom', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, 'refresh.jsonl'), `${'x'.repeat(1_100_000)}\n`);

    await writeRevision(projectRoot, 1);

    const entries = await readdir(logsDir);
    expect(entries.some(entry => /^refresh\..+\.jsonl$/.test(entry))).toBe(true);
    expect((await stat(path.join(logsDir, 'refresh.jsonl'))).size).toBeLessThan(10_000);
  });
});
