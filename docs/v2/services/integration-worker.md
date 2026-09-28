# integration-worker (v2) · domain `connections`

## 1. Responsibility

Stateless, horizontally scaled worker for calls to the outside world. It resolves secrets
through connector-service at execution time. v1 idempotency (`action_executions` claim/lease)
stays. The domain kit is used for registration and topology only: this worker keeps its own
claim logic because external calls can't be inside a database transaction.

## 2. Data

Unchanged (`action_executions`). New column `error_code text`.

## 4. Messages

Consumes `ActionRequested` on `integration-worker.actions` (v1 bindings + exact bindings for
new types). Produces v1 results with v2 error codes ([../05-messaging.md §6](../05-messaging.md)).
Does not consume `ActionCancelRequested` (no human capabilities).

## 5. Manifest (`connections`, `optional: false`)

Prefixes: `weather`, `http`, `summary`, `email`, `chat`, `feed`.

| Type | Kind | Params | Output | Milestone |
| --- | --- | --- | --- | --- |
| `weather.get` | value | `city`* | `city, temperatureC, condition, summary` | v1 |
| `http.request` | action | `url`*, `method`, `headers` (object, `acceptsSecrets`), `body` | `status, body, headers` | v1 |
| `summary.generate` | value | `title`*, `sections` (object) | `text` | v1 |
| `email.send` | action (`preview`) | `to`*, `subject`*, `body` | `messageId` | v1 |
| `chat.post` | action (`preview`) | `connection`* (ref connections kind `chatWebhook`), `text`* | `postedAt` | M9 |
| `feed.latest` | value | `url`*, `limit` | `items` [{title, link, publishedAt}], `count` | M9 |

Triggers (M9): `feed.itemPublished` is **not** offered. Polling triggers are out of scope.
"When a page changes" is built as a scheduled routine with `feed.latest` + `list.filter` +
a variable, which keeps the worker stateless.

### Secrets

Before executing, the worker scans resolved params for `{{secrets.<name>}}`. If present, it
calls `POST /internal/v1/resolve` on connector-service with `{ ownerId, actionId, names }`
(service token), substitutes values in memory, and **never** logs params, headers or the
substituted body. Outputs are scrubbed: any occurrence of a resolved secret value in the
output is replaced by `••••`.

`chat.post` takes a connection id (`ref`) instead of a secret template. The worker resolves
it the same way (`names` → `ids`).

### Real weather (M9)

`WEATHER_PROVIDER=mock|open-meteo`. `open-meteo` needs no key: geocode the city
(`geocoding-api.open-meteo.com`), then `api.open-meteo.com/v1/forecast`. The output contract
is unchanged. Both hosts go on the allow-list for this action only (the HTTP allow-list for
`http.request` stays separate).

## 8. Configuration

`CONNECTOR_URL`, `SERVICE_TOKEN_SECRET`, `WEATHER_PROVIDER`, v1 variables.

## 10. Tests

Secret never in logs (capture logger output in the test), scrubbed from outputs. HTTP status
→ error code mapping table. `chat.post` preview in test mode sends nothing.
