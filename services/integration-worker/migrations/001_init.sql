-- Integration Worker: shared idempotency store of all worker replicas.
-- A replica "claims" an action with a lease before calling the external
-- service; completed actions are never executed again, only their stored
-- result is re-published.

CREATE TABLE action_executions (
  action_id     uuid PRIMARY KEY,
  execution_id  uuid        NOT NULL,
  action_type   text        NOT NULL,
  status        text        NOT NULL,          -- IN_PROGRESS | COMPLETED
  output        jsonb,
  attempts      integer     NOT NULL DEFAULT 1,
  processed_by  text        NOT NULL,
  lease_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
