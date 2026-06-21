# MCP Tools

- `nl_status`: reports index state and safety flags. Pass `includeAnchors: true` when an agent needs project-local navigation anchor workset status.
- `nl_refresh`: rebuilds derived indexes.
- `nl_prepare_context`: prepares task context by combining discovery, target ranking, context assembly, and optional top-span reads. It also supports `responseProfile: "navigation"` for short anchor-card output.
- `nl_plan_change`: combines target ranking, relation tracing, and impact grouping before code or API changes.
- `nl_verify_task`: verifies changed files after edits and can attach impact context when a target is supplied.
- `nl_anchor_manage`: compact controlled curation tool for common project-local navigation anchor maintenance. It supports only `action="promote"` and `action="demote"`.

All tools are read-only with respect to project source files except `nl_refresh`, which writes derived cache files under `.noemaloom/`, and `nl_anchor_manage`, which writes only controlled project-local navigation state under `.noemaloom/workset/`. Fine-grained primitives remain internal implementation details and are not listed by the MCP server. Low-frequency navigation anchor `repair`, `retire`, and `checkpoint` operations are CLI-only through `noemaloom anchor repair|retire|checkpoint` so they do not occupy agent tool schemas by default.
