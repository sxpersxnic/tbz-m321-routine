-- Routine health (docs/v2/06-engine.md §10): counters updated when a run finishes, the 30-day
-- counts also recomputed nightly (runs age out). alert_after_failures: publish routine.unhealthy
-- after that many failures in a row (null = never).
ALTER TABLE routines ADD COLUMN alert_after_failures integer DEFAULT 2;
ALTER TABLE routines ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN last_success_at timestamptz;
ALTER TABLE routines ADD COLUMN last_failure_at timestamptz;
ALTER TABLE routines ADD COLUMN runs_30d integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN failures_30d integer NOT NULL DEFAULT 0;

-- when replica-safe periodic jobs last ran (the nightly health refresh)
CREATE TABLE job_runs (
  name         text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL
);

-- start from the history there is
UPDATE routines r SET
  runs_30d = s.runs, failures_30d = s.failures, last_success_at = s.last_success, last_failure_at = s.last_failure
  FROM (SELECT routine_id,
               count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS runs,
               count(*) FILTER (WHERE created_at > now() - interval '30 days' AND status = 'FAILED')::int AS failures,
               max(finished_at) FILTER (WHERE status = 'COMPLETED') AS last_success,
               max(finished_at) FILTER (WHERE status = 'FAILED') AS last_failure
          FROM executions WHERE status IN ('COMPLETED', 'FAILED') GROUP BY routine_id) s
 WHERE r.id = s.routine_id;
