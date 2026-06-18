# NoemaLoom

Use NoemaLoom for repository-wide modification localization, impact tracing, and post-edit coverage verification.

NoemaLoom locates and verifies spans. Codex or Hermes edits files with native tools. NoemaLoom does not write project source files, global agent config, Git hooks, or agent caches.

## Workflows

- `repository_locator`: status, refresh if needed, locate targets, read spans, edit natively, verify coverage, refresh changed indexes.
- `markdown_update`: locate docs with related code/config/examples/features, read canonical docs first, edit complete Markdown blocks, verify old terms and links.
- `code_change_impact`: locate code/tests/config/docs/examples/features, trace impact, read affected spans, run native tests, verify coverage.
- `multi_doc_sync`: process canonical API docs, README, quickstart, tutorial, examples, paper, design, and changelog roles as a group.
- `coverage_verification`: run `nl_verify_coverage` on changed paths with old and new terms before refreshing changed indexes.
- `compression_recovery`: call `nl_status`, use `nl_context`, and continue from existing target spans.

## Tool Surface

The exposed tools are `nl_skill`, `nl_status`, `nl_refresh`, `nl_query`, `nl_locate`, `nl_context`, `nl_read_span`, `nl_trace`, `nl_impact`, and `nl_verify_coverage`.

There are no writer tools. Use native Codex or Hermes editing commands after NoemaLoom identifies spans.
