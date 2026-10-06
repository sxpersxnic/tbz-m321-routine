# M4 – Event triggers

**Goal:** routines start when something happens in any domain, with filters and loop
protection, through a new trigger-service.

**You'll see:** *When?* → *Event* → *Tasks · a task is completed · list is "Work"* · a routine
that runs when another routine fails · *Why did this run?* on event-started runs.

**Specs:** [services/trigger-service.md](../services/trigger-service.md) · [05-messaging.md §4.2–4.4](../05-messaging.md) ·
[06-engine.md §2](../06-engine.md) · [04-domain-platform.md §3.5](../04-domain-platform.md) · [02-experience.md §6](../02-experience.md)

---

- [x] **M4-01 · Contracts**
  - Schemas: `RoutineSaved`, `RoutineDeleted`, `StartRoutineRequested`, and the generic domain
    event envelope (`domain-event.v1.schema.json`: `ownerId`, `occurredAt`, optional `areaId`,
    `origin`). One schema per task event type, extending it.

- [x] **M4-02 · routine-service: event trigger definition + routine events**
  - `TriggerDefinition` `event` with `filter` ([06 §2](../06-engine.md)), validated against the
    catalog's triggers. Emit `RoutineSaved` / `RoutineDeleted` from every relevant write (outbox).
    `GET /internal/v1/routines?trigger=event` (service token).
  - Built-in manifest `routines` declares triggers `execution.completed`, `execution.failed`.

- [x] **M4-03 · routine-service: start command consumer**
  - Queue `routine-service.commands`. Handle `StartRoutineRequested`: checks
    ([05 §4.3](../05-messaging.md)), `createExecution` with trigger `event`, idempotency key,
    `trigger_event` stored, `executions.depth`. Template root `trigger.event.<field>`.
  - Tests: duplicate command → one execution. Inactive routine → dropped. Stale version whose
    trigger changed → dropped.

- [x] **M4-04 · trigger-service: scaffold**
  - The full [10-quality.md §5](../10-quality.md) checklist (default compose profile, gateway route
    `/api/v1/triggers`). Queues `trigger-service.events` and `trigger-service.routines` in
    `definitions.json`. Service account `trigger-service` (it calls routine-service `/internal`).

- [x] **M4-05 · trigger-service: projection + resync**
  - `subscriptions` from `RoutineSaved`/`RoutineDeleted`, version rule, automatic resync on an
    empty table, `POST /internal/v1/resync`.

- [ ] **M4-06 · trigger-service: matching**
  - Filter evaluation (shared fixture file `contracts/fixtures/conditions.json` used by both
    routine-service `control.ts` tests and trigger-service tests), loop protection, outbox,
    `match_log`, `GET /api/v1/triggers/log`.

- [ ] **M4-07 · `origin` on domain events**
  - Kit `emitEvent` sets `origin` automatically when called from a capability handler
    (`context.depth + 1`, `executionId`, `routineId`, `actionId`). HTTP-caused events have no
    origin.
  - Tests: a routine that creates a task in list X, triggered by `task.created` in list X →
    runs once, then `loop` in the match log.

- [ ] **M4-08 · Web: event trigger editor**
  - [07 §5.6](../07-web.md). Pills `{{trigger.event.<field>}}`. Routine tiles and hero show the
    trigger sentence (*"When a task is completed in Work"*). Run detail shows *Started by
    "task completed: Write report"* and a *Why did this run?* disclosure from the match log.

**Milestone done when:** the demo *"When a task in Work is completed → notify me"* works, a
self-triggering routine is stopped by loop protection and says so, and killing trigger-service
during a burst of completions loses no start (events wait in its queue).
