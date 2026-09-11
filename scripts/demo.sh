#!/usr/bin/env bash
# Routine – live demo & acceptance test.
#
#   scripts/demo.sh <scenario>
#
# Scenarios:
#   main         Haupt-Workflow (README §17): Routine erstellen → aktivieren → auslösen → abgeschlossen
#   retry        Retry-Verhalten (flaky Dienst) und permanenter Fehler
#   resilience   Resilienz-Workflow (README §18): Worker stoppen, Nachricht wartet, Worker starten
#   idempotency  Doppelte Nachrichten und doppelte API-Aufrufe werden sicher behandelt
#   scale        Horizontale Skalierung des integration-worker (1 → 4 Replikas)
#   schedule     Zeitbasierter Trigger (Cron)
#   evolution    Schema-Evolution mit Expand-and-Contract inkl. Breaking-Change-Demo
#   all          Alle Szenarien nacheinander (Abnahmetest)
#   trace <id>   Logs aller Services zu einer Correlation-/Execution-ID
#   status       Systemstatus (Services, Queues)
#
# Requirements on the host: docker compose, curl, jq.
set -euo pipefail
cd "$(dirname "$0")/.."

GATEWAY=${GATEWAY:-http://localhost:8080}
RABBIT=${RABBIT:-http://localhost:15672}
RABBIT_AUTH=${RABBIT_AUTH:-routine:routine}
EMAIL=${DEMO_EMAIL:-demo@routine.local}
PASSWORD=${DEMO_PASSWORD:-demo12345}
TOKEN=""

# ------------------------------------------------------------------ output helpers
bold=$'\033[1m'; cyan=$'\033[36m'; green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; dim=$'\033[2m'; reset=$'\033[0m'
title() { printf "\n%s%s══ %s ══%s\n" "$bold" "$cyan" "$*" "$reset"; }
step()  { printf "\n%s▶ %s%s\n" "$bold" "$*" "$reset"; }
info()  { printf "  %s\n" "$*"; }
note()  { printf "  %s%s%s\n" "$dim" "$*" "$reset"; }
ok()    { printf "  %s✔ %s%s\n" "$green" "$*" "$reset"; }
warn()  { printf "  %s! %s%s\n" "$yellow" "$*" "$reset"; }
fail()  { printf "  %s✘ %s%s\n" "$red" "$*" "$reset" >&2; exit 1; }

uuid() { uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || python3 -c 'import uuid; print(uuid.uuid4())'; }

# ------------------------------------------------------------------ API helpers
api() { # api METHOD PATH [JSON]
  local args=(-sS -X "$1" "$GATEWAY$2" -H "authorization: Bearer $TOKEN")
  [[ $# -ge 3 ]] && args+=(-H 'content-type: application/json' -d "$3")
  curl "${args[@]}"
}

login() {
  TOKEN=$(curl -sS -f "$GATEWAY/api/v1/auth/login" -H 'content-type: application/json' \
    -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" | jq -r .accessToken) \
    || fail "Login fehlgeschlagen – läuft das System? (docker compose up -d --wait)"
  [[ -n $TOKEN && $TOKEN != null ]] || fail "kein Token erhalten"
}

create_routine() { # create_routine JSON → prints id (routine is activated)
  local response id
  response=$(api POST /api/v1/routines "$1")
  id=$(jq -r '.id // empty' <<<"$response")
  [[ -n $id ]] || fail "Routine konnte nicht erstellt werden: $response"
  api POST "/api/v1/routines/$id/activate" >/dev/null
  echo "$id"
}

TRACE_FILE=$(mktemp); trap 'rm -f "$TRACE_FILE"' EXIT
trigger() { # trigger ROUTINE_ID [IDEMPOTENCY_KEY] → prints execution id
  local headers body
  headers=$(mktemp)
  body=$(curl -sS -D "$headers" -X POST "$GATEWAY/api/v1/routines/$1/executions" -H "authorization: Bearer $TOKEN" ${2:+-H "idempotency-key: $2"})
  grep -i '^x-trace-id:' "$headers" | tr -d '\r' | awk '{print $2}' >"$TRACE_FILE" || true
  rm -f "$headers"
  jq -r '.id // empty' <<<"$body" | grep . || fail "Auslösen fehlgeschlagen: $body"
}

execution() { api GET "/api/v1/executions/$1"; }

# wait_for EXECUTION_ID TIMEOUT_S STATUS... – prints status transitions, returns when a target status is reached
wait_for() {
  local id=$1 timeout=$2; shift 2
  local deadline=$((SECONDS + timeout)) last="" status
  printf "  Status: "
  while ((SECONDS < deadline)); do
    status=$(execution "$id" | jq -r .status)
    if [[ $status != "$last" ]]; then printf "%s%s%s " "$bold" "$status" "$reset"; last=$status; fi
    for target in "$@"; do [[ $status == "$target" ]] && { echo; return 0; }; done
    sleep 0.5
  done
  echo; fail "Timeout: Status ist $last, erwartet: $*"
}

show_actions() {
  execution "$1" | jq -r '.actions[] | "    \(.key | .[0:12] | . + (" " * (12 - length))) \(.status | . + (" " * (10 - length))) Versuche=\(.attempts)  \(.processedBy // "-")\(if .error then "  ⚠ " + .error else "" end)"'
}

show_log() {
  execution "$1" | jq -r '.log[] | "    \(.at[11:23])  \(.kind | . + (" " * (18 - length))) \(.actionKey // "" | . + (" " * (10 - length))) \(.message)"'
}

jaeger_hint() { [[ -s $TRACE_FILE ]] && note "Trace in Jaeger: http://localhost:16686/trace/$(cat "$TRACE_FILE")" || true; }

queue() { # queue NAME → "ready unacked consumers"
  curl -sS -u "$RABBIT_AUTH" "$RABBIT/api/queues/%2F/$1" | jq -r '"\(.messages_ready // 0) \(.messages_unacknowledged // 0) \(.consumers // 0)"'
}

rabbit_publish() { # rabbit_publish EXCHANGE ROUTING_KEY PAYLOAD_JSON
  curl -sS -u "$RABBIT_AUTH" -X POST "$RABBIT/api/exchanges/%2F/$1/publish" -H 'content-type: application/json' \
    -d "$(jq -nc --arg rk "$2" --arg p "$3" '{properties:{delivery_mode:2,content_type:"application/json"},routing_key:$rk,payload:$p,payload_encoding:"string"}')" |
    jq -r '.routed'
}

count() { api GET "$1" | jq '.items | length'; }

recreate() { # recreate SERVICE [ENV=VALUE...] – redeploys a single service with changed configuration
  local service=$1; shift
  note "deploy: ${*:-(Standardkonfiguration)} → $service"
  env "$@" docker compose up -d --no-deps --wait "$service" >/dev/null 2>&1 || fail "$service konnte nicht gestartet werden"
}

# ------------------------------------------------------------------ scenarios
scenario_main() {
  title "Haupt-Workflow (README §17)"
  login
  step "1. Benutzer erstellt Routine \"Weekly Review\""
  local routine rid eid
  routine=$(jq -nc '{
    name: "Weekly Review",
    description: "Wetter abrufen und Aufgabe erstellen (parallel), Zusammenfassung erzeugen, Benachrichtigung senden",
    trigger: {type: "manual"},
    actions: [
      {key: "weather", type: "weather.get",       step: 1, params: {city: "Zürich"}},
      {key: "task",    type: "task.create",       step: 1, params: {title: "Wochenrückblick schreiben", dueInDays: 2, priority: "high"}},
      {key: "summary", type: "summary.generate",  params: {title: "Weekly Review", sections: {Wetter: "{{actions.weather.summary}}", Aufgabe: "{{actions.task.title}} (fällig {{actions.task.dueDate}})"}}},
      {key: "notify",  type: "notification.send", params: {title: "Weekly Review bereit", body: "{{actions.summary.text}}"}}
    ]}')
  rid=$(create_routine "$routine")
  ok "Routine $rid erstellt (POST /api/v1/routines → 201)"
  step "2. Routine wird aktiviert"; ok "aktiv"
  step "3. Trigger startet Routine (POST …/executions → 202 Accepted)"
  eid=$(trigger "$rid")
  ok "Execution $eid"
  step "4.–8. Routine Service erstellt Execution, Worker verarbeiten Actions asynchron"
  wait_for "$eid" 60 COMPLETED FAILED
  show_actions "$eid"
  [[ $(execution "$eid" | jq -r .status) == COMPLETED ]] || fail "Execution nicht abgeschlossen"
  step "9. Routine wird als abgeschlossen angezeigt – Ablauf der Execution:"
  show_log "$eid"
  step "Ergebnisse in den autonomen Services"
  info "Aufgabe (task-service):        $(api GET /api/v1/tasks | jq -r '.items[0] | "\(.title) – fällig \(.dueDate)"')"
  info "Benachrichtigungen (notification-service):"
  api GET /api/v1/notifications | jq -r '.items[0:2][] | "    • [\(.category)] \(.title)"'
  jaeger_hint
  note "Logs aller Services: scripts/demo.sh trace $(execution "$eid" | jq -r .correlationId)"
  ok "Haupt-Workflow erfolgreich"
}

scenario_retry() {
  title "Retry-Verhalten"
  login
  step "Aktion ruft einen instabilen Dienst auf, der die ersten 2 Versuche mit 503 beantwortet"
  local rid eid attempts
  rid=$(create_routine "$(jq -nc '{name: "Flaky Webhook", trigger: {type: "manual"}, actions: [
      {key: "call", type: "http.request", params: {method: "POST", url: "http://mock-external:8090/flaky?failTimes=2", body: {ping: true}}},
      {key: "notify", type: "notification.send", params: {title: "Webhook nach {{actions.call.body.attempt}} Versuchen erfolgreich"}}]}')")
  eid=$(trigger "$rid")
  note "Backoff: 1 s → 5 s → 15 s (eigene Retry-Queues mit TTL + Dead-Lettering zurück in die Work-Queue)"
  wait_for "$eid" 60 COMPLETED FAILED
  show_actions "$eid"
  attempts=$(execution "$eid" | jq -r '.actions[] | select(.key=="call") | .attempts')
  [[ $(execution "$eid" | jq -r .status) == COMPLETED && $attempts -ge 3 ]] || fail "erwartet: COMPLETED nach 3 Versuchen"
  show_log "$eid" | grep -E "RETRY|WAITING|RUNNING|COMPLETED" || true
  ok "nach $attempts Versuchen erfolgreich – ohne erneuten Start durch den Benutzer"

  step "Permanenter Fehler (HTTP 404) wird nicht wiederholt"
  rid=$(create_routine "$(jq -nc '{name: "Broken Endpoint", trigger: {type: "manual"}, actions: [
      {key: "call", type: "http.request", params: {url: "http://mock-external:8090/status/404"}},
      {key: "notify", type: "notification.send", params: {title: "wird nie gesendet"}}]}')")
  eid=$(trigger "$rid")
  wait_for "$eid" 30 FAILED COMPLETED
  show_actions "$eid"
  [[ $(execution "$eid" | jq -r .status) == FAILED ]] || fail "erwartet: FAILED"
  info "Fehler: $(execution "$eid" | jq -r .error)"
  ok "sofort FAILED (1 Versuch), Folgeaktion SKIPPED, Benutzer wird benachrichtigt"
}

scenario_resilience() {
  title "Resilienz-Workflow (README §18)"
  login
  local rid other eid oid depth
  rid=$(create_routine "$(jq -nc '{name: "Morning Setup", trigger: {type: "manual"}, actions: [
      {key: "weather", type: "weather.get", params: {city: "Bern"}},
      {key: "notify", type: "notification.send", params: {title: "Guten Morgen", body: "{{actions.weather.summary}}"}}]}')")
  other=$(create_routine "$(jq -nc '{name: "Quick Task", trigger: {type: "manual"}, actions: [
      {key: "task", type: "task.create", params: {title: "Unabhängige Aufgabe"}}]}')")

  step "2. Worker Service stoppen (alle Replikas des integration-worker)"
  docker compose stop integration-worker >/dev/null 2>&1
  ok "integration-worker gestoppt"
  step "1./3. Routine starten – Action wird trotzdem veröffentlicht"
  eid=$(trigger "$rid")
  for _ in $(seq 1 20); do
    read -r depth _ consumers <<<"$(queue integration-worker.actions)"
    ((depth >= 1)) && break
    sleep 0.5
  done
  info "Queue integration-worker.actions: ${bold}$depth wartende Nachricht(en)${reset}, $consumers Consumer"
  [[ $depth -ge 1 ]] || fail "Nachricht nicht im Broker"
  ok "4. Nachricht wartet im Broker"
  step "5. Routine bzw. andere Services bleiben verfügbar"
  info "GET /api/v1/routines → HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$GATEWAY/api/v1/routines")"
  oid=$(trigger "$other")
  wait_for "$oid" 30 COMPLETED
  ok "andere Routine (task-service) wurde währenddessen abgeschlossen"
  info "Wartende Execution:"
  wait_for "$eid" 30 WAITING
  step "6. Worker Service starten"
  docker compose start integration-worker >/dev/null 2>&1
  ok "integration-worker gestartet"
  step "7./8. Nachricht wird verarbeitet, Execution wird abgeschlossen"
  wait_for "$eid" 60 COMPLETED
  show_log "$eid"
  ok "Keine Arbeit verloren, Benutzer musste die Routine nicht erneut starten"
}

