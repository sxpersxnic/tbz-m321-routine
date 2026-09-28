# health-service (new, M7) · domain `health`

## 1. Responsibility

Personal metrics (sleep, mood, weight, water, anything the user defines), logged entries, and
**check-ins**: human steps that ask for a value. Habits are **not** stored here: a habit is a
routine flagged `habit`, and its history is the routine's run history
([../06-engine.md §9](../06-engine.md), `routine.habitStreak`).

## 2. Data (`health-db`)

```sql
CREATE TABLE metrics (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, unit text,
  kind text NOT NULL,                                   -- scale (1..5) | number | boolean
  icon text, color text, position integer NOT NULL, archived_at timestamptz,
  UNIQUE (owner_id, name)
);
CREATE TABLE entries (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, metric_id uuid NOT NULL REFERENCES metrics ON DELETE CASCADE,
  value numeric NOT NULL, note text, logged_at timestamptz NOT NULL, local_date date NOT NULL,
  source text NOT NULL,                                 -- manual | checkIn | routine
  source_action_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_metric_date_idx ON entries (metric_id, local_date DESC);
CREATE TABLE check_ins (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, metric_id uuid NOT NULL REFERENCES metrics,
  prompt text NOT NULL, awaiting_action_id uuid UNIQUE, state text NOT NULL,   -- open | answered | expired
  entry_id uuid, routine_name text, created_at timestamptz NOT NULL DEFAULT now()
);
-- + outbox, processed_actions
```

First use seeds metrics: Sleep (scale), Mood (scale), Weight (number, kg), Water (number,
glasses).

## 3. HTTP API (`/api/v1/health/...`)

`GET/POST /metrics`, `PATCH/DELETE /metrics/:id`, `GET /metrics/:id/entries?days=30`,
`POST /entries`, `POST /entries/quick` `{ text }`, `DELETE /entries/:id`, `POST /check-ins/:id/answer` `{ value, note? }`
(completes the human step), `GET /overview` (per metric: last value, 30-day series, average).

## 4. Messages

Events: `health.entryLogged` (`metricId, metricName, value, localDate, source`),
`health.checkInMissed` (`metricId, metricName`: emitted when a check-in expires).

## 5. Manifest (`health`, `optional: true`, tint pink, icon `heart`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `health.logValue` | action | `metricId`* (ref metrics), `value`*, `note` | `entryId, value` |
| `health.checkIn` | human (`awaits: checkIn`) | `metricId`*, `prompt` (default "How did you sleep?"-style from metric name) | `value, note, entryId` |
| `health.latest` | value | `metricId`* | `value, loggedAt` |
| `health.average` | value | `metricId`*, `days` (integer, default 7) | `average, count, min, max` |
| `health.series` | value | `metricId`*, `days` | `items` [{date, value}] |

Triggers: `health.entryLogged`, `health.checkInMissed`. Collections: `metrics`.
Quick entry: pattern `^(?<metric>\S+)\s+(?<value>\d+(?:[.,]\d+)?)$` (e.g. *sleep 4*), endpoint
`POST /api/v1/health/entries/quick` (metric resolved by name, case-insensitive; unknown name → `422`).

## 6. Today cards

`checkin:<id>` (`checkIn` · now) for open check-ins, with the scale or a number input.

## 9. Minimum lovable depth

The Health page ([../02-experience.md §11](../02-experience.md)): a card per metric with a
30-day sparkline, last value and a Log button. A metric editor. Habits section listing habit
routines with their calendar strip (data from routine-service `GET /routines/:id/habit`).

## 10. Tests

Check-in answer → exactly one result. `local_date` in the owner's time zone. Scale bounds
enforced (1–5).
