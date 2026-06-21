import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendFileInsideStateDir,
  openExclusiveFileInsideStateDir,
  safeReadFileInsideProject,
  safeStatInsideProject,
  unlinkInsideStateDir,
  writeFileInsideStateDir
} from '../../packages/core/src/safety/path-guard.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-guard-'));
}

describe('state write path guard', () => {
  it('throws before touching disk for writes outside .noemaloom', async () => {
    const projectRoot = await createTempProject();
    const outsidePath = path.join(projectRoot, 'README.md');

    await expect(writeFileInsideStateDir(projectRoot, outsidePath, 'blocked')).rejects.toMatchObject({
      code: 'write_outside_state_dir',
      path: outsidePath
    });
    await expect(access(outsidePath)).rejects.toThrow();
  });

  it('allows guarded writes inside .noemaloom', async () => {
    const projectRoot = await createTempProject();
    const insidePath = path.join(projectRoot, '.noemaloom', 'logs', 'mcp.jsonl');

    await writeFileInsideStateDir(projectRoot, insidePath, 'ok\n');

    await expect(readFile(insidePath, 'utf8')).resolves.toBe('ok\n');
  });

  it('rejects symlinked state path escapes before writing through them', async () => {
    const projectRoot = await createTempProject();
    const outsideTarget = path.join(projectRoot, 'outside-target');
    await mkdir(path.join(projectRoot, '.noemaloom'), { recursive: true });
    await mkdir(outsideTarget);
    await symlink(outsideTarget, path.join(projectRoot, '.noemaloom', 'logs'));

    const escapedPath = path.join(projectRoot, '.noemaloom', 'logs', 'mcp.jsonl');

    await expect(writeFileInsideStateDir(projectRoot, escapedPath, 'blocked\n')).rejects.toMatchObject({
      code: 'write_outside_state_dir',
      path: escapedPath
    });
    await expect(access(path.join(outsideTarget, 'mcp.jsonl'))).rejects.toThrow();
  });

  it('rejects append and exclusive open attempts through final-path symlinks', async () => {
    const projectRoot = await createTempProject();
    const outsidePath = path.join(projectRoot, 'outside-log.jsonl');
    const statePath = path.join(projectRoot, '.noemaloom', 'logs', 'mcp.jsonl');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(outsidePath, 'outside\n', 'utf8');
    await symlink(outsidePath, statePath);

    await expect(appendFileInsideStateDir(projectRoot, statePath, 'blocked\n')).rejects.toBeTruthy();
    await expect(openExclusiveFileInsideStateDir(projectRoot, statePath)).rejects.toBeTruthy();
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('outside\n');
  });

  it('rejects unlink when a state parent directory is a symlink escape', async () => {
    const projectRoot = await createTempProject();
    const outsideTarget = path.join(projectRoot, 'outside-target');
    await mkdir(path.join(projectRoot, '.noemaloom'), { recursive: true });
    await mkdir(outsideTarget);
    await writeFile(path.join(outsideTarget, 'refresh.lock'), 'outside\n', 'utf8');
    await symlink(outsideTarget, path.join(projectRoot, '.noemaloom', 'locks'));

    const escapedPath = path.join(projectRoot, '.noemaloom', 'locks', 'refresh.lock');

    await expect(unlinkInsideStateDir(projectRoot, escapedPath)).rejects.toMatchObject({
      code: 'write_outside_state_dir'
    });
    await expect(readFile(path.join(outsideTarget, 'refresh.lock'), 'utf8')).resolves.toBe('outside\n');
  });
});

describe('project read path guard', () => {
  it('allows reads and stats for normal project-relative files', async () => {
    const projectRoot = await createTempProject();
    const readmePath = path.join(projectRoot, 'README.md');
    await writeFileInsideStateDir(projectRoot, path.join(projectRoot, '.noemaloom', 'logs', 'touch.jsonl'), 'ok\n');
    await mkdir(path.dirname(readmePath), { recursive: true });
    await writeFile(readmePath, '# Demo\n', 'utf8');

    await expect(safeReadFileInsideProject(projectRoot, 'README.md', 'utf8')).resolves.toBe('# Demo\n');
    await expect(safeStatInsideProject(projectRoot, 'README.md')).resolves.toMatchObject({});
  });

  it('rejects traversal and absolute reads outside the project root', async () => {
    const projectRoot = await createTempProject();
    const outsidePath = path.join(path.dirname(projectRoot), 'outside.md');
    await writeFile(outsidePath, 'secret\n', 'utf8');

    await expect(safeReadFileInsideProject(projectRoot, '../outside.md', 'utf8')).rejects.toMatchObject({
      code: 'read_outside_project_root'
    });
    await expect(safeReadFileInsideProject(projectRoot, outsidePath, 'utf8')).rejects.toMatchObject({
      code: 'read_outside_project_root'
    });
  });

  it('rejects symlinked read path escapes', async () => {
    const projectRoot = await createTempProject();
    const outsideTarget = await createTempProject();
    await writeFile(path.join(outsideTarget, 'secret.md'), 'secret\n', 'utf8');
    await mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await symlink(outsideTarget, path.join(projectRoot, 'docs', 'external'));

    await expect(safeReadFileInsideProject(projectRoot, 'docs/external/secret.md', 'utf8')).rejects.toMatchObject({
      code: 'read_outside_project_root'
    });
  });
});
