import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-locate-doc-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'locate-doc-demo' }, null, 2));
  await writeProjectFile(
    projectRoot,
    'src/client.ts',
    [
      'export type ClientOptions = { timeoutMs?: number };',
      'export function createClient(options: ClientOptions = {}) {',
      '  return { timeoutMs: options.timeoutMs ?? 1000 };',
      '}',
      ''
    ].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'docs/api/client.md',
    [
      '# Client API',
      '',
      '## createClient',
      '',
      '`createClient` accepts timeout options for API calls.',
      '',
      '| Option | Description |',
      '| --- | --- |',
      '| `timeoutMs` | Timeout in milliseconds. |',
      ''
    ].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'README.md',
    ['# Locate Demo', '', 'Use `createClient` with timeout options for quick starts.', ''].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'examples/client.md',
    ['# Client Example', '', 'The example calls `createClient` and sets `timeoutMs`.', ''].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'tests/client.test.ts',
    ['import { createClient } from "../src/client";', 'test("uses timeout", () => createClient({ timeoutMs: 50 }));', ''].join('\n')
  );
  return projectRoot;
}

describe('nl_prepare_context for a documentation update', () => {
  it('returns multi-document targets with decisions and coverage plan without collapsing similar docs', async () => {
    const projectRoot = await createProject();
    const refresh = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    expect(refresh.ok).toBe(true);

    const prepared = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Update createClient timeout documentation across API docs, README, examples, source, and tests',
      targetRoles: ['document', 'source', 'test'],
      limit: 20,
      budget: 2400,
      includeSnippets: true,
      responseProfile: 'debug'
    });

    expect(prepared.ok).toBe(true);
    expect(prepared.tool).toBe('nl_prepare_context');
    expect(prepared.warnings.filter(warning => warning.code === 'coverage_missing')).toEqual([]);
    expect(prepared.graphRevision).toBe(refresh.graphRevision);
    const preparedData = prepared.data as {
      queryPreview: Array<Record<string, unknown>>;
      targets: Array<{ path: string; role: string; decision: string }>;
      coveragePlan: { pathRolesToVerify: string[] };
      context: {
        primaryTargets: Array<{ path: string; decision: string }>;
      };
    };
    expect(preparedData.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'docs/api/client.md',
          role: 'canonical_api_doc',
          decision: 'must_edit',
          scoreBreakdown: expect.objectContaining({ exactTermScore: expect.any(Number) })
        }),
        expect.objectContaining({
          path: 'README.md',
          role: 'readme_doc'
        }),
        expect.objectContaining({
          path: 'examples/client.md',
          role: 'example_doc'
        }),
        expect.objectContaining({
          path: 'tests/client.test.ts',
          decision: 'verify_only'
        })
      ])
    );
    expect(preparedData.coveragePlan).toMatchObject({
      pathRolesToVerify: expect.arrayContaining(['canonical_api_doc', 'readme_doc', 'example_doc', 'source_file', 'test_file'])
    });

    const docPaths = preparedData.targets
      .filter((target: { role: string }) => ['canonical_api_doc', 'readme_doc', 'example_doc'].includes(target.role))
      .map((target: { path: string }) => target.path);
    expect(new Set(docPaths)).toEqual(new Set(['docs/api/client.md', 'README.md', 'examples/client.md']));
    expect(preparedData.queryPreview[0]).not.toHaveProperty('decision');
    expect(preparedData.context.primaryTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'docs/api/client.md', decision: 'must_edit' })
      ])
    );
  });

  it('does not recommend native edits when indexes are empty or unreadable', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-prepare-empty-'));

    const prepared = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'rename missing symbol',
      limit: 5,
      includeQueryPreview: true
    });

    expect(prepared.ok).toBe(true);
    expect(prepared.graphState).not.toBe('ready');
    expect((prepared.data as { targets: unknown[] }).targets).toEqual([]);
    expect(prepared.nextActions).not.toContain('edit with native agent tools');
    expect(prepared.nextActions).toEqual(expect.arrayContaining(['call nl_refresh before editing']));
  });
});
