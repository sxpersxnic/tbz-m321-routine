#!/usr/bin/env bash
# Moves all messages from <queue>.dlq back into <queue> (e.g. after a consumer bug was fixed).
#   scripts/replay-dlq.sh notification-service.execution-events
#
# One message at a time: peek → publish copy (must be routed) → remove original.
# A crash in between leaves the message in both queues – a duplicate, which the
# idempotent consumers ignore – but never loses it. Only the messages present at
# the start are moved, so a consumer that still fails cannot cause an endless loop.
set -euo pipefail
QUEUE=${1:?usage: replay-dlq.sh <work-queue>}
DLQ="$QUEUE.dlq"
RABBIT=${RABBIT:-http://localhost:15672}
AUTH=${RABBIT_AUTH:-routine:routine}

rabbit() { curl -fsS -u "$AUTH" -H 'content-type: application/json' "$@"; }
get_one() { rabbit -X POST "$RABBIT/api/queues/%2F/$DLQ/get" -d "{\"count\":1,\"ackmode\":\"$1\",\"encoding\":\"base64\"}"; }
publish() { # publish ROUTING_KEY MESSAGE_JSON [STRIP_HEADERS]
  jq -c --arg q "$1" --argjson strip "${3:-false}" '{
      properties: (.properties | if $strip then .headers = ((.headers // {}) | del(."x-error", ."x-attempts", ."x-failed-at", ."x-attempt")) else . end),
      routing_key: $q, payload: .payload, payload_encoding: .payload_encoding}' <<<"$2" |
    rabbit -X POST "$RABBIT/api/exchanges/%2F/amq.default/publish" -d @- | jq -r .routed
}

total=$(rabbit "$RABBIT/api/queues/%2F/$DLQ" | jq '.messages // 0')
for ((i = 0; i < total; i++)); do
  message=$(get_one reject_requeue_true | jq -c '.[0] // empty') # peek – stays at the head of the (classic) DLQ
  [[ -n $message ]] || break
  [[ $(publish "$QUEUE" "$message" true) == true ]] || { echo "Aborted: $QUEUE does not accept messages (not routed)" >&2; exit 1; }

  removed=$(get_one ack_requeue_false | jq -c '.[0] // empty')
  if [[ $(jq -r '.properties.message_id' <<<"$removed") != $(jq -r '.properties.message_id' <<<"$message") ]]; then
    # someone else changed the DLQ meanwhile – put the removed message back and stop
    [[ -z $removed ]] || publish "$DLQ" "$removed" >/dev/null
    echo "Aborted: $DLQ was changed concurrently – $i message(s) moved" >&2
    exit 1
  fi
done
echo "$i message(s) moved from $DLQ to $QUEUE"
