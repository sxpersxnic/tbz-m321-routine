# 07 – Web client v2

The client stays what v1 made it: React 19 + Vite + TypeScript, served by nginx behind the
gateway, hash routing, no UI framework, `usePolling` for data, types in `web/src/types.ts`
(the client shares no code with services). v2's big change is that **the client learns
domains from the catalog** instead of hard-coding them.

Screens and copy: [02-experience.md](02-experience.md). Quality gate: `npm run build` in
`web/` plus axe-core ([10-quality.md §2](10-quality.md)).

---

## 1. Routes

| Route | Page | Milestone |
| --- | --- | --- |
| `#/` | **Today** (replaces Overview) | M5 |
| `#/overview` | v1 Overview (moved, linked from Infrastructure) | M5 |
| `#/inbox` | Inbox (captured tasks) | M5 |
| `#/routines`, `/new`, `/:id`, `/:id/settings` | v1 + additions | M1–M4 |
| `#/routines/:id/history` | version history | M1 |
| `#/executions`, `/:id` | v1 + resume, human steps, waterfall | M1, M3, M12 |
| `#/tasks` | v1 + edit, snooze, repeat, archive | M5 |
| `#/notifications` | v1 + questions (`?answer=<value>&id=<id>` deep link from push) | M3, M8 |
| `#/budget`, `/transactions`, `/import`, `/plan`, `/accounts`, `/bills`, `/goals` | Budget | M6 |
| `#/health`, `#/people`, `#/people/:id`, `#/home` | domains | M7 |
| `#/areas/:id` | area | M5 |
| `#/week` | Your week | M8 |
| `#/settings/profile`, `/areas`, `/domains`, `/connections`, `/delivery`, `/ai` | settings | M5, M8–M10 |
| `#/onboarding` | first-run flow | M5 |
| `#/shared/:token` | shared routine preview + import | M10 |
| `#/system` | Infrastructure (+ DLQ, registry, chaos, demo scenarios) | M1, M2, M12 |

Domain pages are **lazy-loaded** (`React.lazy`), so users who don't enable Budget never
download it.

## 2. Module structure (new folders)

```text
web/src/
  catalog/        catalog store: fetch /api/v1/catalog with ETag, localStorage cache, useCatalog(), lookup helpers
  forms/          manifest-driven step forms: fieldFor(param), StepForm, SentenceView, param validation
  today/          Today page, card renderers per kind, useLiveToday (SSE + polling fallback)
  capture/        CaptureSheet, CommandPalette, quick-entry matcher
  domains/        budget/, health/, people/, home/ – one folder per domain page (lazy)
  settings/       settings pages
  pwa/            service worker registration, push subscription
  lib/            money.ts (Intl formatting), dates.ts (owner time zone), diff.ts (plain-language version diff)
```

v1 files stay where they are. `action-forms.ts` shrinks to **overrides** (§5.3).

## 3. Types (`web/src/types.ts` additions)

Mirror of the API DTOs: `CatalogDomain`, `Capability`, `ParamSpec`, `OutputField`,
`TriggerSpec`, `CollectionSpec`, `QuickEntrySpec`, `RoutineTemplate`, `TodayCard`,
`CardAction`, `Profile`, `Area`, `ExecutionStatus` (+ `WAITING_FOR_YOU`, `DELAYED`),
`ActionStatus` (+ `AWAITING_USER`, `SCHEDULED`), `ErrorCode`, and one DTO file per domain in
`domains/<name>/types.ts`.

Copy them by hand from the manifest types in [04-domain-platform.md §2](04-domain-platform.md).
The client must not import from `libs/`.

## 4. Catalog

```ts
const { domains, capability, trigger, collection, enabled } = useCatalog();
capability('budget.recordTransaction') // → Capability & { domain }
```

- Loaded once after login, revalidated on focus (`If-None-Match`), cached in `localStorage`
  (try/catch, as v1 does for the session).
