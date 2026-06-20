import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';

import { indexDocumentSpans } from '../../documents/document-span-indexer.js';
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
  file_content_hash: string | null;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

export const nlReadSpanInputSchema = z
  .object({
    projectPath: z.string().optional(),
    spanId: z.string().min(1),
    contextLines: z.number().int().min(0).max(80).default(20),
    maxLines: z.number().int().positive().max(500).default(160)
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

function readSpanRow(projectRoot: string, spanId: string): SpanRow | undefined {
  const db = openDatabase(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'));
  try {
    return db
      .prepare(
        `SELECT s.span_id, s.path, s.kind, s.role, s.label, s.start_line, s.end_line,
                s.heading_path_json, s.anchor, s.stable_locator_json, s.text_hash, s.indexed_text,
                f.content_hash AS file_content_hash
         FROM repo_spans s
         LEFT JOIN repo_files f ON f.path = s.path
         WHERE s.span_id = ?`
      )
      .get(spanId) as SpanRow | undefined;
  } finally {
    db.close();
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

function boundedReadRange(input: {
  totalLines: number;
  spanStartLine: number;
  spanEndLine: number;
  contextLines: number;
  maxLines: number;
}): { startLine: number; endLine: number } {
  const spanLineCount = input.spanEndLine - input.spanStartLine + 1;
  if (spanLineCount >= input.maxLines) {
    return { startLine: input.spanStartLine, endLine: input.spanEndLine };
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
    normalizedText: row.indexed_text,
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

  const exact = exactTextLineRange(input.currentText, input.row.indexed_text);
  if (exact) {
    return {
      startLine: exact.startLine,
      endLine: exact.endLine,
      spanText: exact.text,
      relocation: { used: true, method: 'text_search' }
    };
  }

  throw new Error('span_not_found_after_file_change');
}

export async function handleNlReadSpan(input: unknown): Promise<NoemaLoomEnvelope> {
  const parsed = nlReadSpanInputSchema.parse(input ?? {});
  const projectRoot = resolveProjectRootFromInput(parsed);
  const graphRevision = (await readLatestRevision(projectRoot)) ?? null;
  const row = readSpanRow(projectRoot, parsed.spanId);

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

  const currentText = await readFile(path.join(projectRoot, row.path), 'utf8');
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
  const blockTooLarge =
    ['doc.table', 'doc.list', 'doc.code_fence', 'doc.section', 'code.module'].includes(row.kind) && spanLineCount > parsed.maxLines;

  if (blockTooLarge) {
    return createEnvelope({
      ok: true,
      tool: 'nl_read_span',
      projectRoot,
      graphRevision,
      graphState: relocated.relocation.used ? 'stale' : 'ready',
      data: {
        status: 'block_too_large',
        path: row.path,
        startLine: relocated.startLine,
        endLine: relocated.endLine,
        spanStartLine: relocated.startLine,
        spanEndLine: relocated.endLine,
        content: '',
        spanTextHash: sha1(relocated.spanText),
        fileContentHash: sha1(currentText),
        relocation: relocated.relocation,
        segmentRanges: segmentRanges(relocated.startLine, relocated.endLine, parsed.maxLines)
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
      content: sliceLines(currentText, startLine, endLine),
      spanTextHash: sha1(relocated.spanText),
      fileContentHash: sha1(currentText),
      relocation: relocated.relocation
    }
  });
}
