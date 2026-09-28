# today-service (new, M5)

## 1. Responsibility

A read model (CQRS projection) of **Today cards** per user. Domains publish cards; this
service stores the latest version of each, groups them for the Today screen, and pushes
"changed" hints over server-sent events. It has **no domain knowledge**: it never interprets
a card beyond the generic fields below.

## 2. Data (`today-db`)

```sql
CREATE TABLE cards (
  owner_id    uuid        NOT NULL,
  card_id     text        NOT NULL,          -- '<domain-scoped id>', e.g. 'task:<uuid>'
  domain      text        NOT NULL,
  kind        text        NOT NULL,
  section     text        NOT NULL,          -- now | today | later | attention
  sort_key    text        NOT NULL,          -- ISO timestamp or zero-padded rank
  local_date  date,                          -- the day the card belongs to (null = until removed)
  area_id     uuid,
  payload     jsonb       NOT NULL,          -- the full card
  version     bigint      NOT NULL,
  expires_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, card_id)
);
CREATE INDEX cards_owner_section_idx ON cards (owner_id, section, sort_key);

CREATE TABLE tombstones (                     -- removals, so a late upsert with a lower version stays removed
  owner_id uuid NOT NULL, card_id text NOT NULL, version bigint NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id, card_id)
);
CREATE TABLE owners (owner_id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Zurich');
CREATE TABLE stream_tickets (ticket text PRIMARY KEY, owner_id uuid NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
```

## 3. The card

```ts
interface TodayCard {
  ownerId: string;
  cardId: string;                  // unique per owner; prefix with the domain's own kind
  domain: string;                  // manifest domain id
  kind: 'item' | 'checklist' | 'metric' | 'event' | 'question' | 'checkIn' | 'attention' | 'suggestion';
  section: 'now' | 'today' | 'later' | 'attention';
  sortKey: string;                 // e.g. due time ISO, or '0001'
  localDate?: string;              // YYYY-MM-DD in the owner's zone; card hidden on other days
  areaId?: string | null;
  title: string;
  subtitle?: string;               // e.g. 'Work · from Weekly Review'
  icon?: string; tint?: Tint;
  source?: { routineId?: string; routineName?: string; executionId?: string };
  focus?: boolean;                 // picked in Plan my day
  items?: Array<{ id: string; title: string; subtitle?: string; done: boolean; action?: CardAction; choices?: CardAction[] }>; // checklist; `choices` = per-item options (review)
  selectable?: { max: number };    // checklist items are toggled locally and submitted with the primary action (focus picker)
  progress?: { done: number; total: number };
  metric?: { value: string; label: string; tone?: 'ok' | 'warn' | 'bad' };        // preformatted by the domain
  question?: { text: string; options: Array<{ value: string; label: string }>; action: CardAction };
  checkIn?: { prompt: string; scale: { min: number; max: number } | null; unit?: string; action: CardAction };
  actions?: CardAction[];          // at most 3 (primary first)
  href?: string;                   // where tapping the card goes, e.g. '#/budget?category=…'
  version: number;                 // monotonic per card (source row updated_at in ms)
  expiresAt?: string;
}

interface CardAction {
  kind: 'complete' | 'snooze' | 'answer' | 'open' | 'skip' | 'custom';
  label: string;
  value?: string;                  // machine value of a choice, e.g. 'tomorrow'
  request?: { method: 'POST' | 'PATCH'; path: string; body?: Record<string, unknown> }; // same-origin API call
  // for 'answer' and checkIn, the web merges the chosen value into body under 'value'
}
```

**Local selection:** for `selectable` cards and items with `choices`, the web keeps the user's
picks in local state and sends them with the card's primary action. It merges
`{ taskIds: [...] }` (selectable) or `{ decisions: [{ taskId: item.id, decision: choice.value }] }`
(choices) into `request.body`. Item choices have `kind: 'custom'`, a user-facing `label`
(*Tomorrow*) and a machine `value` (`tomorrow`).

**Rules:** `request.path` must start with `/api/v1/` (validated on ingest, otherwise the card
is rejected and logged). The web never evaluates anything else from a card. `metric.value` is
preformatted text, so the web needs no domain-specific formatting.

## 4. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/today` | `{ date, sections: { now, today, later, attention }, version }` for the caller's local date. Cards with `localDate` ≠ today or `expiresAt` in the past are excluded. `ETag` = max version. |
| `GET /api/v1/today/area/:areaId` | same, only cards of that area (used by the Area page) |
| `POST /api/v1/today/stream-ticket` | → `{ ticket }`: random, single use, valid 60 s, bound to the caller, stored in `stream_tickets` so any replica can redeem it |
| `GET /api/v1/today/stream?ticket=` | SSE (the ticket replaces the bearer token, which `EventSource` can't send): `event: changed` `data: {"version":…}` when any card of the caller changes; comment heartbeat every 30 s |
| `POST /api/v1/today/resync` | asks every domain to republish the caller's cards (`TodayResyncRequested`), rate-limited to 1/min |

## 5. Messages

Consumes `TodayCardUpserted` / `TodayCardRemoved` (`today-service.cards`): upsert if `version` >
stored and > tombstone. Remove: delete if `version` ≥ stored, write a tombstone. Consumes
`profile.updated` (time zone). Produces `TodayResyncRequested` (outbox).

**SSE fan-out across replicas:** a replica only knows about cards it consumed itself, so after
each commit the replica runs `NOTIFY today_changed, '<ownerId>'`. Every replica `LISTEN`s and
pushes to its own connected clients of that owner.

## 7. Background jobs

Tombstone cleanup (> 7 days), expired card cleanup: hourly, `SKIP LOCKED`.

## 10. Tests

Out-of-order upsert/remove (version rules). Invalid `request.path` rejected. Local date
filtering around midnight in two time zones. SSE across two replicas (system test).
