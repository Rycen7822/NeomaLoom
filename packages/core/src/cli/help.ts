export function getHelpText(): string {
  return [
    'NoemaLoom locates and verifies repository spans.',
    '',
    'Usage: noemaloom serve --mcp',
    '',
    'Commands:',
    '  serve --mcp  Start the MCP stdio server.'
  ].join('\n');
}
