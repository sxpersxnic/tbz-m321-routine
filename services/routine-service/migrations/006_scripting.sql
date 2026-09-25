-- Scripting (conditions and loops) on the actions of an execution.
-- run_if:   {"action": "<key of a condition.if>", "is": true|false} – otherwise the action is SKIPPED
-- for_each: "{{…}}" reference to a list – the action is expanded into one child row per item
-- parent_id / loop_item / loop_index: such a child row, with the item it works on
ALTER TABLE execution_actions ADD COLUMN run_if jsonb;
ALTER TABLE execution_actions ADD COLUMN for_each text;
ALTER TABLE execution_actions ADD COLUMN parent_id uuid REFERENCES execution_actions (id) ON DELETE CASCADE;
ALTER TABLE execution_actions ADD COLUMN loop_item jsonb;
ALTER TABLE execution_actions ADD COLUMN loop_index integer;
