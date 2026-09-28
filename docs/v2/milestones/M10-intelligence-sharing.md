# M10 – Intelligence & sharing

**Goal:** AI where it earns its place (a step that summarises, rewrites and extracts, and a
drafting assistant that turns a sentence into a routine), plus sharing routines by link or
file.

**You'll see:** *Summarise* / *Rewrite* / *Extract* steps · *Describe your routine* in the New
routine screen · *Share* in the routine menu · `#/shared/<token>` with *Add to my routines* and
setup questions.

**Specs:** [services/assistant-service.md](../services/assistant-service.md) ·
[services/routine-service.md §7](../services/routine-service.md) · ADR-14

---

- [ ] **M10-01 · Scaffold assistant-service** ([10-quality.md §5](../10-quality.md), profile `ai`; `ANTHROPIC_API_KEY` Swarm secret; `AI_PROVIDER=mock` by default in compose)
- [ ] **M10-02 · Settings, ledger, allowance check, mock provider**
- [ ] **M10-03 · AI step capabilities** (`ai.summarize`, `ai.rewrite`, `ai.extract` via `@anthropic-ai/sdk`, refusal handling, fallbacks, limits)
- [ ] **M10-04 · Draft a routine** (catalog prompt with caching, `messages.parse` + `zodOutputFormat`, validate via routine-service, one repair round)
- [ ] **M10-05 · Web: Settings → AI, *Describe your routine* box in `#/routines/new` → opens the editor with the draft and any issues**
- [ ] **M10-06 · Export and import API** (sanitising rules, preview, setup questions reuse template instantiation)
- [ ] **M10-07 · Share links** (`routine_shares`, public `GET /api/v1/shared/:token`, revoke)
- [ ] **M10-08 · Web: Share dialog (link + download file), `#/shared/:token` page, *Import from file* on the Routines page**

**Milestone done when:** with the mock provider, the full flow runs in CI. With a real key
(manual check), *"Every Friday at 4, remind me to log my hours and e-mail my manager a summary"*
produces a valid draft. A shared routine imported by a second user asks for its list and
connection, and runs.
