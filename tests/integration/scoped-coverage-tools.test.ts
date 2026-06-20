import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

async function createScopedProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-scoped-tools-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'scoped-tools' }));
  await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
  await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nThe createClient docs are cold.\n');
  await writeProjectFile(projectRoot, 'tests/client.test.ts', 'test("createClient", () => {});\n');
  await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'paths', paths: ['src/client.ts'] });
  return projectRoot;
}

describe('scoped coverage tool semantics', () => {
  it('nl_prepare_context returns promotion nextActions for cold inventory candidates', async () => {
    const projectRoot = await createScopedProject();

    const result = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'update docs/api/client.md createClient documentation',
      budget: 777,
      readTopSpans: true
    });

    expect(result.ok).toBe(true);
    expect(result.nextActions).toEqual(expect.arrayContaining(['call nl_refresh with target="paths" for unindexedCandidates']));
    expect(result.tokenBudget.requested).toBe(777);
    expect(result.data).toMatchObject({ coverage: { inventory: 'full', deepSpans: 'scoped' } });
    expect((result.data as { unindexedCandidates: Array<{ path: string }> }).unindexedCandidates.map(candidate => candidate.path)).toContain('docs/api/client.md');
    expect((result.data as { readSpans: unknown[] }).readSpans).toEqual([]);
  });

  it('nl_plan_change marks scoped impact incomplete and names cold paths to promote', async () => {
    const projectRoot = await createScopedProject();

    const result = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'createClient',
      targetType: 'symbol',
      includeTrace: true
    });

    const impact = (result.data as { impact: { impactCoverage: string; missingUnindexedPaths: string[]; requiredActions: string[] } }).impact;
    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('partial');
    expect(impact.impactCoverage).toBe('scoped');
    expect(impact.missingUnindexedPaths).toEqual(expect.arrayContaining(['docs/api/client.md', 'tests/client.test.ts']));
    expect(impact.requiredActions).toEqual(expect.arrayContaining(['promote missingUnindexedPaths with nl_refresh target="paths" before final impact claims']));
  });

  it('nl_plan_change uses exact file target with Unicode paths without trace payload', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-plan-file-fast-path-'));
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'plan-file-fast-path' }));
    await writeProjectFile(
      projectRoot,
      'DeepScientist/quests/001/STAGE10_推进规划.md',
      '# STAGE10 推进规划\n\nUse CURRENT_STATUS and bash_exec evidence.\n'
    );
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'paths',
      paths: ['DeepScientist/quests/001/STAGE10_推进规划.md']
    });

    const result = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'DeepScientist/quests/001/STAGE10_推进规划.md',
      targetType: 'file',
      includeTrace: false
    });

    const data = result.data as { targets: Array<{ path: string }>; trace: unknown; impact: { docImpact: Array<{ path: string }> } };
    expect(result.ok).toBe(true);
    expect(data.targets[0]?.path).toBe('DeepScientist/quests/001/STAGE10_推进规划.md');
    expect(data.trace).toBeNull();
    expect(data.impact.docImpact.map(node => node.path)).toContain('DeepScientist/quests/001/STAGE10_推进规划.md');
  });

  it('nl_plan_change degrades to locate-only planning when only file inventory exists', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-plan-inventory-only-'));
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'plan-inventory-only' }));
    await writeProjectFile(projectRoot, 'problems.md', '# Problems\n\nFix the pressure-test ledger.\n');
    await writeProjectFile(projectRoot, 'docs/related.md', '# Related\n\nLedger notes.\n');
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'files',
      mode: 'safe'
    });

    const result = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'problems.md',
      targetType: 'file',
      includeTrace: false,
      limit: 12
    });

    const data = result.data as {
      targets: Array<{ path: string; indexed?: boolean; promotionAction?: { target: string; paths: string[] } }>;
      trace: unknown;
      impact: unknown;
      requiredActions: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('partial');
    expect(data.targets[0]?.path).toBe('problems.md');
    expect(data.targets[0]?.indexed).toBe(false);
    expect(data.targets[0]?.promotionAction).toMatchObject({ target: 'paths', paths: ['problems.md'] });
    expect(data.trace).toBeNull();
    expect(data.impact).toBeNull();
    expect(data.requiredActions).toEqual(expect.arrayContaining(['call nl_refresh with target="paths" for unindexedCandidates before final impact claims']));
    expect(result.nextActions).toEqual(expect.arrayContaining(['call nl_refresh with target="paths" for unindexedCandidates before final impact claims']));
    expect(result.warnings.map(warning => warning.code)).toContain('plan_change_impact_skipped');
  });

  it('nl_prepare_context caps coverage-plan linked paths during inventory fallback', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-prepare-inventory-cap-'));
    await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'prepare-inventory-cap' }));
    await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        writeProjectFile(
          projectRoot,
          `docs/topic-${String(index).padStart(3, '0')}.md`,
          `# Topic ${index}\n\nShared topic documentation.\n`
        )
      )
    );
    await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'files',
      mode: 'safe'
    });

    const result = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'update shared topic documentation',
      scope: 'topic',
      budget: 3200,
      limit: 20,
      readTopSpans: false
    });

    const data = result.data as {
      coveragePlan: {
        linkedDocsToVerify: string[];
        linkedDocsToVerifyOmitted: number;
        linkedTestsToVerify: string[];
        linkedTestsToVerifyOmitted: number;
      };
    };
    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('partial');
    expect(data.coveragePlan.linkedDocsToVerify.length).toBeLessThanOrEqual(50);
    expect(data.coveragePlan.linkedDocsToVerifyOmitted).toBeGreaterThan(0);
    expect(data.coveragePlan.linkedTestsToVerify.length).toBeLessThanOrEqual(50);
    expect(data.coveragePlan.linkedTestsToVerifyOmitted).toBe(0);
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
  });

  it('nl_verify_task scans cold docs from inventory and fails on remaining old terms', async () => {
    const projectRoot = await createScopedProject();
    await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "timeoutMs"; }\n');
    await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nStill says legacyTimeout.\n');

    const result = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs',
      changedPaths: ['src/client.ts'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs'],
      target: 'createClient',
      includeImpact: true
    });

    const coverage = (result.data as { coverage: { status: string; unsyncedDocRoles: Array<{ path: string; term: string }> } }).coverage;
    expect(result.ok).toBe(false);
    expect(coverage.status).toBe('fail');
    expect(coverage.unsyncedDocRoles).toEqual([
      expect.objectContaining({ path: 'docs/api/client.md', term: 'legacyTimeout' })
    ]);
  });
});
