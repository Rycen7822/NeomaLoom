import { readFile } from 'node:fs/promises';
import { createToolRegistry, NOEMALOOM_TOOL_NAMES } from '../../packages/core/src/mcp/tool-registry.js';

describe('Codex MCP smoke', () => {
  it('documents manual Codex MCP connection and exposes only public nl tools', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('noemaloom serve --mcp');
    expect(readme).toContain('mcp_servers');
    expect(createToolRegistry().map(tool => tool.name)).toEqual([...NOEMALOOM_TOOL_NAMES]);
    expect(NOEMALOOM_TOOL_NAMES).not.toContain('nl_skill');
  });
});
