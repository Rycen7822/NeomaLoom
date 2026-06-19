# repository_locator

1. Call `nl_status` with `includeRepositoryMap=true`.
2. If indexes are missing or stale, call `nl_refresh` with `target="all"` and `mode="safe"`.
3. Call `nl_prepare_context` with explicit `targetRoles` for the task and enable top-span reads when source text is needed.
4. Inspect every `must_edit` target returned by the prepared context.
5. Edit files with native Codex or Hermes tools.
6. Call `nl_verify_task` with `changedPaths`, `oldTerms`, and `newTerms`.
7. Call `nl_refresh` with `target="changed"` and `mode="safe"` after coverage passes.
