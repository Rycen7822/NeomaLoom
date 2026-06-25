export function getHelpText(): string {
  return [
    'NoemaLoom locates and verifies repository spans.',
    '',
    'Usage: noemaloom serve --mcp',
    'Usage: noemaloom status [--project PATH] [--json]',
    'Usage: noemaloom anchor <status|promote|demote|repair|retire|checkpoint> [--project PATH] [--json JSON | --json-file PATH]',
    '',
    'Commands:',
    '  serve --mcp        Start the MCP stdio server.',
    '  status             Print nl_status for a project as JSON.',
    '  anchor status      Print project-local navigation anchor status through nl_status includeAnchors.',
    '  anchor promote     Promote an anchor through controlled workset helpers.',
    '  anchor demote      Demote an anchor through controlled workset helpers.',
    '  anchor repair      Repair an anchor path/label/range through controlled workset helpers.',
    '  anchor retire      Retire an anchor and write a tombstone through controlled workset helpers.',
    '  anchor checkpoint  Update project-local navigation injection checkpoint/options.',
    '',
    'Status options:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json             Emit JSON. This is the default and is accepted for script compatibility.',
    '',
    'Anchor payload:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json JSON        JSON object payload for the anchor operation.',
    '  --json-file PATH   Read JSON object payload from a file.'
  ].join('\n');
}

export function getStatusHelpText(): string {
  return [
    'Usage: noemaloom status [--project PATH] [--json]',
    '',
    'Print nl_status for a project as a JSON envelope.',
    '',
    'Options:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json             Emit JSON. Accepted for compatibility; output is always JSON.'
  ].join('\n');
}
