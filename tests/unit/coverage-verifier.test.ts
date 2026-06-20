import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applySpanMigrations } from '../../packages/core/src/spans/db.js';
import { verifyCoverage } from '../../packages/core/src/verifier/coverage-verifier.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { run: (...params: unknown[]) => void };
    close: () => void;
  };
};

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, 'utf8');
}

async function createInventoryOnlySpanDb(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, ?, 'markdown', ?, 64, 0, 0, 0, 0, '{}')`
    );
    db.exec('BEGIN');
    insertFile.run('docs/api/client.md', path.join(projectRoot, 'docs/api/client.md'), 'canonical_api_doc', 'changed-hash');
    insertFile.run('README.md', path.join(projectRoot, 'README.md'), 'readme_doc', 'cold-hash');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function createInventoryDbWithGeneratedDocRole(projectRoot: string): Promise<void> {
  const spansDir = path.join(projectRoot, '.noemaloom', 'spans');
  await mkdir(spansDir, { recursive: true });
  const db = new DatabaseSync(path.join(spansDir, 'spans.db'));
  try {
    applySpanMigrations(db);
    const insertFile = db.prepare(
      `INSERT INTO repo_files
        (path, absolute_path, role, language, content_hash, size_bytes, modified_at, indexed_at, generated, ignored, metadata_json)
       VALUES (?, ?, ?, 'python-bytecode', ?, 64, 0, 0, 1, 0, '{}')`
    );
    db.exec('BEGIN');
    insertFile.run(
      'tests/__pycache__/test_client.cpython-312.pyc',
      path.join(projectRoot, 'tests/__pycache__/test_client.cpython-312.pyc'),
      'experiment_note_doc',
      'generated-hash'
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
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

  it('fails when a cold inventory doc still contains an old term outside the scoped span set', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-coverage-scoped-'));
    await writeProjectFile(projectRoot, 'docs/api/client.md', '# Client API\n\nThe `timeoutMs` option is documented here.\n');
    await writeProjectFile(projectRoot, 'README.md', '# Demo\n\nStill references `legacyTimeout`.\n');
    await createInventoryOnlySpanDb(projectRoot);

    const result = await verifyCoverage({
      projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs in docs',
      changedPaths: ['docs/api/client.md'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });

    expect(result.status).toBe('fail');
    expect(result.unsyncedDocRoles).toEqual([
      expect.objectContaining({ path: 'README.md', role: 'readme_doc', term: 'legacyTimeout' })
    ]);
  });

  it('ignores generated Python bytecode even when stale indexes classify it as a doc role', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-coverage-pyc-'));
    await writeProjectFile(projectRoot, 'src/client.py', 'def create_client():\n    return "timeoutMs"\n');
    await writeProjectFile(projectRoot, 'tests/__pycache__/test_client.cpython-312.pyc', 'legacyTimeout bytecode cache\n');
    await createInventoryDbWithGeneratedDocRole(projectRoot);

    const result = await verifyCoverage({
      projectRoot,
      goal: 'Rename legacyTimeout to timeoutMs',
      changedPaths: ['src/client.py'],
      oldTerms: ['legacyTimeout'],
      newTerms: ['timeoutMs']
    });

    expect(result.status).toBe('pass');
    expect(result.remainingOldTermHits).toEqual([]);
    expect(result.unsyncedDocRoles).toEqual([]);
  });

  it('scans text files under directory changedPaths without throwing EISDIR', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noemaloom-coverage-dir-'));
    await writeProjectFile(projectRoot, 'AGENTS.md', '# Agents\n\nUse newTerm.\n');
    await writeProjectFile(projectRoot, '.agents/skills/demo/SKILL.md', '# Demo\n\nStill says legacyTerm.\n');

    const result = await verifyCoverage({
      projectRoot,
      goal: 'Rename legacyTerm to newTerm',
      changedPaths: ['MISSING.md', 'AGENTS.md', '.agents/skills'],
      oldTerms: ['legacyTerm'],
      newTerms: ['newTerm']
    });

    expect(result.status).toBe('fail');
    expect(result.remainingOldTermHits).toEqual([
      expect.objectContaining({ path: '.agents/skills/demo/SKILL.md', term: 'legacyTerm' })
    ]);
  });
});
