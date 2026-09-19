# Routine – Distributed Automation System

## 1. Project overview

**Project name:** Routine
**Project type:** Distributed system / microservices
**Module:** M321 – Distributed Systems
**Project team:** 3–4 people
**Planned effort:** about 20 lessons per person

---

## 2. Project idea

Routine is a platform that lets users define recurring workflows and have them run automatically.

A routine consists of a trigger and several actions. The trigger can be, for example, a schedule or a manual start. The individual actions are then processed by specialised system components.

An example:

> Every Monday morning a routine should start that fetches information, creates a task and then sends a notification.

To the user this appears as a single workflow. Internally, however, the processing is spread across several autonomous services.

The focus of the project is therefore not an extensive user interface but the implementation of a working distributed system with clear interfaces, asynchronous communication and measures for high availability.

---

## 3. Objectives

Routine is meant to be a realistic distributed system in which the individual team members are each responsible for their own system components.

In particular, the following goals should be achieved:

* developing several independent system components
* defining and adhering to clear interfaces
* communication between the system components
* using synchronous and asynchronous communication
* using a message broker
* reliable message processing
* handling messages that are delivered more than once
* horizontal scaling of at least one system component
* implementing high-availability measures
* comprehensible error handling
* central traceability of distributed workflows
* integrating the individual components into a working overall system

---

## 4. System requirements

### 4.1 Functional requirements

#### Must-have requirements

The system must:

1. Be able to authenticate users.
2. Let users create routines.
3. Be able to activate and deactivate routines.
4. Be able to run routines manually.
5. Be able to run routines on a schedule.
6. Be able to build a routine from several actions.
7. Keep a separate status for every run.
8. Hand actions asynchronously to the responsible system components.
9. Recognise successful and failed actions.
10. Allow failed actions to be retried.
11. Be able to recognise messages that have already been processed.
12. Be able to show the status of a routine run.

#### Optional requirements

Depending on the time available, the following can also be implemented:

* additional trigger types
* additional action types
* retry rules for individual actions
* priorities for actions
* execution history
* simple statistics
* webhooks as external actions

---

## 5. Non-functional requirements

The system should have the following properties:

### Interfaces

All communication between the system components happens through clearly defined and documented interfaces.

The interfaces are described formally before or alongside the implementation.

### Autonomy

Each system component has a clearly bounded area of responsibility.

Components must not access other components' databases directly.

### Asynchrony

Long-running or mutually independent processing should go through a message broker.

A consumer outage must not block the publisher.

### Idempotency

Messages can arrive more than once because of retries. Processing must therefore be implemented so that a message does not lead to unwanted repeated actions.

### Scalability

At least one system component should be horizontally scalable.

Several instances of the same component should be able to process messages at the same time.

### High availability

The system should remain as functional as possible even when individual components fail.

At least two concrete high-availability measures should be implemented and demonstrated.

### Observability

Distributed operations should be traceable through structured logs and a shared correlation or trace ID.

### Deployment

All components needed for the overall system should be installable and runnable on LernMAAS.

---

## 6. System components

The system is split into several autonomous components.

The exact split is decided together as a team. One possible split is:

| Component                      | Responsibility                               |
| ------------------------------ | -------------------------------------------- |
| **Routine Service**            | Managing routines and their executions       |
| **Execution / Worker Service** | Processing and executing actions             |
| **Integration Service**        | Communicating with external services         |
| **Notification Service**       | Sending notifications                        |

In addition, infrastructure components such as a message broker and possibly an API gateway are used.

The concrete division of responsibility is recorded during project planning. Each team member takes full ownership of at least one system component and is responsible for its implementation, integration and documentation.

---

## 7. How the components interact

Central communication follows, for example, this principle:

```text
                         ┌───────────────┐
                         │    Client     │
                         └───────┬───────┘
                                 │
                                 ▼
                         ┌───────────────┐
                         │ Routine       │
                         │ Service       │
                         └───────┬───────┘
                                 │
                         Action Requested
                                 │
                                 ▼
                       ┌───────────────────┐
                       │  Message Broker   │
                       └───────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
       │ Worker      │  │ Integration │  │ Notification│
       │ Service     │  │ Service     │  │ Service     │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                         Action Completed
```

The individual services do not communicate through shared domain models or shared databases.

---

## 8. Example system run

A user creates the routine **"Weekly Review"**:

```text
Trigger:
Every Monday at 08:00

Actions:
1. Fetch information
2. Create a task
3. Send a notification
```

At the scheduled time, a new routine run is created.

The required actions are then published as messages.

```text
Routine Service
      │
      │ RoutineTriggered
      ▼
Message Broker
      │
      ├──► Integration Service
      │
      ├──► Worker Service
      │
      └──► Notification Service
```

The services process their respective work independently and report the result back, again through defined messages.

---

