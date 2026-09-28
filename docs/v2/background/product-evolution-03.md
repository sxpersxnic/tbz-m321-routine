# Routine – one platform, many domains of life

The third product-evolution document.

1. [product-evolution-01.md](product-evolution-01.md): Routine as an **automation app**.
2. [product-evolution-02.md](product-evolution-02.md): Routine as a **personal management
   platform** driven by routines, with tasks as the core object.
3. **This document:** tasks are **one domain among many**. Finance, health, people, home and
   others join them. Every domain brings its own **triggers and actions**, and routines
   connect them all.

> The more of a person's life Routine covers, the more useful it gets, **as long as every
> domain can be used by routines.** The routines connecting the domains are the product.

This document replaces section 3 (product model) and parts of section 9 (what not to
build) of document 02. The rest of 02 (Today, steps you do yourself, planning routines)
still applies, now across every domain.

---

## 1. The idea

Separate apps for tasks, budget, habits and birthdays each know one slice of your life.
None of them can say *"when my salary arrives, set this month's budgets, remind me to pay
rent and move 10 % to savings"*, because that sentence spans three apps.

Routine can, because:

- every **domain** (Tasks, Budget, Health, People, …) owns its data and exposes a **small,
  fixed vocabulary**: things that can *happen* (triggers), things that can be *done*
  (actions) and things that can be *looked up* (values);
- **routines** combine that vocabulary across domains, in the same sentence-style editor.

```text
      Tasks          Budget          Health          People        …
   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
   │ When…   │    │ When…   │    │ When…   │    │ When…   │   triggers
   │ Do…     │    │ Do…     │    │ Do…     │    │ Do…     │   actions
   │ Get…    │    │ Get…    │    │ Get…    │    │ Get…    │   values
   └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘
        └──────────────┴──── Routines ┴──────────────┘
                        (connect the domains)
```

### Where the value comes from

The number of domains alone doesn't make the product. On its own page, any single domain
will be weaker than a dedicated app: Budget than YNAB, Tasks than Things. The value is in
**the connections between domains**, which no single-domain app can offer. So the rule for
growth is:

> **A domain earns its place through what it adds to routines, not through its own page.**

With *n* domains, the possible cross-domain routines grow much faster than *n*. That is the
network effect of this model, and it only works if every domain follows the same contract
(section 3).

---

## 2. Domain vocabulary

Each domain speaks in three kinds of sentence, matching the editor that exists today:

| Kind | Editor wording | Example | Behaviour |
| --- | --- | --- | --- |
| **Trigger** | *When…* | *When a transaction over CHF 200 is recorded* | Starts a routine. Published by the domain as an event. |
| **Action** | *Do…* | *Record a transaction*, *Create a task* | Changes the domain's data. Idempotent, keyed by the action id. |
| **Value** | *Get…* | *Get what's left in "Groceries" this month* | Reads only, never changes anything. Safe to run in a test run or a preview. |

Keeping **Get** separate from **Do** matters for the product, not just the code. Get steps
can always be tried in the editor with real data ("Test a step" from the first document,
A5), while Do steps show a preview instead.

---

## 3. The domain contract

Every domain, existing or future, is described by a **manifest**: one document that tells
the platform everything it needs to offer the domain in routines, in Today and in the
editor.

```yaml
domain: budget
version: 1
name: Budget
icon: wallet
tint: green

triggers:
  - type: budget.transaction.recorded
    sentence: "When a transaction {{filter}} is recorded"
    filter: { amountAbove: number, category: category, account: account }
    provides: [transaction]
  - type: budget.category.threshold
    sentence: "When {{category}} reaches {{percent}} % of its budget"

actions:
  - type: budget.transaction.record
    sentence: "Record {{amount}} for {{category}}"
    params: { amount: number*, category: category*, note: text }
    returns: [transaction]

values:
  - type: budget.category.remaining
    sentence: "Get what's left in {{category}}"
    returns: { amount: number, percentUsed: number }

today:
  widget: budget.summary        # what the domain contributes to Today
```

From one manifest the platform gets:

- **Routine validation**: parameter names, required fields and types. This replaces the
  hard-coded `ACTION_TYPES` in `routine-service/src/domain/action-catalog.ts`.
- **Editor forms**: the sentence, the pickers (a `category` param shows a category
  picker), icon and tint. This replaces the per-type entries in `web/src/action-forms.ts`.
