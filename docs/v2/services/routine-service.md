# routine-service (v2)

## 1. Responsibility

Owns routines, versions, runs, the engine, the scheduler, the **domain registry and
catalog**, **templates**, **share/import**, and the built-in domains `routines` and
`scripting`. It orchestrates. It never stores domain data (tasks, money, …).

Engine changes are specified in [../06-engine.md](../06-engine.md). Registry rules in
[../04-domain-platform.md §4](../04-domain-platform.md).

## 2. Data

The engine migrations are listed in [../06-engine.md §13](../06-engine.md) (one file per work package, next free number). Additionally:

```sql
-- M10: share links
CREATE TABLE routine_shares (
  token        text PRIMARY KEY,            -- 256-bit random, base64url
  owner_id     uuid        NOT NULL,
  routine_id   uuid        NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  export       jsonb       NOT NULL,        -- the sanitised export document (§7)
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
```

## 3. HTTP API

New or changed endpoints. All v1 endpoints stay.

| Method & path | Milestone | Purpose |
| --- | --- | --- |
| `GET /api/v1/routines` | M1 | + `health` object per routine, `?areaId=`, `?origin=` |
| `POST /api/v1/routines/validate` | M2 | validate a `RoutineInput` without saving → `{ issues: string[], warnings: string[] }` |
| `GET /api/v1/routines/:id/versions` | M1 | list `{ version, createdAt, origin }` |
| `GET /api/v1/routines/:id/versions/:version` | M1 | full definition of that version |
| `POST /api/v1/routines/:id/versions/:version/restore` | M1 | new version equal to the old one |
| `POST /api/v1/routines/:id/skip-next` | M9 | skip the next scheduled slot (`{ skip: false }` undoes) |
| `POST /api/v1/routines/:id/pause` | M9 | `{ until: ISO }` or `{ until: null }` |
| `GET /api/v1/routines/:id/habit?days=90` | M5 | `{ days: [{ date, status }], current, best }`, status = `kept` / `missed` / `skipped` / `none` |
| `POST /api/v1/routines/:id/executions` | M3 | body may carry `{ inputs: {...} }` (validated against `inputs`) |
| `POST /api/v1/routines/test-step` | M1 | test one step ([../06-engine.md §12](../06-engine.md)) |
| `POST /api/v1/executions/:id/resume` | M1 | resume a failed run |
| `POST /api/v1/executions/:id/actions/:key/skip` | M3 | skip a waiting human step |
| `POST /api/v1/executions/:id/cancel` | M3 | cancel a running or waiting run: pending steps → `SKIPPED`, human items get `ActionCancelRequested { reason: 'runCancelled' }` (see note) |
| `GET /api/v1/catalog` | M2 | manifests, `enabled` flags, `ETag` |
| `GET /api/v1/action-types` | M2 | v1, now derived from the catalog |
| `GET /api/v1/templates` | M5 | cross-domain + manifest templates whose `requires` are enabled |
| `POST /api/v1/templates/:id/instantiate` | M5 | `{ answers, active: true }` → created routine |
| `GET /api/v1/routines/:id/export` | M10 | export document (§7) |
| `POST /api/v1/routines/import` | M10 | `{ document, answers?, preview?: true }` → preview or created routine |
| `POST /api/v1/routines/:id/share` | M10 | create a share link → `{ url }` |
| `DELETE /api/v1/shares/:token` | M10 | revoke |
| `GET /api/v1/shared/:token` | M10 | **public**, the export document (like `/hooks`, the token is the credential) |
| `GET /internal/v1/routines?trigger=event` | M4 | service token (trigger-service): active event-triggered routines for resync |
| `GET /api/v1/system/registry` | M2 | admin: domains, versions, heartbeats, rejections, usage counts |

**Cancel note:** a cancelled run gets status `FAILED` with `error_code = 'CANCELLED'` (stored
on the execution, `executions.error_code`) and `ExecutionFailed` is **not** published for
cancellations. It doesn't count for health and can't be resumed. In-flight worker steps become
`SKIPPED` (`user`), so their late results change nothing.

Routine DTO additions: `inputs`, `areaId`, `habit`, `alertAfterFailures`, `origin`,
`skipNext`, `pausedUntil`, `health: { consecutiveFailures, lastSuccessAt, lastFailureAt, runs30d, failures30d }`,
`domains: string[]` (domains its steps and trigger use, computed).

Execution DTO additions: `kind`, `routineVersion`, `resumeCount`, `inputs`, per action
`errorCode`, `skipReason`, `awaiting`, `acceptedAt`, `deadlineAt`, `wakeAt`.

## 4. Messages

