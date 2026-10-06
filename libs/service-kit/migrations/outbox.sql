-- Transactional outbox: messages are written in the same transaction as the
-- state change and published asynchronously by the relay (outbox.ts).
CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  message_id      uuid        NOT NULL UNIQUE,
  exchange        text        NOT NULL,
  routing_key     text        NOT NULL,
  payload         jsonb       NOT NULL,
  trace_headers   jsonb       NOT NULL DEFAULT '{}',
  correlation_id  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
