import { access, mkdir, readFile, unlink, writeFile, mkdtemp } from 'node:fs/promises';
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
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM refresh_revisions')).toBe(beforeRevisionCount + 1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE label = 'createAdminClient'")).toBe(1);
    expect(scalar(dbPath, "SELECT COUNT(*) AS value FROM repo_spans WHERE path = ?", 'docs/api/client.md')).toBe(0);
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
