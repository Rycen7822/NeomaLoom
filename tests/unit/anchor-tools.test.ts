import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-anchor-tools-'));
}

describe('NoemaLoom compressed navigation anchor tool surface', () => {
  it('uses nl_status includeAnchors for read-only anchor inspection and nl_anchor_manage for promote/demote', async () => {
    const projectRoot = await createTempProject();

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
      reason: 'agent found owner seam'
    });
    expect(promoted.ok).toBe(true);
    expect(promoted.tool).toBe('nl_anchor_manage');
    const promotedData = promoted.data as { anchors: Array<{ id: string; path: string; pinned: boolean; state: string }>; enabled: boolean };
    expect(promotedData.enabled).toBe(false);
    expect(promotedData.anchors[0]).toMatchObject({ path: 'src/client.ts', pinned: true, state: 'active' });
    const anchorId = promotedData.anchors[0].id;

    const anchorStatus = await callRegisteredTool('nl_status', { projectPath: projectRoot, includeAnchors: true });
    const anchorStatusData = anchorStatus.data as { anchorWorkset: { navigation: { cards: Array<{ path: string }>; text: string }; counters: { projectActivitySeq: number } } };
    expect(anchorStatus.ok).toBe(true);
    expect(anchorStatusData.anchorWorkset.navigation.cards[0]).toMatchObject({ path: 'src/client.ts' });
    expect(anchorStatusData.anchorWorkset.navigation.text).toContain('NoemaLoom navigation anchors:');
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
    expect((demoted.data as { anchors: Array<{ id: string; state: string; reason: string }> }).anchors.find(anchor => anchor.id === anchorId)).toMatchObject({ state: 'archived', reason: 'not useful this task' });
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
  });
});
