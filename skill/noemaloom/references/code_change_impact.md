# code_change_impact

Use this before code, API, config, symbol, or behavior changes.

1. Call `nl_prepare_context` with:
   - `goal`: the exact code or API change.
   - `targetRoles=["source_file","test_file","config_file","canonical_api_doc","readme_doc","example_doc","feature_plan"]`.
   - `limit=40`.
   - `budget=2048`.
   - `includeSnippets=false`.
   - `readTopSpans=false` unless current disk text is required before editing.
2. Call `nl_plan_change` with:
   - `target`: the symbol, file path, config key, or feature name being changed.
   - `goal`: the exact code or API change.
   - `targetType="auto"`.
   - `depth=2`.
   - `includeTrace=true`.
3. Inspect returned `impact.requiredVerification`, source, test, config, doc, example, and feature groups before editing.
4. Edit files only with native Codex or Hermes tools.
5. Run the project test command that protects the changed behavior.
6. Call `nl_verify_task` with:
   - `goal`: the exact code or API change.
   - `target`: the same anchor passed to `nl_plan_change`.
   - `targetType="auto"`.
   - `changedPaths`: every edited repository-relative path.
   - `oldTerms`: removed or renamed terms, or `[]`.
   - `newTerms`: required replacement terms, or `[]`.
7. Continue only when tests pass and `nl_verify_task` returns `status="pass"`.
8. Call `nl_refresh` with `target="changed"` and `mode="safe"` after verification passes.
