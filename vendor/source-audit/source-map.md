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
| tree-sitter | `reference/tree-sitter/README.md` | dependency role | Code parsing uses tree-sitter concepts and runtime bindings for robust AST extraction. |

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