- **Broker routing**: `action.budget.#` → budget service. This follows the existing
  convention (`action.task.#` → task service), so the engine doesn't change.
- **Pills in the editor**: `returns` tells the editor which `{{actions.x.…}}` values a step
  offers, so the token pills work for every domain automatically.

### Adding a domain changes no existing service

Today, adding an action type means editing the routine service, the web client and the
broker definitions. With manifests, a new domain service **registers itself** on start (a
`domain.registered` event carrying its manifest), and everything else follows. That is the
real test of the architecture: *a new part of the system can join without the rest being
redeployed.*

### Contracts that evolve without downtime

Routines saved today must keep working when a domain changes. Manifests are **versioned**:

- Adding optional params or return values is allowed within a version.
- Renaming or removing something means a new action type or version (`…record.v2`). The
  old one stays served and is shown as *"Update available"* in the editor.
- A routine stores the contract version it was built against.

This is the README's goal *"evolving interfaces without downtime"*, turned into a product
feature.

---

## 4. Domain catalogue

The candidates, each with the vocabulary it would bring. Domains marked **exists** are
already implemented as services, just not yet described by a manifest.

### Tasks (exists)

| When… | Do… | Get… |
| --- | --- | --- |
| a task is created / completed / overdue | create, complete, move, snooze a task | open tasks in a list, tasks due today |
| a list becomes empty | "do yourself" step (document 02) | count of overdue tasks |

### Budget (new, the reference domain)

**Objects:** accounts, transactions, categories, monthly budgets, recurring bills and
subscriptions, savings goals.

| When… | Do… | Get… |
| --- | --- | --- |
| a transaction is recorded (filter: amount, category, merchant) | record a transaction | remaining budget in a category |
| income arrives | set or move a category's budget | spent this month / week |
| a category reaches X % | mark a bill as paid | upcoming bills (next N days) |
| a bill is due in N days | add to a savings goal | balance of an account |
| a new month starts | categorise a transaction | progress towards a savings goal |

**Getting data in** decides whether the domain lives or dies:

1. **Quick entry** from Today and ⌘K: *"12.50 lunch"*.
2. **Import a bank statement:** CSV and **camt.053** (the ISO 20022 statement Swiss banks
   export), with rules that categorise automatically. Those rules are routines:
   *"When a transaction from 'Migros' is recorded → category Groceries"*.
3. **Bank connection** (bLink in Switzerland, PSD2 in the EU): later, and only with care.

**Firm boundary:** Routine **never moves real money.** Budget actions change Routine's own
records. Paying or transferring is a "do yourself" step: *"Transfer CHF 500 to savings"*
appears as a task, and ticking it off records the transfer.

### Health & habits

Grows out of document 02's check-ins, habits and entries.

| When… | Do… | Get… |
| --- | --- | --- |
| a check-in is logged (filter: value) | log a value (sleep, mood, weight, water) | average of a value over N days |
| a streak reaches N / is at risk | start a check-in ("How did you sleep?") | current streak |

### People

| When… | Do… | Get… |
| --- | --- | --- |
| a birthday is in N days | log contact ("Called Mum") | people not contacted in N weeks |
| someone hasn't been contacted in N weeks | add a note to a person | birthdays this month |

### Home

| When… | Do… | Get… |
| --- | --- | --- |
| an item on the shopping list is added | add to the shopping list | shopping list |
| a supply runs low | log a chore as done | chores due |
| a chore is overdue | | |

### Calendar (read-only, from document 02)

| When… | Do… | Get… |
| --- | --- | --- |
| an event starts in N minutes (filter: title, calendar) | (none: read-only) | today's events, free time today |

### Connections (exists, as the integration worker)

Weather, HTTP, e-mail and later chat. These are the domains *outside* the user's own data.
They follow the same manifest, so the integration worker is just another domain.

### Signals (exists, as the notification service)

| When… | Do… | Get… |
| --- | --- | --- |
| a notification is answered ("Ask me") | send a notification, ask me | unread count |

---

## 5. What cross-domain routines look like

These are the proof of the model. Each one is impossible in any single-domain app.

**Payday**
> *When* income over CHF 3,000 is recorded → *set* every category's budget from the plan →
> *you:* transfer 10 % to savings → *add* that amount to the savings goal "Holiday" →
> *notify* "Budgets are set for October."

**Month-end check**
> *Every last day of the month* → *get* spent per category → *if* "Eating out" is over
> budget → *create task* "Plan meals for next week" in Home → *send* summary by e-mail

