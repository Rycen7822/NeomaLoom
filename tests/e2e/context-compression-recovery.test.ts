import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture } from './helpers.js';

describe('e2e context compression recovery', () => {
  it('recovers from status, repository map, context, and locate without broad file reads', async () => {
    const projectRoot = await copyFixture('context-recovery');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });
    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot, includeRepositoryMap: true });
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ derivedMap: { state: 'ready' } });

    const context = await callRegisteredTool('nl_context', {
      projectPath: projectRoot,
      goal: 'Update createClient API docs',
      budget: 1024,
      includeSnippets: false
    });
    expect(context.ok).toBe(true);
    const contextData = context.data as { repositoryMap: { directoryRoles: unknown[]; canonicalDocs: unknown[]; coreSourceModules: unknown[]; highConfidenceLinks: unknown[] } };
    expect(contextData.repositoryMap.directoryRoles.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.canonicalDocs.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.coreSourceModules.length).toBeGreaterThan(0);
    expect(contextData.repositoryMap.highConfidenceLinks.length).toBeGreaterThan(0);
    expect(JSON.stringify(context.data)).not.toMatch(/long-term memory|experiment conclusion|chat summary/i);

    const locate = await callRegisteredTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Update createClient API docs',
      targetRoles: ['canonical_api_doc', 'source_file', 'readme_doc'],
      limit: 10
    });
    expect((locate.data as { targets: unknown[] }).targets.length).toBeGreaterThan(0);
  });
});
