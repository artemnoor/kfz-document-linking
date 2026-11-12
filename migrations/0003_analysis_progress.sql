CREATE TABLE IF NOT EXISTS analysis_progress (
  payload_hash TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL
);
