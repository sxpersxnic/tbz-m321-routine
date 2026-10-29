#!/usr/bin/env bash
# Routine – automated deployment on four VMs (Kubernetes, k3s). Details: docs/deployment.md
#
# Run on vm1, in a clone of this repository – it sets up the whole cluster from there:
#   deploy/deploy.sh [command …]   (several run in order, e.g. `deploy.sh images app`)
#
# Commands:
#   all        access → cluster → images → app → verify (default; every step is idempotent)
#   access     SSH from vm1 to vm2–vm4 (copies a key, asks for the password once if needed) and sudo there
#   cluster    install k3s: vm1–vm3 control plane (embedded etcd), vm4 worker; node labels
#   images     build the service images on vm1 and import them on every VM
#   app        deploy / update the application (rolling update, zero downtime) and wait until it is healthy
#   verify     run the main workflow (scripts/demo.sh main) against the deployed system
#   render     only write the manifests to deploy/.generated (no cluster needed – used by CI)
#   status     nodes, pods and where they run
#   destroy    remove the application (volumes and cluster stay)
#
# Inventory: deploy/cluster.env (the four VMs), or INVENTORY=<file>.
# Secrets: generated on the first run into deploy/cluster.secrets.env (next to the inventory, mode 600, never
#          committed) – keep that file: the databases only accept the passwords they were created with.
# Requirements: Ubuntu/Debian on vm1 with sudo; vm2–vm4 reachable from vm1 by SSH, with sudo.
set -euo pipefail
cd "$(dirname "$0")/.."

INVENTORY=${INVENTORY:-deploy/cluster.env}
[[ -f $INVENTORY ]] || { echo "Inventory $INVENTORY missing" >&2; exit 1; }
# shellcheck source=/dev/null
source "$INVENTORY"

SECRETS=${SECRETS:-${INVENTORY%.env}.secrets.env}
GENERATED=deploy/.generated
NAMESPACE=routine
NODES=(1 2 3 4)
SERVERS=(1 2 3)   # control plane: etcd needs a majority – three servers tolerate the loss of one
BROKER_NODES=(1 2 3)
DATA_NODE=4
IMAGES=(gateway keycloak routine-service task-service notification-service integration-worker mock-external web)
SSH_USER=${SSH_USER:-$(id -un)}
SUDO=; ((EUID == 0)) || SUDO=sudo
WORK=$(mktemp -d) # installer, configs, image archive – removed on exit
trap 'rm -rf "$WORK"' EXIT

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
step() { printf "\n%s▶ %s%s\n" "$bold" "$*" "$reset"; }
ok()   { printf "  %s✔ %s%s\n" "$green" "$*" "$reset"; }
note() { printf "  %s%s%s\n" "$dim" "$*" "$reset"; }
fail() { printf "  %s✘ %s%s\n" "$red" "$*" "$reset" >&2; exit 1; }

# ------------------------------------------------------------------ inventory helpers
ip_of() { local var="VM$1"; echo "${!var:?VM$1 is not set in $INVENTORY}"; }
public_url() { echo "${PUBLIC_URL:-http://$(ip_of 1):8080}"; }
is_server() { [[ " ${SERVERS[*]} " == *" $1 "* ]]; }
k() { $SUDO k3s kubectl "$@"; } # kubectl of the cluster (vm1 is a server)

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
remote() { local n=$1; shift; ssh "${SSH_OPTS[@]}" "$SSH_USER@$(ip_of "$n")" "$@"; }

as_root() { # as_root <vm> <command> – vm1 is this machine; the sudo password (if any) goes in on stdin
  local n=$1; shift
  if ((n == 1)); then $SUDO sh -c "$*"; return; fi
  if [[ $SSH_USER == root ]]; then remote "$n" "sh -c $(printf %q "$*")" </dev/null; return; fi
  printf '%s\n' "${SUDO_PASSWORD:-}" | remote "$n" "sudo -S -p '' sh -c $(printf %q "$*")"
}