| Direction | Message | Queue / exchange |
| --- | --- | --- |
| consumes | `RoutineTriggered` (own) | `routine-service.triggers` (v1) |
| consumes | action results incl. `ActionAwaitingUser` | `routine-service.action-results` (v1, binding `action.#` already covers it) |
| consumes | `DomainRegistered`, `DomainHeartbeat` | `routine-service.registry` |
| consumes | `StartRoutineRequested` | `routine-service.commands` |
| consumes | `profile.*`, `area.archived` | `routine-service.profile-events` → `owner_settings`, clear `routines.area_id` |
| produces | v1 messages, `ActionRequested` (+ `context`), `ActionCancelRequested`, `ExecutionResumed`, `ExecutionWaitingForYou`, `RoutineSaved`, `RoutineDeleted`, `RoutineUnhealthy` | outbox |
| produces | `TodayCardUpserted/Removed` (§6) | outbox → `today.cards` |

**Profile projection:** `owner_settings` is filled from `profile.updated`,
`profile.domainsChanged` and `profile.vacationChanged`. A missing row means defaults
(`Europe/Zurich`, `CHF`, `tasks,notifications` + always-on domains).

## 5. Manifests (built-in)

- `routines`: prefixes `routine`, `execution`: see [../06-engine.md §9](../06-engine.md).
- `scripting`: prefixes `variable`, `condition`, `math`, `flow`, `text`, `list`, `json`.

Both `optional: false`, registered in-process on startup.

**Cross-domain templates** (`src/domain/template-catalog.ts`), each with `requires`:

| Template | Requires | Setup questions |
| --- | --- | --- |
| Morning routine (checklist) | tasks | items (list), time |
| Plan my day | tasks | time |
| Shutdown | tasks | time |
| Weekly review | tasks | day, time |
| Monthly reset | tasks | – |
| Payday | budget, tasks | income threshold, savings % |
| Month-end check | budget, tasks, connections | e-mail |
| Subscription watch | budget, notifications | – |
| Birthday | people, tasks, budget | days before, gift budget |
| Low-energy day | health, tasks | threshold |
| Keep in touch | people, tasks | – |
| Chore rotation | home, tasks | – |
| Morning setup (v1) | connections, tasks | city, time |
| Weekly review (v1) | connections, tasks | city |
| Webhook inbox (v1) | notifications | – |

v1's demo routines (*Flaky Webhook, Load Test, Broken Endpoint, Heartbeat*) are **not**
templates any more. They move to `web/src/demo-scenarios.ts` (M1).

## 6. Today cards

See [../06-engine.md §11](../06-engine.md). Resync handler: republish `later:*` for
routines due later today and `unhealthy:*` for routines above their threshold.

## 7. Export format (M10)

```json
{
  "format": "routine-export/1",
  "name": "Payday", "description": "…", "icon": "wallet", "color": "teal",
  "trigger": { "type": "event", "event": "budget.incomeRecorded", "filter": [ … ] },
  "inputs": [ … ],
  "actions": [ … ],
  "requires": { "domains": ["budget", "tasks"], "connections": ["github"] },
  "setup": [ { "name": "categoryId_1", "label": "Category for step \"record\"", "type": "ref",
               "ref": { "domain": "budget", "collection": "categories" }, "path": "actions[1].params.categoryId" } ]
}
```

Sanitising rules on export: every literal `ref` param value (ids of lists, categories,
persons, routines, …) is replaced by a `{{setup.<name>}}` placeholder and listed in `setup`
(the importer answers it like a template question). `{{secrets.x}}` stays (the name only);
`requires.connections` lists the names. `areaId`, webhook tokens and anything owner-specific
are dropped.

## 8. Background jobs

| Job | Interval | Replica safety |
| --- | --- | --- |
| scheduler (v1 + §8 of engine) | 1 s | `SKIP LOCKED` |
| housekeeping: stale → WAITING (v1), expired human steps, due `flow.wait`, test-run cleanup | 2 s | `SKIP LOCKED` per row |
| health refresh (`runs_30d`, `failures_30d`) | nightly 03:00 UTC | advisory lock `hashtext('health-refresh')` |
| `later:*` cards refresh | every 5 min | advisory lock |
| registry staleness check | 30 s | idempotent |

## 9. Configuration

| Variable | Default | |
| --- | --- | --- |
| `MAX_EVENT_DEPTH` | 5 | refuse `StartRoutineRequested` deeper than this |
| `TEST_RUN_TTL_MS` | 3600000 | |
| `REGISTRY_STALE_AFTER_MS` | 90000 | |
| `SERVICE_TOKEN_SECRET` | – | own service account secret (calls to `/internal` endpoints elsewhere) |
| v1 variables | | unchanged |

## 10. Tests

- `progress.ts`: every row of the status tables in [../06-engine.md §1](../06-engine.md).
- Resume: failed middle step → resume → earlier outputs unchanged, failed step re-dispatched
  with the same `actionId`, condition-skipped steps stay skipped.
- Human step expiry with `skip` and `fail`; the race in [../05-messaging.md §5](../05-messaging.md) rule 4.
- Registry acceptance rules (every row of [../04-domain-platform.md §4.3](../04-domain-platform.md) and §5).
- Validation against the catalog (every row of [../06-engine.md §2.1](../06-engine.md)).
- Export sanitising: no uuid literals, no owner data in the document.
- Contract tests for every produced message.
