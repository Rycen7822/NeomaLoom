# Troubleshooting

## Missing Indexes

Run `nl_status`, then `nl_refresh` with `target="all"` and `mode="safe"`.

## Stale Spans

Rerun `nl_prepare_context` with `readTopSpans=true`; it reads current disk content and reports relocation metadata. After coverage passes, run `nl_refresh` with `target="changed"` and `mode="safe"`.

## Failed Coverage

Check `remainingOldTermHits`, `brokenLinks`, `staleAnchors`, `unsyncedDocRoles`, `codeDocMismatches`, and `unverifiedLinkedTests`. Fix all reported arrays before treating the task as complete.

## Worker Warnings

Feature projection warnings do not stop the MCP server. The graph still includes deterministic spans from files that were indexed successfully.
