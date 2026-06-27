import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { unlinkInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { ensureStateDir } from './state-dir.js';
import { isErrnoException } from '../shared/fs-errors.js';

export type RefreshFailureRecord = {
  tool: string;
  target?: string;
  message: string;
  failedAt: string;
};

function isRefreshFailureRecord(value: unknown): value is RefreshFailureRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<RefreshFailureRecord>;
  return typeof record.tool === 'string' && typeof record.message === 'string' && typeof record.failedAt === 'string';
}

export async function recordRefreshFailure(input: {
  projectRoot: string;
  tool: string;
  target?: string;
  message: string;
  failedAt?: string;
}): Promise<void> {
  const paths = await ensureStateDir(input.projectRoot);
  const record: RefreshFailureRecord = {
    tool: input.tool,
    target: input.target,
    message: input.message,
    failedAt: input.failedAt ?? new Date().toISOString()
  };
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.logsDir, 'latest-failure.json'), `${JSON.stringify(record, null, 2)}\n`);
}

export async function clearRefreshFailure(projectRoot: string): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  try {
    await unlinkInsideStateDir(paths.projectRoot, path.join(paths.logsDir, 'latest-failure.json'));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function readRefreshFailure(projectRoot: string): Promise<RefreshFailureRecord | undefined> {
  const paths = await ensureStateDir(projectRoot);
  try {
    const parsed = JSON.parse(await readFile(path.join(paths.logsDir, 'latest-failure.json'), 'utf8')) as unknown;
    return isRefreshFailureRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function refreshFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
