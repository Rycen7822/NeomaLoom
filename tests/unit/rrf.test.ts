import { weightedReciprocalRankScore } from '../../packages/core/src/locator/rrf.js';

describe('weighted reciprocal rank fusion', () => {
  it('combines deterministic route ranks with a hard score cap', () => {
    expect(weightedReciprocalRankScore([
      { route: 'code_symbol_name_signature', rank: 1, weight: 8 },
      { route: 'fts_lexical', rank: 2, weight: 4 },
      { route: 'cross_reference_edge', rank: 4, weight: 2 }
    ])).toBe(23);
    expect(weightedReciprocalRankScore([{ route: 'many', rank: 1, weight: 100 }])).toBe(24);
  });
});
