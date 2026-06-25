import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createEmptyWorksetManifest,
  markAnchorUseful,
  markAnchorsInjected,
  normalizeNavigationAnchorPath,
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

  it('serializes concurrent navigation target writes without losing anchors', async () => {
    const projectRoot = await createTempProject();

    await Promise.all([
      recordNavigationTargets({
        projectRoot,
        targets: [{ spanId: 'one', path: 'src/one.ts', kind: 'code.function', role: 'source_file', label: 'one', score: 100 }]
      }),
      recordNavigationTargets({
        projectRoot,
        targets: [{ spanId: 'two', path: 'src/two.ts', kind: 'code.function', role: 'source_file', label: 'two', score: 100 }]
      })
    ]);

    const reloaded = await readWorksetManifest(projectRoot);
    expect(reloaded.anchors.map(anchor => anchor.path).sort()).toEqual(['src/one.ts', 'src/two.ts']);
    expect(reloaded.counters.navigationQuerySeq).toBe(2);
  });

  it('does not steal an expired workset lock while the recorded process is still alive', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await mkdir(paths.worksetDir, { recursive: true });
    await writeFile(path.join(paths.worksetDir, 'anchors.json.lock'), `${process.pid} 0\n`);

    await expect(writeWorksetManifest(projectRoot, createEmptyWorksetManifest(projectRoot))).rejects.toThrow('workset_lock_busy');
  });

  it('rotates oversized workset event logs before appending a new navigation event', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await mkdir(paths.worksetDir, { recursive: true });
    await writeFile(path.join(paths.worksetDir, 'events.jsonl'), `${'x'.repeat(5 * 1024 * 1024 + 32)}\n`);

    await recordNavigationTargets({
      projectRoot,
      targets: [{ spanId: 'rotated', path: 'src/rotated.ts', kind: 'code.function', role: 'source_file', label: 'rotated', score: 100 }]
    });

    const worksetFiles = await readdir(paths.worksetDir);
    expect(worksetFiles.some(file => file.startsWith('events.') && file.endsWith('.jsonl'))).toBe(true);
    const currentEvents = await readFile(path.join(paths.worksetDir, 'events.jsonl'), 'utf8');
    expect(currentEvents.length).toBeLessThan(1024 * 1024);
    expect(currentEvents).toContain('navigation_query');
  });

  it('caps rotated workset event logs to the newest retained files', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await mkdir(paths.worksetDir, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      await writeFile(path.join(paths.worksetDir, `events.2026-06-25T00-00-0${index}-000Z.jsonl`), `old ${index}\n`);
    }
    await writeFile(path.join(paths.worksetDir, 'events.jsonl'), `${'x'.repeat(5 * 1024 * 1024 + 32)}\n`);

    await recordNavigationTargets({
      projectRoot,
      targets: [{ spanId: 'retained', path: 'src/retained.ts', kind: 'code.function', role: 'source_file', label: 'retained', score: 100 }]
    });

    const worksetFiles = await readdir(paths.worksetDir);
    const rotated = worksetFiles.filter(file => /^events\..+\.jsonl$/.test(file));
    expect(rotated).toHaveLength(5);
  });

  it('falls back to an empty workset manifest when anchors.json is corrupt', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);
    await mkdir(paths.worksetDir, { recursive: true });
    await writeFile(path.join(paths.worksetDir, 'anchors.json'), '{not json');

    const manifest = await readWorksetManifest(projectRoot);

    expect(manifest.anchors).toEqual([]);
    expect(manifest.counters.navigationQuerySeq).toBe(0);
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

  it('filters NoemaLoom state paths and escaping paths from automatic workset anchors', async () => {
    const projectRoot = await createTempProject();
    let manifest = createEmptyWorksetManifest(projectRoot);

    expect(normalizeNavigationAnchorPath('.noemaloom/workset/anchors.json')).toBeUndefined();
    expect(normalizeNavigationAnchorPath('../outside.md')).toBeUndefined();
    expect(normalizeNavigationAnchorPath('docs/../src/client.ts')).toBe('src/client.ts');

    manifest = upsertNavigationTargets({
      manifest,
      targets: [
        { path: '.noemaloom/planning/features.json', kind: 'feature.node', role: 'feature_plan', label: 'internal feature node', score: 99 },
        { path: '../outside.md', kind: 'doc.section', role: 'design_doc', label: 'outside', score: 98 },
        { path: 'docs/../src/client.ts', kind: 'code.function', role: 'source_file', label: 'createClient', score: 97 }
      ],
      defaultState: 'dormant',
      preserveCurated: true
    });

    expect(manifest.anchors).toHaveLength(1);
    expect(manifest.anchors[0]).toMatchObject({ path: 'src/client.ts', state: 'dormant' });

    await writeWorksetManifest(projectRoot, {
      ...manifest,
      anchors: [
        ...manifest.anchors,
        {
          ...manifest.anchors[0],
          id: 'nav-bad-state-path',
          path: '.noemaloom/planning/features.json',
          label: 'bad legacy state path'
        }
      ]
    });

    const reloaded = await readWorksetManifest(projectRoot);
    expect(reloaded.anchors.map(anchor => anchor.path)).toEqual(['src/client.ts']);
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

  it('caps tombstones when normalizing persisted worksets and keeps newest retire records', async () => {
    const projectRoot = await createTempProject();
    const base = createEmptyWorksetManifest(projectRoot);
    await writeWorksetManifest(projectRoot, {
      ...base,
      tombstones: Array.from({ length: 540 }, (_, index) => ({
        id: `old-${index}`,
        path: `src/old-${index}.ts`,
        reason: 'retired',
        tombstonedAt: `2026-06-21T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        tombstonedSeq: index
      }))
    });

    const reloaded = await readWorksetManifest(projectRoot);
    const ids = new Set(reloaded.tombstones.map(entry => entry.id));

    expect(reloaded.tombstones).toHaveLength(512);
    expect(ids.has('old-0')).toBe(false);
    expect(ids.has('old-28')).toBe(true);
    expect(ids.has('old-539')).toBe(true);
  });
});
