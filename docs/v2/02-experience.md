# 02 – Experience

Every screen of v2, as wireframes and rules. Wireframes show **structure and content**, not
pixels. The v1 visual language stays (Shortcuts-style tinted glyphs, gradient routine tiles,
sentence steps, soft motion). Section 16 lists the rules every screen follows.

Routes are hash routes, as in v1. Existing v1 routes keep working (see §15).

---

## 1. Navigation

### Desktop sidebar

```text
┌──────────────────────┐
│ ◉ Routine            │
│                      │
│ ☀ Today              │  ← home, route #/
│ ⌂ Inbox          3   │  ← captured, unsorted items
│ ↻ Routines           │
│                      │
│ LIFE                 │  ← only the domains the user turned on, in their order
│ ✓ Tasks              │
│ ◈ Budget             │
│ ♥ Health             │
│ ☺ People             │
│ ⌂ Home               │
│ + Add a domain       │
│                      │
│ AREAS                │  ← user-named, collapsible
│ ● Work               │
│ ● Flat               │
│ ● Family             │
│                      │
│ ACTIVITY             │
│ ▶ Runs               │
│ 🔔 Notifications  1  │
│                      │
│ UNDER THE HOOD       │
│ ≡ Infrastructure     │
│                      │
│ ⚙ Settings    ◐ ⌘K  │
└──────────────────────┘
```

### Phone tab bar

`Today · Routines · [ + ] · Life · Notifications`. The centre **+** opens Capture (§3).
**Life** is a hub listing enabled domains and areas. Runs, Infrastructure and Settings live
in the Life hub's footer.

### Rules

- Only **enabled** domains appear anywhere: sidebar, step picker, Today, templates.
- The badge on Inbox counts unsorted captured items. The badge on Notifications counts unread.
- ⌘K / Ctrl-K opens the command palette from every screen.

---

## 2. Today (`#/`)

The home screen. Everything comes from **Today cards** that domains and the routine service
publish ([services/today-service.md](services/today-service.md)). The screen has four
sections, in this order, and a section without cards is not rendered.

```text
Monday, 28 September                                         Good morning, Alex

┌ NOW ───────────────────────────────────────────────────────────────────────┐
│ ┌ Morning routine ─────────────────────────────────────────── 3 of 5 ─┐   │  checklist card
│ │ ✓ Drink water   ✓ Stretch   ✓ Review plan                           │   │  (run waiting for you)
│ │ ○ Take vitamins                                                      │   │
│ │ How did you sleep?   ① ② ③ ④ ⑤                                      │   │  check-in inline
│ └──────────────────────────────────────────────────────────────────────┘   │
│ ┌ Payday ──────────────────────────────────────────────────────────────┐   │  ask card
│ │ Transfer CHF 500 to savings?                        [ Done ] [ Skip ]│   │
│ └──────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘

TODAY                                                          Focus · All
  ○ Write weekly review          Work · from Weekly Review          ★
  ○ Pay rent                     Flat · Bill · CHF 1,850
  ○ Call Mum                     Family · last contact 3 weeks ago
  ○ Buy a present for Sam        Family · from Birthday · Sat
  ◈ Eating out   CHF 54 left · 12 days                                metric
  ▦ 14:00 Dentist (calendar)                                          event

LATER TODAY
  17:30  ↻ Shutdown
  20:00  ↻ Evening check-in

NEEDS ATTENTION
  ⚠ Backup reminder failed twice. The website said the page doesn't exist.   [ Fix ]
  💡 You created "Plan the day" by hand 4 times this week.         [ Make it a routine ]
```

**Behaviour**

| Element | Behaviour |
| --- | --- |
| Checklist card | One card per run waiting on human steps. Ticking an item completes that human step. The card disappears when the run moves on. |
| Check-in | Tapping a value answers `health.checkIn`. No confirmation dialog. |
| Ask card | Buttons map to the question's options. Answering resumes the run. |
| Task row | Tick = complete (optimistic, lingers ~1.5 s struck through, as in v1). Swipe or hover menu: *Tomorrow · Next week · Pick date* (snooze), *Move to area*, *Open*. |
| ★ Focus | Tasks the user picked in *Plan my day*. **Focus** filter shows only them. |
| Metric card | Tap opens the domain page filtered to it. |
| Later today | Routines scheduled to run later today. Tap opens the routine. |
| Needs attention | Unhealthy routines (with the plain-language fix, §8), over-budget categories, suggestions. |
| Empty day | *"Nothing on today."* plus one button: *Plan my day*. Never a wall of zeros. |

