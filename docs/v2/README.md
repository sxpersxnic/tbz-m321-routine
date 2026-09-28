# Routine v2 – plan

Routine v1 (everything outside `docs/v2/`) is the M321 hand-in: a distributed automation
platform. **Routine v2** turns it into a **personal management platform driven by routines**:
life is split into **domains** (Tasks, Budget, Health, People, Home, …), every domain offers
**triggers, actions and values**, and routines connect them, with steps done by the machine
*and* steps done by you.

This folder is the complete plan: product, experience, architecture, contracts, services,
and a milestone-by-milestone implementation plan precise enough for Claude Code agents to
implement without further design work.

> **Status:** planned, not started. v1 stays untouched until v2 is approved.

---

## Reading order

| # | Document | Read it for | Audience |
| --- | --- | --- | --- |
| 1 | [01-vision.md](01-vision.md) | What v2 is, and a day with it | everyone |
| 2 | [02-experience.md](02-experience.md) | Every screen, with wireframes and copy rules | everyone, web agents |
| 3 | [03-architecture.md](03-architecture.md) | Target service landscape, decisions (ADRs) | engineers, all agents |
| 4 | [04-domain-platform.md](04-domain-platform.md) | The domain manifest contract and registry | all agents |
| 5 | [05-messaging.md](05-messaging.md) | Every exchange, queue and message | all agents |
| 6 | [06-engine.md](06-engine.md) | Routine engine v2: statuses, new step kinds, resume, versions | routine-service agents |
| 7 | [services/](services/) | One spec per service: schema, API, messages, manifest | the agent building that service |
| 8 | [07-web.md](07-web.md) | Web client architecture for v2 | web agents |
| 9 | [08-roadmap.md](08-roadmap.md) | Milestones, dependencies, work packages | everyone |
| 10 | [milestones/](milestones/) | Executable work packages with acceptance criteria | implementing agents |
| 11 | [09-compatibility.md](09-compatibility.md) | How v1 data, routines and messages keep working | all agents |
| 12 | [10-quality.md](10-quality.md) | Testing, definition of done, agent working rules | all agents |
| – | [background/](background/) | The three product-evolution essays v2 is based on | context only |

The background essays are **superseded** wherever they disagree with this plan. This plan
settles the open questions and conflicts between them.

---

## For implementing agents: start here

1. Read [10-quality.md](10-quality.md) §4 (working rules) **first**. It defines branch,
   commit and verification rules that apply to every work package.
2. Read [03-architecture.md](03-architecture.md), [04-domain-platform.md](04-domain-platform.md)
   and [05-messaging.md](05-messaging.md). They are the shared contract every service follows.
3. Open the milestone you were given (`milestones/Mx-*.md`) and work its packages **in
   order**. Each package lists the files to touch, the spec sections it implements and its
   acceptance criteria.
4. The service spec (`services/<name>.md`) is the source of truth for schema, endpoints and
   messages. If a milestone and a service spec disagree, the service spec wins. Report the
   conflict in the commit message.
5. Change contracts first (`contracts/`), then producers, then consumers.

---

## Glossary

| Term | Meaning |
| --- | --- |
| **v1 / v2** | *Product* versions. The HTTP path stays `/api/v1` (all v2 changes are additive, see [09-compatibility.md](09-compatibility.md)). |
| **Domain** | A kind of data with its own service and database: Tasks, Budget, Health, People, Home, Calendar, Notifications, Connections, Routines. |
| **Manifest** | A domain's published description of its triggers, actions, values, collections and Today cards ([04](04-domain-platform.md)). |
| **Capability** | One entry of a manifest: a *trigger* ("When…"), an *action* ("Do…") or a *value* ("Get…"). |
| **Capability type** | Its id, `<prefix>.<name>`, e.g. `task.create`, `budget.recordTransaction`. Doubles as routing key. |
| **Human step** | A step a person does ("do yourself", "ask me", check-in). The run waits for them (`WAITING_FOR_YOU`). |
| **Area** | A user-named part of life (Work, Flat, Family). Items from any domain can belong to one. |
| **Today card** | A generic item a domain contributes to the Today screen ([services/today-service.md](services/today-service.md)). |
| **Connection** | A stored credential or account (API key, ICS URL, chat webhook), owned by the connector service. |
| **Origin** | Metadata on events caused by a routine, used for loop protection. |
