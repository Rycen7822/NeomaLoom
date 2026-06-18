import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture } from './helpers.js';

describe('e2e code API change impact', () => {
  it('groups SchedulerConfig impact and catches unsynced artifacts', async () => {
    const projectRoot = await copyFixture('scheduler-api-change');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });

    const impact = await callRegisteredTool('nl_impact', {
      projectPath: projectRoot,
      target: 'SchedulerConfig',
      targetType: 'auto',
      depth: 2
    });
    const impactData = impact.data as {
      codeImpact: unknown[];
      docImpact: unknown[];
      configImpact: unknown[];
      testImpact: unknown[];
      exampleImpact: unknown[];
      featureImpact: unknown[];
    };
    expect(impact.ok).toBe(true);
    expect(impactData.codeImpact.length).toBeGreaterThan(0);
    expect(impactData.docImpact.length).toBeGreaterThan(0);
    expect(impactData.configImpact.length).toBeGreaterThan(0);
    expect(impactData.testImpact.length).toBeGreaterThan(0);
    expect(impactData.exampleImpact.length).toBeGreaterThan(0);
    expect(impactData.featureImpact.length).toBeGreaterThan(0);

    const locate = await callRegisteredTool('nl_locate', {
      projectPath: projectRoot,
      goal: 'Change SchedulerConfig.timeout to SchedulerConfig.deadlineSeconds and update all affected repository artifacts',
      targetRoles: ['source_file', 'config_file', 'canonical_api_doc', 'test_file', 'example_doc', 'feature_plan'],
      limit: 40
    });
    const targets = (locate.data as { targets: Array<{ path: string; decision: string; role: string }> }).targets;
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/scheduler.ts', role: 'source_file' }),
        expect.objectContaining({ path: 'config/scheduler.json', role: 'config_file' }),
        expect.objectContaining({ path: 'docs/api/scheduler.md', role: 'canonical_api_doc' }),
        expect.objectContaining({ path: 'tests/scheduler.test.ts', decision: 'verify_only' })
      ])
    );

    const coverage = await callRegisteredTool('nl_verify_coverage', {
      projectPath: projectRoot,
      goal: 'Change SchedulerConfig.timeout to SchedulerConfig.deadlineSeconds',
      changedPaths: ['src/scheduler.ts', 'config/scheduler.json', 'docs/api/scheduler.md', 'examples/scheduler.ts'],
      oldTerms: ['timeout'],
      newTerms: ['deadlineSeconds']
    });
    expect(coverage.data).toMatchObject({
      status: 'fail',
      remainingOldTermHits: expect.arrayContaining([
        expect.objectContaining({ path: 'config/scheduler.json', term: 'timeout' }),
        expect.objectContaining({ path: 'docs/api/scheduler.md', term: 'timeout' }),
        expect.objectContaining({ path: 'examples/scheduler.ts', term: 'timeout' })
      ])
    });
  });
});