**Freshness:** Today updates within ~1 s of a change (server-sent events, polling fallback).
An item the user just ticked never flickers back (optimistic update wins until the server
confirms or rejects).

---

## 3. Capture and command palette

### Capture sheet (`+`, or `C` on desktop)

```text
┌ Capture ──────────────────────────────────────────┐
│ Call the landlord about the tap                   │
│                                                   │
│ Inbox · no date                   [ Add ]         │
└───────────────────────────────────────────────────┘
```

A single line of text lands in **Inbox** (a special task list). Quick syntax is recognised
and shown as pills before saving: `tomorrow`, `fri`, `!high`, `#Flat` (area). Everything else
is the title. Routines can sort the Inbox (event `task.captured`).

### Inbox (`#/inbox`)

A task list of unsorted items with one-tap actions per row: *Area ▾ · Date ▾ · Move to list ▾ ·
Delete*. When the list is empty: *"Inbox zero."*

### Command palette (⌘K)

```text
┌──────────────────────────────────────────────────────────┐
│ ⌘  14.50 lunch                                           │
├──────────────────────────────────────────────────────────┤
│ ◈ Record CHF 14.50 · Eating out              Budget  ↵   │  quick entry, parsed
│ ✓ Add task "14.50 lunch"                      Tasks      │
│ ↻ Run "Lunch log"                             Routine    │
│ ⌕ Search "lunch"                                         │
└──────────────────────────────────────────────────────────┘
```

Sources, in order: quick-entry parsers from domains, *Run routine …*, *Go to …*, *New …*,
search. Quick-entry patterns are declared by domain manifests (`quickEntry`, see
[04-domain-platform.md §3.7](04-domain-platform.md)).

---

## 4. Routines (`#/routines`)

v1's tile grid stays. Additions:

- **Health line** on each tile, quiet when healthy: *"28 of 28 this month"*. Tone changes only
  when unhealthy: *"Failed the last 3 runs"*.
- **Groups:** *My routines · Repeats* (one-step routines made by "Repeat" on a task, §9) ·
  *Habits*.
- **Domain dots:** small glyphs of the domains a routine uses (at most 4), so cross-domain
  routines are recognisable.
- Filter by area.

## 5. Routine detail (`#/routines/:id`)

```text
┌─ gradient hero in the routine's colour ───────────────────────────────────┐
│ ◉  Payday                                             [ ▶ Run ]  [ … ]   │
│    When income over CHF 3,000 is recorded                                 │
└───────────────────────────────────────────────────────────────────────────┘

Health       ✓ 11 of 11 runs · last 25 Sep
Habit        ■■■■□■■  5 of 7 days       (habits only)

Steps
  1  ◈ Set budgets from plan "Monthly"
  2  ✋ You: Transfer {{actions.plan.savings}} to savings          human step
  3  ◈ Add {{actions.plan.savings}} to goal "Holiday"
  4  🔔 Notify "Budgets are set for October"

Runs    ✓ ✓ ✓ ✓ ✗ ✓ ✓ …                                            All ›

▸ Under the hood   ID, version 7, event trigger, JSON
```

The `…` menu: *Settings · History · Duplicate · Share · Skip next run · Pause until…*.

### History (`#/routines/:id/history`)

```text
Version 7 · today 09:12            current
  Changed step 2: amount from "CHF 400" to {{actions.plan.savings}}
Version 6 · 3 Sep
  Added step: Notify "Budgets are set…"
Version 5 · 1 Sep                                   [ Restore ]
  …
```

The diff is in plain language, generated by the web client from two definitions ([07-web.md §8](07-web.md)). **Restore** creates a new version equal to the old one. It never
rewrites history.

---

## 6. Editor (`#/routines/new`, `#/routines/:id/settings`)

The v1 editor asks **When?** and **What?**. v2 keeps that and adds a third, optional question
for manual routines: **Ask when run?** (inputs).

### When?

