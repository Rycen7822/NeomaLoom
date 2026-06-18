import type { SpanKind } from './enums.js';

export type StableLocator = {
  path: string;
  kind: SpanKind;
  headingPath: string[];
  blockOrdinal: number;
  anchor?: string;
  normalizedTextHash: string;
  nearbyHeadingHash: string;
};

export function createStableLocator(input: StableLocator): StableLocator {
  return {
    path: input.path,
    kind: input.kind,
    headingPath: [...input.headingPath],
    blockOrdinal: input.blockOrdinal,
    anchor: input.anchor,
    normalizedTextHash: input.normalizedTextHash,
    nearbyHeadingHash: input.nearbyHeadingHash
  };
}
