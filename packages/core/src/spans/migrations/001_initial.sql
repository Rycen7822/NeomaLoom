CREATE TABLE repo_files (
  path TEXT PRIMARY KEY,
  absolute_path TEXT NOT NULL,
  role TEXT NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  generated INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL
);

CREATE TABLE repo_spans (
  span_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER,
  end_column INTEGER,
  parent_span_id TEXT,
  language TEXT NOT NULL,
  heading_path_json TEXT NOT NULL,
  symbol_path_json TEXT NOT NULL,
  anchor TEXT,
  stable_locator_json TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  indexed_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repo_edges (
  edge_id TEXT PRIMARY KEY,
  source_span_id TEXT NOT NULL,
  target_span_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repo_evidence (
  evidence_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  quote_hash TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE refresh_revisions (
  graph_revision TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  target TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  span_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  warnings_json TEXT NOT NULL
);

CREATE TABLE index_metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE repo_spans_fts USING fts5(
  span_id,
  path,
  kind,
  role,
  label,
  heading_path,
  symbol_path,
  indexed_text,
  summary
);

CREATE INDEX repo_spans_path_idx ON repo_spans(path);
CREATE INDEX repo_spans_role_idx ON repo_spans(role);
CREATE INDEX repo_spans_kind_idx ON repo_spans(kind);
CREATE INDEX repo_edges_source_idx ON repo_edges(source_span_id);
CREATE INDEX repo_edges_target_idx ON repo_edges(target_span_id);
CREATE INDEX repo_files_role_idx ON repo_files(role);
