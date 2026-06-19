import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool, createToolRegistry } from '../../packages/core/src/mcp/tool-registry.js';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

describe('final safety assertions', () => {
  it('keeps forbidden surfaces absent and degrades on worker crash', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-final-safety-'));
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'noemaloom-home-'));
    const fakeHermes = await mkdtemp(path.join(tmpdir(), 'noemaloom-hermes-'));
    await writeProjectFile(projectRoot, '.gitignore', 'node_modules\n');
    await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
    await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nUse `createClient` and oldTerm.\n');
    const originalGitignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    const originalPython = process.env.PYTHON;
    const originalHome = process.env.HOME;
    const originalHermes = process.env.HERMES_HOME;
    process.env.PYTHON = path.join(projectRoot, 'missing-python');
    process.env.HOME = fakeHome;
    process.env.HERMES_HOME = fakeHermes;
    try {
      const refresh = await callRegisteredTool('nl_refresh', {
        projectPath: projectRoot,
        target: 'all',
        mode: 'safe'
      });
      expect(refresh.ok).toBe(true);
      expect(refresh.warnings.some(warning => warning.message.includes('missing-python'))).toBe(true);
    } finally {
      if (originalPython === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = originalPython;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalHermes === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermes;
    }

    expect(await exists(path.join(projectRoot, '.codegraph'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.rpgkit'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.git/hooks/noemaloom'))).toBe(false);
    expect(await exists(path.join(fakeHome, '.codex/noemaloom'))).toBe(false);
    expect(await exists(path.join(fakeHermes, 'noemaloom'))).toBe(false);
    expect(await readFile(path.join(projectRoot, '.gitignore'), 'utf8')).toBe(originalGitignore);
    expect(await exists(path.join(projectRoot, '.noemaloom/experiment-ledger.jsonl'))).toBe(false);
    expect(await exists(path.join(projectRoot, '.noemaloom/claim-ledger.jsonl'))).toBe(false);

    const toolNames = createToolRegistry().map(tool => tool.name);
    expect(toolNames).not.toContain('nl_skill');
    expect(toolNames).not.toEqual(expect.arrayContaining([
      'nl_query',
      'nl_locate',
      'nl_context',
      'nl_read_span',
      'nl_trace',
      'nl_impact',
      'nl_verify_coverage'
    ]));
    expect(toolNames).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^codegraph_/),
      expect.stringMatching(/^rpg/),
      expect.stringMatching(/writer|memory|ledger/)
    ]));

    const coverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Remove oldTerm',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['oldTerm'],
      newTerms: ['newTerm']
    });
    expect(coverage.data).toMatchObject({ status: 'fail', coverage: { status: 'fail' } });
  });
});
