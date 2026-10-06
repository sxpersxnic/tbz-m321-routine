-- Event-triggered runs (docs/v2/06-engine.md §11, 05-messaging.md §4.3): what started the run
-- (readable as {{trigger.event.<field>}}) and how deep in an event chain it is (loop protection).
ALTER TABLE executions ADD COLUMN trigger_event jsonb;
ALTER TABLE executions ADD COLUMN depth integer NOT NULL DEFAULT 0;
