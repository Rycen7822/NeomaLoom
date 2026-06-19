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
  maxSpans?: number;
};

const DEFAULT_MAX_ARTIFACT_SPANS = 1000;
export const MAX_ARTIFACT_SPAN_TEXT_BYTES = 8192;
const MAX_ARTIFACT_SPAN_LABEL_BYTES = 1024;
const JSON_VALUE_PREVIEW_BYTES = 1024;

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const suffix = '\n…[truncated]';
  const suffixBytes = byteLength(suffix);
  let used = 0;
  let output = '';
  for (const char of value) {
    const charBytes = byteLength(char);
    if (used + charBytes + suffixBytes > maxBytes) {
      break;
    }
    output += char;
    used += charBytes;
  }
  return `${output}${suffix}`;
}

function boundedText(input: {
  text: string;
  metadata?: Record<string, unknown>;
  maxBytes?: number;
}): { text: string; metadata: Record<string, unknown>; truncated: boolean } {
  const maxBytes = input.maxBytes ?? MAX_ARTIFACT_SPAN_TEXT_BYTES;
  const originalBytes = byteLength(input.text);
  if (originalBytes <= maxBytes) {
    return { text: input.text, metadata: input.metadata ?? {}, truncated: false };
  }
  return {
    text: truncateUtf8(input.text, maxBytes),
    metadata: {
      ...(input.metadata ?? {}),
      truncatedIndexedText: true,
      originalTextBytes: originalBytes,
      originalTextHash: sha1(input.text)
    },
    truncated: true
  };
}

function boundedLabel(label: string): { label: string; metadata: Record<string, unknown> } {
  const originalBytes = byteLength(label);
  if (originalBytes <= MAX_ARTIFACT_SPAN_LABEL_BYTES) {
    return { label, metadata: {} };
  }
  return {
    label: truncateUtf8(label, MAX_ARTIFACT_SPAN_LABEL_BYTES),
    metadata: {
      labelTruncated: true,
      originalLabelBytes: originalBytes,
      originalLabelHash: sha1(label)
    }
  };
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
  const bounded = boundedText({ text: input.text, metadata: input.metadata });
  const label = boundedLabel(input.label);
  return {
    kind: input.kind,
    path: input.path,
    label: label.label,
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
    text: bounded.text,
    metadata: { ...bounded.metadata, ...label.metadata }
  };
}

