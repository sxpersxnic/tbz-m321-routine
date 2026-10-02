# identity-service (v2) · domain `profile`

> **Keycloak note (M0):** v1 replaced the custom identity-service with **Keycloak** (realm
> `routine`, `infra/keycloak/realm-routine.json`) before this plan was written. Users, sign-in,
> tokens, **roles** and **service accounts** are therefore Keycloak configuration, not tables:
> see §6. The profile, areas and workspaces (M5, M11) still need a service of their own. Where
> they live is decided before M5 starts.

## 1. Responsibility

Users, login and tokens (v1), plus **roles**, **service accounts**, the **profile** (time zone,
currency, week start, vacation mode, enabled domains, auto-archive setting), **areas**, and
(M11) **workspaces**. It is the source of `profile.*` and `area.*` events.

## 2. Data

```sql
-- M0
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user';          -- user | admin
CREATE TABLE service_accounts (
  name         text PRIMARY KEY,                                        -- 'trigger-service'
  secret_hash  text NOT NULL,                                           -- scrypt, like passwords
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- + outbox (service-kit)

-- M5
CREATE TABLE profiles (
  user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  timezone           text    NOT NULL DEFAULT 'Europe/Zurich',
  currency           text    NOT NULL DEFAULT 'CHF',
  week_start         integer NOT NULL DEFAULT 1,                         -- ISO weekday
  enabled_domains    text[]  NOT NULL DEFAULT '{tasks,notifications}',
  domain_order       text[]  NOT NULL DEFAULT '{}',
  paused_until       timestamptz,
  auto_archive_days  integer NOT NULL DEFAULT 30,
  onboarded_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE areas (
  id           uuid PRIMARY KEY,
  owner_id     uuid        NOT NULL,
  name         text        NOT NULL,
  icon         text,
  color        text        NOT NULL DEFAULT 'grey',
  position     integer     NOT NULL,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX areas_owner_name_idx ON areas (owner_id, lower(name)) WHERE archived_at IS NULL;

-- M11
CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role         text NOT NULL,                                          -- owner | editor | viewer
  PRIMARY KEY (workspace_id, user_id)
);
```

A missing `profiles` row means defaults. It is created on first `PATCH /me` or at onboarding.

## 3. HTTP API

| Method & path | Milestone | Purpose |
| --- | --- | --- |
| ~~`POST /api/v1/auth/service-token`~~ | M0 | Keycloak's token endpoint instead (client-credentials), see §6 |
| `GET /api/v1/auth/me` | M5 | + `role`, `profile`, `workspaces` (M11) |
| `PATCH /api/v1/me` | M5 | profile fields |
| `PUT /api/v1/me/domains` | M5 | `{ enabled: string[], order: string[] }` → emits `profile.domainsChanged` |
| `POST /api/v1/me/onboarding` | M5 | `{ domains, templates }` marks onboarded (templates are instantiated by the web via routine-service) |
| `GET/POST /api/v1/areas`, `PATCH/DELETE /api/v1/areas/:id` | M5 | delete = archive |
| `POST /api/v1/areas/reorder` | M5 | `{ ids }` |
| `POST /api/v1/workspaces`, `POST /api/v1/workspaces/:id/members`, `POST /api/v1/auth/switch-workspace` | M11 | see §5 |

**Tokens (M0):** user tokens gain `roles: ['user'|'admin']`. The seeded demo user is `admin`.
Service accounts are seeded from env `SERVICE_ACCOUNTS=name:secret,…` (Swarm secrets in the
VM deployment).

## 4. Messages

Produces (outbox, `domain.events`): `profile.updated` (all profile fields), `profile.domainsChanged`
(`enabled, order`), `profile.vacationChanged` (`pausedUntil`), `area.created`, `area.updated`,
`area.archived` (fields `areaId, name, color, icon`).

## 5. Workspaces (M11)

- A user's **personal workspace id = user id** (no row needed in `workspaces`).
- Tokens carry `sub` (user) and `ws` (acting workspace, default = `sub`).
- service-kit `requireUser` becomes `requireActor(request) → { userId, ownerId: ws ?? sub, role }`.
  Every service uses `ownerId` where v1 used `user.id` for scoping. That's a mechanical change,
  done by one package per service.
- Viewer role: services reject writes (`403`) when the membership role is `viewer`
  (`wsRole` claim).
- An activity log is out of scope for M11. Events carry `actorId` (additive) so it can be
  built later.

## 6. Roles and service accounts in Keycloak (as built in M0)

| Plan (§2, §3) | Built |
| --- | --- |
| `users.role`, demo user `admin` | Realm role `admin`, granted to the demo user in the realm file. Every signed-in user counts as `user`. |
| `roles` claim | Protocol mapper `roles` (realm roles, multivalued) on `routine-web` and `routine-cli`. service-kit `rolesOf` also reads Keycloak's `realm_access.roles`. |
| `ADMIN_EMAILS` | Dropped: Keycloak can't grant a role on registration by e-mail without a custom extension. Admins are granted in the admin console (`/auth/admin`). |
| `service_accounts` table, `POST /api/v1/auth/service-token` | One **confidential client per service account** in the realm (client-credentials grant only, `access.token.lifespan` 900 s, audience mapper `routine-internal`). Services get tokens from Keycloak's token endpoint (`TOKEN_URL`, default: `JWKS_URL` with `/certs` → `/token`) through service-kit `serviceTokenProvider`. |
| `sub: service:<name>` | Keycloak's `sub` is the service-account user's id; the service name is the token's **`azp`** (the client id). `installServiceAuth` checks `aud: routine-internal` and `azp` ∈ allowed. |
| `SERVICE_ACCOUNTS=name:secret,…` | The realm file lists the clients; each secret is a placeholder `${<NAME>_TOKEN_SECRET}` filled from Keycloak's environment, and the same value reaches the service as `SERVICE_TOKEN_SECRET`. On VMs `deploy.sh` generates it like the other secrets. |

Adding a service account = a client in `realm-routine.json` (copy `integration-worker`), the
secret in `compose.yaml` (Keycloak and the service), `deploy/stack.yml` and `deploy.sh`
`SECRET_NAMES`.

The realm file is imported only when the realm doesn't exist yet. An existing Keycloak database
keeps its realm: add new roles, grants and service-account clients in the admin console there
(or recreate the `keycloak-db` volume in a development stack).

## 8. Configuration

v1 variables. Roles and service accounts are Keycloak configuration (§6).

## 10. Tests

Service token: wrong secret → identical response and timing as wrong password (v1 rule).
User tokens can't reach `/internal`. Area name uniqueness per owner. `profile.*` events in
the same transaction as the update.
