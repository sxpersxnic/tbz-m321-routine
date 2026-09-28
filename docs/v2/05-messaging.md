# 05 – Messaging

Every exchange, queue and message of v2. v1 rules are unchanged: JSON envelope
(`contracts/schemas/envelope.schema.json`), at-least-once delivery, tolerant readers,
additive changes within a `version`, expand-and-contract for breaking ones, retry queues
per consumer (`<queue>.retry.<ms>ms`) and a DLQ per work queue (`<queue>.dlq`).

Every message below gets a JSON Schema in `contracts/schemas/` and appears in
`contracts/asyncapi/routine-messaging.yaml` **before** it is produced (contract first).

---

## 1. Exchanges

| Exchange | Type | Status | Routing keys | Carries |
| --- | --- | --- | --- | --- |
| `routine.actions` | topic (AE → `routine.actions.unrouted`) | v1 | `action.<type>` | `ActionRequested`, **`ActionCancelRequested`** |
| `routine.action-results` | topic | v1 | `action.completed`, `action.failed`, `action.retry-scheduled`, **`action.awaiting-user`** | results |
| `routine.events` | topic | v1 | `routine.triggered`, `execution.completed`, `execution.failed`, **`execution.resumed`**, **`execution.waitingForYou`**, **`routine.saved`**, **`routine.deleted`**, **`routine.unhealthy`** | routine-service events |
| **`routine.commands`** | topic | new | `routine.start` | `StartRoutineRequested` |
| **`domain.events`** | topic | new | = trigger type (`task.completed`, `budget.incomeRecorded`, …) | domain events |
| **`today.cards`** | topic | new | `card.upserted`, `card.removed`, `card.resync` | Today projection feed |
| **`platform.registry`** | topic | new | `domain.registered`, `domain.heartbeat` | manifests |

New exchanges are added to `infra/rabbitmq/definitions.json` (durable, not auto-delete).

## 2. Queues and bindings

v1 queues stay. New ones (all quorum, `x-delivery-limit: 10`, DLX to `<queue>.dlq`):

| Queue | Declared by | Bindings | Consumer |
| --- | --- | --- | --- |
| `routine-service.registry` | definitions.json | `platform.registry` `domain.*` | routine-service |
| `routine-service.commands` | definitions.json | `routine.commands` `routine.start` | routine-service |
| `routine-service.profile-events` | definitions.json | `domain.events` `profile.*`, `area.*` | routine-service (profile projection) |
| `trigger-service.events` | definitions.json | `domain.events` `#`; `routine.events` `execution.*` | trigger-service |
| `trigger-service.routines` | definitions.json | `routine.events` `routine.saved`, `routine.deleted` | trigger-service |
| `today-service.cards` | definitions.json | `today.cards` `card.upserted`, `card.removed` | today-service |
| `today-service.events` | definitions.json | `domain.events` `profile.*` | today-service (time zone) |
| `notification-service.execution-events` | v1 | + `routine.events` `routine.unhealthy` | notification-service |
| `delivery-service.notifications` | definitions.json | `domain.events` `notification.created`, `notification.answered` | delivery-service |
| `delivery-service.push` / `.email` / `.chat` | delivery-service | direct (internal work queues) | delivery-service |
| `<service>.actions` for each **new** domain | domain kit (§6.2 of [04](04-domain-platform.md)) | `routine.actions` `action.<type>` per capability | that domain |
| `<service>.resync` | domain kit | `today.cards` `card.resync` | that domain |
| `<service>.area-events` | domain kit | `domain.events` `area.archived` | every domain storing `area_id` |

v1 action queues (`task-service.actions`, `notification-service.actions`,
`integration-worker.actions`) keep their prefix bindings from `definitions.json`. The domain
kit adds exact bindings for new capability types.

## 3. Changed v1 messages (additive)

### ActionRequested v1

- `actionType` pattern widened from `^[a-z]+\.[a-z]+$` to `^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$`.
  Every v1 value still matches.
