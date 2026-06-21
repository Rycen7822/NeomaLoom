import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkMarkdownLinks } from '../../packages/core/src/verifier/link-checker.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-link-checker-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

describe('markdown link checker', () => {
  it('does not scan malformed links across line boundaries', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(projectRoot, 'docs/readme.md', '[broken\nlabel](missing.md)\n');

    const result = await checkMarkdownLinks({ projectRoot, changedPaths: ['docs/readme.md'] });

    expect(result.brokenLinks).toEqual([]);
    expect(result.staleAnchors).toEqual([]);
  });
});
