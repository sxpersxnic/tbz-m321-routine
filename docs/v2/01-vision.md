# 01 – Vision

## 1. In one sentence

> **Routine v2 is a personal management platform that keeps itself going:** your life is
> organised in domains (tasks, money, health, people, home), and routines, some steps done
> by the machine and some by you, connect them on the rhythm of your week.

## 2. From v1 to v2

| | v1 (hand-in) | v2 |
| --- | --- | --- |
| **What it is** | Automation platform | Personal management platform, driven by routines |
| **Home screen** | Overview (system health, runs) | **Today**: what's on, what's waiting for you, what needs attention |
| **Data** | Routines, runs, tasks, notifications | **Domains**: Tasks, Budget, Health, People, Home, Calendar, plus Routines, Notifications, Connections |
| **Steps** | Done by services | Done by services **or by you** (do yourself, ask me, check-in) |
| **Triggers** | Manual, schedule, webhook | + **events from any domain**, sun times, holidays, run inputs |
| **Extensibility** | Action types hard-coded in three places | **Manifests**: a domain registers itself, the editor and engine adapt |
| **Trust** | Honest run status | + resume from the failed step, plain-language failures, health, version history, test a step |
| **Reach** | Web inbox | + push, e-mail digest, chat, installable app, command palette |
| **Systems depth** | Topology, queues, DLQ count | + DLQ replay, run waterfall, chaos switch, replica view: still one click away |

## 3. Positioning

| Tool | What it is | What it leaves to you |
| --- | --- | --- |
| Todoist, Things, Reminders | Lists of what to do | Reviews, planning, recurring structure |
| YNAB, budgeting apps | Money only | Connecting money to the rest of life |
| Notion | A place to store everything | Structure and upkeep |
| Shortcuts, Zapier | What the machine does | Everything a person has to do |
| **Routine v2** | **The rhythm of your life, carried out by you and the machine together, across every domain** | Deciding. The rest is prepared for you. |

Routine doesn't try to beat single-domain apps on their own page. It wins on the
**connections between domains**: *"When my salary arrives, set the budgets, remind me to
pay rent, move 10 % to savings"* is impossible in any of the tools above.

## 4. Principles

These principles decide every design question in this plan. Each is short on purpose.

1. **Anything that repeats is a routine.** No second recurrence system for tasks, habits or
   bills.
2. **The machine prepares, you decide.** Routines gather, sort and suggest. People choose.
3. **One place for today.** The home screen answers *"What's on today?"*
4. **A domain earns its place through routines.** Every domain offers triggers, actions and
   values, and ships at *minimum lovable depth* on its own page.
5. **Calm by default.** Signals are rare. Everything else waits quietly in Today.
6. **Every item has a reason.** Anything a routine made shows which routine and run made it.
7. **Reversible by default.** Pause, snooze, undo and restore come before delete.
8. **Sentences, not diagrams.** Steps read as sentences in lanes. No node canvas.
9. **Never move real money, never hide the machine.** Routine records and reminds, it
   doesn't transfer. The distributed system stays visible one click away ("Under the hood").
10. **Say it once.** One name per concept, labels over explanations, terms of art stay terms
    of art.

## 5. The product model

```text
            ┌─────────────────────────── Area (user-named) ───────────────────────────┐
            │  Work · Flat · Family · Health · Side project                           │
            │                                                                         │
 Domains:   │  Tasks     Budget     Health      People     Home     Calendar (read)   │
            │  tasks     money      entries     persons    chores   events            │
            │  lists     bills      check-ins   contacts   shopping                   │
            │                                                                         │
            │        ▲ act on  ▼ emit events           ▲ look up values               │
            │  ┌──────────────────────── Routines ───────────────────────────────┐    │
            │  │ When… (schedule · event · webhook · manual with inputs · sun)  │    │
            │  │ Steps: machine steps  ·  human steps (do yourself, ask, check) │    │
            │  └────────────────────────────────────────────────────────────────┘    │
            └─────────────────────────────────────────────────────────────────────────┘
                 Today = what every domain and routine says is relevant now
                 Notifications = the few things that need attention right away
```

