# 04 – Domain platform

The contract that lets a domain join Routine without any other service changing. It has
four parts: the **manifest** (what a domain offers), the **registry** (how the platform
learns about it), the **domain kit** (the service-kit module every domain uses), and the
**conformance checklist** (when a domain is done).

---

## 1. Concepts

| Concept | Definition |
| --- | --- |
| **Domain** | A service that owns one kind of data and publishes a manifest. Id: `^[a-z][a-z0-9]*$` (`tasks`, `budget`). |
| **Prefix** | The first segment of every capability type the domain owns. A domain may own several (`connections` owns `http`, `weather`, `email`, `summary`, `chat`, `feed`). A prefix belongs to exactly one domain. |
| **Capability** | A trigger, action, value or human step. Type: `<prefix>.<name>`, regex `^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$`. |
| **Action** | Changes data (`sideEffects: true`). |
| **Value** | Reads data (`sideEffects: false`). Safe in test runs and previews. |
| **Human step** | An action that completes when a person acts (`kind: 'human'`). |
| **Trigger** | An event the domain publishes on `domain.events`. Its type is the routing key. |
| **Collection** | A list of the domain's entities that params can reference (categories, lists, persons). |

v1 types (`task.create`, `notification.send`, `weather.get`, `http.request`,
`summary.generate`, `email.send`, `variable.set`, `condition.if`, `math.calculate`,
`routine.run`) all match the new regex and keep their names.

---

## 2. The manifest (TypeScript)

