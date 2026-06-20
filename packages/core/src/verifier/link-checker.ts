import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#');
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasAnchor(targetPath: string, anchor: string): Promise<boolean> {
  const text = await readFile(targetPath, 'utf8');
  const anchors = new Set(
    text
      .split(/\r?\n/)
      .filter(line => /^#{1,6}\s+/.test(line))
      .map(line => slug(line.replace(/^#{1,6}\s+/, '')))
  );
  return anchors.has(anchor.replace(/^#/, '').toLowerCase());
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
      text = await readFile(path.join(input.projectRoot, changedPath), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      const rawTarget = match[1];
      if (isExternal(rawTarget)) {
        continue;
      }
      const [targetPath, anchor] = rawTarget.split('#');
      const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(changedPath), targetPath));
      const absolute = path.join(input.projectRoot, resolvedPath);
      if (!(await exists(absolute))) {
        brokenLinks.push({ path: changedPath, target: rawTarget, resolvedPath });
        continue;
      }
      if (anchor && !(await hasAnchor(absolute, anchor))) {
        staleAnchors.push({ path: changedPath, target: rawTarget, anchor, resolvedPath });
      }
    }
  }

  return { brokenLinks, staleAnchors };
}