| Object | Owned by | Answers |
| --- | --- | --- |
| **Routine** | routine-service | What happens regularly, and when? |
| **Run** | routine-service | What happened, and what's still waiting? |
| **Task** | task-service | What do I have to do? |
| **Transaction, budget, bill, goal** | budget-service | Where does my money go? Can I afford this? |
| **Metric, entry, check-in** | health-service | How am I doing? |
| **Person, interaction** | people-service | Who haven't I talked to? Whose birthday is it? |
| **Chore, shopping item, supply** | home-service | What does the flat need? |
| **Calendar event** (read-only) | calendar-service | Where do I have to be? |
| **Notification** | notification-service | What needs my attention now? |
| **Area** | identity-service (profile) | Which part of my life is this? |
| **Connection** | connector-service | Which accounts and keys can routines use? |

**Deliberately not objects:** projects, notes and documents, goals/OKRs, events you create
(Routine reads your calendar and doesn't replace it).

## 6. A day with Routine v2

This walkthrough is the product in motion. Every screen named here is specified in
[02-experience.md](02-experience.md).

**07:30 · Morning.** A push notification: *"Morning routine · 5 steps"*. Alex opens Routine.
**Today** shows a checklist card: *Drink water · Stretch · Review today's plan · Take
vitamins · Check-in: How did you sleep?* Alex ticks three items, taps **2** of 5 on the sleep
scale. Because sleep is below 3, the routine's next step snoozes two non-urgent tasks to
tomorrow and says so: *"Take it easy. 2 tasks moved to tomorrow."*

**08:15 · Plan my day.** The *Plan my day* routine gathered everything due today and overdue
across areas. Today shows *"Pick up to 3 to focus on"*: Alex picks *Write weekly review*,
*Pay rent* and *Call Mum*. The rest stays below, quieter.

**12:40 · Lunch.** ⌘K → *"14.50 lunch"* → Routine suggests *Record CHF 14.50 in Budget ·
Eating out* → Enter. Eating out is now at 82 % of its monthly budget. That's over the 80 %
threshold, so the *Budget watch* routine creates a quiet Today card: *"Eating out: CHF 54
left for 12 days."*

**15:00 · A birthday.** People knows Sam's birthday is in 7 days. The *Birthday* routine
created a task *"Buy a present for Sam"* in area Family and recorded a planned expense of
CHF 50 under Gifts.

**17:30 · Shutdown.** The *Shutdown* routine runs. Today shows what's still open. For each
item: *Tomorrow · Later · Drop*. Two taps each. *"Done for today."*

**25th · Payday.** A bank statement import (camt.053) records the salary. The *Payday*
routine starts on `budget.incomeRecorded`: it sets every category's budget from the plan,
adds a human step *"Transfer CHF 500 to savings"* (Routine never moves money), and when
Alex ticks it, records the transfer against the goal *Holiday*.

**Friday · Weekly review.** A guided routine: this week's tasks done per area, money spent,
habits kept (*Reading: 5 of 7 days*), people not contacted in 4 weeks. Alex clears the inbox,
chooses next week's three priorities, and gets the *"Your week"* summary by e-mail.

**Behind the scenes.** When the budget service was redeployed mid-afternoon, the
`budget.recordTransaction` step of a routine showed *"Waiting – Budget is catching up"* for
40 seconds and then continued. No run was lost and nothing happened twice. Under
**Infrastructure**, the run's waterfall shows exactly where the time went.

## 7. What success looks like

| Metric | Target | Tells you |
| --- | --- | --- |
| Days per week Today is opened | ≥ 5 | Routine is the daily home |
| Routines using ≥ 2 domains | ≥ 30 % of active routines | Connections, the actual product, are used |
| Share of tasks created by routines | ↑ | Routines drive the system |
| Human steps finished (not expired) | ≥ 70 % | Human steps are useful, not noise |
| Weekly review completed | ≥ 3 of 4 weeks | The system keeps itself going |
| Run success rate (excluding user errors) | ≥ 98 % | Reliability |
| Failed runs resolved within 24 h | ≥ 80 % | Trust features work |
| Time to first successful run | < 3 min from sign-up | Onboarding |

All are computable from existing service data. No analytics stack is required.
