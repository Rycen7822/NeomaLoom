import { readFile, type FileHandle } from 'node:fs/promises';

import { openExclusiveFileInsideStateDir, renameInsideStateDir, unlinkInsideStateDir } from '../safety/path-guard.js';
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

const REFRESH_LOCK_TTL_MS = 6 * 60 * 60 * 1000;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isErrnoException(error) && error.code === 'ESRCH');
  }
}

function lockExpired(createdAt: unknown, now = Date.now()): boolean {
  if (typeof createdAt !== 'string') {
    return false;
  }
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && now - timestamp > REFRESH_LOCK_TTL_MS;
}

function lockIsActive(parsed: { pid?: unknown; createdAt?: unknown }): parsed is { pid: number; createdAt?: string } {
  return typeof parsed.pid === 'number' && processIsAlive(parsed.pid) && !lockExpired(parsed.createdAt);
}

export type RefreshLockInspection =
  | { state: 'missing' }
  | { state: 'active' | 'stale'; pid: number; createdAt?: string }
  | { state: 'stale'; reason: 'empty_or_malformed'; message: string }
  | { state: 'unreadable'; message: string };

type ParsedRefreshLock =
  | { ok: true; pid: number; createdAt?: string; active: boolean }
  | { ok: false; reason: 'empty_or_malformed'; message: string };

function parseRefreshLock(raw: string): ParsedRefreshLock {
  if (raw.trim() === '') {
    return { ok: false, reason: 'empty_or_malformed', message: 'refresh.lock is empty' };
  }
  let parsed: { pid?: unknown; createdAt?: unknown };
  try {
    parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
  } catch (error) {
    return { ok: false, reason: 'empty_or_malformed', message: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed.pid !== 'number') {
    return { ok: false, reason: 'empty_or_malformed', message: 'refresh.lock does not contain a numeric pid' };
  }
  return {
    ok: true,
    pid: parsed.pid,
    ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
    active: lockIsActive(parsed)
  };
}

export async function inspectRefreshLock(projectRoot: string): Promise<RefreshLockInspection> {
  const paths = await ensureStateDir(projectRoot);
  let raw = '';
  try {
    raw = await readFile(paths.refreshLockFile, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { state: 'missing' };
    }
    return { state: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }

  const parsed = parseRefreshLock(raw);
  if (!parsed.ok) {
    return { state: 'stale', reason: parsed.reason, message: parsed.message };
  }
  return {
    state: parsed.active ? 'active' : 'stale',
    pid: parsed.pid,
    ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {})
  };
}

async function removeStaleLockIfDead(projectRoot: string, lockFile: string): Promise<boolean> {
  let raw = '';
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch {
    return false;
  }

  const parsed = parseRefreshLock(raw);
  if (parsed.ok && parsed.active) {
    return false;
  }

  const graveyard = `${lockFile}.stale.${process.pid}.${Date.now()}`;
  try {
    await renameInsideStateDir(projectRoot, lockFile, graveyard);
    const quarantinedRaw = await readFile(graveyard, 'utf8').catch(() => '');
    if (quarantinedRaw !== raw) {
      await renameInsideStateDir(projectRoot, graveyard, lockFile).catch(() => undefined);
      return false;
    }
    await unlinkInsideStateDir(projectRoot, graveyard).catch(error => {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    });
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
    return await openExclusiveFileInsideStateDir(
      projectRoot,
      lockFile,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`
    );
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
