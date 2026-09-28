#!/usr/bin/env bash
# Three simulated VMs on your machine (Docker-in-Docker) – rehearse the 3-VM deployment without real VMs.
#
#   deploy/local-vms.sh up     start vm1..vm3 and write deploy/local-vms.env
#   INVENTORY=deploy/local-vms.env deploy/deploy.sh
#   deploy/local-vms.sh down   remove the simulated VMs (and everything deployed on them)
#
# Each "VM" is a privileged docker:dind container with its own Docker daemon on the network routine-vms.
# Every port is bound to 127.0.0.1 only: the dind daemons accept unauthenticated API calls, and nothing of
# the simulation should be reachable from your network.
# In front of them runs a load balancer (like a cloud LB in front of real VMs) – the UI/API is reached
# through it: http://localhost:18080, Jaeger http://localhost:26686.
# From your machine: vmN's Docker on tcp://127.0.0.1:2375N, its RabbitMQ management on http://localhost:2567N.
# (Docker Desktop cannot forward a host port reliably into the swarm routing mesh of a dind container,
#  hence the load balancer instead of publishing :8080 of every VM.)
set -euo pipefail
cd "$(dirname "$0")/.."
NETWORK=routine-vms
INVENTORY=deploy/local-vms.env

up() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  for n in 1 2 3; do
    if [[ -z $(docker ps -aq --filter "name=^routine-vm$n\$") ]]; then
      docker run -d -q --privileged --name "routine-vm$n" --hostname "vm$n" --network "$NETWORK" --network-alias "vm$n" \
        -e DOCKER_TLS_CERTDIR= -v "routine-vm$n:/var/lib/docker" \
        -p "127.0.0.1:2375$n:2375" -p "127.0.0.1:2567$n:15672" \
        docker:dind >/dev/null
    else
      docker start "routine-vm$n" >/dev/null
    fi
  done
  for n in 1 2 3; do
    until DOCKER_HOST="tcp://127.0.0.1:2375$n" docker info >/dev/null 2>&1; do sleep 1; done
  done
  if [[ -z $(docker ps -aq --filter name=^routine-vms-lb\$) ]]; then
    docker run -d -q --name routine-vms-lb --network "$NETWORK" -p 127.0.0.1:18080:8080 -p 127.0.0.1:26686:16686 \
      -v "$PWD/deploy/local-vms-lb.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.29-alpine >/dev/null
  else
    docker start routine-vms-lb >/dev/null
  fi
  {
    echo "# written by deploy/local-vms.sh – simulated VMs (Docker-in-Docker)"
    for n in 1 2 3; do
      echo "VM$n=vm$n"
      echo "VM${n}_DOCKER=tcp://127.0.0.1:2375$n"
      echo "VM${n}_ADDR=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "routine-vm$n")"
    done
    echo "PUBLIC_URL=http://localhost:18080"
    echo "RABBIT_URL=http://localhost:25671"
  } >"$INVENTORY"
  echo "3 simulated VMs running – next: INVENTORY=$INVENTORY deploy/deploy.sh"
}

down() {
  docker rm -f routine-vms-lb routine-vm1 routine-vm2 routine-vm3 >/dev/null 2>&1 || true
  docker volume rm routine-vm1 routine-vm2 routine-vm3 >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$INVENTORY"
  echo "simulated VMs removed"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) sed -n '2,/^# Each/p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
