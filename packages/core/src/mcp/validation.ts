const BLOCKED_TOOL_NAMES = new Set([
  'codegraph_explore',
  'codegraph_search',
  'search_rpg',
  'rpg_generate',
  'write_codex_config',
  'write_hermes_config',
  'writer_apply',
  'writer_update',
  'memory_store',
  'memory_recall'
]);

export function isBlockedToolName(toolName: string): boolean {
  return BLOCKED_TOOL_NAMES.has(toolName) || toolName.includes('writer') || toolName.startsWith('write_');
}
