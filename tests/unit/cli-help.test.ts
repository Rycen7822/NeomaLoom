import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getHelpText } from '../../packages/core/src/cli/help.js';
import { runCli } from '../../packages/core/src/cli/main.js';

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } }
    },
    output: () => ({ stdout, stderr })
  };
}

async function runJson(argv: string[]) {
  const captured = captureIo();
  const code = await runCli(argv, captured.io);
  const { stdout, stderr } = captured.output();
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) as Record<string, unknown> : undefined };
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

describe('noemaloom CLI help', () => {
  it('lists supported serve and anchor maintenance commands without installer or raw writer commands', () => {
    const help = getHelpText();

    expect(help).toContain('Usage: noemaloom serve --mcp');
    expect(help).toContain('Usage: noemaloom anchor <status|promote|demote|repair|retire|checkpoint>');
    expect(help).toContain('NoemaLoom locates and verifies repository spans.');
    expect(help).toContain('--json-file');

    for (const forbiddenCommand of [
      'install',
      'uninstall',
      'init',
      'agent',
      'hook',
      'writer',
      'codegen',
      'write-codex-config',
      'write-hermes-config'
    ]) {
      expect(help).not.toContain(forbiddenCommand);
    }
  });

  it('runs repair, retire, and checkpoint as CLI-only controlled anchor operations', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-anchor-cli-'));
    await writeProjectFile(projectRoot, 'src/client.ts', 'export const client = 1;\n');
    await writeProjectFile(projectRoot, 'src/client-new.ts', 'export const client = 2;\n');

    const promoted = await runJson([
      'anchor',
      'promote',
      '--project',
      projectRoot,
      '--json',
      JSON.stringify({ path: 'src/client.ts', label: 'client', reason: 'cli setup' })
    ]);
    expect(promoted.code).toBe(0);
    const anchors = ((promoted.json?.data as { anchors: Array<{ id: string }> }).anchors);
    const anchorId = anchors[0].id;

    const repaired = await runJson([
      'anchor',
      'repair',
      '--project',
      projectRoot,
      '--json',
      JSON.stringify({ anchorId, newPath: 'src/client-new.ts', label: 'client v2', reason: 'cli repair' })
    ]);
    expect(repaired.code).toBe(0);
    expect((repaired.json?.data as { anchors: Array<{ id: string; path: string; label: string }> }).anchors.find(anchor => anchor.id === anchorId)).toMatchObject({
      path: 'src/client-new.ts',
      label: 'client v2'
    });

    const checkpoint = await runJson([
      'anchor',
      'checkpoint',
      '--project',
      projectRoot,
      '--json',
      JSON.stringify({ enabled: true, mode: 'inject', reason: 'cli checkpoint' })
    ]);
    expect(checkpoint.code).toBe(0);
    expect((checkpoint.json?.data as { enabled: boolean; mode: string }).enabled).toBe(true);
    expect((checkpoint.json?.data as { mode: string }).mode).toBe('inject');

    const beforeNoopSeq = ((checkpoint.json?.data as { counters: { projectActivitySeq: number } }).counters).projectActivitySeq;
    const noopCheckpoint = await runJson(['anchor', 'checkpoint', '--project', projectRoot, '--json', JSON.stringify({})]);
    expect(noopCheckpoint.code).toBe(0);
    expect((noopCheckpoint.json?.data as { status: string }).status).toBe('noop');
    expect(((noopCheckpoint.json?.data as { counters: { projectActivitySeq: number } }).counters).projectActivitySeq).toBe(beforeNoopSeq);
    expect((noopCheckpoint.json?.data as { stateEffectsDetailed: unknown[] }).stateEffectsDetailed).toEqual([]);

    const retired = await runJson([
      'anchor',
      'retire',
      '--project',
      projectRoot,
      '--json',
      JSON.stringify({ anchorId, reason: 'cli retire' })
    ]);
    expect(retired.code).toBe(0);
    expect((retired.json?.data as { tombstones: Array<{ id: string; reason: string }> }).tombstones).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: anchorId, reason: 'cli retire' })])
    );

    const status = await runJson(['anchor', 'status', '--project', projectRoot, '--json', JSON.stringify({ includeRetired: true })]);
    expect(status.code).toBe(0);
    expect((status.json?.data as { anchorWorkset: { tombstones: Array<{ id: string }> } }).anchorWorkset.tombstones).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: anchorId })])
    );
    const retiredAnchors = (retired.json?.data as { anchors: Array<{ id: string }>; counts: { anchors: number; tombstones: number } }).anchors;
    const statusWorkset = (status.json?.data as { anchorWorkset: { anchors: Array<{ id: string }>; counts: { anchors: number; tombstones: number } } }).anchorWorkset;
    expect(retiredAnchors.find(anchor => anchor.id === anchorId)).toBeUndefined();
    expect((retired.json?.data as { counts: { anchors: number; tombstones: number } }).counts).toMatchObject(statusWorkset.counts);
    expect(statusWorkset.anchors.find(anchor => anchor.id === anchorId)).toBeUndefined();
  });

  it('returns controlled CLI validation JSON instead of raw Zod output for bad anchor payloads', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-anchor-cli-bad-'));

    const result = await runJson(['anchor', 'promote', '--project', projectRoot, '--json', '{}']);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('ZodError');
    expect(result.stderr).toBe('');
    expect(result.json?.ok).toBe(false);
    expect((result.json?.data as { status: string }).status).toBe('validation_error');
    expect((result.json?.warnings as Array<{ code: string }>)[0].code).toBe('validation_error');
  });

  it('returns JSON envelopes for CLI parse errors before handler dispatch', async () => {
    const unknownAction = await runJson(['anchor', 'unknown-action']);
    expect(unknownAction.code).toBe(1);
    expect(unknownAction.json?.ok).toBe(false);
    expect(unknownAction.json?.tool).toBe('noemaloom_anchor_cli');
    expect((unknownAction.json?.warnings as Array<{ code: string; message: string }>)[0]).toMatchObject({
      code: 'validation_error',
      message: 'Unknown anchor action: unknown-action'
    });
    expect(unknownAction.stderr).toBe('');

    const missingProject = await runJson(['anchor', 'status', '--project', '--json', '{}']);
    expect(missingProject.code).toBe(1);
    expect(missingProject.json?.ok).toBe(false);
    expect((missingProject.json?.warnings as Array<{ message: string }>)[0].message).toContain('--project requires a value');
    expect(missingProject.stderr).toBe('');

    const badJson = await runJson(['anchor', 'status', '--json', '{']);
    expect(badJson.code).toBe(1);
    expect(badJson.json?.ok).toBe(false);
    expect((badJson.json?.data as { status: string }).status).toBe('validation_error');
    expect(badJson.stderr).toBe('');

    const unknownCommand = await runJson(['frobnicate']);
    expect(unknownCommand.code).toBe(1);
    expect(unknownCommand.json?.ok).toBe(false);
    expect(unknownCommand.json?.tool).toBe('noemaloom_cli');
    expect(unknownCommand.stderr).toBe('');
  });

  it('returns specific validation for serve without --mcp instead of an unknown command', async () => {
    const result = await runJson(['serve', '--project', process.cwd()]);

    expect(result.code).toBe(1);
    expect(result.json?.tool).toBe('noemaloom_cli');
    expect((result.json?.warnings as Array<{ message: string }>)[0].message).toContain('serve requires --mcp');
  });

  it('prints the package version for --version', async () => {
    const captured = captureIo();

    const code = await runCli(['--version'], captured.io);
    const { stdout, stderr } = captured.output();

    expect(code).toBe(0);
    expect(stdout.trim()).toBe('0.0.0');
    expect(stderr).toBe('');
  });
});
