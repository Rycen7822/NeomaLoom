import { createHash } from 'node:crypto';
import path from 'node:path';

import { createDefaultConfig, type NoemaLoomConfig } from '../config/default-config.js';
import { ProjectReadPathGuardError, safeLstatInsideProject, safeReadFileInsideProject, safeStatInsideProject, resolveProjectReadPath } from '../safety/path-guard.js';
import type { FileRole, SpanKind } from '../spans/enums.js';
import { isGitRepository, listGitVisibleFiles } from './git-files.js';
import { createIgnoreMatcher } from './ignore-rules.js';
import { languageForPath } from './language.js';
import { classifyFileRole } from './role-classifier.js';
import { walkFiles } from './walk-files.js';

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
};

export type PreviousInventoryFile = {
  path: string;
  contentHash: string;
  sizeBytes?: number;
  modifiedAt?: number;
};

export type BuildFileInventoryOptions = {
  projectRoot: string;
  config?: NoemaLoomConfig;
  includeVendor?: boolean;
  loadIndexedText?: boolean;
  previousFiles?: PreviousInventoryFile[];
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

async function listCandidateFiles(projectRoot: string): Promise<{ candidates: string[]; skippedPaths: string[] }> {
  if (await isGitRepository(projectRoot)) {
    return { candidates: await listGitVisibleFiles(projectRoot), skippedPaths: [] };
  }

  const skippedPaths: string[] = [];
  return {
    candidates: await walkFiles(projectRoot, () => false, repoPath => skippedPaths.push(repoPath)),
    skippedPaths
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

export async function buildFileInventory(options: BuildFileInventoryOptions): Promise<FileInventory> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const ignoreMatcher = createIgnoreMatcher(config.fileInventory.ignoreGlobs, {
    includeVendor: options.includeVendor
  });
  const includeExtensions = new Set(config.fileInventory.includeExtensions.map(normalizeExtension));
  const listed = await listCandidateFiles(projectRoot);
  const candidates = listed.candidates.map(toRepoPath).sort();
  const ignoredPaths: string[] = listed.skippedPaths.map(toRepoPath);
  const files: InventoryFile[] = [];
  const indexedAt = Date.now();
  const loadIndexedText = options.loadIndexedText ?? true;
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [toRepoPath(file.path), file]));

  const results = await mapWithConcurrency(candidates, INVENTORY_BUILD_CONCURRENCY, async (repoPath): Promise<InventoryBuildResult> => {
    if (isSensitivePath(repoPath)) {
      return { ignoredPath: repoPath };
    }

    if (ignoreMatcher.ignores(repoPath)) {
      return { ignoredPath: repoPath };
    }

    if (!isIncludedExtension(repoPath, includeExtensions)) {
      return { ignoredPath: repoPath };
    }

    if (await isSymlink(projectRoot, repoPath)) {
      return { ignoredPath: repoPath };
    }

    return {
      file: await createInventoryFile(projectRoot, repoPath, config.indexing.maxFileBytes, indexedAt, loadIndexedText, previousByPath)
    };
  });

  for (const result of results) {
    if (result.file) {
      files.push(result.file);
    } else {
      ignoredPaths.push(result.ignoredPath);
    }
  }

  return {
    files,
    ignoredPaths: ignoredPaths.sort()
  };
}
