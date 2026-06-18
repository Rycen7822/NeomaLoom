import { createNoemaLoomServer } from '../../packages/core/src/mcp/server.js';
import { createToolRegistry, NOEMALOOM_TOOL_NAMES } from '../../packages/core/src/mcp/tool-registry.js';

describe('empty NoemaLoom MCP server', () => {
  it('registers exactly the ten planned nl_* tools', () => {
    expect(NOEMALOOM_TOOL_NAMES).toEqual([
      'nl_skill',
      'nl_status',
      'nl_refresh',
      'nl_query',
      'nl_locate',
      'nl_context',
      'nl_read_span',
      'nl_trace',
      'nl_impact',
      'nl_verify_coverage'
    ]);

    expect(createToolRegistry().map(tool => tool.name)).toEqual(NOEMALOOM_TOOL_NAMES);
  });

  it('returns not_implemented envelopes from registered placeholder handlers', async () => {
    const firstTool = createToolRegistry().find(tool => tool.name === 'nl_query');

    if (!firstTool) {
      throw new Error('nl_query tool is missing from the registry');
    }

    const result = await firstTool.handler({});

    expect(result).toMatchObject({
      ok: false,
      tool: firstTool.name,
      graphState: 'empty',
      data: {
        status: 'not_implemented'
      }
    });
    expect(result.warnings[0]).toMatchObject({
      code: 'not_implemented',
      severity: 'warning'
    });
  });

  it('creates a stdio-capable server adapter without exposing SDK imports outside sdk.ts', () => {
    const server = createNoemaLoomServer();

    expect(server).toMatchObject({
      connectStdio: expect.any(Function)
    });
  });
});
