CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'completed', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_chunk_count INTEGER NOT NULL,
  progress_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at_ms INTEGER,
  last_error TEXT,
  run_id TEXT,
  result_json TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS analysis_jobs_status_idx ON analysis_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS analysis_job_payload_chunks (
  job_id TEXT NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  payload_text TEXT NOT NULL,
  PRIMARY KEY(job_id, chunk_index)
);
