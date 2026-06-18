import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture, replaceInFile } from './helpers.js';

describe('e2e multi-document old term sweep', () => {
  it('keeps similar document paragraphs and catches omitted docs', async () => {
    const projectRoot = await copyFixture('multi-doc-old-term');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });
    const goal = 'Replace retrieval-only context with span-first repository localization';
    const locate = await callRegisteredTool('nl_locate', {
      projectPath: projectRoot,
      goal,
      targetRoles: ['readme_doc', 'tutorial_doc', 'design_doc', 'paper_doc'],
      limit: 20
    });
    const data = locate.data as { targets: Array<{ path: string; role: string }>; coveragePlan: { exactSweeps: string[] } };
    expect(new Set(data.targets.filter(target => target.role.endsWith('_doc')).map(target => target.path))).toEqual(
      new Set(['README.md', 'docs/tutorial/context.md', 'docs/design/context.md', 'paper/context.md'])
    );
    expect(data.coveragePlan.exactSweeps).toContain('retrieval-only context');

    await replaceInFile(projectRoot, 'README.md', 'retrieval-only context', 'span-first repository localization');
    const coverage = await callRegisteredTool('nl_verify_coverage', {
      projectPath: projectRoot,
      goal,
      changedPaths: ['README.md'],
      oldTerms: ['retrieval-only context'],
      newTerms: ['span-first repository localization']
    });
    expect(coverage.data).toMatchObject({
      status: 'needs_attention',
      unsyncedDocRoles: expect.arrayContaining([
        expect.objectContaining({ path: 'docs/tutorial/context.md' }),
        expect.objectContaining({ path: 'docs/design/context.md' }),
        expect.objectContaining({ path: 'paper/context.md' })
      ])
    });
  });
});
