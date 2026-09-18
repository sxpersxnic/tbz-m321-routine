#!/usr/bin/env bash
# Routine – live demo & acceptance test.
#
#   scripts/demo.sh <scenario>
#
# Scenarios:
#   main         Main workflow (README §17): create routine → activate → trigger → completed
#   retry        Retry behaviour (flaky service) and a permanent error
#   resilience   Resilience workflow (README §18): stop worker, message waits, start worker
#   idempotency  Duplicate messages and duplicate API calls are handled safely
#   scale        Horizontal scaling of the integration-worker (1 → 4 replicas)
#   schedule     Time-based trigger (cron)
#   webhook      External event: a public webhook URL starts a routine (idempotent, rotatable)
#   evolution    Schema evolution with expand-and-contract, including a breaking-change demo
#   all          All scenarios in sequence (acceptance test)
#   trace <id>   Logs of all services for a correlation or execution ID
#   hook <routine> [json]  Call a webhook routine by ID or name, then follow the run (manual testing)
#   status       System status (services, queues)
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
    || fail "Login failed – is the system running? (docker compose up -d --wait)"
  [[ -n $TOKEN && $TOKEN != null ]] || fail "no token received"
}

create_routine() { # create_routine JSON → prints id (routine is activated)
  local response id
  response=$(api POST /api/v1/routines "$1")
  id=$(jq -r '.id // empty' <<<"$response")
  [[ -n $id ]] || fail "could not create routine: $response"
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
  jq -r '.id // empty' <<<"$body" | grep . || fail "trigger failed: $body"
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
  echo; fail "timeout: status is $last, expected: $*"
}

show_actions() {
  execution "$1" | jq -r '.actions[] | "    \(.key | .[0:12] | . + (" " * (12 - length))) \(.status | . + (" " * (10 - length))) attempts=\(.attempts)  \(.processedBy // "-")\(if .error then "  ⚠ " + .error else "" end)"'
}

show_log() {
  execution "$1" | jq -r '.log[] | "    \(.at[11:23])  \(.kind | . + (" " * (18 - length))) \(.actionKey // "" | . + (" " * (10 - length))) \(.message)"'
}

jaeger_hint() { [[ -s $TRACE_FILE ]] && note "Trace in Jaeger: http://localhost:16686/trace/$(cat "$TRACE_FILE")" || true; }

queue() { # queue NAME → "ready unacked consumers"
  curl -sS -u "$RABBIT_AUTH" "$RABBIT/api/queues/%2F/$1" | jq -r '"\(.messages_ready // 0) \(.messages_unacknowledged // 0) \(.consumers // 0)"'
}

rabbit_publish() { # rabbit_publish EXCHANGE ROUTING_KEY PAYLOAD_JSON – fails unless a queue received the message
  local routed
  routed=$(curl -sS -u "$RABBIT_AUTH" -X POST "$RABBIT/api/exchanges/%2F/$1/publish" -H 'content-type: application/json' \
    -d "$(jq -nc --arg rk "$2" --arg p "$3" '{properties:{delivery_mode:2,content_type:"application/json"},routing_key:$rk,payload:$p,payload_encoding:"string"}')" |
    jq -r '.routed')
  [[ $routed == true ]] || fail "message to $1/$2 was not routed – the test would have checked nothing"
}

count() { api GET "$1" | jq '.items | length'; }

recreate() { # recreate SERVICE [ENV=VALUE...] – redeploys a single service with changed configuration
  local service=$1; shift
  note "deploy: ${*:-(default configuration)} → $service"
  env "$@" docker compose up -d --no-deps --wait "$service" >/dev/null 2>&1 || fail "$service could not be started"
}

