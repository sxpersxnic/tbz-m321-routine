# Setting up the four VMs – step by step

A checklist to follow on the VMs by yourself, from start to a working platform. Background, ports, failure
behaviour and operation: [deployment.md](deployment.md).

It starts from four freshly installed VMs that know nothing about each other: steps 1–3 install what is missing,
open the firewall if there is one, and give vm1 SSH access to the other three. Then a single script sets up
Kubernetes and the platform (step 4).

Everything below was run end to end on four Ubuntu 24.04 VMs with the addresses of
[`deploy/cluster.env`](../deploy/cluster.env) ([deployment.md §8](deployment.md#8-tested)) – also with the firewall
on, without `tmux`, and with password login switched off on some VMs. Steps 1–3 take about 15 minutes, the script
about 10.

## 0. What you need

| Check | Why |
| --- | --- |
| Four VMs with Ubuntu 24.04 (22.04 works too), 2 vCPU, 4 GB RAM, 20 GB disk | vm1 builds the images and runs a share of the platform |
| Addresses **10.2.44.17 / .20 / .21 / .28** (vm1–vm4), in one network | Other addresses: note them in step 1, change `deploy/cluster.env` in step 4 |
| One user with `sudo` on every VM, the same name everywhere | Another name on vm2–vm4: `SSH_USER=<name>` in `deploy/cluster.env` |
| You can log in to every VM – SSH from your computer over the VPN, or the console of the VM platform | Steps 1–3 run on each VM |
| Every VM reaches the internet | Ubuntu packages, k3s download (GitHub), images from Docker Hub |

Below, `<user>` is that user's name.

## 1. Prepare each VM – vm1, vm2, vm3 and vm4

Connect the VPN. Log in to the VM (`ssh <user>@10.2.44.20` for vm2, and so on) and paste:

```bash
ip -br -4 addr                                   # this VM's 10.2.44.x address must be listed
sudo apt-get update -q && sudo apt-get install -y openssh-server curl
curl -sI https://get.k3s.io | head -1            # HTTP/2 200 – this VM reaches the internet
date -u                                          # must match the other VMs within a minute
sudo ufw status | head -1                        # "inactive": done with this VM – "active": step 1b
```

| You see | Meaning |
| --- | --- |
| no 10.2.44.x address | The VM has another address – note it for `deploy/cluster.env` (step 4). It must be in the same network as the others |
| `curl` prints nothing or an error | No internet on this VM – the platform cannot be installed; ask whoever runs the VM network |
| the time is off by more than a minute | `sudo timedatectl set-ntp true`, or ask for NTP – the cluster's certificates need the same time everywhere |

### 1b. Only if the firewall is active

The VMs must reach each other on every port, and you must reach the platform. Paste on that VM:

```bash
sudo ufw allow OpenSSH                # keep your own login
sudo ufw allow from 10.2.44.0/24      # the other VMs: Kubernetes API, etcd, kubelet, pod network (8472/udp)
sudo ufw allow from 10.42.0.0/16      # pods
sudo ufw allow from 10.43.0.0/16      # Kubernetes services
sudo ufw allow 8080/tcp               # Routine (UI and API)
sudo ufw allow 15672/tcp              # RabbitMQ management – admins
sudo ufw allow 16686/tcp              # Jaeger – admins, no login: keep it inside the VPN
sudo ufw reload && sudo ufw status | head -1
```

## 2. Give vm1 access to the other VMs

`deploy.sh` runs on vm1 and installs vm2–vm4 over SSH, with a key instead of a password. Log in to **vm1** and
create its key (once):

```bash
sudo apt-get install -y git tmux
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
for ip in 10.2.44.20 10.2.44.21 10.2.44.28; do ssh-copy-id -i ~/.ssh/id_ed25519.pub "$USER@$ip"; done
```

For every VM, `ssh-copy-id` asks `Are you sure you want to continue connecting (yes/no…)?` – type `yes` – and
then for your password on that VM.

**If it says `Permission denied (publickey)`**, that VM allows no password logins. Copy the key from **your
computer** instead, which can log in everywhere – once per such VM (here vm2):

```bash
ssh <user>@10.2.44.17 cat .ssh/id_ed25519.pub |
  ssh <user>@10.2.44.20 'mkdir -p -m 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

(Only a console, no SSH from your computer? On vm1 `cat ~/.ssh/id_ed25519.pub`, and add that one line to
`~/.ssh/authorized_keys` on the other VM.)

**Check on vm1** – three host names, no password question:

```bash
for ip in 10.2.44.20 10.2.44.21 10.2.44.28; do
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ip" hostname || echo "$ip: NO KEY ACCESS"
done
```

## 3. Pre-flight on vm1

Still on vm1, start a `tmux` session: the deployment keeps running if the VPN or your SSH connection drops.

```bash
tmux new -s deploy
```

| tmux | Keys |
| --- | --- |
| Leave it running in the background | `Ctrl-b`, then `d` |
| Back in (also after a dropped connection: log in to vm1 again) | `tmux attach -t deploy` |
| Scroll up | `Ctrl-b`, then `[` – arrow keys, `q` to stop |

Then paste this. Every line must end in `ok`, or HTTP 200/401:

```bash
ip -br -4 addr | grep -q ' 10.2.44.17/' && echo "vm1 address ok"
for ip in 10.2.44.20 10.2.44.21 10.2.44.28; do ping -c1 -W2 $ip >/dev/null && echo "$ip ok" || echo "$ip NOT REACHABLE"; done
curl -sI https://get.k3s.io | head -1                  # HTTP/2 200 – internet
curl -sI https://registry-1.docker.io/v2/ | head -1    # HTTP/2 401 – Docker Hub reachable (401 is right)
sudo -v && echo "sudo ok"
```

`NOT REACHABLE`: the VMs are not in one network, or a firewall between them (outside the VMs) blocks them – that
is the VM platform's network configuration, not something on the VMs.

## 4. Clone and run

```bash
git clone https://github.com/sxpersxnic/tbz-m321-routine.git routine
cd routine
deploy/deploy.sh
```

Other addresses than 10.2.44.17/.20/.21/.28? Before `deploy/deploy.sh`, edit them in `deploy/cluster.env`
(`nano deploy/cluster.env`) – they also go into the URLs below.

It asks for passwords at the start, then runs on its own:

| Prompt | Type |
| --- | --- |
| `[sudo] password for <user>:` | your password on vm1 |
| `sudo password of <user> on the VMs:` | your sudo password on vm2–vm4 (once; kept in memory only) – only if `sudo` there needs a password |
| `<user>@10.2.44.20's password:` | only if you skipped step 2: the script copies vm1's key itself, where password login is allowed |

If a step takes longer than 15 minutes, `sudo` on vm1 may ask once more. The steps you will see:

```text
▶ Access from vm1 to vm2–vm4         ✔ vm2 … vm4: SSH and sudo
▶ Kubernetes (k3s)                    ✔ vm1 … vm4: k3s v1.36.5+k3s1 server/agent, ready     (~3 min)
▶ Images (tag …)                      ✔ built 8 images, ✔ imported on vm1 … vm4            (~4 min)
▶ Application                         ✔ all services ready, ✔ every quorum queue has 3 replicas  (~3 min)
▶ Verify                              ✔ main workflow succeeded, ✔ vm1 … vm4 answer on :8080
Routine runs on 4 VMs: http://10.2.44.17:8080
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
| Routine | **http://10.2.44.17:8080** – exactly this address | "Try the demo" (`demo@routine.local` / `demo12345`) |
| RabbitMQ | http://10.2.44.17:15672 | `routine` / `RABBITMQ_PASSWORD` |
| Jaeger | http://10.2.44.17:16686 | – |
| Keycloak admin | http://10.2.44.17:8080/auth/admin | `admin` / `KEYCLOAK_ADMIN_PASSWORD` |

Sign in through vm1's address only: Keycloak sends you back only to `PUBLIC_URL` (`http://10.2.44.17:8080`).
The other VMs serve the same platform on :8080 for API calls and a load balancer.

For the demo scenarios (self-healing, scaling, a VM failing) see [deployment.md §5](deployment.md#5-operation). In a
new shell on vm1, plain `kubectl` works (`kubectl -n routine get pods -o wide`).

## 7. If something fails

Read the line with ✘, fix the cause, run `deploy/deploy.sh` again – every step is safe to repeat and skips what
is already done.

| ✘ message | What to do |
| --- | --- |
| `this machine is not vm1` | You are on another VM, or vm1 has another address – fix `deploy/cluster.env` |
| `vmN: no SSH access` | Step 2 for that VM – the check there must print its host name. Other user name on that VM → `SSH_USER` in `deploy/cluster.env` |
| `vmN: k3s installation failed` | On that VM: `sudo tail -30 /var/log/routine-k3s-install.log` – usually no internet on that VM |
| `vmN did not become ready` | On that VM: `sudo journalctl -u k3s -n 50` (vm4: `-u k3s-agent`) – usually the firewall: `sudo ufw status` on every VM, step 1b |
| `build of … failed` | `df -h /` and `free -m` on vm1 (disk, memory), Docker Hub reachable (step 3) |
| `… did not become ready` (app step) | `kubectl -n routine get pods -o wide`. Pods that keep restarting only on some VMs: traffic between the VMs is blocked – firewall, step 1b. Details: `kubectl -n routine describe pod <pod>`, `kubectl -n routine logs <pod>` |
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

## 8. Start over

| Goal | Command |
| --- | --- |
| Deploy a new version | `git pull && deploy/deploy.sh images app` |
| Remove the application, keep the data | `deploy/deploy.sh destroy` (back with `deploy/deploy.sh app`) |
| Remove everything, data included | on vm1–vm3 `sudo /usr/local/bin/k3s-uninstall.sh`, on vm4 `sudo /usr/local/bin/k3s-agent-uninstall.sh`, then `deploy/deploy.sh` again |
