import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { EnvelopeWarning, GraphState } from '../mcp/envelope.js';
import type { FileRole, SpanKind } from '../spans/enums.js';
import { readLatestRevision } from '../state/refresh-revision.js';
import { validateBoundary } from './boundary-validation.js';
import { normalizeQuery, type NormalizedQuery } from './query-normalizer.js';
import type { LocatorCandidate } from './ranking.js';

type Statement = {
  all: (...params: unknown[]) => unknown[];
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

const require = createRequire(import.meta.url);

function openDatabase(filename: string): Database {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
  return new sqlite.DatabaseSync(filename);
}

export const LOCATOR_SOURCE_PLAN_SOURCES = [
  'fts_lexical',
  'code_symbol_name_signature',
  'markdown_heading_anchor_inline_code',
  'config_cli_env_schema',
  'test_example_import_call',
  'feature_projection',
  'cross_reference_edge',
  'path_role_expansion',
  'old_term_sweep'
] as const;

type SpanRow = {
  span_id: string;
  path: string;
  kind: string;
  role: string;
  label: string;
  start_line: number;
  end_line: number;
  language: string;
  heading_path_json: string;
  symbol_path_json: string;
  anchor: string | null;
  stable_locator_json: string;
  text_hash: string;
  indexed_text: string;
  summary: string;
  metadata_json: string;
  source: string;
  updated_at: number;
  file_content_hash: string | null;
  file_generated: number | null;
  file_ignored: number | null;
};

type EdgeRow = {
  source_span_id: string;
  target_span_id: string;
  relation: string;
  confidence: number;
};

export type CandidateGenerationResult = {
  normalizedQuery: NormalizedQuery;
  candidates: LocatorCandidate[];
  graphRevision: string | null;
  graphState: GraphState;
  warnings: EnvelopeWarning[];
};

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

function searchable(row: SpanRow): string {
  return [
    row.path,
    row.kind,
    row.role,
    row.label,
    row.indexed_text,
    row.summary,
    row.heading_path_json,
    row.symbol_path_json,
    row.metadata_json
  ]
    .join('\n')
    .toLowerCase();
}

function hasAny(terms: string[], text: string): boolean {
  return terms.some(term => text.includes(term.toLowerCase()));
}

function hasExactCase(terms: string[], text: string): boolean {
  return terms.some(term => text.includes(term));
}

function hitEvidence(kind: string, terms: string[], text: string): Array<Record<string, unknown>> {
  return terms
    .filter(term => text.toLowerCase().includes(term.toLowerCase()))
    .slice(0, 5)
    .map(term => ({ kind, value: term }));
}

function classifySources(row: SpanRow, query: NormalizedQuery): Set<(typeof LOCATOR_SOURCE_PLAN_SOURCES)[number]> {
  const text = searchable(row);
  const originalText = [
    row.path,
    row.label,
    row.indexed_text,
    row.summary,
    row.heading_path_json,
    row.symbol_path_json,
    row.metadata_json
  ].join('\n');
  const sources = new Set<(typeof LOCATOR_SOURCE_PLAN_SOURCES)[number]>();
  const termHit = hasAny([...query.exactTerms, ...query.symbolTerms, ...query.featureTerms], text);

  if (hasAny(query.exactTerms, text)) sources.add('fts_lexical');
  if (row.kind.startsWith('code.') && hasExactCase(query.symbolTerms, originalText)) sources.add('code_symbol_name_signature');
  if (row.kind.startsWith('doc.') && hasAny([...query.docTerms, ...query.symbolTerms, ...query.featureTerms], text)) {
    sources.add('markdown_heading_anchor_inline_code');
  }
  if (
    (row.kind.startsWith('config.') || ['config_file', 'schema_file', 'package_metadata'].includes(row.role)) &&
    hasExactCase(query.configTerms, originalText)
  ) {
    sources.add('config_cli_env_schema');
  }
  if ((row.kind.startsWith('test.') || row.kind.startsWith('example.') || ['test_file', 'example_doc'].includes(row.role)) && termHit) {
    sources.add('test_example_import_call');
  }
  if ((row.kind.startsWith('feature.') || row.role === 'feature_plan') && hasAny(query.featureTerms, text)) {
    sources.add('feature_projection');
  }
  if (
    (query.pathTerms.some(term => row.path.includes(term)) ||
      (query.targetRoles.includes(row.role as FileRole) && termHit)) &&
    query.targetRoles.length > 0
  ) {
    sources.add('path_role_expansion');
  }
  if (hasExactCase(query.oldTerms, originalText)) sources.add('old_term_sweep');

  return sources;
}

async function readCurrentText(projectRoot: string, repoPath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(projectRoot, repoPath), 'utf8');
  } catch {
    return undefined;
  }
}

