import { readFile } from 'node:fs/promises';
import { callRegisteredTool } from '../../packages/core/src/mcp/tool-registry.js';
import { copyFixture, replaceInFile } from './helpers.js';

describe('e2e markdown API documentation sync', () => {
  it('locates scheduler docs, reads complete spans, and verifies old-term cleanup', async () => {
    const projectRoot = await copyFixture('scheduler-doc-sync');
    await expect(callRegisteredTool('nl_refresh', { projectPath: projectRoot, target: 'all', mode: 'safe' })).resolves.toMatchObject({ ok: true });

    const prepared = await callRegisteredTool('nl_prepare_context', {
      projectPath: projectRoot,
      goal: 'Update documentation for the renamed scheduler timeout option from timeout to timeoutMs',
      targetRoles: ['canonical_api_doc', 'readme_doc', 'tutorial_doc', 'example_doc', 'source_file', 'test_file'],
      limit: 30,
      readTopSpans: true,
      maxReadSpans: 3
    });
    expect(prepared.ok).toBe(true);
    const preparedData = prepared.data as {
      targets: Array<{ spanId: string; path: string; role: string; decision: string; kind: string }>;
      coveragePlan: { exactSweeps: string[] };
      readSpans: Array<{ path: string; content: string }>;
    };
    expect(preparedData.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'docs/api/scheduler.md', role: 'canonical_api_doc', decision: 'must_edit' }),
        expect.objectContaining({ path: 'README.md', role: 'readme_doc' }),
        expect.objectContaining({ path: 'docs/tutorial/scheduler.md', role: 'tutorial_doc' }),
        expect.objectContaining({ path: 'examples/scheduler.md', role: 'example_doc' })
      ])
    );
    expect(preparedData.readSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'docs/api/scheduler.md',
          content: expect.stringContaining('| `timeout` |')
        })
      ])
    );

    await replaceInFile(projectRoot, 'docs/api/scheduler.md', '`timeout`', '`timeoutMs`');
    const failing = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename timeout to timeoutMs in scheduler docs',
      changedPaths: ['docs/api/scheduler.md', 'README.md', 'docs/tutorial/scheduler.md', 'examples/scheduler.md'],
      oldTerms: ['timeout`', 'timeout option'],
      newTerms: ['timeoutMs']
    });
    expect(failing.data).toMatchObject({ status: 'fail' });

    for (const repoPath of ['README.md', 'docs/tutorial/scheduler.md', 'examples/scheduler.md']) {
      const before = await readFile(`${projectRoot}/${repoPath}`, 'utf8');
      await replaceInFile(projectRoot, repoPath, 'timeout', 'timeoutMs');
      expect(before).toContain('timeout');
    }
    const passing = await callRegisteredTool('nl_verify_task', {
      projectPath: projectRoot,
      goal: 'Rename timeout to timeoutMs in scheduler docs',
      changedPaths: ['docs/api/scheduler.md', 'README.md', 'docs/tutorial/scheduler.md', 'examples/scheduler.md'],
      oldTerms: ['timeout`', 'timeout option'],
      newTerms: ['timeoutMs']
    });
    expect(passing.data).toMatchObject({ status: 'pass', coverage: { remainingOldTermHits: [] } });
  });
});
