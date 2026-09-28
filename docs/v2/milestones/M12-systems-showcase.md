# M12 – Systems showcase

**Goal:** the distributed system becomes even easier to see and demonstrate, one click away
from the product. This carries the M321 story into v2.

**You'll see:** a waterfall per run · *Pause consuming* per service with queues filling up
live · which replica ran each step · *Duplicate delivery ignored* badges.

**Specs:** [02-experience.md §7, §16](../02-experience.md) · [services/gateway.md](../services/gateway.md) · [03-architecture.md §6](../03-architecture.md)

---

- [ ] **M12-01 · Chaos endpoints in the kit**
  - `installChaosEndpoints(app, broker)`: `POST /internal/v1/chaos/consuming { paused }`
    (cancel/re-attach consumers without closing the connection: `Broker.pauseConsumers()` /
    `resumeConsumers()`), `POST /internal/v1/chaos/failure-rate { rate }` (runtime override of
    `chaosFailureRate`). Enabled only when `CHAOS_ENDPOINTS=1` (compose default on, Swarm off).
- [ ] **M12-02 · Gateway fan-out to all replicas** (`dns.lookup(name, { all: true })`, call each, report per replica)
- [ ] **M12-03 · Web: chaos panel on Infrastructure** (per service: pause/resume, failure-rate slider, live queue depth next to it)
- [ ] **M12-04 · Run waterfall** (`accepted_at` for every action: set on `ActionAwaitingUser` and, for normal actions, the first result's `occurredAt`; bars from `dispatched_at` → `finished_at`, colour per replica from `processed_by`, Jaeger link from `trace_id`)
- [ ] **M12-05 · Duplicate badges** (log entries for `duplicate: true` results rendered as *Duplicate delivery ignored* in the event log. Engine already logs duplicates: add a log `kind` `DUPLICATE`)
- [ ] **M12-06 · Replica view** (Infrastructure: per service, replicas with instance id and messages processed in the last 5 min, from `processed_by` counts, routine-service `GET /api/v1/system/replicas`)

**Milestone done when:** during a live demo you can pause task-service, start three routines,
watch `task-service.actions` fill up, resume, and watch the runs complete. Every step shows
which replica did it, and a forced duplicate (`CHAOS_DUPLICATE_PUBLISH_RATE`) shows its badge.
