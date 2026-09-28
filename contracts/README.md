# Contracts

All interfaces between the services are described formally here – independent of
the services' code. Services share **no** domain classes: each service translates
messages into its own internal model in its own `src/messages.ts`.

| File | Contents |
| --- | --- |
| `openapi/routine-api.yaml` | Routines, triggering, execution status (synchronous) |
| `openapi/task-api.yaml` | Tasks (synchronous) |
| `openapi/notification-api.yaml` | Inbox (synchronous) |
| `asyncapi/routine-messaging.yaml` | Exchanges, routing keys, producers/consumers (asynchronous) |
| `schemas/*.schema.json` | JSON Schemas of all messages, including the envelope and both versions of `ExecutionCompleted` |
| `validate.ts` | Helper for contract tests (tests only, never at runtime) |

## Identity

Sign-in, registration and tokens are Keycloak's (realm `routine`, `infra/keycloak/realm-routine.json`), so their
contract is the OpenID Connect standard itself: the discovery document
`/auth/realms/routine/.well-known/openid-configuration` lists every endpoint and the signing keys. The OpenAPI files
reference it as their `openIdConnect` security scheme.

Replacing the former `identity-api.yaml` (own login endpoints) with Keycloak was a deliberate cut-over, not an
expand-and-contract: the only clients of the login API were the web client and the demo scripts, which moved in the
same change. External API clients would have needed both issuers accepted for a transition period.

## Versioning

* **HTTP**: path version `/api/v1`. Additive changes stay in v1; breaking changes get `/api/v2` alongside v1.
* **Events**: `version` field in the envelope. Consumers are *tolerant readers* (unknown fields are ignored).
  Fields are never removed directly but via **expand and contract** – see `ExecutionCompleted` v1 → v2 and
  `scripts/demo.sh evolution`.

## Contract tests

`npm test` checks that every produced message matches its schema
(`services/*/test/contracts.test.ts`). An accidentally incompatible producer is
caught before it is deployed.
