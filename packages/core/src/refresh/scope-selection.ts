import path from 'node:path';

import { buildFileInventoryForPaths, buildFileInventoryFromSnapshot, type FileInventory, type InventoryFile } from '../files/file-inventory.js';
import { isGitRepository, listGitChangedCandidateFiles, listGitDeletedFiles, listGitVisibleFiles } from '../files/git-files.js';
import { detectCodexScientistHotsetSeedPaths, isCodexScientistColdPath } from '../profiles/codex-scientist.js';
import type { ChangedFiles, InventorySnapshot } from '../state/changed-detection.js';
import { hotsetRevision, manifestFiles, readHotsetManifest, upsertHotsetEntries, writeHotsetManifest } from '../state/hotset.js';
import type { IndexCoverage } from '../state/refresh-revision.js';
import type { NoemaLoomConfig } from '../config/default-config.js';

export type RefreshTarget = 'all' | 'changed' | 'files' | 'hotset' | 'paths' | 'code' | 'docs' | 'artifacts' | 'tests' | 'features' | 'links' | 'map';

function normalizeRepoPath(projectRoot: string, requestedPath: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const absolute = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, absolute).replaceAll('\\', '/');
  if (relative === '' || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`hotset path escapes project root: ${requestedPath}`);
  }
  return relative;
}

function resolveRequestedFiles(projectRoot: string, inventory: FileInventory, requestedPaths: string[]): InventoryFile[] {
  if (requestedPaths.length === 0) {
    throw new Error('target="paths" requires a non-empty paths array');
  }
  const byPath = new Map(inventory.files.map(file => [file.path, file]));
  const selected = new Map<string, InventoryFile>();
  for (const requestedPath of requestedPaths) {
    const repoPath = normalizeRepoPath(projectRoot, requestedPath);
    const file = byPath.get(repoPath);
    if (!file) {
      throw new Error(`hotset path is not in the current file inventory: ${requestedPath}`);
    }
    selected.set(file.path, file);
  }
  return [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export async function tryBuildScopedSnapshotInventory(input: {
  projectRoot: string;
  target: RefreshTarget;
  requestedPaths: string[];
  config: NoemaLoomConfig;
  previousInventory?: InventorySnapshot;
}): Promise<FileInventory | undefined> {
  if (!input.previousInventory || !['paths', 'hotset'].includes(input.target)) {
    return undefined;
  }

  if (input.target === 'paths' && input.requestedPaths.length === 0) {
    return undefined;
  }

  const source = input.target === 'paths' ? 'snapshot_plus_requested_paths' as const : 'snapshot_plus_hotset' as const;
  const snapshotInventory = buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    source
  });
  const seedPaths = await detectCodexScientistHotsetSeedPaths(input.projectRoot, snapshotInventory.files);
  const manifest = input.target === 'hotset' ? await readHotsetManifest(input.projectRoot) : undefined;
  const manifestPaths = manifest?.entries.map(entry => entry.path) ?? [];

  const requiredInventory = input.target === 'paths'
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: input.requestedPaths,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: false
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };
  const requiredPaths = new Set(requiredInventory.files.map(file => file.path));
  const optionalPaths = uniqueStrings([...manifestPaths, ...seedPaths].filter(repoPath => !requiredPaths.has(normalizeRepoPath(input.projectRoot, repoPath))));
  const optionalInventory = optionalPaths.length > 0
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: optionalPaths,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: true
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };

  return buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    refreshedFiles: [...requiredInventory.files, ...optionalInventory.files],
    ignoredPaths: [...requiredInventory.ignoredPaths, ...optionalInventory.ignoredPaths],
    source
  });
}

export async function tryBuildChangedSnapshotInventory(input: {
  projectRoot: string;
  config: NoemaLoomConfig;
  previousInventory?: InventorySnapshot;
}): Promise<FileInventory | undefined> {
  if (!input.previousInventory || !(await isGitRepository(input.projectRoot))) {
    return undefined;
  }
  const [visibleFiles, changedCandidates, gitDeletedFiles] = await Promise.all([
    listGitVisibleFiles(input.projectRoot),
    listGitChangedCandidateFiles(input.projectRoot),
    listGitDeletedFiles(input.projectRoot)
  ]);
  const visible = new Set(visibleFiles.map(repoPath => normalizeRepoPath(input.projectRoot, repoPath)));
  for (const deletedPath of gitDeletedFiles) {
    visible.delete(normalizeRepoPath(input.projectRoot, deletedPath));
  }
  const deletedPaths = input.previousInventory.files
    .map(file => normalizeRepoPath(input.projectRoot, file.path))
    .filter(repoPath => !visible.has(repoPath));
  const refreshedInventory = changedCandidates.length > 0
    ? await buildFileInventoryForPaths({
        projectRoot: input.projectRoot,
        config: input.config,
        paths: changedCandidates,
        loadIndexedText: false,
        previousFiles: input.previousInventory.files,
        allowMissing: true
      })
    : { files: [] as InventoryFile[], ignoredPaths: [] as string[] };

  return buildFileInventoryFromSnapshot({
    projectRoot: input.projectRoot,
    config: input.config,
    previousFiles: input.previousInventory.files,
    refreshedFiles: refreshedInventory.files,
    deletedPaths,
    ignoredPaths: refreshedInventory.ignoredPaths,
    source: 'snapshot_plus_git_changed'
  });
}

