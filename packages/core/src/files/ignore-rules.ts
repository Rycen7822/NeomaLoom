export type IgnoreMatcher = {
  ignores: (repoPath: string) => boolean;
  patterns: string[];
};

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = normalizeRepoPath(pattern).replace(/(?:\/\*\*){2,}/g, '/**');
  return normalized.replace(/^(?:\*\*\/){2,}/, '**/');
}

function escapeRegex(char: string): string {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegex(pattern: string): RegExp {
  const normalizedPattern = normalizeGlobPattern(pattern);
  let source = normalizedPattern.includes('/') ? '^' : '^(?:.*/)?';
  for (let index = 0; index < normalizedPattern.length;) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];
    if (char === '*') {
      if (next === '*') {
        index += 2;
        if (normalizedPattern[index] === '/') {
          source += '(?:.*/)?';
          index += 1;
        } else {
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '/') {
      source += '/';
      index += 1;
      continue;
    }
    source += escapeRegex(char);
    index += 1;
  }
  return new RegExp(`${source}$`);
}

export function createIgnoreMatcher(patterns: string[], options: { includeVendor?: boolean } = {}): IgnoreMatcher {
  const effectivePatterns = [...patterns, '.noemaloom/**'].map(normalizeGlobPattern).filter(
    pattern => !(options.includeVendor && pattern === 'vendor/**')
  );
  const compiledPatterns = effectivePatterns.map(pattern => globToRegex(pattern));

  return {
    patterns: effectivePatterns,
    ignores(repoPath: string): boolean {
      const normalizedPath = normalizeRepoPath(repoPath);
      return compiledPatterns.some(pattern => pattern.test(normalizedPath));
    }
  };
}
