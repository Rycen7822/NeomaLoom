import { access, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { callInternalTool, callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
    close: () => void;
  };
};

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
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

function values(dbPath: string, sql: string, ...params: unknown[]): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).all(...params) as Array<{ value: string }>).map(row => row.value);
  } finally {
    db.close();
  }
}

async function createPathProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-hotset-paths-'));
  await writeProjectFile(projectRoot, 'package.json', JSON.stringify({ name: 'hotset-paths' }));
  await writeProjectFile(projectRoot, 'src/client.ts', 'export function createClient() { return "client"; }\n');
  await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nSee `createClient`.\n');
  await writeProjectFile(projectRoot, 'docs/api/cold.md', '# Cold API\n\nCold only.\n');
  return projectRoot;
}

async function createLoopLikeProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-hotset-loop-'));
  await writeProjectFile(projectRoot, 'CODEX_STATE.md', [
    '# Codex State',
    '',
    'Active root: `DeepScientist/quests/001`.',
    'Read First:',
    '- `DeepScientist/quests/001/AGENTS.md`',
    '- `DeepScientist/quests/001/experiments/CURRENT_STATUS.md`',
    '- `DeepScientist/quests/001/experiments/stage10/scripts/run_seed.py`',
    ''
  ].join('\n'));
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/AGENTS.md', [
    '# Quest Agent Notes',
    '',
    'Read First:',
    '- `experiments/EXPERIMENT_EXECUTION_PLAN.md`',
    '- `experiments/正式实验命令.md`',
    ''
  ].join('\n'));
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/CURRENT_STATUS.md', '# Current Status\n\nContinue Stage10.\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/EXPERIMENT_EXECUTION_PLAN.md', '# Plan\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/正式实验命令.md', '# Commands\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/stage10/scripts/run_seed.py', 'def run_seed():\n    return "ok"\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/resources/code/github/vendor/src/external.py', 'def external():\n    return 1\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/stage10/runs/run-a/events.jsonl', '{"event":"cold"}\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/stage10/runs/run-a/metrics.csv', 'name,value\na,1\n');
  await writeProjectFile(projectRoot, 'DeepScientist/quests/001/experiments/stage10/runs/run-a/output.log', 'cold log\n');
  return projectRoot;
}

describe('scoped hotset refresh', () => {
  it('promotes explicit paths into scoped spans while keeping repo_files global', async () => {
    const projectRoot = await createPathProject();

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'paths',
      paths: ['docs/api/client.md'],
      promotionReason: 'unit-test-explicit-path'
    });

    expect(result.ok).toBe(true);
    expect(result.graphState).toBe('ready');
    expect(result.data).toMatchObject({
      status: 'refreshed',
      target: 'paths',
      coverage: { inventory: 'full', deepSpans: 'scoped', hotFiles: 1 }
    });
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(values(dbPath, 'SELECT path AS value FROM repo_files ORDER BY path')).toEqual([
      'docs/api/client.md',
      'docs/api/cold.md',
      'package.json',
      'src/client.ts'
    ]);
    expect(values(dbPath, 'SELECT DISTINCT path AS value FROM repo_spans ORDER BY path')).toContain('docs/api/client.md');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_spans WHERE path = ?', 'docs/api/cold.md')).toBe(0);
    await expect(access(path.join(projectRoot, '.noemaloom', 'hotset', 'hotset.json'))).resolves.toBeUndefined();
  });

  it('seeds Codex/DeepScientist anchors but keeps resources and run outputs cold by default', async () => {
    const projectRoot = await createLoopLikeProject();

    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'hotset'
    });

    expect(result.ok).toBe(true);
    expect((result.data as { coverage: { deepSpans: string } }).coverage.deepSpans).toBe('scoped');
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    const spanPaths = values(dbPath, 'SELECT DISTINCT path AS value FROM repo_spans ORDER BY path');
    expect(spanPaths).toEqual(expect.arrayContaining([
      'CODEX_STATE.md',
      'DeepScientist/quests/001/AGENTS.md',
      'DeepScientist/quests/001/experiments/CURRENT_STATUS.md',
      'DeepScientist/quests/001/experiments/EXPERIMENT_EXECUTION_PLAN.md',
      'DeepScientist/quests/001/experiments/正式实验命令.md',
      'DeepScientist/quests/001/experiments/stage10/scripts/run_seed.py'
    ]));
    expect(spanPaths.some(repoPath => repoPath.includes('/resources/code/github/'))).toBe(false);
    expect(spanPaths.some(repoPath => repoPath.includes('/runs/'))).toBe(false);

    const manifest = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'hotset', 'hotset.json'), 'utf8')) as {
      entries: Array<{ path: string; reason: string; editBoundary?: { editable: boolean; warning?: string } }>;
    };
    expect(manifest.entries.map(entry => entry.path)).toContain('CODEX_STATE.md');
    expect(manifest.entries.find(entry => entry.path.endsWith('EXPERIMENT_EXECUTION_PLAN.md'))?.editBoundary).toMatchObject({
      editable: false
    });

    const status = await callRegisteredTool('nl_status', { projectPath: projectRoot });
    expect(status.data).toMatchObject({
      coverage: { inventory: 'full', deepSpans: 'scoped' }
    });

    const query = await callInternalTool('nl_query', { projectPath: projectRoot, query: 'Current Status Stage10' });
    expect(query.data).toMatchObject({ coverage: { inventory: 'full', deepSpans: 'scoped' } });
    const results = (query.data as { results: Array<{ path: string; editBoundary?: { editable: boolean; warning?: string } }> }).results;
    expect(results.find(item => item.path.endsWith('CURRENT_STATUS.md'))?.editBoundary).toMatchObject({ editable: false });
  });

  it('allows explicit paths promotion for files that are default-cold patterns', async () => {
    const projectRoot = await createLoopLikeProject();

    const explicitPath = 'DeepScientist/quests/001/resources/code/github/vendor/src/external.py';
    const result = await callRegisteredTool('nl_refresh', {
      projectPath: projectRoot,
      target: 'paths',
      paths: [explicitPath],
      promotionReason: 'explicit-resource-audit'
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ coverage: { inventory: 'full', deepSpans: 'scoped' } });
    expect((result.data as { coverage: { hotFiles: number } }).coverage.hotFiles).toBeGreaterThan(0);
    const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
    expect(scalar(dbPath, 'SELECT COUNT(*) AS value FROM repo_spans WHERE path = ?', explicitPath)).toBeGreaterThan(0);
  });
});
