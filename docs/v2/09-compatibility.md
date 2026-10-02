# 09 – Compatibility with v1

v2 is built on the v1 branch point (`v1.0.0`) and must never break what v1 users, scripts
and documents rely on.

## 1. Guarantees

| Area | Guarantee |
| --- | --- |
| **HTTP** | Every v1 endpoint keeps its path, request and response shape. New fields are additive. v1 request bodies stay valid (e.g. `PATCH /tasks/:id { status }`). |
| **Routines** | Every stored v1 routine validates and runs unchanged. v1 action types keep their names, params and outputs. |
| **Messages** | v1 message versions keep their schemas. Changes are additive (a widened pattern, optional fields). `ExecutionCompleted` v1/v2 expand-and-contract stays demoable (`scripts/demo.sh evolution`). |
| **Scripts** | `scripts/demo.sh` scenarios and `scripts/replay-dlq.sh` keep working. |
| **Routes (web)** | v1 hash routes keep working: `#/` shows Today (the v1 Overview moves to `#/overview`), `#/executions`, `#/tasks`, `#/notifications`, `#/system`, `#/routines/:id/edit` (redirect, as in v1). |
| **Data** | No destructive migrations. Only additive columns/tables and backfills. `owner_id` semantics extend without rewriting rows (ADR-13). |
| **Deployment** | `docker compose up -d --build --wait` without profiles starts a working system (v1 services + trigger, today, connector). |

## 2. Data migrations and backfills

| Service | Migration | Backfill |
| --- | --- | --- |
| routine-service | skip reasons | from `run_if` ([06 §13](06-engine.md)) |
| routine-service | versions | one `routine_versions` row per routine at its current version |
| routine-service | health counters | computed from the last 30 days of executions on first nightly run, and immediately after migration |
| task-service | Inbox list | created lazily on first use, not by migration |
| task-service | Today cards | first `TodayResyncRequested` per owner (today-service sends it when an owner opens Today for the first time and has no cards) |
| identity-service | profiles | none: missing row = defaults |
| notification-service | kind, state | defaults `info`, `open` |

## 3. Behaviour changes users will notice

| Change | Why | Mitigation |
| --- | --- | --- |
| Home is Today, not Overview | the product changed | Overview still at `#/overview`, linked from Infrastructure |
| Demo routines left the template gallery | they're test fixtures, not products | *Demo scenarios* on Infrastructure |
| Failed runs show sentences, not raw errors | trust | raw error under *Under the hood* |
| Tasks created by `task.create` without `areaId` inherit the routine's area | areas | none needed: v1 routines have no area |

## 4. Rollout order within a milestone

Contracts → producers in *expand* mode (old and new fields) → consumers → producers contract
(only if something was ever removed, which v2 plans never do). Each service deploys
independently. The Swarm stack rolls replicas one by one (v1 `update_config`), so a registry
sees old and new manifest versions side by side for a moment, and the rules in
[04 §4.3](04-domain-platform.md) handle that.

## 5. Keeping the v1 hand-in clean

- `main` stays at `v1.0.0` plus v1 fixes only. v2 lives on branch `feat/v2-dev` (see [10-quality.md §4](10-quality.md)).
- `docs/v2/` exists on `main` only as this plan. No v2 code lands on `main` before the course
  is graded.
- v1 docs (`README.md`, `docs/*.md`) are not edited for v2 on `main`. On `feat/v2-dev` they're updated
  as milestones change behaviour.
