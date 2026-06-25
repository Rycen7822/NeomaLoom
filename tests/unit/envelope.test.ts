import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createEnvelope,
  createToolUnavailableEnvelope,
  createUnhandledErrorEnvelope,
  isUnsafeDefaultProjectRootForPlatform,
  resolveProjectRootFromInput
} from '../../packages/core/src/mcp/envelope.js';

describe('MCP response envelope', () => {
  it('has the fixed top-level keys in the required order', () => {
    const envelope = createEnvelope({
      ok: true,
      tool: 'nl_status',
      projectRoot: '/tmp/noemaloom-project',
      graphState: 'empty',
      data: {
        stateDir: '.noemaloom'
      }
    });

    expect(Object.keys(envelope)).toEqual([
      'ok',
      'tool',
      'projectRoot',
      'graphRevision',
      'graphState',
      'tokenBudget',
      'warnings',
      'data',
      'evidence',
      'nextActions'
    ]);
    expect(envelope).toMatchObject({
      ok: true,
      tool: 'nl_status',
      projectRoot: '/tmp/noemaloom-project',
      graphRevision: null,
      graphState: 'empty',
      tokenBudget: {
        requested: 0,
        used: 0,
        truncated: false
      },
      warnings: [],
      evidence: [],
      nextActions: []
    });
  });

  it('returns an envelope instead of throwing for unavailable tools', () => {
    const envelope = createToolUnavailableEnvelope('codegraph_explore', '/tmp/noemaloom-project');

    expect(envelope).toMatchObject({
      ok: false,
      tool: 'codegraph_explore',
      projectRoot: '/tmp/noemaloom-project',
      graphState: 'empty',
      data: {
        status: 'tool_not_available'
      },
      warnings: [
        {
          code: 'tool_not_available',
          severity: 'error'
        }
      ]
    });
  });

  it('keeps stack frame paths out of public unhandled-error warnings', () => {
    const envelope = createUnhandledErrorEnvelope('nl_status', '/tmp/noemaloom-project', new Error('boom'));

    expect(envelope.warnings[0].message).toBe('Error: boom');
    expect(envelope.warnings[0].message).not.toContain('at ');
    expect(envelope.warnings[0].message).not.toContain(import.meta.url);
  });

  it('rejects unsafe default projectPath roots', () => {
    const root = path.parse(process.cwd()).root;

    expect(() => resolveProjectRootFromInput({ projectPath: root })).toThrow(expect.objectContaining({
      code: 'project_root_not_allowed'
    }));

    if (process.platform !== 'win32') {
      expect(() => resolveProjectRootFromInput({ projectPath: '/etc' })).toThrow(expect.objectContaining({
        code: 'project_root_not_allowed'
      }));
    }
  });

  it('treats Windows system directories as unsafe default project roots', () => {
    for (const candidate of [
      'C:\\Windows',
      'C:\\Windows\\System32',
      'C:\\Program Files',
      'C:\\Program Files\\NoemaLoom',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\System Volume Information',
      'C:\\$Recycle.Bin'
    ]) {
      expect(isUnsafeDefaultProjectRootForPlatform(candidate, 'win32')).toBe(true);
    }
    expect(isUnsafeDefaultProjectRootForPlatform('C:\\Users\\alice\\project', 'win32')).toBe(false);
  });

  it('honors NOEMALOOM_ALLOWED_PROJECTS as a strict projectPath allowlist', async () => {
    const previous = process.env.NOEMALOOM_ALLOWED_PROJECTS;
    const allowed = await mkdtemp(path.join(tmpdir(), 'noemaloom-allowed-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'noemaloom-denied-root-'));
    process.env.NOEMALOOM_ALLOWED_PROJECTS = allowed;
    try {
      expect(resolveProjectRootFromInput({ projectPath: path.join(allowed, 'child') })).toBe(path.join(allowed, 'child'));
      expect(() => resolveProjectRootFromInput({ projectPath: outside })).toThrow(expect.objectContaining({
        code: 'project_root_not_allowed'
      }));
    } finally {
      if (previous === undefined) delete process.env.NOEMALOOM_ALLOWED_PROJECTS;
      else process.env.NOEMALOOM_ALLOWED_PROJECTS = previous;
    }
  });

  it('applies project-root allowlist policy to the process.cwd fallback', async () => {
    const previousAllowed = process.env.NOEMALOOM_ALLOWED_PROJECTS;
    const previousCwd = process.cwd();
    const allowed = await mkdtemp(path.join(tmpdir(), 'noemaloom-cwd-allowed-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'noemaloom-cwd-denied-'));
    process.env.NOEMALOOM_ALLOWED_PROJECTS = allowed;
    process.chdir(outside);
    try {
      expect(() => resolveProjectRootFromInput({})).toThrow(expect.objectContaining({
        code: 'project_root_not_allowed'
      }));
    } finally {
      process.chdir(previousCwd);
      if (previousAllowed === undefined) delete process.env.NOEMALOOM_ALLOWED_PROJECTS;
      else process.env.NOEMALOOM_ALLOWED_PROJECTS = previousAllowed;
    }
  });
});
