# notification-service (v2) · domain `notifications`

## 1. Responsibility

The in-app inbox (v1), **questions** ("Ask me" human steps), and the `notification.*` domain
events that delivery-service turns into push, e-mail and chat. It does not deliver outside
the app itself.

## 2. Data (migration `002_…`)

```sql
ALTER TABLE notifications ADD COLUMN kind text NOT NULL DEFAULT 'info';   -- info | question
ALTER TABLE notifications ADD COLUMN options jsonb;                      -- [{ value, label }] for questions
ALTER TABLE notifications ADD COLUMN answer jsonb;                       -- { value, label, answeredAt }
ALTER TABLE notifications ADD COLUMN awaiting_action_id uuid UNIQUE;
ALTER TABLE notifications ADD COLUMN expires_at timestamptz;
ALTER TABLE notifications ADD COLUMN state text NOT NULL DEFAULT 'open'; -- open | answered | expired
ALTER TABLE notifications ADD COLUMN routine_id uuid;
ALTER TABLE notifications ADD COLUMN resolved_at timestamptz;            -- failure notification resolved by a resume
-- + outbox, processed_actions (domain kit)
```

## 3. HTTP API

| Method & path | Milestone | Purpose |
| --- | --- | --- |
| `POST /api/v1/notifications/:id/answer` | M3 | `{ value }` → completes the human step, marks read. `409` if not an open question. |
| `GET /api/v1/notifications` | M3 | + `kind`, `state` in the DTO and as filters |
| v1 endpoints | | unchanged |

## 4. Messages

| Direction | Message | Notes |
| --- | --- | --- |
| consumes | `ActionRequested` `notification.send`, `notification.ask` | domain kit, queue `notification-service.actions` |
| consumes | `ActionCancelRequested` `notification.ask` | state → `expired` |
| consumes | `ExecutionCompleted/Failed` (v1), `RoutineUnhealthy`, `ExecutionResumed` | `notification-service.execution-events` + new bindings |
| produces | `notification.created` (fields: `notificationId, title, body, priority, kind, options, routineId, executionId`) | `domain.events` via outbox |
| produces | `notification.answered` (fields: `notificationId, value, label`) | |
| produces | Today card `question:<id>` (`question` · now) for open questions | |

The v1 rule stays: execution outcome notifications are category `execution` and stay off the
Notifications page ([v1 TODO](../../TODO.md)). v2 adds `RoutineUnhealthy` as a normal
(category `action`) notification with priority `high`.

## 5. Manifest (`notifications`, `optional: false`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `notification.send` | action | `title`*, `body`, `priority` | `notificationId, deliveredAt` (v1) |
| `notification.ask` | human (`awaits: question`) | `question`*, `options`* (list of `{value,label}`, 2–4), `body` | `value, label, answeredAt` |

Triggers: `notification.answered` (fields `value, label, notificationId`).

## 9. Minimum lovable depth

v1 inbox + questions with inline answer buttons, answered state, expiry state.

## 10. Tests

Answer → exactly one `ActionCompleted`, second answer `409`. Expired question can't be
answered (`409`). `notification.created` emitted in the same transaction as the insert.
