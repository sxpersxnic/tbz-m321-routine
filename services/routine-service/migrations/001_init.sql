-- Routine Service owns routine definitions and their executions.
-- No other service reads or writes this database.

CREATE TABLE routines (
  id           uuid PRIMARY KEY,
  owner_id     uuid        NOT NULL,
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  trigger      jsonb       NOT NULL,
  actions      jsonb       NOT NULL,
  active       boolean     NOT NULL DEFAULT false,
  next_run_at  timestamptz,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routines_owner_idx ON routines (owner_id, created_at DESC);
CREATE INDEX routines_due_idx ON routines (next_run_at) WHERE active AND next_run_at IS NOT NULL;

CREATE TABLE executions (
  id               uuid PRIMARY KEY,
  routine_id       uuid        NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  owner_id         uuid        NOT NULL,
  routine_name     text        NOT NULL,
  trigger_type     text        NOT NULL,
  scheduled_for    timestamptz,
  idempotency_key  text,
  status           text        NOT NULL,
  current_step     integer     NOT NULL DEFAULT 0,
  correlation_id   text        NOT NULL,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- a scheduled slot can only ever produce one execution, even with several scheduler replicas
  UNIQUE (routine_id, scheduled_for),
  -- client retries of POST .../executions with the same Idempotency-Key do not start a second run
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX executions_owner_idx ON executions (owner_id, created_at DESC);
CREATE INDEX executions_routine_idx ON executions (routine_id, created_at DESC);

-- One row per action of an execution. The id is the actionId that travels with
-- every message and serves as idempotency key in the worker services.
CREATE TABLE execution_actions (
  id               uuid PRIMARY KEY,
  execution_id     uuid        NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  key              text        NOT NULL,
  type             text        NOT NULL,
  step             integer     NOT NULL,
  position         integer     NOT NULL,
  params           jsonb       NOT NULL,
  resolved_params  jsonb,
  status           text        NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  output           jsonb,
  error            text,
  processed_by     text,
  dispatched_at    timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, key)
);
CREATE INDEX execution_actions_dispatched_idx ON execution_actions (dispatched_at) WHERE status = 'DISPATCHED';

CREATE TABLE execution_log (
  id            bigserial PRIMARY KEY,
  execution_id  uuid        NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text        NOT NULL,
  action_key    text,
  message       text        NOT NULL
);
CREATE INDEX execution_log_execution_idx ON execution_log (execution_id, id);

-- Transactional outbox: messages are written in the same transaction as the
-- state change and published asynchronously by the relay.
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  message_id      uuid        NOT NULL UNIQUE,
  exchange        text        NOT NULL,
  routing_key     text        NOT NULL,
  payload         jsonb       NOT NULL,
  trace_headers   jsonb       NOT NULL DEFAULT '{}',
  correlation_id  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
