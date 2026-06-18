import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FileInventory, InventoryFile } from '../files/file-inventory.js';
import { resolveNoemaLoomPaths } from './paths.js';

export type InventorySnapshot = {
  files: Array<{ path: string; contentHash: string }>;
};

export type ChangedFiles = {
  changedPaths: string[];
  deletedPaths: string[];
};

export async function readInventorySnapshot(projectRoot: string): Promise<InventorySnapshot | undefined> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  try {
    const parsed = JSON.parse(await readFile(path.join(paths.filesDir, 'inventory.json'), 'utf8')) as InventorySnapshot;
    return Array.isArray(parsed.files) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createInventorySnapshot(inventory: FileInventory): InventorySnapshot {
  return {
    files: inventory.files.map(file => ({ path: file.path, contentHash: file.contentHash })).sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function detectChangedFiles(previous: InventorySnapshot | undefined, current: InventoryFile[]): ChangedFiles {
  if (!previous) {
    return {
      changedPaths: current.map(file => file.path).sort(),
      deletedPaths: []
    };
  }
  const previousByPath = new Map(previous.files.map(file => [file.path, file.contentHash]));
  const currentByPath = new Map(current.map(file => [file.path, file.contentHash]));
  const changedPaths = current
    .filter(file => previousByPath.get(file.path) !== file.contentHash)
    .map(file => file.path)
    .sort();
  const deletedPaths = [...previousByPath.keys()].filter(repoPath => !currentByPath.has(repoPath)).sort();
  return { changedPaths, deletedPaths };
}