copy_to() { # copy_to <vm> <local file> <path> – readable by the SSH user only, until moved by as_root
  if (($1 == 1)); then (umask 077 && cat "$2" >"$3"); else remote "$1" "umask 077 && cat > $3" <"$2"; fi
}

default_tag() { # commit of the image inputs; uncommitted changes add a hash of their content
  local tag inputs=(libs services web docker package.json package-lock.json)
  tag=$(git rev-parse --short HEAD)
  if [[ -n $(git status --porcelain -- "${inputs[@]}") ]]; then
    tag="$tag-dirty-$({ git diff HEAD -- "${inputs[@]}"; git ls-files --others --exclude-standard -- "${inputs[@]}" | xargs cat 2>/dev/null; } |
      sha256sum | cut -c1-8)"
  fi
  echo "$tag"
}
TAG=${TAG:-$(default_tag)}

need_tools() { # need_tools <tool>[=<package>] … – installs what is missing on vm1 from the distribution
  local missing=() entry
  for entry in "$@"; do command -v "${entry%%=*}" >/dev/null || missing+=("${entry#*=}"); done
  ((${#missing[@]})) || return 0
  command -v apt-get >/dev/null || fail "missing: ${missing[*]} – install them, then run deploy.sh again"
  note "installing ${missing[*]} …"
  $SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get update -q >/dev/null
  $SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -yq "${missing[@]}" >/dev/null || fail "apt-get install ${missing[*]} failed"
}

# ------------------------------------------------------------------ secrets
SECRET_NAMES=(K3S_TOKEN RABBITMQ_PASSWORD RABBITMQ_ERLANG_COOKIE KEYCLOAK_ADMIN_PASSWORD
  KEYCLOAK_DB_PASSWORD ROUTINE_DB_PASSWORD TASK_DB_PASSWORD NOTIFICATION_DB_PASSWORD INTEGRATION_DB_PASSWORD)

load_secrets() { # generate what is missing (first run, or a secret added later)
  touch "$SECRETS" && chmod 600 "$SECRETS"
  # shellcheck source=/dev/null
  source "$SECRETS"
  for name in "${SECRET_NAMES[@]}"; do
    [[ -n ${!name:-} ]] && continue
    printf '%s=%s\n' "$name" "$(openssl rand -hex 24)" >>"$SECRETS" # hex: safe inside URLs and YAML
    note "generated $name → $SECRETS"
  done
  # shellcheck source=/dev/null
  source "$SECRETS"
}

rabbit_auth() { printf 'routine:%s' "$RABBITMQ_PASSWORD"; }

# ------------------------------------------------------------------ steps
cmd_access() {
  step "Access from vm1 to vm2–vm4 (user $SSH_USER)"
  ip -o addr show | grep -qF " $(ip_of 1)/" || fail "this machine is not vm1 ($(ip_of 1)) – run deploy.sh on vm1"
  [[ -z $SUDO ]] || $SUDO -v || fail "sudo on vm1 failed"
  local n
  for n in "${NODES[@]:1}"; do
    if ! remote "$n" true 2>/dev/null; then
      [[ -f ~/.ssh/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
      note "vm$n: copying vm1's SSH key – enter the password of $SSH_USER@$(ip_of "$n")"
      ssh-copy-id -i ~/.ssh/id_ed25519.pub -o StrictHostKeyChecking=accept-new "$SSH_USER@$(ip_of "$n")" >/dev/null 2>&1 ||
        fail "vm$n: SSH login as $SSH_USER failed – run deploy.sh as your own user (not with sudo), or set SSH_USER in $INVENTORY"
    fi
    if [[ $SSH_USER != root ]] && ! remote "$n" 'sudo -n true' 2>/dev/null && [[ -z ${SUDO_PASSWORD+set} ]]; then
      read -rsp "  sudo password of $SSH_USER on the VMs: " SUDO_PASSWORD; echo
    fi
    as_root "$n" true || fail "vm$n: sudo failed"
    ok "vm$n ($(ip_of "$n")): SSH and sudo"
  done
  ACCESS_CHECKED=1
}

k3s_version() { # every node runs the same version: vm1's, or the current stable release for a new cluster
  if [[ -n ${K3S_VERSION:-} ]]; then echo "$K3S_VERSION"; return; fi
  if command -v k3s >/dev/null; then k3s --version | awk 'NR == 1 { print $3 }'; return; fi
  curl -sS -o /dev/null -w '%{redirect_url}' https://update.k3s.io/v1-release/channels/stable | sed 's|.*/||; s|%2[Bb]|+|'
}

lan_iface() { # network interface that holds the inventory address of vm n
  local n=$1 cmd
  cmd="ip -o -4 addr show to $(ip_of "$n")"
  if ((n == 1)); then $cmd; else remote "$n" "$cmd"; fi | awk '{ print $2; exit }'
}

k3s_config() { # /etc/rancher/k3s/config.yaml of vm n
  local n=$1 iface
  iface=$(lan_iface "$n")
  [[ -n $iface ]] || fail "vm$n has no interface with $(ip_of "$n") – check the address in $INVENTORY"
  echo "# written by deploy/deploy.sh (Routine)"
  echo "node-name: vm$n" # explicit: cloned VMs often share a hostname
  echo "node-ip: $(ip_of "$n")"
  # pod traffic between the VMs (VXLAN) takes the interface of node-ip – not the default route's, which differs
  # on VMs with a second network card (e.g. NAT for internet access)
  echo "flannel-iface: $iface"
  echo "token-file: /etc/rancher/k3s/routine-token" # not in this file: k3s' kubectl reads it as any user
  if ((n == 1)); then echo "cluster-init: true"; else echo "server: https://$(ip_of 1):6443"; fi
  if is_server "$n"; then
    echo "tls-san: [$(ip_of 1), $(ip_of 2), $(ip_of 3)]"
    echo "disable: [traefik, servicelb]" # the platform brings its own edge on :8080 of every VM
    echo "service-node-port-range: 15000-32767" # admin tools keep their usual ports (:15672, :16686)
  fi
}

wait_node_ready() {
  local deadline=$((SECONDS + 300))
  until k get node "vm$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q True; do
    ((SECONDS < deadline)) || fail "vm$1 did not become ready – journalctl -u k3s (-agent) on vm$1"
    sleep 3
  done
}

cmd_cluster() {
  step "Kubernetes (k3s): vm1–vm3 control plane, vm4 worker"
  [[ -n ${ACCESS_CHECKED:-} ]] || cmd_access
  need_tools curl openssl
  load_secrets
  local version installer=$WORK/k3s-install.sh config=$WORK/k3s-config.yaml token=$WORK/k3s-token role n
  version=$(k3s_version)
  [[ $version == v* ]] || fail "could not determine the k3s version – set K3S_VERSION in $INVENTORY"
  curl -sSfL https://get.k3s.io -o "$installer" || fail "download of the k3s installer (get.k3s.io) failed"
  (umask 077 && printf '%s\n' "$K3S_TOKEN" >"$token")
  for n in "${NODES[@]}"; do
    k3s_config "$n" >"$config"
    if is_server "$n"; then role=server; else role=agent; fi
    if [[ $(as_root "$n" 'k3s --version 2>/dev/null' | awk 'NR == 1 { print $3 }') == "$version" ]] &&
      as_root "$n" "cat /etc/rancher/k3s/config.yaml 2>/dev/null" | cmp -s - "$config" &&
      as_root "$n" 'systemctl is-active --quiet k3s || systemctl is-active --quiet k3s-agent'; then
      ok "vm$n: k3s $version $role, running"
      continue
    fi
    note "vm$n: installing k3s $version …"
    copy_to "$n" "$config" /tmp/routine-k3s-config.yaml
    copy_to "$n" "$installer" /tmp/routine-k3s-install.sh
    copy_to "$n" "$token" /tmp/routine-k3s-token
    # the official installer: verifies the binary's checksum, sets up the systemd service. It restarts k3s only
    # when its own service files change – FORCE_RESTART, so a changed config.yaml takes effect too
    as_root "$n" "install -D -m 600 /tmp/routine-k3s-token /etc/rancher/k3s/routine-token" \
      "&& install -D -m 644 /tmp/routine-k3s-config.yaml /etc/rancher/k3s/config.yaml && INSTALL_K3S_VERSION='$version'" \
      "INSTALL_K3S_EXEC=$role INSTALL_K3S_FORCE_RESTART=true sh /tmp/routine-k3s-install.sh >/var/log/routine-k3s-install.log 2>&1;" \
      "rc=\$?; rm -f /tmp/routine-k3s-*; exit \$rc" ||
      fail "vm$n: k3s installation failed – see /var/log/routine-k3s-install.log on vm$n"
    if ((n == 1)); then
      local deadline=$((SECONDS + 180))
      until k get --raw /readyz >/dev/null 2>&1; do
        ((SECONDS < deadline)) || fail "the Kubernetes API on vm1 does not answer – journalctl -u k3s"
        sleep 2
      done
    fi
    wait_node_ready "$n" # servers join one at a time: etcd adds one member after the other
    ok "vm$n: k3s $version $role, ready"
  done

  for n in "${BROKER_NODES[@]}"; do k label node "vm$n" routine/rabbitmq=true --overwrite >/dev/null; done
  k label node "vm$DATA_NODE" routine/data=true --overwrite >/dev/null
  local brokers; printf -v brokers 'vm%s ' "${BROKER_NODES[@]}"
  ok "labels: rabbitmq → ${brokers% }, databases → vm$DATA_NODE"

  if [[ ! -f ~/.kube/config ]]; then # plain `kubectl` for the admin on vm1
    mkdir -p ~/.kube && $SUDO cat /etc/rancher/k3s/k3s.yaml >~/.kube/config && chmod 600 ~/.kube/config
    note "kubeconfig → ~/.kube/config"
  fi
  # k3s' kubectl reads /etc/rancher/k3s/k3s.yaml (root only) unless KUBECONFIG names another file
  if [[ $EUID -ne 0 ]] && ! grep -qs 'KUBECONFIG=' ~/.bashrc; then
    echo "export KUBECONFIG=\$HOME/.kube/config # Routine: kubectl without sudo" >>~/.bashrc
    note "KUBECONFIG in ~/.bashrc – kubectl works without sudo in new shells"
  fi
}

images_present() { # every image of this tag is in the containerd of vm n
  local listed; listed=$(as_root "$1" 'k3s ctr -n k8s.io images ls -q' 2>/dev/null) || return 1
  for image in "${IMAGES[@]}"; do grep -qxF "docker.io/routine/$image:$TAG" <<<"$listed" || return 1; done
}

cmd_images() {
  step "Images (tag $TAG)"
  [[ -n ${ACCESS_CHECKED:-} ]] || cmd_access
  local n missing=()
  for n in "${NODES[@]}"; do images_present "$n" || missing+=("$n"); done
  if ((${#missing[@]} == 0)); then ok "already on every VM"; return; fi

  if ! command -v docker >/dev/null; then # builds only – the cluster runs on k3s' own containerd
    need_tools docker=docker.io
    $SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -yq docker-buildx >/dev/null 2>&1 || true # BuildKit, optional
  fi
  note "building on vm1 – no registry needed: the images are imported on every VM …"
  local service refs=()
  for service in gateway routine-service task-service notification-service integration-worker mock-external; do
    $SUDO docker build -q -f docker/node-service.Dockerfile --build-arg "SERVICE=$service" -t "routine/$service:$TAG" . >/dev/null ||
      fail "build of $service failed"
  done
  $SUDO docker build -q -f docker/keycloak.Dockerfile -t "routine/keycloak:$TAG" . >/dev/null || fail "build of keycloak failed"
  $SUDO docker build -q -t "routine/web:$TAG" web >/dev/null || fail "build of web failed"
  for service in "${IMAGES[@]}"; do refs+=("routine/$service:$TAG"); done
  ok "built ${#refs[@]} images"

  local archive=$WORK/images.tar
  $SUDO docker save "${refs[@]}" >"$archive"
  for n in "${missing[@]}"; do
    copy_to "$n" "$archive" /tmp/routine-images.tar
    as_root "$n" 'k3s ctr -n k8s.io images import /tmp/routine-images.tar >/dev/null; rc=$?; rm -f /tmp/routine-images.tar; exit $rc' ||
      fail "import on vm$n failed"
    ok "imported on vm$n"
  done
}

cmd_render() { # deploy/.generated: overlay on deploy/k8s with the image tag, settings, secrets and configs
  need_tools jq openssl
  load_secrets
  rm -rf "$GENERATED" && mkdir -m 700 "$GENERATED"
  local name
  for name in "${SECRET_NAMES[@]}"; do
    [[ $name == K3S_TOKEN ]] || printf '%s=%s\n' "$name" "${!name}"
  done >"$GENERATED/secrets.env"
  jq --arg password "$RABBITMQ_PASSWORD" '.users |= map(.password = $password)' \
    infra/rabbitmq/definitions.json >"$GENERATED/definitions.json"
  cp infra/rabbitmq/rabbitmq.conf infra/rabbitmq/advanced.config deploy/k8s/rabbitmq-cluster.conf "$GENERATED/"
  # the edge configuration is shared with compose: in the cluster, names resolve through kube-dns – with the
  # full domain, because nginx's resolver ignores the search domains
  sed -e 's/resolver 127\.0\.0\.11 /resolver kube-dns.kube-system.svc.cluster.local /' \
    -e "s/server \(gateway\|keycloak\):/server \1.$NAMESPACE.svc.cluster.local:/" infra/edge/nginx.conf >"$GENERATED/nginx.conf"
  [[ $(grep -c "resolver kube-dns\|\.$NAMESPACE\.svc\.cluster\.local:" "$GENERATED/nginx.conf") == 3 ]] ||
    fail "infra/edge/nginx.conf changed – adapt the rewrite in deploy.sh (cmd_render)"
  {
    echo "# written by deploy/deploy.sh – do not edit, never commit (contains the secrets)"
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "namespace: $NAMESPACE"
    echo "resources: [../k8s]"
    echo "labels: [{ pairs: { app.kubernetes.io/part-of: routine } }]"
    echo "images:"
    for name in "${IMAGES[@]}"; do echo "  - { name: routine/$name, newTag: \"$TAG\" }"; done
    echo "configMapGenerator:"
    echo "  - { name: routine-settings, literals: [PUBLIC_URL=$(public_url)] }"
    echo "  - { name: rabbitmq-config, files: [rabbitmq.conf, rabbitmq-cluster.conf, definitions.json, advanced.config] }"
    echo "  - { name: edge-config, files: [nginx.conf] }"
    echo "secretGenerator:"
    echo "  - { name: routine-secrets, envs: [secrets.env] }"
  } >"$GENERATED/kustomization.yaml"
}

wait_broker_replicated() { # a VM may only fail once every quorum queue has a replica on every broker node
  local n short deadline=$((SECONDS + 300)) api
  api="http://$(ip_of 1):15672/api/queues/%2F?columns=name,members"
  # queues declared while the cluster was still forming start with fewer replicas – add the missing ones now
  # instead of waiting for the broker's periodic reconciliation
  for n in "${BROKER_NODES[@]}"; do
    k -n "$NAMESPACE" exec rabbitmq-1 -- rabbitmq-queues grow "rabbit@rabbitmq-$n.rabbitmq-nodes.$NAMESPACE.svc.cluster.local" all >/dev/null 2>&1 || true
  done
  while ((SECONDS < deadline)); do
    short=$(curl -sf -u "$(rabbit_auth)" "$api" | jq -r '[.[] | select((.members | length) < 3) | .name] | join(" ")') && [[ -z $short ]] && return 0
    printf "\r  %swaiting for replicas: %s%s\033[K" "$dim" "$(cut -c1-100 <<<"${short:-management API not reachable}")" "$reset"
    sleep 3
  done
  echo; fail "quorum queues without 3 replicas: $short"
}

cmd_app() {
  step "Application (images $TAG, $(public_url))"
  need_tools curl
  cmd_render
  local applied resource
  applied=$(k apply -k "$GENERATED" -o name) || fail "kubectl apply failed"
  ok "applied – Kubernetes rolls the services one replica at a time"
  for resource in $(k -n "$NAMESPACE" get statefulset,deployment,daemonset -o name); do
    printf "\r  %swaiting for %s%s\033[K" "$dim" "$resource" "$reset"
    k -n "$NAMESPACE" rollout status "$resource" --timeout=900s >/dev/null ||
      { echo; fail "$resource did not become ready – kubectl -n $NAMESPACE describe $resource"; }
  done
  printf "\r\033[K"; ok "all services ready"
  wait_broker_replicated
  printf "\r\033[K"; ok "every quorum queue has 3 replicas – one per broker VM"
  # generated configs and secrets of earlier versions are no longer referenced
  k -n "$NAMESPACE" get configmap,secret -l app.kubernetes.io/part-of=routine -o name | { grep -vxF "$applied" || true; } |
    while read -r resource; do k -n "$NAMESPACE" delete "$resource" >/dev/null; done
}

cmd_verify() {
  step "Verify: main workflow against $(public_url)"
  need_tools curl jq
  local deadline=$((SECONDS + 120))
  until curl -sf "$(public_url)/edge/health" >/dev/null; do
    ((SECONDS < deadline)) || fail "$(public_url) not reachable – firewall? (see docs/deployment.md)"
    sleep 2
  done
  # what users need first: the sign-in (Keycloak, through the edge) – it is the slowest to start
  deadline=$((SECONDS + 300))
  until curl -sf "$(public_url)/auth/realms/routine/.well-known/openid-configuration" >/dev/null; do
    ((SECONDS < deadline)) || fail "Keycloak does not answer at $(public_url)/auth – kubectl -n $NAMESPACE logs deploy/keycloak"
    sleep 3
  done
  ok "sign-in (Keycloak) answers"
  load_secrets
  GATEWAY=$(public_url) RABBIT=http://$(ip_of 1):15672 RABBIT_AUTH=$(rabbit_auth) bash scripts/demo.sh main
  local n url
  for n in "${NODES[@]}"; do
    url="http://$(ip_of "$n"):8080"
    curl -sf "$url/edge/health" >/dev/null || fail "vm$n does not answer on $url"
    ok "vm$n answers on $url"
  done
}

cmd_status() {
  step "Nodes"
  k get nodes -o wide
  step "Pods"
  k -n "$NAMESPACE" get pods -o wide --sort-by=.spec.nodeName
}

cmd_destroy() {
  step "Remove the application"
  k -n "$NAMESPACE" delete statefulset,deployment,daemonset,service,configmap,secret -l app.kubernetes.io/part-of=routine >/dev/null
  ok "removed – the volumes (data) stay on the VMs; the cluster stays. Uninstall k3s: k3s-uninstall.sh / k3s-agent-uninstall.sh"
}

(($#)) || set -- all
for command in "$@"; do # several in a row, e.g. `deploy.sh images app`
  case "$command" in
    all)
      cmd_access; cmd_cluster; cmd_images; cmd_app; cmd_verify
      printf "\n%sRoutine runs on 4 VMs: %s%s\n" "$bold" "$(public_url)" "$reset"
      note "Keycloak admin console: $(public_url)/auth/admin – user admin, password KEYCLOAK_ADMIN_PASSWORD in $SECRETS"
      ;;
    access) cmd_access ;;
    cluster) cmd_cluster ;;
    images) cmd_images ;;
    app) cmd_app ;;
    verify) cmd_verify ;;
    render) cmd_render; echo "manifests: $GENERATED (kubectl kustomize $GENERATED)" ;;
    status) cmd_status ;;
    destroy) cmd_destroy ;;
    *) sed -n '2,/^# Requirements/p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  esac
done
