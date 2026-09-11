#!/usr/bin/env bash
# Moves all messages from <queue>.dlq back into <queue> (e.g. after a consumer bug was fixed).
#   scripts/replay-dlq.sh notification-service.execution-events
set -euo pipefail
QUEUE=${1:?usage: replay-dlq.sh <work-queue>}
RABBIT=${RABBIT:-http://localhost:15672}
AUTH=${RABBIT_AUTH:-routine:routine}

messages=$(curl -sS -u "$AUTH" -X POST "$RABBIT/api/queues/%2F/$QUEUE.dlq/get" -H 'content-type: application/json' \
  -d '{"count":1000,"ackmode":"ack_requeue_false","encoding":"auto"}')
total=$(jq length <<<"$messages")
for i in $(seq 0 $((total - 1))); do
  jq -c --argjson i "$i" --arg q "$QUEUE" '.[$i] | {
      properties: (.properties | .headers = ((.headers // {}) | del(."x-error", ."x-attempts", ."x-failed-at", ."x-attempt"))),
      routing_key: $q, payload: .payload, payload_encoding: .payload_encoding}' <<<"$messages" |
    curl -sS -u "$AUTH" -X POST "$RABBIT/api/exchanges/%2F/amq.default/publish" -H 'content-type: application/json' -d @- >/dev/null
done
echo "$total Nachricht(en) von $QUEUE.dlq nach $QUEUE verschoben"
