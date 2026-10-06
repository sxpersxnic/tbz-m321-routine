-- trigger-service (docs/v2/services/trigger-service.md §2): its projection of the event-triggered
-- routines (from RoutineSaved / RoutineDeleted) and the decisions it made, for "Why did this run?".

CREATE TABLE subscriptions (
  routine_id       uuid PRIMARY KEY,
  owner_id         uuid        NOT NULL,
  event_type       text        NOT NULL,
  filter           jsonb       NOT NULL DEFAULT '[]',     -- Condition[] (06-engine.md §2)
  routine_version  integer     NOT NULL,
  active           boolean     NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_match_idx ON subscriptions (owner_id, event_type) WHERE active;

-- last 7 days of match decisions
CREATE TABLE match_log (
  id               bigserial PRIMARY KEY,
  event_message_id uuid        NOT NULL,
  routine_id       uuid        NOT NULL,
  owner_id         uuid        NOT NULL,
  event_type       text        NOT NULL,
  outcome          text        NOT NULL CHECK (outcome IN ('started', 'filtered', 'loop', 'inactive')),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_log_routine_idx ON match_log (routine_id, at DESC);
-- one decision per event and routine: a redelivered event is decided again, not logged twice
CREATE UNIQUE INDEX match_log_event_routine_idx ON match_log (event_message_id, routine_id);
