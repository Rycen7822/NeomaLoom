import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createEmptyWorksetManifest,
  markAnchorUseful,
  markAnchorsInjected,
  readWorksetManifest,
  recordNavigationTargets,
  renderNavigationCards,
  retireAnchor,
  setNavigationEnabled,
  updateAnchorState,
  upsertNavigationTargets,
  worksetRevision,
  writeWorksetManifest
} from '../../packages/core/src/state/workset.js';
import { resolveNoemaLoomPaths } from '../../packages/core/src/state/paths.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-workset-'));
}

describe('NoemaLoom navigation workset state', () => {
  it('stores navigation anchors under the project-local workset directory with count-based counters', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);

    const manifest = await recordNavigationTargets({
      projectRoot,
      targets: [
        {
          spanId: 'span:client',
          path: 'src/client.ts',
          kind: 'code.function',
          role: 'source_file',
          label: 'createClient',
          startLine: 10,
          endLine: 18,
          score: 91,
          confidence: 0.91,
          reason: 'top exact target'
        }
      ],
      now: new Date('2026-06-21T00:00:00.000Z')
    });

    expect(manifest.counters.projectActivitySeq).toBe(1);
    expect(manifest.counters.navigationQuerySeq).toBe(1);
    expect(manifest.anchors).toHaveLength(1);
    expect(manifest.anchors[0]).toMatchObject({
      path: 'src/client.ts',
      label: 'createClient',
      state: 'active',
      source: 'nl_prepare_context',
      lastSeenSeq: 1
    });
    await expect(readFile(path.join(paths.worksetDir, 'anchors.json'), 'utf8')).resolves.toContain('src/client.ts');
    await expect(readFile(path.join(paths.worksetDir, 'events.jsonl'), 'utf8')).resolves.toContain('navigation_query');
  });

  it('records automatic navigation observations as dormant weak candidates when requested', async () => {
    const projectRoot = await createTempProject();

    const manifest = await recordNavigationTargets({
      projectRoot,
      targets: [
        {
          path: 'docs/plan.md',
          kind: 'doc.section',
          role: 'design_doc',
          label: 'Plan',
          startLine: 4,
          endLine: 9,
          score: 90,
          reason: 'query observation'
        }
      ],
      defaultState: 'dormant',
      reviveDormant: false,
      preserveCurated: true,
      now: new Date('2026-06-21T00:00:00.000Z')
    });

    expect(manifest.anchors).toHaveLength(1);
    expect(manifest.anchors[0]).toMatchObject({
      path: 'docs/plan.md',
      state: 'dormant',
      source: 'nl_prepare_context'
    });

    const enabled = setNavigationEnabled(manifest, true);
    expect(renderNavigationCards(enabled).cards).toEqual([]);
    expect(renderNavigationCards(enabled, { includeDormant: true }).cards[0]).toMatchObject({ path: 'docs/plan.md', state: 'dormant' });
  });

  it('uses stable path/range/kind identity and preserves curated provenance from automatic observations', () => {
    let manifest = createEmptyWorksetManifest('/tmp/project');
    manifest = upsertNavigationTargets({
      manifest,
      source: 'agent_curated',
      targets: [
        {
          path: 'src/client.ts',
          kind: 'code.function',
          role: 'source_file',
          label: 'createClient',
          startLine: 10,
          endLine: 18,
          score: 100,
          reason: 'manual owner seam'
        }
      ]
    });
    const curatedId = manifest.anchors[0].id;

    manifest = upsertNavigationTargets({
      manifest,
      source: 'nl_prepare_context',
      defaultState: 'dormant',
      preserveCurated: true,
      reviveDormant: false,
      targets: [
        {
          path: 'src/client.ts',
          kind: 'code.function',
          role: 'source_file',
          label: 'client factory from query',
          startLine: 10,
          endLine: 18,
          score: 95,
          reason: 'automatic query hit'
        }
      ]
    });

    expect(manifest.anchors.filter(anchor => anchor.path === 'src/client.ts')).toHaveLength(1);
    expect(manifest.anchors[0]).toMatchObject({
      id: curatedId,
      source: 'agent_curated',
      reason: 'manual owner seam',
      state: 'active'
    });
  });

  it('renders only enabled project anchors within the default navigation budget', () => {
    let manifest = createEmptyWorksetManifest('/tmp/project');
    manifest = upsertNavigationTargets({
      manifest,
      targets: [
        { spanId: 'one', path: 'src/one.ts', kind: 'code.function', role: 'source_file', label: 'one', startLine: 1, endLine: 3, score: 100, reason: 'first' },
        { spanId: 'two', path: 'docs/two.md', kind: 'doc.section', role: 'document', label: 'two', startLine: 4, endLine: 8, score: 90, reason: 'second' },
        { spanId: 'three', path: 'tests/three.test.ts', kind: 'code.function', role: 'test_file', label: 'three', startLine: 9, endLine: 12, score: 80, reason: 'third' },
        { spanId: 'four', path: 'config/four.json', kind: 'config.key', role: 'config', label: 'four', startLine: 1, endLine: 1, score: 70, reason: 'fourth' }
      ],
      now: new Date('2026-06-21T00:00:00.000Z')
    });

    expect(renderNavigationCards(manifest).cards).toEqual([]);

    manifest = setNavigationEnabled(manifest, true);
    const rendered = renderNavigationCards(manifest);

    expect(rendered.cards).toHaveLength(3);
    expect(rendered.charBudget).toBe(650);
    expect(rendered.text).toContain('NoemaLoom navigation anchors:');
    expect(rendered.text).toContain('src/one.ts:1-3');
    expect(rendered.text).not.toContain('config/four.json');
    expect(rendered.truncated).toBe(false);
  });

  it('demotes injected-but-unfollowed anchors by counts, not wall-clock time', () => {
    let manifest = setNavigationEnabled(createEmptyWorksetManifest('/tmp/project'), true);
    manifest = upsertNavigationTargets({
      manifest,
      targets: [{ spanId: 'one', path: 'src/one.ts', kind: 'code.function', role: 'source_file', label: 'one', startLine: 1, endLine: 3, score: 100 }]
    });
    const anchorId = manifest.anchors[0].id;

    manifest = markAnchorsInjected(manifest, [anchorId], new Date('2026-06-21T00:00:00.000Z'));
    expect(manifest.anchors[0]).toMatchObject({ state: 'active', ignoredInjectionCount: 1 });

    manifest = markAnchorsInjected(manifest, [anchorId], new Date('2036-06-21T00:00:00.000Z'));
    expect(manifest.anchors[0]).toMatchObject({ state: 'dormant', ignoredInjectionCount: 2 });
    expect(manifest.counters.anchorInjectionSeq).toBe(2);

    manifest = markAnchorUseful(manifest, { path: 'src/one.ts' });
    expect(manifest.anchors[0]).toMatchObject({ state: 'active', ignoredInjectionCount: 0, usefulHitCount: 1 });
    expect(manifest.counters.readWriteSeq).toBe(1);
  });

  it('keeps tombstoned anchors from being revived by future locate results', () => {
    let manifest = createEmptyWorksetManifest('/tmp/project');
    manifest = upsertNavigationTargets({
      manifest,
      targets: [{ spanId: 'dead', path: 'src/dead.ts', kind: 'code.function', role: 'source_file', label: 'dead', score: 90 }]
    });
    const anchorId = manifest.anchors[0].id;

    manifest = retireAnchor(manifest, anchorId, 'obsolete path');
    expect(manifest.anchors.find(anchor => anchor.id === anchorId)).toBeUndefined();
    expect(manifest.tombstones).toHaveLength(1);
    manifest = upsertNavigationTargets({
      manifest,
      targets: [{ spanId: 'dead', path: 'src/dead.ts', kind: 'code.function', role: 'source_file', label: 'dead', score: 100 }]
    });

    expect(manifest.anchors.find(anchor => anchor.id === anchorId)).toBeUndefined();
    expect(manifest.tombstones).toHaveLength(1);
    expect(manifest.tombstones[0]).toMatchObject({ id: anchorId, path: 'src/dead.ts', reason: 'obsolete path' });
  });

  it('supports controlled agent state updates without exposing a raw writer', async () => {
    const projectRoot = await createTempProject();
    let manifest = createEmptyWorksetManifest(projectRoot);
    manifest = upsertNavigationTargets({
      manifest,
      targets: [{ spanId: 'one', path: 'src/one.ts', kind: 'code.function', role: 'source_file', label: 'one', score: 100 }]
    });
    const before = worksetRevision(manifest);
    manifest = updateAnchorState(manifest, manifest.anchors[0].id, 'archived', 'agent confirmed cold');
    await writeWorksetManifest(projectRoot, manifest);

    const reloaded = await readWorksetManifest(projectRoot);
    expect(reloaded.anchors[0]).toMatchObject({ state: 'archived', source: 'agent_curated', reason: 'agent confirmed cold' });
    expect(worksetRevision(reloaded)).not.toBe(before);
  });
});
