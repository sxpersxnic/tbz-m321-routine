# budget-service (new, M6) · domain `budget`

The reference domain: the first one built entirely on the domain kit. If building it needs a
change in routine-service, web core or broker definitions, the platform contract is wrong and
must be fixed first ([../04-domain-platform.md](../04-domain-platform.md)).

## 1. Responsibility

Accounts, transactions, categories, monthly budgets, bills and subscriptions, savings goals,
statement imports and categorisation rules. It **never moves money**: payments and transfers
are human steps.

## 2. Data (`budget-db`)

All amounts are `bigint` minor units plus the owner's currency (single currency per owner in
v2: multi-currency is out of scope).

```sql
CREATE TABLE accounts (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL,    -- checking | savings | cash | credit
  iban_hint text, opening_balance_minor bigint NOT NULL DEFAULT 0, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE categories (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL,    -- expense | income | transfer
  icon text, color text, area_id uuid, position integer NOT NULL, archived_at timestamptz,
  UNIQUE (owner_id, name)
);
CREATE TABLE budgets (                                   -- one row per category and month
  owner_id uuid NOT NULL, category_id uuid NOT NULL REFERENCES categories ON DELETE CASCADE,
  month date NOT NULL, amount_minor bigint NOT NULL, PRIMARY KEY (category_id, month)
);
CREATE TABLE plans (                                     -- the default monthly budget per category
  owner_id uuid NOT NULL, category_id uuid NOT NULL REFERENCES categories ON DELETE CASCADE,
  amount_minor bigint NOT NULL, PRIMARY KEY (category_id)
);
CREATE TABLE transactions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, account_id uuid REFERENCES accounts,
  booked_on date NOT NULL, amount_minor bigint NOT NULL,                                  -- negative = expense
  payee text, note text, category_id uuid REFERENCES categories, area_id uuid,
  source text NOT NULL,                                                                   -- manual | quick | import | routine
  source_action_id uuid UNIQUE, import_hash text, planned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, import_hash)
);
CREATE INDEX transactions_owner_month_idx ON transactions (owner_id, booked_on);
CREATE TABLE bills (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, amount_minor bigint NOT NULL,
  category_id uuid REFERENCES categories, due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  interval_months integer NOT NULL DEFAULT 1, next_due_on date NOT NULL, is_subscription boolean NOT NULL DEFAULT false,
  last_paid_on date, area_id uuid, archived_at timestamptz
);
CREATE TABLE goals (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL, target_minor bigint NOT NULL,
  saved_minor bigint NOT NULL DEFAULT 0, target_date date, reached_at timestamptz
);
CREATE TABLE rules (                                     -- categorisation rules (also created by routines)
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, match_field text NOT NULL,                 -- payee | note
  match_text text NOT NULL, category_id uuid NOT NULL REFERENCES categories ON DELETE CASCADE, position integer NOT NULL
);
CREATE TABLE imports (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, format text NOT NULL, filename text, rows_total integer,
  rows_imported integer, rows_duplicate integer, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE thresholds_emitted (owner_id uuid, category_id uuid, month date, percent integer,
  PRIMARY KEY (category_id, month, percent));
-- + outbox, processed_actions (domain kit)
```

`import_hash` = SHA-256 of `account_id | booked_on | amount_minor | normalised payee | bank reference`.

## 3. HTTP API (`/api/v1/budget/...`)

| Method & path | Purpose |
| --- | --- |
| `GET /summary?month=YYYY-MM` | totals, per-category spent/budget/percent, bills due, goals |
| `GET/POST /accounts`, `PATCH/DELETE /accounts/:id` | |
| `GET/POST /categories`, `PATCH/DELETE /categories/:id`, `POST /categories/reorder` | first `GET` for a new owner seeds defaults (Rent, Groceries, Eating out, Transport, Health, Gifts, Subscriptions, Savings, Salary) |
| `GET /transactions?month=&categoryId=&q=&limit=&cursor=` | |
| `POST /transactions`, `PATCH/DELETE /transactions/:id`, `POST /transactions/bulk` | bulk re-categorise |
| `POST /transactions/quick` | `{ text }`: parses `^(\d+(?:[.,]\d{1,2})?)\s+(.+)$`, category by rules, then by the last category used for that note, else "Uncategorised" |
| `GET/PUT /plan` | default monthly budgets |
| `PUT /budgets/:month` | budgets of one month |
| `GET/POST /bills`, `PATCH/DELETE /bills/:id`, `POST /bills/:id/paid` | |
| `GET/POST /goals`, `PATCH/DELETE /goals/:id`, `POST /goals/:id/contributions` | |
| `GET/POST /rules`, `DELETE /rules/:id` | |
| `POST /imports` (multipart: `file`, `format` = `csv` or `camt053`, `accountId`) | → preview `{ importId, rows: [...first 50], duplicates, mapping? }` |
| `POST /imports/:id/confirm` | `{ mapping? }` (CSV columns: date, amount, payee, note) → imports, emits events |