export type ScopeSelection = {
  scoped: boolean;
  deepFiles: InventoryFile[];
  coverage: IndexCoverage;
  hotsetRevision: string | null;
  warnings: string[];
  changedTargetStrategy?: 'scoped_hotset_reindex' | 'full_deep_reindex' | 'git_delta_reindex';
};

export async function selectDeepFiles(input: {
  projectRoot: string;
  target: RefreshTarget;
  inventory: FileInventory;
  requestedPaths: string[];
  promotionReason?: string;
  previousCoverage?: IndexCoverage;
  changed?: ChangedFiles;
  allowChangedDelta?: boolean;
}): Promise<ScopeSelection> {
  const now = Date.now();
  if (input.target === 'files') {
    return {
      scoped: false,
      deepFiles: [],
      hotsetRevision: null,
      warnings: [],
      coverage: {
        inventory: 'full',
        deepSpans: 'none',
        hotsetRevision: null,
        hotFiles: 0,
        coldFiles: input.inventory.files.length,
        unindexedCandidateCount: input.inventory.files.length,
        updatedAt: now
      }
    };
  }

  if (
    input.target === 'changed' &&
    input.allowChangedDelta &&
    input.previousCoverage?.deepSpans === 'full' &&
    input.inventory.strategy?.source === 'snapshot_plus_git_changed' &&
    input.changed &&
    (input.changed.changedPaths.length > 0 || input.changed.deletedPaths.length > 0)
  ) {
    const changedPathSet = new Set(input.changed.changedPaths);
    const deepFiles = input.inventory.files
      .filter(file => changedPathSet.has(file.path) && !file.oversized)
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      scoped: false,
      deepFiles,
      hotsetRevision: null,
      warnings: input.inventory.files
        .filter(file => changedPathSet.has(file.path) && file.oversized)
        .map(file => `${file.path}: oversized changed file kept file-only; no deep spans emitted`),
      changedTargetStrategy: 'git_delta_reindex',
      coverage: {
        inventory: 'full',
        deepSpans: 'full',
        hotsetRevision: null,
        hotFiles: input.inventory.files.length,
        coldFiles: 0,
        unindexedCandidateCount: 0,
        updatedAt: now
      }
    };
  }

  if (input.target === 'paths' || input.target === 'hotset' || (input.target === 'changed' && input.previousCoverage?.deepSpans === 'scoped')) {
    const manifest = await readHotsetManifest(input.projectRoot);
    const seedPaths = await detectCodexScientistHotsetSeedPaths(input.projectRoot, input.inventory.files);
    const byPath = new Map(input.inventory.files.map(file => [file.path, file]));
    const seedFiles = seedPaths.map(repoPath => byPath.get(repoPath)).filter((file): file is InventoryFile => Boolean(file));
    let nextManifest = manifest;

    if (input.target === 'paths') {
      const requested = resolveRequestedFiles(input.projectRoot, input.inventory, input.requestedPaths);
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: requested,
        reason: input.promotionReason ?? 'explicit_paths',
        pinned: true
      });
    }

    if (seedFiles.length > 0) {
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: seedFiles,
        reason: 'codex_scientist_seed',
        pinned: false
      });
    }

    const currentManifestFiles = manifestFiles(nextManifest, input.inventory.files);
    if (input.target === 'changed' && currentManifestFiles.length > 0) {
      nextManifest = upsertHotsetEntries({
        projectRoot: input.projectRoot,
        manifest: nextManifest,
        files: currentManifestFiles,
        reason: 'changed_hotset_refresh'
      });
    }

    await writeHotsetManifest(input.projectRoot, nextManifest);
    const entryByPath = new Map(nextManifest.entries.map(entry => [entry.path, entry]));
    const manifestHotFiles = manifestFiles(nextManifest, input.inventory.files);
    const skippedColdDefaults = manifestHotFiles.filter(file => isCodexScientistColdPath(file.path) && !entryByPath.get(file.path)?.pinned);
    const allHotFiles = manifestHotFiles.filter(file => !isCodexScientistColdPath(file.path) || Boolean(entryByPath.get(file.path)?.pinned));
    const deepFiles = allHotFiles.filter(file => !file.oversized).sort((left, right) => left.path.localeCompare(right.path));
    const revision = hotsetRevision(nextManifest);
    const hotPaths = new Set(allHotFiles.map(file => file.path));
    const warnings = [
      ...skippedColdDefaults.map(file => `${file.path}: cold-pattern file remains file-inventory only; use target=\"paths\" to explicitly promote`),
      ...allHotFiles
        .filter(file => file.oversized)
        .map(file => `${file.path}: oversized hotset file kept file-only; no deep spans emitted`)
    ];

    return {
      scoped: true,
      deepFiles,
      hotsetRevision: revision,
      warnings,
      coverage: {
        inventory: 'full',
        deepSpans: 'scoped',
        hotsetRevision: revision,
        hotFiles: hotPaths.size,
        coldFiles: input.inventory.files.length - hotPaths.size,
        unindexedCandidateCount: input.inventory.files.length - hotPaths.size,
        updatedAt: now
      }
    };
  }

  return {
    scoped: false,
    deepFiles: input.inventory.files,
    hotsetRevision: null,
    warnings: [],
    coverage: {
      inventory: 'full',
      deepSpans: 'full',
      hotsetRevision: null,
      hotFiles: input.inventory.files.length,
      coldFiles: 0,
      unindexedCandidateCount: 0,
      updatedAt: now
    }
  };
}