# ------------------------------------------------------------------ scenarios
scenario_main() {
  title "Main workflow (README §17)"
  login
  step "1. User creates routine \"Weekly Review\""
  local routine rid eid
  routine=$(jq -nc '{
    name: "Weekly Review",
    description: "Get weather and create a task (in parallel), build a summary, send a notification",
    trigger: {type: "manual"},
    actions: [
      {key: "weather", type: "weather.get",       step: 1, params: {city: "Zurich"}},
      {key: "task",    type: "task.create",       step: 1, params: {title: "Write weekly review", dueInDays: 2, priority: "high"}},
      {key: "summary", type: "summary.generate",  params: {title: "Weekly Review", sections: {Weather: "{{actions.weather.summary}}", Task: "{{actions.task.title}} (due {{actions.task.dueDate}})"}}},
      {key: "notify",  type: "notification.send", params: {title: "Weekly review ready", body: "{{actions.summary.text}}"}}
    ]}')
  rid=$(create_routine "$routine")
  ok "routine $rid created (POST /api/v1/routines → 201)"
  step "2. Routine is activated"; ok "active"
  step "3. Trigger starts the routine (POST …/executions → 202 Accepted)"
  eid=$(trigger "$rid")
  ok "Execution $eid"
  step "4.–8. Routine service creates the execution, workers process actions asynchronously"
  wait_for "$eid" 60 COMPLETED FAILED
  show_actions "$eid"
  [[ $(execution "$eid" | jq -r .status) == COMPLETED ]] || fail "execution not completed"
  step "9. Routine is shown as completed – execution log:"
  show_log "$eid"
  step "Results in the autonomous services"
  info "Task (task-service):           $(api GET /api/v1/tasks | jq -r '.items[0] | "\(.title) – due \(.dueDate)"')"
  info "Notifications (notification-service):"
  api GET /api/v1/notifications | jq -r '.items[0:2][] | "    • [\(.category)] \(.title)"'
  jaeger_hint
  note "Logs of all services: scripts/demo.sh trace $(execution "$eid" | jq -r .correlationId)"
  ok "main workflow succeeded"
}

scenario_retry() {
  title "Retry behaviour"
  login
  step "Action calls an unstable service that answers the first 2 attempts with 503"
  local rid eid attempts
  rid=$(create_routine "$(jq -nc '{name: "Flaky Webhook", trigger: {type: "manual"}, actions: [
      {key: "call", type: "http.request", params: {method: "POST", url: "http://mock-external:8090/flaky?failTimes=2", body: {ping: true}}},
      {key: "notify", type: "notification.send", params: {title: "Webhook succeeded after {{actions.call.body.attempt}} attempts"}}]}')")
  eid=$(trigger "$rid")
  note "Backoff: 1 s → 5 s → 15 s (dedicated retry queues with TTL + dead-lettering back into the work queue)"
  wait_for "$eid" 60 COMPLETED FAILED
  show_actions "$eid"
  attempts=$(execution "$eid" | jq -r '.actions[] | select(.key=="call") | .attempts')
  [[ $(execution "$eid" | jq -r .status) == COMPLETED && $attempts -ge 3 ]] || fail "expected: COMPLETED after 3 attempts"
  show_log "$eid" | grep -E "RETRY|WAITING|RUNNING|COMPLETED" || true
  ok "succeeded after $attempts attempts – without the user restarting it"

  step "A permanent error (HTTP 404) is not retried"
  rid=$(create_routine "$(jq -nc '{name: "Broken Endpoint", trigger: {type: "manual"}, actions: [
      {key: "call", type: "http.request", params: {url: "http://mock-external:8090/status/404"}},
      {key: "notify", type: "notification.send", params: {title: "never sent"}}]}')")
  eid=$(trigger "$rid")
  wait_for "$eid" 30 FAILED COMPLETED
  show_actions "$eid"
  [[ $(execution "$eid" | jq -r .status) == FAILED ]] || fail "expected: FAILED"
  info "Error: $(execution "$eid" | jq -r .error)"
  ok "FAILED immediately (1 attempt), follow-up action SKIPPED, user is notified"
}

scenario_resilience() {
  title "Resilience workflow (README §18)"
  login
  local rid other eid oid depth
  rid=$(create_routine "$(jq -nc '{name: "Morning Setup", trigger: {type: "manual"}, actions: [
      {key: "weather", type: "weather.get", params: {city: "Bern"}},
      {key: "notify", type: "notification.send", params: {title: "Good morning", body: "{{actions.weather.summary}}"}}]}')")
  other=$(create_routine "$(jq -nc '{name: "Quick Task", trigger: {type: "manual"}, actions: [
      {key: "task", type: "task.create", params: {title: "Independent task"}}]}')")

  step "2. Stop the worker service (all integration-worker replicas)"
  docker compose stop integration-worker >/dev/null 2>&1
  ok "integration-worker stopped"
  step "1./3. Start the routine – the action is still published"
  eid=$(trigger "$rid")
  for _ in $(seq 1 20); do
    read -r depth _ consumers <<<"$(queue integration-worker.actions)"
    ((depth >= 1)) && break
    sleep 0.5
  done
  info "Queue integration-worker.actions: ${bold}$depth waiting message(s)${reset}, $consumers consumer(s)"
  [[ $depth -ge 1 ]] || fail "message not in the broker"
  ok "4. message is waiting in the broker"
  step "5. The routine service and other services stay available"
  info "GET /api/v1/routines → HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$GATEWAY/api/v1/routines")"
  oid=$(trigger "$other")
  wait_for "$oid" 30 COMPLETED
  ok "another routine (task-service) completed in the meantime"
  info "Waiting execution:"
  wait_for "$eid" 30 WAITING
  step "6. Start the worker service"
  docker compose start integration-worker >/dev/null 2>&1
  ok "integration-worker started"
  step "7./8. Message is processed, execution completes"
  wait_for "$eid" 60 COMPLETED
  show_log "$eid"
  ok "no work lost, the user did not have to restart the routine"
}

