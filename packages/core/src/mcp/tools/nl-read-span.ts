import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

import { indexDocumentSpans } from '../../documents/document-span-indexer.js';
import { safeReadFileInsideProject } from '../../safety/path-guard.js';
import { redactText } from '../../safety/redaction.js';
import { relocateSpan, type RelocatableSpan } from '../../spans/relocation.js';
import type { SpanKind } from '../../spans/enums.js';
import { readLatestRevision } from '../../state/refresh-revision.js';
import { createEnvelope, resolveProjectRootFromInput, type NoemaLoomEnvelope } from '../envelope.js';

type Statement = {
  get: (...params: unknown[]) => unknown;
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

type SpanRow = {
  span_id: string;
  path: string;
  kind: string;
  role: string;
  label: string;
  start_line: number;
  end_line: number;
  heading_path_json: string;
  anchor: string | null;
  stable_locator_json: string;
  text_hash: string;
  indexed_text: string;
  metadata_json: string;
  file_content_hash: string | null;
};

const require = createRequire(import.meta.url);
const TRUNCATION_SUFFIX = '\n…[truncated]';
const MAX_RELOCATION_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_RELOCATION_SCAN_LINES = 500_000;
const MAX_RELOCATION_CANDIDATES = 20_000;

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

export const nlReadSpanInputSchema = z
  .object({
    projectPath: z.string().optional(),
    spanId: z.string().min(1),
    contextLines: z.number().int().min(0).max(80).default(20),
    maxLines: z.number().int().positive().max(500).default(160),
    focusStartLine: z.number().int().positive().optional(),
    focusEndLine: z.number().int().positive().optional(),
    focusLine: z.number().int().positive().optional()
  })
  .passthrough();

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type SpanRowReadResult =
  | { status: 'ready'; row?: SpanRow }
  | { status: 'missing_index' }
  | { status: 'unreadable'; message: string };

function readSpanRow(projectRoot: string, spanId: string): SpanRowReadResult {
  const dbPath = path.join(projectRoot, '.noemaloom', 'spans', 'spans.db');
  if (!existsSync(dbPath)) {
    return { status: 'missing_index' };
  }

  let db: Database | undefined;
  try {
    db = openDatabase(dbPath);
    return {
      status: 'ready',
      row: db
        .prepare(
          `SELECT s.span_id, s.path, s.kind, s.role, s.label, s.start_line, s.end_line,
                  s.heading_path_json, s.anchor, s.stable_locator_json, s.text_hash, s.indexed_text,
                  s.metadata_json, f.content_hash AS file_content_hash
           FROM repo_spans s
           LEFT JOIN repo_files f ON f.path = s.path
           WHERE s.span_id = ?`
        )
        .get(spanId) as SpanRow | undefined
    };
  } catch (error) {
    return { status: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function lineCount(text: string): number {
  return Math.max(1, text.split(/\r?\n/).length);
}

function sliceLines(text: string, startLine: number, endLine: number): string {
  return text
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join('\n');
}

function segmentRanges(startLine: number, endLine: number, maxLines: number): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  for (let line = startLine; line <= endLine; line += maxLines) {
    ranges.push({ startLine: line, endLine: Math.min(endLine, line + maxLines - 1) });
  }
  return ranges;
}

function choosePreviewRange(input: {
  ranges: Array<{ startLine: number; endLine: number }>;
  fallback: { startLine: number; endLine: number };
  focusStartLine?: number;
  focusEndLine?: number;
  focusLine?: number;
}): { startLine: number; endLine: number } {
  if (input.ranges.length === 0) return input.fallback;
  const focusStart = input.focusStartLine ?? input.focusLine;
  const focusEnd = input.focusEndLine ?? input.focusLine ?? focusStart;
  if (!focusStart || !focusEnd) return input.ranges[0];
  const focusMid = (focusStart + focusEnd) / 2;
  return [...input.ranges].sort((left, right) => {
    const leftMid = (left.startLine + left.endLine) / 2;
    const rightMid = (right.startLine + right.endLine) / 2;
    return Math.abs(leftMid - focusMid) - Math.abs(rightMid - focusMid) || left.startLine - right.startLine;
  })[0];
}

function redactedContentPayload(content: string): { content: string; redaction?: { hasSensitiveContent: boolean; redactedKinds: string[] } } {
  const redaction = redactText(content);
  return {
    content: redaction.redactedText,
    ...(redaction.hasSensitiveContent
      ? { redaction: { hasSensitiveContent: true, redactedKinds: redaction.redactedKinds } }
      : {})
  };
}

function boundedReadRange(input: {
  totalLines: number;
  spanStartLine: number;
  spanEndLine: number;
  contextLines: number;
  maxLines: number;
}): { startLine: number; endLine: number } {
  const spanLineCount = input.spanEndLine - input.spanStartLine + 1;
  if (spanLineCount >= input.maxLines) {
    return { startLine: input.spanStartLine, endLine: Math.min(input.spanEndLine, input.spanStartLine + input.maxLines - 1) };
  }

  const availableContext = input.maxLines - spanLineCount;
  let before = Math.min(input.contextLines, input.spanStartLine - 1, Math.floor(availableContext / 2));
  let after = Math.min(input.contextLines, input.totalLines - input.spanEndLine, availableContext - before);
  before = Math.min(input.contextLines, input.spanStartLine - 1, availableContext - after);

  return {
    startLine: input.spanStartLine - before,
    endLine: input.spanEndLine + after
  };
}

function indexedTextForRelocation(row: SpanRow): string {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  if (metadata.indexedTextTruncatedAtWrite === true && row.indexed_text.endsWith(TRUNCATION_SUFFIX)) {
    return row.indexed_text.slice(0, -TRUNCATION_SUFFIX.length);
  }
  return row.indexed_text;
}

function fingerprintLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trimEnd());
}

function hashLines(lines: string[]): string {
  return sha1(lines.join('\n'));
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function lineFingerprintLineRange(row: SpanRow, currentText: string): { startLine: number; endLine: number; text: string; method: string } | undefined {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  if (metadata.indexedTextTruncatedAtWrite !== true) {
    return undefined;
  }
  const spanLineCount = metadataNumber(metadata, 'relocationLineCount') ?? Math.max(1, row.end_line - row.start_line + 1);
  const fingerprintLineCount = Math.min(
    metadataNumber(metadata, 'relocationFingerprintLineCount') ?? 8,
    spanLineCount
  );
  const prefixHash = metadataString(metadata, 'relocationPrefixHash');
  const suffixHash = metadataString(metadata, 'relocationSuffixHash');
  const firstLineHash = metadataString(metadata, 'relocationFirstLineHash');
  const lastLineHash = metadataString(metadata, 'relocationLastLineHash');
  if (!prefixHash && !suffixHash && !firstLineHash && !lastLineHash) {
    return undefined;
  }

  if (currentText.length > MAX_RELOCATION_SCAN_BYTES) {
    return undefined;
  }
  const lines = fingerprintLines(currentText);
  if (spanLineCount > lines.length || lines.length > MAX_RELOCATION_SCAN_LINES) {
    return undefined;
  }

  const candidates: Array<{ startLine: number; score: number; distance: number }> = [];
  const maxStartIndex = Math.min(lines.length - spanLineCount, MAX_RELOCATION_CANDIDATES - 1);
  for (let startIndex = 0; startIndex <= maxStartIndex; startIndex += 1) {
    const suffixStartIndex = startIndex + spanLineCount - fingerprintLineCount;
    let score = 0;
    if (prefixHash && hashLines(lines.slice(startIndex, startIndex + fingerprintLineCount)) === prefixHash) score += 4;
    if (suffixHash && hashLines(lines.slice(suffixStartIndex, suffixStartIndex + fingerprintLineCount)) === suffixHash) score += 4;
    if (firstLineHash && hashLines(lines.slice(startIndex, startIndex + 1)) === firstLineHash) score += 1;
    if (lastLineHash && hashLines(lines.slice(startIndex + spanLineCount - 1, startIndex + spanLineCount)) === lastLineHash) score += 1;
    if (score >= 4) {
      const startLine = startIndex + 1;
      if (score >= 8) {
        const endLine = Math.min(lines.length, startLine + spanLineCount - 1);
        return {
          startLine,
          endLine,
          text: sliceLines(currentText, startLine, endLine),
          method: 'line_fingerprint_search'
        };
      }
      candidates.push({ startLine, score, distance: Math.abs(startLine - row.start_line) });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const best = candidates.sort((left, right) => right.score - left.score || left.distance - right.distance || left.startLine - right.startLine)[0];
  const endLine = Math.min(lines.length, best.startLine + spanLineCount - 1);
  return {
    startLine: best.startLine,
    endLine,
    text: sliceLines(currentText, best.startLine, endLine),
    method: 'line_fingerprint_search'
  };
}

function previousRelocatable(row: SpanRow): RelocatableSpan {
  const headingPath = parseJson<string[]>(row.heading_path_json, []);
  const stableLocator = parseJson<{ blockOrdinal?: number; nearbyHeadingHash?: string }>(row.stable_locator_json, {});
  return {
    spanId: row.span_id,
    path: row.path,
    kind: row.kind as SpanKind,
    textHash: row.text_hash,
    anchor: row.anchor ?? undefined,
    headingPath,
    blockOrdinal: stableLocator.blockOrdinal ?? 0,
    normalizedText: indexedTextForRelocation(row),
    nearbyHeadingHash: stableLocator.nearbyHeadingHash ?? sha1(JSON.stringify(headingPath))
  };
}

async function documentRelocationCandidates(input: {
  path: string;
  text: string;
}): Promise<{
  relocatables: RelocatableSpan[];
  linesBySpanId: Map<string, { startLine: number; endLine: number; text: string }>;
}> {
  const parsed = await indexDocumentSpans({ path: input.path, text: input.text });
  const linesBySpanId = new Map<string, { startLine: number; endLine: number; text: string }>();
  const relocatables = parsed.spans.map((span, index) => {
    const spanId = `current:${input.path}:${index}:${sha1(span.text)}`;
    linesBySpanId.set(spanId, { startLine: span.startLine, endLine: span.endLine, text: span.text });
    return {
      spanId,
      path: input.path,
      kind: span.kind,
      textHash: sha1(span.text),
      anchor: span.anchor,
      headingPath: span.headingPath,
      blockOrdinal: index,
      normalizedText: span.text,
      nearbyHeadingHash: sha1(JSON.stringify(span.headingPath))
    };
  });
  return { relocatables, linesBySpanId };
}

function exactTextLineRange(currentText: string, indexedText: string): { startLine: number; endLine: number; text: string } | undefined {
  const index = currentText.indexOf(indexedText);
  if (index < 0) {
    return undefined;
  }
  const before = currentText.slice(0, index);
  const startLine = lineCount(before);
  return {
    startLine,
    endLine: startLine + indexedText.split(/\r?\n/).length - 1,
    text: indexedText
  };
}

function textSearchLineRange(row: SpanRow, currentText: string): { startLine: number; endLine: number; text: string; method: string } | undefined {
  const exact = exactTextLineRange(currentText, row.indexed_text);
  if (exact) {
    return { ...exact, method: 'text_search' };
  }

  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  if (metadata.indexedTextTruncatedAtWrite !== true || !row.indexed_text.endsWith(TRUNCATION_SUFFIX)) {
    return undefined;
  }
  const prefix = row.indexed_text.slice(0, -TRUNCATION_SUFFIX.length);
  if (!prefix) {
    return lineFingerprintLineRange(row, currentText);
  }
  const index = currentText.indexOf(prefix);
  if (index < 0) {
    return lineFingerprintLineRange(row, currentText);
  }
  const before = currentText.slice(0, index);
  const startLine = lineCount(before);
  const spanLineCount = Math.max(1, row.end_line - row.start_line + 1);
  const endLine = Math.min(lineCount(currentText), startLine + spanLineCount - 1);
  return {
    startLine,
    endLine,
    text: sliceLines(currentText, startLine, endLine),
    method: 'truncated_prefix_search'
  };
}

async function relocateIfNeeded(input: {
  row: SpanRow;
  currentText: string;
}): Promise<{
  startLine: number;
  endLine: number;
  spanText: string;
  relocation: { used: boolean; method: string };
}> {
  if (input.row.file_content_hash && sha1(input.currentText) === input.row.file_content_hash) {
    return {
      startLine: input.row.start_line,
      endLine: input.row.end_line,
      spanText: sliceLines(input.currentText, input.row.start_line, input.row.end_line),
      relocation: { used: false, method: 'none' }
    };
  }

  if (input.row.kind.startsWith('doc.')) {
    const current = await documentRelocationCandidates({ path: input.row.path, text: input.currentText });
    const result = relocateSpan(previousRelocatable(input.row), current.relocatables);
    if (result.ok) {
      const lines = current.linesBySpanId.get(result.spanId);
      if (lines) {
        return {
          startLine: lines.startLine,
          endLine: lines.endLine,
          spanText: lines.text,
          relocation: { used: true, method: result.method }
        };
      }
    }
  }

  const textSearch = textSearchLineRange(input.row, input.currentText);
  if (textSearch) {
    return {
      startLine: textSearch.startLine,
      endLine: textSearch.endLine,
      spanText: textSearch.text,
      relocation: { used: true, method: textSearch.method }
    };
  }

  throw new Error('span_not_found_after_file_change');
}

export async function handleNlReadSpan(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlReadSpanInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const rowResult = readSpanRow(projectRoot, parsed.spanId);

  if (rowResult.status === 'missing_index') {
    return createEnvelope({
      ok: false,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: 'empty',
      warnings: [
        {
          code: 'span_index_missing',
          severity: 'error',
          message: 'span index is missing; run nl_refresh before reading spans'
        }
      ],
      data: { status: 'span_index_missing' },
      nextActions: ['call nl_refresh with target="changed" and mode="safe"']
    });
  }

  if (rowResult.status === 'unreadable') {
    return createEnvelope({
      ok: false,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: 'error',
      warnings: [{ code: 'span_index_unreadable', severity: 'error', message: rowResult.message }],
      data: { status: 'span_index_unreadable' },
      nextActions: ['call nl_refresh with target="changed" and mode="safe"']
    });
  }

  const row = rowResult.row;

  if (!row) {
    return createEnvelope({
      ok: false,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: 'empty',
      warnings: [{ code: 'span_not_found', severity: 'error', message: parsed.spanId }],
      data: { status: 'span_not_found' }
    });
  }

  let currentText: string;
  try {
    currentText = await safeReadFileInsideProject(projectRoot, row.path, 'utf8');
  } catch (error) {
    return createEnvelope({
      ok: false,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: 'stale',
      warnings: [
        {
          code: 'unsafe_span_path',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      data: { status: 'unsafe_span_path' }
    });
  }
  let relocated: Awaited<ReturnType<typeof relocateIfNeeded>>;
  try {
    relocated = await relocateIfNeeded({ row, currentText });
  } catch (error) {
    return createEnvelope({
      ok: false,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: 'stale',
      warnings: [
        {
          code: 'span_relocation_failed',
          severity: 'error',
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      data: { status: 'span_relocation_failed' }
    });
  }
  const spanLineCount = relocated.endLine - relocated.startLine + 1;
  const blockTooLarge = spanLineCount > parsed.maxLines;

  if (blockTooLarge) {
    const ranges = segmentRanges(relocated.startLine, relocated.endLine, parsed.maxLines);
    const fallbackRange = { startLine: relocated.startLine, endLine: Math.min(relocated.endLine, relocated.startLine + parsed.maxLines - 1) };
    const previewRange = choosePreviewRange({
      ranges,
      fallback: fallbackRange,
      focusStartLine: parsed.focusStartLine,
      focusEndLine: parsed.focusEndLine,
      focusLine: parsed.focusLine
    });
    const previewPayload = redactedContentPayload(sliceLines(currentText, previewRange.startLine, previewRange.endLine));
    return createEnvelope({
      ok: true,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: relocated.relocation.used ? 'stale' : 'ready',
      data: {
        status: 'block_too_large',
        path: row.path,
        startLine: previewRange.startLine,
        endLine: previewRange.endLine,
        spanStartLine: relocated.startLine,
        spanEndLine: relocated.endLine,
        content: previewPayload.content,
        redaction: previewPayload.redaction,
        contentStatus: 'preview',
        spanTextHash: sha1(relocated.spanText),
        fileContentHash: sha1(currentText),
        relocation: relocated.relocation,
        previewFocus: {
          focusLine: parsed.focusLine,
          focusStartLine: parsed.focusStartLine,
          focusEndLine: parsed.focusEndLine
        },
        segmentRanges: ranges
      }
    });
  }

  const totalLines = lineCount(currentText);
  const { startLine, endLine } = boundedReadRange({
    totalLines,
    spanStartLine: relocated.startLine,
    spanEndLine: relocated.endLine,
    contextLines: parsed.contextLines,
    maxLines: parsed.maxLines
  });

  const readPayload = redactedContentPayload(sliceLines(currentText, startLine, endLine));

  return createEnvelope({
    ok: true,
    tool: 'nl_read_span',
    projectRoot,
    graphRevision,
    graphState: relocated.relocation.used ? 'stale' : 'ready',
    data: {
      status: 'read',
      path: row.path,
      startLine,
      endLine,
      spanStartLine: relocated.startLine,
      spanEndLine: relocated.endLine,
      content: readPayload.content,
      redaction: readPayload.redaction,
      spanTextHash: sha1(relocated.spanText),
      fileContentHash: sha1(currentText),
      relocation: relocated.relocation
    }
  });
}