```text
When?
  [ Manual ] [ Schedule ] [ Event ] [ Webhook ] [ Sun ]

  Event ─────────────────────────────────────────────────────
  When  [ Budget ▾ ] [ income is recorded ▾ ]
  Only if  [ amount ▾ ] [ is greater than ▾ ] [ 3000 ]      + condition
  ────────────────────────────────────────────────────────────
  Schedule extras:  Skip public holidays in [ Zürich ▾ ]
```

- **Event:** pick a domain, then one of its triggers (from manifests). Filters use the same
  comparisons as *If* steps.
- **Sun:** *At sunrise / sunset in [city]*, offset ± minutes.
- **Schedule:** v1 picker plus *Skip public holidays* and *Only in weeks …* (advanced).

### What? (the step picker)

```text
┌ Add a step ──────────────────────────────────────── ⌕ Search ─┐
│ SUGGESTED                                                     │
│   ◈ Add to savings goal       after "Record transaction"      │
│ YOU                                                           │
│   ✋ Do yourself     ❓ Ask me     ♥ Check-in                   │
│ TASKS                                                         │
│   ✓ Create task   ✓ Complete task   ✓ Get open tasks …       │
│ BUDGET                                                        │
│   ◈ Record transaction   ◈ Get remaining budget …            │
│ … one group per enabled domain …                              │
│ SCRIPTING                                                     │
│   If · Set variable · Calculate · Wait · Text · List · Run routine │
└───────────────────────────────────────────────────────────────┘
```

- Groups come from manifests. The **You** group lists human-step capabilities of every domain.
- Each step card shows its sentence with tokens (v1 style). Forms are generated from the
  manifest ([07-web.md §5](07-web.md)).
- **Try this step** (on value and scripting steps, and on actions that support preview) runs
  it with the last run's data and shows the result inline: *"→ CHF 54.00 left (82 % used)"*.
- Token pills show **example values** from the last run when there is one: `[Sunny, 21 °C]`
  instead of `[Weather · Summary]`.
- Human steps have a small **"If you don't get to it"** setting: *Keep waiting · Skip after …
  · Fail after …*.

### Ask when run? (manual routines)

```text
Ask when run?                                       + Add a question
  Which city?        Text      default "Bern"
  How many days?     Number    required
```

Running such a routine opens a small form. The values are `{{input.city}}` etc.

---

## 7. Runs and run detail (`#/executions`, `#/executions/:id`)

v1's run list stays, with two new statuses: **Waiting for you** (person icon) and **Waiting
until 17:00** (clock).

Run detail additions:

```text
Failed at step 3 of 4
┌──────────────────────────────────────────────────────────────────┐
│ ✗ Call "https://api.example.com/backup"                          │
│   The website said this page doesn't exist. The address may have │
│   changed.                                                       │
│   [ Retry from here ]   [ Edit step ]                            │
└──────────────────────────────────────────────────────────────────┘
  ✓ 1 Get weather            ✓ 2 Create task            ○ 4 Notify (not run)
```

- **Retry from here** resumes the run: completed steps keep their results, the failed step
  and the ones after it run again ([06-engine.md §6](06-engine.md)).
- A human step shows who it's waiting for and since when: *"Waiting for you since 07:30 ·
  skips at 12:00"*, with **Do it now** (opens the item) and **Skip**.
- **Under the hood** (collapsed): the v1 event log, plus a **waterfall** (one bar per step:
  queued → processing → done, per replica) and a Jaeger link.

---

## 8. Plain-language failures

Every failed step shows one sentence and one action, chosen by `errorCode`
([05-messaging.md §6](05-messaging.md)). The raw error stays under *Under the hood*.

