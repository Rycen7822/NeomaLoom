import path from 'node:path';

export function toPosixRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function trimRepoPathBoundarySlashes(repoPath: string): string {
  return toPosixRepoPath(repoPath).replace(/\/+$/, '');
}

export function collapseRepoPathSlashes(repoPath: string): string {
  return toPosixRepoPath(repoPath).replace(/\/+/g, '/');
}

export function relativeRepoPath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}
