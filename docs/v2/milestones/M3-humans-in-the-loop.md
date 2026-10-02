# M3 – Humans in the loop

**Goal:** routines can include people. A step can wait for a person to do something, answer a
question or wait for a time, and manual routines can ask for inputs when run. Scripting gains
text and list steps.

**You'll see:** *Do yourself* and *Ask me* in the step picker's *You* group · runs *Waiting for
you* · a checklist routine whose items appear as tasks and tick off the run · *Wait until
17:00* · a *Run* dialog asking *Which city?*

**Specs:** [06-engine.md §1, §2, §3, §5, §9](../06-engine.md) · [05-messaging.md §4.1](../05-messaging.md) ·
[04-domain-platform.md §3.2, §6.1](../04-domain-platform.md) · [services/task-service.md](../services/task-service.md) ·
[services/notification-service.md](../services/notification-service.md) · [02-experience.md §6, §7, §13](../02-experience.md)

---

- [x] **M3-01 · Contracts**
  - Schemas + AsyncAPI + contract tests: `ActionAwaitingUser`, `ActionCancelRequested`,
    `ExecutionWaitingForYou`.

- [x] **M3-02 · Engine: new statuses (pure)**
  - `progress.ts`: `AWAITING_USER`, `SCHEDULED`, `WAITING_FOR_YOU`, `DELAYED`, `decideNext` and
    `inFlightStatus` rules of [06 §1](../06-engine.md). Unit tests for every row.
  - `web/src/types.ts` + status icons/labels (*Waiting for you*, *Waiting until …*).

- [x] **M3-03 · Engine: awaiting results, expiry, skip, cancel**
  - Migration: `awaiting`, `accepted_at`, `deadline_at`, `timeout` + index. `parseActionResult`
    kind `awaiting`. Housekeeping expiry ([06 §5](../06-engine.md)). Endpoints: skip a human step,
    cancel a run. `ExecutionWaitingForYou` on entering the status. Definition field `timeout`
    with validation.
  - Tests: expiry `skip`/`fail`, manual skip, cancel sends `ActionCancelRequested` for every
    awaiting action, the human-step race (rule 4 of [05 §5](../05-messaging.md)).

- [x] **M3-04 · `task.await` in task-service**
  - Migration (M3 part of [services/task-service.md §2](../services/task-service.md)). Handler returns
    `awaiting`. Completing a `step` task (PATCH `status: DONE`) calls `completeAwaiting` in the
    same transaction. Cancel handler → `CANCELLED`. Step tasks show a routine badge in task
    lists and can't be deleted.
  - Manifest: `task.await` (`kind: 'human'`), manifestVersion bump.
  - Tests: [services/task-service.md §10](../services/task-service.md) human-step cases.

- [x] **M3-05 · `notification.ask` in notification-service**
  - Migration, handler, `POST /notifications/:id/answer`, cancel → `expired`,
    `notification.answered` event. Manifest bump.

- [x] **M3-06 · Human steps in the web**
  - Step picker *You* group. *If you don't get to it* setting. Run detail: *Waiting for you since
    … · skips at …*, *Do it now*, *Skip*. Notifications page: question cards with option buttons,
    answered/expired states. Tasks page: step tasks with the routine badge.

- [ ] **M3-07 · Checklists (interim, before Today)**
  - task-service groups `task.await` tasks per run (`step_group`, `step_position`). Until Today
    exists (M5), the Tasks page shows a *Waiting for you* section at the top: one group per run
    with its items. The editor offers a *Checklist* starting point: a routine whose step 1 is N
    parallel `task.await` steps.

- [ ] **M3-08 · `flow.wait`**
  - Built-in capability, `SCHEDULED` + `wake_at`, housekeeping completion, max 7 days, `until`
    computed in the owner's time zone (`Europe/Zurich` until M5 provides profiles).
  - Web: *Wait* step form (*for* duration or *until* time).

- [ ] **M3-09 · Run inputs**
  - Definition `inputs`, validation, `POST …/executions { inputs }`, stored on the execution,
    template root `input.<name>` ([06 §3](../06-engine.md)). `routine.run` passes an object input
    through unchanged.
  - Web: *Ask when run?* editor section. The run button opens an input dialog when the routine
    has inputs. Pills `{{input.<name>}}`.

- [ ] **M3-10 · Text and list steps**
  - Built-ins `text.format`, `text.replace`, `text.split`, `list.get`, `list.count`,
    `list.filter`, `list.sort`, `json.parse` in `control.ts` (pure, unit-tested), added to the
    `scripting` manifest.

**Milestone done when:** a *Morning checklist* routine (3 `task.await` + 1 `notification.ask`)
runs: tasks appear, ticking them advances the run, answering the question completes it.
Running the same routine and letting it expire with `then: skip` completes the run with
skipped steps and cancelled tasks.
