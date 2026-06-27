# Data Model

NoemaLoom stores rebuildable derived state under `.noemaloom/`. The span database contains:

- `repo_files`: visible repository files, roles, language, hashes, generated/ignored flags, and metadata.
- `repo_spans`: file, code, doc, config, test, example, and feature spans with stable ids, line ranges, indexed text, metadata, and source.
- `repo_edges`: typed relations such as contains, mentions, tests, links, calls, imports, examples, and cross-reference edges.
- `repo_symbols`: PureLex symbol/FQN/signature records projected from code spans.
- `repo_symbol_aliases`: deterministic import alias records that point local aliases back to target symbol FQNs when resolution is provable.
- `repo_spans_fts`: local lexical search fields used by locator routes.
- `refresh_revisions` and `index_metadata`: coverage, graph revision, and retrieval-core status metadata.

Code spans carry boundary metadata (`boundaryMethod`, `boundaryComplete`, `boundaryReason`) so fallback-line symbols can be ranked more conservatively than parser-bounded TypeScript/Python blocks.

The code-fact database and PureLex retrieval tables are local derived state. They do not expose a writer surface, external vector store, ANN index, neural reranker, or LLM-generated query expansion. If a field looks unused, treat it as a reachability-review candidate first; deletion requires a focused compatibility check, not a line-count goal.
