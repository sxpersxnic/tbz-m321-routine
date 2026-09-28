# M7 – Health, People, Home

**Goal:** three lighter domains on the proven contract, plus the cross-domain templates that
make them worth having. Same rule as M6: no platform changes. Each domain is independent, so
three agents can build them in parallel.

**You'll see:** the Health, People and Home pages ([02 §11](../02-experience.md)) · check-ins
on Today · *Birthday*, *Low-energy day*, *Keep in touch*, *Chore rotation* templates · ⌘K
*"sleep 4"*, *"called Mum"*, *"buy milk"*.

**Specs:** [services/health-service.md](../services/health-service.md) · [services/people-service.md](../services/people-service.md) ·
[services/home-service.md](../services/home-service.md)

---

### Health

- [ ] **M7-01 · Scaffold health-service** ([10-quality.md §5](../10-quality.md), profile `domains`)
- [ ] **M7-02 · Metrics, entries, overview API, seed metrics, quick entry**
- [ ] **M7-03 · Manifest, `health.checkIn` human step, events, check-in cards**
- [ ] **M7-04 · Web: Health page** (metric cards with sparkline, log dialog, metric editor, habits section)

### People

- [ ] **M7-05 · Scaffold people-service**
- [ ] **M7-06 · Persons, interactions, overview API, quick entry, reminder jobs**
- [ ] **M7-07 · Manifest, events, Today cards**
- [ ] **M7-08 · Web: People list and person page**

### Home

- [ ] **M7-09 · Scaffold home-service**
- [ ] **M7-10 · Shopping, chores, supplies API, quick entry, jobs**
- [ ] **M7-11 · Manifest, events, Today cards**
- [ ] **M7-12 · Web: Home page**

### Together

- [ ] **M7-13 · Cross-domain templates** in routine-service (data only): *Birthday*,
  *Low-energy day*, *Keep in touch*, *Chore rotation* ([services/routine-service.md §5](../services/routine-service.md)).
  Each instantiates, validates and runs in a system test.

**Milestone done when:** each domain's conformance checklist is ticked and the *Low-energy
day* and *Birthday* scenarios of [01-vision.md §6](../01-vision.md) run end to end.
