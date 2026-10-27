-- The pipeline's own record of when it ran.
--
-- The VM is stopped between work sessions to save cost, and the worker used to time its next run from the moment it booted, so
-- a VM that never stayed up for a whole interval never ran the pipeline. With this record the worker can see how long ago
-- the last successful run was, and catch up at start when that is older than the interval.
--
-- Run once on a database created from an older schema.sql:
--   psql "$DATABASE_URL" -f migrations/005_pipeline_runs.sql
-- It only adds a table, so nothing existing is touched, and running it again changes nothing.
BEGIN;

-- Pipeline catch-up: one row per run of the pipeline.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          bigserial   PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('ok', 'failed')),
  stored      integer     CHECK (stored >= 0),  -- articles stored by a run that went through; null for a failure
  error       text,                             -- why a run failed
  CHECK (finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS pipeline_runs_ok_idx ON pipeline_runs (started_at DESC) WHERE outcome = 'ok';

COMMIT;