function jsonSpanText(input: {
  sourceLine: string;
  pointer: string;
  key?: string;
  value: unknown;
}): { text: string; metadata: Record<string, unknown>; truncated: boolean } {
  if (byteLength(input.sourceLine) <= MAX_ARTIFACT_SPAN_TEXT_BYTES) {
    return { text: input.sourceLine, metadata: {}, truncated: false };
  }
  const previewSource = typeof input.value === 'string' ? input.value : stableStringify(input.value);
  const descriptor = [
    `jsonPointer=${input.pointer || '/'}`,
    ...(input.key ? [`key=${input.key}`] : []),
    `valueHash=${normalizedValueHash(input.value)}`,
    `valuePreview=${truncateUtf8(previewSource, JSON_VALUE_PREVIEW_BYTES)}`
  ].join('\n');
  return {
    text: truncateUtf8(descriptor, MAX_ARTIFACT_SPAN_TEXT_BYTES),
    metadata: {
      truncatedIndexedText: true,
      sourceLineBytes: byteLength(input.sourceLine),
      sourceLineHash: sha1(input.sourceLine)
    },
    truncated: true
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
  maxSpans: number;
  truncated: { value: boolean };
  indexedTextTruncated: { value: boolean };
}): void {
  if (input.spans.length >= input.maxSpans) {
    input.truncated.value = true;
    return;
  }
  const line = input.arrayItem
    ? lineForNeedle(input.lines, JSON.stringify(input.value))
    : input.key
      ? lineForNeedle(input.lines, JSON.stringify(input.key))
      : 1;
  if (input.arrayItem) {
    if (input.spans.length < input.maxSpans) {
      const sourceLine = input.lines[line - 1] ?? '';
      const spanText = jsonSpanText({ sourceLine, pointer: input.pointer, key: input.key, value: input.value });
      input.indexedTextTruncated.value ||= spanText.truncated;
      input.spans.push(
      createArtifactSpan({
        kind: 'config.array_item',
        path: input.path,
        label: typeof input.value === 'string' ? input.value : (input.key ?? 'item'),
        startLine: line,
        text: spanText.text,
        metadata: {
          pointer: input.pointer,
          normalizedValueHash: normalizedValueHash(input.value),
          ...spanText.metadata,
          ...primitiveMentions(input.value)
        }
      })
      );
    } else {
      input.truncated.value = true;
    }
  } else if (input.key) {
    const schemaFieldName = input.pointer.match(/^\/properties\/([^/]+)$/)?.[1];
    if (input.spans.length < input.maxSpans) {
      const sourceLine = input.lines[line - 1] ?? '';
      const spanText = jsonSpanText({ sourceLine, pointer: input.pointer, key: input.key, value: input.value });
      input.indexedTextTruncated.value ||= spanText.truncated;
      input.spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: input.key,
        startLine: line,
        text: spanText.text,
        metadata: {
          pointer: input.pointer,
          configKey: input.key,
          normalizedValueHash: normalizedValueHash(input.value),
          ...spanText.metadata,
          ...(schemaFieldName ? { schemaFieldName } : {})
        }
      })
      );
    } else {
      input.truncated.value = true;
    }
  }

  if (input.spans.length >= input.maxSpans) {
    input.truncated.value = true;
    return;
  }

  if (Array.isArray(input.value)) {
    for (const [index, child] of input.value.entries()) {
      traverseJson({
        ...input,
        value: child,
        pointer: pointerJoin(input.pointer, String(index)),
        key: String(index),
        arrayItem: true
      });
      if (input.truncated.value) break;
    }
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
      if (input.truncated.value) break;
    }
    return;
  }

  const mentions = primitiveMentions(input.value);
  if (!input.arrayItem && Object.keys(mentions).length > 0) {
    if (input.spans.length < input.maxSpans) {
      const sourceLine = input.lines[line - 1] ?? '';
      const spanText = jsonSpanText({ sourceLine, pointer: input.pointer, value: input.value });
      input.indexedTextTruncated.value ||= spanText.truncated;
      input.spans.push(
      createArtifactSpan({
        kind: 'config.entry',
        path: input.path,
        label: String(input.value),
        startLine: line,
        text: spanText.text,
        metadata: {
          pointer: input.pointer,
          ...spanText.metadata,
          ...mentions
        }
      })
      );
    } else {
      input.truncated.value = true;
    }
  }
}

export function parseJsonArtifact(input: ArtifactParseInput): ArtifactParseResult {
  const lines = input.text.split(/\r?\n/);
  const maxSpans = input.maxSpans ?? DEFAULT_MAX_ARTIFACT_SPANS;
  const truncated = { value: false };
  const indexedTextTruncated = { value: false };
  const fileText = boundedText({
    text: input.text,
    metadata: byteLength(input.text) > MAX_ARTIFACT_SPAN_TEXT_BYTES
      ? { fullTextBytes: byteLength(input.text), fullTextHash: sha1(input.text), truncatedIndexedText: true }
      : {}
  });
  indexedTextTruncated.value ||= fileText.truncated;
  const spans: ArtifactSpan[] = [
    createArtifactSpan({
      kind: 'config.file',
      path: input.path,
      label: path.basename(input.path),
      startLine: 1,
      endLine: lines.length,
      text: fileText.text,
      metadata: fileText.metadata
    })
  ];

  try {
    const value = JSON.parse(input.text) as unknown;
    traverseJson({
      path: input.path,
      lines,
      spans,
      value,
      pointer: '',
      maxSpans,
      truncated,
      indexedTextTruncated
    });
    const warnings = [
      ...(truncated.value ? [`Artifact span limit reached (${maxSpans}); remaining JSON entries omitted.`] : []),
      ...(indexedTextTruncated.value ? ['Artifact indexed text truncated to avoid duplicating large source lines.'] : [])
    ];
    return {
      path: input.path,
      spans,
      warnings
    };
  } catch (error) {
    return {
      path: input.path,
      spans: [],
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
}
