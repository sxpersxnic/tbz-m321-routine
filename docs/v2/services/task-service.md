# task-service (v2) · domain `tasks`

## 1. Responsibility

Tasks, task lists, the Inbox, snoozing, archiving, human steps of kind `task` (do yourself,
checklists), task events, task Today cards, and "make it a routine" suggestions. It does
**not** do recurrence: repeating tasks are routines (origin `repeat`).

## 2. Data (migrations `004_…` onward)

```sql
-- M2: domain kit tables
-- outbox (service-kit runKitMigrations(['outbox'])) and processed_actions (04 §3.3)

-- M3: human steps
ALTER TABLE tasks ADD COLUMN kind text NOT NULL DEFAULT 'task';        -- task | step
ALTER TABLE tasks ADD COLUMN source_routine_id uuid;
ALTER TABLE tasks ADD COLUMN source_routine_name text;
ALTER TABLE tasks ADD COLUMN awaiting_action_id uuid UNIQUE;          -- set for kind = 'step'
ALTER TABLE tasks ADD COLUMN step_group text;                         -- executionId: steps of one run form a checklist
ALTER TABLE tasks ADD COLUMN step_position integer;
-- status gains CANCELLED (step expired or run cancelled)

-- M5: everyday task management
ALTER TABLE tasks ADD COLUMN area_id uuid;
ALTER TABLE tasks ADD COLUMN snoozed_until date;
ALTER TABLE tasks ADD COLUMN focus_date date;                         -- picked in "Plan my day"
ALTER TABLE tasks ADD COLUMN archived_at timestamptz;
ALTER TABLE tasks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE task_lists ADD COLUMN area_id uuid;
ALTER TABLE task_lists ADD COLUMN is_inbox boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX task_lists_one_inbox_idx ON task_lists (owner_id) WHERE is_inbox;
CREATE INDEX tasks_open_due_idx ON tasks (owner_id, due_date) WHERE status = 'OPEN' AND archived_at IS NULL;

CREATE TABLE task_suggestions (                                          -- "make it a routine"
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, normalized_title text NOT NULL,
  occurrences integer NOT NULL, typical_time time, dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, normalized_title)
);
```

## 3. HTTP API

