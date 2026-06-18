import type { FileHandle } from 'node:fs/promises';

import { openExclusiveFileInsideStateDir, unlinkInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from './state-dir.js';

export type RefreshLockResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      status: 'refresh_in_progress';
    };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function withRefreshLock<T>(
  projectRoot: string,
  task: () => Promise<T>
): Promise<RefreshLockResult<T>> {
  const paths = await ensureStateDir(projectRoot);
  let lockHandle: FileHandle;

  try {
    lockHandle = await openExclusiveFileInsideStateDir(paths.projectRoot, paths.refreshLockFile);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return {
        ok: false,
        status: 'refresh_in_progress'
      };
    }

    throw error;
  }

  try {
    await lockHandle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
    );
    return {
      ok: true,
      result: await task()
    };
  } finally {
    await lockHandle.close();
    try {
      await unlinkInsideStateDir(paths.projectRoot, paths.refreshLockFile);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