## 9. High availability and fault tolerance

A key part of the project is dealing with outages.

For example, the notification service may be unavailable while a routine is running.

```text
Routine Service
      │
      ▼
Message Broker
      │
      X
Notification Service unavailable
```

The message is not discarded; it stays in the message broker.

Once the notification service restarts, the message can be processed.

```text
Notification Service starts
            │
            ▼
waiting message is read
            │
            ▼
action is processed
            │
            ▼
result is published
```

This way the whole routine does not have to be started again.

Further possible high-availability measures are:

* several worker instances
* automatic retries of failed messages
* timeouts
* dead letter queue
* health checks
* horizontal scaling

At least two of these measures should be implemented and working.

---

## 10. Interfaces

The interfaces between the system components are defined independently of their implementation.

API specifications are used for synchronous communication.

Event or message schemas are defined for asynchronous communication.

For example:

```json
{
  "executionId": "exec-123",
  "actionId": "action-456",
  "actionType": "notification",
  "payload": {
    "message": "Routine completed"
  }
}
```

The interfaces are versioned, and changes should be possible without unnecessary dependencies between team members.

Shared business logic or shared domain classes are not used as a shared library.

---

## 11. Breaking changes

At least one interface change should be demonstrated during the project.

For example, an existing event is extended:

### Version 1

```json
{
  "executionId": "exec-123",
  "message": "Routine completed"
}
```

### Version 2

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

Where possible, the change should work without deploying all affected services at the same time.

This demonstrates how an interface evolves within a distributed system.

---

## 12. Observability

Since a routine passes through several system components, a single run must be traceable across the different services.

A correlation or trace ID is used for this.

Example:

```text
Trace ID: 7f91a2

API Gateway
    │
    ▼
Routine Service
    │
    ▼
Message Broker
    │
    ├──► Worker Service
    │
    └──► Notification Service
```

The involved services write structured logs containing this ID.

This makes it possible to see when and where a routine or an individual action was processed.

---

## 13. Project approach

The project is implemented step by step.

### Phase 1 – Concept

* define requirements
* decide on and prioritise features
* identify system components
* assign responsibilities
* design the architecture
* define high-availability measures

### Phase 2 – Interface planning

* define synchronous interfaces
* define event schemas
* decide data ownership
* consider failure cases
* plan versioning

### Phase 3 – Feasibility check

* test the message broker
* test high-availability concepts
* verify deployment on LernMAAS
* test basic communication between components

### Phase 4 – Individual development

Each team member develops their assigned system component independently.

The previously defined interfaces are respected.

### Phase 5 – Integration

The individual components are connected to each other.

The complete end-to-end workflow is then tested.

### Phase 6 – High availability

The planned high-availability measures are implemented and tested.

### Phase 7 – Testing and bug fixing

The overall system is tested under normal conditions as well as with individual components failing.

### Phase 8 – Documentation and submission

The documentation is completed, and code and documentation are prepared for submission.

---

## 14. Testing

Testing happens alongside development.

Test cases are defined and documented for the system components.

The following are tested in particular:

* successful routine runs
* failing actions
* repeated messages
* a consumer outage
* recovery after an outage
* parallel processing
* horizontal scaling
* interface changes
* end-to-end communication

If time allows, automated tests should also be written for the individual components.

---

## 15. Deployment

It should be possible to run the overall system on LernMAAS.

The required services and infrastructure components are containerised and started through a shared deployment configuration.

The goal is to start the overall system as simply as possible.

For example:

```bash
docker compose up
```

After starting, all components needed for a system run should be available.

---

## 16. Scope boundaries

Routine is not a complete workflow automation platform like commercial solutions.

The project focuses on demonstrating the technical properties of a distributed system.

It therefore deliberately does not implement extensive features such as complex user management, large integration catalogues or a visual workflow editor.

The available development time should instead go into clean interfaces, autonomous components, asynchronous communication, high availability and testing.

---

## 17. Expected project outcome

At the end of the project there is a working distributed system with which users can create and run routines.

The system consists of several independently developed system components and supports a complete end-to-end run.

In addition, it can be demonstrated that:

* a component can fail independently,
* tasks already published are not lost,
* tasks continue to be processed after an outage,
* workers can be scaled horizontally,
* messages are processed idempotently,
* distributed workflows are traceable,
* interfaces can evolve without updating the whole system at once.

Routine thus covers the central learning goals of the project while keeping the scope manageable for the available project time.

---

## 18. Conclusion

Routine implements a realistic example of a distributed system. The application itself stays deliberately simple, while the technical architecture makes several central challenges of distributed systems visible.

Splitting the system into autonomous services lets team members develop independently while still building one overall system through defined interfaces.

The main value of the project therefore lies not in the number of features but in the fact that distribution, asynchrony, service autonomy, high availability and interface evolution are implemented and demonstrated in practice.
