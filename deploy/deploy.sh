#!/usr/bin/env bash
# Routine – automated deployment on three VMs (Docker Swarm). Details: docs/deployment.md
#
#   deploy/deploy.sh [command]
#
# Commands:
#   all        bootstrap → swarm → images → stack → verify (default; every step is idempotent)
#   bootstrap  install Docker on the VMs over SSH (skipped where Docker is already installed)
#   swarm      form the swarm: 3 managers, node labels for broker nodes and databases
#   images     build the service images on vm1 and copy them to vm2 and vm3
#   stack      deploy / update the stack (rolling update, zero downtime) and wait until it is healthy
#   verify     run the main workflow (scripts/demo.sh main) against the deployed system
#   status     nodes, services and replicas
#   destroy    remove the stack (volumes and swarm stay)
#
# Inventory: deploy/vms.env (copy deploy/vms.env.example), or INVENTORY=<file>.
# Requirements on your machine: docker CLI, ssh (key-based login to the VMs), git, curl, jq.
set -euo pipefail
cd "$(dirname "$0")/.."

INVENTORY=${INVENTORY:-deploy/vms.env}
[[ -f $INVENTORY ]] || { echo "Inventory $INVENTORY missing – copy deploy/vms.env.example and fill in your VMs" >&2; exit 1; }
# shellcheck source=/dev/null
source "$INVENTORY"

STACK=${STACK:-routine}
NODES=(1 2 3)
IMAGES=(gateway identity-service routine-service task-service notification-service integration-worker mock-external web)

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
step() { printf "\n%s▶ %s%s\n" "$bold" "$*" "$reset"; }
ok()   { printf "  %s✔ %s%s\n" "$green" "$*" "$reset"; }
note() { printf "  %s%s%s\n" "$dim" "$*" "$reset"; }
fail() { printf "  %s✘ %s%s\n" "$red" "$*" "$reset" >&2; exit 1; }

