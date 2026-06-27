import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { assertWritableStatePath, unlinkInsideStateDir } from '../safety/path-guard.js';
import { isErrnoException } from '../shared/fs-errors.js';

export type StateFileRetentionInput = {
  projectRoot: string;
  directory: string;
  keepNewest: number;
  match: (fileName: string) => boolean;
};

export async function cleanupOldStateFiles(input: StateFileRetentionInput): Promise<number> {
  if (input.keepNewest < 0) {
    throw new Error('keepNewest must be non-negative');
  }
  const directory = assertWritableStatePath(input.projectRoot, input.directory);
  let entries: string[];
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory()) {
      return 0;
    }
    entries = await readdir(directory);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  const matched: Array<{ fileName: string; fullPath: string; mtimeMs: number }> = [];
  for (const fileName of entries) {
    if (!input.match(fileName)) continue;
    const fullPath = assertWritableStatePath(input.projectRoot, path.join(directory, fileName));
    try {
      const info = await lstat(fullPath);
      if (info.isFile()) {
        matched.push({ fileName, fullPath, mtimeMs: info.mtimeMs });
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  matched.sort((left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName));
  const expired = matched.slice(input.keepNewest);
  let removed = 0;
  for (const entry of expired) {
    try {
      await unlinkInsideStateDir(input.projectRoot, entry.fullPath);
      removed += 1;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return removed;
}
