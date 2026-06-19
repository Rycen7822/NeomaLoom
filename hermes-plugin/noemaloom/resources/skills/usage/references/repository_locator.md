# repository_locator

Use this for generic repository localization when the task has an unclear edit target or spans multiple surfaces.

1. Call `nl_status` with `includeRepositoryMap=true`.
2. If any required index is missing or stale, call `nl_refresh` with `target="all"` and `mode="safe"`.
3. Call `nl_prepare_context` with:
   - `goal`: the exact task objective.
   - `targetRoles`: explicit role strings for the task, such as `source_file`, `test_file`, `config_file`, `canonical_api_doc`, `readme_doc`, `example_doc`, or `feature_plan`.
   - `limit=20`; use `limit=40` for broad multi-surface tasks.
   - `budget=2048`.
   - `includeSnippets=false`.
   - `readTopSpans=true` only when current disk text is needed before editing.
   - `maxReadSpans=3` and `contextLines=10` when `readTopSpans=true`.
4. Inspect returned `targets` in order. Handle every `decision="must_edit"` target and any `decision="maybe_edit"` target whose reason matches the task.
5. Edit files only with native Codex or Hermes tools.
6. Call `nl_verify_task` with:
   - `goal`: the same task objective.
   - `changedPaths`: every edited repository-relative path.
   - `oldTerms`: removed or renamed terms, or `[]`.
   - `newTerms`: required replacement terms, or `[]`.
   - `target`: the symbol, file, or feature anchor when one exists.
7. Continue only when `nl_verify_task` returns `status="pass"`.
8. Call `nl_refresh` with `target="changed"` and `mode="safe"` after verification passes.