scenario_idempotency() {
  title "Idempotency"
  login
  local rid eid key first second action_id owner before after envelope
  step "a) Duplicate API call with the same Idempotency-Key"
  rid=$(create_routine "$(jq -nc '{name: "Idempotency Demo", trigger: {type: "manual"}, actions: [
      {key: "task", type: "task.create", params: {title: "Create exactly once"}}]}')")
  key=$(uuid)
  first=$(trigger "$rid" "$key"); second=$(trigger "$rid" "$key")
  info "call 1 → $first"; info "call 2 → $second"
  [[ $first == "$second" ]] || fail "two executions created"
  ok "same execution – the client retry does not start the routine twice"
  wait_for "$first" 30 COMPLETED

  step "b) The same ActionRequested message is delivered twice"
  action_id=$(execution "$first" | jq -r '.actions[0].id')
  owner=$(api GET /api/v1/auth/me | jq -r .id)
  before=$(count /api/v1/tasks)
  envelope=$(jq -nc --arg mid "$(uuid)" --arg aid "$action_id" --arg eid "$first" --arg rid "$rid" --arg owner "$owner" '{
    messageId: $mid, type: "ActionRequested", version: 1, occurredAt: (now | todate), source: "demo-script", correlationId: $eid,
    data: {actionId: $aid, executionId: $eid, routineId: $rid, ownerId: $owner, actionKey: "task", actionType: "task.create", params: {title: "Create exactly once"}}}')
  # not inside $(…): a failing check in a subshell would not stop the scenario
  rabbit_publish routine.actions action.task.create "$envelope" && info "delivery 1 → routed to task-service.actions"
  rabbit_publish routine.actions action.task.create "$envelope" && info "delivery 2 → routed to task-service.actions"
  sleep 2
  after=$(count /api/v1/tasks)
  info "tasks before: $before, after: $after"
  [[ $before == "$after" ]] || fail "the duplicate created an extra task"
  docker compose logs --no-log-prefix --since 30s task-service routine-service 2>/dev/null | grep "$action_id" | jq -r 'select(.msg | test("duplicate")) | "    \(.service): \(.msg)"' | head -4
  ok "duplicates detected (actionId = idempotency key) → ignored, result only reported again"
}

scenario_scale() {
  title "Horizontal scaling"
  login
  local actions rid eid start duration replicas
  actions=$(jq -nc '[range(1;17) | {key: "w\(.)", type: "weather.get", step: 1, params: {city: (["Zurich","Bern","Basel","Lucerne","Chur","Lugano"][. % 6])}}]')
  rid=$(create_routine "$(jq -nc --argjson a "$actions" '{name: "Load Test", trigger: {type: "manual"}, actions: $a}')")
  for replicas in 1 4; do
    step "$replicas worker replica(s) – 16 parallel actions"
    docker compose up -d --no-deps --scale integration-worker="$replicas" --wait integration-worker >/dev/null 2>&1
    sleep 2
    start=$(date +%s)
    eid=$(trigger "$rid")
    wait_for "$eid" 90 COMPLETED
    duration=$(($(date +%s) - start))
    info "duration: ${bold}~${duration}s${reset} – distribution of actions:"
    execution "$eid" | jq -r '[.actions[].processedBy] | group_by(.) | .[] | "    \(.[0]): \(length)"'
  done
  docker compose up -d --no-deps --scale integration-worker=2 --wait integration-worker >/dev/null 2>&1
  ok "the broker distributes the work (competing consumers), replicas need no special configuration"
}

