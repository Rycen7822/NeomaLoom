import { languageForPath } from '../files/language.js';

const CODE_FACT_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'scala',
  'cpp',
  'c',
  'csharp',
  'ruby',
  'php',
  'swift'
]);

export function detectCodeLanguage(repoPath: string): string {
  return languageForPath(repoPath);
}

export function isCodeFactLanguage(language: string): boolean {
  return CODE_FACT_LANGUAGES.has(language);
}
