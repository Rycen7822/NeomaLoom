import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { classifyFileRole } from '../files/role-classifier.js';
import { languageForPath } from '../files/language.js';
import type { EnvelopeWarning, GraphState } from '../mcp/envelope.js';
import { normalizeProjectRelativePath, safeReadFileInsideProject, safeStatInsideProject } from '../safety/path-guard.js';
import { detectProjectBoundaryWarnings } from '../projects/boundary-warnings.js';
import type { FileRole, SpanKind } from '../spans/enums.js';
import { readHotsetManifest, type HotsetManifest } from '../state/hotset.js';
import { readIndexCoverage, readLatestRevision, type IndexCoverage } from '../state/refresh-revision.js';
import type { EditBoundary } from '../profiles/codex-scientist.js';
import { validateBoundary } from './boundary-validation.js';
import { normalizeQuery, type NormalizedQuery } from './query-normalizer.js';
import type { LocatorCandidate } from './ranking.js';
import { buildLinkedSpanIndex, type LinkedSpan } from './edge-index.js';
import { sha1 } from '../shared/hash.js';
import { openSqliteDatabase } from '../shared/sqlite.js';

type Statement = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};

type Database = {
  prepare: (sql: string) => Statement;
  close: () => void;
};

function openReadableSpanIndexDatabase(filename: string): Database {
  if (!existsSync(filename)) {
    throw new Error('span index is not readable: spans.db is missing');
  }
  return openSqliteDatabase<Database>(filename);
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

type PlanSource = (typeof LOCATOR_SOURCE_PLAN_SOURCES)[number];

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

type FileRow = {
  path: string;
  absolute_path: string;
  role: string;
  language: string;
  content_hash: string;
  size_bytes: number;
  generated: number;
  ignored: number;
  metadata_json: string;
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
  unindexedCandidates: LocatorCandidate[];
  coverage: IndexCoverage;
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

function inferCoverage(files: FileRow[], spans: SpanRow[], metadata?: IndexCoverage): IndexCoverage {
  if (metadata) {
    return metadata;
  }
  if (files.length === 0) {
    return {
      inventory: 'missing',
      deepSpans: 'none',
      hotsetRevision: null,
      hotFiles: 0,
      coldFiles: 0,
      unindexedCandidateCount: 0
    };
  }
  const indexedPaths = new Set(spans.map(span => span.path));
  const coldFiles = files.filter(file => !indexedPaths.has(file.path)).length;
  const deepSpans = spans.length === 0 ? 'none' : coldFiles > 0 ? 'scoped' : 'full';
  return {
    inventory: 'full',
    deepSpans,
    hotsetRevision: null,
    hotFiles: files.length - coldFiles,
    coldFiles,
    unindexedCandidateCount: coldFiles
  };
}

function editBoundaryForPath(manifest: HotsetManifest, repoPath: string): EditBoundary | undefined {
  return manifest.entries.find(entry => entry.path === repoPath)?.editBoundary;
}

export type SearchableText = {
  lower: string;
  original: string;
  symbol: string;
  config: string;
};

export type SearchableTextInput = {
  path: string;
  kind: string;
  role: string;
  label: string;
  indexed_text: string;
  summary: string;
  heading_path_json: string;
  symbol_path_json: string;
  metadata_json: string;
};

export function precomputeSearchableText(row: SearchableTextInput): SearchableText {
  const original = [
    row.path,
    row.label,
    row.indexed_text,
    row.summary,
    row.heading_path_json,
    row.symbol_path_json,
    row.metadata_json
  ].join('\n');
  return {
    lower: [row.path, row.kind, row.role, original].join('\n').toLowerCase(),
    original,
    symbol: [row.label, row.indexed_text, row.symbol_path_json].join('\n'),
    config: [row.label, row.indexed_text, row.metadata_json].join('\n')
  };
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

function classifySources(row: SpanRow, query: NormalizedQuery, text: SearchableText): Set<PlanSource> {
  const sources = new Set<PlanSource>();
  const termHit = hasAny([...query.exactTerms, ...query.symbolTerms, ...query.featureTerms], text.lower);

  if (hasAny(query.exactTerms, text.lower)) sources.add('fts_lexical');
  if (row.kind.startsWith('code.') && hasExactCase(query.symbolTerms, text.original)) sources.add('code_symbol_name_signature');
  if (row.kind.startsWith('doc.') && hasAny([...query.docTerms, ...query.symbolTerms, ...query.featureTerms], text.lower)) {
    sources.add('markdown_heading_anchor_inline_code');
  }
  if (
    (row.kind.startsWith('config.') || ['config_file', 'schema_file', 'package_metadata'].includes(row.role)) &&
    hasExactCase(query.configTerms, text.original)
  ) {
    sources.add('config_cli_env_schema');
  }
  if ((row.kind.startsWith('test.') || row.kind.startsWith('example.') || ['test_file', 'example_doc'].includes(row.role)) && termHit) {
    sources.add('test_example_import_call');
  }
  if ((row.kind.startsWith('feature.') || row.role === 'feature_plan') && hasAny(query.featureTerms, text.lower)) {
    sources.add('feature_projection');
  }
  if (
    (query.pathTerms.some(term => row.path.includes(term)) ||
      (query.targetRoles.includes(row.role as FileRole) && termHit)) &&
    query.targetRoles.length > 0
  ) {
    sources.add('path_role_expansion');
  }
  if (hasExactCase(query.oldTerms, text.original)) sources.add('old_term_sweep');

  return sources;
}

function classifyInventorySources(row: FileRow, query: NormalizedQuery): Set<PlanSource> {
  const text = [row.path, row.role, row.language, row.metadata_json].join('\n').toLowerCase();
  const originalText = [row.path, row.role, row.language, row.metadata_json].join('\n');
  const sources = new Set<PlanSource>();
  const termHit = hasAny([...query.exactTerms, ...query.symbolTerms, ...query.featureTerms, ...query.pathTerms], text);
  if (hasAny([...query.exactTerms, ...query.pathTerms], text)) sources.add('fts_lexical');
  if (query.pathTerms.some(term => row.path.includes(term)) || query.targetRoles.includes(row.role as FileRole)) sources.add('path_role_expansion');
  if (String(row.role).endsWith('_doc') && termHit) sources.add('markdown_heading_anchor_inline_code');
  if (['config_file', 'schema_file', 'package_metadata'].includes(row.role) && hasExactCase(query.configTerms, originalText)) {
    sources.add('config_cli_env_schema');
  }
  if (row.role === 'test_file' && termHit) sources.add('test_example_import_call');
  if (hasExactCase(query.oldTerms, originalText)) sources.add('old_term_sweep');
  return sources;
}

const CURRENT_TEXT_FILE_READ_MAX_BYTES = 256 * 1024;
const CURRENT_TEXT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

async function readCurrentText(projectRoot: string, repoPath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await safeStatInsideProject(projectRoot, repoPath);
    if (!info.isFile() || info.size > CURRENT_TEXT_FILE_READ_MAX_BYTES || info.size > maxBytes) {
      return undefined;
    }
    const text = await safeReadFileInsideProject(projectRoot, repoPath, 'utf8');
    return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : undefined;
  } catch {
    return undefined;
  }
}

function spanRowToCandidate(input: {
  row: SpanRow;
  query: NormalizedQuery;
  sources: Set<PlanSource>;
  linkedSpanIndex: Map<string, LinkedSpan[]>;
  searchableText: SearchableText;
  currentText?: string;
  includeGeneratedVendor?: boolean;
  editBoundary?: EditBoundary;
}): LocatorCandidate {
  const headingPath = parseJson<string[]>(input.row.heading_path_json, []);
  const symbolPath = parseJson<string[]>(input.row.symbol_path_json, []);
  const metadata = parseJson<Record<string, unknown>>(input.row.metadata_json, {});
  const stableLocator = parseJson<Record<string, unknown>>(input.row.stable_locator_json, {});
  const evidence = [
    ...hitEvidence('direct_text_match', input.query.exactTerms, input.searchableText.lower),
    ...hitEvidence('symbol_match', input.query.symbolTerms, input.searchableText.symbol),
    ...hitEvidence('config_match', input.query.configTerms, input.searchableText.config)
  ];
  const linkedSpans = input.linkedSpanIndex.get(input.row.span_id) ?? [];
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
    metadata: input.editBoundary ? { ...metadata, editBoundary: input.editBoundary } : metadata,
    indexed: true
  };
}

function fileRowToCandidate(input: {
  row: FileRow;
  query: NormalizedQuery;
  sources: Set<PlanSource>;
  currentText?: string;
  includeGeneratedVendor?: boolean;
  editBoundary?: EditBoundary;
}): LocatorCandidate {
  const metadata = parseJson<Record<string, unknown>>(input.row.metadata_json, {});
  const evidence = [
    ...hitEvidence('inventory_path_match', [...input.query.exactTerms, ...input.query.pathTerms], input.row.path),
    ...hitEvidence('inventory_role_match', input.query.targetRoles, input.row.role)
  ];
  const file = {
    ignored: Boolean(input.row.ignored),
    generated: Boolean(input.row.generated) || input.row.role === 'generated_file',
    vendor: input.row.role === 'vendor_file'
  };
  const boundary = validateBoundary({
    path: input.row.path,
    kind: 'file',
    role: input.row.role,
    startLine: 1,
    endLine: 1,
    indexedFileHash: input.row.content_hash,
    currentText: input.currentText,
    ignored: file.ignored,
    generated: file.generated,
    vendor: file.vendor,
    includeGeneratedVendor: input.includeGeneratedVendor,
    evidenceCount: Math.max(1, evidence.length)
  });
  const promotionAction = { target: 'paths' as const, paths: [input.row.path], reason: 'candidate_unindexed' };

  return {
    spanId: `file:${sha1(`${input.row.path}:${input.row.content_hash}`).slice(0, 16)}`,
    path: input.row.path,
    kind: 'file',
    role: input.row.role as FileRole,
    label: path.posix.basename(input.row.path),
    startLine: 1,
    endLine: 1,
    headingPath: [],
    symbolPath: [],
    indexedText: '',
    summary: `${input.row.path} is present in the file inventory but has not been deep-indexed into spans.`,
    source: 'file-inventory',
    sourcePlanSources: [...input.sources],
    evidence,
    linkedSpans: [],
    boundary,
    file,
    coverageRole: input.row.role,
    fileContentHash: input.row.content_hash,
    textHash: input.row.content_hash,
    stableLocator: { path: input.row.path, kind: 'file' },
    metadata: { ...metadata, indexed: false, indexStatus: 'unindexed', promotionAction, ...(input.editBoundary ? { editBoundary: input.editBoundary } : {}) },
    indexed: false,
    promotionAction
  };
}

const MAX_INDEXED_TEXT_READ_BYTES = 8192;

function candidateCaps(limit?: number, query?: NormalizedQuery): { spanCap: number; fileCap: number; edgeCap: number } {
  const requested = Math.max(limit ?? 50, 20);
  const hasExplicitPath = (query?.pathTerms ?? []).some(term => term.includes('/') || /\.[A-Za-z0-9]+$/.test(term));
  return {
    spanCap: Math.max(requested * 8, hasExplicitPath ? 800 : 200),
    fileCap: Math.max(requested * 10, 250),
    edgeCap: Math.max(requested * 20, 1000)
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function likePattern(term: string): string {
  return `%${term.toLowerCase().replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function searchTerms(query: NormalizedQuery): string[] {
  return unique([
    ...query.pathTerms,
    ...query.symbolTerms,
    ...query.configTerms,
    ...query.oldTerms,
    ...query.exactTerms,
    ...query.featureTerms
  ].filter(term => term.trim().length >= 2)).slice(0, 24);
}

const SPAN_SELECT = `SELECT s.span_id, s.path, s.kind, s.role, s.label, s.start_line, s.end_line, s.language,
    s.heading_path_json, s.symbol_path_json, s.anchor, s.stable_locator_json,
    s.text_hash, substr(s.indexed_text, 1, ${MAX_INDEXED_TEXT_READ_BYTES}) AS indexed_text,
    s.summary, s.metadata_json, s.source, s.updated_at,
    f.content_hash AS file_content_hash, f.generated AS file_generated, f.ignored AS file_ignored
  FROM repo_spans s
  LEFT JOIN repo_files f ON f.path = s.path`;

function selectSpanRowsByIds(db: Database, ids: string[]): SpanRow[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  return db
    .prepare(`${SPAN_SELECT}
      WHERE s.span_id IN (${placeholders})
      ORDER BY s.path ASC, s.start_line ASC, s.span_id ASC`)
    .all(...ids) as SpanRow[];
}

function addRouteSource(routeSourcesBySpanId: Map<string, Set<PlanSource>>, spanId: string, source: PlanSource): void {
  const sources = routeSourcesBySpanId.get(spanId) ?? new Set<PlanSource>();
  sources.add(source);
  routeSourcesBySpanId.set(spanId, sources);
}

function addSpanIdsFromRows(
  target: string[],
  rows: Array<{ span_id: string }>,
  cap: number,
  routeSourcesBySpanId?: Map<string, Set<PlanSource>>,
  routeSource?: PlanSource
): void {
  const seen = new Set(target);
  for (const row of rows) {
    if (routeSourcesBySpanId && routeSource) {
      addRouteSource(routeSourcesBySpanId, row.span_id, routeSource);
    }
    if (target.length >= cap) {
      continue;
    }
    if (!seen.has(row.span_id)) {
      seen.add(row.span_id);
      target.push(row.span_id);
    }
  }
}

function safeFtsQuery(term: string): string | undefined {
  const cleaned = term.trim().replace(/"/g, '""');
  if (!cleaned || /[\u0000-\u001f]/.test(cleaned)) {
    return undefined;
  }
  return `"${cleaned}"`;
}

function selectSpanCandidateIds(db: Database, query: NormalizedQuery, cap: number): { ids: string[]; routeSourcesBySpanId: Map<string, Set<PlanSource>> } {
  const ids: string[] = [];
  const routeSourcesBySpanId = new Map<string, Set<PlanSource>>();
  const terms = searchTerms(query);
  const pathTerms = unique([...query.pathTerms, ...terms.filter(term => term.includes('.') || term.includes('/') || term.includes('_'))]);

  for (const symbol of query.symbolTerms) {
    if (ids.length >= cap) break;
    const pattern = likePattern(symbol);
    try {
      addSpanIdsFromRows(
        ids,
        db
          .prepare(`SELECT DISTINCT rs.span_id
            FROM repo_symbols rs
            LEFT JOIN repo_symbol_aliases rsa ON rsa.target_fqn = rs.symbol_fqn
            WHERE rs.symbol_name = ?
               OR rs.symbol_fqn = ?
               OR lower(rs.symbol_fqn) LIKE ? ESCAPE '\\'
               OR lower(rs.signature) LIKE ? ESCAPE '\\'
               OR lower(rsa.alias_fqn) LIKE ? ESCAPE '\\'
               OR lower(rsa.metadata_json) LIKE ? ESCAPE '\\'
            ORDER BY CASE WHEN rs.symbol_name = ? OR rs.symbol_fqn = ? THEN 0 ELSE 1 END,
                     length(rs.path) ASC, rs.path ASC, rs.symbol_fqn ASC
            LIMIT ?`)
          .all(symbol, symbol, pattern, pattern, pattern, pattern, symbol, symbol, Math.max(10, Math.min(cap - ids.length, 80))) as Array<{ span_id: string }>,
        cap,
        routeSourcesBySpanId,
        'code_symbol_name_signature'
      );
    } catch {
      // Older ad-hoc databases may not have retrieval-core rows populated yet.
    }
  }

  for (const symbol of query.symbolTerms) {
    if (ids.length >= cap) break;
    const symbolJsonPattern = likePattern(`"${symbol}"`);
    const metadataPattern = likePattern(symbol);
    addSpanIdsFromRows(
      ids,
      db
        .prepare(`SELECT span_id FROM repo_spans
          WHERE kind LIKE 'code.%'
            AND (label = ? OR lower(symbol_path_json) LIKE ? ESCAPE '\\' OR lower(metadata_json) LIKE ? ESCAPE '\\')
          ORDER BY CASE WHEN label = ? THEN 0 ELSE 1 END,
                   CASE kind
                     WHEN 'code.function' THEN 0
                     WHEN 'code.method' THEN 1
                     WHEN 'code.class' THEN 2
                     WHEN 'code.constant' THEN 3
                     WHEN 'code.component' THEN 4
                     WHEN 'code.module' THEN 8
                     ELSE 5
                   END,
                   length(path) ASC, path ASC, start_line ASC
          LIMIT ?`)
        .all(symbol, symbolJsonPattern, metadataPattern, symbol, Math.max(10, Math.min(cap - ids.length, 50))) as Array<{ span_id: string }>,
      cap,
      routeSourcesBySpanId,
      'code_symbol_name_signature'
    );
  }

  for (const term of pathTerms) {
    if (ids.length >= cap) break;
    const exactPathLimit = term.includes('/') || /\.[A-Za-z0-9]+$/.test(term);
    const limitForTerm = exactPathLimit
      ? Math.max(200, Math.min(cap - ids.length, 700))
      : Math.max(25, Math.min(cap - ids.length, 100));
    addSpanIdsFromRows(
      ids,
      db
        .prepare(`SELECT span_id FROM repo_spans
          WHERE lower(path) LIKE ? ESCAPE '\\'
          ORDER BY CASE WHEN lower(path) = ? THEN 0 WHEN lower(path) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                   length(path) ASC, path ASC, start_line ASC
          LIMIT ?`)
        .all(likePattern(term), term.toLowerCase(), `%/${term.toLowerCase()}`, limitForTerm) as Array<{ span_id: string }>,
      cap,
      routeSourcesBySpanId,
      'path_role_expansion'
    );
  }

  for (const role of query.targetRoles) {
    if (ids.length >= cap) break;
    addSpanIdsFromRows(
      ids,
      db
        .prepare(`SELECT span_id FROM repo_spans
          WHERE role = ?
          ORDER BY path ASC, start_line ASC, span_id ASC
          LIMIT ?`)
        .all(role, Math.max(10, Math.min(cap - ids.length, 50))) as Array<{ span_id: string }>,
      cap,
      routeSourcesBySpanId,
      'path_role_expansion'
    );
  }

  for (const term of terms) {
    if (ids.length >= cap) break;
    const ftsQuery = safeFtsQuery(term);
    if (ftsQuery) {
      try {
        addSpanIdsFromRows(
          ids,
          db
            .prepare(`SELECT span_id FROM repo_spans_fts
              WHERE repo_spans_fts MATCH ?
              LIMIT ?`)
            .all(ftsQuery, Math.max(25, Math.min(cap - ids.length, 100))) as Array<{ span_id: string }>,
          cap,
          routeSourcesBySpanId,
          'fts_lexical'
        );
      } catch {
        // Some ad-hoc test databases may not populate FTS or may reject punctuation-heavy terms.
      }
    }
    if (ids.length >= cap) break;
    const pattern = likePattern(term);
    addSpanIdsFromRows(
      ids,
      db
        .prepare(`SELECT span_id FROM repo_spans
          WHERE lower(path) LIKE ? ESCAPE '\\'
             OR lower(label) LIKE ? ESCAPE '\\'
             OR lower(role) LIKE ? ESCAPE '\\'
             OR lower(kind) LIKE ? ESCAPE '\\'
             OR lower(summary) LIKE ? ESCAPE '\\'
             OR lower(metadata_json) LIKE ? ESCAPE '\\'
             OR lower(symbol_path_json) LIKE ? ESCAPE '\\'
             OR lower(heading_path_json) LIKE ? ESCAPE '\\'
             OR lower(substr(indexed_text, 1, ${MAX_INDEXED_TEXT_READ_BYTES})) LIKE ? ESCAPE '\\'
          ORDER BY path ASC, start_line ASC, span_id ASC
          LIMIT ?`)
        .all(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, Math.max(25, Math.min(cap - ids.length, 100))) as Array<{ span_id: string }>,
      cap,
      routeSourcesBySpanId,
      'fts_lexical'
    );
  }

  return { ids, routeSourcesBySpanId };
}

function selectNeighborEdges(db: Database, spanIds: string[], edgeCap: number): EdgeRow[] {
  if (spanIds.length === 0) {
    return [];
  }
  const limitedIds = spanIds.slice(0, Math.min(spanIds.length, 250));
  const placeholders = limitedIds.map(() => '?').join(', ');
  return db
    .prepare(`SELECT source_span_id, target_span_id, relation, confidence
      FROM repo_edges
      WHERE source_span_id IN (${placeholders}) OR target_span_id IN (${placeholders})
      ORDER BY confidence DESC, source_span_id ASC, target_span_id ASC
      LIMIT ?`)
    .all(...limitedIds, ...limitedIds, edgeCap) as EdgeRow[];
}

function selectFileRows(db: Database, query: NormalizedQuery, cap: number): FileRow[] {
  const rows: FileRow[] = [];
  const seen = new Set<string>();
  const addRows = (candidates: FileRow[]): void => {
    for (const row of candidates) {
      if (rows.length >= cap) break;
      if (!seen.has(row.path)) {
        seen.add(row.path);
        rows.push(row);
      }
    }
  };
  const select = `SELECT f.path, f.absolute_path, f.role, f.language, f.content_hash, f.size_bytes, f.generated, f.ignored, f.metadata_json
    FROM repo_files f
    WHERE NOT EXISTS (SELECT 1 FROM repo_spans s WHERE s.path = f.path) AND`;
  const terms = searchTerms(query);
  const pathTerms = unique([...query.pathTerms, ...terms.filter(term => term.includes('.') || term.includes('/') || term.includes('_'))]);

  for (const term of pathTerms) {
    if (rows.length >= cap) break;
    addRows(
      db
        .prepare(`${select} lower(f.path) LIKE ? ESCAPE '\\'
          ORDER BY CASE WHEN lower(f.path) = ? THEN 0 WHEN lower(f.path) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                   length(f.path) ASC, f.path ASC
          LIMIT ?`)
        .all(likePattern(term), term.toLowerCase(), `%/${term.toLowerCase()}`, Math.max(25, Math.min(cap - rows.length, 100))) as FileRow[]
    );
  }

  for (const role of query.targetRoles) {
    if (rows.length >= cap) break;
    addRows(
      db
        .prepare(`${select} f.role = ?
          ORDER BY f.path ASC
          LIMIT ?`)
        .all(role, Math.max(10, Math.min(cap - rows.length, 50))) as FileRow[]
    );
  }

  for (const term of terms) {
    if (rows.length >= cap) break;
    const pattern = likePattern(term);
    addRows(
      db
        .prepare(`${select} (
             lower(f.path) LIKE ? ESCAPE '\\'
          OR lower(f.role) LIKE ? ESCAPE '\\'
          OR lower(f.language) LIKE ? ESCAPE '\\'
          OR lower(f.metadata_json) LIKE ? ESCAPE '\\'
        )
        ORDER BY CASE WHEN lower(f.path) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                 f.generated ASC, length(f.path) ASC, f.path ASC
        LIMIT ?`)
        .all(pattern, pattern, pattern, pattern, pattern, Math.max(25, Math.min(cap - rows.length, 100))) as FileRow[]
    );
  }

  return rows;
}

function coverageFromDb(db: Database): IndexCoverage | undefined {
  try {
    const filesRow = db.prepare('SELECT COUNT(*) AS value FROM repo_files').get() as { value: number };
    const spansRow = db.prepare('SELECT COUNT(*) AS value FROM repo_spans').get() as { value: number };
    const indexedPathsRow = db.prepare('SELECT COUNT(DISTINCT path) AS value FROM repo_spans').get() as { value: number };
    const fileCount = Number(filesRow.value ?? 0);
    const spanCount = Number(spansRow.value ?? 0);
    const indexedPathCount = Number(indexedPathsRow.value ?? 0);
    if (fileCount === 0) {
      return undefined;
    }
    const coldFiles = Math.max(0, fileCount - indexedPathCount);
    return {
      inventory: 'full',
      deepSpans: spanCount === 0 ? 'none' : coldFiles > 0 ? 'scoped' : 'full',
      hotsetRevision: null,
      hotFiles: indexedPathCount,
      coldFiles,
      unindexedCandidateCount: coldFiles
    };
  } catch {
    return undefined;
  }
}

function rowsFromDb(
  dbPath: string,
  query: NormalizedQuery,
  limit?: number
): { spans: SpanRow[]; edges: EdgeRow[]; files: FileRow[]; coverage?: IndexCoverage; routeSourcesBySpanId: Map<string, Set<PlanSource>> } {
  const db = openReadableSpanIndexDatabase(dbPath);
  try {
    const caps = candidateCaps(limit, query);
    const selection = selectSpanCandidateIds(db, query, caps.spanCap);
    const initialSpanIds = selection.ids;
    const routeSourcesBySpanId = selection.routeSourcesBySpanId;
    const initialEdges = selectNeighborEdges(db, initialSpanIds, caps.edgeCap);
    const spanIds = [...initialSpanIds];
    addSpanIdsFromRows(
      spanIds,
      initialEdges
        .filter(edge => edge.confidence >= 0.6)
        .flatMap(edge => [{ span_id: edge.source_span_id }, { span_id: edge.target_span_id }]),
      caps.spanCap,
      routeSourcesBySpanId,
      'cross_reference_edge'
    );
    const edges = selectNeighborEdges(db, spanIds, caps.edgeCap);
    const spans = selectSpanRowsByIds(db, spanIds);
    const files = selectFileRows(db, query, caps.fileCap);
    return { spans, edges, files, coverage: coverageFromDb(db), routeSourcesBySpanId };
  } finally {
    db.close();
  }
}

async function filesFromInventorySnapshot(projectRoot: string): Promise<FileRow[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectRoot, '.noemaloom', 'files', 'inventory.json'), 'utf8')) as {
      files?: Array<{ path: string; contentHash?: string }>;
    };
    return Array.isArray(parsed.files)
      ? parsed.files
          .flatMap(file => {
            if (typeof file.path !== 'string') return [];
            let repoPath: string;
            try {
              repoPath = normalizeProjectRelativePath(projectRoot, file.path);
            } catch {
              return [];
            }
            const role = classifyFileRole(repoPath);
            return {
              path: repoPath,
              absolute_path: path.join(projectRoot, repoPath),
              role,
              language: languageForPath(repoPath),
              content_hash: file.contentHash ?? '',
              size_bytes: 0,
              generated: role === 'generated_file' ? 1 : 0,
              ignored: 0,
              metadata_json: '{}'
            } satisfies FileRow;
          })
      : [];
  } catch {
    return [];
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
  let files: FileRow[] = [];
  let dbCoverage: IndexCoverage | undefined;
  let routeSourcesBySpanId = new Map<string, Set<PlanSource>>();
  const warnings: EnvelopeWarning[] = [];
  warnings.push(...(await detectProjectBoundaryWarnings(input.projectRoot)));

  try {
    const rows = rowsFromDb(dbPath, normalizedQuery, input.limit);
    spans = rows.spans;
    edges = rows.edges;
    files = rows.files;
    dbCoverage = rows.coverage;
    routeSourcesBySpanId = rows.routeSourcesBySpanId;
  } catch (error) {
    files = await filesFromInventorySnapshot(input.projectRoot);
    warnings.push({
      code: files.length > 0 ? 'span_index_missing_inventory_fallback' : 'span_index_missing',
      severity: 'warning',
      message: error instanceof Error ? error.message : 'span index is not readable'
    });
  }

  const coverage = (await readIndexCoverage(input.projectRoot)) ?? dbCoverage ?? inferCoverage(files, spans);
  const hotsetManifest = await readHotsetManifest(input.projectRoot);

  if (spans.length === 0 && files.length === 0) {
    return {
      normalizedQuery,
      candidates: [],
      unindexedCandidates: [],
      coverage,
      graphRevision,
      graphState: 'empty',
      warnings
    };
  }

  const searchableBySpanId = new Map<string, SearchableText>();
  const sourceBySpanId = new Map<string, Set<PlanSource>>();
  for (const row of spans) {
    const searchableText = precomputeSearchableText(row);
    searchableBySpanId.set(row.span_id, searchableText);
    const sources = new Set<PlanSource>(routeSourcesBySpanId.get(row.span_id));
    for (const source of classifySources(row, normalizedQuery, searchableText)) {
      sources.add(source);
    }
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

  const linkedSpanIndex = buildLinkedSpanIndex(edges);
  const currentTextByPath = new Map<string, string | undefined>();
  let currentTextCachedBytes = 0;
  const cachedCurrentText = async (repoPath: string): Promise<string | undefined> => {
    if (currentTextByPath.has(repoPath)) return currentTextByPath.get(repoPath);
    const remainingBytes = CURRENT_TEXT_CACHE_MAX_BYTES - currentTextCachedBytes;
    const currentText = remainingBytes > 0 ? await readCurrentText(input.projectRoot, repoPath, remainingBytes) : undefined;
    if (currentText !== undefined) currentTextCachedBytes += Buffer.byteLength(currentText, 'utf8');
    currentTextByPath.set(repoPath, currentText);
    return currentText;
  };
  const candidates: LocatorCandidate[] = [];
  for (const row of spans) {
    const sources = sourceBySpanId.get(row.span_id);
    if (!sources) {
      continue;
    }
    const currentText = await cachedCurrentText(row.path);
    const searchableText = searchableBySpanId.get(row.span_id) ?? precomputeSearchableText(row);
    candidates.push(
      spanRowToCandidate({
        row,
        query: normalizedQuery,
        sources,
        linkedSpanIndex,
        searchableText,
        currentText,
        includeGeneratedVendor: input.includeGeneratedVendor,
        editBoundary: editBoundaryForPath(hotsetManifest, row.path)
      })
    );
  }

  const indexedPaths = new Set(spans.map(span => span.path));
  const unindexedCandidates: LocatorCandidate[] = [];
  for (const row of files) {
    if (indexedPaths.has(row.path)) {
      continue;
    }
    const sources = classifyInventorySources(row, normalizedQuery);
    if (sources.size === 0) {
      continue;
    }
    const currentText = await cachedCurrentText(row.path);
    const candidate = fileRowToCandidate({
      row,
      query: normalizedQuery,
      sources,
      currentText,
      includeGeneratedVendor: input.includeGeneratedVendor,
      editBoundary: editBoundaryForPath(hotsetManifest, row.path)
    });
    unindexedCandidates.push(candidate);
    candidates.push(candidate);
  }

  if (unindexedCandidates.length > 0) {
    warnings.push({
      code: 'unindexed_candidates',
      severity: 'warning',
      message: `${unindexedCandidates.length} matching file(s) are only in inventory; promote with nl_refresh target="paths" before span reads or final impact claims.`
    });
  }

  return {
    normalizedQuery,
    candidates,
    unindexedCandidates,
    coverage,
    graphRevision,
    graphState: candidates.length > 0 ? (spans.length > 0 ? 'ready' : 'partial') : 'partial',
    warnings
  };
}
