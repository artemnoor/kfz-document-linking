CREATE TABLE IF NOT EXISTS linking_runs (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  input_documents_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES linking_runs(id) ON DELETE CASCADE,
  source_document_id TEXT NOT NULL,
  target_document_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_run_idx ON links(run_id);
