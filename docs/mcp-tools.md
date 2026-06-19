# MCP Tools

- `nl_status`: reports index state and safety flags.
- `nl_refresh`: rebuilds derived indexes.
- `nl_prepare_context`: prepares task context by combining discovery, target ranking, context assembly, and optional top-span reads.
- `nl_plan_change`: combines target ranking, relation tracing, and impact grouping before code or API changes.
- `nl_verify_task`: verifies changed files after edits and can attach impact context when a target is supplied.

All tools are read-only with respect to project source files except `nl_refresh`, which writes derived cache files under `.noemaloom/`. Fine-grained primitives remain internal implementation details and are not listed by the MCP server.
