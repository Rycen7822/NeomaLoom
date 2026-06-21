import { mkdir, writeFile, mkdtemp, readFile } from 'node:fs/promises';
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

async function createLoopLikeProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-loop-direct-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'loop-direct' }));
  await writeProjectFile(
    projectRoot,
    'CODEX_STATE.md',
    '# CODEX_STATE\n\nStage10 active anchors mention LoopCert selector tags and recovery CE only as a broad status index.\n'
  );
  await writeProjectFile(
    projectRoot,
    'DeepScientist/quests/001/STAGE10_推进方向.md',
    '# STAGE10 推进方向\n\nGeneral LoopCert direction notes mention selector tags without the score-side no-target constraint.\n'
  );
  await writeProjectFile(
    projectRoot,
    'DeepScientist/quests/001/STAGE10_推进规划.md',
    [
      '# STAGE10 推进规划',
      '',
      '## S10-08 LoopCert score',
      '',
      'Introductory notes are intentionally generic.',
      '',
      'The Stage10 LoopCert portfolio selector tags are `CFC-only`, `LoopCert-only`, `OrbitRepair-Proxy`, `Pareto-front`, `risk-calibrated no-target blend`, and `family-balanced blend`. This paragraph defines the score-side no-target constraint: use only ScoreBank, HiddenTrajectoryBank, CFC, and LoopCert component ledgers; do not read recovery CE.',
      '',
      'Further notes stay outside the requested paragraph.',
      ''
    ].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'DeepScientist/quests/001/experiments/stage10/scripts/stage10_loopcert_score.py',
    [
      'def helper_score(row):',
      '    return row.get("score", 0)',
      '',
      'def portfolio_rows(score_rows, generated_at, run_mode, topk):',
      '    return [row for row in score_rows[:topk]]',
      ''
    ].join('\n')
  );
  await writeProjectFile(
    projectRoot,
    'DeepScientist/quests/001/experiments/stage10/tests/test_stage10_loopcert_score.py',
    [
      'from experiments.stage10.scripts.stage10_loopcert_score import portfolio_rows',
      '',
      'def test_portfolio_rows():',
      '    assert portfolio_rows([{"score": 1}], "now", "formal", 1)',
      ''
    ].join('\n')
  );
  await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
  return projectRoot;
}