scenario_schedule() {
  title "Time-based trigger"
  login
  local rid n
  rid=$(create_routine "$(jq -nc '{name: "Every 15 Seconds", trigger: {type: "schedule", cron: "*/15 * * * * *", timezone: "Europe/Zurich"}, actions: [
      {key: "weather", type: "weather.get", params: {city: "Lugano"}}]}')")
  info "Cron */15 * * * * * – next run: $(api GET "/api/v1/routines/$rid" | jq -r .nextRunAt)"
  note "waiting for two executions …"
  for _ in $(seq 1 45); do
    n=$(api GET "/api/v1/routines/$rid/executions" | jq '[.items[] | select(.trigger == "schedule")] | length')
    ((n >= 2)) && break
    sleep 1
  done
  api GET "/api/v1/routines/$rid/executions" | jq -r '.items[] | "    \(.scheduledFor)  \(.trigger)  \(.status)"'
  api POST "/api/v1/routines/$rid/deactivate" >/dev/null
  ((n >= 2)) || fail "the schedule did not fire"
  ok "the scheduler triggered the routine (routine deactivated again)"
}

scenario_webhook() {
  title "External event: webhook trigger"
  login
  local routine rid path first second key body status
  routine=$(jq -nc '{name: "Deploy Hook", trigger: {type: "webhook"}, actions: [
      {key: "task", type: "task.create", params: {title: "Check release {{trigger.body.release.version}}", priority: "high"}},
      {key: "notify", type: "notification.send", params: {title: "Deployed {{trigger.body.release.version}}", body: "by {{trigger.body.author}}"}}]}')
  rid=$(create_routine "$routine")
  path=$(api GET "/api/v1/routines/$rid" | jq -r .webhookPath)
  [[ $path == /api/v1/hooks/* ]] || fail "routine has no webhook URL"
  ok "routine $rid listens on $GATEWAY${path:0:24}…"

  step "An external system calls the URL – no user token, the secret path is the credential"
  key=$(uuid)
  body='{"release":{"version":"2.4.0"},"author":"ci-bot"}'
  first=$(curl -sS -X POST "$GATEWAY$path" -H 'content-type: application/json' -H "idempotency-key: $key" -d "$body" | jq -r .executionId)
  [[ $first =~ ^[0-9a-f-]{36}$ ]] || fail "webhook call was not accepted"
  wait_for "$first" 30 COMPLETED
  info "Task:         $(api GET /api/v1/tasks | jq -r '.items[0].title')"
  info "Notification: $(api GET /api/v1/notifications | jq -r --arg e "$first" '[.items[] | select(.executionId == $e and .category == "action")][0] | "\(.title) – \(.body)"')"
  ok "JSON fields of the call became step input ({{trigger.body.release.version}})"

  step "The sender retries with the same Idempotency-Key"
  second=$(curl -sS -X POST "$GATEWAY$path" -H 'content-type: application/json' -H "idempotency-key: $key" -d "$body" | jq -r .executionId)
  [[ $first == "$second" ]] || fail "retry started a second run"
  ok "same execution – a retrying webhook provider does not start the routine twice"

  step "A leaked URL is replaced – the old one stops working immediately"
  api POST "/api/v1/routines/$rid/webhook/rotate" >/dev/null
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY$path" -H 'content-type: application/json' -d '{}')
  [[ $status == 404 ]] || fail "old URL still answers $status"
  ok "old URL → HTTP 404"
  api POST "/api/v1/routines/$rid/deactivate" >/dev/null
}

evolution_run() { # evolution_run LABEL → triggers a routine, prints the resulting execution notification
  local eid
  eid=$(trigger "$EVOLUTION_ROUTINE")
  wait_for "$eid" 30 COMPLETED >/dev/null
  sleep 1.5
  api GET /api/v1/notifications | jq -r --arg eid "$eid" '[.items[] | select(.executionId == $eid and .category == "execution")][0] // empty | "    📨 \(.title)  \(if .body != "" then "– " + .body else "" end)"'
}

scenario_evolution() {
  title "Evolving an interface: ExecutionCompleted v1 → v2 (expand and contract)"
  login
  EVOLUTION_ROUTINE=$(create_routine "$(jq -nc '{name: "Evolution Demo", trigger: {type: "manual"}, actions: [{key: "t", type: "task.create", params: {title: "Evolution"}}]}')")
  local dlq out

  step "Starting point – the producer sends v1, the consumer only understands v1"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v1
  recreate notification-service COMPLETION_EVENT_READER=legacy
  out=$(evolution_run); echo "$out"; [[ -n $out ]] || fail "no notification"

  step "Breaking change (what would happen without expand-and-contract): the producer drops 'message' right away"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v2
  out=$(evolution_run); [[ -z $out ]] || fail "the legacy consumer should not have processed v2"
  for _ in $(seq 1 20); do
    read -r dlq _ _ <<<"$(queue notification-service.execution-events.dlq)"
    ((dlq >= 1)) && break
    sleep 0.5
  done
  warn "the legacy consumer cannot read v2 → no notification, the event is in the DLQ ($dlq message(s)) – nothing lost"
  docker compose logs --no-log-prefix --since 20s notification-service 2>/dev/null | jq -r 'select(.level=="error") | "    \(.err)"' | tail -1

  step "Expand – the producer sends old AND new fields (only routine-service redeployed)"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=expand
  out=$(evolution_run); echo "$out"; [[ -n $out ]] || fail "the expand phase breaks the old consumer"
  ok "the old consumer keeps working"

  step "Update the consumer – the tolerant reader reads v2 (only notification-service redeployed)"
  recreate notification-service COMPLETION_EVENT_READER=tolerant
  out=$(evolution_run); echo "$out"; [[ $out == *"All actions succeeded"* ]] || fail "the new consumer does not use the v2 fields"
  info "Replay the event from the DLQ:"
  scripts/replay-dlq.sh notification-service.execution-events | sed 's/^/    /'

  step "Contract – remove the old fields (the producer only sends v2)"
  recreate routine-service EXECUTION_COMPLETED_FORMAT=v2
  out=$(evolution_run); echo "$out"; [[ $out == *"All actions succeeded"* ]] || fail "v2 is not processed"
  recreate routine-service; recreate notification-service
  ok "interface evolved – producer and consumer never had to be deployed at the same time"
}

# Manual testing helper: `scripts/demo.sh hook "Webhook Inbox" '{"hello":"world"}'`
scenario_hook() {
  local ref=${1:?pass a routine ID or name} body=${2:-'{"test":true}'} routine path eid
  jq -e 'type == "object"' <<<"$body" >/dev/null 2>&1 || fail "the body must be a JSON object: $body"
  login
  routine=$(api GET /api/v1/routines | jq -c --arg r "$ref" '[.items[] | select(.id == $r or .name == $r)][0] // empty')
  [[ -n $routine ]] || fail "no routine \"$ref\""
  path=$(jq -r '.webhookPath // empty' <<<"$routine")
  [[ -n $path ]] || fail "\"$(jq -r .name <<<"$routine")\" is not a webhook routine"
  [[ $(jq -r .active <<<"$routine") == true ]] || warn "the routine is paused – the call will be rejected (409)"
  title "POST $GATEWAY$path"
  info "body: $body"
  eid=$(curl -sS -X POST "$GATEWAY$path" -H 'content-type: application/json' -H "idempotency-key: $(uuid)" -d "$body" | tee /dev/stderr | jq -r '.executionId // empty')
  echo
  [[ -n $eid ]] || fail "the webhook call was rejected"
  wait_for "$eid" 60 COMPLETED FAILED
  show_actions "$eid"
  note "open in the UI: http://localhost:8080/#/executions/$eid"
}

scenario_trace() {
  local id=${1:?pass a correlation or execution ID}
  title "Logs for $id (all services)"
  docker compose logs --no-log-prefix 2>/dev/null | grep -F "$id" |
    jq -r '"\(.time[11:23])  \(.service | . + (" " * (21 - length))) \(.level | . + (" " * (5 - length))) \(.msg)\(if .actionId then "  action=" + .actionId[0:8] else "" end)\(if .processedBy then "  by=" + .processedBy else "" end)"' |
    sort
}

scenario_status() {
  login
  title "System status"
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
  webhook) scenario_webhook ;;
  evolution) scenario_evolution ;;
  trace) scenario_trace "${2:-}" ;;
  hook) scenario_hook "${2:-}" "${3:-}" ;;
  status) scenario_status ;;
  all)
    scenario_main; scenario_retry; scenario_idempotency; scenario_resilience; scenario_scale; scenario_schedule; scenario_webhook; scenario_evolution
    title "All scenarios succeeded"
    ;;
  *) sed -n '2,/^# Requirements/p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
