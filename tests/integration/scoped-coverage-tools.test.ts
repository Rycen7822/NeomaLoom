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
      readTopSpans: true
    });

    expect(result.ok).toBe(true);
    expect(result.nextActions).toEqual(expect.arrayContaining(['call nl_refresh with target="paths" for unindexedCandidates']));
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
    expect(result.ok).toBe(true);
    expect(coverage.status).toBe('fail');
    expect(coverage.unsyncedDocRoles).toEqual([
      expect.objectContaining({ path: 'docs/api/client.md', term: 'legacyTimeout' })
    ]);
  });
});
