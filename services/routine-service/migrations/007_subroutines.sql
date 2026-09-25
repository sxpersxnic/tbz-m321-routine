-- routine.run: an execution started by another routine's step. Its result goes back
-- to that step (parent_action_id); call_depth stops a routine from calling itself forever.
ALTER TABLE executions ADD COLUMN parent_action_id uuid;
ALTER TABLE executions ADD COLUMN parent_execution_id uuid;
ALTER TABLE executions ADD COLUMN call_depth integer NOT NULL DEFAULT 0;
