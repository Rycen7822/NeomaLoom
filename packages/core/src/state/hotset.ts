import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { InventoryFile } from '../files/file-inventory.js';
import { writeFileInsideStateDir } from '../safety/path-guard.js';
import { resolveNoemaLoomPaths } from './paths.js';
import { ensureStateDir } from './state-dir.js';
import { codexScientistEditBoundary, type EditBoundary } from '../profiles/codex-scientist.js';

export type HotsetTier = 'deep' | 'file_only';

export type HotsetEntry = {
  path: string;
  contentHash: string;
  tier: HotsetTier;
  reason: string;
  promotedAt: string;
  lastUsedAt: string;
  accessCount: number;
  pinned: boolean;
  editBoundary: EditBoundary;
};

export type HotsetManifest = {
  version: 1;
  projectRootHash: string;
  entries: HotsetEntry[];
  budgets: {
    maxFiles: number;
    maxBytes: number;
  };
};

const DEFAULT_BUDGETS = {
  maxFiles: 200,
  maxBytes: 10 * 1024 * 1024
};

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function projectRootHash(projectRoot: string): string {
  return sha1(path.resolve(projectRoot)).slice(0, 16);
}

export function createEmptyHotsetManifest(projectRoot: string): HotsetManifest {
  return {
    version: 1,
    projectRootHash: projectRootHash(projectRoot),
    entries: [],
    budgets: DEFAULT_BUDGETS
  };
}

function normalizeManifest(projectRoot: string, value: unknown): HotsetManifest {
  if (!value || typeof value !== 'object') {
    return createEmptyHotsetManifest(projectRoot);
  }
  const raw = value as { entries?: unknown; budgets?: unknown };
  const budgets = raw.budgets && typeof raw.budgets === 'object'
    ? raw.budgets as Partial<HotsetManifest['budgets']>
    : {};
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .filter((entry): entry is Partial<HotsetEntry> & { path: string } => Boolean(entry) && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string')
        .map(entry => ({
          path: entry.path,
          contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : '',
          tier: entry.tier === 'file_only' ? 'file_only' as const : 'deep' as const,
          reason: typeof entry.reason === 'string' ? entry.reason : 'manifest',
          promotedAt: typeof entry.promotedAt === 'string' ? entry.promotedAt : new Date(0).toISOString(),
          lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : new Date(0).toISOString(),
          accessCount: Number(entry.accessCount ?? 0),
          pinned: Boolean(entry.pinned),
          editBoundary: entry.editBoundary && typeof entry.editBoundary === 'object'
            ? entry.editBoundary as EditBoundary
            : codexScientistEditBoundary(entry.path)
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    : [];

  return {
    version: 1,
    projectRootHash: projectRootHash(projectRoot),
    entries,
    budgets: {
      maxFiles: Number(budgets.maxFiles ?? DEFAULT_BUDGETS.maxFiles),
      maxBytes: Number(budgets.maxBytes ?? DEFAULT_BUDGETS.maxBytes)
    }
  };
}

export async function readHotsetManifest(projectRoot: string): Promise<HotsetManifest> {
  const paths = resolveNoemaLoomPaths(projectRoot);
  try {
    return normalizeManifest(projectRoot, JSON.parse(await readFile(path.join(paths.hotsetDir, 'hotset.json'), 'utf8')) as unknown);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return createEmptyHotsetManifest(projectRoot);
    }
    throw error;
  }
}

export async function writeHotsetManifest(projectRoot: string, manifest: HotsetManifest): Promise<void> {
  const paths = await ensureStateDir(projectRoot);
  const normalized = normalizeManifest(projectRoot, manifest);
  await writeFileInsideStateDir(paths.projectRoot, path.join(paths.hotsetDir, 'hotset.json'), `${JSON.stringify(normalized, null, 2)}\n`);
}

export function hotsetRevision(manifest: HotsetManifest): string {
  return `hot-${sha1(JSON.stringify(manifest.entries.map(entry => [entry.path, entry.contentHash, entry.tier, entry.reason, entry.pinned]).sort())).slice(0, 16)}`;
}

export function upsertHotsetEntries(input: {
  projectRoot: string;
  manifest: HotsetManifest;
  files: InventoryFile[];
  reason: string;
  pinned?: boolean;
  now?: Date;
}): HotsetManifest {
  const now = (input.now ?? new Date()).toISOString();
  const byPath = new Map(input.manifest.entries.map(entry => [entry.path, entry]));
  for (const file of input.files) {
    const existing = byPath.get(file.path);
    byPath.set(file.path, {
      path: file.path,
      contentHash: file.contentHash,
      tier: file.oversized ? 'file_only' : 'deep',
      reason: existing?.reason ?? input.reason,
      promotedAt: existing?.promotedAt ?? now,
      lastUsedAt: now,
      accessCount: (existing?.accessCount ?? 0) + 1,
      pinned: input.pinned ?? existing?.pinned ?? false,
      editBoundary: codexScientistEditBoundary(file.path)
    });
  }

  return {
    ...input.manifest,
    projectRootHash: projectRootHash(input.projectRoot),
    entries: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function manifestFiles(manifest: HotsetManifest, inventoryFiles: InventoryFile[]): InventoryFile[] {
  const byPath = new Map(inventoryFiles.map(file => [file.path, file]));
  return manifest.entries
    .map(entry => byPath.get(entry.path))
    .filter((file): file is InventoryFile => Boolean(file));
}