**Birthday**
> *When* a birthday is in 7 days → *create task* "Buy a present for {{person.name}}" →
> *record* a planned expense of CHF 50 under Gifts

**Low-energy day**
> *When* the sleep check-in is below 3 → *snooze* all non-urgent tasks to tomorrow →
> *notify* "Take it easy today. 4 tasks moved to tomorrow."

**Subscription watch**
> *When* a subscription renews in 14 days → *get* how often it was used (manual check-in) →
> *ask me* "Keep Netflix?" → *if* no → *create task* "Cancel Netflix before the 12th"

**Weekly review (document 02, now across every domain)**
> *Friday 16:00* → *get* tasks done, money spent, habits kept, people not contacted →
> *you:* review each domain → *send* "Your week" summary

---

## 6. How domains and areas relate

Document 02 introduced **Areas** (Work, Health, Home). Areas and domains are easy to mix
up, and they are different things:

| | Domain | Area |
| --- | --- | --- |
| **What** | A *kind* of data with its own behaviour | A *part of your life*, named by you |
| **Examples** | Tasks, Budget, Health, People | Work, Family, Flat, Side project |
| **Defined by** | The platform (a service + manifest) | The user |
| **Cuts across** | Areas | Domains |

An area gathers items **from every domain**: area *Flat* holds the task "Fix the tap", the
budget category "Rent", the chore "Clean the bathroom" and the routine "Monthly bills".

User-facing wording: the word *domain* never appears in the UI. Each domain just appears
by its name (**Tasks**, **Budget**, **Health**) in the sidebar and in the step picker.

---

## 7. Keeping many domains simple

More domains bring a risk the first two documents didn't have: **a crowded app**.

1. **Turn domains on as needed.** Onboarding asks *"What would you like Routine to help
   with?"*: Tasks, Money, Health, People, Home. Only the chosen ones appear in the sidebar,
   the step picker and Today. Everything else is one tap away under **Add a domain**.
