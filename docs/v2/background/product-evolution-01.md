# Routine – how the product could evolve

A product-design view of where Routine stands today and where it could go next.
Every proposal is tied to the code as it exists, and says which service would own
it, so the roadmap keeps strengthening the distributed-systems core rather than
working around it.

---

## 1. Where Routine stands today

### What a user can do

| Area | Today |
| --- | --- |
| **Start a routine** | Manually, on a schedule (friendly picker, cron under "Advanced"), or by a secret webhook URL |
| **Steps** | Weather, HTTP request, summary, create task, notification, e-mail |
| **Scripting** | Variables, if-conditions (`runIf`), repeat-for-each, maths, calling another routine like a function (`routine.run`) |
| **Data flow** | `{{actions.x.y}}`, `{{vars.…}}`, `{{trigger.body}}`, `{{item}}` shown as pills in the editor |
| **Runs** | Live progress, per-step status, automatic retries with back-off, `WAITING` when a worker is down, "Run again" |
| **Outputs** | Tasks in custom lists (icon, colour), Notifications inbox with search, filter, sort and bulk actions |
| **Look** | Shortcuts-style tiles with icon and colour per routine, sentence-style steps, template gallery on first run |
| **Under the hood** | Topology, queues, DLQ count, retries, trace IDs: labelled, one click away |

### What it does well

1. **Onboarding teaches the product.** The template gallery and "When? / What?" editor
   mean a newcomer never has to read cron or JSON.
2. **Runs are honest.** Status, attempts and waiting states are shown truthfully, not
   smoothed over.
3. **The architecture is sound.** An outbox, idempotent consumers, a DLQ and horizontal
   workers are the foundations serious automation products are built on.

### Where it falls short

| Gap | Evidence in the code | Why it hurts |
| --- | --- | --- |
| Nothing inside Routine can start a routine | Triggers are `manual \| schedule \| webhook` only (`domain/definition.ts`) | Routines can't react to each other, to tasks, or to failures |
| A failed run can only be restarted from scratch | `POST /routines/:id/executions` is the only way in; no step-level retry | Re-running repeats side effects that already succeeded (e-mails, tasks) |
| Secrets live in plain params | `http.request` copies `params.headers` verbatim (`integration-worker/src/actions.ts`) | API keys sit readable in the routine JSON, runs and logs |
| Edits overwrite the routine with no history | `version = version + 1` but no history table | Users can't undo or compare changes, or see which version a run used |
| Only one way to reach you | Notification service writes `channel: 'inbox'` only | Nothing reaches the user when the app is closed |
| Tasks are write-once | Task API only `PATCH`es `status` | You can't fix a typo or snooze a task a routine created |
| Demo scenarios mixed with real templates | "Flaky Webhook", "Load Test", "Broken Endpoint" sit next to "Morning Setup" | New users are shown test fixtures as if they were products |
| Only one real external integration | `weather.get` hits the mock service | Beyond HTTP, there is no way to connect a real account |

---

## 2. Product thesis

> **Routine is the automation you can trust.**
> Shortcuts-level simplicity on the surface, with a guarantee underneath that
> no run is lost, nothing happens twice, and you always know why something happened.

Other tools already cover simplicity (Apple Shortcuts, IFTTT) and power (n8n, Zapier).
Routine can own **trustworthiness**, and the M321 architecture is exactly what that needs.
Every feature below should either:

- let people **automate more of their week** (reach), or
- make them **trust it with more important things** (confidence).

### Design principles, continued

These extend the principles already in use:

1. **Teach first, depth on demand.** Every new capability gets a plain-language front
   and an optional "Under the hood" view.
2. **Sentences, not diagrams.** Steps read as sentences in lanes. Don't add a free-form
   node canvas: it would bring in all the complexity this UI was built to avoid.
3. **Say it once.** One name per concept, labels over explanations.
4. **Nothing silent.** Anything the system does on its own, like retrying, waiting or
   skipping, is visible in the run, in words.
5. **Reversible by default.** Pausing, undoing and restoring should be easier than deleting.

---

## 3. Themes and features

Effort: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ several weeks.

### Theme A: Trust: make reliability something the user can see

The architecture already guarantees a lot. These features make those guarantees
something users experience directly, and they are also the strongest material for the
M321 demo.

