import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultConfig, type NoemaLoomConfig } from '../config/default-config.js';
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
  const absolutePath = path.join(projectRoot, repoPath);
  const fileStat = await stat(absolutePath);
  const role = classifyFileRole(repoPath);
  const oversized = fileStat.size > maxFileBytes;
  let contentHash = `oversized:${fileStat.size}:${Math.floor(fileStat.mtimeMs)}`;
  let indexedText = '';

  if (!oversized) {
    const content = await readFile(absolutePath);
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
  return (await lstat(path.join(projectRoot, repoPath))).isSymbolicLink();
}

export async function buildFileInventory(options: BuildFileInventoryOptions): Promise<FileInventory> {
  const projectRoot = path.resolve(options.projectRoot);
  const config = options.config ?? createDefaultConfig(projectRoot);
  const ignoreMatcher = createIgnoreMatcher(config.fileInventory.ignoreGlobs, {
    includeVendor: options.includeVendor
  });
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
