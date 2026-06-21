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

export type BuildFileInventoryOptions = {
  projectRoot: string;
  config?: NoemaLoomConfig;
  includeVendor?: boolean;
  loadIndexedText?: boolean;
};

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

function isIncludedExtension(repoPath: string, includeExtensions: Set<string>): boolean {
  if (includeExtensions.size === 0) {
    return true;
  }
  const extension = path.posix.extname(repoPath).toLowerCase();
  return extension === '' || includeExtensions.has(extension);
}

async function listCandidateFiles(projectRoot: string): Promise<string[]> {
  if (await isGitRepository(projectRoot)) {
    return listGitVisibleFiles(projectRoot);
  }

  return walkFiles(projectRoot);
}

async function createInventoryFile(
  projectRoot: string,
  repoPath: string,
  maxFileBytes: number,
  indexedAt: number,
  loadIndexedText: boolean
): Promise<InventoryFile> {
  const absolutePath = resolveProjectReadPath(projectRoot, repoPath);
  const fileStat = await safeStatInsideProject(projectRoot, repoPath);
  const role = classifyFileRole(repoPath);
  const oversized = fileStat.size > maxFileBytes;
  let contentHash = `oversized:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
  let indexedText = '';

  if (!oversized) {
    const content = await safeReadFileInsideProject(projectRoot, repoPath);
    contentHash = sha1(content);
    indexedText = loadIndexedText ? content.toString('utf8') : '';
  }

  return {
    path: repoPath,
    absolutePath,
    role,
    language: languageForPath(repoPath),
    contentHash,
    sizeBytes: fileStat.size,
    modifiedAt: Math.floor(fileStat.mtimeMs),
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

export async function buildFileInventory(options: BuildFileInventoryOptions): Promise<FileInventory> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const ignoreMatcher = createIgnoreMatcher(config.fileInventory.ignoreGlobs, {
    includeVendor: options.includeVendor
  });
  const includeExtensions = new Set(config.fileInventory.includeExtensions.map(normalizeExtension));
  const candidates = (await listCandidateFiles(projectRoot)).map(toRepoPath).sort();
  const ignoredPaths: string[] = [];
  const files: InventoryFile[] = [];
  const indexedAt = Date.now();
  const loadIndexedText = options.loadIndexedText ?? true;

  for (const repoPath of candidates) {
    if (ignoreMatcher.ignores(repoPath)) {
      ignoredPaths.push(repoPath);
      continue;
    }

    if (!isIncludedExtension(repoPath, includeExtensions)) {
      ignoredPaths.push(repoPath);
      continue;
    }

    if (await isSymlink(projectRoot, repoPath)) {
      ignoredPaths.push(repoPath);
      continue;
    }

    files.push(await createInventoryFile(projectRoot, repoPath, config.indexing.maxFileBytes, indexedAt, loadIndexedText));
  }

  return {
    files,
    ignoredPaths: ignoredPaths.sort()
  };
}
