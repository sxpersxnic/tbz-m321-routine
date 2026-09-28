# 06 – Routine engine v2

Changes to the orchestration core in `services/routine-service/src/` (`engine.ts`,
`domain/progress.ts`, `domain/definition.ts`, `domain/templates.ts`, `scheduler.ts`). The
engine keeps its v1 guarantees: one transaction per transition, execution row locked,
messages only through the outbox, pure state machine (`progress.ts`) fully unit-tested.

---

## 1. Statuses

```text
Execution:   PENDING ─▶ RUNNING ─▶ COMPLETED
                          │ ▲
                          ▼ │
             WAITING (worker slow/retrying) · WAITING_FOR_YOU (person) · DELAYED (timer)
                          │
                          ▼
                        FAILED ──resume──▶ RUNNING
Action:      PENDING ─▶ DISPATCHED ─▶ COMPLETED
                          ├─▶ RETRYING ─▶ DISPATCHED
                          ├─▶ AWAITING_USER ─▶ COMPLETED | SKIPPED (expired) | FAILED (expired, then: fail)
                          └─▶ FAILED ──resume──▶ PENDING
             PENDING ─▶ SCHEDULED (flow.wait) ─▶ COMPLETED
             PENDING ─▶ SKIPPED (condition false · earlier failure · test mode)
```

| Execution status | New? | Meaning | User-facing words |
| --- | --- | --- | --- |
| `PENDING` | | created, not started | Starting |
| `RUNNING` | | steps in flight | Running |
| `WAITING` | | a worker is retrying or hasn't answered in `WAITING_AFTER_MS` | Waiting · *{Domain} is catching up* |
| `WAITING_FOR_YOU` | new | only human steps are in flight | Waiting for you |
| `DELAYED` | new | only `flow.wait` steps are in flight | Waiting until {time} |
| `COMPLETED` | | all steps done | Done |
| `FAILED` | | a step failed | Failed · *{plain-language reason}* |

| Action status | New? | Meaning |
| --- | --- | --- |
| `AWAITING_USER` | new | the domain created a human item and is waiting for the person |
| `SCHEDULED` | new | a `flow.wait` step sleeps until `wake_at` |

### 1.1 `decideNext` (pure)

In-flight statuses become `DISPATCHED | RETRYING | AWAITING_USER | SCHEDULED`. Everything
else is unchanged: any `FAILED` → fail; any in flight → wait; no `PENDING` → complete; else
dispatch the lowest pending step.

### 1.2 `inFlightStatus` (pure)

Given the in-flight actions of the current step:

1. any `RETRYING`, or `DISPATCHED` older than `waitingAfterMs` → `WAITING`
2. else any `DISPATCHED` → `RUNNING`
3. else any `AWAITING_USER` → `WAITING_FOR_YOU`
4. else (only `SCHEDULED`) → `DELAYED`

`markStaleExecutionsWaiting` (store.ts) keeps its query. It only looks at `DISPATCHED`
actions and `RUNNING` executions, so it never touches `WAITING_FOR_YOU` or `DELAYED`.

---

## 2. Routine definition v2

`domain/definition.ts` additions (all optional, so v1 routines stay valid):

