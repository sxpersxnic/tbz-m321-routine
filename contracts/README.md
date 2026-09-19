# Contracts

All interfaces between the services are described formally here – independent of
the services' code. Services share **no** domain classes: each service translates
messages into its own internal model in its own `src/messages.ts`.

| File | Contents |
| --- | --- |
| `openapi/identity-api.yaml` | Registration, login, JWKS (synchronous) |
| `openapi/routine-api.yaml` | Routines, triggering, execution status (synchronous) |
| `openapi/task-api.yaml` | Tasks (synchronous) |
| `openapi/notification-api.yaml` | Inbox (synchronous) |
| `asyncapi/routine-messaging.yaml` | Exchanges, routing keys, producers/consumers (asynchronous) |
| `schemas/*.schema.json` | JSON Schemas of all messages, including the envelope and both versions of `ExecutionCompleted` |
| `validate.ts` | Helper for contract tests (tests only, never at runtime) |

## Versioning

* **HTTP**: path version `/api/v1`. Additive changes stay in v1; breaking changes get `/api/v2` alongside v1.
* **Events**: `version` field in the envelope. Consumers are *tolerant readers* (unknown fields are ignored).
  Fields are never removed directly but via **expand and contract** – see `ExecutionCompleted` v1 → v2 and
  `scripts/demo.sh evolution`.

## Contract tests

`npm test` checks that every produced message matches its schema
(`services/*/test/contracts.test.ts`). An accidentally incompatible producer is
caught before it is deployed.
