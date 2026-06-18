import path from 'node:path';

export type NoemaLoomPaths = {
  projectRoot: string;
  stateDir: string;
  configFile: string;
  stateGitignoreFile: string;
  locksDir: string;
  refreshLockFile: string;
  filesDir: string;
  spansDir: string;
  factDir: string;
  documentsDir: string;
  planningDir: string;
  derivedMapDir: string;
  logsDir: string;
  transientDir: string;
};

export function resolveNoemaLoomPaths(projectRoot: string): NoemaLoomPaths {
  const resolvedRoot = path.resolve(projectRoot);
  const stateDir = path.join(resolvedRoot, '.noemaloom');
  const locksDir = path.join(stateDir, 'locks');

  return {
    projectRoot: resolvedRoot,
    stateDir,
    configFile: path.join(stateDir, 'config.json'),
    stateGitignoreFile: path.join(stateDir, '.gitignore'),
    locksDir,
    refreshLockFile: path.join(locksDir, 'refresh.lock'),
    filesDir: path.join(stateDir, 'files'),
    spansDir: path.join(stateDir, 'spans'),
    factDir: path.join(stateDir, 'fact'),
    documentsDir: path.join(stateDir, 'documents'),
    planningDir: path.join(stateDir, 'planning'),
    derivedMapDir: path.join(stateDir, 'derived-map'),
    logsDir: path.join(stateDir, 'logs'),
    transientDir: path.join(stateDir, 'transient')
  };
}
