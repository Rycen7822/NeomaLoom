import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-anchor-tools-'));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

describe('NoemaLoom compressed navigation anchor tool surface', () => {
  it('uses nl_status includeAnchors for read-only anchor inspection and nl_anchor_manage for promote/demote', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');

    const plainStatus = await callRegisteredTool('nl_status', { projectPath: projectRoot });
    expect(plainStatus.ok).toBe(true);
    expect((plainStatus.data as { anchorWorkset?: unknown }).anchorWorkset).toBeUndefined();

    const promoted = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: 'src/client.ts',
      label: 'createClient',
      kind: 'code.function',
      role: 'source_file',
      startLine: 10,
      endLine: 18,
      pinned: true,
      enableNavigation: true,
      reason: 'agent found owner seam'
    });
    expect(promoted.ok).toBe(true);
    expect(promoted.tool).toBe('nl_anchor_manage');
    const promotedData = promoted.data as {
      anchors?: unknown[];
      anchorPreviews: Array<{ id: string; path: string; pinned: boolean; state: string }>;
      enabled: boolean;
    };
    expect(promotedData.enabled).toBe(false);
    expect(promotedData.anchors).toBeUndefined();
    expect(promotedData.anchorPreviews[0]).toMatchObject({ path: 'src/client.ts', pinned: true, state: 'active' });
    const anchorId = promotedData.anchorPreviews[0].id;

    const anchorStatus = await callRegisteredTool('nl_status', { projectPath: projectRoot, includeAnchors: true });
    const anchorStatusData = anchorStatus.data as {
      anchorWorkset: {
        anchorPreviews: Array<{ path: string }>;
        navigation: { cards: Array<{ path: string }>; text: string };
        counters: { projectActivitySeq: number };
      };
    };
    expect(anchorStatus.ok).toBe(true);
    expect(anchorStatusData.anchorWorkset.anchorPreviews[0]).toMatchObject({ path: 'src/client.ts' });
    expect(anchorStatusData.anchorWorkset.navigation.cards[0]).toMatchObject({ path: 'src/client.ts' });
    expect(anchorStatusData.anchorWorkset.navigation.text).toBe('');
    expect(anchorStatusData.anchorWorkset.counters.projectActivitySeq).toBeGreaterThanOrEqual(1);

    const demoted = await callRegisteredTool('nl_anchor_manage', {
      action: 'demote',
      projectPath: projectRoot,
      anchorId,
      state: 'archived',
      reason: 'not useful this task'
    });
    expect(demoted.ok).toBe(true);
    expect(demoted.tool).toBe('nl_anchor_manage');
    expect((demoted.data as { anchorPreviews: Array<{ id: string; state: string; reason: string }> }).anchorPreviews.find(anchor => anchor.id === anchorId)).toMatchObject({ state: 'archived', reason: 'not useful this task' });
  });

  it('returns structured warnings for missing controlled curation targets through nl_anchor_manage', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_anchor_manage', {
      action: 'demote',
      projectPath: projectRoot,
      anchorId: 'missing-anchor',
      reason: 'test missing target'
    });

    expect(result.ok).toBe(false);
    expect(result.tool).toBe('nl_anchor_manage');
    expect(result.warnings[0]).toMatchObject({ code: 'anchor_not_found', severity: 'warning' });
    expect((result.data as { status: string; anchors: unknown[]; navigation?: unknown }).status).toBe('error');
    expect((result.data as { status: string; anchors: unknown[]; navigation?: unknown }).anchors).toEqual([]);
    expect((result.data as { status: string; anchors: unknown[]; navigation?: unknown }).navigation).toBeUndefined();
  });

  it('rejects unsafe or missing promote paths before they become active anchors', async () => {
    const projectRoot = await createTempProject();

    const missing = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: 'missing/client.ts',
      label: 'missing client',
      reason: 'typo should not be stored'
    });
    expect(missing.ok).toBe(false);
    expect(missing.warnings[0]).toMatchObject({ code: 'anchor_path_not_found', severity: 'warning' });
    expect((missing.data as { anchors: unknown[] }).anchors).toEqual([]);

    const stateDirPath = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: '.noemaloom/workset/anchors.json',
      label: 'state file',
      reason: 'state files are not source anchors'
    });
    expect(stateDirPath.ok).toBe(false);
    expect(stateDirPath.warnings[0].code).toBe('anchor_path_forbidden');
  });

  it('keeps duplicate promotes path-bounded without rewriting sibling anchor provenance', async () => {
    const projectRoot = await createTempProject();
    await writeProjectFile(projectRoot, 'src/client.ts', ['export function createClient() {', '  return "client";', '}', ''].join('\n'));

    const first = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: 'src/client.ts',
      label: 'factory one',
      kind: 'code.function',
      role: 'source_file',
      startLine: 1,
      endLine: 1,
      reason: 'first exact anchor'
    });
    expect(first.ok).toBe(true);

    const sibling = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: 'src/client.ts',
      label: 'factory sibling',
      kind: 'code.function',
      role: 'source_file',
      startLine: 2,
      endLine: 2,
      reason: 'second exact anchor'
    });
    expect(sibling.ok).toBe(true);

    const duplicate = await callRegisteredTool('nl_anchor_manage', {
      action: 'promote',
      projectPath: projectRoot,
      path: 'src/client.ts',
      label: 'factory one renamed',
      kind: 'code.function',
      role: 'source_file',
      startLine: 1,
      endLine: 1,
      reason: 'updated first anchor only'
    });
    expect(duplicate.ok).toBe(true);
    const anchors = (duplicate.data as { anchorPreviews: Array<{ path: string; startLine?: number; reason: string }> }).anchorPreviews.filter(anchor => anchor.path === 'src/client.ts');

    expect(anchors).toHaveLength(2);
    expect(anchors.find(anchor => anchor.startLine === 1)).toMatchObject({ reason: 'updated first anchor only' });
    expect(anchors.find(anchor => anchor.startLine === 2)).toMatchObject({ reason: 'second exact anchor' });
  });

  it('returns controlled validation warnings for unsupported public manage actions', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_anchor_manage', {
      action: 'repair',
      projectPath: projectRoot,
      anchorId: 'nav-one',
      reason: 'public repair should stay unavailable'
    });

    expect(result.ok).toBe(false);
    expect(result.warnings[0].code).toBe('invalid_action');
    expect(result.warnings[0].message).toContain('promote');
    expect(result.warnings[0].message).toContain('demote');
    expect(result.warnings[0].message).toContain('CLI');
    expect(JSON.stringify(result)).not.toContain('handler_error');
    expect(JSON.stringify(result)).not.toContain('ZodError');
  });
});
