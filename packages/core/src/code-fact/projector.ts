import type { CodeFactEdge, CodeFactSpan } from './extractor.js';

export type ProjectedCodeFacts = {
  spans: CodeFactSpan[];
  edges: CodeFactEdge[];
};

export function projectCodeFacts(input: ProjectedCodeFacts): ProjectedCodeFacts {
  return input;
}
