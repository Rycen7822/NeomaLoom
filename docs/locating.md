# Locating

The context-preparation path normalizes goals into exact terms, symbols, paths, document terms, config terms, feature terms, old terms, new terms, and target roles.

Candidate sources are PureLex lexical routes over spans, code symbol/FQN/signature routes, import-alias routes, Markdown headings and anchors, config keys, tests and examples, feature projection, cross-reference edges, path-role expansion, and old-term sweeps. Route hits are merged into the existing candidate contract and ranked with bounded weighted reciprocal rank fusion plus the existing role, path, boundary, freshness, and link-confidence scores.

Cross-reference edge lookup is indexed once per candidate-generation pass so linked spans do not require filtering all edges for each span. This is a behavior-preserving performance seam; it must not be combined with ranking-weight changes.

Targets include decisions, score breakdowns, read ranges, linked spans, an EvidenceBundle, confidence, and edit risk. Compact output reports counts and essential target coordinates; standard output includes a bounded EvidenceBundle; debug output keeps full diagnostic details. The public MCP surface returns these through `nl_prepare_context` for task context and `nl_plan_change` for code or API impact planning.

Ranking/verifier behavior should change only with benchmark evidence. Tests should prefer ordering, decision, coverage, and verification behavior assertions over hard-coding incidental score breakdown details.
