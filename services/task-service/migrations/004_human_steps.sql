-- Human steps (docs/v2/services/task-service.md §2, M3): a task.await step creates a task of kind
-- `step`, tied to the routine step that waits for it. Ticking it completes the step; an expired or
-- cancelled step leaves it CANCELLED. Steps of one run form a checklist (step_group = executionId).
ALTER TABLE tasks ADD COLUMN kind text NOT NULL DEFAULT 'task';        -- task | step
ALTER TABLE tasks ADD COLUMN source_routine_id uuid;
ALTER TABLE tasks ADD COLUMN source_routine_name text;
ALTER TABLE tasks ADD COLUMN awaiting_action_id uuid UNIQUE;
ALTER TABLE tasks ADD COLUMN step_group text;
ALTER TABLE tasks ADD COLUMN step_position integer;
-- status: OPEN | DONE | CANCELLED
