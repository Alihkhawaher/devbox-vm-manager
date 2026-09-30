# Architecture

devbox VM Manager is one Node.js process (standard library only). It owns a
data folder of QEMU disks, images and container logs, and serves a GUI and a
JSON API on 127.0.0.1. Every long operation runs as a background task. The
process runs three kinds of guests:

- **full VMs**: Alpine Linux, SSH, optionally Docker inside;
- **microVM containers**: one Docker image each, booted straight from the
  registry image, with no Docker Engine;
- the **file server** that shares folders of this PC with both.

A separate MCP server process talks to the manager over the same API. Each
module's header comment explains its rules and the reasons for them; this
page is the map.

```
 browser (public/app.js) ──HTTP + token──┐
                                         ▼
 mcp-server.js ──lib/client.js──►  server.js ─► lib/http.js  (security, routes)
   lib/mcp/protocol.js                            │
   lib/mcp/tools.js ──ssh (exec, files)──┐        ├─ lib/vm.js          full VMs: lifecycle, status, disks, network view
   lib/mcp/containers.js                 │        ├─ lib/install.js     prereqs, setup, QEMU install, bake
   lib/mcp/shares.js                     │        ├─ lib/docker.js      Docker in a guest
                                         │        ├─ lib/deploy.js      deploy / quick deploy (Docker-in-VM)
                                         │        ├─ lib/sessions.js    terminals (ssh pty, serial) over SSE
                                         │        ├─ lib/microvm/       microVM containers (routes, containers,
                                         │        │                     run, plan, kernel, init.sh ...)
                                         │        │    └─ lib/oci/      registry, flatten, cpio, image cache
                                         │        └─ lib/shares.js      shared folders (+ shares-routes.js)
                                         │             └─ lib/ninep/    9P2000.L server on 127.0.0.1:5640
                                         ▼                 │
                           full VMs, microVMs  ◄── QEMU ◄──┤ lib/monitor.js (HMP: live forwards, powerdown, quit)
                                  │                        │ lib/ssh.js     (ssh/scp, per-VM known_hosts, key)
                                  └── 9P over slirp (10.0.2.2) ──► lib/ninep/server.js
          shared: lib/tasks.js  lib/state.js  lib/ports.js  lib/platform.js  lib/download.js  lib/util.js  lib/config.js  lib/route.js
```

## Modules

