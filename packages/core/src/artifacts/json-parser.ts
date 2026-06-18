import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SpanKind } from '../spans/enums.js';

export type ArtifactSpan = {
  kind: Extract<SpanKind, `config.${string}`>;
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  text: string;
  metadata: Record<string, unknown>;
};

export type ArtifactParseResult = {
  path: string;
  spans: ArtifactSpan[];
  warnings: string[];
};

export type ArtifactParseInput = {
  path: string;
  text: string;
};

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizedValueHash(value: unknown): string {
  return sha1(stableStringify(value));
}

function lineForNeedle(lines: string[], needle: string): number {
  const index = lines.findIndex(line => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

export function createArtifactSpan(input: {
  kind: ArtifactSpan['kind'];
  path: string;
  label: string;
  startLine: number;
  endLine?: number;
  text: string;
  metadata?: Record<string, unknown>;
}): ArtifactSpan {
  return {
    kind: input.kind,
    path: input.path,
    label: input.label,
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
    text: input.text,
    metadata: input.metadata ?? {}
  };
}

function primitiveMentions(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return { envVar: value };
  }
  if (/^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    return { cliFlag: value };
  }
  return {};
}

function pointerJoin(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function traverseJson(input: {
  path: string;
  lines: string[];
  spans: ArtifactSpan[];
  value: unknown;
  pointer: string;
  key?: string;
  arrayItem?: boolean;
}): void {
  const line = input.arrayItem
    ? lineForNeedle(input.lines, JSON.stringify(input.value))
    : input.key
      ? lineForNeedle(input.lines, JSON.stringify(input.key))
      : 1;
  if (input.arrayItem) {
    input.spans.push(
      createArtifactSpan({
        kind: 'config.array_item',
        path: input.path,
        label: typeof input.value === 'string' ? input.value : (input.key ?? 'item'),
        startLine: line,
        text: input.lines[line - 1] ?? '',
        metadata: {
          pointer: input.pointer,
          normalizedValueHash: normalizedValueHash(input.value),
          ...primitiveMentions(input.value)
        }
      })
    );
  } else if (input.key) {
    const schemaFieldName = input.pointer.match(/^\/properties\/([^/]+)$/)?.[1];
    input.spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: input.key,
        startLine: line,
        text: input.lines[line - 1] ?? '',
        metadata: {
          pointer: input.pointer,
          configKey: input.key,
          normalizedValueHash: normalizedValueHash(input.value),
          ...(schemaFieldName ? { schemaFieldName } : {})
        }
      })
    );
  }

  if (Array.isArray(input.value)) {
    input.value.forEach((child, index) => {
      traverseJson({
        ...input,
        value: child,
        pointer: pointerJoin(input.pointer, String(index)),
        key: String(index),
        arrayItem: true
      });
    });
    return;
  }

  if (input.value && typeof input.value === 'object') {
    for (const [key, child] of Object.entries(input.value)) {
      traverseJson({
        ...input,
        value: child,
        pointer: pointerJoin(input.pointer, key),
        key,
        arrayItem: false
      });
    }
    return;
  }

  const mentions = primitiveMentions(input.value);
  if (!input.arrayItem && Object.keys(mentions).length > 0) {
    input.spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: String(input.value),
        startLine: line,
        text: input.lines[line - 1] ?? '',
        metadata: {
          pointer: input.pointer,
          ...mentions
        }
      })
    );
  }
}

export function parseJsonArtifact(input: ArtifactParseInput): ArtifactParseResult {
  const lines = input.text.split(/\r?\n/);
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

  try {
    const value = JSON.parse(input.text) as unknown;
    traverseJson({
      path: input.path,
      lines,
      spans,
      value,
      pointer: ''
    });
    return {
      path: input.path,
      spans,
      warnings: []
    };
  } catch (error) {
    return {
      path: input.path,
      spans: [],
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
}
