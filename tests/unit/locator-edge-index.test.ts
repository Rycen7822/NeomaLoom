import { describe, expect, it } from 'vitest';

import { buildLinkedSpanIndex } from '../../packages/core/src/locator/edge-index.js';

describe('locator edge index', () => {
  it('indexes cross-reference edges from both directions with deterministic ordering', () => {
    const index = buildLinkedSpanIndex([
      { source_span_id: 'a', target_span_id: 'b', relation: 'references', confidence: 0.6 },
      { source_span_id: 'c', target_span_id: 'a', relation: 'calls', confidence: 0.9 },
      { source_span_id: 'a', target_span_id: 'd', relation: 'contains', confidence: 0.9 }
    ]);

    expect(index.get('a')).toEqual([
      { spanId: 'c', confidence: 0.9, relation: 'calls' },
      { spanId: 'd', confidence: 0.9, relation: 'contains' },
      { spanId: 'b', confidence: 0.6, relation: 'references' }
    ]);
    expect(index.get('b')).toEqual([{ spanId: 'a', confidence: 0.6, relation: 'references' }]);
  });
});
