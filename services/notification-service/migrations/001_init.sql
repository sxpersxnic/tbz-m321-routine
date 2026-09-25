-- Notification Service owns the user's notification inbox.
-- source_key identifies the message a notification originates from and makes
-- processing idempotent (actionId for actions, execution:<id>:<event> for events).

CREATE TABLE notifications (
  id            uuid PRIMARY KEY,
  owner_id      uuid        NOT NULL,
  title         text        NOT NULL,
  body          text        NOT NULL DEFAULT '',
  priority      text        NOT NULL DEFAULT 'normal',
  category      text        NOT NULL,
  source_key    text        NOT NULL UNIQUE,
  execution_id  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notifications_owner_idx ON notifications (owner_id, created_at DESC);
