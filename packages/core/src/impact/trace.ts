import { createRequire } from 'node:module';
import path from 'node:path';

import type { EdgeRelation, FileRole, SpanKind } from '../spans/enums.js';

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
  indexed_text: string;
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

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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

function readGraphRows(projectRoot: string): { spans: SpanRow[]; edges: EdgeRow[] } {
  const db = openDatabase(path.join(projectRoot, '.noemaloom', 'spans', 'spans.db'));
  try {
    const spans = db
      .prepare(
        `SELECT span_id, path, kind, role, label, start_line, end_line, heading_path_json,
                symbol_path_json, indexed_text, summary, metadata_json
         FROM repo_spans
         ORDER BY path ASC, start_line ASC, span_id ASC`
      )
      .all() as SpanRow[];
    const edges = db
      .prepare(
        `SELECT edge_id, source_span_id, target_span_id, relation, confidence, source, evidence_json
         FROM repo_edges
         ORDER BY confidence DESC, source_span_id ASC, target_span_id ASC`
      )
      .all() as EdgeRow[];
    return { spans, edges };
  } finally {
    db.close();
  }
}

function searchable(row: SpanRow): string {
  return [
    row.span_id,
    row.path,
    row.kind,
    row.role,
    row.label,
    row.symbol_path_json,
    row.indexed_text,
    row.summary,
    row.metadata_json
  ]
    .join('\n')
    .toLowerCase();
}

function resolveSeedSpanIds(spans: SpanRow[], target: string, targetType = 'auto'): string[] {
  const normalizedTarget = target.toLowerCase();
  const matches = spans.filter(row => {
    if (targetType === 'span') return row.span_id === target;
    if (targetType === 'file') return row.path === target;
    if (targetType === 'feature') return row.kind.startsWith('feature.') && searchable(row).includes(normalizedTarget);
    if (targetType === 'config') return row.kind.startsWith('config.') && searchable(row).includes(normalizedTarget);
    if (targetType === 'doc') return row.kind.startsWith('doc.') && searchable(row).includes(normalizedTarget);
    return row.span_id === target || row.path === target || searchable(row).includes(normalizedTarget);
  });
  return matches.map(row => row.span_id);
}

function relationAllowed(edge: EdgeRow, relationTypes: string[]): boolean {
  return relationTypes.length === 0 || relationTypes.includes('all') || relationTypes.includes(edge.relation);
}

export function traceGraph(input: {
  projectRoot: string;
  target: string;
  targetType?: string;
  direction?: TraceDirection;
  depth?: number;
  relationTypes?: string[];
}): TraceGraph {
  const { spans, edges } = readGraphRows(input.projectRoot);
  const spansById = new Map(spans.map(span => [span.span_id, span]));
  const relationTypes = input.relationTypes ?? ['all'];
  const allowedEdges = edges.filter(edge => relationAllowed(edge, relationTypes));
  const seedSpanIds = resolveSeedSpanIds(spans, input.target, input.targetType);
  const includedNodeIds = new Set(seedSpanIds);
  const includedEdgeIds = new Set<string>();
  let frontier = new Set(seedSpanIds);

  for (let step = 0; step < (input.depth ?? 2); step += 1) {
    const next = new Set<string>();
    for (const edge of allowedEdges) {
      const useDownstream = (input.direction ?? 'both') !== 'upstream' && frontier.has(edge.source_span_id);
      const useUpstream = (input.direction ?? 'both') !== 'downstream' && frontier.has(edge.target_span_id);
      if (useDownstream) {
        includedEdgeIds.add(edge.edge_id);
        includedNodeIds.add(edge.target_span_id);
        next.add(edge.target_span_id);
      }
      if (useUpstream) {
        includedEdgeIds.add(edge.edge_id);
        includedNodeIds.add(edge.source_span_id);
        next.add(edge.source_span_id);
      }
    }
    frontier = next;
    if (frontier.size === 0) {
      break;
    }
  }

  return {
    nodes: [...includedNodeIds]
      .map(spanId => spansById.get(spanId))
      .filter((row): row is SpanRow => Boolean(row))
      .map(rowToNode)
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine || left.spanId.localeCompare(right.spanId)),
    edges: allowedEdges
      .filter(edge => includedEdgeIds.has(edge.edge_id))
      .map(rowToEdge)
      .sort((left, right) => right.confidence - left.confidence || left.sourceSpanId.localeCompare(right.sourceSpanId)),
    seedSpanIds
  };
}
