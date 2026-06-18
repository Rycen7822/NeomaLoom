import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureStateDir } from '../../packages/core/src/state/state-dir.js';
import { resolveNoemaLoomPaths } from '../../packages/core/src/state/paths.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'noemaloom-state-'));
}

describe('NoemaLoom state directory', () => {
  it('creates the fixed .noemaloom directory tree and exact local gitignore', async () => {
    const projectRoot = await createTempProject();
    const paths = resolveNoemaLoomPaths(projectRoot);

    await ensureStateDir(projectRoot);

    for (const directory of [
      paths.stateDir,
      paths.locksDir,
      paths.filesDir,
      paths.spansDir,
      paths.factDir,
      paths.documentsDir,
      paths.planningDir,
      paths.derivedMapDir,
      paths.logsDir,
      paths.transientDir
    ]) {
      await expect(access(directory)).resolves.toBeUndefined();
    }

    await expect(readFile(paths.stateGitignoreFile, 'utf8')).resolves.toBe('*\n!.gitignore\n');
    await expect(access(path.join(projectRoot, '.gitignore'))).rejects.toThrow();
  });
});