| Method & path | Milestone | Purpose |
| --- | --- | --- |
| `GET /api/v1/tasks` | M5 | + filters `areaId`, `kind`, `smart=today\|scheduled\|open\|done\|archived\|focus`, excludes snoozed/archived by default |
| `PATCH /api/v1/tasks/:id` | M5 | all fields optional (`minProperties: 1`): `status`, `title`, `description`, `priority`, `dueDate`, `listId`, `areaId`, `snoozedUntil`, `focusDate`. v1 bodies (`{ status }`) stay valid. Completing a `step` task completes its human step. |
| `POST /api/v1/tasks/:id/snooze` | M5 | `{ until: 'YYYY-MM-DD' }` shortcut |
| `DELETE /api/v1/tasks/:id` | M5 | delete (a `step` task can't be deleted: `409`, use skip on the run) |
| `POST /api/v1/capture` | M5 | `{ text }` → parses quick syntax (§3.1), creates a task in the Inbox, emits `task.captured` |
| `POST /api/v1/tasks/bulk` | M5 | `{ ids, patch }` for Inbox sorting and Shutdown |
| `GET /api/v1/task-suggestions` | M5 | open suggestions |
| `POST /api/v1/task-suggestions/:id/dismiss` | M5 | |
| `POST /api/v1/task-steps/:actionId/focus` | M5 | `{ taskIds }` (≤ `max`) → sets `focus_date = today` on them, completes `task.pickFocus` |
| `POST /api/v1/task-steps/:actionId/review` | M5 | `{ decisions: [{ taskId, decision }] }`, decision = `keep` / `tomorrow` / `later` (+7 days) / `drop` (delete) → applies them, completes `task.reviewOpen` |
| v1 list endpoints | | + `areaId` on lists |

The `\|` in `smart=` above separates alternatives. Only one value is sent.

### 3.1 Capture syntax (server-side parser, shared test vectors with the web)

| Token | Meaning |
| --- | --- |
| `today`, `tomorrow`, `mon`…`sun`, `next week`, `YYYY-MM-DD`, `DD.MM.` | due date (user's time zone) |
| `!high`, `!low` | priority |
| `#<area name>` (case-insensitive prefix match) | area |
| `@<list name>` | list (default: Inbox) |
| rest | title |

## 4. Messages

| Direction | Message | Notes |
| --- | --- | --- |
| consumes | `ActionRequested` for its capabilities | domain kit, queue `task-service.actions` (v1 queue kept) |
| consumes | `ActionCancelRequested` (`task.await`) | step task → `CANCELLED`, card updated |
| consumes | `TodayResyncRequested` | `task-service.resync` |
| consumes | `area.archived` | clears `area_id` on tasks and lists |
| produces | results, `ActionAwaitingUser` | outbox |
| produces | `task.created`, `task.captured`, `task.completed`, `task.reopened`, `task.overdue`, `task.moved` | outbox, `domain.events` |
| produces | Today cards | outbox |

Event fields (all events): `taskId, title, listId, listName, areaId, priority, dueDate, kind,
sourceRoutineId`. Plus `completedAt` (completed), `fromListId` (moved).

## 5. Manifest (`tasks`, `optional: false`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `task.create` | action | `title`*, `description`, `priority` (choice), `dueInDays` (integer; v1) **or** `dueDate` (date), `listId` (ref lists), `areaId` (ref areas) | `taskId, title, listId, dueDate, priority` |
| `task.complete` | action | `taskId`* | `taskId, completedAt` |
| `task.move` | action | `taskId`*, `listId`, `areaId`, `dueDate` | `taskId` |
| `task.snooze` | action | `taskIds`* (list) **or** `filter` (`nonUrgentToday`), `until` (date) | `count` |
| `task.await` | human (`awaits: task`) | `title`*, `description`, `listId` | `taskId, completedAt` |
| `task.pickFocus` | human (`awaits: task`) | `max` (integer, default 3), `dueBy` (date, default today), `areaId` | `taskIds, titles` |
| `task.reviewOpen` | human (`awaits: task`) | `listId` (e.g. the Inbox), `areaId`, `dueBy` (date) | `kept, snoozed, dropped` (counts) |
| `task.openTasks` | value | `listId`, `areaId`, `dueBy` (date), `limit` | `items` [{taskId, title, dueDate, priority}], `count` |
| `task.doneTasks` | value | `since` (date), `areaId` | `items`, `count` |
| `task.count` | value | `listId`, `areaId`, `overdueOnly` (boolean) | `count` |

Triggers: `task.created`, `task.captured`, `task.completed`, `task.overdue` (emitted once per
task by the overdue job), `task.moved`. Filter fields as in §4.

Collections: `lists` (`/api/v1/task-lists`), `openTasks` (`/api/v1/tasks?smart=open`).

Quick entry: none (capture has its own sheet).

`task.pickFocus` and `task.reviewOpen` keep their selection client-side until *Done*. The
final POST carries all decisions, so a half-finished review changes nothing.

**Checklists:** `task.await` steps in the **same step number** of a run share
`step_group = executionId`. Their tasks are not shown as separate Today items. The service
publishes one `checklist` card `steps:<executionId>` (title = `context.routineName`, items =
the group's tasks with done state, progress `done/total`). The card is removed when every item
is done or cancelled.

## 6. Today cards

| Card id | Kind · section | When |
| --- | --- | --- |
| `task:<id>` | `item` · today | open, not a step, due today/overdue or `focus_date` = today, not snoozed |
| `steps:<executionId>` | `checklist` · now | open step tasks of one run |
| `focus:<actionId>` | `checklist` · now | a waiting `task.pickFocus`: items = candidate tasks (toggle), card action *Done* → `…/focus` with the selected ids |
| `review:<actionId>` | `checklist` · now | a waiting `task.reviewOpen`: items = open tasks, each with actions *Tomorrow · Later · Drop* (unanswered items count as `keep`), card action *Done* → `…/review` |
| `suggest:<id>` | `suggestion` · attention | an open suggestion |

Card actions: `complete` → `PATCH /api/v1/tasks/:id {status:'DONE'}`, `snooze` →
`POST …/snooze`, `open` → `#/tasks?task=<id>`.

**Day change:** a job at 00:05 in each user's time zone (runs every 15 min, handles owners
whose local midnight passed) upserts cards for tasks that became due and removes cards of
tasks whose snooze started.

## 7. Background jobs

| Job | Interval | Notes |
| --- | --- | --- |
| overdue detector | 15 min | emits `task.overdue` once (`overdue_emitted_at` column) |
| day change (cards) | 15 min | per time zone |
| auto-archive | nightly | `DONE` older than the owner's setting (default 30 days), from `owner_settings` projection (`profile.updated`) |
| suggestions | nightly | ≥ 3 manual tasks with the same normalised title in 7 days, not already covered by a routine |

## 8. Configuration

`AUTO_ARCHIVE_DAYS_DEFAULT=30`, `SUGGESTION_MIN_OCCURRENCES=3`.

## 9. Minimum lovable depth

Everything in v1 plus edit, snooze, area, Inbox, archive, repeat (via routines), focus.

## 10. Tests

Capture parser vectors (shared JSON file `contracts/fixtures/capture-syntax.json`, also used
by the web). Human step: create → awaiting → tick → completed result exactly once, tick again
→ no second result. Cancel after tick → ignored. Checklist card progress. Overdue emitted once
across two replicas.
