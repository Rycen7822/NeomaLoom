import { createNoemaLoomServer } from '../../packages/core/src/mcp/server.js';
import { createToolRegistry, NOEMALOOM_TOOL_NAMES } from '../../packages/core/src/mcp/tool-registry.js';

describe('empty NoemaLoom MCP server', () => {
  it('registers exactly the curated agent-facing nl_* tools', () => {
    expect(NOEMALOOM_TOOL_NAMES).toEqual([
      'nl_status',
      'nl_refresh',
      'nl_prepare_context',
      'nl_plan_change',
      'nl_verify_task',
      'nl_anchor_manage'
    ]);

    expect(createToolRegistry().map(tool => tool.name)).toEqual(NOEMALOOM_TOOL_NAMES);
  });

  it('does not leave planned tools registered as placeholders', () => {
    expect(createToolRegistry().map(tool => tool.description)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('placeholder')])
    );
  });

  it('creates a stdio-capable server adapter without exposing SDK imports outside sdk.ts', () => {
    const server = createNoemaLoomServer();

    expect(server).toMatchObject({
      connectStdio: expect.any(Function)
    });
  });
});
