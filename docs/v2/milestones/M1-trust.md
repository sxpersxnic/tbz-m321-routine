# M1 – Trust

**Goal:** make reliability visible. A failed run can be resumed, every failure explains
itself, every routine shows its health, every edit can be undone, and dead letters can be
replayed from the UI.

**You'll see:** *Retry from here* on a failed run · *"The website said this page doesn't
exist"* · *"28 of 28 this month"* on tiles · History with *Restore* · *Try this step* ·
Dead letters with *Replay* · Demo scenarios on Infrastructure.

**Specs:** [06-engine.md §6, §7, §10, §12](../06-engine.md) · [02-experience.md §4, §5, §7, §8, §16](../02-experience.md) ·
[services/routine-service.md](../services/routine-service.md) · [services/gateway.md](../services/gateway.md)

---

- [x] **M1-01 · Demo scenarios leave the gallery**
  - Move *Flaky Webhook, Heartbeat, Load Test, Broken Endpoint* from `web/src/templates.ts`
    to `web/src/demo-scenarios.ts`. Render them on `System.tsx` under *Demo scenarios* with
    *Create & run* and a one-line "demonstrates …". Update `docs/demo.md` references if the
    v2 branch changes the demo flow (v1 docs stay untouched on `main`).
  - Done when: the template gallery shows only user templates. Demo scenarios still work.

- [x] **M1-02 · Failure explanations (web)**
  - `web/src/lib/failure-copy.ts`: map `errorCode` → sentence + action ([02 §8](../02-experience.md)).
    Run detail and run rows show the sentence. The raw error moves under *Under the hood*.
  - `types.ts`: `ErrorCode`, `errorCode` on `ExecutionAction`.
  - Done when: each code has a rendered example in a failure fixture. axe clean.

- [x] **M1-03 · Skip reasons**
  - Migration: `execution_actions.skip_reason` + backfill ([06 §13](../06-engine.md)). Engine sets
    `condition` / `failure`. DTO exposes `skipReason`.
  - Tests: both reasons set correctly in `scripting.test.ts`-style engine tests.

- [x] **M1-04 · Resume (engine + API)**
  - `POST /api/v1/executions/:id/resume` per [06 §6](../06-engine.md). Migration: `executions.resume_count`.
    Message `ExecutionResumed` (schema + AsyncAPI + contract test).
  - notification-service consumes `execution.resumed` (binding on
    `notification-service.execution-events`) and sets `resolved_at` on the failure
    notification of that execution (migration in notification-service).
  - Tests: [services/routine-service.md §10](../services/routine-service.md) resume cases.
    System test: Broken Endpoint-like routine whose URL is fixed via mock-external, then resumed.

- [ ] **M1-05 · Resume (web)**
  - Run detail: failure card with *Retry from here* and *Edit step* ([02 §7](../02-experience.md)).
    *Resumed N×* marker. Optimistic status → Running.

- [ ] **M1-06 · Versions (engine + API)**
  - Migration: `routine_versions` + backfill, `executions.routine_version`. Every
    version-bumping store function inserts a version row in the same transaction.
  - Endpoints: list, get, restore ([services/routine-service.md §3](../services/routine-service.md)).
  - Tests: restore creates version n+1 equal to the old definition. Runs record their version.

- [ ] **M1-07 · History page and diff (web)**
  - `web/src/lib/diff.ts` ([07 §8](../07-web.md)) with `node --test` fixtures. Route
    `#/routines/:id/history`. *History* in the routine `…` menu. Run detail links *version 7*.

- [ ] **M1-08 · Routine health (engine + API)**
  - Migration: health columns and `alert_after_failures` ([06 §13](../06-engine.md)). Engine updates
    counters. Nightly refresh job with advisory lock. `RoutineUnhealthy` event (schema,
    contract test). `health` in the routine DTO.
  - notification-service consumes `routine.unhealthy` → high-priority notification.
  - Tests: counter transitions, event once per streak.

- [ ] **M1-09 · Routine health (web)**
  - Tile health line, detail *Health* row, setting *Tell me after N failures in a row* on the
    settings page ([02 §4, §5](../02-experience.md)).

- [ ] **M1-10 · Test a step (engine + API)**
  - `executions.kind`, `POST /api/v1/routines/test-step`, test-run exclusion from lists, stats,
    health, events. Cleanup job. In M1 only **engine** capabilities and values that the
    **integration-worker** marks side-effect-free (`weather.get`, `summary.generate`) run.
    Everything else is `SKIPPED` with `skip_reason = 'test'`. M2 generalises this via manifests.
  - `ActionRequested.context.mode = 'test'` from here on.
  - Tests: test runs never appear in `GET /executions` or stats. Cleanup after TTL.

- [ ] **M1-11 · Test a step (web)**
  - *Try this step* on eligible step cards. Inline result. Example values in token pills from
    the last real run (`GET /executions?routineId=&limit=1` → output lookup).

- [ ] **M1-12 · Dead letters (gateway + web)**
  - Gateway admin endpoints ([services/gateway.md](../services/gateway.md)): list, replay, discard.
    Port the logic of `scripts/replay-dlq.sh` exactly (peek → publish → remove, abort on a
    concurrent change).
  - Web: *Dead letters* section on Infrastructure with human labels per queue, expandable raw
    message, *Replay*, *Discard* (confirm dialog). Hidden for non-admins.
  - System test: the v1 breaking-change demo (`scripts/demo.sh evolution`) ends with a UI-driven
    replay instead of the script (keep the script).

**Milestone done when:** all packages ticked, the M1 demo works end to end: break a routine,
see the explanation, fix the step, *Retry from here*, see it complete. Restore an old version.
Replay a dead letter from the UI.
