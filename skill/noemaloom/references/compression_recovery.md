# compression_recovery

Use this after context compression, session resume, or loss of prior target details.

1. Call `nl_status` with `includeRepositoryMap=true`.
2. If indexes are missing or stale, call `nl_refresh` with `target="all"` and `mode="safe"` before rebuilding task context.
3. Call `nl_prepare_context` with:
   - `goal`: the current active user goal.
   - `limit=10`.
   - `budget=1024`.
   - `includeSnippets=false`.
   - `readTopSpans=false`.
4. Continue from returned `targets` and `context.suggestedReadOrder`.
5. If prior spans are stale or unavailable, rerun `nl_prepare_context` with the same `goal` and a larger `limit`.
6. Do not report completion from recovered context alone. After any edit, read `references/coverage_verification.md` and run `nl_verify_task`.