Limits: 5 MB, 5,000 rows per import. camt.053: parse `BkToCstmrStmt/Stmt/Ntry` (`Amt`,
`CdtDbtInd`, `BookgDt/Dt`, `NtryDtls/TxDtls/RltdPties`, `AcctSvcrRef`) with `fast-xml-parser`.

## 4. Messages

Produces (outbox → `domain.events`):

| Event | Fields | When |
| --- | --- | --- |
| `budget.transactionRecorded` | `transactionId, amount, payee, note, categoryId, categoryName, accountId, bookedOn, source` | any expense or transfer recorded |
| `budget.incomeRecorded` | same | a positive transaction in an income category |
| `budget.categoryThresholdReached` | `categoryId, categoryName, percent` (50, 80, 100), `spent, budget, remaining` | first time per month and percent (`thresholds_emitted`) |
| `budget.billDueSoon` | `billId, name, amount, dueOn, daysBefore` (7, 3, 1, 0) | daily job |
| `budget.monthStarted` | `month` | first day of month, 00:05 local |
| `budget.goalReached` | `goalId, name, target` | |

Amounts in events are major units (numbers), consistent with outputs.

## 5. Manifest (`budget`, `optional: true`, tint teal, icon `wallet`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `budget.recordTransaction` | action (`preview`) | `amount`* (money; negative = expense is **not** required: `direction` choice expense/income, default expense), `categoryId` (ref categories), `accountId` (ref accounts), `payee`, `note`, `date`, `planned` (boolean) | `transactionId, amount, categoryName, remaining` |
| `budget.setBudget` | action | `categoryId`*, `amount`*, `month` (date, default this month) | `categoryId, amount` |
| `budget.applyPlan` | action | `month` (date) | `count, total` |
| `budget.moveBudget` | action | `fromCategoryId`*, `toCategoryId`*, `amount`* | `from, to` |
| `budget.markBillPaid` | action | `billId`* | `billId, nextDueOn` |
| `budget.addToGoal` | action | `goalId`*, `amount`* | `saved, target, percent` |
| `budget.categorize` | action | `transactionId`*, `categoryId`*, `rememberRule` (boolean) | `transactionId` |
| `budget.categoryRemaining` | value | `categoryId`*, `month` | `remaining, spent, budget, percent` |
| `budget.spent` | value | `categoryId`, `from` (date), `to` (date) | `total, count` |
| `budget.upcomingBills` | value | `days` (integer, default 7) | `items` [{billId, name, amount, dueOn}], `count`, `total` |
| `budget.accountBalance` | value | `accountId`* | `balance` |
| `budget.goalProgress` | value | `goalId`* | `saved, target, percent` |
| `budget.monthSummary` | value | `month` | `income, expenses, net, overBudget` (list of category names) |

**No transfer capability, on purpose.** Moving money is a human step: routines use the
generic `task.await` with a title like *"Transfer {{actions.plan.savings}} to savings"*,
followed by `budget.addToGoal` or `budget.recordTransaction`. The Payday template does
exactly that. Budget must not create tasks itself: a domain never writes into another
domain's store.

Triggers: the six events of §4 with their fields.

Collections: `categories` (`/api/v1/budget/categories`), `accounts`, `bills`, `goals`.

Quick entry: `expense`, pattern `^(?<amount>\d+(?:[.,]\d{1,2})?)\s+(?<note>.+)$`, endpoint
`/api/v1/budget/transactions/quick`, label *"Record {amount} · {note}"*.

Templates (single-domain): *Budget watch* (threshold 80 % → notification), *Month start*
(`budget.monthStarted` → `budget.applyPlan`).

## 6. Today cards

| Card | Kind · section | When |
| --- | --- | --- |
| `budget:category:<id>` | `metric` · today | category ≥ 80 % this month: *"CHF 54 left · 12 days"*, tone warn/bad |
| `budget:bill:<id>` | `item` · today | bill due today or overdue, action *Mark paid* |
| `budget:over:<id>` | `attention` · attention | category ≥ 100 % |

## 7. Background jobs

Daily (per time zone, 15-min tick): bill due events, month start, bill `next_due_on` roll-over
after payment. All replica-safe with `SKIP LOCKED` / unique constraints.

## 9. Minimum lovable depth

The Budget page in [../02-experience.md §10](../02-experience.md): month overview, categories
with progress, bills, goals, recent transactions, quick entry, CSV and camt.053 import with
preview and duplicate detection, rules, plan.

## 10. Tests

Money rounding (`14.505` → rejected, 2 decimals max). Import dedupe on re-import of the same
file. Threshold events once per month and percent across two replicas. camt.053 fixture
parsing (a real anonymised sample in `services/budget-service/test/fixtures/`). Quick-entry
parser vectors shared with the web (`contracts/fixtures/quick-entry-budget.json`).
