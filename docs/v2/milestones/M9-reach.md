# M9 – Reach

**Goal:** routines reach further and schedule smarter. Secrets live in a vault, calendars show
up on Today, routines post to chat and read feeds, the weather is real, and schedules know
about sunsets, holidays and holidays of your own (vacation mode).

**You'll see:** Settings → Connections · meetings on Today and *"30 min before 'Interview'"*
triggers · *Post to chat* and *Get latest from feed* steps · *At sunset in Bern* · *Skip public
holidays* · *Skip next run* / *Pause until* on routines · *Pause all routines until…*

**Specs:** [services/connector-service.md](../services/connector-service.md) · [services/calendar-service.md](../services/calendar-service.md) ·
[services/integration-worker.md](../services/integration-worker.md) · [06-engine.md §8](../06-engine.md)

---

- [ ] **M9-01 · Scaffold connector-service** ([10-quality.md §5](../10-quality.md), default profile; master key as Swarm secret)
- [ ] **M9-02 · Connections API, encryption, key rotation, resolve endpoint, access log**
- [ ] **M9-03 · Secrets in the engine and worker**
  - Template root `secrets` passthrough ([06 §3](../06-engine.md)), validation against
    `acceptsSecrets`, worker resolution + output scrubbing + log-capture test.
- [ ] **M9-04 · Web: Settings → Connections; `{{secrets.x}}` pill picker in allowed params**
- [ ] **M9-05 · Chat and feed capabilities** (`chat.post`, `feed.latest`). Migrate delivery-service's chat
  URL (M8-06) into a connection.
- [ ] **M9-06 · Real weather provider** (`WEATHER_PROVIDER=open-meteo`)
- [ ] **M9-07 · Scaffold calendar-service** (profile `domains`)
- [ ] **M9-08 · Calendar sync, soon/day jobs, events, values, Today cards**
- [ ] **M9-09 · Web: calendars in Settings → Connections (ICS link), event cards already render via M5**
- [ ] **M9-10 · Scheduling: holidays, odd/even weeks, sun trigger** ([06 §8](../06-engine.md), `date-holidays`, `suncalc`)
- [ ] **M9-11 · Skip next run, pause until, vacation mode** (`routine_skips`, profile `paused_until` via projection)
- [ ] **M9-12 · Web: sun trigger UI, schedule extras, routine menu items, vacation switch in Profile**

**Milestone done when:** an `http.request` with `{{secrets.token}}` works and the token appears
nowhere in logs, run records or the UI. A calendar event triggers a routine 30 minutes before it
starts. A routine scheduled on a public holiday is skipped with a visible note.
