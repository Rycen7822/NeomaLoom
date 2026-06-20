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
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-verify-edit-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'verify-edit-demo' }, null, 2));
  await writeProjectFile(projectRoot, '.noemaloom/planning/features.json', JSON.stringify([
    { id: 'client-timeout', title: 'createClient timeout feature', source: 'test-fixture' }
  ], null, 2));
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
      '`createClient` still documents `legacyTimeout` before the edit.',
      '',
      '[README](../../README.md)',
      ''
    ].join('\n')
  );
  await writeProjectFile(projectRoot, 'README.md', '# Verify Demo\n\nUse `createClient` with `legacyTimeout`.\n');
  await writeProjectFile(projectRoot, 'config/client.json', JSON.stringify({ createClient: { timeoutMs: 1000 } }, null, 2));
  await writeProjectFile(projectRoot, 'examples/client.ts', 'import { createClient } from "../src/client";\ncreateClient({ timeoutMs: 50 });\n');
  await writeProjectFile(projectRoot, 'tests/client.test.ts', 'import { createClient } from "../src/client";\ntest("timeout", () => createClient({ timeoutMs: 50 }));\n');
  return projectRoot;
}

describe('aggregated impact planning and coverage verification after edits', () => {
  it('traces cross-surface edges, groups impact, and verifies current changed file contents', async () => {
    const projectRoot = await createProject();
    const refresh = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    expect(refresh.ok).toBe(true);

    const plan = await callRegisteredTool('nl_plan_change', {
      projectPath: projectRoot,
      target: 'createClient',
      targetType: 'auto',
      depth: 2,
      relationTypes: ['all']
    });
    expect(plan.ok).toBe(true);
    expect(plan.tool).toBe('nl_plan_change');
    const planData = plan.data as {
      trace: {
        nodes: Array<{ path: string; kind: string; role: string }>;
        edges: Array<{ relation: string; confidence: number; source: string; evidence: unknown }>;
      };
      impact: {
        codeImpact: unknown[];
        docImpact: unknown[];
        configImpact: unknown[];
        testImpact: unknown[];
        exampleImpact: unknown[];
        featureImpact: unknown[];
        requiredVerification: string[];
      };
    };
    const traceData = planData.trace;
    expect(traceData.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/client.ts', role: 'source_file' }),
        expect.objectContaining({ path: 'docs/api/client.md', role: 'canonical_api_doc' }),
        expect.objectContaining({ path: 'tests/client.test.ts', role: 'test_file' })
      ])
    );
    expect(traceData.edges).toEqual([
      expect.objectContaining({
        relation: expect.any(String),
        confidence: expect.any(Number),
        source: expect.any(String),
        evidence: expect.anything()
      }),
      ...traceData.edges.slice(1).map(edge => expect.objectContaining(edge))
    ]);

    const impactData = planData.impact;
    expect(impactData.codeImpact.length).toBeGreaterThan(0);
    expect(impactData.docImpact.length).toBeGreaterThan(0);
    expect(impactData.configImpact.length).toBeGreaterThan(0);
    expect(impactData.testImpact.length).toBeGreaterThan(0);
    expect(impactData.exampleImpact.length).toBeGreaterThan(0);
    expect(impactData.featureImpact.length).toBeGreaterThan(0);
    expect(impactData.requiredVerification).toEqual(expect.arrayContaining(['tests/client.test.ts', 'docs/api/client.md']));

    const sourceCoverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Update createClient implementation',
      target: 'createClient',
      changedPaths: ['src/client.ts'],
      oldTerms: [],
      newTerms: []
    });
    expect(sourceCoverage.ok).toBe(false);
    expect(sourceCoverage.data).toMatchObject({
      status: 'needs_attention',
      coverage: {
        status: 'needs_attention',
        unverifiedLinkedTests: [expect.objectContaining({ path: 'tests/client.test.ts' })]
      },
      impact: expect.objectContaining({
        requiredVerification: expect.arrayContaining(['tests/client.test.ts'])
      })
    });

    await writeProjectFile(
      projectRoot,
      'docs/api/client.md',
      ['# Client API', '', '`createClient` still has `legacyTimeout` in current disk content.', ''].join('\n')
    );
    const failingCoverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });
    expect(failingCoverage.ok).toBe(false);
    expect(failingCoverage.data).toMatchObject({
      status: 'fail',
      coverage: {
        status: 'fail',
        remainingOldTermHits: [expect.objectContaining({ path: 'docs/api/client.md', term: 'legacyTimeout' })],
        unsyncedDocRoles: [expect.objectContaining({ path: 'README.md', role: 'readme_doc', term: 'legacyTimeout' })]
      }
    });

    await writeProjectFile(projectRoot, 'README.md', '# Verify Demo\n\nUse `createClient` with `timeoutMs`.\n');
    await writeProjectFile(
      projectRoot,
      'docs/api/client.md',
      ['# Client API', '', '`createClient` now documents `timeoutMs` in current disk content.', ''].join('\n')
    );
    const passingCoverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });
    expect(passingCoverage.ok).toBe(true);
    expect(passingCoverage.graphState).toBe('stale');
    expect(passingCoverage.nextActions).toEqual(expect.arrayContaining(['call nl_refresh with target="changed" and mode="safe"']));
    expect(passingCoverage.data).toMatchObject({
      status: 'pass',
      coverage: {
        status: 'pass',
        remainingOldTermHits: [],
        brokenLinks: [],
        codeDocMismatches: []
      }
    });

    const changedRefresh = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });
    expect(changedRefresh.ok).toBe(true);
    expect(changedRefresh.graphState).toBe('ready');

    const refreshedPassingCoverage = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });
    expect(refreshedPassingCoverage.ok).toBe(true);
    expect(refreshedPassingCoverage.graphState).toBe('ready');
    expect(refreshedPassingCoverage.nextActions).not.toEqual(expect.arrayContaining(['call nl_refresh with target="changed" and mode="safe"']));
    expect(refreshedPassingCoverage.data).toMatchObject({
      status: 'pass',
      coverage: { status: 'pass' }
    });
  });
});
