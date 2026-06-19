import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture } from './helpers.js';

describe('e2e code API change impact', () => {
  it('groups SchedulerConfig impact and catches unsynced artifacts', async () => {
    const projectRoot = await copyFixture('scheduler-api-change');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });

    const plan = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'SchedulerConfig',
      targetType: 'auto',
      depth: 2
    });
    const planData = plan.data as {
      impact: {
        codeImpact: unknown[];
        docImpact: unknown[];
        configImpact: unknown[];
        testImpact: unknown[];
        exampleImpact: unknown[];
        featureImpact: unknown[];
      };
    };
    expect(plan.ok).toBe(true);
    const impactData = planData.impact;
    expect(impactData.codeImpact.length).toBeGreaterThan(0);
    expect(impactData.docImpact.length).toBeGreaterThan(0);
    expect(impactData.configImpact.length).toBeGreaterThan(0);
    expect(impactData.testImpact.length).toBeGreaterThan(0);
    expect(impactData.exampleImpact.length).toBeGreaterThan(0);
    expect(impactData.featureImpact.length).toBeGreaterThan(0);

    const prepared = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Change SchedulerConfig.timeout to SchedulerConfig.deadlineSeconds and update all affected repository artifacts',
      targetRoles: ['source_file', 'config_file', 'canonical_api_doc', 'test_file', 'example_doc', 'feature_plan'],
      limit: 40
    });
    const targets = (prepared.data as { targets: Array<{ path: string; decision: string; role: string }> }).targets;
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/scheduler.ts', role: 'source_file' }),
        expect.objectContaining({ path: 'config/scheduler.json', role: 'config_file' }),
        expect.objectContaining({ path: 'docs/api/scheduler.md', role: 'canonical_api_doc' }),
        expect.objectContaining({ path: 'tests/scheduler.test.ts', decision: 'verify_only' })
      ])
    );

    const coverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Change SchedulerConfig.timeout to SchedulerConfig.deadlineSeconds',
      target: 'SchedulerConfig',
      changedPaths: ['src/scheduler.ts', 'config/scheduler.json', 'docs/api/scheduler.md', 'examples/scheduler.ts'],
      oldTerms: ['timeout'],
      newTerms: ['deadlineSeconds']
    });
    expect(coverage.data).toMatchObject({
      status: 'fail',
      coverage: {
        remainingOldTermHits: expect.arrayContaining([
          expect.objectContaining({ path: 'config/scheduler.json', term: 'timeout' }),
          expect.objectContaining({ path: 'docs/api/scheduler.md', term: 'timeout' }),
          expect.objectContaining({ path: 'examples/scheduler.ts', term: 'timeout' })
        ])
      },
      impact: expect.objectContaining({
        requiredVerification: expect.arrayContaining(['tests/scheduler.test.ts'])
      })
    });
  });
});