scenario_idempotency() {
  title "Idempotenz"
  login
  local rid eid key first second action_id owner before after envelope
  step "a) Doppelter API-Aufruf mit gleichem Idempotency-Key"
  rid=$(create_routine "$(jq -nc '{name: "Idempotency Demo", trigger: {type: "manual"}, actions: [
      {key: "task", type: "task.create", params: {title: "Genau einmal erstellen"}}]}')")
  key=$(uuid)
  first=$(trigger "$rid" "$key"); second=$(trigger "$rid" "$key")
  info "1. Aufruf → $first"; info "2. Aufruf → $second"
  [[ $first == "$second" ]] || fail "zwei Executions erstellt"
  ok "gleiche Execution – der Client-Retry startet die Routine nicht zweimal"
  wait_for "$first" 30 COMPLETED

  step "b) Dieselbe ActionRequested-Nachricht wird zweimal zugestellt"
  action_id=$(execution "$first" | jq -r '.actions[0].id')
  owner=$(api GET /api/v1/auth/me | jq -r .id)
  before=$(count /api/v1/tasks)
  envelope=$(jq -nc --arg mid "$(uuid)" --arg aid "$action_id" --arg eid "$first" --arg rid "$rid" --arg owner "$owner" '{
    messageId: $mid, type: "ActionRequested", version: 1, occurredAt: (now | todate), source: "demo-script", correlationId: $eid,
    data: {actionId: $aid, executionId: $eid, routineId: $rid, ownerId: $owner, actionKey: "task", actionType: "task.create", params: {title: "Genau einmal erstellen"}}}')
  info "Delivery 1 → routed: $(rabbit_publish routine.actions action.task.create "$envelope")"
  info "Delivery 2 → routed: $(rabbit_publish routine.actions action.task.create "$envelope")"
  sleep 2
  after=$(count /api/v1/tasks)
  info "Aufgaben vorher: $before, nachher: $after"
  [[ $before == "$after" ]] || fail "Duplikat hat eine zusätzliche Aufgabe erzeugt"
  docker compose logs --no-log-prefix --since 30s task-service routine-service 2>/dev/null | grep "$action_id" | jq -r 'select(.msg | test("duplicate")) | "    \(.service): \(.msg)"' | head -4
  ok "Duplikate erkannt (actionId = Idempotenzschlüssel) → ignoriert, Ergebnis nur erneut gemeldet"
}