#### A1. Resume from the failed step · M
**Problem:** "Run again" restarts everything. If step 3 of 4 failed, the e-mail in
step 1 goes out again.
**Proposal:** On a failed run, show **"Retry from here"** on the failed step. Completed
steps keep their outputs, and only the failed step and the ones after it run again.
**Architecture:** Routine service re-emits `ActionRequested` for the failed action with a
new attempt number. The idempotency keys already on every action mean a worker that
did finish the first time answers with its stored result. This finally closes
requirement 10 ("allow failed actions to be retried") in the UI.

#### A2. Failure explanations with a fix · S
**Problem:** "404" or "ECONNREFUSED" means nothing to a non-technical user.
**Proposal:** Map error classes to one sentence and one action:
*"The website said this page doesn't exist. The address may have changed. **Edit step**"*.
Keep the raw error under "Under the hood".
**Architecture:** Workers already separate `PermanentError` and `TransientError`. Add
a stable `errorCode` to `ActionFailed` and keep the wording in the client.

#### A3. Routine health · S
**Proposal:** Each tile gets a quiet health signal: *"Ran 28 of 28 times this month"* or
*"Failed the last 3 runs"*. If a routine keeps failing, the Overview shows it at the top
with the fix from A2. Optional: *"Tell me if this routine fails twice in a row"*.
**Architecture:** Computed from `executions`. Alerting is a consumer of the existing
`execution.failed` event in the notification service.

#### A4. Version history and restore · M
**Problem:** Saving overwrites the routine for good.
**Proposal:** A **History** item in the routine's "…" menu: a timeline of versions, a
plain-language diff (*"Changed city from Bern to Zurich"*, *"Added step: Send e-mail"*)
and **Restore**. Each run records the version it used, and the run page links to it.
**Architecture:** A `routine_versions` table holding definition snapshots. `version`
already exists, so an execution only needs to store it.

#### A5. Test a step before saving · M
**Proposal:** **"Try this step"** in the editor runs one step on its own, using the
outputs of the last real run as sample input, and shows the result inline. The token
pills (`{{actions.weather.summary}}`) then show real example values (*"Sunny, 21 °C"*)
instead of paths.
**Architecture:** A `dryRun` flag on the command. Workers for steps with side effects
(`email.send`, `task.create`) answer with a preview instead of acting.

#### A6. DLQ in the UI · S
**Proposal:** The Infrastructure page lists what's in the dead-letter queues, in words
(*"2 notifications could not be delivered"*), with **Replay** and **Discard**. This
replaces `scripts/replay-dlq.sh` for day-to-day use.
**Architecture:** A gateway endpoint on the RabbitMQ management API. This is a real
feature, and it also makes a strong grading moment.

---

### Theme B: Reach: more ways to start, more things to do

#### B1. Event triggers ("When…") · L, highest-leverage feature
**Problem:** Routines are isolated. They can't react to each other or to things that
happen inside Routine.
**Proposal:** A fourth kind of start in the "When?" step:

- *When a task in* **Work** *is completed*
- *When the routine* **Weekly Review** *finishes / fails*
- *When a notification with priority* **High** *arrives*
- *When an e-mail arrives at* `your-routine@…` (later)

**Architecture:** This is the purest use of the broker the system has. The routine
service already publishes `execution.completed` / `execution.failed`. The task and
notification services would add their own domain events (`task.completed`,
`notification.created`) next to the action results they already send. A new
**trigger-service** (or a module in the routine service) subscribes to them, matches
them against routine subscriptions, and publishes `routine.triggered`. The publishers
never need to know who listens. Loop protection reuses the `call_depth` idea from
`routine.run`.

#### B2. More ways to schedule · M
- **Relative to the sun:** *"At sunset in Zurich"*.
- **Skip rules:** *"…except on public holidays"*, *"…only in the first week of the month"*.
- **Snooze / skip next run** from the tile's menu.
- **Vacation mode:** pause all routines until a date, with one switch on the Overview.

**Architecture:** Scheduler logic in the routine service, plus a holiday calendar as a
worker action or a static dataset.

#### B3. Ask for input when run · S
**Proposal:** A manual routine can declare inputs (*"Which city?"*, *"How many days?"*).
**Run** opens a small form, and the values are available as `{{input.city}}`, which
`routine.run` already uses for subroutines.
**Payoff:** Turns routines into small personal tools, not just timers.

#### B4. Wait and ask steps (human in the loop) · M
New engine-side steps:

- **Wait** *for 2 hours* / *until 17:00*.
- **Ask me:** sends an actionable notification (*"Send the weekly report to the team?"
  **Send · Skip***), and the run waits in `WAITING` until you answer or it times out.

