# M8 – Presence

**Goal:** Routine reaches people outside the open tab, calmly. Push with answer buttons,
an e-mail digest, chat for important things, quiet hours, an installable app, and a weekly
summary.

**You'll see:** a push *"Morning routine · 5 steps"* · a question answered from the lock
screen · *Install Routine* in the browser · Settings → Delivery · *Your week*.

**Specs:** [services/delivery-service.md](../services/delivery-service.md) · [07-web.md §9](../07-web.md) ·
[02-experience.md §14, §15](../02-experience.md) (*Your week*)

---

- [ ] **M8-01 · Scaffold delivery-service** ([10-quality.md §5](../10-quality.md), profile `presence`). VAPID keys
  generated once (`npx web-push generate-vapid-keys`), stored as env/Swarm secrets.
- [ ] **M8-02 · Preferences and push subscriptions API**
- [ ] **M8-03 · Routing: consume `notification.created` / `ExecutionWaitingForYou`, rules, quiet hours, deliveries table, channel queues**
- [ ] **M8-04 · Push channel** (`web-push`, `410` cleanup, payload with actions for questions)
- [ ] **M8-05 · E-mail digest channel + job** (mock-external mail in dev)
- [ ] **M8-06 · Chat channel** (Slack/Teams-compatible incoming webhook JSON `{ text }`, mock-external `/chat/:name` endpoint for dev). Until M9 ships connector-service, the webhook URL is stored in `preferences.chat_webhook_url` (encrypted with a delivery-local key). M9-05 migrates it to a connection.
- [ ] **M8-07 · Web: PWA** (manifest, icons, hand-written `sw.js`, offline shell)
- [ ] **M8-08 · Web: push opt-in and answer deep link** (`#/notifications?id=&answer=`)
- [ ] **M8-09 · Web: Settings → Delivery**
- [ ] **M8-10 · Your week** (`#/week`, computed client-side from existing APIs: tasks done per area,
  budget month summary when enabled, habit strips, run stats). The *Weekly review* template gains
  an `email.send` step with a `summary.generate` body of the same numbers.

**Milestone done when:** with the chat mock stopped, push and e-mail still arrive (and chat
catches up after restart, since it has its own queue). A question answered from a push
notification completes the run.