function linkedSpansFor(row: SpanRow, edges: EdgeRow[]): Array<{ spanId: string; confidence: number; relation?: string }> {
  return edges
    .filter(edge => edge.source_span_id === row.span_id || edge.target_span_id === row.span_id)
    .map(edge => ({
      spanId: edge.source_span_id === row.span_id ? edge.target_span_id : edge.source_span_id,
      confidence: edge.confidence,
      relation: edge.relation
    }))
    .sort((left, right) => right.confidence - left.confidence || left.spanId.localeCompare(right.spanId));
}

function spanRowToCandidate(input: {
  row: SpanRow;
  query: NormalizedQuery;
  sources: Set<(typeof LOCATOR_SOURCE_PLAN_SOURCES)[number]>;
  edges: EdgeRow[];
  currentText?: string;
  includeGeneratedVendor?: boolean;
}): LocatorCandidate {
  const headingPath = parseJson<string[]>(input.row.heading_path_json, []);
  const symbolPath = parseJson<string[]>(input.row.symbol_path_json, []);
  const metadata = parseJson<Record<string, unknown>>(input.row.metadata_json, {});
  const stableLocator = parseJson<Record<string, unknown>>(input.row.stable_locator_json, {});
  const evidence = [
    ...hitEvidence('direct_text_match', input.query.exactTerms, searchable(input.row)),
    ...hitEvidence('symbol_match', input.query.symbolTerms, [input.row.label, input.row.indexed_text, input.row.symbol_path_json].join('\n')),
    ...hitEvidence('config_match', input.query.configTerms, [input.row.label, input.row.indexed_text, input.row.metadata_json].join('\n'))
  ];
  const linkedSpans = linkedSpansFor(input.row, input.edges);
  const file = {
    ignored: Boolean(input.row.file_ignored),
    generated: Boolean(input.row.file_generated) || input.row.role === 'generated_file',
    vendor: input.row.role === 'vendor_file'
  };
  const boundary = validateBoundary({
    path: input.row.path,
    kind: input.row.kind,
    role: input.row.role,
    startLine: input.row.start_line,
    endLine: input.row.end_line,
    indexedFileHash: input.row.file_content_hash ?? undefined,
    currentText: input.currentText,
    ignored: file.ignored,
    generated: file.generated,
    vendor: file.vendor,
    includeGeneratedVendor: input.includeGeneratedVendor,
    evidenceCount: evidence.length + linkedSpans.length
  });

  return {
    spanId: input.row.span_id,
    path: input.row.path,
    kind: input.row.kind as SpanKind,
    role: input.row.role as FileRole,
    label: input.row.label,
    startLine: input.row.start_line,
    endLine: input.row.end_line,
    headingPath,
    symbolPath,
    indexedText: input.row.indexed_text,
    summary: input.row.summary,
    source: input.row.source,
    sourcePlanSources: [...input.sources],
    evidence,
    linkedSpans,
    boundary,
    file,
    coverageRole: input.row.role,
    fileContentHash: input.row.file_content_hash ?? undefined,
    textHash: input.row.text_hash,
    anchor: input.row.anchor ?? undefined,
    stableLocator,
    metadata
  };
}