```ts
export type TriggerDefinition =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string; timezone: string; skip?: ScheduleSkip }
  | { type: 'webhook' }
  | { type: 'event'; event: string; filter?: Condition[] }          // new
  | { type: 'sun'; event: 'sunrise' | 'sunset'; offsetMinutes: number; location: GeoPoint }; // new

export interface ScheduleSkip { holidays?: string; /* e.g. 'CH-ZH' */ weeks?: 'odd' | 'even' }
export interface Condition { field: string; operator: ConditionOperator; value?: unknown } // operators from control.ts
export interface GeoPoint { name: string; lat: number; lon: number }

export interface RoutineInputSpec {                                   // "Ask when run?"
  name: string;                    // ^[a-z][a-zA-Z0-9]*$
  label: string;
  type: 'text' | 'number' | 'date' | 'choice' | 'ref';
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  ref?: { domain: string; collection: string };
}

export interface ActionDefinition {
  key: string; type: string; step: number; params: Record<string, unknown>;
  runIf?: RunIf; forEach?: string;
  timeout?: { after: string; then: 'skip' | 'fail' };                // new – human steps only, ISO 8601 duration
}

export interface RoutineDefinition extends Appearance {
  name: string; description: string; trigger: TriggerDefinition; actions: ActionDefinition[];
  inputs?: RoutineInputSpec[];     // manual (and routine.run-called) routines only
  areaId?: string | null;
  habit?: boolean;                 // shown as a habit (requires schedule or sun trigger)
  alertAfterFailures?: number | null; // publish routine.unhealthy after N consecutive failures (default 2; null = never)
  origin?: 'user' | 'repeat' | 'template' | 'import' | 'assistant';
}
```

Limits (v1 had 20 actions): **30 actions**, **10 inputs**, **5 filter conditions**.

### 2.1 Validation against the registry

`validateRoutine(input, catalog, profile)` gets the current catalog (§4 of
[04](04-domain-platform.md)) and the owner's profile projection:

| Rule | Issue text |
| --- | --- |
| type is known (current manifest, deprecated allowed) | `action "x": unknown type "y"` |
| type's domain is enabled for the owner | `action "x": {Domain} is turned off` |
| required params present, `choice` values valid, literal numbers/dates well-formed | as v1 |
| `ref` literal is a uuid | `action "x": "{param}" must be a {collection} id` |
| `{{secrets.*}}` only inside params listed in `acceptsSecrets` | `action "x": secrets are not allowed in "{param}"` |
| `timeout` only on `kind: 'human'` capabilities | `action "x": only steps you do yourself can time out` |
| `event` trigger: event type is a known trigger; filter fields exist in its `fields` | `unknown event` / `unknown field` |
| `inputs` only with `manual` trigger (routine.run may pass them too) | `questions are only asked when a routine is run by hand` |
| `habit` only with `schedule` or `sun` | `a habit needs a schedule` |
| v1 rules (earlier-steps-only references, loop rules, variables, …) | unchanged |

`POST /api/v1/routines/validate` runs the same function without saving (used by the editor
and the assistant).

---

## 3. Template scope v2

| Root | Content | New? |
| --- | --- | --- |
| `actions.<key>.<field>` | outputs of earlier steps | |
| `vars.<name>` | variables | |
| `routine`, `execution`, `now` | as v1 | |
| `trigger.body` | webhook body | |
| `trigger.event.<field>` | the event's fields (event trigger) | new |
| `input.<name>` | run inputs; `{{input}}` alone = whole input (v1 `routine.run` semantics) | extended |
| `item`, `index` | loop item | |
| `today` | the owner's local date, `YYYY-MM-DD` | new |
| `secrets.<name>` | **not resolved by the engine**: kept literally for the worker | new |

`templatePaths` treats `secrets.*` like any other root for validation but `resolveTemplates`
leaves the `{{secrets.x}}` text untouched. `resolved_params` therefore never contain a
secret.

---

## 4. Dispatch changes

`#advance` → `dispatch` branch, per action:

1. Built-in capability (domain `scripting` or `routines`, `runsIn: engine`) → evaluate
   in-transaction as in v1. New built-ins: §9.
2. Test run (`execution.kind = 'test'`): send only `value` capabilities and `action` with
   `preview`; mark others `SKIPPED` (`skip_reason = 'test'`).
3. Domain disabled for the owner → `FAILED` with `NOT_AVAILABLE` (no dispatch).
4. Otherwise enqueue `ActionRequested` with `context` (`mode`, `timezone`, `currency`,
   `routineName`, `stepIndex`, `stepCount`, `depth = execution.depth`, `areaId`).

