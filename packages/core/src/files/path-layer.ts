export type PathLayer =
  | 'business'
  | 'derived_state'
  | 'tooling_agent'
  | 'artifact'
  | 'backup'
  | 'archive'
  | 'repair_worktree'
  | 'generated'
  | 'vendor';

function normalize(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

function segments(repoPath: string): string[] {
  return normalize(repoPath).split('/').filter(Boolean).map(segment => segment.toLowerCase());
}

function hasSegment(repoPath: string, names: string[]): boolean {
  const parts = segments(repoPath);
  return parts.some(part => names.includes(part));
}

function hasSegmentMatching(repoPath: string, pattern: RegExp): boolean {
  return segments(repoPath).some(part => pattern.test(part));
}

export function classifyPathLayer(repoPath: string): PathLayer {
  const normalized = normalize(repoPath).toLowerCase();
  if (normalized === '.noemaloom' || normalized.startsWith('.noemaloom/')) return 'derived_state';
  if (hasSegment(repoPath, ['.agents', '.codex', '.claude', '.cursor', '.roo'])) return 'tooling_agent';
  if (hasSegment(repoPath, ['vendor']) || normalized.includes('/resources/code/') || normalized.startsWith('resources/code/')) return 'vendor';
  if (
    hasSegment(repoPath, ['dist', 'build', 'coverage', '__pycache__']) ||
    /\.(?:pyc|pyo|min\.js|map)$/i.test(normalized)
  ) {
    return 'generated';
  }
  if (
    hasSegment(repoPath, ['.pytest_cache', 'artifacts', 'artifact', 'runs', 'outputs', 'output', 'checkpoints', 'checkpoint', 'wandb', 'mlruns', 'logs']) ||
    hasSegment(repoPath, ['token_efficiency_benchmark'])
  ) {
    return 'artifact';
  }
  if (hasSegment(repoPath, ['hermes-plugin-backups', 'backups', 'backup']) || hasSegmentMatching(repoPath, /(?:^|[-_.])backup(?:[-_.]|$)/)) {
    return 'backup';
  }
  if (
    hasSegment(repoPath, ['archive', 'archives', 'archived', 'deprecated']) ||
    hasSegmentMatching(repoPath, /(?:^|[-_.])(?:archive|archives|archived|deprecated)(?:[-_.]|$)/)
  ) return 'archive';
  if (
    hasSegment(repoPath, ['repair', 'repairs', 'repair-worktree', 'repair_worktree', 'fixback']) ||
    hasSegmentMatching(repoPath, /(?:^|[-_.])(?:repair|repairs|repair[-_]worktree|fixback)(?:[-_.]|$)/)
  ) return 'repair_worktree';
  return 'business';
}

export function isBusinessPathLayer(layer: PathLayer): boolean {
  return layer === 'business';
}

export function isDefaultBusinessPath(repoPath: string): boolean {
  return isBusinessPathLayer(classifyPathLayer(repoPath));
}

export function isNoisePathLayer(layer: PathLayer): boolean {
  return layer !== 'business';
}
