# MCP Tools

- `nl_skill`: returns workflow guidance.
- `nl_status`: reports index state and safety flags.
- `nl_refresh`: rebuilds derived indexes.
- `nl_query`: exploratory span search without edit decisions.
- `nl_locate`: ranks edit and verification targets.
- `nl_context`: returns compact task context using locator results.
- `nl_read_span`: reads bounded current-disk span content with relocation.
- `nl_trace`: returns typed graph edges around a target.
- `nl_impact`: groups impacted code, docs, config, tests, examples, and features.
- `nl_verify_coverage`: verifies changed files after edits.

All tools are read-only with respect to project source files except `nl_refresh`, which writes derived cache files under `.noemaloom/`.
