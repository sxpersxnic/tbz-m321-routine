# assistant-service (new, M10) · domain `ai`

## 1. Responsibility

Everything that calls a language model: the **AI step** (summarise, rewrite, extract) and
**drafting a routine from a description**. It owns the token ledger that enforces each user's
monthly allowance. It is the only service with the model API key.

## 2. Data (`assistant-db`)

```sql
CREATE TABLE usage_ledger (
  id bigserial PRIMARY KEY, owner_id uuid NOT NULL, month date NOT NULL,   -- first day of month
  purpose text NOT NULL,                                                   -- step | draft
  input_tokens integer NOT NULL, output_tokens integer NOT NULL,
  cache_read_tokens integer NOT NULL DEFAULT 0, action_id uuid UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_owner_month_idx ON usage_ledger (owner_id, month);
CREATE TABLE settings (owner_id uuid PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
  monthly_token_allowance integer NOT NULL DEFAULT 200000);
-- + processed_actions, outbox (domain kit)
```

## 3. HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET/PUT /api/v1/assistant/settings` | on/off (opt-in), shows `usedThisMonth`, `allowance` |
| `POST /api/v1/assistant/draft-routine` | `{ description }` (≤ 2,000 chars) → `{ draft: RoutineInput, explanation, issues }`. Never saves. The editor opens the draft. |

## 5. Manifest (`ai`, `optional: true`)

| Type | Kind | Params | Output |
| --- | --- | --- | --- |
| `ai.summarize` | value | `text`* (longText), `style` (choice: bullets, paragraph, oneLine), `maxWords` | `text` |
| `ai.rewrite` | value | `text`*, `instruction`* (e.g. "friendlier", "in German") | `text` |
| `ai.extract` | value | `text`*, `fields`* (list of `{ name, description }`, ≤ 10) | one output field per requested name, plus `raw` |

They are `value`s (no side effects outside the ledger), so they work in test runs, and the
test-run ledger entries count against the allowance.

## 6. Model usage

- SDK: `@anthropic-ai/sdk`. Model from `AI_MODEL`, default **`claude-opus-5`**. Adaptive thinking
  is the model's default. Effort from `AI_EFFORT` (unset = API default).
- **Refusals:** check `stop_reason === 'refusal'` before reading content → fail the step with
  `AI_REFUSED`. Server-side fallbacks are enabled by default (`fallbacks: "default"` with beta
  `server-side-fallback-2026-07-01`, via `client.beta.messages`).
- **Structured output for drafts:** `client.messages.parse` with
  `output_config: { format: zodOutputFormat(DraftSchema) }` (package `zod`,
  `@anthropic-ai/sdk/helpers/zod`). `DraftSchema` mirrors `RoutineInput`. The parsed draft is
  **always** sent to routine-service `POST /api/v1/routines/validate` (with the user's token
  forwarded). If issues come back, one repair round sends the issues back to the model. The
  remaining issues are returned to the editor, which shows them like normal validation errors.
- **Prompt caching:** the system prompt = fixed instructions + the user's **enabled catalog**
  (capabilities, params, outputs, triggers) serialised deterministically (domains and
  capabilities sorted by id, keys sorted) with `cache_control: { type: 'ephemeral' }` on that
  block. The description goes in the user message, after the breakpoint. Verify with
  `usage.cache_read_input_tokens`.
- **Limits:** AI-step input > 50,000 characters → fail with `INPUT_TOO_LARGE` (never silently
  truncate). `max_tokens`: 4,000 for steps, 16,000 for drafts. Before each call, the allowance
  check: `SUM(input+output)` for the month ≥ allowance → `QUOTA_EXCEEDED`. After each call, write
  the ledger row (`action_id` unique = idempotent on redelivery).
- **Idempotency:** a redelivered `ActionRequested` for an action already in
  `processed_actions` re-sends the stored output without calling the model again.
- **Privacy:** the settings page states that step inputs are sent to Anthropic's API. The
  service never logs prompts or outputs (ids and token counts only).
- **Mock provider:** `AI_PROVIDER=mock` returns deterministic outputs (summaries = first N
  words, drafts from a fixed table of example descriptions) for CI, demos and offline work.

## 8. Configuration

`AI_PROVIDER` (`anthropic` or `mock`), `ANTHROPIC_API_KEY` (Swarm secret), `AI_MODEL`,
`AI_EFFORT`, `ROUTINE_URL`.

## 10. Tests

With the mock provider: allowance enforcement, `INPUT_TOO_LARGE`, redelivery doesn't call the
provider twice, drafts go through validation. One opt-in live smoke test
(`AI_LIVE_TEST=1`) that is never run in CI.
