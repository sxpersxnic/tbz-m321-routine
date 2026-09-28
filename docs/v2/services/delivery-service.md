# delivery-service (new, M8)

## 1. Responsibility

Gets notifications to people outside the app: **web push**, **e-mail digest** and **chat**.
It applies per-user rules and quiet hours. Each channel has its own internal work queue, so
one failing channel (e.g. the chat webhook is down) never delays the others. That's the v1
failure-isolation story with a visible user benefit.

## 2. Data (`delivery-db`)

```sql
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL, auth text NOT NULL, device_label text, created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz, failures integer NOT NULL DEFAULT 0
);
CREATE TABLE preferences (
  owner_id uuid PRIMARY KEY,
  push_enabled boolean NOT NULL DEFAULT true,
  email_digest text NOT NULL DEFAULT 'off',          -- off | daily | weekly
  email_address text,
  chat_connection_id uuid,                            -- connector-service id (kind chatWebhook), from M9
  chat_webhook_url_enc bytea,                         -- M8 interim only (AES-GCM, DELIVERY_LOCAL_KEY); moved to a connection and dropped in M9-05
  quiet_from time, quiet_to time,                     -- local time; null = none
  min_priority_push text NOT NULL DEFAULT 'normal',   -- low | normal | high
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deliveries (                             -- idempotency + history
  notification_id uuid NOT NULL, channel text NOT NULL, target text NOT NULL,
  status text NOT NULL,                               -- sent | failed | deferred
  attempts integer NOT NULL DEFAULT 0, sent_at timestamptz, error text,
  PRIMARY KEY (notification_id, channel, target)
);
CREATE TABLE digest_items (owner_id uuid NOT NULL, notification_id uuid NOT NULL, title text NOT NULL, body text,
  created_at timestamptz NOT NULL, PRIMARY KEY (owner_id, notification_id));
CREATE TABLE owners (owner_id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Zurich');
```

## 3. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/delivery/vapid-public-key` | for `pushManager.subscribe` |
| `POST /api/v1/delivery/push-subscriptions` | register this device |
| `DELETE /api/v1/delivery/push-subscriptions/:id` | |
| `GET/PUT /api/v1/delivery/preferences` | |
| `POST /api/v1/delivery/test` | send a test push/e-mail/chat to the caller |

## 4. Messages and flow

1. Consume `notification.created` and `ExecutionWaitingForYou` (`delivery-service.notifications`).
2. Decide channels: push if enabled, priority ≥ `min_priority_push` **or** kind `question` /
   waiting-for-you, and not in quiet hours (outside quiet hours only; inside, it's deferred to
   `quiet_to`). E-mail digest: store in `digest_items`. Chat: if configured and priority
   `high`.
3. For each (channel, target): insert `deliveries` row (`ON CONFLICT DO NOTHING` = idempotent)
   and publish an internal job to `delivery-service.push` / `.email` / `.chat` (outbox).
4. Channel consumers send: push with `web-push` (VAPID, TTL 12 h, payload `{ title, body, url,
   actions }`; `410 Gone` deletes the subscription), e-mail via the mail provider (mock-external
   `/mail/messages` in dev), chat via `integration-worker`-style HTTP with the webhook URL
   resolved from connector-service. Retries 1 s / 5 s / 30 s, then DLQ.
5. Push notifications for questions carry `actions` (up to 2 options). The service worker
   answers via `POST /api/v1/notifications/:id/answer` ([07-web.md §9](../07-web.md)).

**Digest job:** every 15 min, per owner whose local time is 07:00 (daily) or Monday 07:00
(weekly): one e-mail listing `digest_items`, then delete them. The *Your week* e-mail is **not**
sent here: it's the *Weekly review* routine's `email.send` step.

## 8. Configuration

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `MAIL_API_URL`, `CONNECTOR_URL`,
`SERVICE_TOKEN_SECRET`.

## 10. Tests

Quiet hours across midnight. Idempotent delivery on duplicate events. `410` removes the
subscription. Chat channel down → push still delivered (system test with chaos on chat).
