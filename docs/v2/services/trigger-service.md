# trigger-service (new, M4)

## 1. Responsibility

Starts routines when a domain event matches an event-triggered routine. It keeps its own
projection of subscriptions (from `routine.saved` / `routine.deleted`), consumes all domain
events, evaluates filters, applies loop protection, and sends `StartRoutineRequested`. It never
creates executions itself.

## 2. Data (`trigger-db`)

```sql
CREATE TABLE subscriptions (
  routine_id       uuid PRIMARY KEY,
  owner_id         uuid        NOT NULL,
  event_type       text,                                 -- NULL = tombstone (no event trigger any more, or deleted)
  filter           jsonb       NOT NULL DEFAULT '[]',     -- Condition[] (06-engine.md §2)
  routine_version  integer     NOT NULL,
  active           boolean     NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_match_idx ON subscriptions (owner_id, event_type) WHERE active;

CREATE TABLE match_log (                                      -- last 7 days, for the UI "Why did this run?"
  id              bigserial PRIMARY KEY,
  event_message_id uuid NOT NULL,
  routine_id      uuid NOT NULL,
  outcome         text NOT NULL,                              -- started | filtered | loop | inactive
  at              timestamptz NOT NULL DEFAULT now()
);
-- + outbox (service-kit)
```

## 3. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/triggers/log?routineId=` | last 50 match decisions for the owner's routine (routes via gateway prefix `/api/v1/triggers`) |
| `POST /internal/v1/resync` | service token (callers in `INTERNAL_CALLERS`): rebuild `subscriptions` from routine-service `GET /internal/v1/routines?trigger=event` |
| `POST /api/v1/triggers/resync` | the same for an admin, through the gateway (user tokens never open `/internal`) |

On startup, if `subscriptions` is empty, the service resyncs automatically.

## 4. Behaviour

**Projection** (queue `trigger-service.routines`): `RoutineSaved` → upsert when
`trigger.type = 'event'` and `routine_version` ≥ stored, else a tombstone (`event_type` NULL) with
that version. `RoutineDeleted` → a tombstone no save outranks. Tombstones keep a late, older
`RoutineSaved` from bringing a subscription back. **Resync** applies the list with the same rule
and removes rows the list lacks unless they changed after the list was requested.

**Matching** (queue `trigger-service.events`, prefetch 50):

1. Read `ownerId` and the event type (from the envelope `type`, the inverse of
   `eventTypeName` – a retried message comes back with the queue name as routing key). Load the
   subscriptions for `(ownerId, eventType)`; an inactive one logs `inactive`.
2. For each: evaluate `filter` against the event data with the **same operators** as
   `condition.if` (copy `evaluateCondition` semantics: numbers compare as numbers, `contains` is
   case-insensitive). Mismatch → log `filtered`.
3. **Loop protection:** if `origin.routineId = routine_id` → log `loop` (self-trigger). If
   `origin.depth ≥ MAX_EVENT_DEPTH` (5) → log `loop`.
4. Enqueue `StartRoutineRequested { routineId, ownerId, routineVersion, trigger: { type: 'event',
   event, eventMessageId, data }, idempotencyKey: 'event:' + messageId, depth: (origin.depth ?? 0) }`
   through the outbox, together with the `match_log` row, in one transaction.

Duplicate events produce duplicate `StartRoutineRequested` messages. routine-service
dedupes them by idempotency key (ADR-08).

Execution events (`execution.completed`, `execution.failed`) from `routine.events` are
handled identically. Their `origin` is derived: `{ routineId, depth: execution.depth + 1 }` (the
events carry the run's `depth`; + 1 like a domain event a step causes, so a chain of routines
starting on each other's failures stops at the same depth). A redelivered event is decided only
once: `match_log` is unique per `(event_message_id, routine_id)` and a start is sent only with a
new log row.

## 8. Configuration

`MAX_EVENT_DEPTH=5`, `ROUTINE_URL`, `SERVICE_TOKEN_SECRET`.

## 10. Tests

Filter semantics table (shared fixtures with routine-service `control.ts` tests). Self-trigger
dropped. Depth limit. Projection ignores an older `routine_version`. Two replicas never send
two starts for one event *that reach routine-service as two runs* (system test).
