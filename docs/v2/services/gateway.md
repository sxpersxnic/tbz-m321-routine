# gateway (v2)

## 1. Responsibility

v1: single entry point, routing, token check, correlation id, system status. v2 adds routes
for every new service, SSE pass-through, and **admin endpoints** for the systems views.

## 3. HTTP API

### New routes (prefix → upstream)

| Prefix | Upstream |
| --- | --- |
| `/api/v1/me`, `/api/v1/areas`, `/api/v1/workspaces` | identity-service |
| `/api/v1/catalog`, `/api/v1/templates`, `/api/v1/shared`, `/api/v1/shares` | routine-service (`/api/v1/shared` is public) |
| `/api/v1/system/registry` | routine-service (admin, like every `/api/v1/system` path) |
| `/api/v1/capture`, `/api/v1/task-suggestions` | task-service |
| `/api/v1/today` | today-service. `/api/v1/today/stream` is exempt from the gateway's bearer check (it carries a one-time ticket that today-service verifies) and is proxied without response buffering. The access log must log that path **without** its query string. |
| `/api/v1/triggers` | trigger-service |
| `/api/v1/delivery` | delivery-service |
| `/api/v1/connections` | connector-service |
| `/api/v1/assistant` | assistant-service |
| `/api/v1/budget` | budget-service |
| `/api/v1/health` | health-service (note: **not** `/health`, which is the probe) |
| `/api/v1/people` | people-service |
| `/api/v1/home` | home-service |
| `/api/v1/calendar` | calendar-service |
| `/internal/**` | **never** routed (internal endpoints are service-to-service only) |

Upstreams are configured by env (`BUDGET_URL`, …). An unset upstream (service not deployed
in this profile) answers `503 upstream_unavailable` with `detail: "Budget is not deployed"`.

### Admin endpoints (require role `admin`)

| Method & path | Milestone | Purpose |
| --- | --- | --- |
| `GET /api/v1/system/status` | v1 | + `domains` (from routine-service registry) |
| `GET /api/v1/system/dead-letters` | M1 | per DLQ: `{ queue, workQueue, count, sample: [{ messageId, type, error, failedAt, attempts, routingKey, body }] }` (peek via management API `get` with `ackmode: reject_requeue_true`, max 20) |
| `POST /api/v1/system/dead-letters/:queue/replay` | M1 | `:queue` = the DLQ (`task-service.actions.dlq`). Port of `scripts/replay-dlq.sh` (peek → publish copy without the failure headers → remove original, `409` on a concurrent change or an unrouted copy). Returns `{ moved }`. |
| `POST /api/v1/system/dead-letters/:queue/discard` | M1 | `{ messageIds }` → removes only those: one walk through the DLQ, a kept message is copied to the tail before its original is removed (order kept, nothing lost on a crash). Returns `{ discarded }`. |
| `POST /api/v1/system/services/:name/consuming` | M12 | `{ paused: boolean }` → forwards to `POST /internal/v1/chaos/consuming` on every replica of that service (DNS lookup of all replicas) |
| `POST /api/v1/system/services/:name/chaos` | M12 | `{ failureRate }` → `POST /internal/v1/chaos/failure-rate` on every replica |

Human-readable DLQ labels come from a static map in the web (`task-service.actions.dlq` →
*"Task steps that could not be processed"*).

## 8. Configuration

One `<NAME>_URL` per upstream, `SERVICE_TOKEN_SECRET` (to call `/internal/v1/chaos/*`),
v1 variables.

## 10. Tests

Admin endpoints reject non-admin tokens (`403`). Replay aborts on concurrent change (unit
test with a fake management API). SSE proxy streams without buffering (system test).
