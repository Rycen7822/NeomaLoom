import { languageForPath } from '../../packages/core/src/files/language.js';

const languageCases: Array<[string, string]> = [
  ['src/app.ts', 'typescript'],
  ['src/component.tsx', 'typescript'],
  ['src/app.js', 'javascript'],
  ['src/component.jsx', 'javascript'],
  ['src/module.mjs', 'javascript'],
  ['src/module.cjs', 'javascript'],
  ['src/app.py', 'python'],
  ['src/app.go', 'go'],
  ['src/app.rs', 'rust'],
  ['src/App.java', 'java'],
  ['src/app.cpp', 'cpp'],
  ['src/app.c', 'c'],
  ['src/app.h', 'c'],
  ['src/app.hpp', 'cpp'],
  ['src/app.cs', 'csharp'],
  ['src/app.rb', 'ruby'],
  ['src/app.php', 'php'],
  ['src/app.swift', 'swift'],
  ['src/app.kt', 'kotlin'],
  ['src/app.scala', 'scala'],
  ['src/app.lua', 'lua'],
  ['src/App.vue', 'vue'],
  ['src/App.svelte', 'svelte'],
  ['docs/api/client.md', 'markdown'],
  ['docs/page.mdx', 'mdx'],
  ['docs/page.rst', 'rst'],
  ['package.json', 'json'],
  ['config/settings.yaml', 'yaml'],
  ['config/settings.yml', 'yaml'],
  ['pyproject.toml', 'toml'],
  ['README', 'markdown'],
  ['CHANGELOG', 'markdown'],
  ['LICENSE', 'unknown']
];

describe('language detection', () => {
  it.each(languageCases)('detects %s as %s', (repoPath, expected) => {
    expect(languageForPath(repoPath)).toBe(expected);
  });
});