**Architecture:** This fits the existing state machine: `WAITING` already exists, and a
`UserResponded` event resumes the run. Durable waiting is where a message-driven design
beats a script, so it makes a strong demo.

#### B5. Connected accounts and a secrets vault · L, prerequisite for real integrations
**Problem:** API keys sit in plaintext params.
**Proposal:** A **Connections** page: add a named secret or OAuth account once, and pick
it from a list in any step (*"Use connection: GitHub (personal)"*). Secrets are never
shown again, never logged, and never copied into run records.
**Architecture:** A new **connector-service** owns encrypted credentials. Workers
resolve `{{secrets.github}}` at execution time through a short-lived, scoped lookup,
so the routine service never sees the value. This is another clearly separated service
with its own data store, which fits the M321 service split.

#### B6. First real integrations · M each, after B5
Choose integrations by what people automate every week, not by how many there are:

1. **Calendar (ICS / Google):** *"Tomorrow's first meeting"*, trigger *"30 min before
   an event"*.
2. **Chat (Slack / Teams / Discord webhook):** *"Post a message"*.
3. **RSS / web page change:** *"When this page changes"*, the gentlest way into polling triggers.
4. **Real weather provider** behind the same `weather.get` contract. The mock stays for demos.

Each one is a new `action.<type>` queue consumed by a worker, so the routine service
doesn't change at all. This shows the contract-first design working.

#### B7. Text and list steps · S
Small engine steps that make data flow useful: **Format text**, **Get item from list**,
**Count**, **Filter list** (*"items where temperature > 20"*), **Parse JSON**. Shortcuts
shows that these small building blocks are what make scripting usable.

#### B8. AI step · M, optional
**Summarise / Rewrite / Extract** with a language model, e.g. *"Summarise these 12
headlines in 3 bullet points"*. `summary.generate` already sits where this would go.
Keep it a normal worker action with a clear cost and privacy note, and never a hidden
part of other steps.

---

### Theme C: Creation: from blank page to a running routine faster

#### C1. Separate templates from demo scenarios · S, quick win
The gallery should only show routines a real person wants. Move *Flaky Webhook*,
*Load Test*, *Broken Endpoint* and *Heartbeat* to a **"Demo scenarios"** section on the
Infrastructure page, next to what they demonstrate.

#### C2. Templates that ask setup questions · S
*"Morning Setup"*: **Which city? What time? Which list should tasks go to?** Three
questions, then it's running. No editor needed for the common case.

#### C3. Describe it in your own words · M
*"Every Friday at 4, remind me to log my hours and e-mail my manager a summary."*
This produces a **draft** routine in the normal editor for review, never one that runs
straight away. The existing validation (`validateRoutine`) checks the result, so the
AI can't produce anything the editor couldn't.

#### C4. Suggestions from behaviour · S
*"You create a 'Plan the day' task by hand most mornings. Turn it into a routine?"*
Only suggest from data the user can see, and let them dismiss suggestions for good.

#### C5. Share and import · M
**Export** a routine as a file or link, and **Import** it with a preview of what it will
do. Connections (B5) are left out and asked for on import. A shared gallery can come
later, once imports are safe.

---

### Theme D: Presence: reach the user outside the web app

#### D1. Delivery channels · M
Notifications can go to **Inbox**, **Web push**, **E-mail digest** or **Chat**, chosen
per routine or globally, with **quiet hours**.
**Architecture:** The notification service already writes `channel: 'inbox'`. Split out
a **delivery-service** that consumes `NotificationCreated` and fans out per channel. If
a channel fails, only its own queue is affected, which is the M321 failure demo again
with a user-visible benefit.

#### D2. Actionable notifications · S, after D1
Buttons on notifications: **Complete task**, **Run again**, **Approve** (for B4). An inbox
becomes a place to act, not only to read.

#### D3. Installable app and quick runs · M
- **PWA** (installable, offline shell, push).
- **Command palette** (⌘K): *run*, *go to*, *create*.
- **Home-screen shortcuts** for favourite routines, and later a native Shortcuts/Siri
  bridge via the webhook trigger.

#### D4. Weekly recap · S
A Monday card and optional e-mail: *"Routine ran 34 times for you last week, created 9
tasks and needed you once."* This reminds people of the value and points out routines
that are failing (A3).

---

### Theme E: Outputs: tasks and notifications worth keeping

Routine shouldn't turn into a task manager. Tasks and notifications are **outputs**:
they should be good enough to act on, then get out of the way.