scenario_scale() {
  title "Horizontale Skalierung"
  login
  local actions rid eid start duration replicas
  actions=$(jq -nc '[range(1;17) | {key: "w\(.)", type: "weather.get", step: 1, params: {city: (["Zürich","Bern","Basel","Luzern","Chur","Lugano"][. % 6])}}]')
  rid=$(create_routine "$(jq -nc --argjson a "$actions" '{name: "Load Test", trigger: {type: "manual"}, actions: $a}')")
  for replicas in 1 4; do
    step "$replicas Worker-Replika(s) – 16 parallele Actions"
    docker compose up -d --no-deps --scale integration-worker="$replicas" --wait integration-worker >/dev/null 2>&1
    sleep 2
    start=$(date +%s)
    eid=$(trigger "$rid")
    wait_for "$eid" 90 COMPLETED
    duration=$(($(date +%s) - start))
    info "Dauer: ${bold}~${duration}s${reset} – Verteilung der Actions:"
    execution "$eid" | jq -r '[.actions[].processedBy] | group_by(.) | .[] | "    \(.[0]): \(length)"'
  done
  docker compose up -d --no-deps --scale integration-worker=2 --wait integration-worker >/dev/null 2>&1
  ok "Broker verteilt die Arbeit (competing consumers), Replikas brauchen keine spezielle Konfiguration"
}

