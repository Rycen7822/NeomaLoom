import path from 'node:path';

import { createGithubSlugger } from '../documents/github-slug.js';
import { normalizeProjectRelativePath, safeReadFileInsideProject, safeStatInsideProject } from '../safety/path-guard.js';

export type BrokenLink = {
  path: string;
  target: string;
  resolvedPath: string;
};

export type StaleAnchor = {
  path: string;
  target: string;
  anchor: string;
  resolvedPath: string;
};

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || /^[A-Za-z]:[\\/]/.test(target) || /^\\\\/.test(target);
}

function normalizeRawTarget(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

function normalizeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor.replace(/^#/, '')).toLowerCase();
  } catch {
    return anchor.replace(/^#/, '').toLowerCase();
  }
}

async function exists(projectRoot: string, repoPath: string): Promise<boolean> {
  try {
    const info = await safeStatInsideProject(projectRoot, repoPath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function hasAnchor(projectRoot: string, targetPath: string, anchor: string): Promise<boolean> {
  const text = await safeReadFileInsideProject(projectRoot, targetPath, 'utf8');
  const slugger = createGithubSlugger();
  const anchors = new Set(
    text
      .split(/\r?\n/)
      .filter(line => /^#{1,6}\s+/.test(line))
      .map(line => slugger.slug(line.replace(/^#{1,6}\s+/, '')))
  );
  return anchors.has(normalizeAnchor(anchor));
}

export async function checkMarkdownLinks(input: {
  projectRoot: string;
  changedPaths: string[];
}): Promise<{ brokenLinks: BrokenLink[]; staleAnchors: StaleAnchor[] }> {
  const brokenLinks: BrokenLink[] = [];
  const staleAnchors: StaleAnchor[] = [];

  for (const changedPath of input.changedPaths.filter(file => /\.(md|mdx|rst)$/i.test(file))) {
    let text = '';
    try {
      text = await safeReadFileInsideProject(input.projectRoot, changedPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      for (const match of line.matchAll(/\[[^\]\r\n]+\]\(([^)\s\r\n]+)\)/g)) {
        const rawTarget = normalizeRawTarget(match[1]);
        if (isExternal(rawTarget)) {
          continue;
        }
        const [targetPath, anchor] = rawTarget.split('#');
        let resolvedPath: string;
        try {
          resolvedPath = normalizeProjectRelativePath(
            input.projectRoot,
            targetPath
              ? path.posix.normalize(path.posix.join(path.posix.dirname(changedPath), targetPath))
              : changedPath
          );
        } catch {
          brokenLinks.push({ path: changedPath, target: rawTarget, resolvedPath: targetPath });
          continue;
        }
        if (!(await exists(input.projectRoot, resolvedPath))) {
          brokenLinks.push({ path: changedPath, target: rawTarget, resolvedPath });
          continue;
        }
        if (anchor && !(await hasAnchor(input.projectRoot, resolvedPath, anchor))) {
          staleAnchors.push({ path: changedPath, target: rawTarget, anchor, resolvedPath });
        }
      }
    }
  }

  return { brokenLinks, staleAnchors };
}
