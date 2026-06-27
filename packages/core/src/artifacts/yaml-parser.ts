import path from 'node:path';

import { createArtifactSpan, normalizedValueHash, type ArtifactParseInput, type ArtifactParseResult, type ArtifactSpan } from './json-parser.js';

function cleanValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function mentionMetadata(value: string): Record<string, unknown> {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return { envVar: value };
  }
  if (/^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    return { cliFlag: value };
  }
  return {};
}

export function parseYamlArtifact(input: ArtifactParseInput): ArtifactParseResult {
  const lines = input.text.split(/\r?\n/);
  const maxSpans = Math.max(1, input.maxSpans ?? Number.POSITIVE_INFINITY);
  let spanLimitReached = false;
  const spans: ArtifactSpan[] = [
    createArtifactSpan({
      kind: 'config.file',
      path: input.path,
      label: path.basename(input.path),
      startLine: 1,
      endLine: lines.length,
      text: input.text
    })
  ];
  const stack: Array<{ indent: number; key: string }> = [];

  lines.forEach((line, index) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) {
      return;
    }
    const indent = match[1].length;
    const key = match[2];
    const value = cleanValue(match[3] ?? '');
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const yamlPath = [...stack.map(item => item.key), key].join('.');
    if (spans.length >= maxSpans) {
      spanLimitReached = true;
      return;
    }
    spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: key,
        startLine: index + 1,
        text: line,
        metadata: {
          yamlPath,
          configKey: key,
          normalizedValueHash: normalizedValueHash(value),
          ...mentionMetadata(value)
        }
      })
    );
    stack.push({ indent, key });
  });

  return {
    path: input.path,
    spans,
    warnings: spanLimitReached ? [`Artifact span limit reached (${maxSpans})`] : []
  };
}