## 5. Human steps

1. The domain answers `ActionAwaitingUser`. `applyResult` gets a new kind `awaiting`:
   status → `AWAITING_USER`, store `awaiting` (jsonb) and `accepted_at`; if the definition has
   `timeout`, set `deadline_at = accepted_at + after`. Log: *"Waiting for you: {title}"*.
2. `#advance` → `wait` → `inFlightStatus` → `WAITING_FOR_YOU`. When the execution *enters*
   `WAITING_FOR_YOU`, enqueue `ExecutionWaitingForYou` and upsert the run's Today card (§11).
3. Completion arrives as a normal `ActionCompleted` → v1 path.
4. **Expiry:** the housekeeping loop (every 2 s, replica-safe with `FOR UPDATE SKIP LOCKED`)
   selects `AWAITING_USER` actions with `deadline_at < now()`. For each: lock the execution,
   mark `SKIPPED` (`skip_reason = 'expired'`) or `FAILED` (`AWAIT_EXPIRED`), enqueue
   `ActionCancelRequested { reason: 'expired' }`, then `#advance`.
5. **Manual skip** (`POST /api/v1/executions/:id/actions/:key/skip`) does the same with
   `skip_reason = 'user'`.

## 6. Resume from the failed step

`POST /api/v1/executions/:id/resume` (owner only; execution must be `FAILED`):

1. Lock execution. Find the failed action (top-level, or the failed loop child together with
   its parent).
