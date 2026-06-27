export type EdgeIndexRow = {
  source_span_id: string;
  target_span_id: string;
  relation: string;
  confidence: number;
};

export type LinkedSpan = {
  spanId: string;
  confidence: number;
  relation?: string;
};

function addLinkedSpan(index: Map<string, LinkedSpan[]>, spanId: string, linked: LinkedSpan): void {
  const current = index.get(spanId);
  if (current) {
    current.push(linked);
    return;
  }
  index.set(spanId, [linked]);
}

export function buildLinkedSpanIndex(edges: readonly EdgeIndexRow[]): Map<string, LinkedSpan[]> {
  const index = new Map<string, LinkedSpan[]>();
  for (const edge of edges) {
    addLinkedSpan(index, edge.source_span_id, {
      spanId: edge.target_span_id,
      confidence: edge.confidence,
      relation: edge.relation
    });
    addLinkedSpan(index, edge.target_span_id, {
      spanId: edge.source_span_id,
      confidence: edge.confidence,
      relation: edge.relation
    });
  }
  for (const linked of index.values()) {
    linked.sort((left, right) => right.confidence - left.confidence || left.spanId.localeCompare(right.spanId));
  }
  return index;
}
