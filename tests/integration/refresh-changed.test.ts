import { access, mkdir, readFile, unlink, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
    close: () => void;
  };
};

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-refresh-changed-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'changed-demo' }));
  await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
  await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n');
  return projectRoot;
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

async function initGitProject(projectRoot: string): Promise<void> {
  await execFileAsync('git', ['-C', projectRoot, 'init'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  await execFileAsync('git', ['-C', projectRoot, 'config', 'user.email', 'noemaloom@example.invalid']);
  await execFileAsync('git', ['-C', projectRoot, 'config', 'user.name', 'NoemaLoom Test']);
  await execFileAsync('git', ['-C', projectRoot, 'add', '.']);
  await execFileAsync('git', ['-C', projectRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial']);
}

function scalar(dbPath: string, sql: string, ...params: unknown[]): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get(...params) as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

describe('nl_refresh target changed', () => {
  it('detects changed and deleted files, rewrites touching graph state, and writes a new revision', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    const beforeRevisionCount = scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions');

    await writeProjectFile(
      projectRoot,
      'src/client.ts',
      'export function createClient() { return "client"; }\nexport function createAdminClient() { return createClient(); }\n'
    );
    await unlink(path.join(projectRoot, 'docs/api/client.md'));

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    const data = result.data as { timings: Array<{ step: string }> };
    expect(result.data).toMatchObject({
      status: 'refreshed',
      target: 'changed',
      changed: {
        changedPaths: ['src/client.ts'],
        deletedPaths: ['docs/api/client.md']
      },
      deepIndex: {
        scope: 'full',
        changedTargetStrategy: 'full_deep_reindex'
      }
    });
    const timingSteps = data.timings.map(timing => timing.step);
    expect(timingSteps).not.toContain('FeatureProjectionWorker');
    expect(timingSteps).toContain('RefreshRevisionWriter');
    expect((result.data as { steps: string[] }).steps).not.toContain('FeatureProjectionWorker');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(beforeRevisionCount + 1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE label = 'createAdminClient'")).toBe(1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE path = ?", 'docs/api/client.md')).toBe(0);
  });

  it('uses git snapshot inventory and delta writer for non-empty changed refreshes with full prior coverage', async () => {
    const projectRoot = await createProject();
    await writeProjectFile(projectRoot, 'src/server.ts', 'export function createServer() { return "server"; }\n');
    await initGitProject(projectRoot);
    await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    const codegraphPath = path.join(projectRoot, '.noemaloom', 'fact', 'codegraph.db');
    const beforeRevisionCount = scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions');

    await writeProjectFile(
      projectRoot,
      'src/client.ts',
      'export function createClient() { return "client"; }\nexport function createAdminClient() { return createClient(); }\n'
    );
    await unlink(path.join(projectRoot, 'docs/api/client.md'));

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 'refreshed',
      target: 'changed',
      changed: {
        changedPaths: ['src/client.ts'],
        deletedPaths: ['docs/api/client.md']
      },
      inventoryStrategy: { source: 'snapshot_plus_git_changed' },
      deepIndex: {
        scope: 'full',
        deepFiles: 1,
        changedTargetStrategy: 'git_delta_reindex'
      }
    });
    const steps = (result.data as { steps: string[] }).steps;
    expect(steps).toContain('ChangedDeltaRevisionWriter');
    expect(steps).not.toContain('FeatureProjectionWorker');
    const timingSteps = (result.data as { timings: Array<{ step: string }> }).timings.map(timing => timing.step);
    expect(timingSteps).toContain('ChangedDeltaRevisionWriter');
    expect(timingSteps).not.toContain('FeatureProjectionWorker');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(beforeRevisionCount + 1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_files WHERE path = ?", 'docs/api/client.md')).toBe(0);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE path = ?", 'docs/api/client.md')).toBe(0);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans_fts WHERE path = ?", 'docs/api/client.md')).toBe(0);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE label = 'createAdminClient'")).toBe(1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE label = 'createServer'")).toBe(1);
    expect(scalar(codegraphPath, "SELECT COUNT(*) AS value FROM facts_nodes WHERE label = 'createAdminClient'")).toBe(1);
    expect(scalar(codegraphPath, "SELECT COUNT(*) AS value FROM facts_nodes WHERE label = 'createServer'")).toBe(1);
  });

  it('returns unchanged without deep reindex when safe changed refresh has no file delta', async () => {
    const projectRoot = await createProject();
    const initial = await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    const beforeRevisionCount = scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions');

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });

    expect(result.ok).toBe(true);
    expect(result.graphRevision).toBe(initial.graphRevision);
    const data = result.data as {
      steps: string[];
      timings: Array<{ step: string }>;
    };
    expect(result.data).toMatchObject({
      status: 'unchanged',
      target: 'changed',
      mode: 'safe',
      graphRevision: initial.graphRevision,
      graphState: 'ready',
      changed: { changedPaths: [], deletedPaths: [] },
      deepIndex: {
        scope: 'full',
        changedTargetStrategy: 'no_change_fast_path'
      },
      counts: { files: expect.any(Number), spans: expect.any(Number), edges: expect.any(Number) },
      inventoryStrategy: {
        source: 'walk',
        candidateFiles: expect.any(Number),
        includedFiles: expect.any(Number),
        prunedDirs: expect.any(Number),
        maxWalkDepth: 64
      }
    });
    expect(data.steps).toEqual(['FileInventory', 'ChangedNoopFastPath']);
    const timingSteps = data.timings.map(timing => timing.step);
    expect(timingSteps).toEqual(['FileInventory', 'LatestRefreshSummaryReader']);
    expect(timingSteps).not.toEqual(expect.arrayContaining([
      'CodeFactIndexer',
      'FeatureProjectionWorker',
      'RefreshRevisionWriter'
    ]));
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(beforeRevisionCount);
  });

  it('returns refresh_in_progress when the refresh lock already exists', async () => {
    const projectRoot = await createProject();
    const lockPath = path.join(projectRoot, '.noemaloom', 'locks', 'refresh.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ status: 'refresh_in_progress' });
  });

  it('creates a transient backup in force mode before replacement', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'force'
    });

    expect(result.ok).toBe(true);
    await expect(access(path.join(projectRoot, '.noemaloom', 'transient', 'refresh-backup.json'))).resolves.toBeUndefined();
    const backup = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'transient', 'refresh-backup.json'), 'utf8')) as {
      previousRevision?: string;
    };
    expect(backup.previousRevision).toEqual(expect.stringMatching(/^rev-/));
  });

  it('keeps the existing revision when safe refresh fails config validation', async () => {
    const projectRoot = await createProject();
    await callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' });
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    const beforeRevisionCount = scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions');
    await writeFile(path.join(projectRoot, '.noemaloom', 'config.json'), JSON.stringify({ schemaRevision: 1 }));

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'changed',
      mode: 'safe'
    });

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ status: 'config_invalid' });
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(beforeRevisionCount);
  });
});
