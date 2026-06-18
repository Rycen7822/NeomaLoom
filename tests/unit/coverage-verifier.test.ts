import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { verifyCoverage } from '../../packages/core/src/verifier/coverage-verifier.js';

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

describe('coverage verifier', () => {
  it('fails while current changed files contain old terms or broken links and passes after they are fixed', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-coverage-unit-'));
    await writeProjectFile(projectRoot, 'docs/api/client.md', [
      '# Client API',
      '',
      'The `legacyTimeout` option is documented here.',
      '',
      '[Missing](./missing.md)',
      ''
    ].join('\n'));

    const failing = await verifyCoverage({
      projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });

    expect(failing.status).toBe('fail');
    expect(failing.remainingOldTermHits).toEqual([
      expect.objectContaining({ path: 'docs/api/client.md', line: 3, term: 'legacyTimeout' })
    ]);
    expect(failing.brokenLinks).toEqual([
      expect.objectContaining({ path: 'docs/api/client.md', target: './missing.md' })
    ]);

    await writeProjectFile(projectRoot, 'docs/api/missing.md', '# Present\n');
    await writeProjectFile(projectRoot, 'docs/api/client.md', [
      '# Client API',
      '',
      'The `timeoutMs` option is documented here.',
      '',
      '[Present](./missing.md)',
      ''
    ].join('\n'));

    const passing = await verifyCoverage({
      projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });

    expect(passing).toMatchObject({
      remainingOldTermHits: [],
      staleAnchors: [],
      brokenLinks: [],
      unsyncedDocRoles: [],
      codeDocMismatches: [],
      unverifiedLinkedTests: [],
      unreadMustEditTargets: [],
      status: 'pass'
    });
  });
});
