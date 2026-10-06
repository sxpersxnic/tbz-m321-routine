-- Resume from the failed step (docs/v2/06-engine.md §6): how often a run was resumed.
ALTER TABLE executions ADD COLUMN resume_count integer NOT NULL DEFAULT 0;
