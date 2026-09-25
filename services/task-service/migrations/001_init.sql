-- Task Service owns tasks. Tasks created by a routine remember the action that
-- created them; the unique constraint makes processing an action idempotent.

CREATE TABLE tasks (
  id                   uuid PRIMARY KEY,
  owner_id             uuid        NOT NULL,
  title                text        NOT NULL,
  description          text        NOT NULL DEFAULT '',
  priority             text        NOT NULL DEFAULT 'normal',
  status               text        NOT NULL DEFAULT 'OPEN',
  due_date             date,
  source_action_id     uuid UNIQUE,
  source_execution_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX tasks_owner_idx ON tasks (owner_id, created_at DESC);
