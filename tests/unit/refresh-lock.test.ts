import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withRefreshLock } from '../../packages/core/src/state/refresh-lock.js';
import { resolveNoemaLoomPaths } from '../../packages/core/src/state/paths.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-lock-'));
}

describe('refresh lock', () => {
  it('serializes concurrent refresh attempts and releases the lock afterward', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);

    const first = await withRefreshLock(projectRoot, async () => {
      return withRefreshLock(projectRoot, async () => 'second');
    });
    const afterRelease = await withRefreshLock(projectRoot, async () => 'after-release');

    expect(first).toEqual({
      ok: true,
      result: {
        ok: false,
        status: 'refresh_in_progress'
      }
    });
    expect(afterRelease).toEqual({
      ok: true,
      result: 'after-release'
    });
    await expect(access(paths.refreshLockFile)).rejects.toThrow();
  });
});
