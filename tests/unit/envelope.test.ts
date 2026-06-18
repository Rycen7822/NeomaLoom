import { createEnvelope, createToolUnavailableEnvelope } from '../../packages/core/src/mcp/envelope.js';

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
});
