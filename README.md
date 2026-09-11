# devbox VM Manager

A local control panel for the QEMU headless Linux VMs on this machine.
No admin rights, no Hyper-V, no WSL, no `npm install` — Node standard library only.

## Run it

Double-click **`vm-manager.cmd`**, or:

```
%USERPROFILE%\vm-manager\vm-manager.cmd
```

It opens a console window (keep it open — that IS the server) and launches the GUI
at <http://127.0.0.1:8777/>.

## What the GUI does

**Host** — live memory and disk meters.

**Prerequisites** — detects what's missing and installs it on demand:
QEMU (downloaded and unpacked with 7-Zip, no installer), SSH key (generated),
Alpine guest image, and the golden base (built by booting the guest once under
cloud-init, installing a toolchain, then freezing it).

**VM templates (base images)** — every sandbox is an instant copy-on-write clone of
a template, so creating one costs ~200 KB and no boot-time configuration.

| Template | Purpose |
|---|---|
| `devbox-base` | Alpine + toolchain (Python, git, gcc, bash, jq, …) |
| `docker-ready` | the same, **plus Docker installed and running** |

- **New VM from this** — clones a template.
- **Freeze** (Settings tab) — turns a configured sandbox into a new template,
  flattening the backing chain so it is standalone. This is how `docker-ready`
  was made: install Docker once in a sandbox, freeze it, and every later sandbox
  has Docker at boot.

**Sandboxes** — start / stop / manage, with live status (`stopped` → `booting` →
`running`, where `running` means a real **sshd banner** was read, not just that a
process exists).

**VM detail panel** — five tabs per sandbox:

| Tab | Contents |
|---|---|
| **Overview** | status, SSH command, MAC, resources, disk, template, ports, uptime |
| **Settings** | memory, vCPUs, autostart, note, extra port mappings, disk resize, grow filesystem, freeze as template, delete |
| **Docker** | install Docker; containers (start/stop/restart/remove/logs); images (pull, remove); run a container; deploy a compose project; networks and volumes |
| **Network** | every host→guest forward across all VMs, with listening state, owning PID, and conflict detection |
| **Terminal** | interactive browser shell (xterm.js) + the read-only serial log |

### Rules the UI enforces

- Memory, vCPUs and port mappings require the VM **stopped** (QEMU fixes them at launch).
- Disk resize is two steps: **Resize disk** while stopped, then start and **Grow filesystem**.
- Port specs are validated server-side — malformed entries, duplicates, and anything
  colliding with the SSH port are rejected.
- **Autostart** VMs are started when the manager launches.

### The in-page terminal

The system `ssh.exe` is the transport. Its stdio is bridged to the browser over
`text/event-stream` for output and `POST` for input:

```
POST /api/vm/console          -> { session }      spawns ssh -tt into the guest
GET  /api/vm/console/stream   -> SSE of stdout/stderr
POST /api/vm/console/input    -> { id, data }     keystrokes to the guest
POST /api/vm/console/close    -> { id }           ends the ssh client
```

Closing the browser tab ends the SSH **client** and never affects the VM — unlike
driving a QEMU console window, where closing the window kills the VM.

xterm.js is vendored under `public/vendor/` so the GUI works offline.

### Deep links

```
/?vm=<name>&tab=<overview|settings|docker|network|terminal>
/?console=<name>          straight into an interactive shell
```

## Other API endpoints

```
GET  /api/state                     host, VMs, templates, prereqs, task
GET  /api/network                   all port forwards + conflicts
GET  /api/vm/docker?name=           containers, images, networks, volumes
GET  /api/vm/docker/logs?name=&container=
POST /api/vm/create|start|stop|delete|ports|settings|resize|growfs|freeze
POST /api/vm/docker/install|pull|run|action|rmi
POST /api/vm/compose                { name, project, yaml }
GET  /api/log?name=                 serial log tail
GET  /api/task                      progress of the current long operation
```

## Running services (Docker, web apps)

Containers need kernel namespaces and cgroups, **not** hardware virtualization, so
these guests run Docker normally despite the host having no nested virt.
Verified: `Server Version 27.3.1`, `overlay2`, `cgroup v2`, on `6.12.81-0-virt`.

Reaching a service from Windows: add a **host→guest** port mapping in Settings
(e.g. `2283:2283`), start the VM, then browse to `http://127.0.0.1:2283`.
Container `-p` ports are *inside* the guest — they need a matching host mapping too.

### Sizing guidance

CPU is **emulated** (~15-30% of native) and RAM is the binding constraint — the host
has ~8.6 GB total.

| Stack | Verdict |
|---|---|
| Light services (nginx, Gitea, Postgres, Redis, small APIs) | comfortable at 1-2 GB |
| Multi-container apps (Immich, Nextcloud) | 3-4 GB; run one at a time on this host |
| CPU-heavy inference (Immich machine-learning, Whisper) | not viable — disable it |

### Known-good example: Immich

`immich` VM, 3 GB / 4 vCPU / 23 GB disk, ports `2283:2283`. Deployed from the
official compose file with `IMMICH_MACHINE_LEARNING_ENABLED=false`. Postgres and
valkey come up healthy in seconds; `immich_server` takes **~10 minutes** to become
healthy on an emulated CPU (it runs full DB migrations). That is not a hang —
`docker stats` shows 200%+ CPU while it works.

Two traps worth remembering:

1. **`/etc/localtime` must be a real file.** Alpine doesn't ship it, so Docker
   creates the bind-mount source as a **directory**, and container creation then
   fails with `cannot create subdirectories in ".../usr/share/zoneinfo/..."`.
   Fix inside the guest: `rmdir /etc/localtime; cp /usr/share/zoneinfo/UTC /etc/localtime`.
   The manager applies this automatically before every compose deploy, so deploys
   are repeatable.
2. **A pull that looks stuck isn't.** A 1.75 GB image takes minutes under emulation.

## Layout

```
%USERPROFILE%\vm-manager\
  server.js            backend (stdlib only)
  public\index.html    the GUI (single file, vanilla JS)
  public\vendor\       xterm.js (vendored, offline)
  vm-manager.cmd       launcher
  vms.json             VM registry: ports, memory, base, autostart, note
%USERPROFILE%\qemu\              portable QEMU (extracted, not installed)
%USERPROFILE%\devbox-base.qcow2  golden template
%USERPROFILE%\vm-bases\          additional templates (e.g. docker-ready.qcow2)
%USERPROFILE%\sandboxes\         per-sandbox thin clones + serial logs
%USERPROFILE%\seed\id_dev        SSH private key for all guests
```

## Notes

- **One long operation at a time.** Installs, pulls, deploys and state changes share
  a lock; the GUI shows HTTP 409 if something is already running, and streams the
  task log into the page.
- **Everything is outbound NAT.** Sandboxes reach the internet but cannot see each
  other; the host reaches them only via forwarded ports.
- **Never replace a template while clones exist.** Clones resolve their backing file
  by path, so overwriting it corrupts every clone. Stop and delete clones first.
- Guest console is a **passwordless root shell** — no login needed.
- **Closing a QEMU console window kills that VM.** Closing the *manager* window only
  stops the control plane; running VMs survive, and autostart brings back the ones
  flagged for it.
