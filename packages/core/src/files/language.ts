import path from 'node:path';

const EXTENSION_LANGUAGES = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.cpp', 'cpp'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
  ['.swift', 'swift'],
  ['.kt', 'kotlin'],
  ['.scala', 'scala'],
  ['.lua', 'lua'],
  ['.vue', 'vue'],
  ['.svelte', 'svelte'],
  ['.md', 'markdown'],
  ['.mdx', 'mdx'],
  ['.rst', 'rst'],
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.toml', 'toml']
]);

export function languageForPath(repoPath: string): string {
  const basename = path.posix.basename(repoPath);
  if (basename === 'README' || basename === 'CHANGELOG') {
    return 'markdown';
  }

  return EXTENSION_LANGUAGES.get(path.posix.extname(repoPath)) ?? 'unknown';
}