describe('scoped coverage tool semantics', () => {
  it('returns the exact scoped document paragraph instead of broad anchor docs', async () => {
    const projectRoot = await createLoopLikeProject();

    const result = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Find the document paragraph that defines Stage10 LoopCert portfolio selector tags and the score-side no-target constraint',
      scope: 'STAGE10_推进规划.md LoopCert score selector tags no-target recovery CE',
      targetRoles: ['document'],
      readTopSpans: true,
      maxReadSpans: 1,
      contextLines: 1,
      limit: 5
    });

    const data = result.data as {
      targets: Array<{ path: string; kind: string }>;
      readSpans: Array<{ path: string; spanStartLine: number; spanEndLine: number; content: string }>;
    };
    expect(result.ok).toBe(true);
    expect(data.targets[0]).toMatchObject({
      path: 'DeepScientist/quests/001/STAGE10_推进规划.md',
      kind: 'doc.paragraph'
    });
    expect(data.readSpans[0]).toMatchObject({
      path: 'DeepScientist/quests/001/STAGE10_推进规划.md',
      spanStartLine: 7,
      spanEndLine: 7
    });
    expect(data.readSpans[0].content).toContain('risk-calibrated no-target blend');
    expect(data.readSpans[0].content).toContain('do not read recovery CE');
  });

  it('resolves exact Python symbols as source functions with bounded plan-change output', async () => {
    const projectRoot = await createLoopLikeProject();

    const result = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'portfolio_rows',
      targetType: 'symbol',
      targetRoles: ['source'],
      goal: 'Find the Python function portfolio_rows that emits LoopCert portfolio selector rows',
      limit: 8
    });

    const data = result.data as { targets: Array<{ path: string; kind: string; role: string; label: string }> };
    expect(result.ok).toBe(true);
    expect(data.targets[0]).toMatchObject({
      path: 'DeepScientist/quests/001/experiments/stage10/scripts/stage10_loopcert_score.py',
      kind: 'code.function',
      role: 'source_file',
      label: 'portfolio_rows'
    });
    expect(result.warnings.filter(warning => warning.code === 'coverage_missing')).toEqual([]);
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
    expect(result.tokenBudget.used).toBeLessThanOrEqual(result.tokenBudget.requested);
  });

  it('nl_prepare_context supports compact output while debug keeps diagnostic target details', async () => {
    const projectRoot = await createLoopLikeProject();

    const compact = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Find the document paragraph that defines Stage10 LoopCert portfolio selector tags and the score-side no-target constraint',
      scope: 'STAGE10_推进规划.md LoopCert score selector tags no-target recovery CE',
      targetRoles: ['document'],
      readTopSpans: true,
      maxReadSpans: 1,
      contextLines: 1,
      limit: 5,
      responseProfile: 'compact'
    });
    const debug = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Find the document paragraph that defines Stage10 LoopCert portfolio selector tags and the score-side no-target constraint',
      scope: 'STAGE10_推进规划.md LoopCert score selector tags no-target recovery CE',
      targetRoles: ['document'],
      readTopSpans: true,
      maxReadSpans: 1,
      contextLines: 1,
      limit: 5,
      responseProfile: 'debug'
    });

    const compactData = compact.data as {
      targets: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
      readSpans: Array<{ content: string }>;
      coveragePlan: unknown;
    };
    expect(compact.ok).toBe(true);
    expect(compactData.targets[0]).toMatchObject({
      path: 'DeepScientist/quests/001/STAGE10_推进规划.md',
      startLine: 7,
      endLine: 7
    });
    expect(compactData.readSpans[0].content).toContain('risk-calibrated no-target blend');
    expect(compactData.coveragePlan).toBeTruthy();
    expect(JSON.stringify(compact.data)).not.toContain('scoreBreakdown');
    expect(JSON.stringify(compact.data)).not.toContain('linkedSpans');
    expect(JSON.stringify(compact.evidence)).toBe('[]');
    expect(JSON.stringify(debug.data)).toContain('scoreBreakdown');
    expect(JSON.stringify(debug.data)).toContain('linkedSpans');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(debug).length * 0.75);
  });

  it('nl_prepare_context navigation profile emits anchor cards and records project-local workset state', async () => {
    const projectRoot = await createLoopLikeProject();

    const result = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Find the document paragraph that defines Stage10 LoopCert portfolio selector tags and the score-side no-target constraint',
      scope: 'STAGE10_推进规划.md LoopCert score selector tags no-target recovery CE',
      targetRoles: ['document'],
      readTopSpans: true,
      maxReadSpans: 1,
      contextLines: 1,
      limit: 5,
      responseProfile: 'navigation'
    });

    const data = result.data as {
      navigation: { cards: Array<{ path: string; label: string }>; text: string; enabled: boolean; charBudget: number };
      targets: Array<{ path: string; startLine: number; endLine: number }>;
      context?: unknown;
    };
    expect(result.ok).toBe(true);
    expect(data.navigation.enabled).toBe(false);
    expect(data.navigation.charBudget).toBe(650);
    expect(data.navigation.cards).toEqual([]);
    expect(data.navigation.text).toBe('');
    expect(data.targets[0]).toMatchObject({ path: 'DeepScientist/quests/001/STAGE10_推进规划.md', startLine: 7, endLine: 7 });
    expect(data.context).toBeUndefined();
    expect(JSON.stringify(result.data)).not.toContain('scoreBreakdown');
    expect(JSON.stringify(result.evidence)).toBe('[]');

    const workset = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'workset', 'anchors.json'), 'utf8')) as {
      anchors: Array<{ path: string; state: string; source: string }>;
      counters: { navigationQuerySeq: number };
      options: { navigation: { enabled: boolean; mode: string } };
    };
    expect(workset.counters.navigationQuerySeq).toBeGreaterThan(0);
    expect(workset.options.navigation).toMatchObject({ enabled: false, mode: 'silent' });
    expect(workset.anchors.find(anchor => anchor.path === 'DeepScientist/quests/001/STAGE10_推进规划.md')).toMatchObject({
      state: 'dormant',
      source: 'nl_prepare_context'
    });

    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot, includeAnchors: true });
    expect((status.data as { anchorWorkset: { navigation: { cards: unknown[]; text: string } } }).anchorWorkset.navigation.cards).toEqual([]);
    expect((status.data as { anchorWorkset: { navigation: { text: string } } }).anchorWorkset.navigation.text).toBe('');
  });

  it('nl_plan_change compact output summarizes trace while debug keeps full trace edges', async () => {
    const projectRoot = await createLoopLikeProject();

    const compact = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'portfolio_rows',
      targetType: 'symbol',
      targetRoles: ['source'],
      goal: 'Find the Python function portfolio_rows that emits LoopCert portfolio selector rows',
      limit: 8,
      responseProfile: 'compact'
    });
    const debug = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'portfolio_rows',
      targetType: 'symbol',
      targetRoles: ['source'],
      goal: 'Find the Python function portfolio_rows that emits LoopCert portfolio selector rows',
      limit: 8,
      responseProfile: 'debug'
    });

    const compactData = compact.data as {
      targets: Array<{ path: string; kind: string; label: string }>;
      trace: unknown;
      traceSummary: { nodeCount: number; edgeCount: number };
      impact: { requiredActions?: string[] };
      requiredVerification: string[];
    };
    expect(compact.ok).toBe(true);
    expect(compactData.targets[0]).toMatchObject({
      path: 'DeepScientist/quests/001/experiments/stage10/scripts/stage10_loopcert_score.py',
      kind: 'code.function',
      label: 'portfolio_rows'
    });
    expect(compactData.trace).toBeNull();
    expect(compactData.traceSummary).toMatchObject({ nodeCount: expect.any(Number), edgeCount: expect.any(Number) });
    expect(compactData.requiredVerification).toBeTruthy();
    expect(JSON.stringify(compact.data)).not.toContain('scoreBreakdown');
    expect(JSON.stringify(compact.evidence)).toBe('[]');
    expect(JSON.stringify(debug.data)).toContain('scoreBreakdown');
    expect(JSON.stringify(debug.data)).toContain('edges');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(debug).length * 0.75);
  });

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
