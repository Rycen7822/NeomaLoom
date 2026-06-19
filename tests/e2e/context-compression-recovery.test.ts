import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture } from './helpers.js';

describe('e2e context compression recovery', () => {
  it('recovers from status, repository map, context, and locate without broad file reads', async () => {
    const projectRoot = await copyFixture('context-recovery');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });
    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot, includeRepositoryMap: true });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ derivedMap: { state: 'ready' } });

    const prepared = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Update createClient API docs',
      budget: 1024,
      includeSnippets: false
    });
    expect(prepared.ok).toBe(true);
    const preparedData = prepared.data as {
      context: { repositoryMap: { directoryRoles: unknown[]; canonicalDocs: unknown[]; coreSourceModules: unknown[]; highConfidenceLinks: unknown[] } };
      targets: unknown[];
    };
    const contextData = preparedData.context;
    expect(contextData.repositoryMap.directoryRoles.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.canonicalDocs.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.coreSourceModules.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.highConfidenceLinks.length).toBeGreaterThan(0);
    expect(JSON.stringify(prepared.data)).not.toMatch(/long-term memory|experiment conclusion|chat summary/i);
    expect(preparedData.targets.length).toBeGreaterThan(0);
  });
});
