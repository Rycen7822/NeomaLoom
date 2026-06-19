import { readFile } from 'node:fs/promises';
import { createToolRegistry, NOEMALOOM_TOOL_NAMES } from '../../packages/core/src/mcp/tool-registry.js';

describe('Codex MCP smoke', () => {
  it('documents manual Codex connection and exposes exactly five nl tools', async () => {
    const readme = await readFile('docs/README.md', 'utf8');
    expect(readme).toContain('[mcp_servers.noemaloom]');
    expect(readme).toContain('args = ["serve", "--mcp"]');
    expect(createToolRegistry().map(tool => tool.name)).toEqual([...NOEMALOOM_TOOL_NAMES]);
    expect(NOEMALOOM_TOOL_NAMES).not.toContain('nl_skill');
  });
});
