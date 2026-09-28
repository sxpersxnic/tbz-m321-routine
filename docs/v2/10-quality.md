# 10 – Quality, testing and working rules

## 1. Test layers

| Layer | Tool | Where | Runs in CI |
| --- | --- | --- | --- |
| Unit (pure logic: engine state machine, parsers, filters, diff, money) | `node --test` | `libs/*/test`, `services/*/test`, `web/src/**/*.test.ts` | ✓ |
| Contract (every produced message and manifest validates, and parsers read fixtures) | `contracts/validate.ts` | `services/*/test/contracts.test.ts` | ✓ |
| Domain conformance ([04 §7](04-domain-platform.md)) | node test + in-memory fake broker from the kit | `services/<domain>/test/conformance.test.ts` | ✓ |
| System (whole stack in Docker) | `scripts/demo.sh <scenario>` | new scenarios per milestone (§3) | ✓ (`system.yml`) |
| Web build + types | `npm run build` in `web/` | | ✓ |
| Accessibility | axe-core via Playwright script | `web/scripts/a11y.mjs` | ✓ (against the system stack) |
| Manual browser check | Vite dev server (`npm run dev`) | – | – |

### Shared fixtures

Parsers that exist on both server and client share test vectors in `contracts/fixtures/`:
`capture-syntax.json`, `quick-entry-*.json`, `conditions.json` (filter and `condition.if`
semantics). Both sides' tests load the same file.

## 2. Accessibility check

v2 adds `axe-core` and `playwright` as **devDependencies of `web/`** and a script
`web/scripts/a11y.mjs` that logs in as the demo user, visits every route of
[07 §1](07-web.md) (with a seeded fixture routine, run, task, budget data where the domain is
enabled), runs axe on each, and exits non-zero on any violation. Run it against the dev server
or the compose stack: `node web/scripts/a11y.mjs http://localhost:5173`.

## 3. System test scenarios

Added to `scripts/demo.sh` (each also documented in `docs/demo.md` on `feat/v2-dev`):

| Scenario | Milestone | Shows |
| --- | --- | --- |
| `resume` | M1 | fail → fix → resume, earlier outputs unchanged |
| `dlq-ui` | M1 | the v1 breaking-change demo, replay through the gateway API |
| `registry` | M2 | five domains registered, incompatible manifest rejected |
| `human-step` | M3 | checklist run completed by ticking tasks, expiry path |
| `event-trigger` | M4 | task completed → routine runs, self-trigger stopped |
| `today-live` | M5 | two SSE clients see the same change, one replica killed in between |
| `payday` | M6 | camt.053 import → Payday → goal, budget-service restarted mid-run |
| `birthday` | M7 | birthday event → task + planned expense |
| `channels` | M8 | chat down, push/e-mail still delivered, chat catches up |
| `secrets` | M9 | secret used, never visible in logs/records |
| `share` | M10 | export → import by a second user with setup answers |
| `workspace` | M11 | shared chore, viewer blocked |
| `chaos` | M12 | pause consuming, queue grows, resume, runs complete |

## 4. Working rules for implementing agents

1. **Branches.** `main` stays the v1 hand-in (tag `v1.0.0`). All v2 work happens on the one
   integration branch `feat/v2-dev`, cut from `v1.0.0`. No per-milestone branches: the
   milestone boundary is the push (rule 3).
2. **One work package = one commit** that also ticks its checkbox in the milestone file. A
   large package may be split into commits named *part 1/2*, *part 2/2*. The box is ticked in
   the last one. Commit messages follow the repository's style (`feat(scope): …`,
   `fix(scope): …`) and mention the package id (`M1-04`).
3. **Push once per milestone** (at the end), unless told otherwise.
4. **Order.** Work packages in the listed order. Within a package: contracts → producer →
   consumer → web.
5. **Source of truth.** Service spec > milestone > other docs. If you find a conflict or a gap,
   make the smallest consistent decision, note it in the commit message under
   `Spec note:`, and fix the doc in the same commit.
6. **Scope.** Don't build anything listed in [08 §4](08-roadmap.md), and don't add features a
   package doesn't name.
7. **Architecture rules (never break):** one database per service, no cross-service DB
   access, every state change and its messages in one transaction via the outbox, every
   consumer idempotent, every background loop replica-safe, `/internal` only with service
   tokens, no secrets or sensitive values in logs.
8. **Language and copy:** English only (`en-GB`). UI copy follows [02 §17](02-experience.md).
   Before adding text, check whether a label or icon already says it.
9. **Verify before ticking:** `npm test`, `npm run typecheck`, `npm run lint`,
   `npm --prefix web run build`, the milestone's system scenario, and for UI changes a check
   in the browser through the Vite dev server (the Docker `web` container serves a stale
   build). Delete test data you create in the demo account afterwards.
10. **Report honestly.** If a check fails or was skipped, say so in the PR description.

## 5. New service scaffolding checklist

Every new service (trigger, today, delivery, connector, assistant, budget, health, people,
home, calendar) is created the same way:

- [ ] `services/<name>/package.json` (`@routine/<name>`, depends on `@routine/service-kit`),
      `tsconfig.json` (copy from task-service), `src/main.ts` using the chassis (logger, pool,
      `waitForDatabase`, `runMigrations`, `runKitMigrations`, broker, `createHttpServer` with
      readiness checks, `installAuth`, `onShutdown`)
- [ ] `services/<name>/migrations/001_init.sql`
- [ ] `services/<name>/test/` with at least contract tests
- [ ] database + role in `infra/postgres/domains-init.sql` (local) and its own Postgres
      service in `deploy/stack.yml`
- [ ] compose service: `<<: *node-service`, `build.args.SERVICE`, `deploy: *replicated`,
      common env, `DATABASE_URL`, `SERVICE_TOKEN_SECRET`, correct **profile**,
      `depends_on` broker + DB
- [ ] `deploy/stack.yml` entry with the v1 placement/update rules
- [ ] `.github/workflows/<name>.yml` calling `_node-service.yml`, path filters like the others
- [ ] gateway: upstream env, route prefix, probe in `/api/v1/system/status`
- [ ] service account (Keycloak client + `SERVICE_TOKEN_SECRET`, [identity-service.md §6](services/identity-service.md)) if it calls `/internal` endpoints
- [ ] queues in `definitions.json` if it consumes fixed platform queues. Domain action queues
      are declared by the kit
- [ ] topology component in the web (`components/topology.tsx`) knows the new node
- [ ] `docs/architecture.md` service table updated on `feat/v2-dev`

## 6. Definition of done (per work package)

- Behaviour matches the spec sections the package names.
- Tests at the layers that apply, all green.
- Contracts updated first, with contract tests.
- No new lint or type errors. `npm run build` in `web/` green.
- UI: axe clean on touched routes, keyboard reachable, copy rules followed.
- Docs: the spec is updated if the implementation made a decision the spec didn't.
- Checkbox ticked in the same commit.