- New optional `context` object: `mode` (`live` | `test`), `timezone`, `currency`,
  `routineName`, `stepIndex`, `stepCount`, `depth`, `areaId`
  ([04 §3.1](04-domain-platform.md)).

### ActionFailed v1

`error.code` becomes one of the codes in §6. v1 producers used exception class names
(`PermanentError`, `TransientError`). Consumers map unknown codes to `INTERNAL`.

### ExecutionFailed v1

New optional fields `errorCode` (of the failed action) and `failedActionType`.

### RoutineTriggered v1

`trigger` gains the values `event` and `sun`. A resumed run is not a new trigger: it
publishes `ExecutionResumed` instead.

## 4. New messages

### 4.1 Action protocol

**`ActionAwaitingUser` v1**: routing `action.awaiting-user`, producer: any domain with human
capabilities.

```json
{
  "actionId": "uuid", "executionId": "uuid", "actionType": "task.await",
  "awaiting": {
    "kind": "task",               // task | question | checkIn
    "refId": "uuid",              // the task / notification / check-in id
    "title": "Stretch for 5 minutes",
    "dueAt": "2026-10-01T10:00:00Z" // optional: when the human step expires (from params.timeout)
  },
  "processedBy": "task-service@a1b2"
}
```

**`ActionCancelRequested` v1**: routing `action.<type>` on `routine.actions`, producer:
routine-service, when a human step expires or its run is cancelled.

```json
{ "actionId": "uuid", "executionId": "uuid", "actionType": "task.await", "ownerId": "uuid",
  "reason": "expired" }           // expired | runCancelled
```

The domain closes the item (task → `CANCELLED`, question → `EXPIRED`) and sends no result.

### 4.2 Routine events

| Type | Routing key | Data | Consumers |
| --- | --- | --- | --- |
| `ExecutionResumed` v1 | `execution.resumed` | `executionId, routineId, ownerId, fromActionKey, resumedBy` | notification-service (marks the failure notification resolved) |
| `ExecutionWaitingForYou` v1 | `execution.waitingForYou` | `executionId, routineId, ownerId, routineName, awaiting: [{actionKey, kind, refId, title, dueAt}]` | delivery-service (push) |
| `RoutineSaved` v1 | `routine.saved` | `routineId, ownerId, version, active, name, trigger` (full trigger definition), `areaId` | trigger-service |
| `RoutineDeleted` v1 | `routine.deleted` | `routineId, ownerId` | trigger-service |
| `RoutineUnhealthy` v1 | `routine.unhealthy` | `routineId, ownerId, routineName, consecutiveFailures, lastErrorCode` | notification-service |

`RoutineSaved` is emitted on create, update, activate, deactivate and restore (event-carried
state: consumers never call back).

### 4.3 Routine commands

**`StartRoutineRequested` v1**: routing `routine.start` on `routine.commands`, producer:
trigger-service (later possibly others).

```json
{
  "routineId": "uuid", "ownerId": "uuid", "routineVersion": 7,
  "trigger": { "type": "event", "event": "budget.incomeRecorded", "eventMessageId": "uuid",
               "data": { "…": "the event's data" } },
  "idempotencyKey": "event:<eventMessageId>",
  "depth": 1
}
```

routine-service creates the execution with that idempotency key (duplicates → no-op). It
refuses (`log + drop`) if the routine is inactive, deleted, or its current version no longer
has this trigger.

### 4.4 Domain events

- Exchange `domain.events`, routing key = trigger type.
- Envelope `type` = PascalCase of the routing key (`task.completed` → `TaskCompleted`,
  `budget.incomeRecorded` → `BudgetIncomeRecorded`), `version` 1.
- Data = `{ ownerId, occurredAt, areaId?, origin?, …fields }`. The fields are exactly the
  trigger's `fields` from the manifest. Consumers ignore extras.
- Emitted **through the producer's outbox**, in the transaction of the change.

The full list of event types is in each service spec. Summary:

| Prefix | Events |
| --- | --- |
| `task` | `task.created`, `task.captured`, `task.completed`, `task.reopened`, `task.overdue`, `task.moved` |
| `execution` | `execution.completed`, `execution.failed` (on `routine.events`, v1) |
| `notification` | `notification.created`, `notification.answered` |
| `profile` | `profile.updated`, `profile.vacationChanged`, `profile.domainsChanged` |
| `area` | `area.created`, `area.updated`, `area.archived` |
| `budget` | `budget.transactionRecorded`, `budget.incomeRecorded`, `budget.categoryThresholdReached`, `budget.billDueSoon`, `budget.monthStarted`, `budget.goalReached` |
| `health` | `health.entryLogged`, `health.checkInMissed` |
| `people` | `people.birthdayUpcoming`, `people.contactDue`, `people.contactLogged` |
| `home` | `home.shoppingItemAdded`, `home.choreDue`, `home.choreOverdue`, `home.supplyLow` |
| `calendar` | `calendar.eventStartingSoon`, `calendar.dayStarted` |

### 4.5 Today cards

| Type | Routing key | Data |
| --- | --- | --- |
| `TodayCardUpserted` v1 | `card.upserted` | a full card ([services/today-service.md §3](services/today-service.md)) |
| `TodayCardRemoved` v1 | `card.removed` | `ownerId, cardId, version` |
| `TodayResyncRequested` v1 | `card.resync` | `ownerId, requestedAt` |

### 4.6 Registry

| Type | Routing key | Data |
| --- | --- | --- |
| `DomainRegistered` v1 | `domain.registered` | `manifest, digest, instance` |
| `DomainHeartbeat` v1 | `domain.heartbeat` | `domain, manifestVersion, digest, instance` |

## 5. Ordering and consistency rules

1. **No global ordering.** Every consumer must tolerate reordering.
2. **Cards and projections use versions:** every card carries `version` (the source row's
   `updated_at` in ms, or a per-row counter). Today keeps the highest version per `cardId`,
   and a removal with a lower version than the stored card is ignored.
3. **Late results** for finished actions are recorded in the log and change nothing (v1 rule).
4. **Human-step races:** if a task is ticked in the same moment its step expires, the first
   transition the engine commits wins. The other result is ignored as a duplicate. The task
   keeps the user's state (done), and the run shows *Skipped (done too late)*.

## 6. Error codes

Every `ActionFailed.error.code` and `execution_actions.error_code` uses one of:

| Code | Meaning | Retryable (worker retries) |
| --- | --- | --- |
| `NOT_FOUND` | target (URL, entity) doesn't exist | no |
| `UNAUTHORIZED` | credential rejected | no |
| `FORBIDDEN_HOST` | host not on the allow-list | no |
| `TIMEOUT` | call timed out | yes |
| `UNREACHABLE` | connection failed | yes |
| `RATE_LIMITED` | 429 from the target | yes (respects `Retry-After`) |
| `INVALID_PARAMS` | params don't validate | no |
| `TEMPLATE_ERROR` | a `{{…}}` couldn't be resolved (engine) | no |
| `NOT_AVAILABLE` | capability unknown to the consumer or domain disabled | no |
| `REFERENCE_GONE` | a referenced entity (list, category, person, routine) was deleted | no |
| `SUBROUTINE_FAILED` | a `routine.run` call failed | no |
| `AWAIT_EXPIRED` | a human step expired with `then: fail` | no |
| `QUOTA_EXCEEDED` | AI allowance used up | no |
| `AI_REFUSED` | the model declined | no |
| `INPUT_TOO_LARGE` | input exceeds a documented limit | no |
| `CONFLICT` | state doesn't allow the action (e.g. completing a closed task) | no |
| `CANCELLED` | the user cancelled the run (execution-level only, never sent by workers) | no |
| `INTERNAL` | anything else | per exception class |

The mapping from HTTP status to code for `http.request` is: 404/410 → `NOT_FOUND`,
401/403 → `UNAUTHORIZED`, 429 → `RATE_LIMITED`, other 4xx → `INVALID_PARAMS`, 5xx and
network errors → retried, then `UNREACHABLE`.
