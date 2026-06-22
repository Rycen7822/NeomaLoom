import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isGeneratedArtifactPath } from './role-classifier.js';
import { normalizeProjectRelativePath, resolveProjectReadPath, safeStatInsideProject } from '../safety/path-guard.js';

export const MAX_CHANGED_PATHS = 500;
export const MAX_DIRECTORY_EXPANSION_FILES = 1000;
export const HEAVY_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '.noemaloom',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'dist',
  'build',
  '.next'
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.rst',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.css',
  '.html',
  '.xml'
]);

export type BoundedChangedPathExpansion = {
  files: string[];
  truncated: boolean;
  warnings: string[];
};

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isTextChangedPath(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  return !isGeneratedArtifactPath(normalized) && (TEXT_EXTENSIONS.has(path.posix.extname(normalized)) || path.posix.basename(normalized).toUpperCase() === 'AGENTS.md');
}

export function isHeavyIgnoredChangedPath(repoPath: string): boolean {
  return normalizeRepoPath(repoPath).split('/').some(part => HEAVY_DIRECTORY_NAMES.has(part));
}

export async function boundedCollectChangedPathFiles(input: {
  projectRoot: string;
  changedPaths: string[];
  textOnly?: boolean;
  maxChangedPaths?: number;
  maxDirectoryFiles?: number;
}): Promise<BoundedChangedPathExpansion> {
  const maxChangedPaths = input.maxChangedPaths ?? MAX_CHANGED_PATHS;
  const maxDirectoryFiles = input.maxDirectoryFiles ?? MAX_DIRECTORY_EXPANSION_FILES;
  const warnings: string[] = [];
  const files = new Set<string>();
  let truncated = false;
  const root = path.resolve(input.projectRoot);

  if (input.changedPaths.length > maxChangedPaths) {
    truncated = true;
    warnings.push(`changedPaths truncated from ${input.changedPaths.length} to ${maxChangedPaths}`);
  }

  async function maybeAdd(repoPath: string): Promise<void> {
    if (files.size >= maxDirectoryFiles) {
      truncated = true;
      return;
    }
    if (input.textOnly && !isTextChangedPath(repoPath)) {
      return;
    }
    files.add(repoPath);
  }

  async function walk(dirAbs: string): Promise<void> {
    if (files.size >= maxDirectoryFiles) {
      truncated = true;
      return;
    }
    for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
      if (HEAVY_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const childAbs = path.join(dirAbs, entry.name);
      const childRelative = path.relative(root, childAbs).replaceAll('\\', '/');
      if (childRelative === '' || childRelative.startsWith('../') || childRelative === '..' || path.isAbsolute(childRelative)) {
        continue;
      }
      if (isHeavyIgnoredChangedPath(childRelative) || isGeneratedArtifactPath(childRelative)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childAbs);
      } else if (entry.isFile()) {
        await maybeAdd(childRelative);
      }
      if (files.size >= maxDirectoryFiles) {
        truncated = true;
        return;
      }
    }
  }

  for (const rawPath of input.changedPaths.slice(0, maxChangedPaths).map(normalizeRepoPath).filter(Boolean)) {
    let normalized: string;
    try {
      normalized = normalizeProjectRelativePath(input.projectRoot, rawPath);
    } catch {
      continue;
    }
    if (isHeavyIgnoredChangedPath(normalized)) {
      continue;
    }
    let info;
    try {
      info = await safeStatInsideProject(input.projectRoot, normalized);
    } catch {
      if (!input.textOnly || isTextChangedPath(normalized)) {
        files.add(normalized);
      }
      continue;
    }
    if (info.isFile()) {
      await maybeAdd(normalized);
    } else if (info.isDirectory()) {
      await walk(resolveProjectReadPath(input.projectRoot, normalized));
    }
  }

  return { files: [...files].sort(), truncated, warnings };
}
