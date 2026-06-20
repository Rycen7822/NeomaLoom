import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-anchor-tools-'));
}

describe('NoemaLoom controlled navigation anchor tools', () => {
  it('promotes anchors, enables navigation by checkpoint, demotes, repairs, and retires without raw writers', async () => {
    const projectRoot = await createTempProject();

    const promoted = await callRegisteredTool('nl_anchor_promote', {
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
    const promotedData = promoted.data as { anchors: Array<{ id: string; path: string; pinned: boolean; state: string }>; enabled: boolean };
    expect(promotedData.enabled).toBe(false);
    expect(promotedData.anchors[0]).toMatchObject({ path: 'src/client.ts', pinned: true, state: 'active' });
    const anchorId = promotedData.anchors[0].id;

    const checkpoint = await callRegisteredTool('nl_anchor_checkpoint', {
      projectPath: projectRoot,
      enabled: true,
      mode: 'inject',
      reason: 'enable project-local navigation injection'
    });
    expect(checkpoint.ok).toBe(true);
    expect((checkpoint.data as { enabled: boolean; mode: string }).enabled).toBe(true);
    expect((checkpoint.data as { mode: string }).mode).toBe('inject');

    const status = await callRegisteredTool('nl_anchor_status', { projectPath: projectRoot });
    const statusData = status.data as { navigation: { cards: Array<{ path: string }>; text: string }; counters: { projectActivitySeq: number } };
    expect(status.ok).toBe(true);
    expect(statusData.navigation.cards[0]).toMatchObject({ path: 'src/client.ts' });
    expect(statusData.navigation.text).toContain('NoemaLoom navigation anchors:');
    expect(statusData.counters.projectActivitySeq).toBeGreaterThanOrEqual(2);

    const demoted = await callRegisteredTool('nl_anchor_demote', {
      projectPath: projectRoot,
      anchorId,
      state: 'archived',
      reason: 'not useful this task'
    });
    expect(demoted.ok).toBe(true);
    expect((demoted.data as { anchors: Array<{ id: string; state: string; reason: string }> }).anchors.find(anchor => anchor.id === anchorId)).toMatchObject({ state: 'archived', reason: 'not useful this task' });

    const repaired = await callRegisteredTool('nl_anchor_repair', {
      projectPath: projectRoot,
      anchorId,
      newPath: 'src/client-new.ts',
      label: 'createClientV2',
      startLine: 20,
      endLine: 25,
      reason: 'relocated after refactor'
    });
    expect(repaired.ok).toBe(true);
    expect((repaired.data as { anchors: Array<{ id: string; path: string; label: string; state: string }> }).anchors.find(anchor => anchor.id === anchorId)).toMatchObject({
      path: 'src/client-new.ts',
      label: 'createClientV2',
      state: 'active'
    });

    const retired = await callRegisteredTool('nl_anchor_retire', {
      projectPath: projectRoot,
      anchorId,
      reason: 'obsolete API'
    });
    expect(retired.ok).toBe(true);
    const retiredData = retired.data as { anchors: Array<{ id: string; state: string; tombstoneReason?: string }>; tombstones: Array<{ id: string; reason: string }> };
    expect(retiredData.anchors.find(anchor => anchor.id === anchorId)).toMatchObject({ state: 'tombstoned', tombstoneReason: 'obsolete API' });
    expect(retiredData.tombstones).toEqual(expect.arrayContaining([expect.objectContaining({ id: anchorId, reason: 'obsolete API' })]));
  });

  it('returns structured warnings for missing controlled curation targets', async () => {
    const projectRoot = await createTempProject();

    const result = await callRegisteredTool('nl_anchor_demote', {
      projectPath: projectRoot,
      anchorId: 'missing-anchor',
      reason: 'test missing target'
    });

    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatchObject({ code: 'anchor_not_found', severity: 'warning' });
  });
});
