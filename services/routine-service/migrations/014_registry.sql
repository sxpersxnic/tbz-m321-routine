-- The domain registry (docs/v2/04-domain-platform.md §4): every manifest version a domain registered,
-- and per domain the current one, its last heartbeat and the last rejected registration.
CREATE TABLE domain_manifests (
  domain            text        NOT NULL,
  manifest_version  integer     NOT NULL,
  digest            text        NOT NULL,
  manifest          jsonb       NOT NULL,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, manifest_version)
);

CREATE TABLE domains (
  domain             text PRIMARY KEY,
  current_version    integer,                 -- null: never accepted (only a rejected registration so far)
  service            text        NOT NULL,
  last_heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  rejected           jsonb                    -- { reason, manifestVersion, digest, service, instance, at } – shown on Infrastructure
);
