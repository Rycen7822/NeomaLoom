import { createHash } from 'node:crypto';
import path from 'node:path';

import { createDefaultConfig, type NoemaLoomConfig } from '../config/default-config.js';
import { ProjectReadPathGuardError, safeLstatInsideProject, safeReadFileInsideProject, safeStatInsideProject, resolveProjectReadPath } from '../safety/path-guard.js';
import type { FileRole, SpanKind } from '../spans/enums.js';
import { isGitRepository, listGitVisibleFiles } from './git-files.js';
import { createIgnoreMatcher, type IgnoreMatcher } from './ignore-rules.js';
import { languageForPath } from './language.js';
import { classifyFileRole } from './role-classifier.js';
import { DEFAULT_MAX_WALK_DEPTH, walkFiles } from './walk-files.js';

export type InventoryFile = {
  path: string;
  absolutePath: string;
  role: FileRole;
  language: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: number;
  indexedAt: number;
  generated: boolean;
  ignored: false;
  oversized: boolean;
  fileOnlySpan: boolean;
  spanKind: Extract<SpanKind, 'file'>;
  indexedText: string;
};

export type FileInventory = {
  files: InventoryFile[];
  ignoredPaths: string[];
  strategy?: FileInventoryStrategy;
};

export type FileInventoryStrategySource = 'git' | 'walk' | 'snapshot_plus_requested_paths' | 'snapshot_plus_hotset' | 'snapshot_plus_git_changed';

export type FileInventoryStrategy = {
  source: FileInventoryStrategySource;
  candidateFiles: number;
  includedFiles: number;
  ignoredPaths: number;
  prunedDirs: number;
  prunedDirSamples: string[];
  maxWalkDepth: number | null;
};

export type PreviousInventoryFile = {
  path: string;
  contentHash: string;
  sizeBytes?: number;
  modifiedAt?: number;
  indexedAt?: number;
  role?: FileRole;
  language?: string;
  generated?: boolean;
  oversized?: boolean;
  fileOnlySpan?: boolean;
};

export type BuildFileInventoryOptions = {
  projectRoot: string;
  config?: NoemaLoomConfig;
  includeVendor?: boolean;
  loadIndexedText?: boolean;
  previousFiles?: PreviousInventoryFile[];
};

export type BuildFileInventoryForPathsOptions = BuildFileInventoryOptions & {
  paths: string[];
  allowMissing?: boolean;
};

export type BuildFileInventoryFromSnapshotOptions = {
  projectRoot: string;
  config?: NoemaLoomConfig;
  previousFiles: PreviousInventoryFile[];
  refreshedFiles?: InventoryFile[];
  deletedPaths?: string[];
  ignoredPaths?: string[];
  source: Extract<FileInventoryStrategySource, 'snapshot_plus_requested_paths' | 'snapshot_plus_hotset' | 'snapshot_plus_git_changed'>;
};

const INVENTORY_BUILD_CONCURRENCY = 8;

function toRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(?:$|[._-])/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.aws(?:\/|$)/i,
  /(^|\/)\.gnupg(?:\/|$)/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.ssh(?:\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)htpasswd$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(^|\/)secrets?\.(?:json|ya?ml|toml|ini)$/i,
  /(^|\/)credentials(?:$|[._-])/i
];

function isSensitivePath(repoPath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(repoPath));
}

function isIncludedExtension(repoPath: string, includeExtensions: Set<string>): boolean {
  if (includeExtensions.size === 0) {
    return true;
  }
  const extension = path.posix.extname(repoPath).toLowerCase();
  return includeExtensions.has(extension);
}

type CandidateListing = {
  source: 'git' | 'walk';
  candidates: string[];
  skippedPaths: string[];
  prunedDirs: string[];
  maxWalkDepth: number | null;
};

const DIRECTORY_PRUNE_PROBE = '__noemaloom_directory_prune_probe__';

