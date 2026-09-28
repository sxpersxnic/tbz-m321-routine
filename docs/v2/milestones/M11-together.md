# M11 – Together

**Goal:** households and small teams share a workspace: routines, lists, budget and
everything else, with roles. Personal workspaces keep working exactly as before.

**You'll see:** a workspace switcher in the sidebar header · *Invite* in Settings ·
viewer-only screens without edit controls.

**Specs:** [services/identity-service.md §5](../services/identity-service.md) · ADR-13

---

- [ ] **M11-01 · Workspaces and memberships in identity-service** (tables, create, invite by e-mail of an existing user, remove, leave)
- [ ] **M11-02 · Tokens with `ws` and `wsRole`, `POST /auth/switch-workspace`**
- [ ] **M11-03 · service-kit `requireActor`** (`ownerId = ws ?? sub`) and `requireWriter` (rejects viewers)
- [ ] **M11-04 · Adopt `requireActor` service by service** (one package per service: routine, task, notification, today, delivery, connector, assistant, budget, health, people, home, calendar, trigger). Mechanical replacement of `user.id` scoping by `ownerId`. Writes guarded by `requireWriter`.
- [ ] **M11-05 · Events carry `actorId`** (additive field in every domain event emitted from HTTP handlers)
- [ ] **M11-06 · Web: workspace switcher, invite dialog, members list, viewer mode (hide write controls based on `wsRole`)**
- [ ] **M11-07 · Push and digest per workspace member** (delivery-service fans out `notification.created` of a shared workspace to all members' subscriptions, respecting each member's preferences)

**Milestone done when:** two users share a *Flat* workspace: a chore completed by one appears
done for the other, a shared *Monthly bills* routine runs once (not per member), and a viewer
can't change anything (API `403` and hidden controls).