| Feature | Effort | Note |
| --- | --- | --- |
| Edit a task (title, due date, list, priority) | S | Currently only status can change |
| Snooze a task / notification | S | *"Tomorrow"*, *"Next week"* |
| "Created by" link on tasks and notifications | exists for tasks | Extend to notifications: jump to the step that produced it |
| Auto-archive done tasks after N days | S | Keeps lists calm |
| Send tasks to Reminders / Todoist | M | An integration (B6), not a feature to rebuild |

---

### Theme F: Together: shared routines · L, later

Households and small teams: **shared routines**, **roles** (owner / editor / viewer),
**shared task lists**, and an **activity log** (*"Anna changed the schedule"*).
Every table is currently scoped by `owner_id`, so this needs a `workspace_id` across
services. Do it only once single-user retention is proven.

---

## 4. Making the systems story a feature

The M321 depth isn't a side feature. It is Routine's differentiator, so it should
evolve as well.

| Proposal | What the user sees | What it demonstrates |
| --- | --- | --- |
| **Run timeline** (waterfall) | Where time went in a run: *"Waited 4 s for the weather service"* | `trace_id` across services, async hand-offs |
| **Idempotency made visible** | *"This webhook call was a duplicate. Nothing happened twice."* on the run | Idempotency keys |
| **Chaos switch** (demo mode only) | Stop a service from the Infrastructure page and watch runs wait, then resume | Durable queues, `WAITING`, recovery |
| **DLQ replay** (A6) | *"2 messages failed for good. Replay?"* | Dead-lettering, manual recovery |
| **Scaling view** | Which worker replica ran each step | Horizontal scaling, competing consumers |

Each one gives a user a reason to trust the system and gives a grader something to see.

---

## 5. Roadmap

### Now: quick wins that build trust (≈ 2–3 weeks)

| # | Feature | Effort |
| --- | --- | --- |
| C1 | Separate templates from demo scenarios | S |
| A2 | Failure explanations with a fix | S |
| A3 | Routine health on tiles and Overview | S |
| A6 | DLQ list with Replay in the UI | S |
| E | Edit and snooze tasks | S |
| B3 | Ask for input when run | S |
| A1 | Resume from the failed step | M |

### Next: make routines connected (≈ 1–2 months)

| # | Feature | Effort |
| --- | --- | --- |
| B1 | Event triggers ("When…") | L |
| A4 | Version history and restore | M |
| A5 | Test a step before saving | M |
| B4 | Wait and Ask-me steps | M |
| D1 + D2 | Delivery channels, actionable notifications | M |
| C2 | Templates with setup questions | S |
| B7 | Text and list steps | S |

### Later: grow reach

| # | Feature | Effort |
| --- | --- | --- |
| B5 | Connections and secrets vault | L |
| B6 | Calendar, chat, RSS, real weather | M each |
| C3 | Describe it in your own words | M |
| C5 | Share and import | M |
| D3 / D4 | PWA, command palette, weekly recap | M / S |
| F | Shared workspaces | L |

**Sequencing:** B5 (secrets) must ship before any integration that needs a key. A1 comes
before B4 because both change how a run resumes. D1 comes before D2.

---

## 6. What not to build

- **A node/flowchart canvas.** Lanes of sentences scale well enough with conditions,
  loops and subroutines. A canvas would undo the "non-technical first" decision.
- **A full task manager.** Subtasks, projects and tags belong to Todoist or Reminders.
  Integrate with them instead.
- **Hundreds of shallow integrations.** Five that are reliable and well-explained beat
  fifty that fail quietly.
- **Cron or JSON as the main interface.** It stays in "Advanced" and "Under the hood".
- **Hiding the infrastructure.** Explain it, don't remove it.

---

## 7. How to know it's working

| Metric | Target direction | Measures |
| --- | --- | --- |
| Time to first successful run | < 3 minutes from sign-up | Onboarding (C1, C2) |
| Active routines per user (weekly) | ↑ | Reach (Theme B) |
| Run success rate | ≥ 98 % excluding user errors | Reliability |
| Failed runs resolved within 24 h | ↑ | Trust features (A1–A3) |
| Share of routines with an event trigger | ↑ after B1 | Whether routines become connected |
| Notifications acted on vs. dismissed | ↑ | Presence (D1, D2) |

Most of these can be computed from the routine service's `executions` table and the
notification service's read state, so no new analytics stack is needed.
