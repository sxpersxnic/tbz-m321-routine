#!/usr/bin/env bash
# Removes the throwaway accounts (…@test.local) created while testing the UI,
# together with the routines, executions, tasks and notifications they own.
# The demo account (demo@routine.local) is never matched by the pattern.
set -euo pipefail
cd "$(dirname "$0")/.."

ids=$(docker compose exec -T identity-db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select id from users where email like '"'"'%@test.local'"'"';"' \
  | tr -d '\r' | paste -sd, - | sed "s/[^,]*/'&'/g")

if [ -z "$ids" ]; then echo "No test accounts found."; exit 0; fi
echo "Test accounts: $(echo "$ids" | tr -cd ',' | wc -c | tr -d ' ') + 1"

docker compose exec -T routine-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"
  DELETE FROM execution_log WHERE execution_id IN (SELECT id FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids)));
  DELETE FROM execution_actions WHERE execution_id IN (SELECT id FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids)));
  DELETE FROM executions WHERE routine_id IN (SELECT id FROM routines WHERE owner_id IN ($ids));
  DELETE FROM routines WHERE owner_id IN ($ids);\""
docker compose exec -T task-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"DELETE FROM tasks WHERE owner_id IN ($ids);\""
docker compose exec -T notification-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"DELETE FROM notifications WHERE owner_id IN ($ids);\""
docker compose exec -T identity-db sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -v ON_ERROR_STOP=1 -c \"DELETE FROM users WHERE email LIKE '%@test.local';\""
echo "Done."
