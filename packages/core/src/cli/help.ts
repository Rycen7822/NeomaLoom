export function getHelpText(): string {
  return [
    'NoemaLoom locates and verifies repository spans.',
    '',
    'Usage: noemaloom serve --mcp',
    'Usage: noemaloom anchor <status|promote|demote|repair|retire|checkpoint> [--project PATH] [--json JSON | --json-file PATH]',
    '',
    'Commands:',
    '  serve --mcp        Start the MCP stdio server.',
    '  anchor status      Print project-local navigation anchor status through nl_status includeAnchors.',
    '  anchor promote     Promote an anchor through controlled workset helpers.',
    '  anchor demote      Demote an anchor through controlled workset helpers.',
    '  anchor repair      Repair an anchor path/label/range through controlled workset helpers.',
    '  anchor retire      Retire an anchor and write a tombstone through controlled workset helpers.',
    '  anchor checkpoint  Update project-local navigation injection checkpoint/options.',
    '',
    'Anchor payload:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json JSON        JSON object payload for the anchor operation.',
    '  --json-file PATH   Read JSON object payload from a file.'
  ].join('\n');
}
