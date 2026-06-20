# MCP Tools

- `nl_status`: reports index state and safety flags.
- `nl_refresh`: rebuilds derived indexes.
- `nl_prepare_context`: prepares task context by combining discovery, target ranking, context assembly, and optional top-span reads. It also supports `responseProfile: "navigation"` for short anchor-card output.
- `nl_plan_change`: combines target ranking, relation tracing, and impact grouping before code or API changes.
- `nl_verify_task`: verifies changed files after edits and can attach impact context when a target is supplied.
- `nl_anchor_status`: inspects project-local navigation anchors, lifecycle counters, budgets, and rendered cards.
- `nl_anchor_promote`: promotes a path/span into the project-local navigation anchor pool through a controlled operation.
- `nl_anchor_demote`: demotes an existing anchor to `dormant` or `archived`.
- `nl_anchor_repair`: repairs an existing anchor path, label, kind, role, or line range.
- `nl_anchor_retire`: tombstones an obsolete anchor so future locator hits do not revive it.
- `nl_anchor_checkpoint`: updates project-local navigation checkpoint metadata, including explicit pre-LLM injection enablement.

All tools are read-only with respect to project source files except `nl_refresh`, which writes derived cache files under `.noemaloom/`, and controlled `nl_anchor_*` curation tools, which write only project-local navigation state under `.noemaloom/workset/`. Fine-grained primitives remain internal implementation details and are not listed by the MCP server.
