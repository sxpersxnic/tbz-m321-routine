# Routine – a personal management platform, driven by routines

The second product-evolution document. [product-evolution-01.md](product-evolution-01.md) treated
Routine as an **automation app** with tasks as one of its outputs. This one starts from a
different reading of the product:

> Tasks make Routine more than automation. It is a **personal management platform**,
> and routines are the engine that drives it.

The first document still holds for automation depth (triggers, reliability, integrations).
This one changes **what the product is about**, and therefore what goes on the home screen,
what the core objects are, and what gets built first. Section 8 lists exactly what changes
from the first document.

---

## 1. The idea

Most personal management tools are **containers**: a list app stores what you have to do,
a notes app stores what you know, a calendar stores where you have to be. You keep them
in order yourself, and most people's systems fall apart because the upkeep (reviewing,
re-planning, remembering recurring things) never happens.

Routine can be the opposite: **a system that keeps itself going.**

- **Routines are the rhythm**: every morning, every Friday, when something happens.
- **Tasks are the commitments**: what you personally have to do.
- Routines **create, gather, remind about and review** tasks. Some of their steps are done
  by the machine, and some are done by you.

Everything that recurs in your life, whether a weekly review, a morning checklist, paying
rent or watering plants, is a routine. Everything you have to act on shows up as a task,
in one place, at the right time.

### Positioning

| Tool | What it is | What it leaves to you |
| --- | --- | --- |
| Todoist, Things, Reminders | Lists of what to do | The system around the list: reviews, planning, recurring structure |
| Notion | A place to store everything | Everything: structure, upkeep, discipline |
| Apple Shortcuts, Zapier | What the machine does | Anything a person has to do |
| **Routine** | **The rhythm of your life, carried out by you and the machine together** | Deciding. The rest is prepared for you. |

---

## 2. Why the codebase is already halfway there

This isn't a pivot. Most of the pieces already exist:

| Already built | What it becomes |
| --- | --- |
| Tasks with smart lists (Today, Scheduled, Open, Done) and custom lists | The **commitments** layer, already modelled on Apple Reminders |
| `source_execution_id` on tasks | Every task knows **which routine run** put it there |
| Task service as an action worker (`action.task.create` → `action.completed`) | The basis for **steps you carry out yourself** (section 5.2) |
| The `WAITING` state and durable runs | A run can **wait hours or days for a person**, not only for a worker |
| `routine.run` with `{{input}}` / `result` | Reusable building blocks: a "plan the day" routine used by others |
| Notifications | **Signals**: things that need your attention, as opposed to your commitments |
| Schedules with a friendly picker | One engine for **everything that recurs** |

---

## 3. The product model

Five objects. Keeping them few and clearly separate is the most important design decision
in this document.

```text
            ┌──────────────────────── Area ────────────────────────┐
            │  Work · Health · Home · Money · …                    │
            │                                                      │
  Routine ──┼── runs ──► Steps ──┬── done by the machine           │
 (rhythm)   │                    └── done by you ──► Task          │
            │                                        (commitment)  │
            │  Capture ──► Inbox ──(a routine sorts it)──► Task    │
            │                                                      │
            │  Check-in ──► Entry  (a value you log: mood, sleep…) │
            └──────────────────────────────────────────────────────┘
                   Signals (notifications) point at any of these
```

| Object | Answers | Exists today? |
| --- | --- | --- |
| **Area** | "Which part of my life is this?" | Partly, as task lists. Lists grow into areas. |
| **Routine** | "What happens regularly, and when?" | Yes |
| **Task** | "What do I have to do?" | Yes |
| **Entry** | "How did it go?" (a logged value) | New |
| **Signal** | "What needs my attention right now?" | Yes (notifications) |

**Not added:** projects, notes, documents, goals as separate objects. Section 9 explains why.

---

## 4. Principles

1. **Anything that repeats is a routine.** No separate recurrence settings on tasks, habits
   or reminders. One engine and one mental model. A "repeating task" is a tiny routine with
   one step.
2. **The machine prepares, you decide.** Routines gather, sort and suggest. Choosing what to
   do, what to drop and what to move stays with the person.
3. **One place for today.** The home screen answers *"What's on today?"*, not
   *"How is the system doing?"*
