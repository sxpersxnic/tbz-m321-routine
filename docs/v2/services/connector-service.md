# connector-service (new, M9)

## 1. Responsibility

Stores **connections**: named, encrypted credentials a user adds once and routines reference
by name (`{{secrets.github}}`) or by id (`ref`). Only services with a service token may read
values, and only at execution time. Users can never read a stored value back.

## 2. Data (`connector-db`)

```sql
CREATE TABLE connections (
  id            uuid PRIMARY KEY,
  owner_id      uuid        NOT NULL,
  name          text        NOT NULL,              -- ^[a-z][a-z0-9_]{0,39}$, used in {{secrets.<name>}}
  kind          text        NOT NULL,              -- secret | icsUrl | chatWebhook
  label         text        NOT NULL,              -- 'GitHub (personal)'
  ciphertext    bytea       NOT NULL,
  nonce         bytea       NOT NULL,              -- 12 bytes, random per write
  key_version   integer     NOT NULL,
  hint          text,                              -- last 4 characters, for recognition
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE (owner_id, name)
);
CREATE TABLE access_log (                          -- every resolve, 30 days
  id bigserial PRIMARY KEY, connection_id uuid NOT NULL, service text NOT NULL,
  action_id uuid, at timestamptz NOT NULL DEFAULT now()
);
```

**Encryption:** AES-256-GCM, key from `CONNECTOR_MASTER_KEYS` (`1:<base64 32 bytes>,2:…`). New
writes use the highest version. Additional authenticated data = `owner_id || id`, so a
ciphertext copied to another row fails to decrypt.

## 3. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/connections` | metadata only (`id, name, kind, label, hint, lastUsedAt`) |
| `POST /api/v1/connections` | `{ name, kind, label, value }` → metadata. `value` never echoed. |
| `PUT /api/v1/connections/:id/value` | replace the value |
| `DELETE /api/v1/connections/:id` | |
| `POST /internal/v1/resolve` | service token from the allow-list (`integration-worker`, `delivery-service`, `calendar-service`): `{ ownerId, actionId?, names?, ids? }` → `{ values: { <name or id>: string } }`. An unknown name or id → `404` naming it. Callers fail the step with `REFERENCE_GONE`. |

connector-service publishes no manifest of its own. The picker collection `connections`
(`GET /api/v1/connections`, filterable by `?kind=`) is declared in the **connections**
manifest of integration-worker. A collection may point at any service's endpoint.

## 8. Configuration

`CONNECTOR_MASTER_KEYS`, `RESOLVE_ALLOWED_SERVICES`.

## 10. Tests

Round-trip encryption. AAD mismatch fails. Values never in logs or HTTP responses. Resolve
rejects user tokens and non-allow-listed services. Key rotation: old versions still decrypt.
