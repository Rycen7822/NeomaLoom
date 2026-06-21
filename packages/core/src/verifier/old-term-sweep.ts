import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isGeneratedArtifactPath } from '../files/role-classifier.js';
import { classifyPathLayer } from '../files/path-layer.js';
import { normalizeProjectRelativePath, resolveProjectReadPath, safeReadFileInsideProject, safeStatInsideProject } from '../safety/path-guard.js';

export type OldTermHit = {
  path: string;
  line: number;
  term: string;
  text: string;
  pathLayer: string;
  severity: 'fail';
};

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.rst', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.sh', '.bash', '.zsh', '.sql', '.css', '.html', '.xml'
]);
const MAX_CHANGED_PATHS = 500;
const MAX_DIRECTORY_EXPANSION_FILES = 1000;
const HEAVY_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.noemaloom', '__pycache__', '.venv', 'venv', '.tox']);

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isTextPath(repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  return !isGeneratedArtifactPath(normalized) && (TEXT_EXTENSIONS.has(path.posix.extname(normalized)) || path.posix.basename(repoPath).toUpperCase() === 'AGENTS.md'.toUpperCase());
}

function isHeavyIgnoredPath(repoPath: string): boolean {
  return normalizeRepoPath(repoPath).split('/').some(part => HEAVY_DIRECTORY_NAMES.has(part));
}

async function expandChangedPath(projectRoot: string, repoPath: string): Promise<string[]> {
  let normalized: string;
  try {
    normalized = normalizeProjectRelativePath(projectRoot, repoPath);
  } catch {
    return [];
  }
  if (isHeavyIgnoredPath(normalized)) {
    return [];
  }
  const absolute = resolveProjectReadPath(projectRoot, normalized);
  const root = path.resolve(projectRoot);

  let info;
  try {
    info = await safeStatInsideProject(projectRoot, normalized);
  } catch {
    return [];
  }
  if (info.isFile()) {
    return isTextPath(normalized) ? [normalized] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (HEAVY_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      const childRelative = path.relative(root, child).replaceAll('\\', '/');
      if (isHeavyIgnoredPath(childRelative) || isGeneratedArtifactPath(childRelative)) {
        continue;
      }
      if (out.length >= MAX_DIRECTORY_EXPANSION_FILES) {
        return;
      }
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && isTextPath(childRelative)) {
        out.push(childRelative);
      }
    }
  }
  await walk(absolute);
  return out.sort();
}

export async function sweepOldTerms(input: {
  projectRoot: string;
  changedPaths: string[];
  oldTerms: string[];
}): Promise<OldTermHit[]> {
  const hits: OldTermHit[] = [];
  const changedPaths = input.changedPaths.slice(0, MAX_CHANGED_PATHS);
  const expandedPaths = [...new Set((await Promise.all(changedPaths.map(changedPath => expandChangedPath(input.projectRoot, changedPath)))).flat())];
  for (const changedPath of expandedPaths) {
    let text = '';
    try {
      text = await safeReadFileInsideProject(input.projectRoot, changedPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const term of input.oldTerms) {
        if (term && line.includes(term)) {
          hits.push({ path: changedPath, line: index + 1, term, text: line.trim(), pathLayer: classifyPathLayer(changedPath), severity: 'fail' });
        }
      }
    });
  }
  return hits;
}
