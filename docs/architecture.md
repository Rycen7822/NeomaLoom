# Architecture

NoemaLoom is a local MCP server with a small agent-facing surface and richer internal derived state. Runtime tools return a uniform envelope with graph state, warnings, evidence, and token-budget metadata.

## Layers

1. **Inventory and safety layer**: discovers repository files, applies ignore/generated/vendor policy, and writes only project-local derived state under `.noemaloom/`.
2. **Extraction layer**: extracts code, document, artifact, test, example, and feature spans. Extractors are deterministic and bounded; they do not call an LLM.
3. **Graph layer**: stores spans, files, edges, symbol tables, import aliases, retrieval-core fields, coverage metadata, and refresh revisions.
4. **Tool layer**: exposes status, refresh, context preparation, impact planning, verification, and controlled navigation-anchor curation.

## Public and internal surfaces

The public MCP surface stays intentionally small: `nl_status`, `nl_refresh`, `nl_prepare_context`, `nl_plan_change`, `nl_verify_task`, and `nl_anchor_manage`. Fine-grained primitives remain internal so agents get stable workflow-level tools instead of raw backend handles.

NoemaLoom does not edit repository source files. Agents use native editing tools after NoemaLoom identifies likely spans and verification targets. Public tools may write only derived project state: refresh caches under `.noemaloom/` and navigation workset state under `.noemaloom/workset/`.

## Contract boundaries

TypeScript is the implementation source of truth. The Hermes Python plugin mirrors the public tool schema and routes calls to the local NoemaLoom runtime. Schema/default parity and install provenance hashes are contract checks: if copied plugin schema or build artifacts drift from their recorded metadata, bridge calls should warn and the plugin should be re-synced.
