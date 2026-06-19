# compression_recovery

1. Call `nl_status` with `includeRepositoryMap=true`.
2. Call `nl_prepare_context` with the active goal, `budget=1024`, and `includeSnippets=false`.
3. Continue from prior target spans when available.
4. Rerun `nl_prepare_context` for the active goal only when prior target spans are unavailable or stale.
