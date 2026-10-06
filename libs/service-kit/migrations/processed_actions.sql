-- Idempotency of domain capabilities (docs/v2/04-domain-platform.md §3.3): the result an action
-- produced, so a redelivered command re-sends it instead of running the handler again. `result` is
-- the data of the result message that was sent (ActionCompleted or ActionAwaitingUser).
CREATE TABLE processed_actions (
  action_id   uuid PRIMARY KEY,
  result      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
