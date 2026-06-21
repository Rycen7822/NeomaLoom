import { access, readFile } from 'node:fs/promises';

const pluginFiles = [
  'hermes-plugin/noemaloom/plugin.yaml',
  'hermes-plugin/noemaloom/__init__.py',
  'hermes-plugin/noemaloom/noemaloom_bridge.py',
  'hermes-plugin/noemaloom/navigation_hooks.py',
  'hermes-plugin/noemaloom/schemas.py',
  'hermes-plugin/noemaloom/resources/skills/usage/SKILL.md'
];

const publicTools = [
  'nl_status',
  'nl_refresh',
  'nl_prepare_context',
  'nl_plan_change',
  'nl_verify_task',
  'nl_anchor_manage'
];

const hiddenTools = [
  'nl_query',
  'nl_locate',
  'nl_context',
  'nl_read_span',
  'nl_trace',
  'nl_impact',
  'nl_verify_coverage'
];

describe('Hermes plugin contract', () => {
  it('ships a native Hermes plugin directory with manifest, handlers, schemas, and bundled usage skill', async () => {
    for (const file of pluginFiles) {
      await expect(access(file)).resolves.toBeUndefined();
    }

    const manifest = await readFile('hermes-plugin/noemaloom/plugin.yaml', 'utf8');
    expect(manifest).toContain('name: noemaloom');
    expect(manifest).toContain('kind: standalone');
    for (const tool of publicTools) {
      expect(manifest).toContain(`- ${tool}`);
    }
    expect(manifest).toContain('provides_hooks:');
    expect(manifest).toContain('- pre_llm_call');
    expect(manifest).toContain('- post_tool_call');

    const init = await readFile('hermes-plugin/noemaloom/__init__.py', 'utf8');
    expect(init).toContain('ctx.register_tool');
    expect(init).toContain('ctx.register_skill');
    expect(init).toContain('ctx.register_hook("pre_llm_call"');
    expect(init).toContain('ctx.register_hook("post_tool_call"');
    expect(init).toContain('toolset="noemaloom"');

    const schemas = await readFile('hermes-plugin/noemaloom/schemas.py', 'utf8');
    expect(schemas).toContain('"paths"');
    expect(schemas).toContain('"hotset"');
    expect(schemas).toContain('"promotionReason"');

    const skill = await readFile('hermes-plugin/noemaloom/resources/skills/usage/SKILL.md', 'utf8');
    expect(skill).toContain('Only call these public Hermes tools');
    expect(skill).toContain('noemaloom:usage');
    for (const tool of publicTools) {
      expect(skill).toContain(tool);
    }
  });

  it('keeps the Hermes plugin surface curated and does not document hidden primitives as callable tools', async () => {
    const pluginDocs = await Promise.all([
      readFile('hermes-plugin/noemaloom/plugin.yaml', 'utf8'),
      readFile('hermes-plugin/noemaloom/__init__.py', 'utf8'),
      readFile('hermes-plugin/noemaloom/schemas.py', 'utf8'),
      readFile('hermes-plugin/noemaloom/resources/skills/usage/SKILL.md', 'utf8'),
      readFile('README.md', 'utf8'),
      readFile('README.zh-CN.md', 'utf8')
    ]);
    const text = pluginDocs.join('\n');

    for (const tool of publicTools) {
      expect(text).toContain(tool);
    }
    for (const tool of hiddenTools) {
      expect(text).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
    expect(text).not.toContain('write-hermes-config');
    expect(text).not.toContain('patch-codex-cache');
    expect(text).not.toContain('install-hooks');
  });

  it('updates README with plugin-first Hermes installation and keeps manual MCP as compatibility path', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('## Hermes Plugin');
    expect(readme).toContain('hermes-plugin/noemaloom');
    expect(readme).toContain('hermes plugins enable noemaloom');
    expect(readme).toContain('NOEMALOOM_REPO');
    expect(readme).toContain('skill_view(name="noemaloom:usage")');
    expect(readme).toContain('No separate Hermes MCP server entry is required');
    expect(readme).toContain('## Manual MCP Configuration');

    const readmeZh = await readFile('README.zh-CN.md', 'utf8');
    expect(readmeZh).toContain('## Hermes Plugin');
    expect(readmeZh).toContain('hermes-plugin/noemaloom');
    expect(readmeZh).toContain('hermes plugins enable noemaloom');
    expect(readmeZh).toContain('NOEMALOOM_REPO');
    expect(readmeZh).toContain('skill_view(name="noemaloom:usage")');
    expect(readmeZh).toContain('不需要单独添加 Hermes MCP server entry');
  });
});
