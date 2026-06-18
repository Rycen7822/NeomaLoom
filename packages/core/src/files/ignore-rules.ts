export type IgnoreMatcher = {
  ignores: (repoPath: string) => boolean;
  patterns: string[];
};

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '');
}

function matchesPattern(pattern: string, repoPath: string): boolean {
  const normalizedPattern = normalizeRepoPath(pattern);
  const normalizedPath = normalizeRepoPath(repoPath);

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.startsWith('*.')) {
    return normalizedPath.endsWith(normalizedPattern.slice(1));
  }

  return normalizedPath === normalizedPattern;
}

export function createIgnoreMatcher(patterns: string[], options: { includeVendor?: boolean } = {}): IgnoreMatcher {
  const effectivePatterns = [...patterns, '.noemaloom/**'].filter(
    pattern => !(options.includeVendor && pattern === 'vendor/**')
  );

  return {
    patterns: effectivePatterns,
    ignores(repoPath: string): boolean {
      return effectivePatterns.some(pattern => matchesPattern(pattern, repoPath));
    }
  };
}
