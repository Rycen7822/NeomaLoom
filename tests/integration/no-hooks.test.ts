import { access, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-no-hooks-'));
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await writeProjectFile(projectRoot, 'src/index.ts', 'export const value = 1;\n');
  return projectRoot;
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

describe('refresh safety', () => {
  it('does not create git hooks', async () => {
    const projectRoot = await createProject();

    await expect(access(path.join(projectRoot, '.git', 'hooks'))).rejects.toThrow();
    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    await expect(access(path.join(projectRoot, '.git', 'hooks'))).rejects.toThrow();
  });
});
