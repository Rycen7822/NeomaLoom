import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { relativeRepoPath as toRepoPath } from '../shared/repo-path.js';

export const DEFAULT_MAX_WALK_DEPTH = 64;

export async function walkFiles(
  projectRoot: string,
  shouldSkipPath: (repoPath: string) => boolean = () => false,
  onSkippedPath: (repoPath: string) => void = () => undefined
): Promise<string[]> {
  const results: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: projectRoot, depth: 0 }];

  while (stack.length > 0) {
    const { directory, depth } = stack.pop() as { directory: string; depth: number };
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const repoPath = toRepoPath(projectRoot, absolutePath);

      if (entry.isDirectory()) {
        if (entry.name === '.git' || shouldSkipPath(repoPath) || depth + 1 >= DEFAULT_MAX_WALK_DEPTH) {
          onSkippedPath(repoPath);
          continue;
        }

        stack.push({ directory: absolutePath, depth: depth + 1 });
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        results.push(repoPath);
      }
    }
  }

  return results.sort();
}
