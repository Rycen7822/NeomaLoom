import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const requiredDocs = [
  'docs/README.md',
  'docs/architecture.md',
  'docs/mcp-tools.md',
  'docs/data-model.md',
  'docs/indexing.md',
  'docs/locating.md',
  'docs/safety.md',
  'docs/troubleshooting.md',
  'skill/noemaloom/SKILL.md'
];

const toolNames = [
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
];

const forbiddenCommands = [
  'install-agent',
  'uninstall-agent',
  'write-codex-config',
  'write-hermes-config',
  'patch-codex-cache',
  'install-hooks'
];

const forbiddenRawToolPatterns = [
  /\bcodegraph_[a-z0-9_]+\b/i,
  /\brpgkit_[a-z0-9_]+\b/i,
  /\brpg_[a-z0-9_]+\b/i,
  /\bsearch_rpg\b/i
];

async function readAllDocs(): Promise<string> {
  const workflowFiles = (await readdir('skill/noemaloom/workflows'))
    .filter(file => file.endsWith('.md'))
    .map(file => path.join('skill/noemaloom/workflows', file));
  const files = [...requiredDocs, ...workflowFiles];
  const chunks = await Promise.all(files.map(file => readFile(file, 'utf8')));
  return chunks.join('\n');
}

describe('documentation policy', () => {
  it('contains required manual docs and rejects config writers, hooks, cache patchers, and raw tool names', async () => {
    const text = await readAllDocs();

    for (const command of forbiddenCommands) {
      expect(text).not.toContain(command);
    }
    for (const pattern of forbiddenRawToolPatterns) {
      expect(text).not.toMatch(pattern);
    }
    for (const toolName of toolNames) {
      expect(text).toContain(toolName);
    }
  });

  it('README contains exact manual MCP snippets and runtime safety statements', async () => {
    const readme = await readFile('docs/README.md', 'utf8');

    expect(readme).toContain('noemaloom serve --mcp');
    expect(readme).toContain('mcp_servers:');
    expect(readme).toContain('[mcp_servers.noemaloom]');
    expect(readme).toContain('args = ["serve", "--mcp"]');
    expect(readme).toContain('## NoemaLoom');
    expect(readme).toContain('.noemaloom/');
    expect(readme).toContain('does not write global config');
    expect(readme).toContain('does not install Git hooks');
    expect(readme).toContain('does not patch Codex cache');
  });

  it('skill contains the six required workflows and states that native agents perform edits', async () => {
    const skill = await readFile('skill/noemaloom/SKILL.md', 'utf8');

    for (const workflow of [
      'repository_locator',
      'markdown_update',
      'code_change_impact',
      'multi_doc_sync',
      'coverage_verification',
      'compression_recovery'
    ]) {
      expect(skill).toContain(workflow);
    }
    expect(skill).toContain('NoemaLoom locates and verifies spans');
    expect(skill).toContain('Codex or Hermes edits files with native tools');
  });
});
