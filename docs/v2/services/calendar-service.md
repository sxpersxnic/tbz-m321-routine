# calendar-service (new, M9) · domain `calendar`

## 1. Responsibility

**Read-only** awareness of the user's calendars through ICS subscription links. It imports
events, shows today's events on Today, offers values, and emits *event starting soon*
triggers. It never creates or edits calendar events.

## 2. Data (`calendar-db`)

```sql
CREATE TABLE calendars (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, color text,
  connection_id uuid NOT NULL,               -- connector-service connection of kind icsUrl
  last_synced_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, calendar_id uuid NOT NULL REFERENCES calendars ON DELETE CASCADE,
  uid text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz, all_day boolean NOT NULL,
  title text NOT NULL, location text, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calendar_id, uid, starts_at)       -- recurring instances expanded, 60 days ahead
);
CREATE TABLE soon_emitted (event_id uuid, minutes_before integer, PRIMARY KEY (event_id, minutes_before));
-- + outbox, processed_actions
```

## 3. HTTP API (`/api/v1/calendar/...`)

`GET/POST /calendars` (`POST { name, icsUrl }` → stores the URL in connector-service first,
then the calendar row), `DELETE /calendars/:id`, `POST /calendars/:id/sync`,
`GET /events?from=&to=`.

## 4. Behaviour and messages

- **Sync job** every 15 min per calendar (`SKIP LOCKED`): resolve the URL via connector-service,
  fetch (allow any https host, 5 MB cap, 10 s timeout, redirects checked like `http.request`),
  parse with `node-ical`, expand recurrences for 60 days, upsert, delete vanished events.
- **Soon job** every minute: events starting in 60, 30, 15 or 5 minutes (± 1 min) → emit
  `calendar.eventStartingSoon` (`eventId, title, location, startsAt, minutesBefore, calendarName`)
  once per `(event, minutesBefore)`.
- **Day job:** `calendar.dayStarted` (`date, count, firstStartsAt`) at 00:05 local.

## 5. Manifest (`calendar`, `optional: true`, tint sky, icon `calendar`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `calendar.todayEvents` | value | `calendarId` (ref calendars) | `items` [{title, startsAt, endsAt, location}], `count`, `first` |
| `calendar.nextEvent` | value | `titleContains` | `title, startsAt, minutesUntil` |
| `calendar.freeTime` | value | `date` | `freeMinutes, blocks` [{from, to}] |

Triggers: `calendar.eventStartingSoon` (filter e.g. `minutesBefore` equals 30 and `title`
contains "Interview"), `calendar.dayStarted`. Collections: `calendars`.

## 6. Today cards

`calendar:event:<id>` (`event` · today), sorted by start time, removed after the event ends.

## 9. Minimum lovable depth

Settings page to add or remove ICS calendars with sync status. Events on Today. There's no
separate calendar page in v2.

## 10. Tests

ICS fixtures: recurring events with exceptions, all-day events, time zones. Soon events
emitted once across replicas.
