import { readFile, type FileHandle } from 'node:fs/promises';

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

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isErrnoException(error) && error.code === 'ESRCH');
  }
}

async function removeStaleLockIfDead(projectRoot: string, lockFile: string): Promise<boolean> {
  let raw = '';
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch {
    return false;
  }

  let parsed: { pid?: unknown };
  try {
    parsed = JSON.parse(raw) as { pid?: unknown };
  } catch {
    return false;
  }

  if (typeof parsed.pid !== 'number' || processIsAlive(parsed.pid)) {
    return false;
  }

  try {
    await unlinkInsideStateDir(projectRoot, lockFile);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function acquireRefreshLock(projectRoot: string, lockFile: string): Promise<FileHandle | undefined> {
  try {
    return await openExclusiveFileInsideStateDir(projectRoot, lockFile);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  }
}

export async function withRefreshLock<T>(
  projectRoot: string,
  task: () => Promise<T>
): Promise<RefreshLockResult<T>> {
  const paths = await ensureStateDir(projectRoot);
  let lockHandle = await acquireRefreshLock(paths.projectRoot, paths.refreshLockFile);

  if (!lockHandle && (await removeStaleLockIfDead(paths.projectRoot, paths.refreshLockFile))) {
    lockHandle = await acquireRefreshLock(paths.projectRoot, paths.refreshLockFile);
  }

  if (!lockHandle) {
    return {
      ok: false,
      status: 'refresh_in_progress'
    };
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
