export const CONFIDENCE_SCORES = {
  explicit_markdown_link: 1.0,
  exact_qualified_symbol_inline_code: 0.97,
  exact_config_cli_env_mention: 0.95,
  test_case_calls_source_symbol: 0.92,
  example_imports_or_calls_source_symbol: 0.9,
  rpg_feature_explicit_map: 0.88,
  exact_symbol_name_relevant_heading: 0.82,
  path_name_exact_relation: 0.75,
  call_neighborhood_overlap: 0.68,
  fuzzy_heading_symbol_relation: 0.6
} as const;

export type EvidenceKind = keyof typeof CONFIDENCE_SCORES | 'below_threshold';

export function confidenceForEvidence(kind: EvidenceKind): number {
  if (kind === 'below_threshold') {
    return 0;
  }
  return CONFIDENCE_SCORES[kind];
}

export function shouldWriteCandidate(candidate: { confidence: number }): boolean {
  return candidate.confidence >= 0.6;
}
