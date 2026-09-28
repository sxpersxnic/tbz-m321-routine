# home-service (new, M7) · domain `home`

## 1. Responsibility

The household: a shopping list, recurring chores with a cycle, and supplies that run low.

## 2. Data (`home-db`)

```sql
CREATE TABLE shopping_items (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, title text NOT NULL, quantity text,
  done_at timestamptz, source_action_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chores (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, every_days integer NOT NULL,
  last_done_at timestamptz, next_due_on date NOT NULL, area_id uuid, archived_at timestamptz,
  overdue_emitted_for date
);
CREATE TABLE supplies (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, level text NOT NULL DEFAULT 'ok',   -- ok | low | out
  add_to_shopping_when_low boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
-- + outbox, processed_actions
```

## 3. HTTP API (`/api/v1/home/...`)

`GET/POST /shopping`, `POST /shopping/quick` `{ text }`, `PATCH/DELETE /shopping/:id`, `POST /shopping/clear-done`;
`GET/POST /chores`, `PATCH/DELETE /chores/:id`, `POST /chores/:id/done`;
`GET/POST /supplies`, `PATCH/DELETE /supplies/:id`.

Setting a supply to `low` with `add_to_shopping_when_low` adds a shopping item in the same
transaction (inside one domain, so this is fine).

## 4. Messages

Events: `home.shoppingItemAdded` (`itemId, title`), `home.choreDue` (`choreId, name, dueOn`),
`home.choreOverdue` (`choreId, name, overdueDays`), `home.supplyLow` (`supplyId, name, level`).

## 5. Manifest (`home`, `optional: true`, tint indigo, icon `house`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `home.addToShoppingList` | action | `title`*, `quantity` | `itemId` |
| `home.completeChore` | action | `choreId`* (ref chores) | `nextDueOn` |
| `home.markSupplyLow` | action | `supplyId`* | `level` |
| `home.shoppingList` | value | – | `items` [{itemId, title, quantity}], `count` |
| `home.choresDue` | value | `withinDays` (default 0) | `items` [{choreId, name, dueOn}], `count` |

Triggers: the four events. Collections: `chores`, `supplies`. Quick entry: pattern
`^buy\s+(?<title>.+)$`, endpoint `POST /api/v1/home/shopping/quick`.

## 6. Today cards

`home:chore:<id>` (`item` · today) when due or overdue, action *Done*.
`home:shopping` (`metric` · today) when the list has ≥ 5 items: *"7 things to buy"*.

## 9. Minimum lovable depth

Shopping list with quick add and tick-off, chores with due state and *Done*, supplies with
level toggles.

## 10. Tests

Chore cycle roll-over, overdue emitted once per due date, supply low → shopping item exactly
once.