4. **Calm by default.** A personal system that nags gets switched off. Signals are rare and
   worth reading, and everything else waits quietly in Today.
5. **Every task has a reason.** A task from a routine always shows where it came from and
   why, so it's easy to trust, and easy to change the routine instead of fighting its output.
6. **Automation depth stays one click away.** Unchanged from the first document. The M321
   systems view keeps its place under "Under the hood".

---

## 5. Features

Organised around the loop personal management runs on: **Capture → Plan → Do → Review**,
with routines driving each stage. Effort: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ weeks.

### 5.1 Today becomes the home screen · M

**Today** replaces the monitoring-style Overview as the first screen:

```text
Monday, 28 September                                     Good morning

  ┌ Morning routine ──────────── 2 of 5 ┐   ← a run waiting for you (5.2)
  │ ✓ Drink water   ✓ Stretch           │
  │ ○ Review today's plan  ○ …          │
  └─────────────────────────────────────┘

  Today                                        ← tasks due today, all areas
  ○ Write weekly review        Work · from Weekly Review
  ○ Pay rent                   Home · from Monthly bills
  ○ Call dentist               Health

  Later today                                  ← routines that will run
  17:30  Shutdown routine
  20:00  Evening check-in

  Needs attention (1)                          ← signals, only if any
  ⚠ "Backup reminder" failed twice. Fix
```

The system health view moves one level down, where it is still reachable and still
labelled. Nothing M321-related is removed.

### 5.2 Steps you do yourself · L, the key feature

**Problem:** A routine today can only do machine steps. A morning routine, a cleaning
checklist or a weekly review is mostly done by a *person*.

**Proposal:** A new kind of step: **"Do yourself"** (*"Stretch for 5 minutes"*). When the
run reaches it, it appears as a task in Today. When you tick it off, the run continues.
Steps can be mixed freely:

> *Every Friday 16:00* → **get** this week's done tasks (machine) → **you:** review open
> tasks → **you:** pick three priorities for next week → **send** summary to myself (machine)

Each "do yourself" step has a setting for when you don't get to it: **skip after** a
duration, **carry over** to tomorrow, or **fail the run**.

**How it works:** The task service already consumes `action.task.create` and replies
`action.completed`. A step with `waitFor: 'done'` makes it reply only **when the task is
completed**. The task becomes the step's in-progress state, and ticking it off is the
completion. No new engine concept is needed, only a new way for a step to finish.

**One change the engine needs:** `markStaleExecutions` turns runs with an unanswered step
into `WAITING` ("no worker response yet"). A step waiting for a *person* is not a fault and
needs its own state, **`WAITING_FOR_YOU`**, which is not counted as stale and is shown in
friendly words.

### 5.3 Checklist routines · S, after 5.2

A routine made only of "do yourself" steps is a checklist: morning routine, packing list,
end-of-month bookkeeping. The editor gets a **"Checklist"** starting point, and Today shows
it as one card with progress (*2 of 5*) instead of five separate tasks.

### 5.4 Repeating tasks are routines · S

**Proposal:** The New task dialog gets **Repeat** (*every weekday*, *every 1st of the month*).
Behind the scenes this creates a one-step routine that creates the task on schedule. It
appears under the task's area and on the Routines page as a normal routine, so it can later
grow into more (*"…and e-mail the landlord"*).

**Why not a recurrence field on tasks:** two recurrence systems drift apart in behaviour
(time zones, skipped days, pausing). One engine keeps "Pause everything while I'm on
holiday" true for everything.

### 5.5 Quick capture and an inbox that sorts itself · M

- **Capture** from anywhere: a global `+` / ⌘K, a webhook, later e-mail-in and a share
  sheet. Captured items land in the **Inbox list**, unsorted.
- **Sorting rules as routines:** *"When something is captured containing 'invoice' →
  move to Money, due in 7 days"*. This uses the event triggers from the first document
  (B1), with a new `task.created` event.
- A built-in **"Process inbox"** step in the daily planning routine walks you through
  what's left.

Naming: today the notifications page is labelled *Inbox* in the tab bar. Once capture
exists, **Inbox = things you captured** and **Notifications = signals**. Rename the short
label to avoid two meanings.