2. **Today stays one list.** Each domain contributes a small widget (*"CHF 312 left for
   groceries"*, *"2 birthdays this week"*) only when it has something to say.
3. **The step picker groups by domain**, like Shortcuts groups by app, with search across
   all of them. Suggestions come first: *"Often used after 'Record a transaction'"*.
4. **Templates show their domains** (*Tasks + Budget*), and the gallery only shows
   templates whose domains are turned on, or offers to turn them on.
5. **Minimum lovable depth.** A domain ships only when it is good enough to use on its own
   page for its core job, and never as a stub that only exists for routines.

### When is something a domain?

A candidate becomes a domain when it meets all five of these:

1. **It has a rhythm.** Things recur or can be expected (bills, birthdays, check-ins).
2. **Data can get in cheaply.** Quick entry, import, or events. Without that, it stays empty.
3. **At least two triggers and two actions** that are useful *with another domain*.
4. **It owns its data.** It can be its own service with its own store, and doesn't borrow
   another domain's tables.
5. **Someone would miss it.** It answers a question people actually ask, like *"Can I
   afford this?"* or *"When did I last call Dad?"*.

Notes, documents and full calendars still fail rule 3 or 4 (see document 02, section 9)
and stay out, though notes may come back as a small attribute of other objects.

---

## 8. Architecture: each domain is a service

This model maps directly onto the M321 principles. It is essentially the microservice
idea, made visible to users.

```text
                             ┌─────────────────────┐
                             │   Routine service   │  orchestrates, knows no domain
                             │  (engine + registry)│  logic, only manifests
                             └─────────┬───────────┘
                     action.<domain>.* │ ▲ action.completed / failed
                                       ▼ │
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
 │  Tasks   │  │  Budget  │  │  Health  │  │  People  │  │ Connections  │
 │ service  │  │ service  │  │ service  │  │ service  │  │ (integration │
 │  + DB    │  │  + DB    │  │  + DB    │  │  + DB    │  │   worker)    │
 └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘
      └──── <domain>.<object>.<event> ──────────┴──► trigger-service ──► routine.triggered
                                                └──► today-service (projection)
```

| Concern | How it is handled |
| --- | --- |
| **Service autonomy** | Each domain owns its database. Budget data never sits in the task DB. |
| **Registration** | On start, a domain publishes `domain.registered` with its manifest. The routine service stores it, and the web client loads the manifests to build its forms. |
| **Commands** | `action.<domain>.<verb>` on the existing `routine.actions` exchange. Each domain binds `action.<domain>.#`. |
| **Triggers** | Domains publish `<domain>.<object>.<event>` (e.g. `budget.transaction.recorded`). The trigger-service (first document, B1) matches them against routine subscriptions and their filters. |
| **Values (Get)** | Handled like actions, through the broker, with `sideEffects: false` in the manifest. That lets the engine run them in test runs and previews. |
| **Idempotency** | Unchanged: every action carries its action id. A `budget.transaction.record` delivered twice records once. |
| **Failure isolation** | If the budget service is down, only budget steps wait (`WAITING`). Task and health steps continue, which is the README's failure scenario, now per domain. |
| **Privacy** | Sensitive domains (Budget, Health) get their own service boundary, encryption at rest and never log values. Separate services make this enforceable. |

### What changes in the current code

| Today | Becomes |
| --- | --- |
| `ACTION_TYPES` hard-coded in the routine service | A **registry** filled from manifests, and the validator reads param schemas from it |
| Per-type forms in `web/src/action-forms.ts` | **Schema-driven forms** from manifests. Hand-written forms stay possible where a custom picker is worth it |
| Broker bindings listed in `infra/rabbitmq/definitions.json` | Each domain service **declares its own bindings** on start |
| Task, notification and integration services | Get manifests first. They become domains 1–3 without any change in behaviour |

---

## 9. Roadmap

### Step 1: make the existing services into domains (≈ 3–4 weeks)

| Work | Effort | Result |
| --- | --- | --- |
| Manifest format + registry in the routine service | M | The contract exists |
| Manifests for Tasks, Signals, Connections | S | Existing behaviour, now described |
| Schema-driven step forms in the editor | M | New domains need no web change |
| Domain events: `task.*` first (document 02) | S | Tasks can trigger routines |
| Services declare their own broker bindings | S | Adding a domain needs no infra change |

This step adds **no user-visible domain**, but it is the one that makes all the others
cheap. It is also the strongest M321 story of all three documents: a contract-driven,
self-registering service landscape.

### Step 2: Budget, the reference domain (≈ 4–6 weeks)

| Work | Effort |
| --- | --- |
| Budget service: accounts, transactions, categories, monthly budgets | L |
| Quick entry + CSV / camt.053 import | M |
| Triggers, actions and values from section 4 | M |
| Today widget + Budget page at minimum lovable depth | M |
| Templates: Payday, Month-end check, Subscription watch | S |

Budget comes first because its data is **structured and recurring**, it has natural
**thresholds** that make good triggers, and it pairs well with Tasks (bills → tasks).

### Step 3: the lighter domains (each ≈ 2–3 weeks)

**Health & habits** (grows out of document 02's check-ins) → **People** → **Home**, in the
order users ask for them. Each one is a new service with a manifest, and **no change to
the routine service.** If it needs one, the contract is wrong and must be fixed first.

### Step 4: domain onboarding and discovery

Choosing domains on sign-up, "Add a domain", a step picker grouped by domain, and
cross-domain templates in the gallery.

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| **Breadth without depth:** many half-finished domains | "Minimum lovable depth" and the five rules in section 7. Ship one domain well before starting the next. |
| **Empty domains:** nobody enters budget data by hand for long | Every domain needs a cheap way to get data in *before* it ships. Import, quick entry and events are part of the domain, not extras. |
| **A crowded app** | Domains are opt-in. Today shows only what has something to say. |
| **Sensitive data** | Separate services, encryption at rest, no values in logs. Routine never moves real money. |
| **Contract drift** | Versioned manifests. A domain that needs a routine-service change is a contract bug. |
| **Team capacity** (3–4 people, M321 timeline) | Step 1 alone is a complete, gradeable result. Budget is a stretch goal, and the rest is vision. |

---

## 11. How to know it's working

| Metric | Target direction | Tells you |
| --- | --- | --- |
| Routines that use **two or more domains** | ↑ | Whether connections, the actual product, are being used |
| Domains turned on per active user | 2–4 | Breadth that people actually use, not everything at once |
| Domains used on their own page weekly | ↑ per domain | Minimum lovable depth is met |
| Time to add a new domain (engineering) | ↓, with no routine-service change | The contract holds |
| Data freshness per domain (days since last entry) | ↓ | Getting data in is cheap enough |
