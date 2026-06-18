import { access, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeFileInsideStateDir } from '../../packages/core/src/safety/path-guard.js';

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
});