- `enabled` comes from the profile (`/api/v1/auth/me`). Everything (sidebar, step picker,
  templates, Today, command palette) filters by it.
- Unknown capability types (a domain removed or not yet loaded) render with the v1 fallback:
  neutral look, raw JSON editor.

## 5. Manifest-driven editor

### 5.1 Field mapping

| ParamType | Component | Notes |
| --- | --- | --- |
| `text` | input | pill insertion for `{{…}}` as v1 |
| `longText` | textarea | |
| `number`, `integer` | input `inputmode=decimal/numeric` | `min` from the manifest; a number input as in v1, so no `{{…}}` pills (M2) |
| `money` | MoneyInput (currency symbol from profile) | stores a number in major units; a plain number input until the profile exists (M5) |
| `boolean` | switch | |
| `date` | segmented *Today · Tomorrow · In days · Date* → `+Nd` or `YYYY-MM-DD` | tapping the chosen segment clears an optional date; a `{{…}}` value stays editable as text |
| `time` | time input | |
| `duration` | amount + unit select → ISO 8601 | a text input until a manifest uses it |
| `choice` | segmented control (≤ 4 options) or select | labels from `options` |
| `ref` | RefPicker: select filled from the collection's `list` endpoint, *+ New* when the domain supports it | stores the id, shows the label. M2: `tasks/lists` and `routines` use v1's pickers; the generic RefPicker comes with the first collection without one (M5) |
| `list`, `object`, `value` | v1 `value` / `json` / `keyvalue` editors | |

`advanced: true` params go under *More options*. Required params show the v1 inline error
style.

### 5.2 Sentences

`SentenceView` renders `capability.sentence` by replacing `{param}` with a token showing the
param's display value (ref label, formatted money, relative date). This replaces the per-type
`actionSentence` switch in `action-forms.ts` for every catalog capability.

An empty required param shows its label; an empty optional one is left out with the words
leading to it (back to a comma, else one word): `Create task {title}, due {dueDate}` reads
*Create task [Pay rent]* without a date. Until the RefPicker loads collections, a ref token
names what was picked (*list*), not its label.

The ten v1 step types keep their hand-tuned sentences as overrides (they say more than the
manifest sentence, e.g. *· important*); `web/src/forms/v1-sentences.fixture.json` guards that they
read as before.

### 5.3 Overrides

`action-forms.ts` keeps entries only where a hand-made form is better than the generated one
(`condition.if`, `routine.run`, `summary.generate` sections editor, `http.request` headers).
Resolution order: override → generated from manifest → fallback.

### 5.4 Step picker

Groups: *Suggested* (capabilities whose params can be filled from the previous step's outputs,
max 3), *You* (all `kind: 'human'`), one group per enabled domain in profile order,
*Scripting*. Search matches label, description and domain name.

A step is *suggested* when the previous step outputs a field named like one of its required
params (`task.create` → `taskId` → *Move task*, *Complete task*); own domain first, then by how
many params fit. Domain order is the manifests' `order` until the profile has one (M5). While
searching there are no suggestions; Enter adds the first match.

### 5.5 Test a step

*Try this step* on values, scripting steps and actions with `preview`:
`POST /api/v1/routines/test-step`, then poll the test execution (≤ 10 s, 500 ms interval),
then show the output inline. The same call fills the **example values** of token pills
(cached per routine in memory).

### 5.6 Event trigger editor

Domain select → trigger select (from `domain.triggers`) → filter rows *field · operator ·
value* (fields from `trigger.fields`, operators from the v1 condition list). Pills for
`{{trigger.event.<field>}}` become available in steps.

A `ref` field named after a collection of its domain (`listId` → task lists, `routineId` →
routines) gets that picker instead of an id field. The trigger sentence (`lib/event-trigger.ts`)
fills `{filter}` with the conditions in words (*"in Work"*, *"with title containing "rent""*),
any other `{field}` from an *is* condition on it or its `…Id` (*"When "Backup" fails"*, else
*"any routine"*), and appends the conditions when the sentence has no `{filter}`. *Why did this
run?* shows the event's fields, trigger-service's decision for it and its last decisions for the
routine (`GET /api/v1/triggers/log`).

