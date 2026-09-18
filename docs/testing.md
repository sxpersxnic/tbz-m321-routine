# Testing manually on your machine

Everything runs locally with Docker. No external accounts or services are needed.

## 1. Start the system

```bash
docker compose up -d --build --wait    # all 16 containers, waits until healthy
scripts/demo.sh status                 # every service "up"?
```

| What | Where | Login |
| --- | --- | --- |
| Web UI and API | <http://localhost:8080> | `demo@routine.local` / `demo12345` (or **Try the demo**) |
| RabbitMQ management | <http://localhost:15672> | `routine` / `routine` |
| Jaeger (traces) | <http://localhost:16686> | – |
| Mock external APIs | <http://localhost:8090> | – |

After changing service code, rebuild just that service: `docker compose up -d --build --wait routine-service`.

## 2. Work on the UI with hot reload

The `web` container serves a production build, so UI changes only appear there after a rebuild.
For UI work, run the dev server instead. It forwards `/api` to the running gateway:

```bash
npm --prefix web install
npm --prefix web run dev                       # http://localhost:5173
PORT=5391 npm --prefix web run dev             # if 5173 is taken
GATEWAY_URL=http://other-host:8080 npm --prefix web run dev
```

Use your own accounts for experiments: register with any address ending in `@test.local`,
and remove all of them (with their data) afterwards with `scripts/cleanup-test-users.sh`.

## 3. Try each kind of trigger

| Trigger | In the UI | In the terminal |
| --- | --- | --- |
| Manual | Routine page → **Run now** | `scripts/demo.sh main` |
| Schedule | Editor → **Schedule** → e.g. *Interval* every 15 seconds | `scripts/demo.sh schedule` |
| Webhook | Routine page → **Send test** (edit the JSON, then **Send**) | `scripts/demo.sh hook "<routine name or ID>" '{"hello":"world"}'` |

### Webhooks step by step

1. **Routines → Templates → Webhook Inbox → Try it**. This creates the routine and sends a test event through its own URL.
2. The routine page shows the URL. **Technical details** has a ready-to-copy `curl` command:

   ```bash
   curl -X POST http://localhost:8080/api/v1/hooks/<token> \
     -H 'content-type: application/json' \
     -H "idempotency-key: $(uuidgen)" \
     -d '{"release":{"version":"2.4.0"},"author":"me"}'
   ```

   No login is needed: the token in the path is the credential.
3. Use the fields in any step as `{{trigger.body.release.version}}`. The whole body is `{{trigger.body}}`
   (the **Webhook data** chip in the editor).
4. On a run page, **Under the hood → Webhook data** shows what was received, and **Run again** replays it.
5. Things worth trying:
   * Send the same `idempotency-key` twice → the same run comes back, no second run.
   * Pause the routine → `409`. Unknown token → `404`. A JSON array or a body over 64 KiB → `400` / `413`.
   * **Edit → Create new URL** → the old URL answers `404` immediately.

`scripts/demo.sh webhook` runs all of these checks automatically.

## 4. Look behind the scenes

| Question | How to see it |
| --- | --- |
| What did a *Call webhook* step send? | `curl http://localhost:8090/webhooks/demo` lists everything `mock-external` received under `/webhooks/demo` |
| Which service did what? | Run page → **Under the hood**, or `scripts/demo.sh trace <correlation ID>` |
| One trace across all services | Run page → **Open in Jaeger** |
| Are messages waiting? | **Infrastructure** page, or the queues in RabbitMQ management |
| What happens when a worker is down? | `docker compose stop integration-worker`, start a routine, watch **Infrastructure**, then `docker compose start integration-worker` |
| Retries and permanent errors | Templates **Flaky Webhook** and **Broken Endpoint** |
| Load across replicas | `docker compose up -d --scale integration-worker=4`, then template **Load Test** |

The chaos switches in [demo.md](demo.md#chaos-switches-optional) inject duplicate messages and random failures.

## 5. Automated checks

```bash
npm test                   # unit and contract tests
npm run typecheck          # services + web client
npm --prefix web run build # production build of the UI
scripts/demo.sh all        # every scenario end to end against the running system
```

## 6. Reset

```bash
docker compose down -v     # stop and delete all data (the demo user is created again on the next start)
```
