# Live-Demo & Nachweis der Erfolgskriterien

## Vorbereitung

```bash
docker compose up -d --build --wait    # ganzes System (15 Container)
scripts/demo.sh status                  # alles "up"?
```

Offene Tabs: **UI** <http://localhost:8080> (demo@routine.local / demo12345) ·
**RabbitMQ** <http://localhost:15672> (routine / routine) · **Jaeger** <http://localhost:16686>

Jedes Szenario kann im Terminal (`scripts/demo.sh <szenario>`) oder im UI gezeigt werden.
`scripts/demo.sh all` führt alle Szenarien als automatischen Abnahmetest aus.

## Szenarien

| Szenario | Befehl | Was man sieht |
| --- | --- | --- |
| Haupt-Workflow (§17) | `scripts/demo.sh main` | Routine „Weekly Review“: Wetter + Aufgabe parallel, Zusammenfassung, Benachrichtigung; `PENDING → RUNNING → COMPLETED`; welcher Worker was verarbeitet hat; Jaeger-Link |
| Retry | `scripts/demo.sh retry` | Externer Dienst antwortet 2× mit 503 → Retry nach 1 s und 5 s, Execution `WAITING`, dann `COMPLETED`. HTTP 404 → sofort `FAILED`, Folgeaktion `SKIPPED` |
| Resilienz (§18) | `scripts/demo.sh resilience` | integration-worker gestoppt → Nachricht wartet in der Queue (0 Consumer), API und andere Routinen laufen weiter, Execution `WAITING`; Worker starten → `COMPLETED` |
| Idempotenz | `scripts/demo.sh idempotency` | Gleicher `Idempotency-Key` → gleiche Execution. Dieselbe `ActionRequested` zweimal in den Broker → nur eine Aufgabe, Logs „duplicate … ignored“ |
| Skalierung | `scripts/demo.sh scale` | 16 parallele Actions mit 1 vs. 4 Worker-Replikas; Dauer und Verteilung pro Instanz |
| Zeitplan | `scripts/demo.sh schedule` | Cron `*/15 * * * * *` löst zweimal aus |
| Evolution | `scripts/demo.sh evolution` | ExecutionCompleted v1 → expand → Consumer-Update → v2; Breaking Change landet in DLQ und wird nach dem Fix erneut eingespielt |
| Tracing | `scripts/demo.sh trace <correlationId>` | Logs aller Services zu einer Ausführung, zeitlich sortiert |

### Manuell im UI (für die Präsentation)

1. **Routinen** → Vorlage „Weekly Review“ → *Erstellen & aktivieren* → *Jetzt ausführen*.
2. **Ausführungen** zeigt Status-Pipeline, Aktionen (inkl. `verarbeitet von`) und Verlauf live.
3. **System** zeigt Services und Queue-Tiefen. Für die Resilienz-Demo im Terminal
   `docker compose stop integration-worker`, Routine ausführen → Queue `integration-worker.actions` zeigt
   wartende Nachricht und 0 Consumer, Execution wird `WAITING`; `docker compose start integration-worker` → `COMPLETED`.
4. Vorlage „Flaky Webhook (Retry)“ zeigt Retries, „Fehlerhafter Endpunkt“ einen permanenten Fehler.

### Chaos-Schalter (optional)

| Variable | Wirkung |
| --- | --- |
| `CHAOS_DUPLICATE_PUBLISH_RATE=0.5` | Outbox-Relay publiziert jede zweite Nachricht doppelt → Idempotenz unter Last |
| `INTEGRATION_CHAOS_FAILURE_RATE=0.3` (analog `TASK_…`, `NOTIFICATION_…`) | 30 % der Verarbeitungen scheitern transient → Retries |
| `WAITING_AFTER_MS` | Ab wann eine unbeantwortete Action die Execution auf `WAITING` setzt (Standard 10 s) |

Beispiel: `CHAOS_DUPLICATE_PUBLISH_RATE=0.5 docker compose up -d routine-service`

## Erfolgskriterien (README §20)

| # | Kriterium | Nachweis |
| --- | --- | --- |
| 1 | ≥ 3 autonome Services kommunizieren | 5 Plattform-Services + Gateway (`compose.yaml`); `main` nutzt routine-, task-, integration- und notification-service |
| 2 | synchron **und** asynchron | REST über Gateway (`contracts/openapi`) · Commands/Events über RabbitMQ (`contracts/asyncapi`) |
| 3 | Daten unabhängig verwaltet | eigener PostgreSQL-Container mit eigenen Zugangsdaten pro Service (`identity-db`, `routine-db`, …); eigene Migrationen je Service (`services/*/migrations`) |
| 4 | Events über Message Broker | Exchanges `routine.actions`, `routine.action-results`, `routine.events` (`infra/rabbitmq/definitions.json`) |
| 5 | doppelte Nachrichten sicher | `idempotency`; Unique-Constraints/Claim-Tabelle; Tests in `services/*/test` |
| 6 | Worker horizontal skalierbar | `scale`; `docker compose up -d --scale integration-worker=5` |
| 7 | ausgefallener Consumer verliert nichts | `resilience`; durable Quorum Queues, manuelles Ack, Outbox |
| 8 | Ausführung über Services nachvollziehbar | Correlation-ID in allen Logs (`trace`), ein Jaeger-Trace über alle Services, Execution-Verlauf im UI |
| 9 | Schnittstelle ohne gleichzeitiges Deployment weiterentwickelt | `evolution`; pro Phase wird genau ein Service neu deployt |
| 10 | ein definierter Startvorgang | `docker compose up -d --build --wait` |