scenario_schedule() {
  title "Zeitbasierter Trigger"
  login
  local rid n
  rid=$(create_routine "$(jq -nc '{name: "Every 15 Seconds", trigger: {type: "schedule", cron: "*/15 * * * * *", timezone: "Europe/Zurich"}, actions: [
      {key: "weather", type: "weather.get", params: {city: "Lugano"}}]}')")
  info "Cron */15 * * * * * – nächster Lauf: $(api GET "/api/v1/routines/$rid" | jq -r .nextRunAt)"
  note "warte auf zwei Ausführungen …"
  for _ in $(seq 1 45); do
    n=$(api GET "/api/v1/routines/$rid/executions" | jq '[.items[] | select(.trigger == "schedule")] | length')
    ((n >= 2)) && break
    sleep 1
  done
  api GET "/api/v1/routines/$rid/executions" | jq -r '.items[] | "    \(.scheduledFor)  \(.trigger)  \(.status)"'
  api POST "/api/v1/routines/$rid/deactivate" >/dev/null
  ((n >= 2)) || fail "Zeitplan hat nicht ausgelöst"
  ok "Scheduler hat die Routine ausgelöst (Routine wieder deaktiviert)"
}

evolution_run() { # evolution_run LABEL → triggers a routine, prints the resulting execution notification
  local eid
  eid=$(trigger "$EVOLUTION_ROUTINE")
  wait_for "$eid" 30 COMPLETED >/dev/null
  sleep 1.5
  api GET /api/v1/notifications | jq -r --arg eid "$eid" '[.items[] | select(.executionId == $eid and .category == "execution")][0] // empty | "    📨 \(.title)  \(if .body != "" then "– " + .body else "" end)"'
}

