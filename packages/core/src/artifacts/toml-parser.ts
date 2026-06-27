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

export function parseTomlArtifact(input: ArtifactParseInput): ArtifactParseResult {
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
  let tablePath = '';

  lines.forEach((line, index) => {
    const table = line.trim().match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (table) {
      tablePath = table[1];
      if (spans.length >= maxSpans) {
        spanLimitReached = true;
        return;
      }
      spans.push(
        createArtifactSpan({
          kind: 'config.object',
          path: input.path,
          label: tablePath,
          startLine: index + 1,
          text: line,
          metadata: {
            tomlPath: tablePath
          }
        })
      );
      return;
    }

    const entry = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!entry) {
      return;
    }
    const key = entry[1];
    const value = cleanValue(entry[2]);
    const tomlPath = tablePath ? `${tablePath}.${key}` : key;
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
          tomlPath,
          configKey: key,
          normalizedValueHash: normalizedValueHash(value),
          ...mentionMetadata(value)
        }
      })
    );
  });

  return {
    path: input.path,
    spans,
    warnings: spanLimitReached ? [`Artifact span limit reached (${maxSpans})`] : []
  };
}