function shouldPruneIgnoredDirectory(ignoreMatcher: IgnoreMatcher, repoPath: string): boolean {
  return ignoreMatcher.ignores(`${repoPath}/${DIRECTORY_PRUNE_PROBE}/${DIRECTORY_PRUNE_PROBE}`);
}

function sortedUniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(toRepoPath))].sort();
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function normalizeRequestedRepoPath(projectRoot: string, requestedPath: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const absolute = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(resolvedRoot, requestedPath);
  const relative = path.relative(resolvedRoot, absolute).replaceAll('\\', '/');
  if (relative === '' || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`inventory path escapes project root: ${requestedPath}`);
  }
  return toRepoPath(relative);
}

async function fileExists(projectRoot: string, repoPath: string): Promise<boolean> {
  try {
    return (await safeStatInsideProject(projectRoot, repoPath)).isFile();
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function listCandidateFiles(projectRoot: string, ignoreMatcher: IgnoreMatcher): Promise<CandidateListing> {
  if (await isGitRepository(projectRoot)) {
    return { source: 'git', candidates: await listGitVisibleFiles(projectRoot), skippedPaths: [], prunedDirs: [], maxWalkDepth: null };
  }

  const skippedPaths: string[] = [];
  const prunedDirs: string[] = [];
  const shouldPrunePath = (repoPath: string): boolean => shouldPruneIgnoredDirectory(ignoreMatcher, repoPath);
  return {
    source: 'walk',
    candidates: await walkFiles(projectRoot, shouldPrunePath, repoPath => {
      skippedPaths.push(repoPath);
      if (shouldPrunePath(repoPath)) {
        prunedDirs.push(repoPath);
      }
    }),
    skippedPaths,
    prunedDirs,
    maxWalkDepth: DEFAULT_MAX_WALK_DEPTH
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function reusablePreviousHash(previous: PreviousInventoryFile | undefined, sizeBytes: number, modifiedAt: number): string | undefined {
  if (!previous || previous.sizeBytes !== sizeBytes || previous.modifiedAt !== modifiedAt) {
    return undefined;
  }
  return previous.contentHash || undefined;
}

async function createInventoryFile(
  projectRoot: string,
  repoPath: string,
  maxFileBytes: number,
  indexedAt: number,
  loadIndexedText: boolean,
  previousByPath: Map<string, PreviousInventoryFile>
): Promise<InventoryFile> {
  const absolutePath = resolveProjectReadPath(projectRoot, repoPath);
  const fileStat = await safeStatInsideProject(projectRoot, repoPath);
  const role = classifyFileRole(repoPath);
  const oversized = fileStat.size > maxFileBytes;
  const modifiedAt = Math.floor(fileStat.mtimeMs);
  let contentHash = `oversized:${fileStat.size}:${modifiedAt}`;
  let indexedText = '';

  if (!oversized) {
    const previousHash = loadIndexedText ? undefined : reusablePreviousHash(previousByPath.get(repoPath), fileStat.size, modifiedAt);
    if (previousHash) {
      contentHash = previousHash;
    } else {
      const content = await safeReadFileInsideProject(projectRoot, repoPath);
      contentHash = sha1(content);
      indexedText = loadIndexedText ? content.toString('utf8') : '';
    }
  }

  return {
    path: repoPath,
    absolutePath,
    role,
    language: languageForPath(repoPath),
    contentHash,
    sizeBytes: fileStat.size,
    modifiedAt,
    indexedAt,
    generated: role === 'generated_file',
    ignored: false,
    oversized,
    fileOnlySpan: oversized,
    spanKind: 'file',
    indexedText
  };
}

async function isSymlink(projectRoot: string, repoPath: string): Promise<boolean> {
  try {
    return (await safeLstatInsideProject(projectRoot, repoPath)).isSymbolicLink();
  } catch (error) {
    if (error instanceof ProjectReadPathGuardError) {
      return true;
    }
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

type InventoryBuildResult = { file: InventoryFile; ignoredPath?: undefined } | { file?: undefined; ignoredPath: string };

async function createInventoryBuildResult(input: {
  projectRoot: string;
  repoPath: string;
  config: NoemaLoomConfig;
  ignoreMatcher: IgnoreMatcher;
  includeExtensions: Set<string>;
  indexedAt: number;
  loadIndexedText: boolean;
  previousByPath: Map<string, PreviousInventoryFile>;
  checkFileExists?: boolean;
}): Promise<InventoryBuildResult> {
  if (isSensitivePath(input.repoPath)) {
    return { ignoredPath: input.repoPath };
  }

  if (input.ignoreMatcher.ignores(input.repoPath)) {
    return { ignoredPath: input.repoPath };
  }

  if (!isIncludedExtension(input.repoPath, input.includeExtensions)) {
    return { ignoredPath: input.repoPath };
  }

  if (input.checkFileExists && !(await fileExists(input.projectRoot, input.repoPath))) {
    return { ignoredPath: input.repoPath };
  }

  if (await isSymlink(input.projectRoot, input.repoPath)) {
    return { ignoredPath: input.repoPath };
  }

  return {
    file: await createInventoryFile(
      input.projectRoot,
      input.repoPath,
      input.config.indexing.maxFileBytes,
      input.indexedAt,
      input.loadIndexedText,
      input.previousByPath
    )
  };
}

function inventoryFileFromSnapshot(projectRoot: string, config: NoemaLoomConfig, previous: PreviousInventoryFile, indexedAt: number): InventoryFile | undefined {
  if (!previous.path || !previous.contentHash) {
    return undefined;
  }
  const repoPath = toRepoPath(previous.path);
  try {
    const role = previous.role ?? classifyFileRole(repoPath);
    const sizeBytes = Number(previous.sizeBytes ?? 0);
    const modifiedAt = Number(previous.modifiedAt ?? 0);
    const oversized = typeof previous.oversized === 'boolean'
      ? previous.oversized
      : sizeBytes > config.indexing.maxFileBytes;
    return {
      path: repoPath,
      absolutePath: resolveProjectReadPath(projectRoot, repoPath),
      role,
      language: previous.language ?? languageForPath(repoPath),
      contentHash: previous.contentHash,
      sizeBytes,
      modifiedAt,
      indexedAt: Number(previous.indexedAt ?? indexedAt),
      generated: typeof previous.generated === 'boolean' ? previous.generated : role === 'generated_file',
      ignored: false,
      oversized,
      fileOnlySpan: typeof previous.fileOnlySpan === 'boolean' ? previous.fileOnlySpan : oversized,
      spanKind: 'file',
      indexedText: ''
    };
  } catch {
    return undefined;
  }
}

export function buildFileInventoryFromSnapshot(options: BuildFileInventoryFromSnapshotOptions): FileInventory {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const indexedAt = Date.now();
  const refreshedByPath = new Map((options.refreshedFiles ?? []).map(file => [toRepoPath(file.path), file]));
  const deletedPaths = new Set((options.deletedPaths ?? []).map(toRepoPath));
  const filesByPath = new Map<string, InventoryFile>();

  for (const previous of options.previousFiles) {
    const repoPath = toRepoPath(previous.path);
    if (deletedPaths.has(repoPath)) {
      continue;
    }
    const refreshed = refreshedByPath.get(repoPath);
    if (refreshed) {
      filesByPath.set(repoPath, refreshed);
      refreshedByPath.delete(repoPath);
      continue;
    }
    const fromSnapshot = inventoryFileFromSnapshot(projectRoot, config, previous, indexedAt);
    if (fromSnapshot) {
      filesByPath.set(fromSnapshot.path, fromSnapshot);
    }
  }

  for (const refreshed of refreshedByPath.values()) {
    filesByPath.set(toRepoPath(refreshed.path), refreshed);
  }

  const files = [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const ignoredPaths = sortedUniquePaths(options.ignoredPaths ?? []);
  return {
    files,
    ignoredPaths,
    strategy: {
      source: options.source,
      candidateFiles: options.previousFiles.length + (options.refreshedFiles?.length ?? 0),
      includedFiles: files.length,
      ignoredPaths: ignoredPaths.length,
      prunedDirs: 0,
      prunedDirSamples: [],
      maxWalkDepth: null
    }
  };
}

export async function buildFileInventoryForPaths(options: BuildFileInventoryForPathsOptions): Promise<FileInventory> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const ignoreMatcher = createIgnoreMatcher(config.fileInventory.ignoreGlobs, {
    includeVendor: options.includeVendor
  });
  const includeExtensions = new Set(config.fileInventory.includeExtensions.map(normalizeExtension));
  const candidates = sortedUniquePaths(options.paths.map(requestedPath => normalizeRequestedRepoPath(projectRoot, requestedPath)));
  const indexedAt = Date.now();
  const loadIndexedText = options.loadIndexedText ?? true;
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [toRepoPath(file.path), file]));
  const results = await mapWithConcurrency(candidates, INVENTORY_BUILD_CONCURRENCY, async (repoPath): Promise<InventoryBuildResult> =>
    createInventoryBuildResult({
      projectRoot,
      repoPath,
      config,
      ignoreMatcher,
      includeExtensions,
      indexedAt,
      loadIndexedText,
      previousByPath,
      checkFileExists: true
    })
  );
  const files: InventoryFile[] = [];
  const ignoredPaths: string[] = [];
  for (const result of results) {
    if (result.file) {
      files.push(result.file);
    } else {
      ignoredPaths.push(result.ignoredPath);
    }
  }
  if (!options.allowMissing) {
    const included = new Set(files.map(file => file.path));
    const missing = candidates.filter(repoPath => !included.has(repoPath));
    if (missing.length > 0) {
      throw new Error(`hotset path is not in the current file inventory: ${missing[0]}`);
    }
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    ignoredPaths: sortedUniquePaths(ignoredPaths),
    strategy: {
      source: 'walk',
      candidateFiles: candidates.length,
      includedFiles: files.length,
      ignoredPaths: sortedUniquePaths(ignoredPaths).length,
      prunedDirs: 0,
      prunedDirSamples: [],
      maxWalkDepth: null
    }
  };
}

export async function buildFileInventory(options: BuildFileInventoryOptions): Promise<FileInventory> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const ignoreMatcher = createIgnoreMatcher(config.fileInventory.ignoreGlobs, {
    includeVendor: options.includeVendor
  });
  const includeExtensions = new Set(config.fileInventory.includeExtensions.map(normalizeExtension));
  const listed = await listCandidateFiles(projectRoot, ignoreMatcher);
  const candidates = listed.candidates.map(toRepoPath).sort();
  const ignoredPaths: string[] = sortedUniquePaths(listed.skippedPaths);
  const files: InventoryFile[] = [];
  const indexedAt = Date.now();
  const loadIndexedText = options.loadIndexedText ?? true;
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [toRepoPath(file.path), file]));

  const results = await mapWithConcurrency(candidates, INVENTORY_BUILD_CONCURRENCY, async (repoPath): Promise<InventoryBuildResult> =>
    createInventoryBuildResult({ projectRoot, repoPath, config, ignoreMatcher, includeExtensions, indexedAt, loadIndexedText, previousByPath })
  );

  for (const result of results) {
    if (result.file) {
      files.push(result.file);
    } else {
      ignoredPaths.push(result.ignoredPath);
    }
  }

  const sortedIgnoredPaths = sortedUniquePaths(ignoredPaths);
  const prunedDirs = sortedUniquePaths(listed.prunedDirs);

  return {
    files,
    ignoredPaths: sortedIgnoredPaths,
    strategy: {
      source: listed.source,
      candidateFiles: candidates.length,
      includedFiles: files.length,
      ignoredPaths: sortedIgnoredPaths.length,
      prunedDirs: prunedDirs.length,
      prunedDirSamples: prunedDirs.slice(0, 20),
      maxWalkDepth: listed.maxWalkDepth
    }
  };
}