scenario_evolution() {
  title "Evolution einer Schnittstelle: ExecutionCompleted v1 → v2 (Expand and Contract)"
  login
  EVOLUTION_ROUTINE=$(create_routine "$(jq -nc '{name: "Evolution Demo", trigger: {type: "manual"}, actions: [{key: "t", type: "task.create", params: {title: "Evolution"}}]}')")
  local dlq out

  step "Ausgangslage – Producer sendet v1, Consumer versteht nur v1"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v1
  recreate notification-service COMPLETION_EVENT_READER=legacy
  out=$(evolution_run); echo "$out"; [[ -n $out ]] || fail "keine Benachrichtigung"

  step "Breaking Change (was ohne Expand-and-Contract passieren würde): Producer entfernt 'message' sofort"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v2
  out=$(evolution_run); [[ -z $out ]] || fail "Legacy-Consumer hätte v2 nicht verarbeiten dürfen"
  for _ in $(seq 1 20); do
    read -r dlq _ _ <<<"$(queue notification-service.execution-events.dlq)"
    ((dlq >= 1)) && break
    sleep 0.5
  done
  warn "Legacy-Consumer kann v2 nicht lesen → keine Benachrichtigung, Event liegt in der DLQ ($dlq Nachricht(en)) – nichts verloren"
  docker compose logs --no-log-prefix --since 20s notification-service 2>/dev/null | jq -r 'select(.level=="error") | "    \(.err)"' | tail -1

  step "Expand – Producer sendet alte UND neue Felder (nur routine-service neu deployt)"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=expand
  out=$(evolution_run); echo "$out"; [[ -n $out ]] || fail "Expand-Phase bricht alten Consumer"
  ok "alter Consumer funktioniert weiter"

  step "Consumer aktualisieren – tolerant reader liest v2 (nur notification-service neu deployt)"
  recreate notification-service COMPLETION_EVENT_READER=tolerant
  out=$(evolution_run); echo "$out"; [[ $out == *"abgeschlossen"* ]] || fail "neuer Consumer nutzt v2-Felder nicht"
  info "Event aus der DLQ erneut einspielen:"
  scripts/replay-dlq.sh notification-service.execution-events | sed 's/^/    /'

  step "Contract – alte Felder entfernen (Producer sendet nur noch v2)"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v2
  out=$(evolution_run); echo "$out"; [[ $out == *"abgeschlossen"* ]] || fail "v2 wird nicht verarbeitet"
  recreate routine-service; recreate notification-service
  ok "Schnittstelle weiterentwickelt – nie mussten Producer und Consumer gleichzeitig deployt werden"
}

