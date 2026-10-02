-- "Wait" steps (flow.wait, docs/v2/06-engine.md §9): a SCHEDULED step sleeps until wake_at; the
-- housekeeping loop completes the due ones.
ALTER TABLE execution_actions ADD COLUMN wake_at timestamptz;
CREATE INDEX execution_actions_wake_idx ON execution_actions (wake_at) WHERE status = 'SCHEDULED';