# ------------------------------------------------------------------ inventory helpers
ssh_target() { local var="VM$1"; echo "${!var:?VM$1 is not set in $INVENTORY}"; }
docker_url() { local var="VM$1_DOCKER"; echo "${!var:-ssh://$(ssh_target "$1")}"; }
addr() { # address the other VMs reach this VM at (swarm traffic)
  local var="VM$1_ADDR" target
  if [[ -n ${!var:-} ]]; then echo "${!var}"; return; fi
  target=$(ssh_target "$1"); target=${target#*@}; echo "${target%%:*}"
}
public_url() { echo "${PUBLIC_URL:-http://$(addr 1):8080}"; }
on() { local n=$1; shift; DOCKER_HOST=$(docker_url "$n") docker "$@"; } # run a docker command on VM n
uses_ssh() { [[ $(docker_url "$1") == ssh://* ]]; }

default_tag() { # commit of the image inputs; uncommitted changes add a hash of their content
  local tag inputs=(libs services web docker package.json package-lock.json)
  tag=$(git rev-parse --short HEAD)
  if [[ -n $(git status --porcelain -- "${inputs[@]}") ]]; then
    tag="$tag-dirty-$({ git diff HEAD -- "${inputs[@]}"; git ls-files --others --exclude-standard -- "${inputs[@]}" | xargs cat 2>/dev/null; } |
      { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)"
  fi
  echo "$tag"
}
TAG=${TAG:-$(default_tag)}

# ------------------------------------------------------------------ steps
cmd_bootstrap() {
  step "Docker on the VMs"
  for n in "${NODES[@]}"; do
    if ! uses_ssh "$n"; then note "vm$n: $(docker_url "$n") – not managed over SSH, skipped"; continue; fi
    local target; target=$(ssh_target "$n")
    if ssh -o BatchMode=yes "$target" 'docker version --format "{{.Server.Version}}"' >/dev/null 2>&1; then
      ok "vm$n ($target): Docker $(ssh -o BatchMode=yes "$target" 'docker version --format "{{.Server.Version}}"')"
      continue
    fi
    note "vm$n ($target): installing Docker (get.docker.com) …"
    ssh -o BatchMode=yes "$target" 'curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"' >/dev/null ||
      fail "vm$n: Docker installation failed (needs sudo without password)"
    ok "vm$n ($target): Docker installed"
  done
}

cmd_swarm() {
  step "Swarm (3 managers – the swarm itself tolerates the loss of one VM)"
  if [[ $(on 1 info --format '{{.Swarm.LocalNodeState}}') != active ]]; then
    on 1 swarm init --advertise-addr "$(addr 1)" >/dev/null
    ok "vm1: swarm initialised on $(addr 1)"
  else
    ok "vm1: swarm already active"
  fi
  local token; token=$(on 1 swarm join-token -q manager)
  for n in 2 3; do
    if [[ $(on "$n" info --format '{{.Swarm.LocalNodeState}}') == active ]]; then ok "vm$n: already a member"; continue; fi
    on "$n" swarm join --token "$token" --advertise-addr "$(addr "$n")" "$(addr 1):2377" >/dev/null
    ok "vm$n: joined as manager"
  done

  local id
  for n in "${NODES[@]}"; do
    id=$(on "$n" info --format '{{.Swarm.NodeID}}')
    on 1 node update --label-add "routine.rabbitmq=$n" "$id" >/dev/null
  done
  on 1 node update --label-add routine.data=true "$(on 1 info --format '{{.Swarm.NodeID}}')" >/dev/null
  ok "labels: rabbitmq-N → vmN, databases → vm1"
}

cmd_images() {
  step "Images (tag $TAG)"
  note "building on vm1 – native architecture of the VMs, no registry needed …"
  on 1 compose -f compose.yaml build --quiet "${IMAGES[@]}" || fail "build failed"
  local refs=()
  for image in "${IMAGES[@]}"; do
    on 1 tag "routine/$image:latest" "routine/$image:$TAG"
    refs+=("routine/$image:$TAG")
  done
  ok "built ${#refs[@]} images on vm1"
  for n in 2 3; do
    on 1 save "${refs[@]}" | on "$n" load >/dev/null || fail "copying images to vm$n failed"
    ok "copied to vm$n"
  done
}

config_version() { # content hash: swarm configs are immutable, a changed file needs a new name
  cat infra/rabbitmq/rabbitmq.conf infra/rabbitmq/definitions.json infra/rabbitmq/advanced.config infra/edge/nginx.conf |
    { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12
}

wait_converged() { # every service of the stack runs its desired number of healthy tasks
  local deadline=$((SECONDS + ${1:-600})) pending
  while ((SECONDS < deadline)); do
    pending=$(on 1 service ls --filter "label=com.docker.stack.namespace=$STACK" --format '{{.Name}} {{.Replicas}}' |
      awk '{ split($2, r, "/"); if (r[1] != r[2] + 0) print $1 " " $2 }')
    [[ -z $pending ]] && return 0
    printf "\r  %swaiting for: %s%s\033[K" "$dim" "$(echo "$pending" | tr '\n' ' ' | cut -c1-110)" "$reset"
    sleep 3
  done
  echo; fail "stack did not converge: $(echo "$pending" | tr '\n' ' ')"
}

wait_broker_replicated() { # a VM may only fail once every quorum queue has a replica on every VM
  local container short deadline=$((SECONDS + 300))
  container=$(on 1 ps -q --filter "name=${STACK}_rabbitmq-1" | head -1)
  [[ -n $container ]] || fail "rabbitmq-1 is not running on vm1"
  # queues declared while the cluster was still forming start with fewer replicas – add the missing ones now
  # instead of waiting for the broker's periodic reconciliation
  for n in "${NODES[@]}"; do on 1 exec "$container" rabbitmq-queues grow "rabbit@rabbitmq-$n" all >/dev/null 2>&1 || true; done
  while ((SECONDS < deadline)); do
    short=$(on 1 exec "$container" wget -qO- --header "Authorization: Basic $(printf routine:routine | base64)" \
      'http://127.0.0.1:15672/api/queues/%2F?columns=name,members' | jq -r '[.[] | select((.members | length) < 3) | .name] | join(" ")')
    [[ -z $short ]] && return 0
    printf "\r  %swaiting for replicas: %s%s\033[K" "$dim" "$(cut -c1-100 <<<"$short")" "$reset"
    sleep 3
  done
  echo; fail "quorum queues without 3 replicas: $short"
}

cmd_stack() {
  step "Stack \"$STACK\" (images $TAG)"
  export TAG CONFIG_VERSION
  CONFIG_VERSION=$(config_version)
  on 1 stack deploy --detach=true --prune --resolve-image never -c deploy/stack.yml "$STACK" >/dev/null
  ok "deployed – swarm rolls the services one replica at a time"
  wait_converged 900
  printf "\r\033[K"; ok "all services healthy"
  wait_broker_replicated
  printf "\r\033[K"; ok "every quorum queue has 3 replicas – one per VM"
  # configs of earlier versions are no longer referenced – swarm refuses to remove the ones in use
  on 1 config ls --format '{{.Name}}' | { grep -E '^routine_(rabbitmq|edge)_' || true; } | { grep -v "_${CONFIG_VERSION}\$" || true; } |
    while read -r config; do on 1 config rm "$config" >/dev/null 2>&1 || true; done
}

cmd_verify() {
  step "Verify: main workflow against $(public_url)"
  local deadline=$((SECONDS + 120))
  until curl -sf "$(public_url)/edge/health" >/dev/null; do
    ((SECONDS < deadline)) || fail "$(public_url) not reachable – firewall? (see docs/deployment.md)"
    sleep 2
  done
  GATEWAY=$(public_url) RABBIT=${RABBIT_URL:-http://$(addr 1):15672} bash scripts/demo.sh main
  [[ -n ${PUBLIC_URL:-} ]] && return # behind a load balancer / port mapping: only that one URL is reachable
  local url
  for n in "${NODES[@]}"; do
    url="http://$(addr "$n"):8080"
    curl -sf "$url/edge/health" >/dev/null || fail "vm$n does not answer on $url"
    ok "vm$n answers on $url"
  done
}

cmd_status() {
  step "Nodes"
  on 1 node ls --format '  {{.Hostname}}\t{{.Status}}\t{{.Availability}}\t{{.ManagerStatus}}'
  step "Services"
  on 1 service ls --filter "label=com.docker.stack.namespace=$STACK" --format '  {{.Name}}\t{{.Replicas}}\t{{.Image}}' | sort | column -t
  step "Where the tasks run"
  on 1 stack ps "$STACK" --filter desired-state=running --format '{{.Node}} {{.Name}}' |
    awk '{ sub(/\.[a-z0-9]+$/, "", $2); tasks[$1] = tasks[$1] " " $2 } END { for (n in tasks) print "  " n ":" tasks[n] }' | sort
}

cmd_destroy() {
  step "Remove stack \"$STACK\""
  on 1 stack rm "$STACK" >/dev/null
  ok "removed – volumes (data) stay on the VMs; the swarm stays formed"
}

case "${1:-all}" in
  all) cmd_bootstrap; cmd_swarm; cmd_images; cmd_stack; cmd_verify; printf "\n%sRoutine runs on 3 VMs: %s%s\n" "$bold" "$(public_url)" "$reset" ;;
  bootstrap) cmd_bootstrap ;;
  swarm) cmd_swarm ;;
  images) cmd_images ;;
  stack) cmd_stack ;;
  verify) cmd_verify ;;
  status) cmd_status ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,/^# Requirements/p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
