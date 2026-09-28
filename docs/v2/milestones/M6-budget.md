# M6 – Budget

**Goal:** the first domain built entirely on the platform, and the proof that the contract
holds. **No change to routine-service, web core (outside `web/src/domains/budget/`,
navigation data and card renderers) or `definitions.json` may be needed.** If one is, stop,
fix the platform in a separate package, and note it in the milestone file.

**You'll see:** the Budget page ([02 §10](../02-experience.md)) · ⌘K *"14.50 lunch"* · camt.053
import · Budget steps and triggers in the editor · the *Payday* and *Month-end check* templates
· budget cards on Today.

**Specs:** [services/budget-service.md](../services/budget-service.md) · [04-domain-platform.md §7](../04-domain-platform.md)

---

- [ ] **M6-01 · Scaffold budget-service** ([10-quality.md §5](../10-quality.md) checklist, profile `domains`)
- [ ] **M6-02 · Schema and seed categories** (migration, default categories on first `GET`)
- [ ] **M6-03 · Accounts, categories, plan, budgets API**
- [ ] **M6-04 · Transactions API + quick entry** (+ `contracts/fixtures/quick-entry-budget.json`)
- [ ] **M6-05 · Imports: CSV with column mapping, camt.053, preview, dedupe, confirm**
  - Fixtures: a CSV from two Swiss banks' export layouts, one anonymised camt.053 file.
- [ ] **M6-06 · Bills and goals API + daily jobs** (bill due events, month start, roll-over)
- [ ] **M6-07 · Rules and auto-categorisation**
- [ ] **M6-08 · Manifest, handlers, events, thresholds**
  - Every capability of [services/budget-service.md §5](../services/budget-service.md), `preview` on
    `recordTransaction`, events through the outbox, `thresholds_emitted`.
  - Conformance tests ([04 §7](../04-domain-platform.md)).
- [ ] **M6-09 · Today cards + resync**
- [ ] **M6-10 · Web: Budget overview page** (`web/src/domains/budget/`, lazy route)
- [ ] **M6-11 · Web: transactions, plan, accounts, bills, goals pages**
- [ ] **M6-12 · Web: import flow** (drop zone, preview table, mapping for CSV, confirm, result)
- [ ] **M6-13 · Templates**
  - Manifest templates *Budget watch*, *Month start*. Cross-domain templates in routine-service:
    *Payday*, *Month-end check*, *Subscription watch* (the only routine-service change allowed:
    template data, not code).

**Milestone done when:** the conformance checklist is fully ticked, the *Payday* scenario of
[01-vision.md §6](../01-vision.md) runs from a camt.053 import to the goal update, and the
budget service can be stopped for a minute during that scenario without losing or doubling
anything.
