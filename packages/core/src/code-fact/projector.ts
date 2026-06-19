import type { CodeFactEdge, CodeFactSpan } from './extractor.js';

export type ProjectedCodeFacts = {
  spans: CodeFactSpan[];
  edges: CodeFactEdge[];
};

function byStableSpanOrder(left: CodeFactSpan, right: CodeFactSpan): number {
  return (
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine ||
    (left.startColumn ?? 0) - (right.startColumn ?? 0) ||
    left.kind.localeCompare(right.kind) ||
    left.label.localeCompare(right.label) ||
    left.spanId.localeCompare(right.spanId)
  );
}

function byStableEdgeOrder(left: CodeFactEdge, right: CodeFactEdge): number {
  return (
    left.sourceSpanId.localeCompare(right.sourceSpanId) ||
    left.relation.localeCompare(right.relation) ||
    left.targetSpanId.localeCompare(right.targetSpanId) ||
    left.edgeId.localeCompare(right.edgeId)
  );
}

export function projectCodeFacts(input: ProjectedCodeFacts): ProjectedCodeFacts {
  return {
    spans: [...new Map(input.spans.sort(byStableSpanOrder).map(span => [span.spanId, span])).values()],
    edges: [...new Map(input.edges.sort(byStableEdgeOrder).map(edge => [edge.edgeId, edge])).values()]
  };
}
