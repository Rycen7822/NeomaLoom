# NoemaLoom Source Audit Map

This file records reference sources inspected for NoemaLoom and whether each
source is reference-only, planned for a narrow port, or explicitly cropped.

## Reference Sources

| source | files or evidence | status | NoemaLoom use |
|---|---|---|---|
| CodeGraph | `reference/codegraph/README.md`, `reference/codegraph/src/mcp/tools.ts`, `reference/codegraph/package.json` | ported selectively | Local tree-sitter, SQLite, FTS, symbol, reference, caller, callee, impact ideas become NoemaLoom code facts projected into `RepoSpan` and `RepoEdge`. |
| RPG-ZeroRepo | `reference/RPG-ZeroRepo/README.md` | ported selectively | Repository Planning Graph semantics inform the restricted feature projection worker. |
| MCP TypeScript SDK | `reference/typescript-sdk/README.md`, `reference/typescript-sdk/package.json` | reference-only | NoemaLoom uses a small MCP adapter boundary and locks the chosen package during implementation. |
| remark | `reference/remark/packages/remark-parse/readme.md` | dependency role | Markdown parsing uses the unified/remark mdast pipeline for document spans. |
| MDX | `reference/mdx/packages/remark-mdx/readme.md` | dependency role | MDX syntax parsing uses `remark-mdx`; NoemaLoom does not compile or render MDX. |
| tree-sitter | `reference/tree-sitter/README.md` | dependency role | Code parsing keeps a `tree-sitter-loader` boundary and uses tree-sitter concepts; Phase 8 does not load WASM runtimes. |

## Locked Implementation Packages

- MCP server package: `@modelcontextprotocol/server@2.0.0-alpha.2` from `package-lock.json`.
- Required MCP runtime peer: `@cfworker/json-schema@4.1.1` from `package-lock.json`.
- MCP input schema package: `zod@4.4.3` from `package-lock.json`.
- MCP SDK imports are restricted to `packages/core/src/mcp/sdk.ts`.
- The selected MCP package exports `McpServer` and `StdioServerTransport` from the main package entry; `@modelcontextprotocol/server/stdio` is not an exported subpath in this lock.
- Markdown parser stack: `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`, and `mdast-util-to-string@4.0.0` from `package-lock.json`.
- MDX parser package: `remark-mdx@3.1.1` from `package-lock.json`; NoemaLoom parses and degrades MDX blocks but does not compile or render MDX.

## Cropped Upstream Behaviors

The following upstream behaviors are forbidden in NoemaLoom:

- installer
- uninstaller
- agent configuration writer
- hooks
- raw tools
- writer
- codegen
- branch workflow
- Docker runner
- long-term memory
- experiment ledger
- claim ledger

## Porting Rule

Every ported reference file must be copied or adapted only after a focused audit
entry is added here. The audit entry must name the source file, the destination
file, the retained behavior, and the cropped behavior.

## Focused Port Entries

| upstream source | NoemaLoom destination | retained behavior | cropped behavior |
|---|---|---|---|
| `reference/codegraph/src/types.ts` | `packages/core/src/code-fact/extractor.ts`, `packages/core/src/code-fact/reference-resolver.ts` | Code node and edge vocabulary mapped into NoemaLoom `code.*` span kinds and `calls`/`imports`/`contains` edges. | CodeGraph raw node IDs, raw MCP result shapes, and non-NoemaLoom edge kinds are not exposed. |
| `reference/codegraph/src/db/schema.sql` | `packages/core/src/code-fact/codegraph-db.ts` | Local SQLite fact tables and FTS symbol/name/signature search idea. | `.codegraph/` storage, CodeGraph schema migrations, daemon-owned DB lifecycle, and raw CodeGraph query tables are not copied. |
| `reference/codegraph/src/extraction/languages/typescript.ts` | `packages/core/src/code-fact/extractor.ts` | Symbol/import/call extraction categories for TypeScript/JavaScript plus method/property distinction awareness. | CodeGraph tree-sitter WASM runtime, full AST walkers, installer asset copying, and language-specific generated code are not copied. |
| `reference/codegraph/src/resolution/import-resolver.ts` | `packages/core/src/code-fact/reference-resolver.ts` | Import and name-based reference resolution into graph edges. | Workspace alias caches, filesystem probing outside inventory, and raw unresolved-reference tables are not copied. |
| `reference/codegraph/src/graph/queries.ts` | `packages/core/src/code-fact/code-fact-indexer.ts` | Query surface idea for searchable symbols and edge-backed context. | Raw `codegraph_*` MCP tools, context prose formatting, explore tool output, and aggressive agent instructions are not copied. |