| Module | Role |
|---|---|
| `server.js` | Entry point. Works only when started directly. It sets `UV_THREADPOOL_SIZE=16` before anything touches the file system (the file server's reads and writes run on the pool). It parses the CLI, resolves the data folder, and refuses a second manager for the same folder (it opens the first). It loads `vms.json` and `containers.json`, re-protects the SSH key, listens (next free port on EADDRINUSE) and writes `run/manager.json`. It then re-adopts running VMs and containers, restores the running VMs' shared folders, autostarts, and shuts down on SIGINT/SIGTERM/SIGHUP/SIGBREAK. |
| `lib/config.js` | `CFG`, one shared object that `configure()` changes in place: data root and port precedence, every path under the root, host-derived limits, the access token, `parseArgs`, the optional `config.json` keys, `setConfigValue` (only `ninepPort` is ever written by the manager). |
| `lib/platform.js` | The OS abstraction: tool discovery (`findTool`), QEMU process listing (tasklist CSV, `/proc`, `ps`), listening sockets (netstat read by the foreign address so the display language does not matter, `ss`, `/proc/net/tcp`, `lsof`), port-free checks on 127.0.0.1 and 0.0.0.0 (one probe per port at a time), `internalHost()` (a random private 127.x.y.z per start, or null = unix sockets), accelerator detection, browser, disk free, private-file permissions, time zone, install hints. The parsers are pure and tested with fixtures. |
| `lib/util.js` | `run()` with bounded output capture, validators (`vmNameError`, image refs, container names), `shq`, atomic writes, exact log tails, size-capped logs, `probeSsh`, and the API error helpers (`badRequest`, `notFound`, `conflict`). |
| `lib/state.js` | `vms.json` v2: load (v1 migration, corrupt-file recovery, `.bak`), save only on change and atomically, VM record helpers (forwards keep `proto`), per-VM file paths, global settings. |
| `lib/tasks.js` | Tasks and locks: `start(spec, fn)`, `BusyError` (409 naming the holder), `assertFree`, `holder`, `runAndWait`, history (50 tasks, 2000 lines each), `logs/tasks.log`. A task carries `vm` or `ctr`. |
| `lib/ports.js` | The one parser for port text (`lan:`/`local:`/`0.0.0.0:`/`127.0.0.1:` prefixes, `/udp`), QEMU `hostfwd` rules with the bind address and protocol, validation and reservation (manager port, SSH ports, other forwards, every container record's ports, monitors, other programs), allocation, metadata-preserving merges. |
| `lib/ssh.js` | ssh/scp argument builder (BatchMode, `accept-new`, per-VM known_hosts), `sshExec` with exit codes, stdin, timeouts and head+tail output caps; SSH key creation and protection. |
| `lib/monitor.js` | QEMU HMP client: waits for the banner prompt, one command at a time per monitor; `hostfwd_add/remove` with the bind address and protocol (confirmed through `info usernet`), `system_powerdown`, `quit`. Used for VMs and microVMs alike. |
| `lib/download.js` | HTTPS downloads to a per-writer `.part` with connect and idle timeouts, size and sha512 checks; `fetchText`, `headInfo`. |
| `lib/install.js` | Prerequisites (including the microVM kernel row), one-click setup (`only: "microvm"` stops after the kernel), QEMU discovery/install/update (Windows; refused while VMs or containers run), Alpine image discovery, the cloud-init seed server, the bake (which installs the `devbox-shares` service). |
| `lib/vm.js` | VM lifecycle and status (pid + QEMU check, background SSH probes, a shared in-flight `listVms`), QEMU arguments (the WHPX CPU model from `microvm/hostcpu`, the shared-folder fw_cfg list), accelerator choice with TCG retry, stop sequence, reset, snapshots, compact, resize, grow fs, freeze, settings, live port changes, the network overview (VMs and containers), adoption, autostart. |
| `lib/sessions.js` | Terminal sessions: `ssh -tt` with pty size, or the VM's serial socket; SSE output batched every 20 ms, with byte offsets for replay; idle sessions reaped. |
| `lib/docker.js` | Docker state (one ssh call), install/start, pull, run, container actions, rmi, compose (YAML over stdin as base64), logs, image inspect. |
| `lib/deploy.js` | Port planning (TCP and UDP), the safe redeploy script with rollback, deploy into a VM, quick deploy (new VM + deploy, deleted again on failure). The Docker-in-VM engine and fallback of `POST /api/container/run`. |
| `lib/http.js` | The HTTP server: Host/Origin/token/content-type checks, body limits, security headers, static files from `public/`, and the data-driven route table (`ROUTES`, with the route tables of `microvm/routes.js` and `shares-routes.js` appended). |
| `lib/route.js` | Route-table helpers shared by `http.js` and the route tables other modules export: `taskRoute` (validate first, then a task with `vm`/`ctr`), `accepted()` (a 202 from a handler), `startTask`. |
| `lib/client.js` | API client for the MCP server and tools: finds the manager through `run/manager.json`, starts a headless one if needed, token auth, `waitForTask`. |
| `lib/mcp/protocol.js` | MCP over stdio: JSON-RPC 2.0 framing (byte-safe, one object per line), version negotiation, tool registry, JSON Schemas from parameter tables, lax argument checking, concurrent requests. |
| `lib/mcp/tools.js` | The 31 MCP tools, built by `createTools(deps)` with injectable dependencies so tests can use a fake manager. It holds the VM tools and assembles the two modules below. |
| `lib/mcp/containers.js` | `run_image`, `stop_image`, `image_logs`, `list_containers`, `remove_container`, `pull_image`, `list_images`, `remove_image`, and `runImageFlow` (shared with `deploy_image`). Host folders pass `guardLocalPath` before the manager is asked. |
| `lib/mcp/shares.js` | `share_folder`, `unshare_folder`, `list_shares` (`POST /api/vm/shares`, `GET /api/shares`). |
| `lib/oci/registry.js` | Registry v2 client: references, token auth, HEAD-first tag resolution (a cached tag with pull policy `missing` makes no request), verified blobs to a per-writer `.part`, resume of its own `.part`, redirects without leaking credentials, rate-limit headers, `AbortSignal`. |
| `lib/oci/layers.js` | Streaming tar reader and the two-pass flatten (whiteouts, opaque dirs, hard links, symlinked parents) with caps on entries, bytes and depth. |
| `lib/oci/cpio.js` | THE newc cpio writer (streaming or in memory, `autoParents`), readers, the initramfs checker, `flattenToCpio`/`ensureRootfsCpio`, and the kept `.json` sidecar of a (transient) rootfs archive. |
| `lib/oci/images.js` | The image cache: keyed mutex (`withImageLock`), `images/index.json` (the only file the cache rewrites on use), `listImages`, remove with Docker's `rmi` rules, prune, age- and use-aware boot-image GC, `requireSpace`. |
| `lib/microvm/` | The microVM engine (one Docker image = one headless VM; see [the run pipeline](#docker-images-without-docker-the-microvm-run-pipeline)). `containers.js` is the contract the rest of the app calls: the registry, status machine, start flow, supervisor, stop protocol, adoption and autostart. The building blocks: `run.js` (prepare, launch, watch, the stop primitives), `plan.js` (content-keyed boot images, run plans, host facts per accelerator), `init.sh` (PID 1 in the guest), `initramfs.js` (run spec, init archive), `qemu-args.js`, `kernel.js` + `apk.js` + `keys/` (verified kernel setup), `store.js` (`containers.json`), `validate.js` (request fields), `compat.js` (rules and failure classifier), `facts.js` (users and s6 read from a boot image), `logs.js` (log tails and the SSE stream), `routes.js`, plus `volumes`, `copyin`, `tail`, `args`, `qcow2`, `mkext4`, `hostcpu`, `vmrun`, `kmod`, `tar`. |
| `lib/ninep/` | The 9P2000.L file server for live shared folders (`server.js`, `proto.js`) and what a guest needs to mount it (`guest.js`: the fw_cfg list format, the SSH mount and unmount scripts, guest-path rules). |
| `lib/shares.js` | The shared-folder service (see [below](#live-shared-folders-the-9p-share-service)): one 9P server per manager, share validation and records, the private fw_cfg lists, lifecycle hooks for VMs and containers, mount jobs over SSH, reboot and restart handling, status. `lib/shares-routes.js` holds its routes; `lib/assets/devbox-shares.initd` is the guest's OpenRC service. |
| `public/` | `index.html` (markup only), `app.js` (all behaviour), `app.css` (all styling), `vendor/` xterm.js. No inline script or style anywhere (CSP). |

Dependency direction (a module requires only those to its left): `util` →
`config` → `platform` → `state`/`tasks` → `ports` → `ssh`/`monitor`/`download`
→ `vm` → `install`/`sessions`/`docker` → `deploy` → `http` → `server`. Two
references go back, both lazily at call time to avoid require cycles: `vm`
closes a stopped VM's terminals through `sessions`, and `config` protects the
token file through `platform`. `client` needs only `config`. No module does
anything when required, so tests can load any of them.

The microVM and shared-folder modules sit beside `vm`, and they load each
other lazily, at call time:

- `ports.reservedPorts` asks `microvm/containers` for the containers' ports.
- `vm.networkOverview` asks it for their rows.
- `vm` calls `shares` at a VM's start, exit and delete.
- `microvm/run` reuses `vm.runtimeEndpoints` for its private console and
  monitor sockets.
- `microvm/containers` calls `shares` at a container's start and exit, and
  `deploy` for the Docker-in-VM engine.

## Docker images without Docker: the microVM run pipeline

A single image runs as its own headless microVM. No Docker Engine is involved:
the manager is the image puller, the unpacker and the supervisor, and a
busybox shell script is PID 1.

```
 registry (HTTPS, token, HEAD first)
     │  verified blobs (sha256, size) ─► images/blobs/sha256/<hex>        (lib/oci/registry.js)
     ▼
 flatten in memory: whiteouts, opaque dirs, hard links, symlinked parents,
 caps on entries/bytes/depth - never unpacked onto NTFS                    (lib/oci/layers.js)
     ▼
 images/rootfs/<cfg>-v1.cpio (transient) + its .json sidecar (runtime config, kept)
     ▼  + the base init archive: static busybox, init.sh, the kernel modules
 images/initrd/<cfg12>-<key16>.initrd  - keyed by CONTENT, built once per
 image under images.withImageLock, then the rootfs .cpio is deleted          (lib/microvm/plan.js)
     ▼
 QEMU -machine microvm (q35 when needed) -accel whpx|kvm|hvf -accel tcg,tb-size=128
      -kernel kernel/<kver>/vmlinuz-virt -initrd <boot image>  (tsc_early_khz=<host facts>)
      -fw_cfg opt/devbox/spec=microvms/<id>/spec.sh          the run spec (<= 32 KB)
      -fw_cfg opt/devbox/shares=run/ctr-<id>.shares          share port + keys (private file)
      virtio-serial devbox.stdout / devbox.stderr ─► microvms/<id>/stdout.log, stderr.log
      ttyS0 socket (private 127.x.y.z or unix socket) + console.log: markers, stop requests
      HMP monitor (private): system_powerdown, quit
      virtio-blk: named volumes (qcow2 / ext4), copy-in (raw cpio, read-only)
      slirp: hostfwd per published port on 127.0.0.1 or 0.0.0.0; 10.0.2.2 = this PC
     ▼
 guest PID 1 = init.sh: mounts, stop-request reader, modules, network, /etc/hosts
 (host.docker.internal), volumes, 9P shares, user, copy-in, RAM-root cap ─► READY
 ─► the app as a foreground job, output relayed ─► exit: kill the rest, drain,
 sync, fstrim, unmount ─► EXIT=<code> ─► poweroff
```

QEMU writes every log file itself and each control channel is a short
connection to a private endpoint. So a container does not depend on the
manager process that started it: it keeps running, and its logs keep
growing, while the manager is closed.

**A container start** (`containers.startFlow`) runs inside the `ctr-run` or
`ctr-start` task, under the lock `ctr:<id>`. Each step checks for a stop
request, and a stop during these steps aborts the task:

1. **The image**:
   - `registry.pullImage` with the pull policy (`missing` makes no request for
     a cached tag). A later start re-pulls only with `always`.
   - Then the preflight on the manifest and config (`compat.imageRules`:
     systemd, s6-overlay, the Docker socket, the estimated size).
   - Then the boot image by content key, under the image's keyed mutex: on a
     miss, flatten, build the initrd, and delete the rootfs archive again.
     Flatten warnings go to the task log and the record.
2. **Rootfs rules** (`compat.rootfsRules`): the exact size and s6-overlay
   found in the tree. A finding that needs Docker ends the task with
   `fallback` set. Engine `auto` never switches by itself.
3. **Re-read the registry**. A stop or remove may have come during the slow
   part, and what is attached now is what counts (volume exclusivity). A
   container with shared folders needs a kernel that has the 9P modules.
4. **Accelerator and host facts**: the container's, else the global setting,
   else the detected accelerator. Then `plan.hostDefaults` for the CPU model
   and TSC frequency (see [Host facts](#host-facts-and-the-clock)).
5. **Volumes**: created on first use (qcow2 written by `qcow2.js`, formatted
   ext4 by `mkext4.js` on the host), then the exclusive attach lock
   `volumes/<name>.lock` (created with `wx`; stale when its container is not
   running and its manager is gone or is this one).
6. **Ports**: the image's EXPOSE ports when none were given. Every host port
   must be free on both 127.0.0.1 and 0.0.0.0 right now.
7. **Copy-in**: a one-way snapshot of the host folders packed into
   `microvms/<id>/copyin.cpio` (512 MB cap). The guest RAM grows by its size
   unless it lands inside a volume.
8. **Shared folders**: `shares.registerFor('container', id, ...)` with the
   container user's numeric uid:gid. The private fw_cfg list is written to
   `run/ctr-<id>.shares`. A folder that is gone ends the start.
9. **Memory**: the container's size, else
   `max(256, recommendedMemMB(initrd) + copy-in)`. The budget check is
   `memMB + 64 <= free - 512 MB`, because WHPX commits all guest RAM.
10. **Machine**:
    - `microvm`, unless this QEMU lacks it;
    - q35 when more than 8 virtio devices are needed (the microvm machine
      has 8 virtio-mmio slots), or when no TSC frequency is known;
    - more than 1 vCPU is clamped on microvm (untested there).
11. **The run spec** (`plan.buildSpec`): argv by Docker's ENTRYPOINT/CMD
    rules, env, workdir, user, hostname, volume, share and copy-in targets,
    the stop signal and timeout, `host.docker.internal → 10.0.2.2` and the
    log cap. Every value is single-quoted. The spec is at most 32 KB, because
    fw_cfg reads cost O(n²).
12. **Spawn** (`run.launch`): the previous boot's logs are rotated to
    `*.prev.log`. QEMU is started directly, detached, with no window, with
    `-pidfile`, fresh private endpoints (`vm.runtimeEndpoints`), and a retry
    with new endpoints when a control socket could not bind. `spec.sh`
    (env values inside) is written private. The runtime is saved in
    `containers.json` **the moment QEMU is spawned** (`onSpawn`), before the
    start window of up to 3.4 s: a manager that closes in between leaves a
    record the next one can adopt. The `qemu` task lock ("Update QEMU") is
    checked again right before the host-facts boot and the spawn.

Before step 1 finishes downloading anything, `registry.pullImage` calls the
engine's `beforeLayers` hook with the declared layer sizes: the compat rules
(spec 14.2), `IMAGE_TOO_LARGE` for an image that could not boot even with
the most memory a VM may get, and `images.requireSpace` for the download plus
the unpacked copies. The blobs the preparation uses are held
(`images.holdBlobs`) until it ends, and the record's `configDigest` is set at
that point, so an image removal or prune meanwhile never deletes them.
`cpio.flattenToCpio` checks the space again on the exact unpacked size
(`beforeEmit`) and flattens with the microVM limits (layer data at most twice
the memory cap).

After READY the task probes the first published TCP port for up to 20 s,
then ends with the URLs. It ends earlier when the app exits first, with the
exit code and 4 KB tails of stdout and stderr.

**The guest** (`lib/microvm/init.sh`, static busybox, LF line endings
enforced by `.gitattributes`). The spec comes from fw_cfg - read first;
`/.devbox/spec.sh` is only a fallback for a per-run archive without fw_cfg,
and the flattener drops `/.devbox` from image layers, so an image cannot
replace it. The **stop-request reader starts right after the spec is
read**, before modules, volumes, shares and copy-in, so a stop during the boot
is never lost. The ACPI button reader is armed after the modules load. Then
init:

1. brings up the network (10.0.2.15, gateway 10.0.2.2, DNS 10.0.2.3) and
   opens low ports to every user;
2. mounts volumes and 9P shares in ONE list, `devbox_mounts`, which the spec
   renders sorted by target depth, parents first (Docker's sortMounts): a
   volume below a share is mounted after it. A volume's `data/` goes over its
   target; a new one is seeded from the image into `data.new`, renamed to
   `data` only when the copy is complete. A share gets at most 5 bounded
   attempts. A failure is exit 125 with the reason. `$R/mounts` records the
   order; when a dead share is healed (below), everything mounted under it is
   mounted again (`remount_nested`), because the lazy unmount takes it along;
3. resolves the user and unpacks the copy-in, owned by that user;
4. caps the RAM root at what it uses plus half the free memory, so a full
   root gives ENOSPC instead of a deadlock;
5. prints `__DEVBOX_READY` and runs the app as a **foreground job**, so it
   gets default signal dispositions, as under Docker.

The app's stdout and stderr go through FIFOs owned by the container user to
the virtio-serial ports. A per-boot cap applies (`containerLogCapMB`) - in
the guest, and again on the host: the app is root in its guest and can get
around the guest's watchdog, so the supervisor stats the three logs every 2 s
and stops a container whose stream is past the cap plus 64 MB (a forced stop:
KILL in the guest first, so volumes are still synced). `run.readExit` reads
only the first and last 64 KB of `console.log`. When the app exits, init:

1. SIGKILLs everything else;
2. lets the relays drain;
3. syncs, `fstrim`s and unmounts the volumes;
4. prints `__DEVBOX_EXIT=<code>` (and `__DEVBOX_NOSTART` if the app never
   ran);
5. powers off.

A background loop re-mounts a share whose `statfs` fails, because the Linux
9p TCP transport never reconnects after a manager restart. The new mount is
made at a private point first and then moved over the dead one, so the app
never sees the image's own files there.

**The console protocol** (ttyS0; the manager parses only these lines, with
strict regexes, capped):

| Guest to host | Meaning |
|---|---|
| `__DEVBOX_INIT uptime=S` | init started (the manager deletes `spec.sh`: QEMU has read it) |
| `__DEVBOX_STOPPING` | a stop request was accepted (sent for every request) |
| `__DEVBOX_SIGNAL=<SIG>` | a signal request was passed on |
| `__DEVBOX_READY` | setup done, the app starts now |
| `__DEVBOX_ERROR=<text>` | why init gave up (at most 300 characters) |
| `__DEVBOX_NOSTART` | a stop came before the app started |
| `__DEVBOX_EXIT=<code>` | the app exited (always last) |

The host sends `__DEVBOX_STOP [timeout]` and `__DEVBOX_KILL <SIG>`. Lines
starting `devbox-init:` are init's messages, and the last 20 are kept.

**Supervision** (not a task): one watcher per live container.

- It tails `console.log` every 250 ms for the markers.
- Liveness comes from `platform.pidAlive`. For a QEMU started here, its
  process handle pins the pid. An adopted one was matched against the shared
  `platform.listQemuPids()` listing and `qemu.pid`. No per-container
  `tasklist` ever runs.
- READY → `running`. EXIT or the pid's end → `exited`: the volume locks are
  released, the shares are disconnected and unregistered, `autoRemove` is
  honoured, and the record is saved.
- No INIT within 90 s (240 s under TCG) → a forced stop and 125 "the VM did
  not boot", with the last console lines.
- An end with a non-zero code before READY, or within 10 s of it, goes
  through `compat.classify`. That can set `fallback` (needs PID 1, runs
  containers itself, a kernel panic) or suggest more memory.
- The supervisor is the one source of truth: the run and stop tasks only
  read what it wrote.

**Status machine**: `created → preparing → booting → running → stopping →
exited`, and any failure → `error`. `exited` and `error` records keep their
logs and ports until Remove.

**Exit codes** follow Docker's: the app's 0-255 (128+N = signal N); 126/127
from init with its message; 125 = the engine failed (no exit marker, kernel
panic, QEMU failed, boot timeout, a volume, copy-in or share that could not be
set up); null = stopped before the app started, or stopped outside the
manager.

**Manager restart.** Containers are detached. `server.js` loads the registry
with `pendingAdoption`: until `adoptAll` has run (it runs after the VMs'
adoption, while the API is already served), start, stop, kill, remove,
settings, fallback and volume/image removal wait for it (409 `STARTING_UP`
after 15 s) - before it, a running container looks stopped. `adoptAll`
handles each record with a runtime:

- **Still running**: its pid is alive, in the QEMU process list, equal to the
  `qemu.pid` QEMU wrote (a missing file means a gone QEMU), and its HMP
  monitor answers `info name` with `devbox-ctr-<id>` (without an answer,
  pid + list + file suffice). The record is adopted: `console.log` is re-read
  from the start, and the watcher and volume locks are re-attached. Its
  shares are registered again with the same ids, keys and owner
  (`runtime.shareIds`, else the image's USER from the rootfs sidecar), and
  the guest heals its mounts.
- **Exited meanwhile**: it gets the code its console shows, or null with
  "stopped outside the manager"; `autoRemove` removes it.
- **Cannot be told** (no process list and no monitor answer): kept as
  running without supervision (`lost`), never marked exited.
- **A record in a live status without a runtime** (the manager ended
  between spawn and the save - normally impossible since `onSpawn`): its
  `qemu.pid`, if the process's command line names the container, makes it
  an unsupervised VM that can be stopped.
- **A QEMU without a record**: a live `qemu.pid` whose container record is
  gone becomes a "lost" record only when the process's command line
  (`platform.processCommandLine`) names that container; it can only be
  stopped (the command line is checked again first) or removed. The state
  warning is computed from the records, so it goes with the VM.

`autostartAll` then starts autostart containers one after another.

## The stop protocol

`POST /api/container/stop {id, timeoutS?, force?}` runs as the task
`ctr-stop` under its own lock `ctr-stop:<id>`. It is deliberately **not**
`ctr:<id>`, so a stop is accepted while the run task is still pulling or
booting.

1. `record.stopRequest = {at, timeoutS, force}` and status `stopping`.
2. **Not spawned yet** (preparing): the run task's AbortController is
   aborted, and with it any pull in flight. The task ends "stopped before the
   app started" with no exit code, and no VM is created.
3. **Spawned**: `__DEVBOX_STOP <timeoutS>` (or `__DEVBOX_KILL KILL` when
   forced) is sent over a short console connection, **every second until
   the guest answers** with `__DEVBOX_STOPPING` or `__DEVBOX_EXIT`, or the
   pid is gone. A successful socket write is not an acknowledgement: the 8250
   FIFO is reset when its driver loads, and QEMU serves one console client at
   a time. If the console cannot be reached for 3 s, the ACPI power button is
   pressed (HMP `system_powerdown`); init treats it as a stop.
4. In the guest, init sends the image's stop signal (SIGTERM by default). If
   the app is still running after `timeoutS`, init sends SIGKILL. A stop
   accepted before the app started skips the app.
5. The manager waits `timeoutS + 5 s` for EXIT, then sends
   `__DEVBOX_KILL KILL` and waits 5 s more. Init still drains, syncs, trims and
   unmounts the volumes, so **a timeout is SIGKILL, never a power cut**. Only
   after that does the manager send HMP `quit`, and then kill the pid if it is
   still a QEMU. A forced stop of a guest that does not answer (for example
   one hung before init) is quit after 5 s.
6. The result is `{id, exitCode, how, ms}`, where `how` is `graceful`,
   `killed after N s`, `killed (force)`, `forced (quit)`,
   `stopped before the app started` or `already exited`. The record is kept.

Full VMs stop differently (see [How a VM start works](#how-a-vm-start-works)):
`poweroff` over SSH or ACPI, a wait, `quit`, then a verified kill.

## Host facts and the clock

The microvm machine has no HPET or ACPI PM timer, so the guest kernel must be
told the TSC frequency (`tsc_early_khz`). Without it the kernel calibrates
against the PIT alone. On a busy PC a guest misses the PIT windows, marks the
TSC unstable, and waits for good in `calibrate_delay` (18 of 24 TCG boots with
8 in parallel).

`plan.hostDefaults` therefore measures, once per QEMU version and detected
accelerator:

- the host CPU features, which give the WHPX CPU model (`hostcpu.js`, also
  used by `vm.js` for full VMs);
- the TSC frequency, from one short q35 boot, which has HPET.

The calibration runs without a TCG fallback, so a PC without working WHPX
cannot cache a wrong value labelled whpx. KVM and HVF need no calibration
(kvmclock). The facts are stored in `kernel/host.json`. TCG facts live in
`kernel/host-tcg.json` and reuse the hardware accelerator's measured TSC
when there is one, so a TCG run never replaces the WHPX facts. Concurrent
first runs share one computation. A machine with no known TSC uses q35.

## Live shared folders: the 9P share service

The Windows QEMU build has no virtfs/9p and no virtio-fs, and virtiofsd runs
only on Linux. So the manager serves shared folders itself: a 9P2000.L
server in Node (`lib/ninep/server.js`) on **127.0.0.1**. Guests mount it over
QEMU user networking, where slirp maps the guest's `10.0.2.2` to this PC's
127.0.0.1:

```
mount -t 9p -o trans=tcp,port=<P>,version=9p2000.L,msize=524288,cache=mmap,
               aname=<shareId>:<secret>,uname=boot-<boot id>[,ro]  10.0.2.2  <path>
```

`cache=mmap` is coherent both ways: a Windows edit is seen in 6-26 ms, and a
guest write is on disk when the write returns. `cache=loose` never showed
Windows edits to files the guest had cached, so it is not used.

**The service** (`lib/shares.js`, one per manager process):

- **The server** starts lazily, once, on `CFG.ninepPort` (5640). Running
  guests' fw_cfg lists and mounts name the port, so it must stay stable
  across restarts. If 5640 is busy on first use, a free port is picked and
  saved to `config.json`, and nothing is written otherwise.
- **Shares** are `{hostPath, guestPath, readOnly, id, secret}`. The id is
  `<owner>-<n>`, and the secret comes from `generateSecret()`, made when the
  share is added. They are stored with the owner record: `vms.json`
  `vm.shares[]`, or the container record in `containers.json`.
  - `validateShare` checks the host side: the folder exists, and it is not the
    data root, a folder containing it, or a system folder. A drive root or
    the whole profile gives a warning.
  - `guest.validateGuestPath` checks the guest side: plain absolute paths, not
    over system directories.
  - An owner has at most 8 shares, with no duplicate guest path.
- **Secrets never leave the private files.** The guest gets the list from
  fw_cfg (`opt/devbox/shares`, one line per share:
  `<port> <id>:<secret> <path> <rw|ro>`). QEMU reads that list from a file
  in `run/`, which is made private while still empty, then filled and renamed
  into place. The file is deleted when the owner stops, and leftovers are
  cleaned at manager start. SSH mount scripts go to the guest on stdin. The
  API returns `publicShare` views and never a secret. uid:gid is 0:0 for VMs
  (their SSH user is root); containers pass the image user's numeric ids.

**Lifecycle hooks:**

| When | Full VM (`lib/vm.js`) | microVM container (`microvm/containers.js`) |
|---|---|---|
| start | `registerFor('vm', name, shares)` writes `run/<vm>.shares`; `-fw_cfg name=opt/devbox/shares,file=...` goes on the QEMU line. The guest's `devbox-shares` OpenRC service mounts the list at every boot, with no SSH involved. After the start task (it pins the guest's new host key first), a mount job runs over SSH: it installs the service if the image predates it, and mounts whatever the boot did not. | `registerFor('container', id, ...)` writes `run/ctr-<id>.shares`; init mounts each share before the app starts, and a failure is exit 125 with the reason |
| share added while running | registered, then mounted over SSH at once (`applied: "live"`) | applies at the next start |
| share removed while running | unmounted over SSH, then unregistered: the guest loses access at once | unregistered: the guest loses access at once |
| reboot inside the VM | QEMU keeps the list it was started with. If shares were added or removed since (a "stale" list), the service watches for a new boot. That is either a 9P attach with a new `uname=boot-<id>`, or SSH going away and coming back; then it mounts what the boot missed. | - |
| QEMU exited | `disconnect` (close the owner's 9P connections) + `unregister` | the same, from the supervisor |
| manager restart | `restoreRunning`: every running VM's shares are registered again and re-mounted over SSH. The dead mounts are lazily detached first, because the 9p TCP transport never reconnects. | adoption registers the same ids and keys again; the guest's heal loop re-mounts |

Mount jobs are serialised per VM, and a newer request replaces a pending
one. `POST /api/vm/shares` runs under the VM's lock (409 `BUSY` during a
start or stop). `status(owner)` reports, per share:

- mounted or not;
- connections, open files, and bytes read and written;
- the last close reason (for example "closed by the guest", "superseded by a
  newer boot of the VM", "share removed" or "stalled").

The GUI, `GET /api/shares` and MCP `list_shares` show it.

**The server's security model** (header of `lib/ninep/server.js`):

- **Access control is the per-share secret.** Every guest and every local
  program can connect, so the attach name `<shareId>:<secret>` decides.
  - Secrets are compared as SHA-256 digests with `timingSafeEqual`.
  - A failed attach costs 100 ms, and repeated failures close the connection.
  - A connection that has not attached soon is closed. Only a few may wait
    unauthenticated, and the oldest makes room for a newcomer.
  - Until an attach succeeds, frames are capped at 64 KiB with 2 requests in
    flight.
- **Jail.** A fid points at a node in a tree rooted at the share's real
  root, never at a path string.
  - `..` never climbs above the root.
  - Every new name passes `validateName`: no `.`, `..`, `/` or NUL, nothing
    Windows would misread, no DOS device names, no 8.3 aliases of another
    name.
  - Symlinks and junctions are never walked through or opened.
  - Everything that opens, creates, renames or links first resolves the real
    path, and refuses anything outside the root. This check runs on every
    operation and is never cached, because programs on the host can swap a
    folder for a junction at any time. A server-wide lock stops a guest from
    racing its own checks.
  - Guest-made links must be relative and stay inside the share.
  - Readlink never shows a host path.
- **Read-only** shares refuse every mutating operation with EROFS.
- **Bounded memory.** Fids, open files, in-flight requests and bytes are
  capped per connection, per share and in total. A connection that stalls
  mid-frame, or does not take its replies, is closed after 60 s. Idle
  attached connections are kept, because the transport never reconnects.
- **Reboots.** slirp keeps a rebooted guest's old connections open. They are
  closed when the new boot attaches with a different `uname=boot-<id>`
  (supersede), or reclaimed when the share reaches its connection cap.

What stays open by design: the secret is visible in the guest's
`/proc/mounts` (the VM is the boundary); a writable share can fill the host
drive; getattr on a fid walked before a host program swapped a directory for a
junction can show that target's metadata, never its content.

## Conventions

**Rules for every module:** CommonJS, `'use strict'`, no side effects at require
time, pure functions exported for tests, comments that explain *why*.

**CFG is read at use time.** `configure()` changes `CFG` in place; never copy a
`CFG` value into a top-level constant.

**Validate, then run.** Each task route has a `validateX(body)` (async) that
checks input and state and throws 400/404/409 before anything starts, and an
`opX(t, args)` that does the work and returns a JSON-able result. `lib/http.js`
awaits the validator, then `tasks.start({kind, title, vm, locks}, t => opX(t, args))`
and answers 202 with the task summary.

**One task, one log.** Composite operations call sub-operations as plain
functions with the same context `t` (`opRestart` → `opStop` + `opStart`,
`opQuickDeploy` → `opCreate` + `opStart` + deploy); never a nested task.
`t.step(text)` sets the step shown in the GUI and logs it once.

**Errors:** throw the helpers from `lib/util.js`; `tasks.BusyError` and
`ports.PortConflict` are 409s. Anything else is a 500 `INTERNAL`, logged to
`logs/manager.log`. Responses are always `{ok:false, error, code}`.

**Guest commands:** every value is validated and quoted with `shq()`; `--`
before positional ids; guest scripts are single-line (`docker.oneLine`) or sent
over stdin (`sh -s`), which survives Windows `ssh.exe` argument handling and
its 32 767-character command line.

**Guest output is untrusted.** Console lines are capped and parsed only by
strict regexes; guest text is never used in a path, a command or HTML (the GUI
sets `textContent`).

**Cross-module calls through module objects** (`vmMod.isRunning`,
`ssh.sshExec`, `platform.findTool`), not destructured, so tests can stub them.

## Tasks and locks

A task is `{id (UUID), kind, title, vm, ctr, status: running|done|error,
step, log, startedAt, endedAt, error, result}`. `tasks.start(spec, fn)`
checks every lock, takes them, records the task and returns its summary at
once; `fn(t)` runs in the background. The runner always finalises in
`finally`: status, `endedAt`, the error or result, and the locks are
released. Nothing can leave a task stuck in `running`. The last 50 tasks stay
in memory (logs capped at 2000 lines each); every line is also appended to
`logs/tasks.log`.

Locks are plain strings. A held lock makes `start()` throw `BusyError`: HTTP
409 `BUSY` with the holder's summary, so the GUI and Claude can say what to
wait for.

| Lock | Taken by | Checked without taking (`assertFree`) by |
|---|---|---|
| `vm:<name>` | every VM route (create, start, stop, restart, delete, reset, resize, growfs, compact, freeze, snapshot, all Docker routes, deploy, quick deploy, the Docker-in-VM engine and fallback); `POST /api/vm/ports` and `POST /api/vm/shares` (as short tasks through `runAndWait`); autostart | create; `updateSettings` and `forgetVm`; `lookupVm`, so a VM that is still being created answers 409 BUSY instead of 404 |
| `ctr:<id>` | container run (`ctr-run`) and start (`ctr-start`) | - |
| `ctr-stop:<id>` | container stop (`ctr-stop`), and a forced remove through `runAndWait` | - |
| `template:<name>` | freeze (`template:<as>`), base build and setup (`template:devbox-base`) | create, reset and quick deploy (no clone of a template that is being written) |
| `qemu` | QEMU install/update and setup | start, create with `start`, restart, reset of a running VM, quick deploy, container run and start (no VM starts while the binaries are replaced) |
| `global` | QEMU install/update, base build, setup | - |

Besides task locks, some work is serialised inside the process: the keyed
mutex `image:<configDigest>` (`images.withImageLock`, so concurrent runs of
one image build its boot image once), the volume lock files
`volumes/<name>.lock` (one running container per volume, also across a
manager restart), the per-VM share mount job, and a module-level promise
around `ensureKernel`. Image pulls and prunes take no task lock.

The QEMU install also refuses while any VM or container runs, because Windows
locks the program files of a running QEMU. Several tasks run at once when
their locks differ: two VMs can boot, deploy and stop in parallel, and four
containers can start at once, each with its own endpoints.

Status polls read the locks:

- A VM held by a `start|restart|create|quickdeploy|reset` task whose QEMU is
  not up yet shows `booting`.
- A VM held by a `stop|delete` task shows `stopping`.
- `busy` carries the task id, for VMs and containers.

A force stop (`validateStop` with `force`) adds the VM to `forceRequested`
when a start-like task or a normal stop holds it:

- a start that is still waiting for SSH gives up at once, and a restart does
  not boot again;
- a stop that is still waiting for the power-off goes straight to quit/kill.

The force stop then waits up to 20 s for that task to release the lock. The
GUI keeps its Force stop button enabled for exactly those holders.

`updateSettings` takes no lock for `note`, `autostart` and `ephemeral` (no task
reads them); `mem`, `cpus`, `accel` and `sshLan` need the VM to be free.

**Port claims** (`ports.claim(port, ms, owner)`): an operation that checked a
host port against the registry claims it in the same tick (no await in
between), and holds the claim until its registry change is saved.

- The claiming operations are `validateCreate`/`opCreate`, `setPorts`,
  `validateDeploy`, `validateQuickDeploy` and deploy planning
  (`planWithFreePorts`). Create claims the VM's forwards and a chosen SSH
  port, so the automatic SSH port never lands on one of them; `setPorts`
  claims new host ports.
- A container run puts its record (with its ports) into the registry
  synchronously after the check, so its ports count as reserved at once.
- Other owners' checks see the claim (`reservedPorts`); the owner's own checks
  ignore it.
- http.js releases a validator's claims (`args.claimed`) when its task cannot
  start.

`platform.isPortFree` runs one probe per port at a time, because the probe
binds the port for a moment.

## State: `vms.json` and `containers.json`

```json
{
  "version": 2,
  "settings": { "accel": "auto", "defaultExpose": "local" },
  "vms": {
    "web": {
      "port": 2223, "sshLan": false,
      "mem": 1024, "cpus": 2, "accel": "auto",
      "template": "devbox-base",
      "ports": [ { "host": 8080, "guest": 8080, "container": 80, "owner": "nginx", "lan": false } ],
      "shares": [ { "hostPath": "C:/Users/me/project", "guestPath": "/root/project", "readOnly": false, "id": "web-1", "secret": "..." } ],
      "autostart": false, "note": "", "ephemeral": false,
      "createdBy": "gui", "createdAt": "2026-09-30T12:00:00.000Z",
      "pendingFsResize": false, "personalized": true, "pendingRestart": false,
      "lastError": null,
      "runtime": {
        "pid": 1234, "startedAt": "2026-09-30T12:01:00.000Z", "accel": "whpx",
        "monitor": { "host": "127.83.20.117", "port": 50001 },
        "serial":  { "host": "127.83.20.117", "port": 50002 }
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `settings.accel` | global accelerator: `auto` (use the detected one), `whpx`, `kvm`, `hvf`, `tcg` |
| `settings.defaultExpose` | `local` or `lan`: only the default for new forwards and container ports |
| `port` | the SSH host port (forwarded to guest port 22), fixed at creation, from 2223 up |
| `sshLan` | bind the SSH forward to 0.0.0.0 instead of 127.0.0.1 (applies at the next start) |
| `accel` | per-VM accelerator; `auto` falls through to `settings.accel` |
| `template` | the template the disk is a clone of: `devbox-base` or a name in `vm-bases/`; `null` = not known yet (a disk found without a record, filled in from `qemu-img info`); `""` = a standalone disk |
| `ports[]` | app forwards; `lan` is the user's choice per forward; `proto: "udp"` for UDP (TCP when absent); `container` and `owner` exist only for forwards a deploy created (the container that owns them) |
| `shares[]` | live shared folders (the secret never leaves this file and the private fw_cfg list) |
| `ephemeral` | temporary: removed by "Delete all temporary VMs" and MCP `cleanup` |
| `createdBy` | `gui`, `api`, `claude` (MCP), `discovered` (a disk found without a record) |
| `personalized` | the first-boot hostname and time zone step has run |
| `pendingRestart` | a setting was saved that the running QEMU does not have yet |
| `pendingFsResize` | the disk grew; the filesystem still needs "Grow filesystem" |
| `lastError` | `{at, message, detail}` of the last failed start or unexpected exit |
| `runtime` | the running QEMU: pid, start time, the accelerator it really uses, and its private monitor and serial endpoints (`{host, port}` on Windows, `{path}` on Linux/macOS); `null` when stopped. `legacy: true` marks a VM adopted from v1 (its old monitor; no live forwards or serial console until it restarts) |

Rules (`lib/state.js`):

- `saveState()` writes only when the serialised registry changed, always
  atomically (temp file, fsync, rename), and keeps the previous file as
  `vms.json.bak`.
- A file that cannot be parsed is renamed to `vms.json.corrupt-<time>` (never
  overwritten), the `.bak` is tried, and the warning is shown in the GUI
  (`stateWarning`).
- A file that exists but cannot be read blocks all writes.
- A VM whose disk is missing keeps its record with status `missing`; a disk
  without a record gets one.
- v1 records (an absolute `base` path, a top-level `pid`) are migrated; a v1
  pid is never trusted.
- `state` is one shared object that is mutated, never replaced.

**`containers.json`** (`lib/microvm/store.js`, same rules: only on change,
atomic, `.bak`, `corrupt-<time>`, unknown fields kept) is
`{version: 1, containers: {<id>: record}}`. It is separate from `vms.json`,
so there is no schema bump or migration. A record holds:

- identity: `id` (12 hex), `name`;
- the image: `image` as typed, the canonical `reference`, the manifest and
  config digests;
- `createdAt`, `createdBy`, `ephemeral`, `autoRemove`, `autostart`, `note`,
  `engine`;
- the run settings: `cmd`, `entrypoint`, `env` (values are secrets: redacted
  in lists), `workdir`, `user`, `hostname`, `ports[]`
  (`{host, guest, proto, lan, auto}`), `lan`, `volumes[]`, `shares[]`,
  `copyIn[]`, `network`, `mem`, `cpus`, `accel`, `machine`, `stopSignal`,
  `stopTimeout`, `pull`;
- the outcome: `status`, `exitCode`, `exitReason`, `initMessages`, `startedAt`,
  `readyAt`, `endedAt`, `lastError`, `warnings`, `fallback`, `stopRequest`,
  `timings`, `pendingRestart`;
- `runtime`: `{pid, startedAt, accel, effectiveAccel, machine, memMB, cpus,
  initrd, monitor, console}` while QEMU runs.

Every record's ports are reserved, running or not, until it is removed. The
image cache has its own index (`images/index.json`: references, last use,
sizes, boot image). `images/refs.json` is written only by a real pull.

Per-VM files: `sandboxes/<vm>.qcow2`, `sandboxes/<vm>-serial.log`,
`logs/qemu-<vm>.log`, `run/<vm>.pid`, `run/known_hosts/<vm>`, `run/<vm>.shares`
(while it runs with shares), and on Linux/macOS `run/<vm>.mon` and
`run/<vm>.ser`. `vm.socketPaths` uses short hashed names in `run/` for long
VM names. For a data path too long for any unix socket it uses a private
folder under `$XDG_RUNTIME_DIR`, `/tmp` or the temp folder: a real directory,
owned by this user, mode 0700, checked with `lstat` before every use, else a
fresh `mkdtemp` one. The bake keeps `run/bake.pid` (written by QEMU) and
`run/bake.json` (`{pid, monitor}`). Per-container files are in
`microvms/<id>/` (see the pipeline above) and `run/ctr-<id>.shares`.

Loading a **v1** registry keeps a copy as `vms.json.v1-<time>` (the `.bak` is
overwritten by the next save), and every record whose name v2 no longer
accepts is named in `stateWarning` instead of being dropped silently.

## Security layers

Guests reach this PC's loopback through slirp's `10.0.2.2`, so listening on
127.0.0.1 is not a boundary on its own. The layers, outermost first:

| Layer | Where | What it stops |
|---|---|---|
| The manager listens on 127.0.0.1 only | `server.js` | other machines |
| `Host` allow-list (`127.0.0.1`, `localhost`, `[::1]` with the right port), on every request, static files too | `http.js` | DNS rebinding, and ordinary guest requests (they arrive as `10.0.2.2`). A guest can forge `Host`, so the token below is what keeps guests out |
| `Origin` must be the manager's own; a POST without `Origin` but with a cross-site `Sec-Fetch-Site` is refused | `http.js` | cross-site requests from web pages |
| Token (`X-DevBox-Token`, `?token=` only for the SSE streams), constant-time compare, on every `/api/*` route but `GET /api/ping`; file permissions re-applied at every start; printed only to a console window | `http.js`, `config.js`, `server.js` | guests and local web pages, which cannot read `<data>/manager-token` |
| Clients trust a manager only after `GET /api/ping?nonce=` answered `HMAC(token, nonce + its port)` | `client.js`, `config.pingProof` | a stale `run/manager.json` or another program on a scanned port receiving the token or the `#token=` link |
| POST must be `application/json`, at most 1 MB, a JSON object; aborted uploads settle | `http.js` | form posts, oversized or hanging bodies |
| CSP `default-src 'self'`, no inline script or style, `X-Frame-Options: DENY`, `nosniff`, no referrer, no CORS; the GUI builds all dynamic content as text nodes | `http.js`, `public/app.js` | script injection through image metadata, Docker output, container output or task titles |
| Static files only from `public/`, resolved and prefix-checked, known types only | `http.js` | path traversal |
| QEMU monitor and serial console on a random 127.x.y.z (never 127.0.0.1; fails closed unless `allowSharedLoopback`) and random ports, new at every start (Windows), or unix sockets in `run/` or a checked private folder (Linux/macOS) - for VMs and microVMs alike; never in an API reply | `platform.internalHost()`, `vm.runtimeEndpoints`, `vm.socketPaths` | guests driving QEMU (`quit`, `hostfwd_add`, `migrate exec:`, file-writing commands); web pages spraying requests at a predictable address |
| Forwards and container ports bind 127.0.0.1 unless the user chose LAN for that port; a port must be free on both 127.0.0.1 and 0.0.0.0 | `ports.hostfwdRule`, `platform.isPortFree` | other machines reaching guests by accident; another program on 127.0.0.1 answering a LAN link |
| ssh: `BatchMode`, `IdentitiesOnly`, per-VM known_hosts with `accept-new`, owner-only key; each clone makes its own host keys at its first boot and the new key is pinned before the start ends | `ssh.js`, `platform.protectPrivateFile`, `vm.personalize` | impostors on a known VM's port (also a sibling VM, which would otherwise hold the template's host key); Windows OpenSSH refusing an exposed key |
| A pid is killed or adopted only when it is this manager's own QEMU child (ended through its handle), or a QEMU whose own monitor answered `info name` with the VM's name (never a pid another record holds); an old bake only after `info name` = `devbox-bake`; a container's QEMU only when its pid is a listed QEMU, equal to its `qemu.pid`, and named by its monitor - or, without a record, by its command line | `vm.confirmIdentity`, `vm.stillQemu`, `vm.adoptRunning`, `install.killOrphanBake`, `containers.adoptAll`, `run.forceStop`, `platform.processCommandLine` | killing or taking over another VM's (or program's) QEMU that reused a pid |
| Images: HTTPS only (HTTP only for a registry named `localhost`, `127.0.0.1` or `[::1]`; a plain-HTTP token realm only for such a registry), sha256 of every manifest and blob, diffIds checked, no credentials on a cross-host redirect; declared sizes and free space checked before any layer is downloaded; flatten in memory with caps on entries, bytes, depth, name and link length, PAX headers and the names kept, a free-space check on the exact size; `/.devbox` dropped from layers | `oci/registry.js`, `oci/layers.js`, `oci/images.js`, `microvm/run.js` | a tampered or hostile image exhausting memory or disk, escaping onto NTFS, replacing the engine's spec, or making the manager fetch a service on this PC |
| Private files: `run/` and `microvms/` locked to the user at every start (inheritable ACL / 0700); `vms.json`, `containers.json` and their `.bak` written from a temp file in `run/` (a rename keeps the ACL); share lists and `spec.sh` refused when they cannot be made private | `platform.protectPrivateDir`, `platform.writePrivateFileSync`, `shares.writeFwcfg`, `server.js` | other accounts of the PC reading share keys (read-write access to a shared folder) or container env values |
| Host paths: UNC and network paths refused before any file call (API, folder picker, MCP); the data folder compared by file identity too | `util.networkPathError`, `shares.validateShare`/`listDirs`, `mcp/tools.js` `guardLocalPath` | an SMB connection that sends the user's NTLM sign-in; `\\localhost\C$\...\data` sharing the data folder past a text comparison |
| microVM kernel: the APKINDEX RSA signature against Alpine keys shipped in `lib/microvm/keys`, then each package's size, control sha1, data sha256 and own signature | `microvm/apk.js`, `microvm/kernel.js` | a compromised mirror (trust is not HTTPS alone) |
| Container output: only strict, capped `__DEVBOX_*` lines are parsed (20 init messages of 300 characters at most); env values listed by name only, `spec.sh` deleted once the guest has read it; log caps per boot, in the guest AND enforced on the host (stat every 2 s); `console.log` read only at its ends; the memory budget; the RAM root capped | `microvm/containers.js`, `init.sh`, `run.readExit` | a hostile image forging status beyond its own container, leaking secrets through lists or logs, or exhausting the host |
| Shared folders: per-share secret (constant-time), jail by node tree + realpath on every operation, read-only enforced by the server, bounded memory per connection and share, secrets only in private files and fw_cfg | `lib/ninep/server.js`, `lib/shares.js` | one guest reading another's share or anything outside it; a hostile guest exhausting the manager |
| MCP `upload`/`download`/`copy_in`/shared folders refuse the data folder's private parts, `~/.ssh`, and for writes the program folder and Startup folders (realpath, case-insensitive on Windows); optional `DEVBOX_MCP_FILES` allow-list | `mcp/tools.js` `guardLocalPath` | a prompt-injected transfer handing a VM the token or key, or overwriting config/code |
| Container env values shown as `NAME=***` in task logs | `docker.redactEnv` | secrets in `logs/tasks.log`, the GUI and `get_task` |
| QEMU installer: sha512 plus an Authenticode signer pinned to the publisher whose certificate chains to a trusted CA | `install.checkInstallerSignature` | a compromised download server (the sha512 comes from the same server) |
| xterm link handler shows guest OSC 8 links in the app's own dialog | `public/app.js` | `confirm()`/`window.open()` phishing from guest output |
| Validation plus `shq()` quoting for everything sent into a guest shell; every value in a microVM run spec single-quoted | `util.js`, `docker.js`, `deploy.js`, `mcp/tools.js`, `microvm/initramfs.js` | command injection through image VOLUME paths, names, env, paths |

What a guest **can** still reach, by design of user networking: the internet
and the LAN, and everything on this PC that listens on 127.0.0.1 or on the
network, which includes every other VM's forwards and every container's
published ports. VMs and containers are one trust zone. The shared-folder
server is reachable too, but serves a share only for its key; the key is
visible inside the guest that mounted it (`/proc/mounts`). The monitor and
serial sockets have no password of their own: programs on this PC can reach
them if they find them (they are trusted), guests cannot. A VM adopted from v1
(`runtime.legacy`) keeps its v1 monitor on 127.0.0.1:25000+ until it restarts;
`/api/state` warns about it (`vm.legacyWarning`). Under TCG a guest is not a
security boundary (QEMU's own policy); the GUI and MCP say so for containers.

## How a VM start works

`POST /api/vm/start {name, waitS?}`:

1. **Validate** (`validateStart`): the name, the record (409 BUSY if a create
   still holds it), the `qemu` lock is free, not already running, the disk
   exists, QEMU is installed, and the template (the disk's backing file) exists.
   Then `tasks.start` with `vm:<name>` and a 202.
2. **Checks** (`opStart`): the disk and template again; every host port of the
   VM (SSH and forwards) must be free, with up to 8 s of grace for a QEMU that
   just exited; a warning when free memory is below the VM's size plus 256 MB.
3. **Accelerator** (`chooseAccel`): the VM's `accel`, else `settings.accel`,
   else `platform.detectAccel().recommended` (the first hardware accelerator
   found at start-up, else `tcg`). The wait for SSH is `waitS`, or
   `bootWaitS(accel)`: 240 s, 600 s for TCG.
4. **Endpoints** (`runtimeEndpoints`): on Windows a fresh random loopback
   address (`platform.internalHost()`: 127.a.b.c, checked with a test bind,
   else 127.0.0.2, else an error) and two free ports on it for the monitor
   and serial chardevs; elsewhere two unix socket paths (`socketPaths`).
5. **Shared folders**: `shares.registerFor('vm', name, vm.shares)` writes the
   private fw_cfg list and returns the `-fw_cfg` arguments (none, and no server
   start, for a VM without shares).
6. **Spawn** (`spawnQemu`): QEMU directly (no shell), detached, no window,
   stdout/stderr to `logs/qemu-<vm>.log`:
   - `-name -m -smp -machine q35`;
   - `-accel <hw> -accel tcg,tb-size=256`: QEMU falls back by itself. WHPX
     runs as `whpx,kernel-irqchip=off` with a `qemu64` CPU model carrying
     the host's SSSE3/SSE4.x/POPCNT flags; KVM, HVF and TCG use `-cpu max`.
   - `-drive ...,if=virtio,discard=unmap,detect-zeroes=unmap`;
   - `-netdev user,hostfwd=<tcp|udp>:<127.0.0.1|0.0.0.0>:<host>-:<guest>...`
     and `-device virtio-net-pci,mac=<from the SSH port>`;
   - `-display none`, the serial chardev (also logged to
     `sandboxes/<vm>-serial.log`), the monitor chardev, the shares' `-fw_cfg`,
     `-pidfile`.

   There is no `-no-reboot`, so a guest reboot reboots. The child handle is
   kept in `children`, and `runtime` is saved.
7. **Wait** (`waitForBoot`), every 1.5 s:
   - QEMU exited → `died`;
   - a force stop → `aborted`;
   - an SSH banner on the port (4 s probe) → `up`;
   - "Kernel panic - not syncing" in the serial log → `panic`;
   - the deadline → `timeout`.

   Progress with the last console line is logged every 15 s.
8. **Outcomes**:
   - `died` within 20 s under a hardware accelerator, and QEMU said nothing or
     named the accelerator: retry once with TCG (and TCG's wait). QEMU rejects
     the q35 machine: retry once with its default machine. A control socket
     that could not bind: retry with new endpoints. Otherwise the task fails
     with `lastError`: QEMU's output and the console tail.
   - `panic`: end this QEMU (`endOwnQemu`: monitor `quit`, then kill our own
     child) and try once more; a second panic fails the start.
   - `timeout`: the task fails, and the VM keeps running so the serial console
     can show why.
9. **Up**:
   - The SSH probe cache is seeded as running.
   - The accelerator QEMU really uses is read from its output
     (`effectiveAccel`) and recorded.
   - On a clone's first boot, `personalize` sets the hostname to the VM name
     and the time zone to this PC's over `ssh ... sh -s`. It never fails the
     start; it is tried again next time.
   - Once the task has ended, the shares' mount job runs (see above).
   - The result is `{name, port, ssh, accel}`.

**Status after that** (`describeVm`, run for every VM on every
`GET /api/state`; concurrent callers share one run):

- `vmAlive` is exact without a process listing for QEMUs this manager
  spawned (the child handle, plus `pidAlive`, because the `exit` event can
  trail the process's end) and for pids a listing already showed as QEMU.
  Only unverified pids (adopted at start-up) cost one shared
  `tasklist`/`ps` listing.
- `sshUp` probes the banner in the background (5 s timeout; a poll waits at
  most 1 s, and results are fresh for 5 s). A running VM needs two failed
  probes in a row to turn `booting`.
- A VM whose QEMU is gone while no task holds it gets `lastError` if the exit
  was unexpected. Its runtime is cleared, and its shares are disconnected and
  unregistered.
- Disk virtual size and snapshots come from `qemu-img info -U`, cached and
  refreshed in the background, never while a task holds the VM.

**Stop** (`opStop`). Every step is bounded:

1. Close the VM's terminals.
2. Unless forced, run `sync; poweroff` over SSH (15 s). An exit 255 counts
   only when the session dropped, not when ssh could not log in
   (`sshDropped`). Otherwise press ACPI `system_powerdown` through the
   monitor.
3. Wait up to `timeoutS` (45 s, 90 s under TCG). A force stop cuts the wait
   short.
4. Send `quit` through the VM's own monitor.
5. Kill, but only if `stillQemu` says the pid is still a QEMU **and**
   `confirmIdentity` says it is this VM's: its own child, or confirmed by its
   monitor. A pid that is another VM's just clears the record; unknown means
   "do not kill".

After QEMU exits, the VM's shares are disconnected and unregistered. Disk
operations that delete or replace a file first wait for a background
`qemu-img` read (`infoIdle`), and retry briefly on EPERM/EBUSY (`retryFs`),
because Windows cannot delete an open file.

**Manager restart:** VMs are detached and keep running. At start-up (in the
background, after the server listens), `adoptRunning` keeps a recorded runtime
only when:

- its pid is still a QEMU;
- no earlier record claims that pid;
- the VM's own monitor answers `info name` with its name.

Everything else is cleared, and left running: it may be someone else's.
`adoptRunning` only touches records nobody changed meanwhile, so a start or
create that spawned its QEMU during the slow process listing keeps its
runtime. Only right after loading a v1 registry are records whose SSH port is
held by a QEMU adopted, as `legacy`. Then `shares.restoreRunning` re-mounts
the running VMs' shares, and `autostartAll` starts autostart VMs one after
another, each as a normal task.

## The MCP server and the manager

`mcp-server.js` points `console.*` and `process.stdout.write` at stderr before
anything else loads, so only protocol reaches stdout; it exits when stdin
closes. `lib/mcp/protocol.js`:

- handles `initialize` (protocol versions 2024-11-05 to 2025-11-25: the
  client's if supported, else the newest), `ping`, `tools/list`,
  `tools/call`, and empty prompt and resource lists;
- answers requests concurrently (a tool may wait minutes for a boot while
  the host keeps pinging);
- turns every failure into an `isError` result or a JSON-RPC error, never a
  crash. An unknown tool name is the protocol error `-32602` (with the
  available names in `data`), as the MCP specification asks.

```
 Claude ──stdio──► mcp-server.js ──► tools.js ──► client.connect()
                                                     │  1. read <data>/run/manager.json, GET /api/ping?nonce=,
                                                     │     accept it only if rootId = sha256(data folder)
                                                     │     and proof = HMAC(token, nonce + port)
                                                     │  2. none: spawn `node server.js --no-open`, detached,
                                                     │     no window, VM_MANAGER_ROOT=<data>, output to
                                                     │     logs/manager-console.log; poll up to 20 s
                                                     ▼
                                          manager HTTP API (X-DevBox-Token read from <data>/manager-token)
```

- **Lifecycle through the API.** These tools start manager tasks, so the GUI
  shows them, locks apply, and they survive MCP host restarts:
  - `create_vm`, `start_vm`, `stop_vm`, `delete_vm`, `reset_vm`, `setup`,
    `snapshot`;
  - `forward_port` (`POST /api/vm/ports {add}`: one change applied to the
    current list under the VM lock, never a stale full list);
  - `share_folder` and `unshare_folder` (`POST /api/vm/shares`);
  - `run_image` (`POST /api/container/run`, the `ctr-run` task), `stop_image`,
    `pull_image`;
  - `deploy_image`. With `engine="docker-vm"`, or after an automatic
    fallback, it follows with the quick deploy.

  Containers are created with `createdBy: "mcp"` and VMs with `"claude"`;
  `cleanup` treats both as Claude's. The manager must outlive the MCP server:
  hosts restart MCP servers freely, and a running boot must not notice.
- **Waiting.** `client.waitForTask` polls `GET /api/task?id=` every 1.5 s over
  a keep-alive connection until the task ends or the tool's `timeout_s`
  passes. The tool then returns `{status: "running", task_id}`, and `get_task`
  follows it.
  - `timeout_s` never shortens the manager's own boot wait (`bootWaitS` only
    passes a longer one).
  - `create_vm docker=true` keeps going after a timeout, so the VM still gets
    Docker.
  - `run_image wait_for="exit"` then reads the container's stdout and stderr
    byte for byte (capped like `exec`).
- **Work inside a VM goes straight to the guest.** `exec`, `write_file`,
  `read_file`, `upload` and `download` use `lib/ssh.js` directly (the same key
  and per-VM known_hosts as the manager), after checking with `/api/state`
  that the VM is `running`. Files and folders stream over ssh with `cat` or
  `tar` on both sides; `scp` is only a fallback when this PC has no `tar`. They
  are not manager tasks: that would only add latency.
- **Safety defaults.**
  - New forwards and container ports are this PC only unless `lan=true`.
  - VMs and containers are created temporary.
  - `cleanup` deletes only what Claude created (never a GUI VM or container,
    even a temporary one).
  - Local paths (uploads, downloads, `copy_in`, shared folders) must be
    absolute and pass `guardLocalPath` (see the security table).
- **`restart_server`** builds its reply first and exits about 0.5 s after the
  reply is written (`ctx.afterReply`); the host starts a fresh copy on the next
  call. The manager, the VMs and the containers are not affected.

`tools/mcp-probe.js` checks the server the way a host uses it:

- `initialize`;
- the initialized notification (it must not be answered);
- `ping`;
- `tools/list`, with a schema check of every tool;
- an unknown method (-32601);
- an optional tool call (e.g. `run_image`);
- no stray stdout, and an exit when stdin closes.

## Tests

`node --test tests/` (`npm test`). `tests/index.js` makes that exact command
work on Node 22+, which treats a folder argument as a module; Node 18/20 run
each `*.test.js` in its own process. `tests/helpers.js` points `CFG` at a
private temporary root before anything else, so no test touches a real data
folder.

- **Real QEMU**: tests with real QEMU use blank scratch disks, and are
  skipped when QEMU is missing.
- **Guest shell scripts** (the bake's boot tweaks, personalisation, the
  Docker and redeploy scripts) are run with a real POSIX `sh` where one
  exists; the others are at least syntax-checked with `sh -n`.
- **Nothing is downloaded**: `/api/setup` and `/api/install/*` are never
  POSTed in tests.
- **The MCP tools** run against a fake manager through `createTools(deps)`.
- **`tests/readme-api.test.js`** fails when the README's API tables and the
  `ROUTES` table in `lib/http.js` differ in either direction.

The engine and the shared folders are tested at every level, without the
network:

- **The container lifecycle** runs against a fake QEMU
  (`tests/microvm-supervisor.test.js`). It is a node script that gets the real
  command line, serves the console and monitor sockets and plays the guest's
  side of the console protocol. The cases cover:
  - a stop before READY and a stop during prepare;
  - the STOP → KILL → quit order;
  - a boot that hangs before init;
  - adoption after a simulated restart;
  - four concurrent starts and the volume race;
  - log rotation and `autoRemove`;
  - live shared folders;
  - the engine rules and the fallback;
  - the HTTP routes;
  - the review fixes: the host-side log cap, the runtime saved at spawn,
    adoption by `qemu.pid` and identity, `--rm` for an exit while away, lost
    VMs proven by their command line, a failed forced stop, the QEMU lock
    during a start, a volume listed twice, pending ports, a failed fallback
    giving the ports back. The pure and file-level ones (network paths,
    private files, image GC during a start, the adoption gate, the flatten
    and tar caps) are in `tests/hardening.test.js`, `tests/oci-layers.test.js`
    and `tests/oci-registry.test.js`.
- **The OCI tests** use a mock registry on port 0 and locally built images,
  including flatten edge cases (whiteouts, opaque directories, hard links,
  symlinked parents), the flatten caps and concurrent first builds.
  `tests/oci-real-images.test.js` and `tests/microvm-compat.test.js` only READ
  the image cache in `data/images` when it exists.
- **The 9P server** is tested with its own client (`tests/helpers/ninep-client.js`):
  every message type, paging, big round trips, framing abuse, auth failures,
  limits, jail cases, boot-id takeover and backpressure.
- **Real microVM boots** are opt-in (`DEVBOX_BOOT_TESTS=1`).
- **The end-to-end matrix** is opt-in too (`DEVBOX_E2E=1`,
  `tests/microvm-e2e.test.js`): the real `server.js` on a scratch data root
  whose kernel and image cache are hard links of `data/` (nothing is
  downloaded), driven over the HTTP API and the MCP server - hello-world,
  exit codes and streams, 126/127, nginx on this PC only, the V7 squatter, a
  live share with an edit served at once and a wrong key refused, a volume
  below a share, the volume race, stops during boot, 4 concurrent runs, 3
  concurrent cold builds of one image, copy-in, a TCG subset, a forced stop
  keeping volume data, the RAM-root fill, the memory budget, the QEMU-update
  refusal, a manager restart with re-adoption and a re-mounted share, MCP
  `run_image`, and (`DEVBOX_E2E_VM=1`) a full VM's shares both ways,
  read-only, after a reboot inside the VM and shared by a second VM. It ends
  only the QEMUs whose command line names its scratch root. Not in it: the
  kernel setup (it downloads), TLS/DNS from the guest (network), smp-2 (more
  than 1 vCPU is still clamped on microvm) and the s6/systemd fallback
  (needs an unapproved image).

Further end-to-end runs are scripts outside the suite. They drive a real
manager over the HTTP API and the MCP server:

- the matrix of microVM spec 18.2: timings, exit codes, volumes, stop races,
  concurrency, TCG;
- registry errors against a local mock registry;
- the shared-folder cases, including reboots and manager restarts;
- MCP round trips;
- a Docker-in-VM regression.
