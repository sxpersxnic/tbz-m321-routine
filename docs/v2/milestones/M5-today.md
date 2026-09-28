# M5 – Today & the daily loop

**Goal:** Routine becomes a personal management platform. **Today** is the home screen,
fed by a CQRS projection. Profiles, areas and domain toggles exist. Tasks become a
complete everyday tool (edit, snooze, Inbox, capture, repeat, archive). Planning and review
routines ship as templates with setup questions, and habits appear.

**You'll see:** everything in [01-vision.md §6](../01-vision.md) up to lunch, minus Budget.
The sidebar and tab bar of [02 §1](../02-experience.md). Today with *Now / Today / Later today /
Needs attention*. Capture and the Inbox. Onboarding. Areas. *Plan my day* and *Shutdown* as
real routines.

**Specs:** [services/today-service.md](../services/today-service.md) · [services/identity-service.md](../services/identity-service.md) ·
[services/task-service.md](../services/task-service.md) · [services/routine-service.md §3, §5](../services/routine-service.md) ·
[02-experience.md §1–3, §5, §9, §12, §14, §15](../02-experience.md) · [07-web.md §6, §7](../07-web.md)

---

### Backend

- [ ] **M5-01 · Profile, areas, domain toggles (identity-service)**
  - Migration (M5 part), endpoints, events `profile.*` / `area.*` through the identity outbox
    (kit), `GET /auth/me` extended. Contract schemas for the events.

- [ ] **M5-02 · Profile projection in routine-service**
  - Queue `routine-service.profile-events`, `owner_settings`. Engine `context.timezone/currency`
    from it. `{{today}}` template root. Validation rejects steps of disabled domains
    ([06 §2.1](../06-engine.md)). `area.archived` clears `routines.area_id`. Catalog marks
    `enabled`. `flow.wait` uses the owner's time zone.

- [ ] **M5-03 · today-service scaffold**
  - The [10-quality.md §5](../10-quality.md) checklist (default compose profile), gateway route
    `/api/v1/today` with the stream exemption ([services/gateway.md](../services/gateway.md)).

- [ ] **M5-04 · today-service projection and API**
  - Tables, version/tombstone rules, `GET /today`, `GET /today/area/:id`, `POST /today/resync`,
    `profile.updated` consumer, cleanup jobs.
  - Tests: [services/today-service.md §10](../services/today-service.md).

- [ ] **M5-05 · today-service live stream**
  - `stream_tickets`, `POST /today/stream-ticket`, SSE endpoint, `LISTEN/NOTIFY` fan-out across
    replicas, 30 s heartbeat.

- [ ] **M5-06 · Tasks: everyday features**
  - task-service M5 migration, extended `PATCH`, snooze, delete, bulk, Inbox list (created on
    first use like the default list), capture endpoint + parser + shared fixture file,
    auto-archive job (reads `owner_settings` projection from `profile.updated`), area events
    consumer.

- [ ] **M5-07 · Tasks: Today cards, planning capabilities, suggestions**
  - Card publication for `task:*`, `steps:*` (replaces M3's interim section), `focus:*`,
    `review:*`, `suggest:*`. Day-change job. Resync handler. `task.pickFocus`,
    `task.reviewOpen` + their endpoints. Suggestions job. Manifest bump.

- [ ] **M5-08 · Routine and notification cards**
  - routine-service: `later:*` and `unhealthy:*` cards + resync ([06 §11](../06-engine.md)).
    notification-service: `question:*` cards + resync.

- [ ] **M5-09 · Templates with setup questions**
  - `GET /api/v1/templates`, `POST /api/v1/templates/:id/instantiate` (replace `{{setup.x}}`
    once, validate, create active). Template catalog in routine-service
    ([services/routine-service.md §5](../services/routine-service.md)): all tasks-only templates
    now (*Morning routine, Plan my day, Shutdown, Weekly review, Monthly reset*, v1 templates).
    Domain templates arrive with their domains.
  - Tests: each template instantiates and validates with default answers.

- [ ] **M5-10 · Habits**
  - `routines.habit`, `GET /routines/:id/habit`, `routine.habitStreak` value.
    A day is *kept* when that day's scheduled run completed with every human step done, and
    *missed* when a human step was skipped or expired.

### Web

- [ ] **M5-11 · Navigation v2**
  - Sidebar with *LIFE* (enabled domains from catalog + profile order), *AREAS*, *ACTIVITY*,
    *UNDER THE HOOD*. Phone tab bar with centre **+** and *Life* hub. v1 Overview moves to
    `#/overview`.

- [ ] **M5-12 · Today page**
  - `today/` module: card renderers per kind, `useLiveToday`, optimistic actions, empty state,
    *Focus / All* filter, live region. axe clean.

- [ ] **M5-13 · Capture and Inbox**
  - Capture sheet (`+`, `C`), pills preview from shared fixtures, `#/inbox` with row actions
    and bulk.

- [ ] **M5-14 · Tasks page v2**
  - Edit sheet, snooze menu, area chip + filter, *Archived* smart list, *Repeat* in the New task
    dialog (creates a routine with `origin: 'repeat'` via `POST /routines`), ↻ badge, *Repeats*
    group on the Routines page.

- [ ] **M5-15 · Settings: profile, areas, domains**
  - `#/settings/profile`, `/areas` (incl. *Turn your task lists into areas* offer), `/domains`
    (toggle, reorder, warning listing routines that use a domain being turned off).

- [ ] **M5-16 · Area page**
  - `#/areas/:id`: cards from `GET /today/area/:id`, routines with that area, links to domain
    pages filtered by area. Routine settings gain *Area*.

- [ ] **M5-17 · Onboarding and what's new**
  - `#/onboarding` ([02 §15](../02-experience.md)): domain choice → templates with setup questions →
    Today. Existing users: a one-time *What's new* card (local, dismissible, stored in the
    profile as `onboarded_at`).

- [ ] **M5-18 · Habits UI**
  - *Habit* switch in routine settings (schedule routines only), calendar strip on the routine
    detail page, *Habits* group on the Routines page.

- [ ] **M5-19 · Command palette**
  - ⌘K with *Run routine*, *Go to*, *New …*, search over routines and tasks, and quick-entry
    matchers from manifests (none exist yet: Budget brings the first in M6).

**Milestone done when:** a new user signs up, chooses Tasks, instantiates *Morning routine*,
*Plan my day* and *Shutdown*, and over a simulated day (use `faketime`-style schedule offsets
or run the routines by hand) sees checklist, focus picker and review cards on Today, which
update live in two browser windows at once. An existing v1 user logs in and everything still
works, with the *What's new* card.
