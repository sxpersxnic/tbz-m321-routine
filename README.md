# Routine

## 1. Summary

**Routine** is a platform for creating and automatically running recurring workflows.

Users define so-called **routines** made up of several independent actions. A routine can, for example, carry out several tasks automatically every Monday morning:

> Fetch information → create a task → send a notification → call an external service

When a routine runs, its individual steps are not executed directly and synchronously one after another. Instead, the work is handed to a message broker as messages and processed by specialised services.

This lets individual services be operated, scaled, updated or temporarily shut down independently of each other.

---

## 2. Project goal

The project is a practical implementation of a distributed system following microservice principles.

The focus is not on an extensive user interface, but on:

* clearly separated services
* autonomous data stores
* formally defined interfaces
* synchronous and asynchronous communication
* decoupling through a message broker
* idempotency and repeatability
* fault tolerance
* horizontal scaling
* distributed tracing and observability
* evolving interfaces without downtime

The application should still offer a comprehensible, practical benefit.

---

## 3. Core idea

A **routine** describes a workflow that recurs or can be triggered manually.

Example:

### Routine: "Weekly Review"

The routine consists of the following actions:

1. Fetch current information from an external service
2. Create a task in the task system
3. Generate a summary
4. Send a notification

The user does not need to know which service carries out which action.

From the user's point of view, all that is visible is:

```text
Weekly Review
     │
     ▼
  started
     │
     ▼
  running
     │
     ▼
 completed
```

Internally, however, a distributed processing system is at work.

---

## 4. Example flow

A user starts a routine.

```text
User
 │
 │ Start routine
 ▼
Routine Service
 │
 │ RoutineTriggered
 ▼
Message Broker
 │
 ├───────────────┐
 ▼               ▼
Task Service   Integration Service
 │               │
 │               │
 ▼               ▼
Task created    Data fetched
 │               │
 └───────┬───────┘
         ▼
    Message Broker
         │
         ▼
 Notification Service
         │
         ▼
    Notification
```

The services do not need to depend on each other directly.

A service publishes an event without having to know which other service consumes it.

---

## 5. Core concepts

### 5.1 Routine

A routine describes a workflow and its actions.

Among other things, a routine has:

* a name
* a description
* a trigger
* actions
* an order or dependencies
* an activation status

Example:

```text
Routine: Morning Setup

Trigger:
    Every weekday at 07:30

Actions:
    1. GetWeather
    2. CreateTask
    3. SendNotification
```

---

### 5.2 Trigger

A trigger determines when a routine runs.

Possible triggers:

* manual start
* schedule
* external event

For the first version, a manual trigger and a time-based trigger are enough. The implementation also supports the external event: every webhook routine gets a secret URL that other systems can call (see `scripts/demo.sh webhook`).

---

### 5.3 Action

An action is a single executable task within a routine.

Examples:

* HTTP request to an external service
* create a task
* send a message
* fetch data
* trigger a webhook

Actions are processed by specialised services.

---

### 5.4 Routine execution

Every run of a routine has its own execution.

Example:

```text
Routine:
    Weekly Review

Execution:
    2026-09-11 08:00
```

An execution has a status:

```text
PENDING
   ↓
RUNNING
   ↓
COMPLETED
```

On errors, states like these are possible:

```text
RUNNING
   ↓
FAILED
```

or:

```text
RUNNING
   ↓
WAITING
   ↓
RUNNING
```

This way a single run can be followed independently of the routine's definition.

---

## 6. Distributed architecture

The application consists of several autonomous services.

One possible split is:

```text
                    ┌───────────────┐
                    │    Client     │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ API / Gateway │
                    └───────┬───────┘
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
      ┌──────────────┐             ┌──────────────┐
      │   Routine    │             │   Identity   │
      │   Service    │             │   Service    │
      └──────┬───────┘             └──────────────┘
             │
             │ events
             ▼
      ┌─────────────────┐
      │  Message Broker │
      └────┬─────┬──────┘
           │     │
       ┌───┘     └──────────┐
       ▼                    ▼
┌──────────────┐      ┌──────────────┐
│ Action /     │      │ Notification │
│ Worker       │      │ Service      │
└──────────────┘      └──────────────┘
```

The exact number and split of services is decided during architecture planning.

What matters is that each service is responsible for a clearly bounded area.

---

## 7. Service autonomy

Each service owns its data and its internal implementation.

