#!/usr/bin/env bash
# Removes the throwaway accounts (…@test.local) created while testing the UI,
# together with the routines, executions, tasks and notifications they own.
# The demo account (demo@routine.local) is never matched by the pattern.
set -euo pipefail
cd "$(dirname "$0")/.."

# test accounts live in Keycloak – found and deleted with its admin CLI inside a Keycloak container
kcadm() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
kcadm config credentials --server http://localhost:8080/auth --realm master \
  --user "${KEYCLOAK_ADMIN:-admin}" --password "${KEYCLOAK_ADMIN_PASSWORD:-admin}" >/dev/null
users=$(kcadm get users -r routine -q email=@test.local -l 10000 | jq -r '.[] | select(.email | endswith("@test.local")) | .id')
ids=$(printf '%s\n' "$users" | grep . | sed "s/.*/'&'/" | paste -sd, - || true)

if [ -z "$ids" ]; then echo "No test accounts found."; exit 0; fi
echo "Test accounts: $(printf '%s\n' "$users" | grep -c .)"

docker compose exec -T routine-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"
  DELETE FROM execution_log WHERE execution_id IN (SELECT id FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids)));
  DELETE FROM execution_actions WHERE execution_id IN (SELECT id FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids)));
  DELETE FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids));
  DELETE FROM routines WHERE owner_id IN ($ids);\""
docker compose exec -T task-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"DELETE FROM tasks WHERE owner_id IN ($ids);\""
docker compose exec -T notification-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"DELETE FROM notifications WHERE owner_id IN ($ids);\""
for id in $users; do kcadm delete "users/$id" -r routine; done
echo "Done."
