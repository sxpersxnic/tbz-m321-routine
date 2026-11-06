#!/usr/bin/env bash
# Routine – new passwords for the running VM deployment (docs/deployment.md §4, Secrets). Run on vm1, in the
# repository, after deploy/deploy.sh:
#   deploy/rotate-secrets.sh                          every password below
#   deploy/rotate-secrets.sh TASK_DB_PASSWORD …       only these
#
# Passwords: KEYCLOAK_ADMIN_PASSWORD RABBITMQ_PASSWORD KEYCLOAK_DB_PASSWORD ROUTINE_DB_PASSWORD TASK_DB_PASSWORD
#            NOTIFICATION_DB_PASSWORD INTEGRATION_DB_PASSWORD
#
# Each new value is set in the running component first (Keycloak's admin CLI, rabbitmqctl, ALTER ROLE in
# PostgreSQL) and written to the secrets file right after – the file always holds what the components accept,
# even if the script stops halfway. Then `deploy.sh app verify` rolls the pods onto the new values (same image
# tag as now) and runs the main workflow. Until the pods have rolled (2–3 min), an old replica that opens a new
# database or broker connection is refused; messages are retried, so no work is lost.
#
# Not rotated: K3S_TOKEN and RABBITMQ_ERLANG_COOKIE – see docs/deployment.md §4.
set -euo pipefail
cd "$(dirname "$0")/.."

INVENTORY=${INVENTORY:-deploy/cluster.env}
SECRETS=${SECRETS:-${INVENTORY%.env}.secrets.env}
NAMESPACE=routine
# Keycloak's admin first: its CLI needs a working Keycloak, which needs its database password
ROTATABLE=(KEYCLOAK_ADMIN_PASSWORD RABBITMQ_PASSWORD KEYCLOAK_DB_PASSWORD ROUTINE_DB_PASSWORD TASK_DB_PASSWORD
  NOTIFICATION_DB_PASSWORD INTEGRATION_DB_PASSWORD)
SUDO=; ((EUID == 0)) || SUDO=sudo

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
step() { printf "\n%s▶ %s%s\n" "$bold" "$*" "$reset"; }
ok()   { printf "  %s✔ %s%s\n" "$green" "$*" "$reset"; }
note() { printf "  %s%s%s\n" "$dim" "$*" "$reset"; }
err()  { printf "  %s✘ %s%s\n" "$red" "$*" "$reset" >&2; }
fail() { err "$@"; exit 1; }

k() { $SUDO k3s kubectl "$@"; }
in_pod() { k -n "$NAMESPACE" exec -i "$@"; } # in_pod <pod> -- <command> – the passwords go in on stdin

save() { # save <name> <value> – replaces the line in the secrets file; mktemp keeps it mode 600
  local tmp; tmp=$(mktemp "$SECRETS.XXXXXX")
  { grep -v "^$1=" "$SECRETS" || true; printf '%s=%s\n' "$1" "$2"; } >"$tmp" && mv "$tmp" "$SECRETS" ||
    fail "$1 is changed, but $SECRETS could not be written – add this line to it by hand: $1=$2"
}

rotate_keycloak_admin() { # <old> <new> – the admin console's user admin (Keycloak reads the bootstrap value only once)
  printf '%s\n%s\n' "$1" "$2" | in_pod deploy/keycloak -c keycloak -- bash -c '
    read -r old; read -r new; config=$(mktemp); trap "rm -f $config" EXIT
    kc() { /opt/keycloak/bin/kcadm.sh "$@" --config "$config"; }
    kc config credentials --server http://localhost:8080/auth --realm master --user admin --password "$old" &&
      kc set-password -r master --username admin --new-password "$new"' >/dev/null 2>&1
}

rotate_rabbitmq() { # <old> <new> – one change for the whole cluster: the nodes share their users
  local n
  for n in 1 2 3; do
    printf '%s\n' "$2" | in_pod "rabbitmq-$n" -c rabbitmq -- sh -c 'read -r new; rabbitmqctl -q change_password routine "$new"' \
      >/dev/null 2>&1 && return 0
  done
  return 1
}

rotate_database() { # <name> <new> – ALTER ROLE over the local socket in the database's pod (trusted, no old password)
  local db; db=$(tr '[:upper:]' '[:lower:]' <<<"${1%_DB_PASSWORD}") # KEYCLOAK_DB_PASSWORD → keycloak (user, database)
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$db" "$2" | in_pod "$db-db-0" -c postgres -- psql -qX -v ON_ERROR_STOP=1 -U "$db" -d "$db" >/dev/null
}

# ------------------------------------------------------------------ checks
selected=()
if (($#)); then
  for name in "$@"; do
    [[ " ${ROTATABLE[*]} " == *" $name "* ]] || fail "$name cannot be rotated here – one of: ${ROTATABLE[*]}"
  done
  for name in "${ROTATABLE[@]}"; do [[ " $* " != *" $name "* ]] || selected+=("$name"); done # in the safe order
else
  selected=("${ROTATABLE[@]}")
fi

[[ -f $SECRETS ]] || fail "$SECRETS missing – rotate-secrets.sh changes a running deployment (deploy/deploy.sh first)"
# shellcheck source=/dev/null
source "$SECRETS"
for name in "${selected[@]}"; do [[ -n ${!name:-} ]] || fail "$name is not in $SECRETS"; done
command -v openssl >/dev/null || fail "openssl missing"
image=$(k -n "$NAMESPACE" get deployment gateway -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null) ||
  fail "the application is not deployed (kubectl -n $NAMESPACE get deployment gateway)"
TAG=${image##*:} # roll out the version that runs now, whatever is checked out

# ------------------------------------------------------------------ rotate
step "New passwords: ${selected[*]}"
changed=() failed=()
for name in "${selected[@]}"; do
  new=$(openssl rand -hex 24) # hex: safe inside URLs, YAML and SQL quotes
  case $name in
    KEYCLOAK_ADMIN_PASSWORD) rotate_keycloak_admin "${!name}" "$new" ;;
    RABBITMQ_PASSWORD) rotate_rabbitmq "${!name}" "$new" ;;
    *_DB_PASSWORD) rotate_database "$name" "$new" ;;
  esac && { save "$name" "$new"; changed+=("$name"); ok "$name"; continue; }
  failed+=("$name")
  case $name in
    KEYCLOAK_ADMIN_PASSWORD) err "$name: Keycloak refused the current password – was it changed in the admin console? Unchanged" ;;
    RABBITMQ_PASSWORD) err "$name: no broker node accepted the change (kubectl -n $NAMESPACE get pods -l app=rabbitmq). Unchanged" ;;
    *) err "$name: the database did not accept the change (kubectl -n $NAMESPACE get pods). Unchanged" ;;
  esac
done
((${#changed[@]})) || fail "nothing changed"
note "written to $SECRETS – copy it to your password manager again"

# ------------------------------------------------------------------ roll out
step "Pods onto the new passwords (images $TAG)"
TAG=$TAG INVENTORY=$INVENTORY SECRETS=$SECRETS deploy/deploy.sh app verify

printf "\n%sRotated: %s%s\n" "$bold" "${changed[*]}" "$reset"
note "Not rotated by this script: K3S_TOKEN, RABBITMQ_ERLANG_COOKIE (docs/deployment.md §4)"
((${#failed[@]} == 0)) || fail "not rotated: ${failed[*]} – see the messages above"
