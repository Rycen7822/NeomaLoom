import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { EdgeRelation, FileRole, SpanKind } from '../spans/enums.js';

type Statement = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
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

export type TraceDirection = 'upstream' | 'downstream' | 'both';

export type TraceNode = {
  spanId: string;
  path: string;
  kind: SpanKind | string;
  role: FileRole | string;
  label: string;
  startLine: number;
  endLine: number;
  headingPath: string[];
};

export type TraceEdge = {
  edgeId: string;
  sourceSpanId: string;
  targetSpanId: string;
  relation: EdgeRelation | string;
  confidence: number;
  source: string;
  evidence: unknown;
};

export type TraceGraph = {
  nodes: TraceNode[];
  edges: TraceEdge[];
  seedSpanIds: string[];
  impactCoverage: 'full' | 'scoped' | 'none';
  missingUnindexedPaths: string[];
  requiredActions: string[];
  warnings?: string[];
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
  symbol_path_json: string;
  summary: string;
  metadata_json: string;
};

type EdgeRow = {
  edge_id: string;
  source_span_id: string;
  target_span_id: string;
  relation: string;
  confidence: number;
  source: string;
  evidence_json: string;
};

type CoverageRow = {
  value_json: string;
};

const MAX_TRACE_SEEDS = 100;
const MAX_TRACE_NODES = 500;
const MAX_TRACE_EDGES = 1000;
const MAX_TRACE_TEXT_BYTES = 8192;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function likePattern(term: string): string {
  return `%${term.toLowerCase().replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function rowToNode(row: SpanRow): TraceNode {
  return {
    spanId: row.span_id,
    path: row.path,
    kind: row.kind,
    role: row.role,
    label: row.label,
    startLine: row.start_line,
    endLine: row.end_line,
    headingPath: parseJson<string[]>(row.heading_path_json, [])
  };
}

function rowToEdge(row: EdgeRow): TraceEdge {
  return {
    edgeId: row.edge_id,
    sourceSpanId: row.source_span_id,
    targetSpanId: row.target_span_id,
    relation: row.relation,
    confidence: row.confidence,
    source: row.source,
    evidence: parseJson<unknown>(row.evidence_json, {})
  };
}

function readCoverage(db: Database): 'full' | 'scoped' | 'none' {
  try {
    const row = db.prepare("SELECT value_json FROM index_metadata WHERE key = 'coverage'").get() as CoverageRow | undefined;
    const parsed = row?.value_json ? parseJson<{ deepSpans?: string }>(row.value_json, {}) : {};
    if (parsed.deepSpans === 'full' || parsed.deepSpans === 'scoped' || parsed.deepSpans === 'none') {
      return parsed.deepSpans;
    }
  } catch {
    // Old databases predate coverage metadata.
  }
  try {
    const spanCount = Number((db.prepare('SELECT COUNT(*) AS value FROM repo_spans').get() as { value: number }).value ?? 0);
    if (spanCount === 0) return 'none';
    const fileCount = Number((db.prepare('SELECT COUNT(*) AS value FROM repo_files').get() as { value: number }).value ?? 0);
    const indexedPathCount = Number((db.prepare('SELECT COUNT(DISTINCT path) AS value FROM repo_spans').get() as { value: number }).value ?? 0);
    return fileCount > indexedPathCount ? 'scoped' : 'full';
  } catch {
    return 'none';
  }
}

function relationAllowed(edge: EdgeRow, relationTypes: string[]): boolean {
  return relationTypes.length === 0 || relationTypes.includes('all') || relationTypes.includes(edge.relation);
}

function spanSearchPredicateSql(kindPrefix?: string): string {
  return `(
    lower(path) LIKE ? ESCAPE '\\'
    OR lower(label) LIKE ? ESCAPE '\\'
    OR lower(role) LIKE ? ESCAPE '\\'
    OR lower(kind) LIKE ? ESCAPE '\\'
    OR lower(summary) LIKE ? ESCAPE '\\'
    OR lower(metadata_json) LIKE ? ESCAPE '\\'
    OR lower(symbol_path_json) LIKE ? ESCAPE '\\'
    OR lower(substr(indexed_text, 1, ${MAX_TRACE_TEXT_BYTES})) LIKE ? ESCAPE '\\'
  )${kindPrefix ? ' AND kind LIKE ?' : ''}`;
}

function resolveSeedSpanIds(db: Database, target: string, targetType = 'auto'): string[] {
  const add = (ids: string[], rows: Array<{ span_id: string }>): string[] => {
    const seen = new Set(ids);
    for (const row of rows) {
      if (ids.length >= MAX_TRACE_SEEDS) break;
      if (!seen.has(row.span_id)) {
        seen.add(row.span_id);
        ids.push(row.span_id);
      }
    }
    return ids;
  };
  let ids: string[] = [];

  if (targetType === 'span') {
    return (db.prepare('SELECT span_id FROM repo_spans WHERE span_id = ? LIMIT ?').all(target, MAX_TRACE_SEEDS) as Array<{ span_id: string }>).map(row => row.span_id);
  }
  if (targetType === 'file') {
    return (db.prepare('SELECT span_id FROM repo_spans WHERE path = ? ORDER BY start_line ASC, span_id ASC LIMIT ?').all(target, MAX_TRACE_SEEDS) as Array<{ span_id: string }>).map(row => row.span_id);
  }
  if (targetType === 'symbol') {
    const symbolJsonPattern = likePattern(`"${target}"`);
    const metadataPattern = likePattern(target);
    ids = add(
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
        .all(target, symbolJsonPattern, metadataPattern, target, MAX_TRACE_SEEDS) as Array<{ span_id: string }>
    );
    if (ids.length > 0) return ids;
  }

  ids = add(ids, db.prepare('SELECT span_id FROM repo_spans WHERE span_id = ? OR path = ? ORDER BY path ASC, start_line ASC LIMIT ?').all(target, target, MAX_TRACE_SEEDS) as Array<{ span_id: string }>);
  if (ids.length >= MAX_TRACE_SEEDS) return ids;

  const pattern = likePattern(target);
  const kindPrefix = targetType === 'feature' ? 'feature.%' : targetType === 'config' ? 'config.%' : targetType === 'doc' ? 'doc.%' : targetType === 'symbol' ? 'code.%' : undefined;
  const params = [pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, ...(kindPrefix ? [kindPrefix] : []), MAX_TRACE_SEEDS - ids.length];
  ids = add(
    ids,
    db
      .prepare(`SELECT span_id FROM repo_spans
        WHERE ${spanSearchPredicateSql(kindPrefix)}
        ORDER BY path ASC, start_line ASC, span_id ASC
        LIMIT ?`)
      .all(...params) as Array<{ span_id: string }>
  );
  return ids;
}

function fetchNodeRows(db: Database, spanIds: string[]): SpanRow[] {
  if (spanIds.length === 0) return [];
  const limited = spanIds.slice(0, MAX_TRACE_NODES);
  const placeholders = limited.map(() => '?').join(', ');
  return db
    .prepare(`SELECT span_id, path, kind, role, label, start_line, end_line, heading_path_json,
        symbol_path_json, summary, metadata_json
      FROM repo_spans
      WHERE span_id IN (${placeholders})
      ORDER BY path ASC, start_line ASC, span_id ASC`)
    .all(...limited) as SpanRow[];
}

function fetchEdgesForFrontier(db: Database, frontier: string[], direction: TraceDirection, relationTypes: string[], remaining: number): EdgeRow[] {
  if (frontier.length === 0 || remaining <= 0) return [];
  const limited = frontier.slice(0, 250);
  const placeholders = limited.map(() => '?').join(', ');
  const relationValues = relationTypes.length === 0 || relationTypes.includes('all') ? [] : relationTypes;
  const relationPlaceholders = relationValues.map(() => '?').join(', ');
  const clauses: string[] = [];
  const params: unknown[] = [];
  const addClause = (column: 'source_span_id' | 'target_span_id'): void => {
    const relationSql = relationValues.length > 0 ? ` AND relation IN (${relationPlaceholders})` : '';
    clauses.push(`${column} IN (${placeholders})${relationSql}`);
    params.push(...limited, ...relationValues);
  };
  if (direction !== 'upstream') {
    addClause('source_span_id');
  }
  if (direction !== 'downstream') {
    addClause('target_span_id');
  }
  const rows = db
    .prepare(`SELECT edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json
      FROM repo_edges
      WHERE ${clauses.map(clause => `(${clause})`).join(' OR ')}
      ORDER BY confidence DESC, source_span_id ASC, target_span_id ASC
      LIMIT ?`)
    .all(...params, remaining) as EdgeRow[];
  return rows.filter(edge => relationAllowed(edge, relationTypes));
}

function missingUnindexedPaths(db: Database, coverage: 'full' | 'scoped' | 'none'): string[] {
  if (coverage === 'full') {
    return [];
  }
  try {
    return (
      db
        .prepare(`SELECT f.path
          FROM repo_files f
          WHERE NOT EXISTS (SELECT 1 FROM repo_spans s WHERE s.path = f.path)
            AND (f.role LIKE '%_doc' OR f.role IN ('test_file', 'config_file', 'schema_file', 'example_doc'))
          ORDER BY f.path ASC
          LIMIT 30`)
        .all() as Array<{ path: string }>
    ).map(row => row.path);
  } catch {
    return [];
  }
}

function emptyTraceGraph(requiredAction: string, warnings: string[] = []): TraceGraph {
  return {
    nodes: [],
    edges: [],
    seedSpanIds: [],
    impactCoverage: 'none',
    missingUnindexedPaths: [],
    requiredActions: [requiredAction],
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

export function traceGraph(input: {
  projectRoot: string;
  target: string;
  targetType?: string;
  direction?: TraceDirection;
  depth?: number;
  relationTypes?: string[];
}): TraceGraph {
  const dbPath = path.join(input.projectRoot, '.noemaloom', 'spans', 'spans.db');
  if (!existsSync(dbPath)) {
    return emptyTraceGraph('run nl_refresh before impact tracing');
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyTraceGraph('run nl_refresh before impact tracing', [`spans.db unreadable; run nl_refresh target="files" (${message})`]);
  }
  try {
    const relationTypes = input.relationTypes ?? ['all'];
    const direction = input.direction ?? 'both';
    const seedSpanIds = resolveSeedSpanIds(db, input.target, input.targetType);
    const includedNodeIds = new Set(seedSpanIds);
    const includedEdgeIds = new Set<string>();
    const includedEdges = new Map<string, EdgeRow>();
    let frontier = new Set(seedSpanIds);

    for (let step = 0; step < (input.depth ?? 2); step += 1) {
      const next = new Set<string>();
      const edges = fetchEdgesForFrontier(db, [...frontier], direction, relationTypes, MAX_TRACE_EDGES - includedEdges.size);
      for (const edge of edges) {
        if (includedEdges.size >= MAX_TRACE_EDGES || includedNodeIds.size >= MAX_TRACE_NODES) break;
        const useDownstream = direction !== 'upstream' && frontier.has(edge.source_span_id);
        const useUpstream = direction !== 'downstream' && frontier.has(edge.target_span_id);
        if (useDownstream) {
          includedEdgeIds.add(edge.edge_id);
          includedEdges.set(edge.edge_id, edge);
          includedNodeIds.add(edge.target_span_id);
          next.add(edge.target_span_id);
        }
        if (useUpstream) {
          includedEdgeIds.add(edge.edge_id);
          includedEdges.set(edge.edge_id, edge);
          includedNodeIds.add(edge.source_span_id);
          next.add(edge.source_span_id);
        }
      }
      frontier = next;
      if (frontier.size === 0 || includedEdges.size >= MAX_TRACE_EDGES || includedNodeIds.size >= MAX_TRACE_NODES) {
        break;
      }
    }

    const coverage = readCoverage(db);
    const missingPaths = missingUnindexedPaths(db, coverage);
    const nodes = fetchNodeRows(db, [...includedNodeIds]);
    return {
      nodes: nodes
        .map(rowToNode)
        .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.spanId.localeCompare(right.spanId)),
      edges: [...includedEdgeIds]
        .map(edgeId => includedEdges.get(edgeId))
        .filter((edge): edge is EdgeRow => Boolean(edge))
        .map(rowToEdge)
        .sort((left, right) => right.confidence - left.confidence || left.sourceSpanId.localeCompare(right.sourceSpanId)),
      seedSpanIds,
      impactCoverage: coverage,
      missingUnindexedPaths: missingPaths,
      requiredActions: missingPaths.length > 0 ? ['promote missingUnindexedPaths with nl_refresh target="paths" before final impact claims'] : []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyTraceGraph('run nl_refresh before impact tracing', [`spans.db unreadable; run nl_refresh target="files" (${message})`]);
  } finally {
    db.close();
  }
}
