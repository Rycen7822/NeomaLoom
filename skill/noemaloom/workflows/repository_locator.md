# repository_locator

1. Call `nl_status` with `includeRepositoryMap=true`.
2. If indexes are missing or stale, call `nl_refresh` with `target="all"` and `mode="safe"`.
3. Call `nl_locate` with explicit `targetRoles` for the task.
4. Read every `must_edit` target with `nl_read_span`.
5. Edit files with native Codex or Hermes tools.
6. Call `nl_verify_coverage` with `changedPaths`, `oldTerms`, and `newTerms`.
7. Call `nl_refresh` with `target="changed"` and `mode="safe"` after coverage passes.
