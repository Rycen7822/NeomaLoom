import { access, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

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
    expect(result.data.steps).toEqual([
      'FileInventory',
      'CodeFactIndexer',
      'DocumentSpanIndexer',
      'ArtifactSpanIndexer',
      'TestExampleSpanIndexer',
      'FeatureProjectionWorker',
      'ProjectionBuilder',
      'CrossReferenceLinker',
      'DerivedRepositoryMapBuilder',
      'RefreshRevisionWriter'
    ]);
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.sqlite'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'documents', 'anchor-index.json'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'))).resolves.toBeUndefined();

    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_spans')).toBeGreaterThan(0);
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_edges')).toBeGreaterThan(0);
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(1);
    const map = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'derived-map', 'repository-map.json'), 'utf8')) as {
      coreSourceModules: Array<{ label: string }>;
      highConfidenceLinks: unknown[];
    };
    expect(map.coreSourceModules.some(item => item.label === 'createClient')).toBe(true);
    expect(map.highConfidenceLinks.length).toBeGreaterThan(0);
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
    await expect(access(path.join(projectRoot, '.noemaloom', 'files', 'inventory.sqlite'))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'))).rejects.toThrow();
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
