import { readdir } from 'node:fs/promises';
import path from 'node:path';

function toRepoPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

export async function walkFiles(
  projectRoot: string,
  shouldSkipPath: (repoPath: string) => boolean = () => false
): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const repoPath = toRepoPath(projectRoot, absolutePath);

      if (entry.isDirectory()) {
        if (entry.name === '.git' || shouldSkipPath(repoPath)) {
          continue;
        }

        await visit(absolutePath);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        results.push(repoPath);
      }
    }
  }

  await visit(projectRoot);
  return results.sort();
}
