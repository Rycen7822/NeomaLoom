import path from 'node:path';

import type { SpanKind } from '../spans/enums.js';

export type TestExampleSpan = {
  kind: Extract<SpanKind, `test.${string}` | `example.${string}`>;
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  text: string;
  metadata: Record<string, unknown>;
};

export type TestExampleParseInput = {
  path: string;
  text: string;
};

export type TestExampleParseResult = {
  path: string;
  spans: TestExampleSpan[];
  warnings: string[];
};

function createSpan(input: {
  kind: TestExampleSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  text: string;
  metadata?: Record<string, unknown>;
}): TestExampleSpan {
  return {
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.startLine,
    text: input.text,
    metadata: input.metadata ?? {}
  };
}

function extractPython(input: TestExampleParseInput, lines: string[]): { spans: TestExampleSpan[]; warnings: string[] } {
  const spans: TestExampleSpan[] = [];
  const warnings: string[] = [];
  let pendingMarkers: string[] = [];

  lines.forEach((line, index) => {
    const marker = line.match(/@pytest\.mark\.([A-Za-z_][A-Za-z0-9_]*)/);
    if (marker) {
      pendingMarkers.push(marker[1]);
      return;
    }

    const functionMatch = line.match(/^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/);
    if (functionMatch) {
      spans.push(
        createSpan({
          kind: 'test.case',
          path: input.path,
          label: functionMatch[1],
          startLine: index + 1,
          text: line,
          metadata: pendingMarkers.length > 0 ? { markers: pendingMarkers } : {}
        })
      );
      pendingMarkers = [];
      return;
    }

    const classMatch = line.match(/^class\s+(Test[A-Za-z0-9_]*)\s*[:(]/);
    if (classMatch) {
      spans.push(
        createSpan({
          kind: 'test.case',
          path: input.path,
          label: classMatch[1],
          startLine: index + 1,
          text: line
        })
      );
    }
  });

  if (pendingMarkers.length > 0) {
    warnings.push(...pendingMarkers.map(marker => `dangling pytest marker ${marker}`));
  }

  return { spans, warnings };
}

function extractJsTs(input: TestExampleParseInput, lines: string[]): TestExampleSpan[] {
  return lines.flatMap((line, index) => {
    const match = line.match(/\b(describe|it|test)\(\s*['"`]([^'"`]+)['"`]/);
    if (!match) {
      return [];
    }
    return [
      createSpan({
        kind: 'test.case',
        path: input.path,
        label: match[2],
        startLine: index + 1,
        text: line,
        metadata: {
          framework: match[1]
        }
      })
    ];
  });
}

function extractGo(input: TestExampleParseInput, lines: string[]): TestExampleSpan[] {
  return lines.flatMap((line, index) => {
    const match = line.match(/^func\s+((?:Test|Benchmark)[A-Za-z0-9_]*)\s*\(/);
    return match
      ? [
          createSpan({
            kind: 'test.case',
            path: input.path,
            label: match[1],
            startLine: index + 1,
            text: line
          })
        ]
      : [];
  });
}

function extractRust(input: TestExampleParseInput, lines: string[]): TestExampleSpan[] {
  const spans: TestExampleSpan[] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== '#[test]') {
      return;
    }
    const next = lines[index + 1] ?? '';
    const match = next.match(/fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (match) {
      spans.push(
        createSpan({
          kind: 'test.case',
          path: input.path,
          label: match[1],
          startLine: index + 2,
          text: next
        })
      );
    }
  });
  return spans;
}

function extractJavaFamily(input: TestExampleParseInput, lines: string[]): TestExampleSpan[] {
  const spans: TestExampleSpan[] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== '@Test') {
      return;
    }
    const next = lines[index + 1] ?? '';
    const match = next.match(/(?:fun|void|[A-Za-z0-9_<>,.?]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (match) {
      spans.push(
        createSpan({
          kind: 'test.case',
          path: input.path,
          label: match[1],
          startLine: index + 2,
          text: next
        })
      );
    }
  });
  return spans;
}

export function extractTestCases(input: TestExampleParseInput): TestExampleParseResult {
  const extension = path.extname(input.path).toLowerCase();
  const lines = input.text.split(/\r?\n/);
  let spans: TestExampleSpan[] = [];
  let warnings: string[] = [];

  if (extension === '.py') {
    const extracted = extractPython(input, lines);
    spans = extracted.spans;
    warnings = extracted.warnings;
  } else if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) {
    spans = extractJsTs(input, lines);
  } else if (extension === '.go') {
    spans = extractGo(input, lines);
  } else if (extension === '.rs') {
    spans = extractRust(input, lines);
  } else if (['.java', '.kt', '.kts', '.scala'].includes(extension)) {
    spans = extractJavaFamily(input, lines);
  }

  return {
    path: input.path,
    spans,
    warnings
  };
}
