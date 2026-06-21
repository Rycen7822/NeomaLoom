import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const requiredDocs = [
  'docs/architecture.md',
  'docs/mcp-tools.md',
  'docs/data-model.md',
  'docs/indexing.md',
  'docs/locating.md',
  'docs/safety.md',
  'docs/troubleshooting.md',
  'README.md',
  'README.zh-CN.md',
  'skill/noemaloom/SKILL.md'
];

const toolNames = [
  'nl_status',
  'nl_refresh',
  'nl_prepare_context',
  'nl_plan_change',
  'nl_verify_task',
  'nl_anchor_manage'
];

const hiddenPrimitiveToolNames = [
  'nl_query',
  'nl_locate',
  'nl_context',
  'nl_read_span',
  'nl_trace',
  'nl_impact',
  'nl_verify_coverage'
];

const workflowReferences = [
  'repository_locator',
  'markdown_update',
  'code_change_impact',
  'multi_doc_sync',
  'coverage_verification',
  'compression_recovery'
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
  const referenceFiles = (await readdir('skill/noemaloom/references'))
    .filter(file => file.endsWith('.md'))
    .map(file => path.join('skill/noemaloom/references', file));
  const files = [...requiredDocs, ...referenceFiles];
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
    for (const hiddenToolName of hiddenPrimitiveToolNames) {
      expect(text).not.toContain(hiddenToolName);
    }
  });

  it('root README contains exact manual MCP snippets and runtime safety statements', async () => {
    const readme = await readFile('README.md', 'utf8');

    expect(readme).toContain('noemaloom serve --mcp');
    expect(readme).toContain('mcp_servers:');
    expect(readme).toContain('[mcp_servers.noemaloom]');
    expect(readme).toContain('args = ["serve", "--mcp"]');
    expect(readme).toContain('# NoemaLoom');
    expect(readme).toContain('User-level installation');
    expect(readme).toContain('Project-level installation');
    expect(readme).toContain('Before changing any user-level agent config');
    expect(readme).toContain('.noemaloom/');
    expect(readme).toContain('does not write global config');
    expect(readme).toContain('does not install Git hooks');
    expect(readme).toContain('does not patch Codex cache');
  });

  it('documents and declares the runtime floor required by node:sqlite', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { engines?: { node?: string } };
    const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      packages?: Record<string, { engines?: { node?: string } }>;
    };
    const readme = await readFile('README.md', 'utf8');
    const readmeZh = await readFile('README.zh-CN.md', 'utf8');
    const expectedRange = '>=22.13.0 <23 || >=23.4.0';

    expect(packageJson.engines?.node).toBe(expectedRange);
    expect(lockfile.packages?.['']?.engines?.node).toBe(expectedRange);
    expect(readme).toContain('Node.js 22.13+ LTS, Node.js 23.4+, or Node.js 24+');
    expect(readme).toContain('NoemaLoom uses the built-in `node:sqlite` module');
    expect(readme).not.toContain('Node.js 20+');
    expect(readme).not.toContain('Node.js 20 or newer');
    expect(readmeZh).toContain('Node.js 22.13+ LTS、Node.js 23.4+ 或 Node.js 24+');
    expect(readmeZh).toContain('NoemaLoom 使用内置 `node:sqlite` 模块');
    expect(readmeZh).not.toContain('Node.js 20+');
    expect(readmeZh).not.toContain('Node.js 20 或更新版本');
  });

  it('skill is a lightweight router to the six workflow references', async () => {
    const skill = await readFile('skill/noemaloom/SKILL.md', 'utf8');

    expect(skill).toMatch(/^---\nname: noemaloom\n/);
    expect(skill).toMatch(/description: "?Use when Codex needs NoemaLoom/);
    expect(skill).toContain('Only call these public MCP tools');
    expect(skill).toContain('Load references in the listed order');

    for (const workflow of workflowReferences) {
      expect(skill).toContain(`references/${workflow}.md`);
    }
    expect(skill).toContain('NoemaLoom locates and verifies spans');
    expect(skill).toContain('Codex or Hermes edits files with native tools');
    expect(skill).not.toContain('## Tool Surface');
  });

  it('workflow references give unambiguous public-tool payload fields', async () => {
    const references = new Map(
      await Promise.all(
        workflowReferences.map(async workflow => [
          workflow,
          await readFile(`skill/noemaloom/references/${workflow}.md`, 'utf8')
        ] as const)
      )
    );

    expect(references.get('repository_locator')).toContain('includeRepositoryMap');
    expect(references.get('repository_locator')).toContain('targetRoles');
    expect(references.get('repository_locator')).toContain('readTopSpans');
    expect(references.get('repository_locator')).toContain('changedPaths');
    expect(references.get('repository_locator')).toContain('target="changed"');

    expect(references.get('markdown_update')).toContain('canonical_api_doc');
    expect(references.get('markdown_update')).toContain('readme_doc');
    expect(references.get('markdown_update')).toContain('oldTerms');

    expect(references.get('code_change_impact')).toContain('targetType="auto"');
    expect(references.get('code_change_impact')).toContain('depth=2');
    expect(references.get('code_change_impact')).toContain('target');

    expect(references.get('multi_doc_sync')).toContain('targetRoles');
    expect(references.get('coverage_verification')).toContain('status="pass"');
    expect(references.get('compression_recovery')).toContain('budget=1024');

    for (const text of references.values()) {
      expect(text).not.toMatch(/\b(document|code|config|example|feature) roles\b/);
      expect(text).not.toContain('NoemaLoom MCP tools for locating');
    }
  });
});
