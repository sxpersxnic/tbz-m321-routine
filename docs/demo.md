# Live demo and evidence for the success criteria

## Preparation

```bash
docker compose up -d --build --wait    # whole system (16 containers)
scripts/demo.sh status                  # everything "up"?
```

Tabs to keep open: **UI** <http://localhost:8080> (demo@routine.local / demo12345) ·
**RabbitMQ** <http://localhost:15672> (routine / routine) · **Jaeger** <http://localhost:16686>

Every scenario can be shown in the terminal (`scripts/demo.sh <scenario>`) or in the UI.
`scripts/demo.sh all` runs all scenarios as an automated acceptance test.

## Scenarios

| Scenario | Command | What you see |
| --- | --- | --- |
| Main workflow (§17) | `scripts/demo.sh main` | Routine "Weekly Review": weather + task in parallel, summary, notification; `PENDING → RUNNING → COMPLETED`; which worker processed what; Jaeger link |
| Retry | `scripts/demo.sh retry` | External service answers 503 twice → retries after 1 s and 5 s, execution `WAITING`, then `COMPLETED`. HTTP 404 → `FAILED` immediately, follow-up action `SKIPPED` |
| Resilience (§18) | `scripts/demo.sh resilience` | integration-worker stopped → message waits in the queue (0 consumers), the API and other routines keep working, execution `WAITING`; start the worker → `COMPLETED` |
| Idempotency | `scripts/demo.sh idempotency` | Same `Idempotency-Key` → same execution. The same `ActionRequested` sent to the broker twice → only one task, logs say "duplicate … ignored" |
| Scaling | `scripts/demo.sh scale` | 16 parallel actions with 1 vs. 4 worker replicas; duration and distribution per instance |
| Schedule | `scripts/demo.sh schedule` | Cron `*/15 * * * * *` fires twice |
| Webhook | `scripts/demo.sh webhook` | An external `curl` without a user token starts a routine; the JSON body becomes step input; a retry with the same `Idempotency-Key` returns the same run; after rotating the URL the old one answers 404 |
| Evolution | `scripts/demo.sh evolution` | ExecutionCompleted v1 → expand → consumer update → v2; the breaking change lands in the DLQ and is replayed after the fix |
| Tracing | `scripts/demo.sh trace <correlationId>` | Logs of all services for one execution, sorted by time |

### Manually in the UI (for the presentation)

1. **Routines → New routine**: pick the "Weekly Review" template – the preview on the right shows the flow (step 1 runs in parallel),
   and references such as `{{actions.weather.summary}}` can be inserted with a click. Press *Create*.
2. **Run now** → the run page shows live progress, the result, and each step. *Under the hood* shows the status history,
   the event log, the worker instances and "Open in Jaeger". Clicking a step shows its resolved input and output.
3. **Infrastructure** shows the live topology. For the resilience demo, run `docker compose stop integration-worker` in the terminal
   and start a routine → the edge to the worker turns red (0 consumers), 1 message waits, and after 10 s the run becomes `WAITING`;
   `docker compose start integration-worker` → the edge turns green, the run becomes `COMPLETED`.
4. The "Load Test" template together with `docker compose up -d --scale integration-worker=4` shows the distribution across replicas
   (run page → Under the hood → worker instances). "Flaky Webhook" shows retries, "Broken Endpoint" a permanent error.
5. The "Webhook Inbox" template shows an external trigger: *Try it* sends a test event through the routine's own URL.
   The routine page shows the URL; *Technical details* has a ready-to-paste `curl` command, and *Run again* on a run
   replays the same webhook data.

### Chaos switches (optional)

| Variable | Effect |
| --- | --- |
| `CHAOS_DUPLICATE_PUBLISH_RATE=0.5` | The outbox relay publishes every second message twice → idempotency under load |
| `INTEGRATION_CHAOS_FAILURE_RATE=0.3` (likewise `TASK_…`, `NOTIFICATION_…`) | 30 % of processing attempts fail transiently → retries |
| `WAITING_AFTER_MS` | How long an unanswered action waits before the execution is set to `WAITING` (default 10 s) |

Example: `CHAOS_DUPLICATE_PUBLISH_RATE=0.5 docker compose up -d routine-service`

## Success criteria (README §20)

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | ≥ 3 autonomous services communicate | 5 platform services + gateway (`compose.yaml`); `main` uses the routine, task, integration and notification services |
| 2 | synchronous **and** asynchronous | REST through the gateway (`contracts/openapi`) · commands/events through RabbitMQ (`contracts/asyncapi`) |
| 3 | data managed independently | a separate PostgreSQL container with its own credentials per service (`identity-db`, `routine-db`, …); separate migrations per service (`services/*/migrations`) |
| 4 | events through a message broker | exchanges `routine.actions`, `routine.action-results`, `routine.events` (`infra/rabbitmq/definitions.json`) |
| 5 | duplicate messages handled safely | `idempotency`; unique constraints / claim table; tests in `services/*/test` |
| 6 | worker scales horizontally | `scale`; `docker compose up -d --scale integration-worker=5` |
| 7 | a failed consumer loses nothing | `resilience`; durable quorum queues, manual ack, outbox |
| 8 | a run is traceable across services | correlation ID in all logs (`trace`), one Jaeger trace across all services, execution log in the UI |
| 9 | interface evolved without simultaneous deployment | `evolution`; each phase redeploys exactly one service |
| 10 | one defined start command | `docker compose up -d --build --wait` |