For example:

```text
Routine Service
    └── Routine Database

Notification Service
    └── Notification Database

Task Service
    └── Task Database
```

Services never access another service's database directly.

Communication happens exclusively through defined interfaces.

This way, for example, the internal data structure of the notification service can change without the routine service having to be adapted.

---

## 8. Synchronous communication

Synchronous communication is used when an immediate answer is needed.

For example:

```text
Client
  │
  │ POST /routines
  ▼
Routine Service
  │
  │ 201 Created
  ▼
Client
```

Synchronous communication is particularly suited to:

* user requests
* creating and changing routines
* querying the current status
* authentication

It should not be used for long-running background processing.

---

## 9. Asynchronous communication

The actual execution of actions happens asynchronously.

Example:

```text
Routine Service
      │
      │ ActionRequested
      ▼
Message Broker
      │
      ▼
Worker Service
      │
      │ ActionCompleted
      ▼
Message Broker
```

The publisher does not wait for the consumer to process the work.

This keeps the triggering service working even when a consumer is currently unavailable.

---

## 10. Failure scenario

A central part of the project is demonstrating a service outage.

Example:

```text
Routine started
      │
      ▼
ActionRequested
      │
      ▼
Message Broker
      │
      X
Notification Service DOWN
```

The message stays available in the broker.

Other parts of the routine can still be processed.

When the notification service is started again later:

```text
Notification Service
        │
        ▼
reads the waiting message
        │
        ▼
processes the action
        │
        ▼
ActionCompleted
```

The user does not have to start the routine again.

This demonstrates that a temporary consumer outage does not automatically lose any work.

---

## 11. Idempotency

Messages can be delivered more than once because of retries or network problems.

A consumer therefore must not assume that each message arrives only once.

Example:

```text
ActionRequested
      │
      ├── Delivery 1 → processed
      │
      └── Delivery 2 → already processed → ignore
```

Every executable action therefore gets a unique ID.

Using this ID, the consumer can tell whether an action has already been processed.

This prevents duplicate actions.

---

## 12. Scaling

Processing services must be able to scale horizontally.

For example:

```text
                 Message Broker
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Worker 1    Worker 2    Worker 3
```

Under higher load, additional workers can be started.

```text
1 worker
   ↓
3 workers
   ↓
5 workers
```

The work is distributed through the message broker.

Services should be as stateless as possible so that extra instances can be started without special configuration.

---

## 13. Interfaces and contracts

All communication between services is defined through explicit contracts.

These include, for example:

* OpenAPI for synchronous HTTP interfaces
* AsyncAPI or defined event schemas for asynchronous communication

The contracts live independently of the individual services.

For example:

```text
contracts/
├── routine-api.yaml
├── routine-events.yaml
└── notification-events.yaml
```

Services must not share domain classes or ORM models.

Each service has its own internal models and translates incoming and outgoing data into its own domain context.

---

## 14. Evolving an interface

An important part of the project is changing an existing event in a controlled way.

At first, for example, this message is used:

```json
{
  "executionId": "exec-123",
  "message": "Routine completed"
}
```

Later the message is extended:

```json
{
  "executionId": "exec-123",
  "notification": {
    "title": "Routine completed",
    "body": "Weekly Review finished successfully"
  },
  "priority": "normal"
}
```

The change must not break existing consumers straight away.

This is what the **expand-and-contract principle** is for:

```text
Version 1
   │
   ▼
Add new fields
   │
   ▼
Update consumers
   │
   ▼
Use the new version
   │
   ▼
Remove old fields
```

The migration must be possible without deploying all involved services at the same time.

---

## 15. Observability

Since a single routine passes through several services, an execution must be traceable across service boundaries.

Every request and every event therefore carries a shared correlation or trace ID.

Example:

```text
Trace ID: 7f91...

API Gateway
    │
    ├── Routine Service
    │
    ├── Worker Service
    │
    └── Notification Service
```

This lets the logs of all involved services be attributed to a single routine run.

In particular, it enables the analysis of:

* errors
* delays
* retries
* failed actions
* service outages

---

## 16. Security

Users must be authenticated.

Routines and their executions each belong to a user.

A user may only access their own routines and executions.

Authentication is provided by an external or standalone identity provider.

The concrete technology is decided during architecture planning.

---

## 17. Planned main workflow

The central demo workflow is:

```text
1. User creates a routine
        ↓
2. Routine is activated
        ↓
3. Trigger starts the routine
        ↓
4. Routine service creates an execution
        ↓
5. Actions are published as events
        ↓
6. Workers process the actions
        ↓
7. Workers publish results
        ↓
8. Execution is updated
        ↓
9. Routine is shown as completed
```

This workflow is the end-to-end slice for the live demonstration.

---

## 18. Planned resilience workflow

In addition, a service outage is demonstrated:

```text
1. Start a routine
        ↓
2. Stop the worker service
        ↓
3. The action is still published
        ↓
4. The message waits in the broker
        ↓
5. The routine service and other services stay available
        ↓
6. Start the worker service
        ↓
7. The message is processed
        ↓
8. The execution completes
```

This makes the benefits of asynchronous decoupling visible in practice.

---

## 19. Project scope

The first version deliberately concentrates on a small feature set.

### Included

* user authentication
* creating, editing and activating routines
* triggering a routine manually
* time-based triggers
* several action types
* asynchronous action processing
* status of a routine execution
* message broker
* retry behaviour
* idempotency
* horizontal scaling of a worker
* structured logs
* correlation ID and distributed tracing
* versioned interfaces
* demonstration of a breaking change
* Docker-based system start

### Not part of the first version

* complex visual workflow editor
* mobile app
* marketplace for integrations
* extensive user management
* complex permission models
* artificial intelligence as a core feature
* arbitrarily complex workflow branching
* production-grade SaaS infrastructure

The focus is on the quality of the distributed system, not on the number of features.

---

## 20. Success criteria

Routine counts as successfully implemented when:

1. at least three autonomous services communicate with each other;
2. both synchronous and asynchronous communication are used;
3. services manage their data independently;
4. events are processed through a message broker;
5. duplicate messages are handled safely;
6. at least one worker can be scaled horizontally;
7. a failed consumer loses none of the work already published;
8. a routine run can be traced across several services;
9. an interface can evolve without deploying all dependent services at the same time;
10. the whole system can be started with a single, defined start command.

---

## 21. The core idea in one sentence

**Routine is a distributed automation platform where users define recurring workflows whose individual actions are processed independently, asynchronously, fault-tolerantly and scalably by autonomous services.**

---

## 22. Implementation

The platform is fully implemented. Details: [docs/architecture.md](docs/architecture.md) · Live demo and evidence for the success criteria: [docs/demo.md](docs/demo.md) · Testing manually on your machine: [docs/testing.md](docs/testing.md) · Contracts: [contracts/](contracts/README.md)

## Quick start

Prerequisite: Docker (Compose v2). The demo scripts also need `curl` and `jq`.

```bash
docker compose up -d --build --wait   # starts the whole system
scripts/demo.sh main                  # main workflow in the terminal
scripts/demo.sh all                   # all scenarios as an acceptance test
scripts/demo.sh hook "Webhook Inbox" '{"hello":"world"}'   # call a webhook routine by hand
docker compose down -v                # stop and delete data
```

| | URL |
| --- | --- |
| Web UI & API (gateway) | <http://localhost:8080> – sign in with `demo@routine.local` / `demo12345` |
| RabbitMQ management | <http://localhost:15672> – `routine` / `routine` |
| Jaeger (distributed tracing) | <http://localhost:16686> |
| Mock external APIs | <http://localhost:8090> |

## Layout

```text
compose.yaml                 whole system (16 containers)
contracts/                   OpenAPI, AsyncAPI, JSON Schemas (independent of the services)
infra/rabbitmq/              broker topology as code
libs/service-kit/            technical chassis (logging, HTTP, DB, broker, auth, tracing) – no domain models
services/
  gateway/                   API gateway (single entry point)
  identity-service/          users, login, JWT/JWKS
  routine-service/           routines, orchestration, scheduler, outbox
  task-service/              tasks (action task.create)
  notification-service/      inbox (notification.send, execution events)
  integration-worker/        scalable worker for external calls
  mock-external/             simulated third-party services
web/                         web client (React + Vite, nginx) – its own service
scripts/demo.sh              demo scenarios / acceptance test
```

## Development

```bash
npm install                # service dependencies (Node ≥ 24)
npm --prefix web install   # web client dependencies
npm --prefix web run dev   # UI with hot reload on :5173 (API via the running gateway)
npm run typecheck          # TypeScript
npm test                   # unit and contract tests
```
