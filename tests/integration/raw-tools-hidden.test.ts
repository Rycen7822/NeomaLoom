import { access, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  callRegisteredTool,
  createToolRegistry,
  NOEMALOOM_TOOL_NAMES
} from '../../packages/core/src/mcp/tool-registry.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-phase3-'));
}

describe('safe tool surface', () => {
  it('does not list raw or writer tools and rejects direct calls to them', async () => {
    const registryNames = createToolRegistry().map(tool => tool.name);

    expect(registryNames).toEqual([...NOEMALOOM_TOOL_NAMES]);
    for (const blockedName of ['codegraph_explore', 'search_rpg', 'write_codex_config', 'writer_apply']) {
      expect(registryNames).not.toContain(blockedName);
      await expect(callRegisteredTool(blockedName, {})).resolves.toMatchObject({
        ok: false,
        tool: blockedName,
        data: {
          status: 'tool_not_available'
        }
      });
    }
  });

  it('returns packaged workflow text without reading or creating project state', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_skill', {
      workflow: 'all',
      format: 'markdown',
      projectPath: projectRoot
    });

    expect(result).toMatchObject({
      ok: true,
      tool: 'nl_skill',
      projectRoot,
      graphState: 'empty',
      data: {
        workflow: 'all',
        format: 'markdown'
      }
    });
    expect(String(result.data.text)).toContain('repository_locator');
    expect(String(result.data.text)).toContain('compression_recovery');
    expect(String(result.data.text)).not.toContain('NoemaLoom_final_development_plan');
    await expect(access(path.join(projectRoot, '.noemaloom'))).rejects.toThrow();
  });

  it('creates default config and reports missing indexes from nl_status', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_status', {
      projectPath: projectRoot,
      includeRepositoryMap: false
    });

    expect(result).toMatchObject({
      ok: true,
      tool: 'nl_status',
      projectRoot,
      graphState: 'empty',
      data: {
        stateDir: '.noemaloom',
        fileInventory: { state: 'missing', files: 0 },
        spanIndex: { state: 'missing', spans: 0, edges: 0 },
        factIndex: { state: 'missing', symbols: 0, edges: 0 },
        documentIndex: { state: 'missing', blocks: 0, parseErrors: 0 },
        artifactIndex: { state: 'missing', entries: 0 },
        featureProjection: { state: 'missing', features: 0 },
        derivedMap: { state: 'missing', tokens: 0 },
        rawToolExposure: false,
        writerEnabled: false
      }
    });
    expect(JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'config.json'), 'utf8'))).toMatchObject({
      schemaRevision: 1,
      projectRoot
    });
    await expect(readFile(path.join(projectRoot, '.noemaloom', '.gitignore'), 'utf8')).resolves.toBe(
      '*\n!.gitignore\n'
    );
  });

  it('reports ready feature projection counts from planning output', async () => {
    const projectRoot = await createTempProject();
    const planningDir = path.join(projectRoot, '.noemaloom', 'planning');
    await mkdir(planningDir, { recursive: true });
    await writeFile(
      path.join(planningDir, 'features.json'),
      JSON.stringify([
        { id: 'feature.docs', title: 'Docs', source: 'rpgkit' },
        { id: 'feature.api', title: 'API', source: 'deterministic' }
      ])
    );

    const result = await callRegisteredTool('nl_status', {
      projectPath: projectRoot,
      includeRepositoryMap: false
    });

    expect(result).toMatchObject({
      ok: true,
      tool: 'nl_status',
      graphState: 'partial',
      data: {
        featureProjection: { state: 'ready', features: 2 }
      }
    });
  });
});