The canonical types live in `libs/service-kit/src/manifest.ts` (a *technical contract*, like
the envelope, so sharing it doesn't violate the no-shared-domain-model rule). The JSON Schema
generated from it lives in `contracts/schemas/domain-manifest.v1.schema.json`.

```ts
export type Tint = 'sky' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'grey';

export interface DomainManifest {
  contract: 1;                   // manifest format version (this document)
  domain: string;                // 'budget'
  manifestVersion: number;       // integer ≥ 1, bumped on every change (see §5)
  service: string;               // 'budget-service' – for the Infrastructure page
  name: string;                  // 'Budget'
  description: string;           // one sentence, shown in "Add a domain"
  icon: string;                  // icon name from the web icon set (web/src/components/ui.tsx)
  tint: Tint;
  order: number;                 // default position in the sidebar
  optional: boolean;             // false = always on (tasks, notifications, routines, scripting, connections)
  prefixes: string[];            // ['budget']
  page?: string;                 // web route of the domain page, e.g. '/budget'
  collections?: Record<string, CollectionSpec>;
  capabilities: CapabilitySpec[];
  triggers?: TriggerSpec[];
  quickEntry?: QuickEntrySpec[];
  todayCards?: CardKind[];       // which card kinds this domain publishes
  templates?: RoutineTemplate[]; // single-domain templates (cross-domain ones live in routine-service)
}

/** A ready-made routine. `{{setup.<name>}}` placeholders are replaced once, at creation. */
export interface RoutineTemplate {
  id: string;                    // 'budget.monthEndCheck'
  name: string;
  description: string;
  icon: string;
  tint: Tint;
  requires: string[];            // domains that must be enabled, e.g. ['budget', 'tasks']
  setup: Array<Pick<ParamSpec, 'name' | 'label' | 'type' | 'required' | 'default' | 'options' | 'ref'>>; // ≤ 3 questions
  routine: Record<string, unknown>; // a RoutineInput (06-engine.md §2) that may contain {{setup.<name>}}
}

export type CapabilityKind = 'action' | 'value' | 'human';

export interface CapabilitySpec {
  type: string;                  // 'budget.recordTransaction'
  kind: CapabilityKind;
  label: string;                 // 'Record transaction'
  sentence: string;              // 'Record {amount} for {category}' – {param} placeholders
  description: string;           // one sentence for the step picker ("what this does for you")
  icon?: string;                 // defaults to the domain icon
  tint?: Tint;                   // defaults to the domain tint
  params: ParamSpec[];
  output: OutputField[];         // what {{actions.<key>.<field>}} can read
  sideEffects: boolean;          // false for values; true for actions and human steps
  preview?: boolean;             // action can answer mode 'test' with a preview (§3.4)
  human?: { awaits: 'task' | 'question' | 'checkIn'; defaultTimeout?: string }; // ISO 8601 duration
  acceptsSecrets?: string[];     // param names that may contain {{secrets.<name>}}
  since: number;                 // manifestVersion that introduced it
  deprecated?: { since: number; replacedBy?: string; message: string };
}

export type ParamType =
  | 'text' | 'longText' | 'number' | 'integer' | 'money' | 'boolean'
  | 'date' | 'time' | 'duration' | 'choice' | 'ref' | 'list' | 'object' | 'value';

export interface ParamSpec {
  name: string;                  // ^[a-z][a-zA-Z0-9]*$
  label: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label: string }>; // for 'choice'
  ref?: { domain: string; collection: string };      // for 'ref' (value = entity id)
  min?: number;
  max?: number;
  placeholder?: string;
  hint?: string;
  templating?: boolean;          // default true: {{…}} allowed
  advanced?: boolean;            // shown under "More options"
}

export interface OutputField {
  name: string;                  // camelCase, money in major units: 'remaining', not 'remainingMinor'
  label: string;                 // 'Remaining'
  type: ParamType;
  example?: unknown;             // shown as the pill's example before a real run exists
}

export interface TriggerSpec {
  type: string;                  // 'budget.incomeRecorded' – also the routing key on domain.events
  label: string;                 // 'Income is recorded'
  sentence: string;              // 'When income {filter} is recorded'
  description: string;
  fields: OutputField[];         // payload fields: filterable, and readable as {{trigger.event.<field>}}
  since: number;
  deprecated?: { since: number; replacedBy?: string; message: string };
}

export interface CollectionSpec {
  label: string;                 // 'Categories'
  list: string;                  // GET path returning { items: [...] }, e.g. '/api/v1/budget/categories'
  idField: string;               // 'id'
  labelField: string;            // 'name'
  iconField?: string;
  tintField?: string;
}

export interface QuickEntrySpec {
  id: string;                    // 'expense'
  pattern: string;               // anchored JS regex source with named groups (client-side suggestion only)
  endpoint: string;              // POST path receiving { text }, e.g. '/api/v1/budget/transactions/quick'
  label: string;                 // 'Record {amount} · {note}' – {group} placeholders
}

export type CardKind = 'item' | 'checklist' | 'metric' | 'event' | 'question' | 'checkIn' | 'attention' | 'suggestion';
```

### 2.1 Param value rules

| Type | JSON value | Notes |
| --- | --- | --- |
| `text`, `longText` | string | `longText` renders a textarea |
| `number` | number | a numeric string is accepted and coerced by the domain |
| `integer` | integer | |
| `money` | number, **major units** (`14.5`) | the domain converts to minor units with the user's currency (`context.currency`) |
| `boolean` | boolean | |
| `date` | `YYYY-MM-DD`, or relative `+Nd` (`+0d` = today, in the user's time zone) | |
| `time` | `HH:mm` | |
| `duration` | ISO 8601 duration (`PT2H`, `P3D`) | |
| `choice` | one of `options[].value` | |
| `ref` | entity id (uuid) of `ref.collection` | the web shows a picker filled from the collection |
| `list` | array | |
| `object` | object | |
| `value` | anything (JSON-ish text in the form) | v1's `value` field kind |

A param whose `templating` is not `false` may contain `{{…}}`. Validation of a templated
value is deferred to run time (as in v1).

### 2.2 Output rules

- Outputs are flat, camelCase, **major units** for money, ISO strings for dates.
- Lists of entities are arrays of small objects with `id` and `title`/`name` (e.g.
  `tasks: [{ id, title, dueDate }]`) so they work with *Repeat for each*.
- A value capability returns its main result under a stable field (`remaining`, `count`,
  `items`, `value`) so the step picker can suggest it first.

---

## 3. Runtime protocol a domain implements

### 3.1 Commands in

The routine service publishes `ActionRequested` to `routine.actions` with routing key
`action.<type>` ([05-messaging.md §3](05-messaging.md)). v2 adds an optional `context` object:

```json
{
  "actionId": "…", "executionId": "…", "routineId": "…", "ownerId": "…",
  "actionKey": "record", "actionType": "budget.recordTransaction",
  "params": { "amount": 14.5, "categoryId": "…", "note": "lunch" },
  "context": {
    "mode": "live",              // live | test
    "timezone": "Europe/Zurich",
    "currency": "CHF",
    "routineName": "Lunch log",
    "stepIndex": 2, "stepCount": 4,
    "depth": 0,                  // loop-protection depth (see §3.5)
    "areaId": null               // the routine's area, used as default area for created items
  }
}
```

### 3.2 Results out

| Situation | Message | Routing key |
| --- | --- | --- |
| done | `ActionCompleted { output }` | `action.completed` |
| transient failure, retry scheduled | `ActionRetryScheduled` | `action.retry-scheduled` |
| gave up / permanent | `ActionFailed { error: { code, message } }` | `action.failed` |
| **human step created** | `ActionAwaitingUser { awaiting }` | `action.awaiting-user` |
| **human step done** | `ActionCompleted { output }` (later, from the domain's HTTP handler) | `action.completed` |

`error.code` must be one of the codes in [05-messaging.md §6](05-messaging.md).

### 3.3 Idempotency

Every domain keeps `processed_actions` (created by the domain kit's migration):

```sql
CREATE TABLE processed_actions (
  action_id   uuid PRIMARY KEY,
  result      jsonb       NOT NULL,   -- the result message data that was sent
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

The kit checks it before calling the handler. A duplicate delivery re-sends the stored result
with `duplicate: true`. The handler's writes, the `processed_actions` row and the outgoing
result (via the outbox) commit in **one transaction**.

### 3.4 Test mode

When `context.mode = 'test'`:

- `value` capabilities run normally.
- `action` capabilities with `preview: true` return `{ preview: { … }, wouldDo: '<sentence>' }`
  and change nothing. Without `preview`, the engine never sends them in test mode.
- `human` capabilities are never sent in test mode.
- The domain must not emit domain events or Today cards in test mode.

### 3.5 Domain events and origin

A domain publishes events on `domain.events` with routing key = trigger type. Data always
includes `ownerId`, the event's `fields` from the manifest, and, when the change was caused
by a routine step, `origin`:

```json
{ "origin": { "executionId": "…", "routineId": "…", "actionId": "…", "depth": 1 } }
```

`origin.depth = context.depth + 1`. The trigger service refuses to start a routine from an
event whose `origin.depth ≥ 5`, or whose `origin.routineId` is the subscribing routine
itself (self-trigger) ([services/trigger-service.md §4](services/trigger-service.md)).

### 3.6 Today cards

A domain publishes `TodayCardUpserted` / `TodayCardRemoved` on `today.cards` (via its outbox)
whenever an item becomes or stops being relevant for Today, and answers `TodayResyncRequested`
for one owner by republishing all its current cards. Card schema:
[services/today-service.md §3](services/today-service.md).

### 3.7 Quick entry

`quickEntry` patterns are matched **client-side** only to suggest an entry in the command
palette. Choosing it sends the raw text to the domain's `endpoint`, which **parses again
server-side** (never trusting the client's match) and does the work. The routine engine is
not involved. Example (Budget):

```json
{ "id": "expense", "pattern": "^(?<amount>\\d+(?:[.,]\\d{1,2})?)\\s+(?<note>.+)$",
  "endpoint": "/api/v1/budget/transactions/quick",
  "label": "Record {amount} · {note}" }
```

The budget service chooses the category itself (rules, then the last category used for that
note).

---

## 4. The registry

### 4.1 Registration

On startup, **after** declaring its queue and bindings (§6), a domain service publishes:

| Message | Routing key (`platform.registry`) | When |
| --- | --- | --- |
| `DomainRegistered { manifest, digest, instance }` | `domain.registered` | on start, and whenever the connection is re-established |
| `DomainHeartbeat { domain, manifestVersion, digest, instance }` | `domain.heartbeat` | every 30 s |

`digest` = SHA-256 of the manifest's canonical JSON (keys sorted).

### 4.2 routine-service stores

```sql
CREATE TABLE domain_manifests (
  domain            text        NOT NULL,
  manifest_version  integer     NOT NULL,
  digest            text        NOT NULL,
  manifest          jsonb       NOT NULL,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, manifest_version)
);
CREATE TABLE domains (
  domain             text PRIMARY KEY,
  current_version    integer,               -- null: only rejected registrations so far (shown too)
  service            text        NOT NULL,
  last_heartbeat_at  timestamptz NOT NULL,
  rejected           jsonb                  -- last rejected registration and why (shown on Infrastructure)
);
```

### 4.3 Acceptance rules

A `DomainRegistered` is **accepted** when:

1. It validates against `domain-manifest.v1.schema.json`.
2. Its prefixes don't belong to another domain, and every capability/trigger type starts
   with one of its prefixes.
3. `manifestVersion` > `current_version` **and** it is compatible (§5), or it equals
   `current_version` with the same digest (a replica restarting).
4. A lower `manifestVersion` (an old replica during a rolling update) is ignored, and counts
   only as a heartbeat.

Same version with a different digest → **rejected** (someone changed a manifest without
bumping the version). Rejections are logged, stored in `domains.rejected` and shown on the
Infrastructure page. The previously accepted manifest stays current.

Built-in domains (`routines`, `scripting`) are registered in-process by routine-service at
startup through the same code path.

### 4.4 Freshness

A domain with no heartbeat for 90 s is **stale**. Stale domains still receive commands (they
queue up durably, which is the point), and the UI says *"Budget is catching up"* on waiting
steps.

### 4.5 Catalog API

`GET /api/v1/catalog` (routine-service) returns every current manifest, with each domain
marked `enabled` for the caller (from the profile projection, see
[services/routine-service.md §4](services/routine-service.md)), plus an `ETag` over all
digests. The web caches it (`If-None-Match`). v1's `GET /api/v1/action-types` stays, derived
from the catalog.

---

## 5. Evolving a manifest

Manifests follow v1's expand-and-contract rule.

| Change | Allowed within the next `manifestVersion`? |
| --- | --- |
| Add a capability, trigger, collection, quick-entry pattern | ✓ |
| Add an optional param, an output field, a trigger field | ✓ |
| Change labels, sentences, descriptions, icons, tints | ✓ |
| Deprecate a capability or trigger (`deprecated`) | ✓ |
| Make a required param optional | ✓ |
| Remove a capability/trigger | only if it was deprecated in an earlier version **and** no routine uses it (the registry counts usage) |
| Remove or rename a param, change a param's or output's type, make an optional param required | ✗: introduce a new capability type (`budget.recordTransaction2` is not allowed; use a new meaningful name) and deprecate the old one |

Routines keep working on deprecated capabilities. The editor shows *"Update available"* with
the `replacedBy` capability.

---

## 6. The domain kit (`@routine/service-kit`)

New modules, used by every domain service (and retrofitted to task, notification and
integration-worker):

| Module | Exports | Purpose |
| --- | --- | --- |
| `manifest.ts` | types of §2, `validateManifest`, `manifestDigest` | contract types |
| `outbox.ts` | `enqueue(tx, message)`, `OutboxRelay` (table via `runKitMigrations(pool, ['outbox'], logger)` in `db.ts`) | moved from routine-service unchanged in behaviour |
| `domain.ts` | `startDomain(options)` | topology, registration, heartbeat, command dispatch, idempotency, results |
| `events.ts` | `emitEvent(tx, type, data, origin?)` | domain events through the outbox |
| `today.ts` | `upsertCard(tx, card)`, `removeCard(tx, ownerId, cardId)`, `onResync(handler)` | Today cards |
| `internal-auth.ts` | `installServiceAuth(app, allowedServices)`, `serviceTokenProvider(name, secret)` | `/internal/**` endpoints and calling them |

### 6.1 `startDomain`

```ts
startDomain({
  manifest,                        // DomainManifest
  broker, pool, logger,
  queue: 'budget-service.actions', // declared: quorum queue + '.dlq', bound to action.<type> for every capability
  retryDelaysMs: [1_000, 5_000, 15_000],
  prefetch: 10,
  handlers: {
    'budget.recordTransaction': async (command, { tx, emit, card }) => ({ kind: 'completed', output: { … } }),
    'budget.categoryRemaining': async (command, { tx }) => ({ kind: 'completed', output: { remaining: 54 } }),
  },
  cancel: {                        // only for human capabilities
    'task.await': async (command, { tx }) => { /* close the task as skipped */ },
  },
  resync: async (ownerId, { tx, card }) => { /* republish all Today cards of ownerId */ },
});
```

Option `dispatch: false` makes the kit declare topology, register and heartbeat, but **not**
consume: the service consumes its queue itself (integration-worker, whose external calls
can't run inside a database transaction and keeps its v1 claim/lease idempotency).

Handler result: `{ kind: 'completed', output }` or
`{ kind: 'awaiting', awaiting: { kind: 'task' | 'question' | 'checkIn', refId, title, dueAt? } }`.
Throw `TransientError` to retry, `PermanentError` (with a `code`) to fail.

What the kit does, in order, per delivery:

1. Parse the envelope (tolerant reader). Unknown `actionType` → `ActionFailed { code: NOT_AVAILABLE }`.
2. `BEGIN`. Look up `processed_actions`. If present → re-send stored result (`duplicate: true`), `COMMIT`.
3. If `ActionCancelRequested` → call `cancel[type]`, `COMMIT`, no result.
4. Call the handler with `tx`. Write `processed_actions`. Enqueue the result into the outbox.
   `COMMIT`.
5. Retries and giving up behave as in v1's `Broker.consume` (`onRetry` → `ActionRetryScheduled`,
   `onGiveUp` → `ActionFailed`).

Human steps complete later through the domain's own HTTP handler, which calls
`completeAwaiting(tx, actionId, output)` from the kit. That writes the final result into the
outbox and marks the `processed_actions` row as completed with that output.

### 6.2 Topology declaration

The kit declares (idempotent `assertQueue` / `bindQueue`):

- `<service>.actions` (quorum, `x-delivery-limit: 10`, DLX → `<service>.actions.dlq`) and the DLQ
- bindings on `routine.actions`: `action.<type>` for every capability in the manifest
- `<service>.resync` bound to `today.cards` with `card.resync` (only if `resync` is given)

v1 queues in `infra/rabbitmq/definitions.json` stay where they are. The exchanges
`domain.events`, `today.cards`, `platform.registry` and `routine.commands` are added there,
because exchanges must exist before any service starts.

---

## 7. Conformance checklist: a domain is done when…

- [ ] Its manifest validates, registers, and appears on the Infrastructure registry list.
- [ ] Every capability has a handler, a contract test (command in → result out) and an
      idempotency test (same `actionId` twice → one effect, same output).
- [ ] Every human capability has a cancel handler and an HTTP completion path.
- [ ] Every trigger is emitted through the outbox with the manifest's fields, and `origin`
      when caused by a routine step.
- [ ] Test mode: values work, previews change nothing, no events or cards are emitted.
- [ ] Today cards are published and removed correctly, and `resync` republishes them.
- [ ] Its page reaches *minimum lovable depth* (the service spec lists what that means).
- [ ] At least two templates use it together with another domain.
- [ ] Sensitive values never appear in logs.
- [ ] It runs as 2 replicas without duplicate effects (tested by the system test).
