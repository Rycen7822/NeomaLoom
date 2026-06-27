import { describe, expect, it } from 'vitest';

import { hasErrnoCode, isErrnoException } from '../../packages/core/src/shared/fs-errors.js';
import { sha1 } from '../../packages/core/src/shared/hash.js';
import { openSqliteDatabase } from '../../packages/core/src/shared/sqlite.js';
import { collapseRepoPathSlashes, relativeRepoPath, toPosixRepoPath, trimRepoPathBoundarySlashes } from '../../packages/core/src/shared/repo-path.js';
import { mapWithConcurrency } from '../../packages/core/src/shared/concurrency.js';

describe('shared helper contracts', () => {
  it('detects errno-shaped Error objects without accepting plain objects', () => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';

    expect(isErrnoException(error)).toBe(true);
    expect(hasErrnoCode(error, 'ENOENT')).toBe(true);
    expect(hasErrnoCode(error, 'EEXIST')).toBe(false);
    expect(isErrnoException({ code: 'ENOENT' })).toBe(false);
  });

  it('hashes text and binary data through the same SHA-1 contract', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1(Buffer.from('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('opens node sqlite databases through a narrow shared loader', () => {
    const db = openSqliteDatabase<{ exec: (sql: string) => void; prepare: (sql: string) => { get: () => { value: number } }; close: () => void }>(':memory:');
    try {
      db.exec('CREATE TABLE sample (value INTEGER NOT NULL); INSERT INTO sample(value) VALUES (7);');
      expect(db.prepare('SELECT value FROM sample').get().value).toBe(7);
    } finally {
      db.close();
    }
  });

  it('keeps repo-path normalization modes explicit', () => {
    expect(toPosixRepoPath('///src\\a//b/')).toBe('src/a//b/');
    expect(trimRepoPathBoundarySlashes('///src\\a//b/')).toBe('src/a//b');
    expect(collapseRepoPathSlashes('///src\\a//b/')).toBe('src/a/b/');
    expect(relativeRepoPath('/repo', '/repo/src/file.ts')).toBe('src/file.ts');
  });

  it('maps concurrently while preserving input order and respecting the concurrency cap', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency([3, 1, 2, 4], 2, async item => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, item));
      active -= 1;
      return item * 10;
    });

    expect(result).toEqual([30, 10, 20, 40]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