| errorCode | Sentence | Action |
| --- | --- | --- |
| `NOT_FOUND` | The website said this page doesn't exist. The address may have changed. | Edit step |
| `UNAUTHORIZED` | The service didn't accept the key. It may have expired. | Open connection |
| `FORBIDDEN_HOST` | Routine isn't allowed to call this address. | Edit step |
| `TIMEOUT` | The service took too long to answer. | Retry from here |
| `UNREACHABLE` | The service couldn't be reached. | Retry from here |
| `RATE_LIMITED` | The service asked Routine to slow down. | Retry from here |
| `INVALID_PARAMS` | This step is missing something: {detail}. | Edit step |
| `TEMPLATE_ERROR` | A value this step uses wasn't there: {detail}. | Edit step |
| `NOT_AVAILABLE` | {Domain} isn't turned on or doesn't know this step any more. | Open settings |
| `REFERENCE_GONE` | The {thing} this step uses was deleted. | Edit step |
| `SUBROUTINE_FAILED` | The routine "{name}" it called failed. | Open that run |
| `AWAIT_EXPIRED` | Nobody did this in time. | Retry from here |
| `QUOTA_EXCEEDED` | This month's AI allowance is used up. | Settings |
| `AI_REFUSED` | The AI step declined this request. | Edit step |
| `INPUT_TOO_LARGE` | This step got more than it can handle: {detail}. | Edit step |
| `CONFLICT` | Something changed in the meantime, so this step couldn't go ahead. | Retry from here |
| `CANCELLED` | You cancelled this run. | Retry from here |
| `INTERNAL` | Something went wrong on our side. | Retry from here |

Run rows show a short form without details (*"A step is missing something."*). Failures
without a code (runs from before v2) keep their raw error.

---

## 9. Tasks (`#/tasks`)

v1's smart lists and custom lists stay. Additions:

- **Edit** everything inline or in the task sheet: title, notes, due date, priority, list, area.
- **Snooze** (*Tomorrow · Next week · Pick date*): hides the task from Today until then.
- **Repeat** in the New task dialog: *Never · Daily · Weekdays · Weekly · Monthly · Custom*.
  This creates a one-step routine (grouped under *Repeats*). The task row shows ↻.
- **Area** chip on each row. A filter by area.
- Done tasks auto-archive after 30 days (setting). **Archived** is a smart list.
- A task a routine created shows its source: *from Weekly Review* (links to the run, as in v1).

## 10. Budget (`#/budget`)

```text
Budget · September                                     [ + Record ]  [ Import ]
┌──────────────────────────────────────────────────────────────────────────┐
│ CHF 1,240 left of 3,900 · 12 days to go                                 │
│ ██████████████████████████████░░░░░░░░░░                                 │
└──────────────────────────────────────────────────────────────────────────┘
Categories
  Rent           1,850 / 1,850   ███████████████  paid
  Groceries        412 / 600     ██████████░░░░░
  Eating out       246 / 300     █████████████░░  82 %
  Gifts             50 / 100     ███████░░░░░░░░  planned 50
Bills due
  Phone            49.00  due 30 Sep                      [ Mark paid ]
Goals
  Holiday        2,300 / 4,000  ███████████░░░░░
Recent
  28 Sep  Migros            -34.20   Groceries
  28 Sep  Lunch             -14.50   Eating out     ⌘K
```

Sub-pages: **Transactions** (search, filter, bulk re-categorise), **Import** (drop a CSV or
camt.053 file, then preview, map columns (CSV only), confirm; duplicates detected and skipped),
**Plan** (monthly budgets per category), **Accounts**, **Bills & subscriptions**, **Goals**.
Amounts use the user's currency (default CHF) with `en-GB` formatting (`CHF 1,240.00`).

## 11. Health, People, Home

**Health (`#/health`):** a card per tracked metric (sleep, mood, weight, water, …) with a
30-day sparkline and the last value. **Log** button per metric. Habits (routines flagged as
habits) show as a calendar strip with gentle wording: *"5 of the last 7 days"*. There are no
broken-streak alarms.

**People (`#/people`):** a list with *Birthdays soon* and *Haven't talked in a while* at the
top. A person page has birthday, *contact every N weeks*, notes and interaction history.
**Log contact** is one tap.

**Home (`#/home`):** three columns (stacked on phone): **Shopping list** (tick off), **Chores**
(due / overdue, *Done* resets the cycle), **Supplies** (*low* / *ok* toggles).

## 12. Areas (`#/areas/:id`)

```text
● Flat
Now                      2 open tasks · Rent paid · 1 chore overdue
Tasks                    Fix the tap · Call landlord
Budget                   Rent · Utilities
Routines                 Monthly bills · Cleaning checklist
Home                     Clean the bathroom (overdue 2 days)
```

Areas collect **active** items from every domain (Today cards tagged with the area) plus the
routines assigned to it. Each group links to the domain page filtered by the area.

