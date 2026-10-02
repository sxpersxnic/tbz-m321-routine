-- "Try this step" (docs/v2/06-engine.md §12): test runs live next to real ones but are left out of
-- lists, stats, health and events, and deleted after an hour.
ALTER TABLE executions ADD COLUMN kind text NOT NULL DEFAULT 'live';   -- live | test
CREATE INDEX executions_test_idx ON executions (created_at) WHERE kind = 'test';