scenario_trace() {
  local id=${1:?Correlation- oder Execution-ID angeben}
  title "Logs zu $id (alle Services)"
  docker compose logs --no-log-prefix 2>/dev/null | grep -F "$id" |
    jq -r '"\(.time[11:23])  \(.service | . + (" " * (21 - length))) \(.level | . + (" " * (5 - length))) \(.msg)\(if .actionId then "  action=" + .actionId[0:8] else "" end)\(if .processedBy then "  by=" + .processedBy else "" end)"' |
    sort
}

scenario_status() {
  login
  title "Systemstatus"
  api GET /api/v1/system/status | jq -r '
    (.services | to_entries[] | "  \(.key | . + (" " * (22 - length))) \(.value.status)\(if .value.instance then "  (" + .value.instance + ")" else "" end)"),
    "  broker                 \(.broker)",
    "",
    "  Queue                                        ready  unacked  consumers",
    (.queues[] | select(.name | test("retry") | not) | "  \(.name | . + (" " * (44 - length))) \(.ready | tostring | . + (" " * (6 - length))) \(.unacked | tostring | . + (" " * (8 - length))) \(.consumers)")'
}

case "${1:-}" in
  main) scenario_main ;;
  retry) scenario_retry ;;
  resilience) scenario_resilience ;;
  idempotency) scenario_idempotency ;;
  scale) scenario_scale ;;
  schedule) scenario_schedule ;;
  evolution) scenario_evolution ;;
  trace) scenario_trace "${2:-}" ;;
  status) scenario_status ;;
  all)
    scenario_main; scenario_retry; scenario_idempotency; scenario_resilience; scenario_scale; scenario_schedule; scenario_evolution
    title "Alle Szenarien erfolgreich"
    ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
