# Architecture

NoemaLoom is a local MCP server with a read-only agent-facing surface. Runtime tools return a uniform envelope with graph state, warnings, evidence, and token budget metadata.

The system has four layers:

1. File inventory and safe state paths under `.noemaloom/`.
2. Span extraction for code, documents, artifacts, tests, examples, and feature records.
3. Graph construction with cross-reference edges and a derived repository map.
4. MCP tools for status, refresh, context preparation, impact planning, and task verification.

NoemaLoom does not edit repository files. Agents use native editing tools after NoemaLoom identifies spans.
