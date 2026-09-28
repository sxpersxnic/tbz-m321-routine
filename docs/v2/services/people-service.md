# people-service (new, M7) · domain `people`

## 1. Responsibility

The people who matter to the user: birthdays, *keep in touch* intervals, notes and a log of
contacts. It is not a contacts app (no phone numbers or addresses sync) and not a CRM.

## 2. Data (`people-db`)

```sql
CREATE TABLE persons (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, relation text,          -- family | friend | work | other
  birthday_month integer CHECK (birthday_month BETWEEN 1 AND 12), birthday_day integer CHECK (birthday_day BETWEEN 1 AND 31),
  birth_year integer, contact_every_days integer, last_contact_at timestamptz, notes text,
  area_id uuid, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE interactions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, person_id uuid NOT NULL REFERENCES persons ON DELETE CASCADE,
  kind text NOT NULL,                                      -- call | message | meeting | other
  note text, at timestamptz NOT NULL, source_action_id uuid UNIQUE
);
CREATE TABLE reminders_emitted (person_id uuid, kind text, for_date date, days_before integer,
  PRIMARY KEY (person_id, kind, for_date, days_before));
-- + outbox, processed_actions
```

## 3. HTTP API (`/api/v1/people/...`)

`GET/POST /persons`, `GET/PATCH/DELETE /persons/:id`, `POST /persons/:id/interactions`,
`GET /persons/:id/interactions`, `POST /interactions/quick` `{ text }`, `GET /overview` (birthdays in the next 30 days, contact due).

## 4. Messages

| Event | Fields | When |
| --- | --- | --- |
| `people.birthdayUpcoming` | `personId, name, date, age?, daysBefore` (14, 7, 1, 0) | daily job, once per value |
| `people.contactDue` | `personId, name, lastContactAt, overdueDays` | once when `now > last_contact_at + contact_every_days`, again every further interval |
| `people.contactLogged` | `personId, name, kind` | interaction added |

## 5. Manifest (`people`, `optional: true`, tint orange, icon `person`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `people.logContact` | action | `personId`* (ref persons), `kind`, `note` | `interactionId` |
| `people.addNote` | action | `personId`*, `note`* | `personId` |
| `people.birthdays` | value | `days` (default 30) | `items` [{personId, name, date, age}], `count` |
| `people.notContactedSince` | value | `days`* | `items` [{personId, name, lastContactAt}], `count` |

Triggers: the three events. Collections: `persons`. Quick entry: pattern
`^(?<kind>called|met|texted)\s+(?<name>.+)$`, endpoint `POST /api/v1/people/interactions/quick`
(person matched by name prefix; ambiguous or unknown → `422` with candidates).

## 6. Today cards

`people:birthday:<id>` (`item` · today) on the day. `people:contact:<id>` (`item` · today) when
contact is due, action *Log contact*.

## 9. Minimum lovable depth

A list with *Birthdays soon* and *Haven't talked in a while* at the top, a person page, and
one-tap *Log contact*.

## 10. Tests

Birthday on 29 Feb in non-leap years → 28 Feb. Reminders emitted once per `days_before` across
replicas.
