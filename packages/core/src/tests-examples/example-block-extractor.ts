import path from 'node:path';

import { type TestExampleParseInput, type TestExampleParseResult, type TestExampleSpan } from './test-case-extractor.js';

const EXECUTABLE_FENCE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'python', 'py', 'ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript']);

function languageFromPath(filePath: string): string {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (extension === 'tsx') {
    return 'ts';
  }
  if (extension === 'jsx') {
    return 'js';
  }
  return extension;
}

function createSpan(input: {
  kind: TestExampleSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  text: string;
  metadata: Record<string, unknown>;
}): TestExampleSpan {
  return {
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine,
    text: input.text,
    metadata: input.metadata
  };
}

function sourceForMarkdownFence(filePath: string, headingPath: string[]): string {
  if (path.basename(filePath).toLowerCase() === 'readme.md' && headingPath.some(heading => /quickstart/i.test(heading))) {
    return 'readme_quickstart';
  }
  if (/docs\/tutorial/i.test(filePath) || /tutorial/i.test(filePath)) {
    return 'tutorial_markdown';
  }
  return 'markdown_executable';
}

function extractMarkdownFences(input: TestExampleParseInput): TestExampleSpan[] {
  const lines = input.text.split(/\r?\n/);
  const spans: TestExampleSpan[] = [];
  const headingPath: string[] = [];
  let line = 1;

  while (line <= lines.length) {
    const current = lines[line - 1] ?? '';
    const heading = current.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      headingPath.splice(heading[1].length - 1, headingPath.length, heading[2].trim());
      line += 1;
      continue;
    }

    const fence = current.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (!fence) {
      line += 1;
      continue;
    }

    const language = (fence[1] ?? '').toLowerCase();
    const start = line;
    line += 1;
    while (line <= lines.length && !(lines[line - 1] ?? '').startsWith('```')) {
      line += 1;
    }
    const end = Math.min(line, lines.length);
    if (EXECUTABLE_FENCE_LANGUAGES.has(language)) {
      spans.push(
        createSpan({
          kind: 'example.block',
          path: input.path,
          label: language,
          startLine: start,
          endLine: end,
          text: lines.slice(start - 1, end).join('\n'),
          metadata: {
            source: sourceForMarkdownFence(input.path, headingPath),
            language
          }
        })
      );
    }
    line += 1;
  }

  return spans;
}

export function extractExampleBlocks(input: TestExampleParseInput): TestExampleParseResult {
  const spans: TestExampleSpan[] = [];
  const normalizedPath = input.path.split(path.sep).join('/');
  const lines = input.text.split(/\r?\n/);

  if (normalizedPath.startsWith('examples/')) {
    const language = languageFromPath(input.path);
    spans.push(
      createSpan({
        kind: 'example.file',
        path: input.path,
        label: path.basename(input.path),
        startLine: 1,
        endLine: lines.length,
        text: input.text,
        metadata: {
          source: 'examples_path',
          language
        }
      }),
      createSpan({
        kind: 'example.block',
        path: input.path,
        label: path.basename(input.path),
        startLine: 1,
        endLine: lines.length,
        text: input.text,
        metadata: {
          source: 'examples_path',
          language
        }
      })
    );
  } else if (path.extname(input.path).toLowerCase() === '.md') {
    spans.push(...extractMarkdownFences(input));
  }

  return {
    path: input.path,
    spans,
    warnings: []
  };
}
