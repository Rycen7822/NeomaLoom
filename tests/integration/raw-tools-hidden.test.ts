import { access, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  callInternalTool,
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

  it('does not expose workflow guidance as an MCP tool', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_skill', { projectPath: projectRoot });

    expect(result).toMatchObject({
      ok: false,
      tool: 'nl_skill',
      projectRoot,
      graphState: 'empty',
      data: {
        status: 'tool_not_available'
      }
    });
    await expect(access(path.join(projectRoot, '.noemaloom'))).rejects.toThrow();
  });

  it('hides low-level primitives from MCP while keeping internal test access', async () => {
    const projectRoot = await createTempProject();

    for (const hiddenPrimitive of [
      'nl_query',
      'nl_locate',
      'nl_context',
      'nl_read_span',
      'nl_trace',
      'nl_impact',
      'nl_verify_coverage'
    ]) {
      expect(createToolRegistry().map(tool => tool.name)).not.toContain(hiddenPrimitive);
      await expect(callRegisteredTool(hiddenPrimitive, { projectPath: projectRoot, goal: 'demo' })).resolves.toMatchObject({
        ok: false,
        tool: hiddenPrimitive,
        data: {
          status: 'tool_not_available'
        }
      });
    }

    await expect(callInternalTool('nl_status', { projectPath: projectRoot, includeRepositoryMap: false })).resolves.toMatchObject({
      ok: true,
      tool: 'nl_status'
    });
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
