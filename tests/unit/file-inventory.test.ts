import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createDefaultConfig } from '../../packages/core/src/config/default-config.js';
import { buildFileInventory } from '../../packages/core/src/files/file-inventory.js';

const execFileAsync = promisify(execFile);

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeProjectFile(projectRoot: string, repoPath: string, text: string): Promise<void> {
  const absolutePath = path.join(projectRoot, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text);
}

describe('file inventory', () => {
  it('combines git tracked files with visible untracked files', async () => {
    const projectRoot = await createTempProject('noemaloom-git-inventory-');
    await execFileAsync('git', ['init'], { cwd: projectRoot });
    await writeProjectFile(projectRoot, 'README.md', '# Project\n');
    await writeProjectFile(projectRoot, 'src/app.ts', 'export const app = 1;\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectRoot });

    const inventory = await buildFileInventory({ projectRoot });

    expect(inventory.files.map(file => file.path)).toEqual(['README.md', 'src/app.ts']);
    expect(inventory.files.find(file => file.path === 'README.md')).toMatchObject({
      role: 'readme_doc',
      language: 'markdown',
      ignored: false,
      oversized: false,
      spanKind: 'file'
    });
  });

  it('walks non-git repositories and keeps inventory records sorted', async () => {
    const projectRoot = await createTempProject('noemaloom-walk-inventory-');
    for (const repoPath of [
      'CHANGELOG.md',
      'CODEX_STATE.md',
      'docs/api/client.md',
      'docs/tutorial-first/intro.md',
      'examples/basic.ts',
      'paper/notes.md',
      'notes/run.md',
      'design/arch.md',
      'src/app.ts',
      'tests/app.test.ts',
      'fixtures/sample.json',
      'config/settings.yaml',
      'schema/settings.schema.json',
      'package.json',
      'features/plan.md'
    ]) {
      await writeProjectFile(projectRoot, repoPath, `${repoPath}\n`);
    }

    const inventory = await buildFileInventory({ projectRoot });
    const byPath = new Map(inventory.files.map(file => [file.path, file]));

    expect(inventory.files.map(file => file.path)).toEqual([...inventory.files.map(file => file.path)].sort());
    expect(byPath.get('docs/api/client.md')).toMatchObject({ role: 'canonical_api_doc', language: 'markdown' });
    expect(byPath.get('src/app.ts')).toMatchObject({ role: 'source_file', language: 'typescript' });
    expect(byPath.get('tests/app.test.ts')).toMatchObject({ role: 'test_file', language: 'typescript' });
    expect(byPath.get('package.json')).toMatchObject({ role: 'package_metadata', language: 'json' });
  });

  it('honors includeExtensions before creating inventory files', async () => {
    const projectRoot = await createTempProject('noemaloom-extension-inventory-');
    await writeProjectFile(projectRoot, 'README.md', '# Demo\n');
    await writeProjectFile(projectRoot, 'LICENSE', 'MIT\n');
    await writeProjectFile(projectRoot, 'src/app.ts', 'export const app = 1;\n');
    await writeProjectFile(projectRoot, 'assets/logo.svg', '<svg />\n');
    const config = createDefaultConfig(projectRoot);
    config.fileInventory.includeExtensions = ['.ts'];

    const inventory = await buildFileInventory({ projectRoot, config });

    expect(inventory.files.map(file => file.path)).toEqual(['LICENSE', 'src/app.ts']);
    expect(inventory.ignoredPaths).toEqual(['README.md', 'assets/logo.svg']);
  });

  it('marks oversized files as file-only spans without normal FTS text', async () => {
    const projectRoot = await createTempProject('noemaloom-oversized-inventory-');
    await writeProjectFile(projectRoot, 'src/big.ts', '0123456789abcdef\n');
    const config = createDefaultConfig(projectRoot);
    config.indexing.maxFileBytes = 4;

    const inventory = await buildFileInventory({ projectRoot, config });

    expect(inventory.files).toHaveLength(1);
    expect(inventory.files[0]).toMatchObject({
      path: 'src/big.ts',
      role: 'source_file',
      oversized: true,
      fileOnlySpan: true,
      spanKind: 'file',
      indexedText: ''
    });
    expect(inventory.files[0].contentHash).toMatch(/^oversized:/);
  });

  it('can build metadata-only inventory without retaining indexed file text', async () => {
    const projectRoot = await createTempProject('noemaloom-metadata-inventory-');
    await writeProjectFile(projectRoot, 'src/app.ts', 'export const app = 1;\n');

    const full = await buildFileInventory({ projectRoot });
    const metadataOnly = await buildFileInventory({ projectRoot, loadIndexedText: false });

    expect(full.files[0].indexedText).toBe('export const app = 1;\n');
    expect(metadataOnly.files[0]).toMatchObject({
      path: 'src/app.ts',
      oversized: false,
      indexedText: ''
    });
    expect(metadataOnly.files[0].contentHash).toBe(full.files[0].contentHash);
  });

  it('applies ignore globs and excludes vendor unless explicitly requested', async () => {
    const projectRoot = await createTempProject('noemaloom-ignore-inventory-');
    for (const repoPath of [
      '.noemaloom/cache.json',
      'node_modules/pkg/index.js',
      'dist/app.js',
      'build/app.js',
      'target/debug/app.js',
      '.venv/bin/python',
      'coverage/summary.json',
      'src/__pycache__/app.cpython-312.pyc',
      'vendor/pkg/index.js',
      'src/app.ts'
    ]) {
      await writeProjectFile(projectRoot, repoPath, `${repoPath}\n`);
    }

    const inventory = await buildFileInventory({ projectRoot });

    expect(inventory.files.map(file => file.path)).toEqual(['src/app.ts']);
    expect(inventory.ignoredPaths).toEqual([
      '.noemaloom/cache.json',
      '.venv/bin/python',
      'build/app.js',
      'coverage/summary.json',
      'dist/app.js',
      'node_modules/pkg/index.js',
      'src/__pycache__/app.cpython-312.pyc',
      'target/debug/app.js',
      'vendor/pkg/index.js'
    ]);

    const withVendor = await buildFileInventory({ projectRoot, includeVendor: true });
    expect(withVendor.files.map(file => file.path)).toEqual(['src/app.ts', 'vendor/pkg/index.js']);
    expect(withVendor.files.find(file => file.path === 'vendor/pkg/index.js')?.role).toBe('vendor_file');
  });

  it('supports common glob patterns in custom ignore rules', async () => {
    const projectRoot = await createTempProject('noemaloom-common-glob-inventory-');
    for (const repoPath of [
      'README.md',
      'src/app.ts',
      'src/nested/app.ts',
      'src/app.js',
      'tests/client.test.ts',
      'foo.js',
      'lib/foo.js',
      'dir/direct.ts',
      'dir/nested/keep.ts'
    ]) {
      await writeProjectFile(projectRoot, repoPath, `${repoPath}\n`);
    }
    const config = createDefaultConfig(projectRoot);
    config.fileInventory.ignoreGlobs = ['src/**/*.ts', '*.test.ts', '**/foo.js', 'dir/*'];

    const inventory = await buildFileInventory({ projectRoot, config });

    expect(inventory.files.map(file => file.path)).toEqual(['README.md', 'dir/nested/keep.ts', 'src/app.js']);
    expect(inventory.ignoredPaths).toEqual([
      'dir/direct.ts',
      'foo.js',
      'lib/foo.js',
      'src/app.ts',
      'src/nested/app.ts',
      'tests/client.test.ts'
    ]);
  });

  it('does not hide unexpected lstat failures as symlink ignores', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const projectRoot = await createTempProject('noemaloom-lstat-error-inventory-');
    await execFileAsync('git', ['init'], { cwd: projectRoot });
    await writeProjectFile(projectRoot, 'blocked/file.ts', 'export const blocked = true;\n');
    await execFileAsync('git', ['add', 'blocked/file.ts'], { cwd: projectRoot });
    await chmod(path.join(projectRoot, 'blocked'), 0o000);
    try {
      await expect(buildFileInventory({ projectRoot })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(path.join(projectRoot, 'blocked'), 0o700);
    }
  });

  it('does not follow symlinked files outside the repository', async () => {
    const projectRoot = await createTempProject('noemaloom-symlink-inventory-');
    const outsideRoot = await createTempProject('noemaloom-outside-inventory-');
    await writeProjectFile(outsideRoot, 'secret.ts', 'export const secret = true;\n');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await symlink(path.join(outsideRoot, 'secret.ts'), path.join(projectRoot, 'src', 'external.ts'));

    const inventory = await buildFileInventory({ projectRoot });

    expect(inventory.files).toEqual([]);
    expect(inventory.ignoredPaths).toEqual(['src/external.ts']);
  });
});