### 5.6 Built-in planning and review routines · M

Ready-made routines that make the Plan and Review stages happen, as templates the user can
edit like any other routine:

| Routine | When | What it does |
| --- | --- | --- |
| **Plan my day** | Weekday mornings | Gathers tasks due today and overdue ones. **You:** pick up to 3 to focus on. Leaves the rest in Today. |
| **Shutdown** | Weekday evenings | Shows what's still open. **You:** move each one to tomorrow, later or drop it. Ends with *"Done for today."* |
| **Weekly review** | Friday afternoon | Summary of the week (tasks done, routines run, habits kept). **You:** clear the inbox, check each area, choose next week's priorities. |
| **Monthly reset** | 1st of month | Review of paused routines and stale tasks: *"Nothing has happened in 'Garden' for 6 weeks. Archive?"* |

These show the product's promise, that the system keeps itself going, better than any
feature list. They are also why the first document's "Ask me" step (B4) moves up in
priority.

### 5.7 Areas · M

Task lists grow into **Areas**: *Work, Health, Home, Money*. An area groups its tasks
**and** its routines and has an overview page (*"Health: 3 routines, 2 open tasks, habit
streak 12 days"*). Lists inside an area stay possible but aren't required.

Migration: every existing list becomes an area, keeping its icon and colour. Routines get
an optional area, and the routine tile's colour can default to it.

### 5.8 Habits · S, after 5.3

A habit is a routine whose step you do yourself: *"Read 20 minutes, daily"*. The routine's
run history already is the habit record: a completed run is a day kept, and a skipped run is
a day missed. What's new is presentation only:

- A **streak and a calendar strip** on the routine and area pages.
- Gentle, **non-punishing** wording: *"4 of the last 7 days"*, not a broken-streak alarm.

No separate habit model. The run history already has the data.

### 5.9 Check-ins and personal records · M

A "do yourself" step can **ask for a value** instead of a tick: *"How did you sleep? 1–5"*,
*"Weight"*, *"Hours worked"*. The answer is stored as an **Entry** and shown as a small
chart on the area page. Routines can use it too:

> *If* `{{actions.sleep.value}}` *is less than 3* → *create task* "Go to bed by 22:30"

### 5.10 Your week · S

A calm weekly view, also sent by the Weekly review routine: tasks done per area, habits
kept, routines that ran for you, and the one that keeps failing. Its point is to show
that the system is working **for you**, without turning into a productivity score.

### 5.11 Calendar awareness · M, read-only

Import a calendar (ICS link) **read-only**, so Today shows meetings and routines can react to
them: *"30 minutes before any event called 'Interview' → create task 'Read CV'"*. Routine
doesn't become a calendar. It knows about yours.

---

## 6. How it stays a distributed system

This direction adds **new consumers, events and one read model**, all of which strengthen
the M321 story rather than dilute it.

### 6.1 A step done by a person, as a message flow

```text
Routine service                Broker                     Task service
      │ action.task.create        │                             │
      │ { waitFor: 'done' } ─────►│────────────────────────────►│ create task,
      │                           │                             │ remember actionId
      │   run: WAITING_FOR_YOU    │                             │
      │                           │                             │    … hours later …
      │                           │                     user ticks the task off
      │                           │◄──────── action.completed ──│ (idempotent: keyed
      │◄──────────────────────────│   { completedAt }           │  by actionId)
      │ next step                 │                             │
```

Durability matters more here than anywhere else: a person answering two days later, while
the routine service has been restarted twice, must still resume the run exactly once. The
outbox, idempotent consumers and durable queues already guarantee this.

### 6.2 Today as an event-driven read model

Today combines routines, runs, tasks and signals from three services. Querying all three on
every page load (gateway fan-out) couples them at read time. Instead, a **today-service**
(or "planner") keeps its own **projection**: it consumes `task.*`, `execution.*` and
`notification.*` events and maintains a ready-to-render Today per user.

This is **CQRS** in its textbook form, and it demonstrates *eventual consistency* in a way
users can see: tick a task and Today updates a moment later, even while the task service is
restarting.

### 6.3 New events and services

| Addition | Owner | Consumed by |
| --- | --- | --- |
| `task.created`, `task.completed`, `task.moved` | Task service | Today projection, event triggers, habits |
| `entry.recorded` | Task service (or a small records service) | Today, routines (`{{…}}`), charts |
| `execution.waiting_for_you` | Routine service | Today projection, notifications |
| **today-service** (projection) | New | Web client |
| **trigger-service** (from the first document, B1) | New | Starts routines from any of the events above |

Every new capability is a new consumer of events that already exist or are cheap to add.
That is the "publishers don't know who listens" property the architecture was designed for.

---

## 7. Roadmap

### Now: make routines and tasks one system (≈ 3–4 weeks)

| Feature | Effort | Why first |
| --- | --- | --- |
| Edit and snooze tasks (from the first document, E) | S | A personal system where you can't fix a task is broken |
| `task.created` / `task.completed` events | S | Everything below listens to them |
| Steps you do yourself + `WAITING_FOR_YOU` (5.2) | L | The idea that ties routines and tasks together |
| Checklist routines (5.3) | S | Makes 5.2 visible and useful on day one |
| Repeating tasks as routines (5.4) | S | Proves "anything that repeats is a routine" |

### Next: the daily loop (≈ 1–2 months)

| Feature | Effort |
| --- | --- |
| Today as home, backed by the today-service projection (5.1, 6.2) | M |
| Plan my day, Shutdown, Weekly review routines (5.6) | M |
| Event triggers (first document, B1) | L |
| Quick capture and the Inbox list (5.5) | M |
| Habits: streaks and calendar strip (5.8) | S |

### Later: the rest of life

| Feature | Effort |
| --- | --- |
| Areas (5.7) | M |
| Check-ins and records (5.9) | M |
| Your week (5.10) | S |
| Calendar awareness (5.11) | M |
| Delivery channels and actionable notifications (first document, D1/D2) | M |

---

## 8. What changes from the first document

| First document said | Now |
| --- | --- |
| "Don't build a full task manager" | Still true for *projects, subtasks and tags*, but tasks become a **core** object, not an output. Editing, snoozing and repeating move to **Now**. |
| Overview is a dashboard | Overview becomes **Today**. System health moves down a level. |
| Reach first: secrets vault and integrations | Integrations move to **Later**, except a read-only calendar. A personal system needs its own loop to work before it needs Slack. |
| "Ask me" step (B4) is a *Next* item | It is the foundation of steps you do yourself and moves to **Now**. |
| Event triggers (B1) are the highest-leverage feature | Still high, now fed mostly by **task events**, not only run events. |
| Trust features (resume, health, DLQ) | Unchanged. Trust matters even more when the system manages your commitments. |

---

## 9. What not to build

The biggest risk of this direction is **becoming everything**. Each of these is a product
of its own, and each would compete with a specialist on its home turf:

- **Notes, wiki, documents.** That's Notion or Obsidian. A task can have a description and a
  link, and that's all.
- **A full calendar.** Read-only awareness only. Don't schedule events or book time.
- **Projects with dependencies, Gantt charts, sub-sub-tasks.** Areas and routines give
  enough structure for a personal system.
- **Goals and OKRs as a separate object.** A weekly review routine that asks *"Did this
  week move your priorities?"* does more for people than a goal tracker they stop opening.
- **Gamification** (points, levels, streak-loss alarms). It works for a month, then makes
  people feel guilty. Streaks stay gentle (5.8).
- **Team features first.** This is personal management. Sharing a routine or a list with a
  household can come later (first document, F).

---

## 10. How to know it's working

The measure changes from *"do the routines run?"* to *"does the person keep using the
system?"*

| Metric | Target direction | Tells you |
| --- | --- | --- |
| Days per week Today is opened | ≥ 5 | Routine has become the daily home |
| Share of tasks created by routines | ↑ | Routines drive the system, rather than sitting beside it |
| Runs waiting for you that finish (not skipped or expired) | ↑ | Steps done by people are useful, not noise |
| Weekly review completed | ≥ 3 of 4 weeks | The system keeps itself going |
| Open tasks older than 30 days | ↓ | Shutdown and review routines keep lists honest |
| Routines paused by the user after < 1 week | ↓ | Signals stay calm enough to live with |
