# Data Model

The span database stores:

- `repo_files`: visible repository files, roles, language, hashes, and metadata.
- `repo_spans`: file, code, doc, config, test, example, and feature spans.
- `repo_edges`: typed relations such as contains, mentions, tests, links, calls, imports, and examples.
- `repo_symbols`: PureLex symbol/FQN/signature records projected from code spans.
- `repo_symbol_aliases`: deterministic import alias records that point local aliases back to target symbol FQNs.
- `refresh_revisions`: graph revision records.
- `index_metadata`: coverage and retrieval-core status metadata.
- `repo_spans_fts`: lexical search fields.

Spans have stable ids, line ranges, role, kind, heading path, symbol path, text hash, indexed text, metadata, and source. Code spans carry boundary metadata (`boundaryMethod`, `boundaryComplete`, `boundaryReason`) so fallback-line symbols can be ranked more conservatively than parser-bounded TypeScript/Python blocks.

PureLex tables are rebuildable derived state. They do not introduce a public writer, external vector store, ANN index, neural reranker, or LLM-generated query expansion.
