# M2 – Domain platform

**Goal:** domains describe themselves. The registry, the catalog and the domain kit exist,
the three v1 worker services become domains, the editor builds its forms from manifests, and
tasks publish domain events through an outbox.

**You'll see:** *Registry* on Infrastructure (Tasks, Notifications, Connections, Routines,
Scripting with versions and heartbeats) · a step picker grouped by domain · forms generated
from manifests (no visible difference for v1 steps, which is the point).

**Specs:** [04-domain-platform.md](../04-domain-platform.md) (all) · [05-messaging.md §2, §4.4, §4.6](../05-messaging.md) ·
[07-web.md §4, §5](../07-web.md) · [services/task-service.md](../services/task-service.md) (M2 parts)

---

- [x] **M2-01 · Registry in routine-service**
  - Migration: `domain_manifests`, `domains` ([04 §4.2](../04-domain-platform.md)). Queue
    `routine-service.registry` in `definitions.json`. Consumer applying the acceptance rules of
    [04 §4.3](../04-domain-platform.md) and the compatibility rules of §5. Staleness check loop.
  - Built-in manifests `routines` and `scripting` registered in-process on startup, same
    code path.
  - Tests: every acceptance/compatibility rule. Two replicas registering concurrently.

- [x] **M2-02 · Catalog API and validation against the registry**
  - `GET /api/v1/catalog` (ETag), `GET /api/v1/action-types` derived from it,
    `POST /api/v1/routines/validate`. `validateRoutine` takes the catalog instead of
    `ACTION_TYPES` (delete `action-catalog.ts` once nothing imports it). Param checks per
    [04 §2.1](../04-domain-platform.md).
  - Until the profile projection exists (M5), every domain counts as enabled.
  - Tests: existing definition tests pass unchanged with the built-in + v1 manifests loaded.

- [x] **M2-03 · Domain kit: `startDomain`**
  - `libs/service-kit/src/domain.ts`, `events.ts`, `today.ts` (card helpers used from M5) per
    [04 §6](../04-domain-platform.md). Kit migration `processed_actions`. Topology declaration.
    Registration + heartbeat. Handler protocol incl. `awaiting` results (sent as
    `ActionAwaitingUser` from M3 on; in M2 the kit supports it but no handler uses it).
  - Tests: an in-memory fake broker test suite for the kit (duplicate delivery, retry,
    permanent failure, unknown type → `NOT_AVAILABLE`, test mode passes `mode`).

- [x] **M2-04 · task-service becomes domain `tasks`**
  - Manifest per [services/task-service.md §5](../services/task-service.md) (M2 subset: `task.create`,
    `task.complete`, `task.move`, `task.openTasks`, `task.doneTasks`, `task.count`; triggers
    `task.created`, `task.completed`, `task.reopened`, `task.moved`). Handlers via `startDomain`.
    The existing queue `task-service.actions` is reused (pass it as `queue`).
  - Outbox + `processed_actions` migrations. Existing `source_action_id` idempotency stays.
  - Domain events emitted through the outbox from HTTP handlers (create, complete, reopen,
    move) **and** from capability handlers (with `origin`).
  - Tests: conformance checklist items for tasks. Events in the same transaction (kill between
    insert and publish → event still published after restart).

- [x] **M2-05 · notification-service becomes domain `notifications`**
  - Manifest with `notification.send` (and `notification.ask` declared from M3). Outbox,
    `notification.created` event.

- [x] **M2-06 · integration-worker becomes domain `connections`**
  - Manifest per [services/integration-worker.md §5](../services/integration-worker.md) (v1 types only).
    Keeps its own claim/lease logic. Uses the kit only for topology and registration
    (`startDomain` option `dispatch: false` + manual consume).
  - `weather.get` and `summary.generate` are values (`sideEffects: false`), `email.send` gets
    `preview`.

- [x] **M2-07 · Test mode from manifests**
  - Engine decides what a test run sends from the catalog (`sideEffects`, `preview`) instead of
    M1's hard-coded list. `email.send` preview returns `{ preview: { to, subject }, wouldDo }`.

- [x] **M2-08 · Catalog in the web**
  - `web/src/catalog/` ([07 §4](../07-web.md)). Replace direct `GET /action-types` use.

- [ ] **M2-09 · Generated step forms**
  - `web/src/forms/` ([07 §5.1–5.3](../07-web.md)). `action-forms.ts` reduced to overrides.
    `SentenceView` from manifest sentences. Visual regression check: every v1 step type renders
    the same sentence as before (fixture comparison).

- [ ] **M2-10 · Step picker by domain**
  - Grouped picker with search ([02 §6](../02-experience.md), [07 §5.4](../07-web.md)). The *You* group
    appears once M3 adds human capabilities.

- [ ] **M2-11 · Registry on Infrastructure**
  - `GET /api/v1/system/registry` (routine-service, admin), `System.tsx` section *Registry*:
    domain, version, service, last heartbeat, status (up/stale), rejected registration
    reason, bindings.

**Milestone done when:** all v1 routines run unchanged, the registry shows five domains, a
deliberately incompatible manifest (test fixture service) is rejected and shown, and a task
ticked in the UI produces a `task.completed` event visible in the RabbitMQ UI.
