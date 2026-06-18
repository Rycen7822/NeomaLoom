import type { SpanKind } from './enums.js';

export type RelocatableSpan = {
  spanId: string;
  path: string;
  kind: SpanKind;
  textHash: string;
  anchor?: string;
  headingPath: string[];
  blockOrdinal: number;
  normalizedText: string;
  nearbyHeadingHash?: string;
};

export type RelocationMethod =
  | 'text_hash'
  | 'anchor_kind'
  | 'heading_block_kind'
  | 'heading_fuzzy_text'
  | 'nearest_heading_similarity';

export type RelocationResult =
  | {
      ok: true;
      method: RelocationMethod;
      spanId: string;
      span: RelocatableSpan;
    }
  | {
      ok: false;
      method: RelocationMethod;
      errorCode: 'ambiguous_span_relocation';
      candidateSpanIds: string[];
    }
  | {
      ok: false;
      errorCode: 'span_not_found_after_file_change';
    };

function sameHeadingPath(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.toLowerCase().split(/\W+/).filter(Boolean));
  const rightTokens = new Set(right.toLowerCase().split(/\W+/).filter(Boolean));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function resolveStep(
  method: RelocationMethod,
  matches: RelocatableSpan[]
): RelocationResult | undefined {
  if (matches.length === 1) {
    return {
      ok: true,
      method,
      spanId: matches[0].spanId,
      span: matches[0]
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      method,
      errorCode: 'ambiguous_span_relocation',
      candidateSpanIds: matches.map(span => span.spanId)
    };
  }

  return undefined;
}

function resolveHighestSimilarityStep(
  method: RelocationMethod,
  scoredMatches: Array<{ span: RelocatableSpan; score: number }>
): RelocationResult | undefined {
  if (scoredMatches.length === 0) {
    return undefined;
  }

  const sorted = [...scoredMatches].sort((left, right) => right.score - left.score);
  const bestScore = sorted[0].score;
  const bestMatches = sorted.filter(match => match.score === bestScore);

  if (bestMatches.length === 1) {
    return {
      ok: true,
      method,
      spanId: bestMatches[0].span.spanId,
      span: bestMatches[0].span
    };
  }

  return {
    ok: false,
    method,
    errorCode: 'ambiguous_span_relocation',
    candidateSpanIds: bestMatches.map(match => match.span.spanId)
  };
}

export function relocateSpan(previous: RelocatableSpan, candidates: RelocatableSpan[]): RelocationResult {
  const samePathCandidates = candidates.filter(candidate => candidate.path === previous.path);

  const textHash = resolveStep(
    'text_hash',
    samePathCandidates.filter(candidate => candidate.textHash === previous.textHash)
  );
  if (textHash) {
    return textHash;
  }

  const anchorKind = resolveStep(
    'anchor_kind',
    previous.anchor
      ? samePathCandidates.filter(
          candidate => candidate.anchor === previous.anchor && candidate.kind === previous.kind
        )
      : []
  );
  if (anchorKind) {
    return anchorKind;
  }

  const headingBlockKind = resolveStep(
    'heading_block_kind',
    samePathCandidates.filter(
      candidate =>
        sameHeadingPath(candidate.headingPath, previous.headingPath) &&
        candidate.blockOrdinal === previous.blockOrdinal &&
        candidate.kind === previous.kind
    )
  );
  if (headingBlockKind) {
    return headingBlockKind;
  }

  const headingFuzzyText = resolveStep(
    'heading_fuzzy_text',
    samePathCandidates.filter(
      candidate =>
        sameHeadingPath(candidate.headingPath, previous.headingPath) &&
        candidate.kind === previous.kind &&
        tokenSimilarity(candidate.normalizedText, previous.normalizedText) >= 0.72
    )
  );
  if (headingFuzzyText) {
    return headingFuzzyText;
  }

  const nearestHeadingSimilarity = resolveHighestSimilarityStep(
    'nearest_heading_similarity',
    previous.nearbyHeadingHash
      ? samePathCandidates
          .filter(
            candidate =>
              candidate.kind === previous.kind && candidate.nearbyHeadingHash === previous.nearbyHeadingHash
          )
          .map(candidate => ({
            span: candidate,
            score: tokenSimilarity(candidate.normalizedText, previous.normalizedText)
          }))
          .filter(candidate => candidate.score >= 0.5)
      : []
  );
  if (nearestHeadingSimilarity) {
    return nearestHeadingSimilarity;
  }

  return {
    ok: false,
    errorCode: 'span_not_found_after_file_change'
  };
}
