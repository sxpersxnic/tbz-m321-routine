-- "Ask when run?" (docs/v2/06-engine.md §2, §3): a manual routine's questions, and a run's answers
-- (readable as {{input.<name>}}).
ALTER TABLE routines ADD COLUMN inputs jsonb;
ALTER TABLE executions ADD COLUMN inputs jsonb;
