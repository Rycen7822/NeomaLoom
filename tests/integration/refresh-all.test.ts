import { access, chmod, mkdir, readFile, readdir, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { createDefaultConfig } from '../../packages/core/src/config/default-config.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    close: () => void;
  };
};

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-refresh-all-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'refresh-demo', scripts: { test: 'vitest' } }));
  await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
  await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nSee `createClient`.\n');
  await writeProjectFile(projectRoot, 'tests/client.test.ts', 'test("creates client", () => createClient());\n');
  return projectRoot;
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

function scalar(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get() as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

describe('nl_refresh target all', () => {
  it('writes files, spans, edges, derived map, and refresh revision', async () => {
    const projectRoot = await createProject();

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.tool).toBe('nl_refresh');
    expect(result.data).toMatchObject({
      status: 'refreshed',
      target: 'all',
      mode: 'safe'
    });
    expect(result.graphRevision).toBe(result.data.graphRevision);
    expect(result.data.steps).toEqual(expect.arrayContaining([
      'FileInventory',
      'ProjectionBuilder',
      'CrossReferenceLinker',
      'DerivedRepositoryMapBuilder',
      'RefreshRevisionWriter'
    ]));
    expect(result.data.durationMs).toEqual(expect.any(Number));
    expect(result.data.timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'FileInventory', durationMs: expect.any(Number) }),
      expect.objectContaining({ step: 'RefreshRevisionWriter', durationMs: expect.any(Number) })
    ]));
    expect(result.data.deepIndex).toMatchObject({ scope: 'full', deepFiles: expect.any(Number) });
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.json'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.sqlite'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'documents', 'anchor-index.json'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'))).resolves.toBeUndefined();

    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_spans')).toBeGreaterThan(0);
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_edges')).toBeGreaterThan(0);
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(1);
    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot });
    expect(status.graphRevision).toBe(result.graphRevision);
    const map = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'), 'utf8')) as {
      coreSourceModules: Array<{ label: string }>;
      highConfidenceLinks: unknown[];
    };
    expect(map.coreSourceModules.some(item => item.label === 'createClient')).toBe(true);
    expect(map.highConfidenceLinks.length).toBeGreaterThan(0);
  });

  it('respects disabled feature projection and does not project stale feature files', async () => {
    const projectRoot = await createProject();
    const config = createDefaultConfig(projectRoot);
    config.featureProjection.enabled = false;
    await mkdir(path.join(projectRoot, '.noemaloom', 'planning'), { recursive: true });
    await writeFile(path.join(projectRoot, '.noemaloom', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectRoot, '.noemaloom', 'planning', 'features.json'),
      `${JSON.stringify([{ id: 'feature:stale', title: 'Stale feature', source: 'test' }], null, 2)}\n`
    );

    const result = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'feature.node'")).toBe(0);
  });

  it('honors custom featureProjection stateDir and does not read stale default features', async () => {
    const projectRoot = await createProject();
    const config = createDefaultConfig(projectRoot);
    config.featureProjection.stateDir = '.noemaloom/custom-feature-state';
    await mkdir(path.join(projectRoot, '.noemaloom', 'planning'), { recursive: true });
    await writeFile(path.join(projectRoot, '.noemaloom', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      path.join(projectRoot, '.noemaloom', 'planning', 'features.json'),
      `${JSON.stringify([{ id: 'feature:stale-default', title: 'Stale default feature', source: 'test' }], null, 2)}\n`
    );

    const previousPythonPath = process.env.NOEMALOOM_PYTHONPATH;
    process.env.NOEMALOOM_PYTHONPATH = path.join(process.cwd(), 'python', 'nl_rpg_projection_worker');
    try {
      const result = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });

      expect(result.ok).toBe(true);
      const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
      expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'feature.node' AND path = '.noemaloom/custom-feature-state/planning/features.json'")).toBeGreaterThan(0);
      expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'feature.node' AND label = 'Stale default feature'")).toBe(0);
    } finally {
      if (previousPythonPath === undefined) delete process.env.NOEMALOOM_PYTHONPATH;
      else process.env.NOEMALOOM_PYTHONPATH = previousPythonPath;
    }
  });

  it('keeps old generated default workerCommand on python3 when PYTHON is unset', async () => {
    const projectRoot = await createProject();
    const config = createDefaultConfig(projectRoot);
    config.featureProjection.workerCommand = 'python -m nl_rpg_projection_worker.main';
    const binDir = path.join(projectRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    const fakePython = path.join(binDir, 'python');
    await writeFile(fakePython, '#!/usr/bin/env bash\necho should-not-use-python >&2\nexit 77\n');
    await chmod(fakePython, 0o755);
    await mkdir(path.join(projectRoot, '.noemaloom'), { recursive: true });
    await writeFile(path.join(projectRoot, '.noemaloom', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    const previousPython = process.env.PYTHON;
    const previousPath = process.env.PATH;
    const previousPythonPath = process.env.NOEMALOOM_PYTHONPATH;
    delete process.env.PYTHON;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    process.env.NOEMALOOM_PYTHONPATH = path.join(process.cwd(), 'python', 'nl_rpg_projection_worker');
    try {
      const result = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
      expect(result.ok).toBe(true);
      expect((result.warnings ?? []).join('\n')).not.toContain('should-not-use-python');
      const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
      expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'feature.node'")).toBeGreaterThan(0);
    } finally {
      if (previousPython === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previousPython;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPythonPath === undefined) delete process.env.NOEMALOOM_PYTHONPATH;
      else process.env.NOEMALOOM_PYTHONPATH = previousPythonPath;
    }
  });

  it('cleans stale codegraph temp DB artifacts before writing a new codegraph', async () => {
    const projectRoot = await createProject();
    const factDir = path.join(projectRoot, '.noemaloom', 'fact');
    await mkdir(factDir, { recursive: true });
    await writeFile(path.join(factDir, 'codegraph.99999999.1.dead.tmp.db'), 'stale');
    await writeFile(path.join(factDir, 'codegraph.99999999.1.dead.tmp.db-journal'), 'stale journal');

    const result = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });

    expect(result.ok).toBe(true);
    const factFiles = await readdir(factDir);
    expect(factFiles.filter(name => name.includes('.tmp.db'))).toEqual([]);
  });

  it('handles same-line duplicate callsites during full projection without repo span collisions', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(
      projectRoot,
      'src/duplicates.ts',
      'export function foo() { return 1; }\nexport function bar() { return foo() + foo(); }\n'
    );

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('ready');
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'code.callsite' AND label = 'foo'")).toBe(2);
  });

  it('keeps JSON config key and env-var mention spans distinct during full refresh', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(
      projectRoot,
      'scratch/spatialclaw/report.json',
      JSON.stringify({ direct_source_links: [{ chosen: 'HEAD' }, { chosen: 'HEAD' }] }, null, 2)
    );

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('ready');
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'config.entry' AND label = 'chosen'")).toBe(2);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE kind = 'config.entry' AND label = 'HEAD'")).toBe(2);
  });

  it('bounds indexed text for large minified JSON artifacts during full refresh', async () => {
    const projectRoot = await createProject();
    const vocabulary = Object.fromEntries(
      Array.from({ length: 1500 }, (_, index) => [`token_${index}`, `value-${index}-${'x'.repeat(120)}`])
    );
    const text = JSON.stringify(vocabulary);
    await writeProjectFile(projectRoot, 'resources/models/vocab.json', text);

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('ready');
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, 'SELECT MAX(length(indexed_text)) AS value FROM repo_spans')).toBeLessThanOrEqual(8192);
    expect(scalar(dbPath, 'SELECT MAX(length(label)) AS value FROM repo_spans')).toBeLessThanOrEqual(1024);
    expect(scalar(dbPath, 'SELECT MAX(length(summary)) AS value FROM repo_spans')).toBeLessThanOrEqual(2048);
    expect(scalar(dbPath, "SELECT SUM(length(indexed_text)) AS value FROM repo_spans WHERE path = 'resources/models/vocab.json'"))
      .toBeLessThan(text.length * 3);
  });

  it('refreshes only file inventory for target files without touching code/span DBs', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(
      projectRoot,
      'src/duplicates.ts',
      'export function foo() { return 1; }\nexport function bar() { return foo() + foo(); }\n'
    );

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'files',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('partial');
    expect(result.data).toMatchObject({
      status: 'refreshed',
      target: 'files',
      steps: ['FileInventory'],
      counts: { spans: 0, edges: 0 }
    });
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.json'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.sqlite'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).rejects.toThrow();
  });

  it('reports recovery actions for stale locks in nl_status', async () => {
    const projectRoot = await createProject();
    const locksDir = path.join(projectRoot, '.noemaloom', 'locks');
    await mkdir(locksDir, { recursive: true });
    await writeFile(path.join(locksDir, 'refresh.lock'), `${JSON.stringify({ pid: 99999999, createdAt: new Date(0).toISOString() })}\n`);

    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot });

    expect(status.ok).toBe(false);
    expect(status.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'refresh_lock_stale' })]));
    expect(status.nextActions).toEqual(expect.arrayContaining([expect.stringContaining('retry nl_refresh')]));
  });

  it('quarantines corrupt span DB evidence during target files refresh and caps old quarantined files', async () => {
    const projectRoot = await createProject();
    const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
    const quarantineDir = path.join(projectRoot, '.noemaloom', 'transient', 'quarantine');
    await mkdir(spansDir, { recursive: true });
    await mkdir(quarantineDir, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      await writeFile(path.join(quarantineDir, `170000000000${index}-999-spans__old-${index}.db`), `old ${index}\n`);
    }
    await writeFile(path.join(spansDir, 'spans.db'), '');

    const result = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'files', mode: 'safe' });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('corrupt sqlite evidence moved') })]));
    await expect(access(path.join(spansDir, 'spans.db'))).rejects.toThrow();
    const quarantined = await readdir(quarantineDir);
    expect(quarantined.some(name => name.includes('spans__spans.db'))).toBe(true);
    expect(quarantined).toHaveLength(5);
  });

  it('invalidates stale deep indexes when target files is run after a full refresh', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).resolves.toBeUndefined();

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'files',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ coverage: { inventory: 'full', deepSpans: 'none' } });
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'))).rejects.toThrow();
    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot });
    expect(status.data).toMatchObject({ coverage: { inventory: 'full', deepSpans: 'none' } });
  });

  it('can refresh the same graph twice without colliding revision ids', async () => {
    const projectRoot = await createProject();
    const first = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });
    const second = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'all',
      mode: 'safe'
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.graphRevision).not.toBe(first.graphRevision);
    expect(scalar(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'), 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(2);
  });
});
