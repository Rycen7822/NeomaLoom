export function getHelpText(): string {
  return [
    'NoemaLoom locates and verifies repository spans.',
    '',
    'Usage: noemaloom serve --mcp',
    'Usage: noemaloom status [--project PATH] [--json [JSON] | --json-file PATH]',
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
    '  --json             Emit JSON. This is the default when no payload follows.',
    '  --json JSON        Merge a JSON object payload into nl_status input.',
    '  --json-file PATH   Read a JSON object payload from a file.',
    '',
    'Anchor payload:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json JSON        JSON object payload for the anchor operation.',
    '  --json-file PATH   Read JSON object payload from a file.'
  ].join('\n');
}

export function getServeHelpText(): string {
  return [
    'Usage: noemaloom serve --mcp',
    '',
    'Start the NoemaLoom MCP stdio server.',
    '',
    'Options:',
    '  --mcp             Required. Start MCP stdio transport.'
  ].join('\n');
}

export function getStatusHelpText(): string {
  return [
    'Usage: noemaloom status [--project PATH] [--json [JSON] | --json-file PATH]',
    '',
    'Print nl_status for a project as a JSON envelope.',
    '',
    'Options:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json             Emit JSON. This is the default when no payload follows.',
    '  --json JSON        Merge a JSON object payload into nl_status input.',
    '  --json-file PATH   Read a JSON object payload from a file.'
  ].join('\n');
}

export function getAnchorHelpText(): string {
  return [
    'Usage: noemaloom anchor <status|promote|demote|repair|retire|checkpoint> [--project PATH] [--json JSON | --json-file PATH]',
    '',
    'Inspect and maintain project-local navigation anchors through controlled operations.',
    '',
    'Actions:',
    '  anchor status      Print nl_status with includeAnchors=true.',
    '  anchor promote     Promote a path/range into the navigation workset.',
    '  anchor demote      Demote a navigation anchor to dormant or archived state.',
    '  anchor repair      Repair anchor path, label, role, kind, or range metadata.',
    '  anchor retire      Retire an anchor and write a tombstone.',
    '  anchor checkpoint  Update navigation injection checkpoint/options.',
    '',
    'Payload options:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json JSON        JSON object payload for the anchor operation.',
    '  --json-file PATH   Read JSON object payload from a file.'
  ].join('\n');
}

export function getAnchorActionHelpText(action: string): string {
  return [
    `Usage: noemaloom anchor ${action} [--project PATH] [--json JSON | --json-file PATH]`,
    '',
    `Run the controlled anchor ${action} operation.`,
    '',
    'Options:',
    '  --project PATH     Repository/workspace root. Defaults to current working directory.',
    '  --json JSON        JSON object payload for the anchor operation.',
    '  --json-file PATH   Read JSON object payload from a file.'
  ].join('\n');
}
