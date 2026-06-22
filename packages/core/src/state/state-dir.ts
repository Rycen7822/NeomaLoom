import { mkdirInsideStateDir, writeFileInsideStateDir } from '../safety/path-guard.js';
import { type NoemaLoomPaths, resolveNoemaLoomPaths } from './paths.js';

export const STATE_GITIGNORE_CONTENT = '*\n!.gitignore\n';

const ensuredGitignoreRoots = new Set<string>();

export async function ensureStateDir(projectRoot: string): Promise<NoemaLoomPaths> {
  const paths = resolveNoemaLoomPaths(projectRoot);

  for (const directory of [
    paths.stateDir,
    paths.locksDir,
    paths.filesDir,
    paths.spansDir,
    paths.factDir,
    paths.documentsDir,
    paths.planningDir,
    paths.derivedMapDir,
    paths.hotsetDir,
    paths.worksetDir,
    paths.logsDir,
    paths.transientDir
  ]) {
    await mkdirInsideStateDir(paths.projectRoot, directory);
  }

  if (!ensuredGitignoreRoots.has(paths.projectRoot)) {
    await writeFileInsideStateDir(paths.projectRoot, paths.stateGitignoreFile, STATE_GITIGNORE_CONTENT);
    ensuredGitignoreRoots.add(paths.projectRoot);
  }
  return paths;
}
