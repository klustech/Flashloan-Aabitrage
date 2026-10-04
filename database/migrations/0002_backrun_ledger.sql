BEGIN;
CREATE TABLE IF NOT EXISTS backrun_records (
  id UUID PRIMARY KEY,
  trigger_hash TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DETECTED','POST_TRIGGER_QUOTED','FUNDING_SELECTED','SIMULATED','REJECTED','SUBMITTED','INCLUDED','REVERTED','DROPPED')),
  mode TEXT NOT NULL CHECK (mode IN ('PAPER','LIVE')),
  parent_block BIGINT,
  target_block BIGINT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS backrun_records_recent ON backrun_records(updated_at DESC);
CREATE INDEX IF NOT EXISTS backrun_records_trigger ON backrun_records(trigger_hash);
CREATE TABLE IF NOT EXISTS backrun_benchmarks (
  id UUID PRIMARY KEY,
  profile_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMIT;