## 6. Today

- `useLiveToday()`: `GET /api/v1/today`, then `POST /api/v1/today/stream-ticket` → a one-time
  ticket (60 s), then `EventSource('/api/v1/today/stream?ticket=…')`. `EventSource` can't set
  headers, and the bearer token must never appear in a URL (URLs end up in logs), so the
  ticket stands in for it. Reconnect with backoff and a fresh ticket. If SSE fails three
  times → poll every 10 s.
- **Card renderers** by `kind`: `ItemCard`, `ChecklistCard`, `MetricCard`, `EventCard`,
  `QuestionCard`, `CheckInCard`, `AttentionCard`, `SuggestionCard`. They know nothing about
  domains, only the card fields ([services/today-service.md §3](services/today-service.md)).
- **Actions:** `CardAction.request` is executed with the normal `api` client (same origin,
  bearer token). Optimistic: the card updates immediately (checklist item ticked, card
  removed on complete). If the request fails, it rolls back with a toast. A server `changed`
  with a version older than the optimistic state is ignored for that card until it catches up.

## 7. Capture and command palette

- Capture sheet → `POST /api/v1/capture`. Quick-syntax pills are previewed client-side with the
  same test vectors as the server (`contracts/fixtures/capture-syntax.json`).
- Command palette: quick-entry matchers built from every enabled manifest's `quickEntry`
  (compile `pattern` once. Invalid patterns are skipped and logged to the console). Choosing
  an entry sends `POST <endpoint> { text }` to the endpoint the manifest names. The domain
  parses the text again and does the work. Plus *Run routine*, *Go to*, *New task / routine /
  transaction*.
- Keyboard: ⌘K / Ctrl-K opens it, `C` opens capture (not inside inputs), `Esc` closes.

## 8. Plain-language version diff (`lib/diff.ts`)

Input: two routine definitions. Output: a list of sentences, in order:

1. Name, description, trigger changes (*"Schedule changed from Mondays 08:00 to weekdays 07:30"*).
2. Steps matched by `key`: added (*"Added step: Notify …"*), removed, moved (*"Moved Notify
   after Create task"*), params changed (*"Changed city from Bern to Zurich"*, using param
   labels and display values).
3. Settings (inputs, habit, area, alert threshold).

Pure function, unit-tested with fixtures (`web/src/lib/diff.test.ts` runs with
`node --test`).

## 9. PWA and push

- `public/manifest.webmanifest` (name, icons, `display: standalone`, `start_url: '/#/'`).
- `public/sw.js`, hand-written, no plugin: caches the app shell (`index.html`, built assets
  by manifest from Vite's `build.manifest`) for offline start. API calls are never cached.
- Push: `pushManager.subscribe` with the VAPID key from delivery-service, then register the
  subscription. The `push` event shows the notification. On `notificationclick`, open
  `data.url`. Question actions open `#/notifications?id=<id>&answer=<value>`, and the page
  answers it after the user is signed in (the service worker never holds the auth token).

## 10. Demo scenarios

v1's demo templates move from `templates.ts` to `demo-scenarios.ts` and render on the
Infrastructure page under *Demo scenarios*, each with *Create & run* and a line saying what it
demonstrates (*"Retries with backoff"*, *"Horizontal scaling"*, *"Permanent failure, no
retry"*, *"Scheduler"*).

## 11. Accessibility and testing

- Every page passes axe-core with zero violations (script in [10-quality.md §2](10-quality.md)).
- Card renderers: checklist = `role="group"` + checkboxes. Check-in scale = `radiogroup`.
  Question buttons are real buttons. The Today SSE updates announce in a polite live region
  only when caused by someone else (not the user's own action).
- Browser verification through the Vite dev server (`npm run dev`). The Docker `web`
  container serves the last built image, not your working copy.
