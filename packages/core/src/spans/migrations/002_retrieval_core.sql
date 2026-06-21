CREATE TABLE repo_symbols (
  symbol_fqn TEXT PRIMARY KEY,
  span_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  parent_symbol_fqn TEXT,
  module_path TEXT NOT NULL,
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  deprecated INTEGER NOT NULL DEFAULT 0,
  deprecated_message TEXT,
  superseded_by TEXT,
  metadata_json TEXT NOT NULL
);

CREATE INDEX repo_symbols_name_idx ON repo_symbols(symbol_name);
CREATE INDEX repo_symbols_path_idx ON repo_symbols(path);
CREATE INDEX repo_symbols_module_idx ON repo_symbols(module_path);
CREATE INDEX repo_symbols_parent_idx ON repo_symbols(parent_symbol_fqn);
CREATE INDEX repo_symbols_span_idx ON repo_symbols(span_id);

CREATE TABLE repo_symbol_aliases (
  alias_fqn TEXT PRIMARY KEY,
  target_fqn TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL
);

CREATE INDEX repo_symbol_aliases_target_idx ON repo_symbol_aliases(target_fqn);
CREATE INDEX repo_symbol_aliases_path_idx ON repo_symbol_aliases(path);
CREATE INDEX repo_symbol_aliases_kind_idx ON repo_symbol_aliases(alias_kind);
