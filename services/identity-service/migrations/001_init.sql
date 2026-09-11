-- Identity Service owns users and signing keys.

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  email          text        NOT NULL UNIQUE,
  display_name   text        NOT NULL,
  password_hash  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Signing keys are persisted so tokens stay valid across restarts and replicas.
CREATE TABLE signing_keys (
  kid          text PRIMARY KEY,
  private_jwk  jsonb       NOT NULL,
  public_jwk   jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
