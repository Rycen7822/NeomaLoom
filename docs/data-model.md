# Data Model

The span database stores:

- `repo_files`: visible repository files, roles, language, hashes, and metadata.
- `repo_spans`: file, code, doc, config, test, example, and feature spans.
- `repo_edges`: typed relations such as contains, mentions, tests, links, and examples.
- `refresh_revisions`: graph revision records.
- `repo_spans_fts`: lexical search fields.

Spans have stable ids, line ranges, role, kind, heading path, symbol path, text hash, indexed text, metadata, and source.
