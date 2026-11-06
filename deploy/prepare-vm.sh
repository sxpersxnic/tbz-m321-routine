#!/usr/bin/env bash
# Routine – prepares one VM for the Kubernetes deployment (docs/deployment-guide.md). Safe to run again.
#
#   vm2–vm4:  the line `deploy/deploy.sh key` prints on vm1 – it runs this script with vm1's public key:
#             curl -fsSL <url of this script> | sudo bash -s -- '<vm1 public key>'
#   vm1:      sudo deploy/prepare-vm.sh            (no key: vm1 is where deploy.sh runs)
#
# - installs openssh-server, curl, git and tmux
# - with a key: creates the user `routine`, which logs in with that key only (no password) and may use sudo
#   without a password – deploy.sh on vm1 installs Kubernetes through it
# - if the firewall (ufw) is active: opens what the cluster needs; an inactive firewall stays as it is
set -euo pipefail

KEY=${1:-}
DEPLOY_USER=routine
SUBNET=${SUBNET:-10.2.44.0/24} # the VMs (deploy/cluster.env)

green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
ok()   { printf "  %s✔ %s%s\n" "$green" "$*" "$reset"; }
fail() { printf "  %s✘ %s%s\n" "$red" "$*" "$reset" >&2; exit 1; }

((EUID == 0)) || fail "run it with sudo"
[[ -z $KEY || $KEY == ssh-* ]] || fail "the argument must be vm1's public key (ssh-ed25519 AAAA…), as deploy.sh key prints it"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
apt-get update -q >/dev/null || fail "apt-get update failed – does this VM reach the internet?"
apt-get install -yq openssh-server curl git tmux >/dev/null || fail "apt-get install failed"
ok "packages: openssh-server curl git tmux"

if [[ -n $KEY ]]; then
  id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/routine-deploy
  chmod 440 /etc/sudoers.d/routine-deploy
  visudo -cqf /etc/sudoers.d/routine-deploy || { rm -f /etc/sudoers.d/routine-deploy; fail "sudoers entry invalid"; }
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  touch "$home/.ssh/authorized_keys"
  grep -qxF "$KEY" "$home/.ssh/authorized_keys" || echo "$KEY" >>"$home/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys" && chmod 600 "$home/.ssh/authorized_keys"
  ok "user $DEPLOY_USER: logs in with vm1's key, sudo without password"
fi

if ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow OpenSSH >/dev/null
  ufw allow from "$SUBNET" >/dev/null # the other VMs: Kubernetes API, etcd, kubelet, pod network (8472/udp)
  ufw allow from 10.42.0.0/16 >/dev/null # pods
  ufw allow from 10.43.0.0/16 >/dev/null # Kubernetes services
  ufw allow 8080/tcp >/dev/null # Routine (UI and API)
  ufw allow 15672/tcp >/dev/null # RabbitMQ management – admins
  ufw allow 16686/tcp >/dev/null # Jaeger – admins, no login: keep it inside the VPN
  ok "firewall (ufw) is on: opened for the cluster ($SUBNET, pods, :8080, :15672, :16686)"
else
  ok "firewall (ufw) is off – nothing to open"
fi

curl -sSf -o /dev/null https://get.k3s.io || fail "no internet (get.k3s.io) – Kubernetes cannot be installed here"
ok "internet reachable"
printf "\n%s%s is ready – addresses: %s%s\n" "$green" "$(hostname)" "$(hostname -I)" "$reset"
