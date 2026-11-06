# Setting up the three VMs – step by step

One way, from three freshly installed VMs to the running platform. Background, ports and failure behaviour:
[deployment.md](deployment.md).

| Who | VM | Does |
| --- | --- | --- |
| **You** | vm1 – 10.2.44.21 | everything: vm1 is the control plane and installs the other VMs over SSH |
| **Your teammates** | vm2 – 10.2.44.20, vm3 – 10.2.44.17 | paste **one line** you send them (step 2) |

You never need your teammates' passwords: the line gives vm1's key access to their VM.

What the VMs need: Ubuntu 24.04 (22.04 works too), 2 vCPU, 4 GB RAM, 20 GB disk, internet access, and a user with
`sudo` on each. Tested end to end, with the firewall on and without anything preinstalled
([deployment.md §8](deployment.md#8-tested)) – about 25 minutes in total.

## 1. You, on vm1: get the code and the line for your teammates

Connect the VPN, log in to vm1, then paste:

```bash
sudo apt-get install -y git
git clone https://github.com/sxpersxnic/tbz-m321-routine.git routine
cd routine
sudo deploy/prepare-vm.sh
deploy/deploy.sh key
```

`prepare-vm.sh` installs what vm1 needs (`curl`, `tmux`) and opens the firewall if it is on. `deploy.sh key`
creates vm1's SSH key and prints one line, like this:

```text
curl -fsSL https://raw.githubusercontent.com/…/deploy/prepare-vm.sh | sudo bash -s -- 'ssh-ed25519 AAAA… routine-deploy@vm1'
```

**Send that line to your teammates** (chat is fine – it holds only vm1's *public* key).

## 2. Your teammates, on vm2 and vm3: paste the line

Each teammate logs in to their VM as usual, pastes the line and types their own `sudo` password. It ends with:

```text
  ✔ packages: openssh-server curl git tmux
  ✔ user routine: logs in with vm1's key, sudo without password
  ✔ firewall (ufw) is off – nothing to open          (or: is on: opened for the cluster …)
  ✔ internet reachable

vm2 is ready – addresses: 10.2.44.20 …
```

That is all they do. The line creates a user `routine` on their VM that only vm1's key can log in to, and that
`deploy.sh` uses to install Kubernetes there. It is safe to run again.

## 3. You, on vm1: check the access

```bash
deploy/deploy.sh access
```

```text
▶ Access from vm1 to vm2 and vm3 (user routine)
[sudo] password for <you>:                 ← your password on vm1
  ✔ vm2 (10.2.44.20): SSH and sudo
  ✔ vm3 (10.2.44.17): SSH and sudo
```

`✘ vm3: no SSH access …` – the line has not run on vm3 yet, or it failed there: ask that teammate for the output
of step 2.

## 4. You, on vm1: deploy

Start `tmux` first: the deployment keeps running even if the VPN or your SSH connection drops.

```bash
tmux new -s deploy
deploy/deploy.sh
```

| tmux | Keys |
| --- | --- |
| Back in after a dropped connection (log in to vm1 again first) | `tmux attach -t deploy` |
| Leave it running in the background | `Ctrl-b`, then `d` |
| Scroll up | `Ctrl-b`, then `[` – arrow keys, `q` to stop |

It may ask for your `sudo` password on vm1, nothing else. Then it runs on its own, about 10 minutes:

```text
▶ Access from vm1 to vm2 and vm3    ✔ vm2, vm3: SSH and sudo
▶ Kubernetes (k3s)                    ✔ vm1 … vm3: k3s v1.36.5+k3s1 server, ready           (~3 min)
▶ Images (tag …)                      ✔ built 8 images, ✔ imported on vm1 … vm3            (~4 min)
▶ Application                         ✔ all services ready, ✔ every quorum queue has 3 replicas  (~3 min)
▶ Verify                              ✔ main workflow succeeded, ✔ vm1 … vm3 answer on :8080
Routine runs on 3 VMs: http://10.2.44.21:8080
```

## 5. Keep the secrets file

```bash
cat deploy/cluster.secrets.env
```

Copy the content to your password manager. The databases accept only these passwords – if the file is lost, the
services can no longer reach their data. It also holds the passwords for RabbitMQ (`RABBITMQ_PASSWORD`, user
`routine`) and the Keycloak admin console (`KEYCLOAK_ADMIN_PASSWORD`, user `admin`).

## 6. Open it in your browser

With the VPN connected:

| What | Address | Login |
| --- | --- | --- |
| Routine | **http://10.2.44.21:8080** – exactly this address | "Try the demo" (`demo@routine.local` / `demo12345`) |
| RabbitMQ | http://10.2.44.21:15672 | `routine` / `RABBITMQ_PASSWORD` |
| Jaeger | http://10.2.44.21:16686 | – |
| Keycloak admin | http://10.2.44.21:8080/auth/admin | `admin` / `KEYCLOAK_ADMIN_PASSWORD` |

Sign in through vm1's address only: Keycloak sends you back only to `http://10.2.44.21:8080`.

For the demo scenarios (self-healing, scaling, a VM failing) see [deployment.md §5](deployment.md#5-operation). In a
new shell on vm1, plain `kubectl` works (`kubectl -n routine get pods -o wide`).

## 7. If something fails

Read the line with ✘, fix the cause, run `deploy/deploy.sh` again – every step is safe to repeat and skips what
is already done.

| ✘ message | What to do |
| --- | --- |
| `this machine is not vm1` | You are on another VM, or vm1 has another address than in `deploy/cluster.env` |
| `vmN: no SSH access` | Step 2 has not run on that VM, or failed there – ask that teammate |
| `vmN: k3s installation failed` | That VM: `sudo tail -30 /var/log/routine-k3s-install.log` – usually no internet there |
| `vmN did not become ready` | That VM: `sudo journalctl -u k3s -n 50` – usually a firewall: step 2's line again on that VM |
| `build of … failed` | On vm1: `df -h /` and `free -m` (disk, memory) |
| `… did not become ready` (app step) | `kubectl -n routine get pods -o wide`. Pods that keep restarting only on some VMs: traffic between the VMs is blocked (firewall). Details: `kubectl -n routine describe pod <pod>`, `kubectl -n routine logs <pod>` |
| `exceeded its progress deadline` | A service waited more than 10 minutes, e.g. while the network was broken. Once the cause is fixed, run `deploy/deploy.sh` again |
| `Keycloak does not answer` (verify) | Keycloak is slow on its first start – wait a minute, `deploy/deploy.sh verify` |
| Browser: "Invalid redirect uri" | Open exactly `http://10.2.44.21:8080` |
| `vmN: … GB free on /var/lib, needs … GB` | [No space left on device](#no-space-left-on-device) |
| `vmN: ports 8080 15672 16686 are held by docker-proxy` | [Ports held by docker-proxy](#ports-held-by-docker-proxy) |
| Browser: black page, console `ERR_CONTENT_LENGTH_MISMATCH` | A full disk (nginx cannot buffer the large JavaScript file and cuts it off), or an old `docker compose` stack answers instead of the cluster – `deploy/deploy.sh access` names which |

### No space left on device

A VM with 20 GB fills up when it also keeps Docker images and stacks from testing. Symptoms: `sudo journalctl -u k3s
-n 20` ends in `no space left on device` and k3s restarts every 5 seconds; the browser gets cut-off files. On that VM:

```bash
df -h /var/lib
```

```bash
sudo du -xh --max-depth=2 /var/lib 2>/dev/null | sort -h | tail -8
```

Usually `/var/lib/docker` is the largest. Docker is only used for building – the cluster runs on k3s' own
containerd, so this frees space without touching the cluster (an old compose stack must be removed first, below):

```bash
sudo docker image prune -af && sudo docker builder prune -af
```

Why `deploy.sh` asks for 20 % free (on vm1 5 GB more, for building the images): below 15 % Kubernetes marks the VM as
out of disk and evicts its pods. k3s starts again by itself within seconds once there is space. Check with `kubectl get nodes`, then run
`deploy/deploy.sh` again.

### Ports held by docker-proxy

A `docker compose up` from testing still runs on that VM and holds :8080 (and :15672, :16686) – the browser sees that
stack, not the cluster. Remove its containers (`tbz-m321-routine` is the folder name the stack was started from –
`sudo docker ps` shows it as the prefix of the container names):

```bash
sudo docker ps -aq --filter label=com.docker.compose.project=tbz-m321-routine | xargs -r sudo docker rm -f
```

On vm2 or vm3 you don't need your teammate: vm1 reaches them as `routine` (step 2), e.g. for vm2:

```bash
ssh routine@10.2.44.20 "sudo docker ps -aq --filter label=com.docker.compose.project=tbz-m321-routine | xargs -r sudo docker rm -f"
```

Its volumes hold that stack's test data (not the cluster's). They take space; remove them once you don't need them:

```bash
sudo docker volume ls -q --filter label=com.docker.compose.project=tbz-m321-routine | xargs -r sudo docker volume rm
```

More symptoms and their causes: [deployment.md §9](deployment.md#9-troubleshooting).

**Stuck?** Collect the state into one file, copy it to your computer while the VPN is still up, and analyse it
later (e.g. with Claude Code, once you are off the VPN):

```bash
# on vm1, in ~/routine
{ deploy/deploy.sh status; kubectl -n routine get events --sort-by=.lastTimestamp | tail -60
  kubectl -n routine logs -l app=keycloak --tail=40 --prefix; } >~/routine-diagnosis.txt 2>&1
# on your computer
scp <you>@10.2.44.21:routine-diagnosis.txt .
```

## 8. Later

| Goal | On vm1, in ~/routine |
| --- | --- |
| Deploy a new version | `git pull && deploy/deploy.sh images app` |
| Remove the application, keep the data | `deploy/deploy.sh destroy` (back with `deploy/deploy.sh app`) |
| Remove everything, data included | on vm1–vm3 `sudo /usr/local/bin/k3s-uninstall.sh`, then `deploy/deploy.sh` again |
