---
name: noemaloom
description: "Use when Codex needs NoemaLoom repository modification support to prepare context, plan code or documentation impact, synchronize documents, recover after context compression, or verify edits. Read before repository-wide localization, Markdown updates, code or API changes, multi-document sync, or post-edit coverage checks; load the routed references and call only nl_status, nl_refresh, nl_prepare_context, nl_plan_change, and nl_verify_task."
---

# NoemaLoom

NoemaLoom locates and verifies spans. Codex or Hermes edits files with native tools. NoemaLoom does not write project source files, global agent config, Git hooks, or agent caches.

## Tool Boundary

Only call these public MCP tools:

- `nl_status`
- `nl_refresh`
- `nl_prepare_context`
- `nl_plan_change`
- `nl_verify_task`

Do not call fine-grained internal primitives or raw backend tools. They are not part of the MCP surface.

## Reference Routing

Load references in the listed order when multiple apply:

1. Context compression recovery or resume from partial context: `references/compression_recovery.md`
2. Generic repository localization or unclear edit target: `references/repository_locator.md`
3. Markdown, docs, README, tutorial, or example update: `references/markdown_update.md`
4. Code, API, config, or symbol impact planning: `references/code_change_impact.md`
5. Multi-document synchronization or old-term sweep: `references/multi_doc_sync.md`
6. After any file edit: `references/coverage_verification.md`

Read only the references that match the active task. If the task changes, load the newly relevant reference before continuing.

## Execution Rules

1. Start with `nl_status`; refresh with `nl_refresh` only when indexes are missing, stale, or after verification passes.
2. Use `nl_prepare_context` before selecting files or spans to inspect.
3. Use `nl_plan_change` before code, API, config, or symbol changes.
4. Edit only with native Codex or Hermes file tools.
5. Use `nl_verify_task` after edits and continue only when it returns `status="pass"`.
6. Call `nl_refresh` with `target="changed"` and `mode="safe"` after coverage passes.