2. Reset it to `PENDING` (same `id`: workers' idempotency stores only remember *completed*
   actions, so a failed one runs again; external services see the same idempotency key).
   Keep `attempts`. Clear `error`, `error_code`, `finished_at`. A reset step that still exists
   in the routine with the same key and type takes its **current** params (a loop child: its
   loop's params; a top-level step also its `runIf`/`forEach`), so *Edit step* followed by
   *Retry from here* runs the fixed step. Steps added to the routine since the run started are
   not added to it.
3. Reset every action with `skip_reason = 'failure'` (skipped because of this failure) to
   `PENDING`. Actions skipped by a condition keep `SKIPPED`.
4. Execution → `RUNNING`, clear `error`, `finished_at`. Increment `resume_count`. Log
   `RESUMED`. Enqueue `ExecutionResumed`. A later failure publishes `ExecutionFailed` with
   `resumeCount`, so consumers keep one notification per failure.
5. `#advance`.

`skipPendingActions` (v1) sets `skip_reason = 'failure'`. Condition skips set `'condition'`.
A `routine.run` step that failed is resumed by calling the sub-routine again (a new child
execution). Resume is allowed any number of times, and the run page shows *"Resumed 2×"*.

## 7. Versions

- Table `routine_versions (routine_id, version, definition jsonb, created_at, created_by, origin)`,
  PK `(routine_id, version)`. Every write that bumps `routines.version` inserts a row in the
  same transaction. Migration backfills the current version of every routine.
- `definition` = name, description, trigger, actions, icon, color and `active` (never the
  webhook token). `origin` = the kind of write: `create`, `edit`, `appearance`, `activate`,
  `deactivate`, `webhook` (URL rotated), `restore`, `backfill`. Activation and URL rotation bump
  the version (it is the optimistic lock), so they appear in the history too.
- `GET …/versions` returns the definitions as well, so the History page can diff neighbours
  without one request per version.
- `executions.routine_version` records the version a run used (set in `createExecution`).
- Restore = a normal update whose definition is the old version's (new version number).

## 8. Scheduling v2 (`scheduler.ts`)

| Feature | Implementation |
| --- | --- |
| **Skip holidays** | after computing the next slot, if its local date is a holiday of `skip.holidays` (package `date-holidays`), advance to the following slot (max 366 iterations). Skipped slots are not recorded as runs. |
| **Odd/even weeks** | same loop, ISO week number parity |
| **Sun** | `next_run_at` computed with package `suncalc` for the location, local date by the routine's time zone, plus offset. Recomputed after each firing. |
| **Skip next run** | `routines.skip_next boolean`: the scheduler consumes the slot without creating an execution and clears the flag. Log on the routine: *Skipped 28 Sep 08:00* (kept in `routine_skips`). |
| **Pause until** | `routines.paused_until timestamptz`: slots before it are consumed without runs. |
| **Vacation mode** | profile projection `owner_settings.paused_until`: same as pause-until for every routine of that owner. |

## 9. Built-in capabilities

Domain **`scripting`** (engine-evaluated, `sideEffects: false`), registered in-process:

| Type | Params | Output | New? |
| --- | --- | --- | --- |
| `variable.set` | `name`, `value` | `name`, `value` | |
| `condition.if` | `left`, `operator`, `right` | `result` | |
| `math.calculate` | `a`, `operator`, `b` | `result` | |
| `flow.wait` | `for` (duration) **or** `until` (`HH:mm`, next occurrence in the owner's time zone) | `wokeAt` | new |
| `text.format` | `template` (text with `{{…}}`) | `text` | new |
| `text.replace` | `text`, `find`, `replaceWith`, `all` | `text` | new |
| `text.split` | `text`, `separator` | `items` | new |
| `list.get` | `list`, `position` (`first`, `last`, number) | `item` | new |
| `list.count` | `list` | `count` | new |
| `list.filter` | `list`, `field`, `operator`, `value` | `items`, `count` | new |
| `list.sort` | `list`, `field`, `direction` | `items` | new |
| `json.parse` | `text` | `value` | new |

`flow.wait` is special: on dispatch it becomes `SCHEDULED` with `wake_at`. The housekeeping
loop completes due `SCHEDULED` actions (`FOR UPDATE SKIP LOCKED`) and advances. Maximum wait:
7 days.

Domain **`routines`** (owned by routine-service):

| Type | Kind | Notes |
| --- | --- | --- |
| `routine.run` | action (engine) | v1 |
| `routine.habitStreak` | value (engine) | params `routineId`; output `current`, `best`, `last7` |
| `routine.lastRun` | value (engine) | output `status`, `finishedAt` |
| triggers `execution.completed`, `execution.failed` | trigger | fields `routineId`, `routineName`, `errorCode` |

## 10. Health counters

Columns on `routines`: `consecutive_failures int`, `last_success_at`, `last_failure_at`,
`runs_30d`, `failures_30d`. Updated in the `complete` / `fail` branches (the 30-day counts
count up there too, so a new routine shows its runs at once) and recomputed by a nightly job so
old runs drop out (after 03:00 UTC, once per day: `pg_try_advisory_xact_lock` + `job_runs`).
When `consecutive_failures` reaches `alert_after_failures`, enqueue `RoutineUnhealthy` once
(reset on the next success). `alertAfterFailures` in a routine input: 1–10, `null` = never,
omitted on update = unchanged (2 for a new routine).

## 11. Today cards from routine-service

| Card | When | Kind / section |
| --- | --- | --- |
| `run:<executionId>` | execution enters `WAITING_FOR_YOU` with ≥ 2 human items from **task** domain | `checklist` · now (task-service publishes the items, see [services/task-service.md §5](services/task-service.md)) |
| `later:<routineId>` | an active routine has `next_run_at` later today (refreshed by the scheduler) | `event` · later |
| `unhealthy:<routineId>` | `RoutineUnhealthy` | `attention` · attention, with *Fix* (opens the failed run) |

Cards are removed when the condition ends.

## 12. Test runs

`POST /api/v1/routines/test-step` `{ routineId, action, sampleExecutionId? }` creates an
execution with `kind = 'test'` and one action (a run needs its routine, so only saved routines
can try a step – the step itself may be unsaved). The template scope comes from
`sampleExecutionId` (the routine's last run by default): its completed steps are copied into
the test run as `COMPLETED` rows, so references, variables and loop items resolve to real
values through the normal scope. What runs comes from the catalog (M2): values and
side-effect-free steps as usual, actions with `preview` (their domain answers with a preview
and changes nothing); everything else is `SKIPPED` (`test`). The client polls
`GET /api/v1/executions/:id` (≤ 10 s). Test executions are excluded from lists, stats, health
and events, and deleted after 1 hour.

## 13. Schema changes (all v2 engine migrations together)

```sql
ALTER TABLE routines ADD COLUMN inputs jsonb;
ALTER TABLE routines ADD COLUMN area_id uuid;
ALTER TABLE routines ADD COLUMN habit boolean NOT NULL DEFAULT false;
ALTER TABLE routines ADD COLUMN alert_after_failures integer DEFAULT 2;
ALTER TABLE routines ADD COLUMN origin text NOT NULL DEFAULT 'user';
ALTER TABLE routines ADD COLUMN skip_next boolean NOT NULL DEFAULT false;
ALTER TABLE routines ADD COLUMN paused_until timestamptz;
ALTER TABLE routines ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN last_success_at timestamptz;
ALTER TABLE routines ADD COLUMN last_failure_at timestamptz;
ALTER TABLE routines ADD COLUMN runs_30d integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN failures_30d integer NOT NULL DEFAULT 0;

ALTER TABLE executions ADD COLUMN kind text NOT NULL DEFAULT 'live';        -- live | test
ALTER TABLE executions ADD COLUMN routine_version integer;
ALTER TABLE executions ADD COLUMN depth integer NOT NULL DEFAULT 0;         -- event-chain depth
ALTER TABLE executions ADD COLUMN resume_count integer NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN inputs jsonb;
ALTER TABLE executions ADD COLUMN trigger_event jsonb;                      -- event trigger data

ALTER TABLE execution_actions ADD COLUMN error_code text;
ALTER TABLE execution_actions ADD COLUMN skip_reason text;                 -- condition | failure | expired | user | test
ALTER TABLE execution_actions ADD COLUMN awaiting jsonb;
ALTER TABLE execution_actions ADD COLUMN accepted_at timestamptz;
ALTER TABLE execution_actions ADD COLUMN deadline_at timestamptz;
ALTER TABLE execution_actions ADD COLUMN wake_at timestamptz;
ALTER TABLE execution_actions ADD COLUMN timeout jsonb;
CREATE INDEX execution_actions_deadline_idx ON execution_actions (deadline_at) WHERE status = 'AWAITING_USER' AND deadline_at IS NOT NULL;
CREATE INDEX execution_actions_wake_idx ON execution_actions (wake_at) WHERE status = 'SCHEDULED';

CREATE TABLE routine_versions (…);         -- §7
CREATE TABLE routine_skips (routine_id uuid NOT NULL REFERENCES routines ON DELETE CASCADE, slot timestamptz NOT NULL, reason text NOT NULL, PRIMARY KEY (routine_id, slot));
CREATE TABLE domain_manifests (…);         -- 04 §4.2
CREATE TABLE domains (…);                  -- 04 §4.2
CREATE TABLE owner_settings (              -- profile projection
  owner_id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Zurich', currency text NOT NULL DEFAULT 'CHF',
  enabled_domains text[] NOT NULL DEFAULT '{tasks,notifications}', paused_until timestamptz, updated_at timestamptz NOT NULL
);
UPDATE execution_actions SET skip_reason = 'failure' WHERE status = 'SKIPPED' AND run_if IS NULL;
UPDATE execution_actions SET skip_reason = 'condition' WHERE status = 'SKIPPED' AND run_if IS NOT NULL;
```

This is the union of all engine migrations. Each work package adds only its own part as the
**next free number** in `services/routine-service/migrations/` (the runner applies files in
sorted name order and records them in `schema_migrations`). Never edit an applied migration.
