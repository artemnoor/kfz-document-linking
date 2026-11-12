ALTER TABLE linking_runs ADD COLUMN idempotency_key TEXT;
ALTER TABLE linking_runs ADD COLUMN payload_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS linking_runs_idempotency_idx ON linking_runs(idempotency_key);
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
