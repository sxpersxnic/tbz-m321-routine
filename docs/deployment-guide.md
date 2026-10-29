# Setting up the four VMs – step by step

A checklist to follow on the VMs by yourself, from start to a working platform. Background, ports, failure
behaviour and operation: [deployment.md](deployment.md).

Everything below was run end to end on four Ubuntu 24.04 VMs with the addresses of
[`deploy/cluster.env`](../deploy/cluster.env) ([deployment.md §8](deployment.md#8-tested)). On fresh VMs it takes
about **10 minutes**, and you type passwords only at the start.

## 0. Before you start

| Check | Why |
| --- | --- |
| Four VMs with Ubuntu 24.04 (22.04 works too), 2 vCPU, 4 GB RAM, 20 GB disk | vm1 builds the images and runs a share of the platform |
| Addresses **10.2.44.17 / .20 / .21 / .28** (vm1–vm4) | Other addresses: change them in `deploy/cluster.env` after the clone (step 3) |
| One user with `sudo` on all four VMs, same name everywhere | Another name on vm2–vm4: `SSH_USER=<name>` in `deploy/cluster.env` |
| On vm2–vm4, SSH login with a password is allowed | The first run copies vm1's key to them. If only keys are allowed, copy `~/.ssh/id_ed25519.pub` of vm1 there yourself |
| Every VM reaches the internet | k3s download (GitHub), images from Docker Hub, Ubuntu packages |
| No firewall between the VMs, or the ports of [deployment.md §3](deployment.md#3-requirements) open | Above all **8472/udp** – all traffic between the services on different VMs |

## 1. Log in to vm1

Connect the VPN, then from your computer:

```bash
ssh <user>@10.2.44.17
tmux new -s deploy        # keeps the run going if the VPN or SSH connection drops – back in: tmux attach -t deploy
```

## 2. Pre-flight (one minute, catches most problems)

Paste this on vm1. Every line must end in `ok`, or HTTP 200/401:

```bash
ip -br -4 addr | grep -q ' 10.2.44.17/' && echo "vm1 address ok"
for ip in 10.2.44.20 10.2.44.21 10.2.44.28; do ping -c1 -W2 $ip >/dev/null && echo "$ip ok" || echo "$ip NOT REACHABLE"; done
curl -sI https://get.k3s.io | head -1                  # HTTP/2 200 – internet
curl -sI https://registry-1.docker.io/v2/ | head -1    # HTTP/2 401 – Docker Hub reachable (401 is right)
sudo -v && echo "sudo ok"
command -v git >/dev/null && echo "git ok" || sudo apt-get install -y git
```

## 3. Clone and run

```bash
git clone https://github.com/sxpersxnic/tbz-m321-routine.git routine
cd routine
deploy/deploy.sh
```

It asks for passwords at the start, then runs on its own:

| Prompt | Type |
| --- | --- |
| `[sudo] password for <user>:` | your password on vm1 |
| `<user>@10.2.44.20's password:` (then `.21`, `.28`) | your password on that VM – only on the first run, it installs vm1's SSH key there |
| `sudo password of <user> on the VMs:` | your sudo password on vm2–vm4 (once; kept in memory only) |

If a step takes longer than 15 minutes, `sudo` on vm1 may ask once more. The steps you will see:

```text
▶ Access from vm1 to vm2–vm4         ✔ vm2 … vm4: SSH and sudo
▶ Kubernetes (k3s)                    ✔ vm1 … vm4: k3s v1.36.5+k3s1 server/agent, ready     (~3 min)
▶ Images (tag …)                      ✔ built 8 images, ✔ imported on vm1 … vm4            (~4 min)
▶ Application                         ✔ all services ready, ✔ every quorum queue has 3 replicas  (~3 min)
▶ Verify                              ✔ main workflow succeeded, ✔ vm1 … vm4 answer on :8080
Routine runs on 4 VMs: http://10.2.44.17:8080
```

## 4. Keep the secrets file

```bash
cat deploy/cluster.secrets.env
```

Copy the content to your password manager. The databases accept only these passwords – if the file is lost, the
services can no longer reach their data. It also holds the passwords for RabbitMQ (`RABBITMQ_PASSWORD`, user
`routine`) and the Keycloak admin console (`KEYCLOAK_ADMIN_PASSWORD`, user `admin`).

## 5. Open it in your browser

With the VPN connected:

| What | Address | Login |
| --- | --- | --- |
| Routine | **http://10.2.44.17:8080** – exactly this address | "Try the demo" (`demo@routine.local` / `demo12345`) |
| RabbitMQ | http://10.2.44.17:15672 | `routine` / `RABBITMQ_PASSWORD` |
| Jaeger | http://10.2.44.17:16686 | – |
| Keycloak admin | http://10.2.44.17:8080/auth/admin | `admin` / `KEYCLOAK_ADMIN_PASSWORD` |

Sign in through vm1's address only: Keycloak sends you back only to `PUBLIC_URL` (`http://10.2.44.17:8080`).
The other VMs serve the same platform on :8080 for API calls and a load balancer.

For the demo scenarios (self-healing, scaling, a VM failing) see [deployment.md §5](deployment.md#5-operation). In a
new shell on vm1, plain `kubectl` works (`kubectl -n routine get pods -o wide`).

## 6. If something fails

Read the line with ✘, fix the cause, run `deploy/deploy.sh` again – every step is safe to repeat and skips what
is already done.

| ✘ message | What to do |
| --- | --- |
| `this machine is not vm1` | You are on another VM, or vm1 has another address – fix `deploy/cluster.env` |
| `vmN: SSH login as <user> failed` | Try `ssh <user>@<address>` yourself. Password login off → copy vm1's `~/.ssh/id_ed25519.pub` into `~/.ssh/authorized_keys` on that VM. Other user name → `SSH_USER` in `deploy/cluster.env` |
| `vmN: k3s installation failed` | On that VM: `sudo tail -30 /var/log/routine-k3s-install.log` – usually no internet on that VM |
| `vmN did not become ready` | On that VM: `sudo journalctl -u k3s -n 50` (vm4: `-u k3s-agent`) – usually a blocked port between the VMs (6443, 2379–2380, 10250, 8472/udp) |
| `build of … failed` | `df -h /` and `free -m` on vm1 (disk, memory), Docker Hub reachable (step 2) |
| `… did not become ready` (app step) | `kubectl -n routine get pods -o wide`. Pods that keep restarting only on some VMs: traffic between the VMs is blocked (8472/udp). Details: `kubectl -n routine describe pod <pod>`, `kubectl -n routine logs <pod>` |
| `exceeded its progress deadline` | A service waited more than 10 minutes, e.g. while the network was broken. Once the cause is fixed, run `deploy/deploy.sh` again |
| `Keycloak does not answer` (verify) | Keycloak is slow on its first start – wait a minute, `deploy/deploy.sh verify` |
| Browser: "Invalid redirect uri" | Open exactly `http://10.2.44.17:8080` |
| Browser: "HTTPS required" | The VMs have public addresses – see [deployment.md §9](deployment.md#9-troubleshooting) |

More symptoms and their causes: [deployment.md §9](deployment.md#9-troubleshooting).

**Stuck?** Collect the state into one file, copy it to your computer while the VPN is still up, and analyse it
later (e.g. with Claude Code, once you are off the VPN):

```bash
# on vm1
{ deploy/deploy.sh status; kubectl -n routine get events --sort-by=.lastTimestamp | tail -60
  kubectl -n routine logs -l app=keycloak --tail=40 --prefix; } >~/routine-diagnosis.txt 2>&1
# on your computer
scp <user>@10.2.44.17:routine-diagnosis.txt .
```

## 7. Start over

| Goal | Command |
| --- | --- |
| Deploy a new version | `git pull && deploy/deploy.sh images app` |
| Remove the application, keep the data | `deploy/deploy.sh destroy` (back with `deploy/deploy.sh app`) |
| Remove everything, data included | on vm1–vm3 `sudo /usr/local/bin/k3s-uninstall.sh`, on vm4 `sudo /usr/local/bin/k3s-agent-uninstall.sh`, then `deploy/deploy.sh` again |
