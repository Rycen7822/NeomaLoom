import { relocateSpan, type RelocatableSpan } from '../../packages/core/src/spans/relocation.js';

const previous: RelocatableSpan = {
  spanId: 'old',
  path: 'docs/api/client.md',
  kind: 'doc.paragraph',
  textHash: 'text-old',
  anchor: 'client-options',
  headingPath: ['Client API', 'Options'],
  blockOrdinal: 4,
  normalizedText: 'client options configure retries',
  nearbyHeadingHash: 'heading-a'
};

describe('span relocation', () => {
  it('uses text hash before later relocation methods for moved spans', () => {
    const result = relocateSpan(previous, [
      {
        ...previous,
        spanId: 'anchor-match',
        textHash: 'text-new'
      },
      {
        ...previous,
        spanId: 'text-match'
      }
    ]);

    expect(result).toMatchObject({
      ok: true,
      method: 'text_hash',
      spanId: 'text-match'
    });
  });

  it('falls back to anchor and kind before heading/block matches', () => {
    const result = relocateSpan(previous, [
      {
        ...previous,
        spanId: 'heading-match',
        textHash: 'text-new',
        anchor: 'changed-anchor'
      },
      {
        ...previous,
        spanId: 'anchor-match',
        textHash: 'text-newer',
        blockOrdinal: 9
      }
    ]);

    expect(result).toMatchObject({
      ok: true,
      method: 'anchor_kind',
      spanId: 'anchor-match'
    });
  });

  it('returns ambiguous_span_relocation for multiple matches at the same step', () => {
    const result = relocateSpan(previous, [
      { ...previous, spanId: 'candidate-a' },
      { ...previous, spanId: 'candidate-b' }
    ]);

    expect(result).toEqual({
      ok: false,
      errorCode: 'ambiguous_span_relocation',
      method: 'text_hash',
      candidateSpanIds: ['candidate-a', 'candidate-b']
    });
  });

  it('uses the highest unique nearest-heading similarity match after earlier methods fail', () => {
    const result = relocateSpan(previous, [
      {
        ...previous,
        spanId: 'lower-similarity',
        textHash: 'changed-a',
        anchor: 'changed-a',
        headingPath: ['Client API', 'Moved'],
        blockOrdinal: 8,
        normalizedText: 'client options retries'
      },
      {
        ...previous,
        spanId: 'highest-similarity',
        textHash: 'changed-b',
        anchor: 'changed-b',
        headingPath: ['Client API', 'Moved'],
        blockOrdinal: 9,
        normalizedText: 'client options configure retries timeout'
      }
    ]);

    expect(result).toMatchObject({
      ok: true,
      method: 'nearest_heading_similarity',
      spanId: 'highest-similarity'
    });
  });

  it('returns span_not_found_after_file_change when no relocation candidate matches', () => {
    const result = relocateSpan(previous, [
      {
        ...previous,
        spanId: 'other',
        path: 'docs/api/other.md',
        textHash: 'other-text',
        anchor: 'other-anchor',
        headingPath: ['Other'],
        blockOrdinal: 1,
        normalizedText: 'unrelated text'
      }
    ]);

    expect(result).toEqual({
      ok: false,
      errorCode: 'span_not_found_after_file_change'
    });
  });
});
