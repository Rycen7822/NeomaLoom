import { readFile } from 'node:fs/promises';
import { createNoemaLoomServer } from '../../packages/core/src/mcp/server.js';

describe('Hermes MCP smoke', () => {
  it('documents manual Hermes connection and creates a stdio-capable server', async () => {
    const readme = await readFile('docs/README.md', 'utf8');
    expect(readme).toContain('mcp_servers:');
    expect(readme).toContain('command: noemaloom');
    expect(readme).toContain('- serve');
    expect(readme).toContain('- --mcp');
    expect(createNoemaLoomServer()).toMatchObject({ connectStdio: expect.any(Function) });
  });
});