## 13. Notifications (`#/notifications`)

v1's inbox with search, filter, sort and bulk actions stays. Questions ("Ask me") show their
options as buttons in the card and in push notifications. An answered question shows the
answer and stays read-only.

## 14. Settings (`#/settings/*`)

| Page | Content |
| --- | --- |
| **Profile** | Name, time zone, currency, week start, *Pause all routines until…* (vacation mode) |
| **Areas** | Create, rename, recolour, reorder, archive. First visit offers *Turn your task lists into areas*. |
| **Domains** | Toggle domains on and off, reorder. Turning one off hides it and flags routines that use it. |
| **Connections** | Add an API key, an ICS calendar link or a chat webhook. Values are never shown again. *Last used* per connection. |
| **Delivery** | Channels (in-app, push on this device, e-mail digest, chat), quiet hours, per-priority rules |
| **AI** | On/off, monthly allowance used, privacy note |

## 15. Onboarding

1. Sign up → **"What would you like Routine to help with?"** (multi-select: Tasks, Money,
   Health, People, Home, Calendar). Tasks is preselected.
2. **"Start with a few routines"**: templates for the chosen domains, each with 1–3 **setup
   questions** (*Which city? What time? Which list?*). Choosing one creates a working,
   active routine without the editor.
3. Land on **Today**, which already shows the first cards.

Existing v1 users skip step 1 (Tasks and Notifications are enabled for them) and see a
one-time *"What's new in Routine"* card on Today.

### Your week (`#/week`)

A calm weekly summary (also sent by the *Weekly review* routine): per area, tasks done, money
spent vs. budget, habits kept, routines that ran for you, and the one routine that keeps
failing. No scores, no rankings.

## 16. Infrastructure (`#/system`) – under the hood

v1's topology, queues and replica view stay. Additions:

- **Dead letters:** a list per queue in words (*"2 notifications could not be delivered"*),
  expandable to the raw message, with **Replay** and **Discard**. Admin only.
- **Registry:** the registered domains, their manifest version, last heartbeat, and bindings.
- **Chaos switch** (demo mode): *Pause consuming* per service, which makes messages queue up
  visibly, then *Resume*. Also the chaos failure rate per service.
- **Demo scenarios:** v1's *Flaky Webhook, Load Test, Broken Endpoint, Heartbeat* moved here
  from the template gallery, each next to what it demonstrates.

## 17. Rules every screen follows

**Copy**

1. **English only**, locale `en-GB`, currency formatted with `Intl.NumberFormat`.
2. **Say each fact once per screen.** No sublines repeating a number shown elsewhere.
3. **Labels, not explanations.** Choices are segmented controls or pills. Blurbs go to `title`.
4. **Success is quiet.** Rows show a tick only. Words appear for failed or waiting states.
5. **Technical terms stay terms of art** under *Under the hood* (Queue, DLQ, Consumer, Retry,
   Replica, Trace). They never appear in the product surface above it.
6. **Human wording for machine states:** *Waiting for you*, *Waiting until 17:00*, *Budget is
   catching up* (worker unavailable), never `AWAITING_USER`.

**Feel**

7. **Fast:** optimistic updates for ticks, answers, snoozes and toggles. Spinner on the run
   button. **Soft:** tinted (not solid) active states, `--ease-out` motion, ticked items
   linger ~1.5 s.
8. **Calm:** push only for questions, human steps that were just requested, failures of
   routines marked important, and bills due tomorrow. Everything else goes to Today.

**Visual**

9. Every capability has a glyph and a tint (from its manifest). Tint is a second cue only. The
   label always says it too.
10. Tint gradients keep white text at ≥ 4.5:1 contrast (v1 palette). Don't use bright system
    colours behind text.
11. Domain colours: Tasks green, Budget teal, Health pink, People orange, Home indigo,
    Calendar sky, Notifications pink, Connections violet, Scripting grey.

**Accessibility**

12. Every interactive element is reachable by keyboard, has a visible focus ring and an
    accessible name. The checklist card is a `group` of checkboxes. The check-in scale is a
    `radiogroup`.
13. Live regions announce run status changes and Today updates caused by others (not by the
    user's own action).
14. Every new screen passes axe-core with zero violations ([10-quality.md §2](10-quality.md)).
