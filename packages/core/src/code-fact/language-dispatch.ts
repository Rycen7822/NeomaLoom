export type CodeFactLanguageFamily = 'javascript_typescript' | 'python' | 'go' | 'rust' | 'java_family' | 'unknown';

export function codeFactLanguageFamily(language: string): CodeFactLanguageFamily {
  if (language === 'typescript' || language === 'javascript') return 'javascript_typescript';
  if (language === 'python') return 'python';
  if (language === 'go') return 'go';
  if (language === 'rust') return 'rust';
  if (['java', 'kotlin', 'scala'].includes(language)) return 'java_family';
  return 'unknown';
}