function rowsFromDb(dbPath: string): { spans: SpanRow[]; edges: EdgeRow[] } {
  const db = openDatabase(dbPath);
  try {
    const spans = db
      .prepare(
        `SELECT s.span_id, s.path, s.kind, s.role, s.label, s.start_line, s.end_line, s.language,
                s.heading_path_json, s.symbol_path_json, s.anchor, s.stable_locator_json,
                s.text_hash, s.indexed_text, s.summary, s.metadata_json, s.source, s.updated_at,
                f.content_hash AS file_content_hash, f.generated AS file_generated, f.ignored AS file_ignored
         FROM repo_spans s
         LEFT JOIN repo_files f ON f.path = s.path
         ORDER BY s.path ASC, s.start_line ASC, s.span_id ASC`
      )
      .all() as SpanRow[];
    const edges = db
      .prepare(
        `SELECT source_span_id, target_span_id, relation, confidence
         FROM repo_edges
         ORDER BY confidence DESC, source_span_id ASC, target_span_id ASC`
      )
      .all() as EdgeRow[];
    return { spans, edges };
  } finally {
    db.close();
  }
}

export async function generateCandidates(input: {
  projectRoot: string;
  query: string;
  targetRoles?: string[];
  limit?: number;
  includeGeneratedVendor?: boolean;
}): Promise<CandidateGenerationResult> {
  const normalizedQuery = normalizeQuery({ query: input.query, targetRoles: input.targetRoles });
  const dbPath = path.join(input.projectRoot, '.noemaloom', 'spans', 'spans.db');
  const graphRevision = (await readLatestRevision(input.projectRoot)) ?? null;
  let spans: SpanRow[] = [];
  let edges: EdgeRow[] = [];

  try {
    const rows = rowsFromDb(dbPath);
    spans = rows.spans;
    edges = rows.edges;
  } catch (error) {
    return {
      normalizedQuery,
      candidates: [],
      graphRevision,
      graphState: 'empty',
      warnings: [
        {
          code: 'span_index_missing',
          severity: 'warning',
          message: error instanceof Error ? error.message : 'span index is not readable'
        }
      ]
    };
  }

  const sourceBySpanId = new Map<string, Set<(typeof LOCATOR_SOURCE_PLAN_SOURCES)[number]>>();
  for (const row of spans) {
    const sources = classifySources(row, normalizedQuery);
    if (sources.size > 0) {
      sourceBySpanId.set(row.span_id, sources);
    }
  }

  const initiallyMatched = new Set(sourceBySpanId.keys());
  for (const edge of edges.filter(edge => edge.confidence >= 0.6)) {
    if (initiallyMatched.has(edge.source_span_id) && !sourceBySpanId.has(edge.target_span_id)) {
      sourceBySpanId.set(edge.target_span_id, new Set(['cross_reference_edge']));
    }
    if (initiallyMatched.has(edge.target_span_id) && !sourceBySpanId.has(edge.source_span_id)) {
      sourceBySpanId.set(edge.source_span_id, new Set(['cross_reference_edge']));
    }
  }

  const currentTextByPath = new Map<string, string | undefined>();
  const candidates: LocatorCandidate[] = [];
  for (const row of spans) {
    const sources = sourceBySpanId.get(row.span_id);
    if (!sources) {
      continue;
    }
    if (!currentTextByPath.has(row.path)) {
      currentTextByPath.set(row.path, await readCurrentText(input.projectRoot, row.path));
    }
    candidates.push(
      spanRowToCandidate({
        row,
        query: normalizedQuery,
        sources,
        edges,
        currentText: currentTextByPath.get(row.path),
        includeGeneratedVendor: input.includeGeneratedVendor
      })
    );
  }

  return {
    normalizedQuery,
    candidates,
    graphRevision,
    graphState: candidates.length > 0 ? 'ready' : 'partial',
    warnings: []
  };
}
