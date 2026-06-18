import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createDefaultConfig } from '../../packages/core/src/config/default-config.js';
import { buildFileInventory } from '../../packages/core/src/files/file-inventory.js';
import { languageForPath } from '../../packages/core/src/files/language.js';
import { classifyFileRole } from '../../packages/core/src/files/role-classifier.js';

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

  it('walks non-git repositories and classifies roles and languages deterministically', async () => {
    const projectRoot = await createTempProject('noemaloom-walk-inventory-');
    for (const repoPath of [
      'CHANGELOG.md',
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
    expect(byPath.get('docs/api/client.md')?.role).toBe('canonical_api_doc');
    expect(byPath.get('docs/tutorial-first/intro.md')?.role).toBe('tutorial_doc');
    expect(byPath.get('examples/basic.ts')?.role).toBe('example_doc');
    expect(byPath.get('paper/notes.md')?.role).toBe('paper_doc');
    expect(byPath.get('notes/run.md')?.role).toBe('experiment_note_doc');
    expect(byPath.get('design/arch.md')?.role).toBe('design_doc');
    expect(byPath.get('src/app.ts')?.role).toBe('source_file');
    expect(byPath.get('tests/app.test.ts')?.role).toBe('test_file');
    expect(byPath.get('fixtures/sample.json')?.role).toBe('fixture_file');
    expect(byPath.get('config/settings.yaml')?.role).toBe('config_file');
    expect(byPath.get('schema/settings.schema.json')?.role).toBe('schema_file');
    expect(byPath.get('package.json')?.role).toBe('package_metadata');
    expect(byPath.get('features/plan.md')?.role).toBe('feature_plan');
    expect(languageForPath('src/app.ts')).toBe('typescript');
    expect(languageForPath('docs/api/client.md')).toBe('markdown');
    expect(classifyFileRole('vendor/pkg/index.js')).toBe('vendor_file');
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

  it('applies ignore globs and excludes vendor unless explicitly requested', async () => {
    const projectRoot = await createTempProject('noemaloom-ignore-inventory-');
    for (const repoPath of [
      '.noemaloom/cache.json',
      'node_modules/pkg/index.js',
      'dist/app.js',
      'build/app.js',
      '.venv/bin/python',
      'coverage/summary.json',
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
      'vendor/pkg/index.js'
    ]);

    const withVendor = await buildFileInventory({ projectRoot, includeVendor: true });
    expect(withVendor.files.map(file => file.path)).toEqual(['src/app.ts', 'vendor/pkg/index.js']);
    expect(withVendor.files.find(file => file.path === 'vendor/pkg/index.js')?.role).toBe('vendor_file');
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
