import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { indexCodeFacts } from '../../packages/core/src/code-fact/code-fact-indexer.js';
import { createToolRegistry } from '../../packages/core/src/mcp/tool-registry.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-no-codegraph-dir-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

describe('CodeGraph-derived boundary', () => {
  it('does not create .codegraph and does not expose raw codegraph tools', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(projectRoot, 'src/index.ts', 'export const value = 1;\n');
    const rawToolNames = createToolRegistry().map(tool => tool.name).filter(name => name.startsWith('codegraph_'));

    await expect(access(path.join(projectRoot, '.codegraph'))).rejects.toThrow();
    await indexCodeFacts({ projectRoot });

    await expect(access(path.join(projectRoot, '.codegraph'))).rejects.toThrow();
    expect(rawToolNames).toEqual([]);
  });
});
