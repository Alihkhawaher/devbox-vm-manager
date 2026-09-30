# devbox VM Manager

**Run Docker images on Windows without Docker Desktop, WSL or Hyper-V.**

Type an image reference, or let Claude do it, and the image runs in seconds as
its own lightweight **microVM**. The manager pulls the image straight from its
registry, boots it with a small Linux kernel under QEMU, and hands back its
link, or its output and exit code. No Docker Engine runs anywhere. For compose
stacks and interactive work, the same manager runs **full Alpine Linux VMs**
with Docker inside. Folders of this PC can be **shared live** with both. An
**MCP server** lets Claude create boxes and run images on demand.

- **One image, one microVM, in seconds.** Measured on a Windows 10 PC with a
  cached image: `hello-world` returns its output and exit code 1.4 s after
  the request, and `nginx:alpine` answers HTTP 200 after 1.8 s. A graceful stop
  takes 0.1-0.35 s. A 256 MB nginx guest costs 292 MB of RAM. The hypervisor
  isolates each container, one VM per image
  ([details](#running-a-docker-image)).
- **Full Linux VMs with Docker inside**, for compose stacks, privileged
  images and anything the microVM engine cannot run. They are also
  interactive boxes to build and test in: a root terminal in the browser, SSH,
  snapshots and templates. A new VM answers on SSH in 12-14 s
  ([which engine when](#which-engine-to-use)).
- **Live shared folders**: a folder of this PC appears inside a VM or a
  container, both ways, with nothing to install and no copying
  ([details](#shared-folders-live)).
- **Claude integration**: 31 MCP tools. Claude can run images, create VMs,
  run commands in them, move files, share folders and clean up after itself
  ([details](#claude-integration-mcp)).
- **Your ports stay on this PC**: every published port listens on 127.0.0.1
  unless you switch that one port to "reachable from the LAN".
- **Nothing to install but Node.js 18.17+**: the Node standard library only,
  no `npm install`, no admin rights, no Docker Desktop, WSL or Hyper-V. On
  Windows, setup downloads and verifies QEMU itself. Hardware acceleration
  uses the *Windows Hypervisor Platform* when that optional Windows feature is
  on. Without it, QEMU emulates the CPU (TCG), which works on every PC and is
  about 5x slower to boot.
- **Windows 10/11 is the primary, fully tested platform**, with and without
  hardware acceleration. Full VMs also run on **Linux and macOS** with QEMU
  installed. The microVM engine and shared folders have Linux (KVM) and macOS
  code paths, but those were not tested end to end yet.

## Quick start

You need **Node.js 18.17 or newer** ([nodejs.org](https://nodejs.org); the LTS
installer is fine).

### Windows 10 / 11

1. Double-click **`vm-manager.cmd`**. A console window starts the manager and
   opens the GUI in your browser. Keep the window open: it is the server.
2. On the **Setup** card, press **Set up for Docker images (about 1 minute)**.
   It installs QEMU when it is missing (downloaded from qemu.weilnetz.de,
   checked, and unpacked with 7-Zip into the data folder; no installer runs).
   Then it installs the verified microVM kernel (about 43 MB).
3. In **Run a Docker image**, type `nginx:alpine` and press **Run**. The link
   to the running server appears a few seconds later.
4. Optional: **Set up everything** also builds the base image for full VMs
   (about 2 minutes with hardware acceleration, 10-20 minutes without).
5. Optional, for speed: turn on **Windows Hypervisor Platform** (Control
   Panel > Programs > Turn Windows features on or off; needs an administrator
   once and a restart). Everything also works without it.

### Linux

```
sudo apt install qemu-system-x86 qemu-utils openssh-client   # or dnf / pacman, see Prerequisites
sudo usermod -aG kvm $USER                                    # for KVM; log in again afterwards
./vm-manager.sh                                               # or: node server.js
```

Then follow steps 2-4 above. The microVM engine and shared folders are built
for KVM and unix sockets on Linux, but have not been tested end to end there
yet.

### macOS

```
brew install qemu
./vm-manager.sh
```

Intel Macs use HVF. Apple Silicon Macs can only emulate the x86-64 guests
(TCG), which works but is slow. The microVM engine is untested on macOS.

### Run your first image, three ways

- **GUI**: the **Run a Docker image** card (above).
- **Claude**: register the MCP server ([below](#claude-integration-mcp)) and
  ask, for example, "run nginx:alpine and give me the link" or "run
  `python -c 'print(2**100)'` in python:3-alpine".
- **API** (Git Bash on Windows, or any POSIX shell; the token is in
  `<data>/manager-token`):

  ```
  T=$(cat data/manager-token)
  curl -s -H "X-DevBox-Token: $T" -H "Content-Type: application/json" \
       -d '{"image":"hello-world"}' http://127.0.0.1:8777/api/container/run
  # -> 202 {"task": {"id": "..."}, "engine": "microvm", "container": {...}}
  curl -s -H "X-DevBox-Token: $T" "http://127.0.0.1:8777/api/task?id=<task id>"
  # -> the task's result: status "exited", exitCode 0, stdout "Hello from Docker! ..."
  ```

### Starting the manager

| System | Start it |
|---|---|
| Windows | double-click **`vm-manager.cmd`** |
| Linux / macOS | `./vm-manager.sh` (or `sh vm-manager.sh`) |
| any | `node server.js` (or `npm start`) |

The launchers find Node on PATH or in the usual install folders, say where to
get it if there is none, and pass their arguments through
(`vm-manager.cmd --port 9000`). If the manager stops with an error, the Windows
window stays open so you can read it.

The console window (or terminal) is the server, so keep it open. It prints the
link to the GUI and opens it in your browser:

```
  devbox VM Manager 2.0.0
  --------------------------------------------------
  Open:      http://127.0.0.1:8777/#token=3f9c...
  Data:      C:/Tools/devbox-vm-manager/data
  QEMU:      QEMU emulator version 10.2.0 ...
  Base:      NOT BUILT
  VMs:       0
```

The `#token=` part is the access key (see [Security](#security)). The page
stores it and removes it from the address bar. Closing the window (or Ctrl+C)
stops the manager. **Running VMs and containers keep running** and are
picked up again the next time it starts. If you start it a second time for
the same data folder, it opens the running copy instead of starting another
one.

### First run: what setup does

The **Setup** card lists what is missing. Each item comes with the exact fix
for your system and a Copy button. **Set up for Docker images (about 1
minute)** stops after step 3; **Set up everything** runs all five steps. Setup
runs as one task with a live log and skips every step that is already done:

1. **SSH key**: an ed25519 key pair that every VM trusts
   (`<data>/seed/id_dev`, readable only by you).
2. **QEMU** (Windows only, when it is missing): downloads the newest build from
   qemu.weilnetz.de, checks its sha512 and digital signature, and unpacks it
   with 7-Zip into `<data>/qemu`. No installer runs and nothing is written
   outside the data folder. On Linux and macOS, install QEMU with your package
   manager first ([Prerequisites](#prerequisites)).
3. **microVM kernel** (about 43 MB): Alpine's `linux-virt` kernel and
   `busybox-static`. The Alpine package index is checked against Alpine's RSA
   signing keys, which ship with the app. Each package is then checked against
   the index and its own signature. One short test boot then measures this
   PC's clock (the microVMs need it). After this step **Docker images can run**.
   The log says so while the base image for full VMs is still being built.
4. **Alpine image**: the newest Alpine Linux "nocloud" cloud image (3.23.4
   today, about 180 MB), verified against its published sha512.
5. **Base image**: boots that image once and lets cloud-init install a
   toolchain (bash, git, curl, jq, make, gcc, python3, pip, vim, nano, htop,
   strace, tzdata and more) and the shared-folder service. The manager checks
   the result over SSH, shuts the guest down cleanly and saves it as
   `devbox-base.qcow2`. Every VM is a thin clone of it.

Measured on a Windows 10 PC with WHPX, the whole setup took **115 s** (38 s
download, 74 s bake). The kernel step adds its 43 MB download plus about 6 s
for unpacking and the test boot. Without hardware acceleration the bake can
take 10-20 minutes. After that, a new VM answers on SSH in **12-14 s** (see
[Acceleration](#acceleration-and-speed)).

### Where everything goes, and how to move it

Everything the manager writes lives in **one data folder**: VM disks,
templates, the image cache, container logs, volumes, the SSH key, the access
token, logs and the registries. Nothing is written to your home folder or to
the system. The one exception: on Linux and macOS, a data folder with a very
long path puts the QEMU sockets in a private folder under `$XDG_RUNTIME_DIR`
or `/tmp` (mode 0700, owned by you, checked before every use). The folder is
chosen in this order:

1. `--data <dir>` on the command line;
2. the `VM_MANAGER_ROOT` environment variable;
3. an existing v1 install in your home folder (`~/sandboxes` or
   `~/devbox-base.qcow2` exists), so old installs keep working unchanged;
4. **`data/` next to `server.js`** (the default for new installs; git ignores it).

After a full setup the folder holds about 630 MB: the 445 MB base image plus
the 184 MB pristine Alpine download (kept so the base can be rebuilt). The
microVM kernel adds about 60 MB. Cached Docker images take their download size
plus one boot image each: the six test images (hello-world, alpine, busybox,
nginx:alpine, python:3-alpine, nginx-unprivileged) take 281 MB together. A
new VM starts at a few hundred KB and grows with what you install in it. A
template frozen from a VM with Docker is about 800 MB. The manager's first
screen shows the free space on that drive.

**To move it**, stop the VMs, the containers and the manager. Move or copy the
whole folder (to another drive or another PC), then start with
`--data <new folder>` or set `VM_MANAGER_ROOT`. Clones store the path to their
template relative to their own folder, so they keep working. To make the
choice stick for the launcher, set the variable for your user:
`setx VM_MANAGER_ROOT "D:\devbox-data"` on Windows (no admin needed; open a
new window afterwards), or an `export` line in your shell profile. Then update
Claude's MCP configuration too: the **Connect Claude** panel shows the new
one. On Windows, keep the data folder's path short: QEMU cannot open paths
longer than 259 characters, and a microVM start says so.

`<data>/config.json` is optional and moves with the folder. It holds settings
for that folder, not its location:

```json
{ "port": 9000, "qemuDir": "D:\\qemu", "ssh": "C:\\Windows\\System32\\OpenSSH\\ssh.exe" }
```

Keys:

- `port`;
- tool paths, for when discovery does not find them: `qemuDir`, `ssh`,
  `sshKeygen`, `scp`, `sevenZip`;
- for Docker images and shared folders:
  - `ninepPort`: the shared-folder server's port, 5640 by default. The manager
    writes it itself only when 5640 was taken and it had to pick another port.
  - `containerLogCapMB`: the per-boot cap on each of a container's stdout and
    stderr, 1024 by default.
  - `microvmMemCapMB`: the most RAM a microVM may need before Automatic prefers
    a Docker VM. The default is 2048 MB or half of the largest VM memory,
    whichever is smaller.
  - `alpineMirror`: where the kernel packages come from (https only).

A file that is not valid JSON is ignored, and the GUI shows a warning. Two
keys switch off a safety rule, and only the JSON value `true` counts:

- `"allowUnsignedQemu": true` - install a QEMU installer that is not signed by
  its known publisher (see [Security](#security)).
- `"allowSharedLoopback": true` - Windows only. Some security software stops
  the manager from binding any loopback address other than 127.0.0.1. With
  this key, the QEMU monitor and serial console may then listen on 127.0.0.1,
  where the VMs can reach them. Without it, such a start fails with an error
  that says so. With it, the GUI shows a warning.

### Command line

```
node server.js [--port <n>] [--data <dir>] [--no-open] [--help]
```

| Option | Meaning |
|---|---|
| `--port <n>` | GUI/API port on 127.0.0.1 (default 8777). If another program holds it, the first free port of the next 20 is used and printed. |
| `--data <dir>` | the data folder (see above) |
| `--no-open` | do not open a browser. A console window still prints the link with the token. When there is no console (the MCP server started the manager, or the output goes to a file), only the address is printed, and the token stays in `<data>/manager-token`. |
| `--help` | usage |

Precedence is **command line > environment > `<data>/config.json` > defaults**.
The port: `--port` > `VM_MANAGER_PORT` > `config.json` `"port"` > 8777.

### Prerequisites

The Setup card lists each item with the fix for your system.

| Item | Windows | Linux | macOS |
|---|---|---|---|
| QEMU (`qemu-system-x86_64`, `qemu-img`) | installed by setup (needs 7-Zip), or from qemu.weilnetz.de/w64 | `sudo apt install qemu-system-x86 qemu-utils openssh-client` / `sudo dnf install qemu-system-x86 qemu-img openssh-clients` / `sudo pacman -S qemu-base openssh` | `brew install qemu` |
| OpenSSH client (`ssh`, `ssh-keygen`) | Settings > System > Optional features > **OpenSSH Client** (usually already there) | `openssh-client` / `openssh-clients` | built in |
| 7-Zip | only to unpack QEMU: [7-zip.org](https://www.7-zip.org) or `winget install 7zip.7zip` | not needed | not needed |
| Hardware acceleration (optional, much faster) | Windows feature **Windows Hypervisor Platform** | `/dev/kvm` usable: `sudo usermod -aG kvm $USER`, then log in again | HVF on Intel Macs; Apple Silicon emulates x86 guests (TCG) |

The OpenSSH client is needed for full VMs (their terminal, `exec` and file
transfers). Docker images as microVMs need only QEMU and the kernel.

Tools are looked for in this order: the `config.json` override, `<data>/qemu/`
(the managed install), PATH, then the usual folders (`%ProgramFiles%\qemu`,
`%SystemRoot%\System32\OpenSSH`, `%ProgramFiles%\7-Zip`, Homebrew, `/usr/bin`,
...). On Windows the system OpenSSH client is preferred over Git's copy. A tool
you install while the manager runs is found within 30 s, without a restart.

On Windows, **Update QEMU** (in the prerequisites list) downloads the newest
build, checks it, unpacks it next to the old one and swaps the folders, so a
failed update never leaves a half-replaced QEMU. It is refused while VMs or
containers run, because Windows locks the program files they use.

## Which engine to use

| | **microVM** (the default for one image) | **Docker inside a full VM** | **A full VM** on its own |
|---|---|---|---|
| What runs | the image's own program, with a busybox init as PID 1; no Docker Engine | an Alpine VM with Docker Engine, which runs the image | Alpine Linux with a toolchain; a root shell over SSH and in the browser |
| Start (image cached, WHPX) | 1.4-2.9 s | 28-34 s from the `docker-ready` template, minutes without one | 12-14 s to SSH |
| RAM | 256 MB by default (the image is held in RAM) | a 2 GB VM by default | 1 GB by default |
| Best for | one image: a server, a database, a one-shot command, a CLI tool | compose stacks; privileged, host-network or Docker-socket images; restart policies; systemd and s6-overlay images; images too big to hold in RAM | building, installing and testing by hand or by Claude (`exec`) |
| Files | named volumes, live folders of this PC, copy-in | folders inside the VM and Docker volumes | its own disk; live folders of this PC |
| Start it from | **Run a Docker image**; MCP `run_image`, `deploy_image` | the same card with engine **Docker inside a VM**, or a VM's Docker tab; MCP `deploy_image engine="docker-vm"` | **Create a VM**; MCP `create_vm` |

**Automatic** (the default engine in the GUI, `engine: "auto"` in the API and
MCP `deploy_image`) picks for you:

- **Decided from the request alone, before anything starts**: privileged
  mode, host networking, devices, compose, a restart policy other than `no`,
  or a volume at the Docker socket all go to Docker inside a new VM at once.
  The reply names the engine and the reason.
- **Decided from the image**: an image that boots systemd or s6-overlay (both
  must be PID 1), declares the Docker socket as a volume, has zstd layers this
  Node cannot unpack, or is too big to hold in RAM. The manager finds these
  only after the pull, so the run **never switches engine by itself**. It ends
  with the reason and a **Run with Docker-in-VM instead** offer, which costs
  about 2 GB of RAM and a few minutes. MCP `deploy_image` with
  `engine="auto"` follows that offer on its own and says so. `run_image`
  reports it.
- **Everything else runs as a microVM.**

`engine: "microvm"` never uses Docker. A request that needs it is answered
409 `NOT_COMPATIBLE` with the reason; an image that needs it ends its run with
"not compatible with the microVM engine" and the reason. The one exception is
a too-big image, which runs anyway, with a warning. `engine: "docker-vm"`
always uses Docker inside a new VM (the
[quick deploy](#docker-inside-a-vm-and-deploying-images)).

## Running a Docker image

**Run a Docker image** runs one image as its own headless VM:

1. The manager pulls the image from its registry into `<data>/images`.
   Pulls are anonymous, over HTTPS, and every blob is checked against its
   digest.
2. It turns the image's layers into the VM's root filesystem in memory. The
   layers are never unpacked onto NTFS.
3. It boots that filesystem with the Alpine `linux-virt` kernel and a small
   busybox init as PID 1.
4. Init mounts the volumes and shared folders, then runs the image's
   entrypoint as the image's user.
5. Init relays the app's output and passes its exit code back.

The QEMU machine is `microvm` (q35 when this QEMU lacks it or when more
devices are needed). Each container has its own network (QEMU user
networking), and its ports are forwarded to this PC like a VM's.

The form's defaults are usually fine: an image reference and **Run**. Under
**Options** are the ports, the environment, volumes and folders, the command,
the name, memory, "Remove the container when it exits", "Start it with the
manager" and "Temporary". **Advanced** has the engine, privileged mode and
host networking. The same fields exist in `POST /api/container/run` and MCP
`run_image`.

The run is a task. It ends with the app's links once the app has started and
its first published TCP port answers (after 20 s without an answer it ends
anyway, with a warning). If the app exits first (a one-shot command), it ends
with the exit code and the last 4 KB of stdout and stderr.

The **Containers** card then lists the container: its status and exit code,
links with **This PC** / **LAN** badges, uptime and memory, plus Logs,
Stop/Start, Remove and a detail panel (overview, logs, settings). Containers
are kept until you remove them, like Docker's. **Delete all temporary
containers** removes the ones marked temporary.

### Ports: this PC or the LAN

The same rule as for VMs: a published port is reachable from **this PC only**
(it listens on 127.0.0.1) unless you tick **LAN** for that port (then it
listens on 0.0.0.0). You choose per port:

- in the form: the **LAN** tick on each port row, or the "reachable from the
  LAN" checkbox for the ports the image declares;
- in text: `8080:80`, `8080:80/udp`, `3000` (the same number on both sides),
  `lan:8080:80`, `local:8080:80`, `8080:80,lan`, `0.0.0.0:8080:80`,
  `127.0.0.1:8080:80`;
- MCP: `lan=true`, which Claude is told to use only when you ask. Claude's
  port strings cannot open a port to the network on their own: a
  `0.0.0.0:`, `lan:` or `,lan` entry is refused unless `lan=true`.

Without any ports, the ports the image declares (`EXPOSE`) are published:

- 80 on 8080, 443 on 8443;
- other ports below 1024 on 8000+N;
- the rest on the same number;
- another free port when that one is taken.

`ports: []` publishes nothing. UDP is forwarded, but only TCP ports get links.
A port that another program holds is refused, and the error says which. A LAN
port is checked on both 127.0.0.1 and 0.0.0.0, so a program already listening
on 127.0.0.1 cannot hijack its link. The first LAN port may make Windows
Defender Firewall ask whether QEMU may accept connections.

"This PC only" includes the VMs and containers on this PC: they reach this
PC's 127.0.0.1 through `10.0.2.2` (see
[What a VM can reach](#what-a-vm-can-and-cannot-reach)). This is also how
containers talk to each other: a container reaches another container's
published port at `host.docker.internal:<port>`.

### Environment

`NAME=value`, one per line (or a list, or `{"NAME": "value"}` in the API and
MCP). Values are treated as secrets. They are stored in the private data
folder, listed by name only (`GET /api/container?reveal=1` shows them), and
never written to a log. The run spec that carries them into the guest is
deleted once the guest has read it. `NAME` without `=` is refused. Docker
would copy that variable from the caller's environment, which here would be
the manager's own. The whole environment may be 30 KB at most. For more,
put the configuration in a file and copy it in.

### Files: named volumes, live folders, copy-in

The root filesystem lives in RAM, so **everything outside volumes and shared
folders is reset every time the container starts**. Docker keeps a stopped
container's files; here they are gone.

| | **Named volume** | **A folder of this PC** (live) | **Copy-in** |
|---|---|---|---|
| Written as | `pgdata:/var/lib/postgresql/data` (`:ro` read-only, `,nocopy` no seeding) | `C:\Users\me\site:/usr/share/nginx/html` (`:ro` read-only) | a folder row with **copy** ticked, or `copyIn: ["C:\\dir:/path"]` |
| What it is | an ext4 disk in `<data>/volumes`: 8 GiB, sparse (a new one takes about 2 MB) | the folder itself, served by the manager's file server ([Shared folders](#shared-folders-live)) | a one-way snapshot of the folder, taken at start |
| Changes | kept across starts and after the container is removed | both ways at once: an edit on this PC is served on the next request; the container's writes land on this PC at once | stay inside the container's RAM; nothing is written back |
| Good for | databases and app state | source code, a website, output you want on this PC | huge trees such as `node_modules`, where a live folder is slow |
| Limits | one running container at a time (a second start is refused and names the holder) | 8 per container; no file-watch events for edits made on this PC | 512 MB at most; adds its size to the guest's RAM unless it lands inside a volume |

- A new named volume is **seeded from the image's content** at that path on
  first use, as in Docker. The seeding is all or nothing: a copy that fails
  (the volume is too small) or is cut short ends the start with the reason,
  and the next start seeds it again. **Volumes** (in the Containers card)
  lists them with their size and users, and can create and remove them. A
  volume can be removed unless a running container uses it. Removing a
  container never removes its volumes. A volume can be mounted once per
  container (listing it twice is refused).
- Mounts may be nested, as in Docker: a volume below a shared folder (the
  usual `C:\project:/app` plus `node_modules:/app/node_modules`), or a volume
  below another volume, is mounted after its parent, whatever the order you
  list them in. The mount point is created in the parent (in the folder on
  this PC, for a shared folder).
- Copied-in scripts and binaries get mode 0755, other files 0644, all owned by
  the container's user.
- Docker-in-VM does not take folders of this PC: the Docker engine runs in
  another VM, so a request with one is refused there with a hint.

### Logs

The Logs tab shows stdout and stderr separately, plus two more logs: the VM's
console (boot and init messages; read it when a start fails) and QEMU's own
output. **Follow** shows them live. The same logs are available through
`GET /api/container/logs` (stdout and stderr byte for byte) and the SSE
stream. MCP `image_logs` reads them too. The previous boot's logs are kept as
the "previous run". Each boot's stdout and stderr are capped at 1 GiB each
(`containerLogCapMB`). The guest drops what comes after the cap; if a stream
still grows well past it (an app in the guest can get around the guest's own
cap), the manager stops the container ("its stdout log passed the limit"), so
a container cannot fill this PC's disk. The Logs tab can also show
**Output and errors** together.

### Exit codes

The codes follow Docker's:

| Code | Meaning |
|---|---|
| 0-255 | the app's own exit code; 128+N means it was killed by signal N (143 = SIGTERM, 137 = SIGKILL) |
| 125 | the engine failed, and the reason names it: a volume or shared folder that could not be mounted, a guest kernel panic, a boot that timed out (90 s, 240 s under TCG), QEMU that could not start |
| 126 | the user was not found, or the command is not executable; the guest's message comes with it |
| 127 | command not found; the guest's message comes with it |
| none | stopped before the app started (a stop during the pull or the boot), or stopped outside the manager (for example the PC shut down) |

A container that fails at once also gets a diagnosis when there is one: out of
memory (with a bigger size to try), needs PID 1, runs containers itself, a
missing CPU feature, or the wrong architecture. It gets the **Run with
Docker-in-VM instead** offer when that would help.

### Stopping

**Stop** sends the image's stop signal (SIGTERM unless the image says
otherwise). It waits the stop timeout (10 s by default, `timeoutS` in the API,
`timeout_s` in MCP), then kills the app **inside** the guest. The guest still
flushes and unmounts the volumes, so their data is safe. A stop is never a
power cut. Only a guest that does not react at all is powered off.

- A stop is accepted at any time, also while the image is still being pulled
  or booted: the guest acknowledges it, and the manager repeats it until it
  does.
- **Force stop** sends SIGKILL at once.
- The result says how the container ended: `graceful`, `killed after N s`,
  `killed (force)`, `forced (quit)`, `stopped before the app started` or
  `already exited`. A QEMU that cannot be ended at all fails the stop with
  "did not stop - end it in Task Manager", and the container stays listed as
  running.
- A stop that lands while nginx's entrypoint shell runs ends with SIGKILL after
  the timeout, because that shell ignores SIGQUIT (the same happens under
  Docker).

The container, its logs and its ports stay until you **Remove** it. **Start**
boots it again with the same settings. Its files outside volumes and shared
folders start fresh, and the image is pulled again only with the pull policy
`always`.

### Memory and CPUs

The whole image is held in RAM. By default a container gets 256 MB, or more
for a big image: whichever is larger of twice its boot image plus 90 MB (while
it boots) and the image plus about 176 MB (while it runs). The form and the
API let you change it. Less than the image needs is refused with the
minimum, for example "memory 128 MB is too small for a 66 MB image held in
RAM (needs >= 224 MB)". Windows commits a WHPX guest's RAM up front. A start
that would not fit in the free memory is refused ("not enough free memory",
with what is running).

microVMs get 1 vCPU. More than one has not been tested on the microvm machine
yet, so a request for more is clamped to 1 with a warning. Set the machine to
`q35` (API `machine: "q35"`) for more.

### Images

The **Images** card lists the local image cache: each image's tags, download
and unpacked size, last use, which containers use it, and whether it runs as a
microVM. It has **Pull latest**, **Remove** (refused while a container uses
it, as in Docker) and **Prune unused images**. It also shows the Docker Hub
anonymous pull quota left. The pull policy of a run is `missing` (the default:
a cached tag makes no network request at all), `always` or `never`. Boot
images are built once per image and content, and cleaned up by age and use;
removing or pruning images never deletes what a container that is starting
needs.

Before any layer is downloaded, the manager checks the sizes the registry
declares: an image that could not boot even with the most memory a VM may get
is refused (`IMAGE_TOO_LARGE`), and so is a pull that would not fit on the
disk (`NO_SPACE`). The exact unpacked size is checked again before the root
file system is written. Unpacking stops at twice the microVM memory cap of
layer data, and file names longer than 4096 bytes are refused, so a hostile
image cannot exhaust the manager's memory.

### When the manager restarts

Containers keep running while the manager is closed, and are picked up again
when it starts. Their logs and live log stream continue. One that exited
meanwhile shows its exit code (and goes, if it was run with "remove when it
exits"). Their shared folders come back within a few seconds (2.9 s
measured), with the same file owner as before. Until then the app gets I/O
errors there (nginx answers 500), never the image's own files.

- A container is picked up only when its process is proven to be its QEMU:
  the pid is a running QEMU, equals the `qemu.pid` that QEMU wrote, and its
  monitor answers with the container's name. A QEMU that runs but cannot be
  proven to be adoptable (for example the manager stopped a moment after
  starting it) is listed as running **without supervision**: it can be
  stopped or removed.
- Right after the manager starts, Start, Stop, Remove and settings changes of
  existing containers wait until this check is done (at most 15 s, then
  `409 STARTING_UP`).

### Measured

Measured on a Windows 10 PC (QEMU 10.2, WHPX, image cached, other programs
busy), in three rounds of the end-to-end test:

| What | Time / size |
|---|---|
| `hello-world`, request to its output and exit code | 1.40-1.49 s (the app starts 1.25-1.33 s after QEMU is spawned) |
| `nginx:alpine`, request to the first HTTP 200 | 1.8 s; its run task ends at 2.2 s |
| `python:3-alpine` `python -c ...` with a TLS 1.3 connection out | 2.7-2.9 s |
| four nginx containers started at once | all answering after 2.7-2.8 s |
| three first runs of one image at once | one boot image built, all answering after 2.5-2.7 s |
| first run of an image whose layers are cached | +66-78 ms to build its boot image |
| nginx serving a live shared folder | about 2.5 s |
| graceful stop | 0.12-0.35 s |
| stop with a 1 s timeout of an app that does not exit in time | killed: exit 137 after 1.3-1.4 s; a file it wrote to a volume 1 s earlier is intact |
| QEMU memory for a 256 MB nginx guest | 292-294 MB private, 351-353 MB working set |
| **without hardware acceleration (TCG)** | hello-world 7.5-8.0 s; nginx with a volume answers after 12-13 s, 445 MB private; graceful stop 0.9 s |
| for comparison: Docker inside a new VM (quick deploy of nginx:alpine) | 40 s including the pull inside the VM; a 2 GB VM |

The first run of an image adds its download. The prototype engine measured
about 11 s to "ready" for nginx:alpine's 25 MB on this PC.

## Shared folders (live)

A folder of this PC can appear inside a VM (**VM Settings > Shared folders**
with a **Browse...** folder picker, MCP `share_folder`,
`POST /api/vm/shares`) or inside a container (a folder in its volumes). Both
sides see the same files; nothing is copied or synchronised.

Edits you make on Windows appear in the VM within a few tens of milliseconds,
and files written in the VM are saved on Windows immediately. Changes made on
Windows do not raise file-watch (inotify) events inside the VM, so dev servers
that watch files need polling mode (e.g. CHOKIDAR_USEPOLLING=1,
WATCHPACK_POLLING=true, vite server.watch.usePolling). Execute bits set with
chmod +x are not stored (scripts and binaries are detected automatically);
symlinks must stay inside the shared folder.

**Nothing to set up.** Shared folders need no admin rights, no Windows
feature, no extra QEMU build and nothing installed by you in the guest:

- Base images built by this version carry the guest service. A VM from an
  older base gets it over SSH the first time it needs it.
- The microVM kernel carries the file-system modules. A kernel installed
  before shared folders existed is updated from the packages already on disk
  by **Update (no download)** on the Setup card.

**How it works.** The manager runs its own file server (9P2000.L) on
127.0.0.1:5640. That port is `ninepPort` in `config.json`: if another program
holds 5640, another port is picked and saved there, because running guests
need it to stay the same. Guests reach the server through QEMU's user
networking, so this works with any QEMU build (the Windows builds have no 9p
or virtio-fs) and on every host system.

- **VMs**:
  - A share added to a running VM is mounted at once (0.5-0.8 s). A removed
    one is unmounted at once; later writes to that path stay on the VM's disk.
  - Every boot mounts the VM's shares by itself (the `devbox-shares` service),
    including a reboot inside the VM: shares added live were back 17 s after
    a `reboot`.
  - After a manager restart, the running VMs' shares are mounted again within
    about a second.
  - Files appear owned by root: the SSH user is root, and the `dev` user can
    read them but not write.
- **Containers**:
  - Shares are mounted before the app starts. A mount that fails ends the
    start with 125 and the reason, so an app never writes into its RAM root by
    mistake.
  - Files appear owned by the image's user when it is numeric (`USER 101`),
    else by root.
  - A share added to a running container applies at its next start. A
    removed one loses access at once.
- **Status**: the Shared folders list (and `GET /api/shares`, MCP
  `list_shares`) shows each share's state. It is **mounted**, **mounting**,
  **not mounted** (with the last reason a mount ended), **unavailable** (the
  folder is gone) or **not running**. It also shows connections, open files
  and bytes read and written.
- **Refused**: the manager's data folder, or a folder containing it (it holds
  the VM disks, the SSH key and the access token) - also when named another
  way, since the folder is compared by identity on disk, not by spelling -
  and system folders. Network and UNC paths (`\\server\share`,
  `\\localhost\C$\...`, a mapped network drive) are refused before anything
  opens them: opening one would connect to that computer and send it your
  Windows sign-in. Sharing a whole drive or your whole user profile works,
  with a warning. At most 8 shares per VM or container. The same host folder
  can be shared with several VMs, each with its own share.

**Security.**

- **Per-share secret**: the server listens on 127.0.0.1 only. Every guest
  and every local program can connect, so each share has its own random key,
  and a connection gets a share only by presenting that key. Keys are
  compared in constant time. A wrong key costs 100 ms, and repeated failures
  close the connection.
- **Where the keys are kept**: keys live in the registries (`vms.json`,
  `containers.json`, and their `.bak` copies) and in a per-VM or
  per-container list file in `run/`. All of them are readable by you only:
  the manager locks its `run/` and `microvms/` folders to your account at
  every start and writes the registries so that they keep that lock (the
  default data folder sits in the program folder, which every account of the
  PC may read). A list file that cannot be made private is not written; the
  start fails instead. The list file is deleted when the guest stops. QEMU
  passes the list to the guest through fw_cfg. The keys are never logged,
  returned by the API, or put on a command line. Container environment values
  (in `containers.json` and the run spec in `microvms/`) are protected the
  same way.
- **Jail**: a guest sees only its shared folder.
  - `..` never climbs above it.
  - Symlinks and junctions are never followed out of it, even when a program
    on this PC swaps a folder for a junction mid-way.
  - Links a guest creates must be relative and stay inside the folder.
  - Names that Windows would misread (`CON`, `nul.txt`, trailing dots, 8.3
    short names) are refused.
  - Host paths are never shown to the guest.
- **Read-only** shares are enforced by the server itself: writes, deletes,
  renames and new folders fail in the guest with "Read-only file system".
- **Bounded**: connections, open files and buffered bytes per share are
  capped. A guest that knows a key can hold only a bounded amount of the
  manager's memory, and a connection that stalls mid-transfer is closed.
- **Keep in mind**:
  - A share's key is visible to every program inside that VM or container
    (Linux lists it in `/proc/mounts`), and it opens only that share - but
    ALL of it. The VM, not a user account inside it, is the boundary. Every
    program in the VM or container can use the whole shared folder with the
    share's access (read-write unless the share is read-only) - also a Docker
    container inside a VM that only sees a sub-folder or mounts it `:ro`:
    those do not limit it. Only the share's own read-only setting is enforced
    by the manager. Share only folders the guest may change, and make the
    share read-only when it should not.
  - A writable share can fill the drive it is on.

**Limits** (measured with the file server on this PC, under load):

- Small files are slow compared with a local disk. Creating, reading or
  deleting one takes about 7-13 ms, and a `stat` about 4 ms. `ls -l` of 2000
  files took 8.5 s. Big files move at 23-29 MB/s writing and 76-95 MB/s
  reading. For a huge tree such as `node_modules`, prefer copy-in, or keep it
  on the VM's own disk.
- Absolute symlinks are refused, so `python -m venv` needs `--copies` inside a
  shared folder.
- File names that differ only by case collide on Windows.
- No extended attributes, device nodes, FIFOs or sockets. File locks are
  granted but not enforced across the two sides.

## Limits of the microVM engine, and the Docker-in-VM fallback

**The root filesystem is RAM.**

- The whole image lives in the guest's memory: about twice the image plus
  90 MB while it boots. That is comfortable up to about 200-300 MB of unpacked
  image and heavy beyond. Automatic sends images whose estimated need is above
  `microvmMemCapMB` to Docker-in-VM.
- The root is capped at what it uses plus half of the free guest memory.
  Writing past that gives "No space left on device" (the app sees ENOSPC),
  never a crash.
- Everything outside volumes and shared folders is reset at every start.
- `df /` does not work inside a microVM (`stat -f /` does).

**Not supported yet:**

- interactive terminals (`-it`): refused with `NOT_SUPPORTED` by both engines
  here; run a command or a server instead;
- `exec` into a running container, and `docker cp` out of one;
- healthchecks;
- restart policies: a policy other than `no` goes to Docker-in-VM;
- log timestamps;
- port or setting changes on a running container: they apply at its next
  start (until then its links stay the current ports, and both the current
  and the new ports stay reserved);
- more than 1 vCPU on the microvm machine (use `q35` for more);
- supplementary groups (they are empty);
- a periodic clock resync: the guest clock is set at boot (within about
  1.4 s of this PC in tests), so a container that runs for days can drift.

**Behaves differently from Docker:**

- The app is not PID 1, as with `docker run --init`. An app without a signal
  handler stops at once with 143, where Docker waits 10 s and reports 137.
- The app runs with full capabilities inside its own VM. The VM is the
  isolation boundary.
- Each container has its own network. Containers reach each other only
  through published ports (`host.docker.internal:<port>`); ICMP (ping) does
  not generally work.
- Images must be linux/amd64. Layers compressed with zstd need Node 22.15 or
  newer.
- Pulls are anonymous: public images only.

**Out of scope** (use Docker inside a VM, or a full VM):

- compose stacks: multi-container networking stays with Docker;
- privileged containers, host network or PID, devices and GPUs;
- Docker-in-Docker, and anything that runs containers itself;
- systemd and s6-overlay images, which must be PID 1;
- arm64 and Windows images;
- private registries with credentials, and registry mirrors;
- snapshot and fast restore, and memory ballooning (Windows commits guest
  RAM anyway).

**Without hardware acceleration** (TCG), microVMs still work, about 5x slower
to boot. TCG is not a security boundary under QEMU's own security policy; the
GUI and Claude say so when a container runs that way.

**The fallback.** When an image cannot run as a microVM, the run ends with
the reason and **Run with Docker-in-VM instead**
(`POST /api/container/fallback`). That creates a new VM from the
`docker-ready` template when there is one (else from the base image), starts
Docker in it and deploys the same image with the same ports (moved to the
VM) and environment. Its named volumes become Docker named volumes of the
same names in that VM - **new and empty**: the data in the container's
microVM volumes is not copied (it stays under Volumes). It costs about 2 GB of
RAM and a few minutes. Folders of this PC and copy-in folders are not carried
over, and the confirmation and the result say so. If the deploy fails, the
container gets its ports back. The container must be stopped first. Nothing
switches engine on its own, except that MCP `deploy_image` with
`engine="auto"` follows the offer for Claude and reports it. A container that
ran out of memory is first offered **Run with N MB** (1.5 times what its image
needs), which starts the same microVM with more memory.

## Using the GUI

### Dashboard

From top to bottom:

- **Setup**: the prerequisites, **Set up for Docker images** and **Set up
  everything** (see [First run](#first-run-what-setup-does)). With the kernel
  ready but no base image it says "Docker images: ready. Full VMs: not set
  up."
- **This PC**: memory and disk meters (the disk is the data folder's drive),
  which accelerators this PC supports, and the memory running containers use.
- **Tasks**: everything that takes time (setup, create, start, stop, run,
  deploy...) runs as a task with a live, expandable log. Several can run at
  once on different VMs and containers. A busy VM or container shows a spinner,
  and its buttons are disabled until the task ends. You get a notification
  when each task finishes, with links where there are any.
- **Run a Docker image**: image reference in, running app and its link (or
  its output and exit code) out ([Running a Docker image](#running-a-docker-image)).
  Presets fill in common images.
- **Containers**: every microVM container, and the named volumes.
- **Images**: the local image cache.
- **VM templates**: every VM is a copy-on-write clone of a template, so a new
  one costs a few hundred KB and no set-up time. `devbox-base` is Alpine plus
  the toolchain. **Freeze** turns any configured VM into another template, for
  example `docker-ready`: install Docker once, freeze, and every clone has
  Docker at boot.
- **Virtual machines**: status (`stopped`, `booting`, `running`, `stopping`,
  `error`, `missing`), SSH port, resources, disk use, uptime. `running` means a
  real sshd answered, not just that QEMU exists. Badges: **temporary** (removed
  by **Delete all temporary VMs**), **Claude** (created through MCP),
  **autostart**, **restart pending**. Click a VM to open its tabs.
- **Create a VM**: name, memory, vCPUs, template, "Start it right away",
  "Temporary VM".
- **Settings** (gear, top right): acceleration (automatic or a fixed choice),
  the default exposure for new port forwards (this PC only / LAN), the data
  folder, and **Connect Claude (MCP)**.

### A VM's tabs

| Tab | What it does |
|---|---|
| **Overview** | status, the exact `ssh` command, acceleration in use, memory/vCPUs, disk (actual and virtual size), template, port forwards with links, uptime, and the last error with QEMU's own words and the console tail. Start, Stop, Restart, Force stop, Open terminal, Copy SSH command. |
| **Settings** | memory, vCPUs, acceleration, note, autostart, temporary, SSH reachable from LAN; the port-forward editor; **Shared folders** (folder picker, path in the VM, read-only, status); disk resize, grow filesystem, compact; snapshots; freeze into a template; reset to template; delete |
| **Docker** | install/start Docker; containers (start, stop, restart, logs, remove) with links to their forwards; images (pull, remove); deploy an image automatically; run a container; compose projects |
| **Network** | every forward of every VM and container: port on this PC, owner, what it is, port inside, who can reach it (this PC / LAN), listening or not, owning process, conflicts, and "restart to apply" where QEMU still listens the old way |
| **Terminal** | an interactive root (or `dev`) shell in the browser (xterm.js over `ssh -tt`) that follows the window size. Switching VM, closing the panel or closing the browser tab ends the ssh client; a session nobody watches is closed after 60 s; a brief disconnect reconnects and replays what was missed. The VM itself is never affected. |
| **Serial console** | the VM's own root console: it works while the VM boots and when SSH or networking is broken. Plus the boot log (view or download). One serial connection at a time. |

Deep links: `/?vm=<name>&tab=overview|settings|docker|network|terminal|serial`
(and the v1 form `/?console=<name>`, which opens the terminal).

**Settings apply when they can.** Note, autostart and temporary always save at
once. Memory, vCPUs, acceleration and SSH exposure are saved while the VM runs
and marked **Changes apply on next start**, with a **Restart now** button. Port
forwards and shared folders on a running VM are added and removed **live**;
only a VM started by v1 needs a restart for its forwards.

### VM operations

- **Create**: a thin clone whose template path is stored *relative* to the
  VM's disk, so the whole data folder can be moved or copied to another PC.
- **Start**: QEMU with `-machine q35` and the chosen accelerator. The task is
  done when SSH answers; it waits up to 240 s (600 s under TCG). If a
  hardware-accelerated start dies at once and QEMU's output points at the
  accelerator, it is retried once with TCG, and the log says why. A guest
  kernel panic ends the wait at once and the start is tried once more. The
  first successful start of a clone sets its hostname to the VM name, its
  time zone to this PC's, and gives it its own SSH host keys.
- **Stop**: `poweroff` over SSH, else an ACPI power button through the monitor
  (also when ssh itself could not log in), then a wait of up to 45 s (90 s
  under TCG, where a VM running Docker needs 35-44 s), then QEMU is told to
  quit. Only then is the process killed, and only if it really is that VM's
  QEMU (one this manager started, or one whose monitor confirmed it). **Force
  stop** skips to quit/kill; it stays clickable while a start waits for SSH or
  a stop waits for the power-off, and cuts that wait short. A stop never hangs.
- **Restart**, and a guest `reboot`: the VM reboots in the same QEMU process
  (v1 turned a guest reboot into a power-off).
- **Delete** stops the VM first and removes its disk, logs, known_hosts and
  shared-folder records (never the folders themselves). **Reset to template**
  recreates the disk from its template and keeps the settings, the port
  forwards, the shared folders and an enlarged disk size (restarting the VM if
  it was running).
- **Snapshots** (qcow2 internal snapshots): create, revert and delete while the
  VM is stopped; the list also shows while it runs.
- **Resize** (stopped) only grows the disk. Start the VM and press **Grow
  filesystem** (the partition and ext4/xfs/btrfs are handled).
- **Compact**: on a running VM, `fstrim` inside the guest makes freed space
  reusable; on a stopped VM, the disk file is rewritten, keeping only what
  differs from its template (205 MB to 7 MB in a test). The rewrite is refused
  while the VM has snapshots.
- **Freeze** (stopped) flattens the VM into a standalone template in
  `vm-bases/` (default name `<vm>-base`). Templates are never overwritten, and
  the name `devbox-base` is reserved. A template never carries shared folders.
- A VM whose disk file disappeared is kept with status `missing` (never
  silently dropped) and can be removed with **Remove record**.

### Interaction conventions

**No native browser dialogs.** `prompt()`, `confirm()`, `alert()` and
`window.open()` are not used anywhere in the GUI:

- they block the whole page and its event loop while open;
- they cannot be styled, so they look nothing like the app;
- `prompt()` is disabled in sandboxed or cross-origin iframes and silently
  returns `null` there, so the action just appears to do nothing;
- `confirm()` returns a boolean with no way to tell "the user said no" from
  "the browser suppressed it";
- popup blockers stop `window.open()` without a visible error.

Instead one `openModal()` helper in `public/app.js` returns a promise that
resolves with the form's values on submit, or `null` when cancelled. Escape and
a click on the backdrop cancel; focus stays inside the dialog and returns to
where it was afterwards. `confirmDialog()` and `textDialog()` (logs, command
output) are built on it, and **Copy** falls back to a dialog with the text when
the clipboard is blocked. Links to running apps are ordinary links that open
in a new tab.

- **Destructive actions ask first**: delete a VM, reset, revert or delete a
  snapshot, force stop, remove a container, volume or image, remove a record,
  delete all temporary VMs or containers, update QEMU, run with Docker-in-VM
  instead (which says what it costs). The dialog starts with focus on Cancel,
  so Enter never deletes by accident. A failed delete keeps the panel open.
- **Anything slow is a task** with a live log; the request returns at once, so
  reloading the page never loses an operation.
- **The page never overwrites what you are typing**: polling updates rows and
  fields in place and leaves a field you are editing alone, and a validation
  error keeps what you typed.
- Toasts and status lines are announced to screen readers; dialogs and tabs
  have proper roles and keyboard handling.

## Ports: this PC only, or the LAN - your choice

Every forward - SSH, app ports and container ports alike - listens on
**127.0.0.1** (this PC only) unless you choose otherwise **for that forward**:

- the **Reachable from LAN** checkbox on each row of the port editor, and
  **SSH reachable from other devices on the network** for the SSH port;
- the **Reachable from LAN** checkbox on deploy and quick deploy, or a prefix
  in port text: `lan:3000:3000`, `local:8080:80`, `0.0.0.0:8123`,
  `127.0.0.1:8080:80`;
- the **LAN** tick on each port row of **Run a Docker image**;
- `lan=true` on the MCP `forward_port`, `deploy_image` and `run_image` tools
  (Claude is told to use it only when you ask);
- the global **default for new port forwards** (gear dialog), which only
  pre-sets the checkboxes.

A LAN forward listens on 0.0.0.0. The first time, Windows Defender Firewall may
ask whether QEMU may accept connections from the network; if other devices
still cannot connect, allow `qemu-system-x86_64.exe` for your network type in
the firewall settings. The Network tab shows who can reach each port and the
LAN addresses to use. Changing an app forward between this PC and LAN applies
live on a VM; changing the SSH port's exposure, or a container's ports,
applies at the next start.

The manager refuses a host port that is its own port, another VM's SSH port,
another forward or container port, or in use by another program, and says
which. A VM's SSH port is picked at creation (from 2223 up) and stays fixed.

Three port numbers are involved in an app forward of Docker inside a VM:

| | meaning |
|---|---|
| **container** | what the process listens on inside the container |
| **guest** | where Docker publishes it inside the VM |
| **host** | the port on this PC that QEMU forwards to the guest port |

`8080:80` means: port 8080 on this PC reaches the container's port 80. The
guest port is picked free, because two containers in one VM cannot both
publish 80. A `/udp` suffix (`5353:53/udp`) forwards UDP; only TCP forwards
get links.

## Docker inside a VM and deploying images

Containers need namespaces and cgroups, not hardware virtualisation, so Docker
works in these guests even under pure emulation. Use it for what the microVM
engine does not do ([Limits](#limits-of-the-microvm-engine-and-the-docker-in-vm-fallback)).

**Quick deploy** (the **Run a Docker image** card with the engine **Docker
inside a VM**, or Automatic when the request needs it) does it all from one
image reference, as numbered steps in one task:

1. check everything first (image, ports, environment, volumes, template);
2. create a VM from the `docker-ready` template when there is one;
3. boot it and make sure Docker runs;
4. deploy the image;
5. report the URL.

It took 28-34 s from a `docker-ready` template in tests, and 40 s when Docker
in the new VM had to pull nginx:alpine. Ports you name up front are part of
the VM from its first boot. If anything fails after the VM was created, the
VM is deleted again (unless **keep the VM if the deploy fails** is ticked),
and the error says so first.

**Deploy an image automatically** (a VM's Docker tab): paste any image
reference.

1. Docker is installed and started if needed (17-19 s), and the image is pulled
   unless it is already there.
2. `docker image inspect` finds its exposed TCP ports and declared volumes.
3. Each port is forwarded to this PC **live** through QEMU's monitor (a restart
   only as a fallback, as a step of the same task), skipping host ports that
   are taken. On Linux without root, ports below 1024 are forwarded from
   port + 8000 (80 becomes 8080).
4. Each declared volume gets a folder inside the VM,
   `/opt/<container>/<path_with_underscores>`. The container starts with
   `--restart unless-stopped`, the ports, the volumes, your environment
   variables, and optionally `--privileged` or `--network host`. It gets this
   PC's time zone (`TZ`) unless you set `TZ` yourself.

It reports the clickable URL(s). **Inspect only** does steps 1-2 and shows what
the image wants.

**Redeploying is safe.** The old container is renamed `<name>-prev` and
stopped, and the new one must be running, with no restarts, 4 s later (a
container that exits 0 at once without restarting counts as a finished one-shot
job). On failure the new one is removed and the old one is put back (and
started again if it was running). A plain redeploy (no ports given) keeps the
app's forwards and their LAN choice; explicit ports replace them. A failed
deploy restores the forwards exactly as they were. Errors name Docker's actual
reason, not its "Run 'docker run --help'" footer.

Fields take **one entry per line** (commas inside values are kept):

| Field | Format |
|---|---|
| Ports | `host:container`, with an optional `lan:` / `local:` prefix and `/udp` suffix per line |
| Environment | `NAME=value` |
| Volumes | `VM folder:container path` or `volume-name:container path`: folders **inside the VM** (a `C:\...` path is refused) |

Some images declare nothing (Home Assistant uses neither `EXPOSE` nor
`VOLUME`), so inspection finds nothing and you add them yourself (`8123:8123`,
`/opt/homeassistant/config:/config`). The presets fill in such cases.

**Removing a container** also removes the port forwards it owned, live and in
the registry. **Compose** projects (paste or load a `docker-compose.yml`) are
for apps that need more than one container: an image that wants PostgreSQL and
Redis deploys as a single container but cannot finish starting. Before compose
runs, the manager makes `/etc/localtime` in the guest a real file with this
PC's zone; Alpine has none, and Docker would otherwise create a directory there
and fail the bind mount.

**Sizing:** RAM is usually the limit. Light services (nginx, Gitea, Postgres,
Redis) are comfortable in 1-2 GB; multi-container apps want 3-4 GB. Under TCG,
CPU-heavy work is slow and big apps can take many minutes to start the first
time (`docker logs` shows their progress). The memory and vCPU limits in the
forms come from this PC.

## Acceleration and speed

| Accelerator | Where | Needs |
|---|---|---|
| **WHPX** | Windows | the Windows feature "Windows Hypervisor Platform" (turning it on needs an administrator once, and a restart) |
| **KVM** | Linux | `/dev/kvm` readable and writable by you (`kvm` group) |
| **HVF** | Intel Macs | nothing |
| **TCG** | everywhere | nothing: QEMU emulates the CPU in software |

**What "automatic" picks.** A VM or container set to **auto** uses the global
setting (gear dialog); when that is also **auto**, it uses what the manager
detected at start-up: the hardware accelerator if there is one, else TCG. On
Windows the manager checks WHPX by starting a paused, diskless QEMU for 2.5 s;
on Linux it checks that `/dev/kvm` is usable; on an Intel Mac it probes HVF.
Apple Silicon Macs run the x86 guests with TCG. QEMU is always given TCG as a
second choice, so it falls back by itself if the first one cannot start, and
the manager records and shows the accelerator actually in use (Overview, and
`accel` in the MCP results).

**Why WHPX stays the automatic choice on Windows.** It boots about 7x faster
than TCG. In end-to-end testing it completed 4 base builds and more than 40
boots. One guest kernel panicked ("IO-APIC + timer doesn't work") while other
programs held the host CPU at 100%. That was fixed at the cause instead of
dropping to TCG: the base now boots with `no_timer_check`, a panic on the
console ends the wait at once with one retry, and the base build retries a
panicked boot. You can still pick TCG for one VM (its Settings tab) or for all
(gear dialog).

**microVMs and the clock.** The microvm machine has no HPET or ACPI timer, so
its kernel is told the CPU's clock rate. The setup's test boot measures it
once per QEMU version (`kernel/host.json`). TCG runs reuse that value
(`kernel/host-tcg.json`). Without it, a TCG microVM on a busy PC could hang
while booting: this happened in 18 of 24 parallel boots before the fix, and 0
of 50 after.

**Measured timings** (Windows 10, QEMU 10.2, WHPX unless noted):

| What | Time |
|---|---|
| A Docker image as a microVM (cached) | 1.4-2.9 s ([table](#measured)) |
| One-click setup (Alpine download + bake) | 115 s (38 s + 74 s); rebuilding the base 73-103 s |
| New VM to SSH (cold boot) | 12-14 s; 17-19 s with Docker installed or a busy PC |
| New VM to SSH under **TCG** | 89-109 s; over 240 s with the PC at 100% CPU |
| MCP `create_vm` | 12-15 s |
| Quick deploy from `docker-ready` / MCP `deploy_image engine="docker-vm"` | 28-34 s / 33-35 s; 40 s when Docker in the new VM has to pull nginx:alpine |
| Install Docker in a running VM | 17-19 s |
| Clean stop of a VM | 4-7 s; 35-44 s under TCG with Docker running |
| MCP `status` when it has to start the manager | 0.8-1.4 s |

The default waits follow the accelerator: SSH up to 240 s (600 s under TCG),
a clean stop up to 45 s (90 s under TCG), a microVM's init 90 s (240 s under
TCG).

## Claude integration (MCP)

`mcp-server.js` is an MCP server (stdio, JSON-RPC 2.0, Node standard library)
that lets Claude run Docker images, create VMs on demand, and run and test
things in them. It is a thin client: everything that changes a VM or a
container goes through the manager's API, so the GUI shows what Claude does,
and the registry, locks and task history stay in one place. Commands and file
transfers go straight to the guest over ssh, with the same key and
known_hosts rules as the manager.

**Register it.** In the GUI, open the gear dialog > **Connect Claude (MCP)**.
It shows the exact configuration for this install, built from the real paths
(`GET /api/about`), with a Copy button. Use absolute paths. For example:

```json
{
  "mcpServers": {
    "devbox-vms": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Tools\\devbox-vm-manager\\mcp-server.js"],
      "env": { "VM_MANAGER_ROOT": "C:/Tools/devbox-vm-manager/data" }
    }
  }
}
```

On Linux or macOS the same with `"command": "/usr/local/bin/node"` (whatever
`command -v node` prints) and `/home/you/...` paths.

- **Claude Desktop**: Settings > Developer > Edit Config, merge it into
  `claude_desktop_config.json` (usually `%APPDATA%\Claude\` on Windows,
  `~/Library/Application Support/Claude/` on macOS), then restart Claude.
- **Claude Code**: put it in a project's `.mcp.json`, or run the
  `claude mcp add devbox-vms -e VM_MANAGER_ROOT="..." -- "<node>" "<mcp-server.js>"`
  command the panel prints.

`VM_MANAGER_ROOT` pins the MCP server to the same data folder as the manager
(`node mcp-server.js --data <dir>` does the same). If no manager is running for
that folder, the first tool call starts one **headless**: no window, no
browser, on the configured port (8777 by default), with its output in
`<data>/logs/manager-console.log`. It keeps running after Claude closes, like
the VMs and containers; open the GUI at any time to watch what Claude does. A
VM or container with autostart is started by a manager that the MCP server
starts, too.

**The tools** (31):

| Group | Tool | What it does |
|---|---|---|
| **Start here** | `status` | readiness and the next step: whether full VMs can be created (`ready`, `next_step`) and whether Docker images can run (`ready_for_images`, `next_step_for_images`, the microVM kernel facts); manager URL, platform and accelerator, prerequisites with fixes, templates, host limits, VMs, containers, running tasks. Call it first. |
| | `setup` | the one-time setup; steps already done are skipped. `images_only=true`: only QEMU and the microVM kernel (about a minute), enough for `run_image`. The default also builds the base image for VMs (a few minutes with acceleration, up to 20 without). |
| **Docker images** (microVMs, no Docker Engine) | `run_image` | run one image as its own microVM. `wait_for="ready"` (default) returns its URLs; `wait_for="exit"` returns its exit code and stdout/stderr (byte for byte, capped like `exec`). Ports are this PC only unless `lan=true`. `volumes` takes named volumes or a folder of this PC (shared live), `copy_in` one-way folders. Also `command`, `entrypoint`, `env`, `workdir`, `user`, `memory_mb`, `pull`, `remove_on_exit`. `engine` is `"microvm"` (default: fails with the reason when the image needs Docker) or `"auto"`. Temporary by default. |
| | `stop_image` | stop signal, then SIGKILL after `timeout_s` (volumes stay safe); `force=true` kills at once; returns the exit code and how it ended; idempotent |
| | `image_logs` | stdout and stderr (or `console`, `qemu`), the last `tail` lines, `previous=true` for the run before the last start |
| | `list_containers` | every container with its status, exit code and meaning, URLs (this PC / LAN), volumes, shared folders, memory, creator, temporary or not |
| | `remove_container` | delete a container, its logs and ports (named volumes are kept); `force=true` stops it first |
| | `pull_image`, `list_images`, `remove_image` | the image cache: pre-pull, list with sizes, users and the Docker Hub pull quota, remove (refused while in use unless `force`) |
| | `deploy_image` | a server image in one step, with its URLs: `engine="auto"` (default: a microVM when possible, else Docker in a new VM, reported as `engine` / `fallback_reason`), `"microvm"` or `"docker-vm"`; `privileged=true` selects Docker |
| **Shared folders** | `share_folder` | share a folder of this PC live with a VM (mounted at once on a running VM, at every boot after that), `read_only` optional; the data folder, `~/.ssh`, the program folder and system folders are refused. For a container, put the folder in `run_image`'s `volumes`. |
| | `unshare_folder` | unmount and forget a VM's share; the files on this PC are untouched |
| | `list_shares` | a VM's (`vm=`) or a container's (`container=`) shares with their live status; never a key |
| **VMs** | `create_vm` | new VM from a template, booted and reachable over SSH; `docker=true` for Docker (uses `docker-ready` when it exists and checks the daemon answers); auto-named `claude-xxxxxx`; temporary by default |
| | `list_vms`, `start_vm`, `stop_vm`, `delete_vm`, `reset_vm` | lifecycle |
| | `snapshot` | list, create, revert or delete disk snapshots |
| | `serial_log` | a VM's console (why it does not boot) |
| **Work inside a VM** | `exec` | run a shell command (root or `dev`, workdir, env, stdin, timeout); exit code, stdout and stderr, each capped at 100 KB (the first 20 KB and last 80 KB are kept) |
| | `write_file`, `read_file` | one file, as text or base64 |
| | `upload`, `download` | files and whole folders between this PC and the VM, over ssh + tar (scp only as a fallback); local paths must be absolute. They never copy the manager's private files (token, SSH key, registries, config, disks) or `~/.ssh` into a VM, and never write into the data folder, the manager's program folder, `~/.ssh` or a Windows Startup folder (see [Security](#security)) |
| | `forward_port` | reach a server in the VM: returns `http://127.0.0.1:<port>`; this PC only unless `lan=true`; live on a running VM. It sends only the one change (`add`), so forwards made at the same time are never lost |
| **Tasks and housekeeping** | `get_task` | follow a long operation |
| | `cleanup` | delete the temporary VMs and containers Claude created (with `ephemeral_only=false`, everything Claude created); never a VM or container you made, even one you marked temporary in the GUI; `dry_run` lists them |
| | `restart_server` | restart the MCP server itself, e.g. after editing its code: it replies, exits about 0.5 s later, and the host starts a fresh copy on the next call. VMs, containers and the manager are not affected. |

The server's instructions tell Claude when to use which:

- `run_image` for one image (a server or a one-shot command; it starts in
  seconds);
- `create_vm` with `exec` for an interactive Linux box;
- `deploy_image` with `engine="docker-vm"`, or `create_vm docker=true` with
  `exec`, for compose stacks, privileged images and anything that needs a full
  Docker;
- `share_folder`, or a folder in `run_image`'s volumes, to work on a folder of
  this PC. The caveats above are part of those tools' descriptions, and Claude
  is told never to share a folder you did not name.

VMs and containers Claude creates are marked **temporary** and **Claude** in
the GUI. Long operations wait up to `timeout_s` and then return
`{status: "running", task_id}`, so Claude follows them with `get_task` instead
of failing. `timeout_s` only limits how long the call waits; it never cuts a
boot short. The server's instructions tell Claude to remove what it created
when done, and never to delete, reset or stop VMs or containers it did not
create unless you ask.

Check the server with a real protocol conversation, not by loading it:
`node tools/mcp-probe.js mcp-server.js status` (or `npm run probe -- status`).

A call to a tool name that does not exist is answered with the JSON-RPC error
`-32602` (as the MCP specification asks), listing the tools that do exist; a
tool that runs and fails answers with `isError: true` and a readable message.

**Files Claude can move.** Everything a VM prints is untrusted while Claude
tests code in it. One misled `upload`, `download`, `copy_in` or shared folder
could otherwise hand a VM the manager's access token or SSH key, or overwrite
`config.json`. So these are refused whatever the path looks like. Symlinks
and junctions are resolved, and Windows paths are compared without case.

- **Copying into a VM** (and `copy_in`, shared folders): the data folder's
  private parts (`manager-token`, `seed/`, `run/`, `config.json`, `vms.json*`,
  `containers.json*`, `qemu/`, `logs/`, `sandboxes/`, `vm-bases/`,
  `downloads/`, `microvms/`, `volumes/`, `kernel/`, `images/`, the base
  images) and `~/.ssh`, or a folder that contains any of them.
- **Copying out of a VM**: the same, plus the manager's program folder and
  the Windows Startup folders, and a directory download into a folder that
  contains any of them.

To narrow transfers further, set `DEVBOX_MCP_FILES` in the MCP server's `env`
to the folders Claude may use (separated by `;` on Windows, `:` elsewhere).

## Security

VM guests reach this PC's loopback through `10.0.2.2`, so "the manager only
listens on 127.0.0.1" protects nothing on its own. The manager therefore checks
every request:

- **Access token.** Every `/api/*` call except `GET /api/ping` needs the token
  from `<data>/manager-token` in the `X-DevBox-Token` header (compared in
  constant time). This is what keeps the VMs out of the API. The token is
  random, created once, and readable only by you (its permissions are applied
  again at every start, so a copied or moved data folder does not leave it
  open). The browser gets it only through the `#token=` part of the link the
  manager prints in a console window: a URL fragment is never sent to a
  server, the page removes it from the address bar and keeps it in the
  browser's storage for that address. A manager started without a console
  (by the MCP server) never writes the token to its output. The terminal and
  log streams pass it as `?token=`, because EventSource cannot set headers. To
  change the token, delete the file and restart the manager.
- **Only the real manager gets the token.** `GET /api/ping` is public, so
  anything could answer "I am the manager for your data folder". The launcher
  and the MCP server send a random nonce and trust a port only when it answers
  with an HMAC of that nonce and its own port, keyed with the token; only then
  do they send the token or open the browser with it.
- **Host and Origin checks.** The `Host` header must be `127.0.0.1:<port>`,
  `localhost:<port>` or `[::1]:<port>`: this stops DNS rebinding, and ordinary
  requests from guests, which arrive as `10.0.2.2`. A guest can still send any
  `Host` header it likes, so for guests it is the token that decides. An
  `Origin` header must be the manager's own, and a cross-site POST without one
  is refused too.
- **POSTs must be JSON**, at most 1 MB.
- **Headers:** a strict Content-Security-Policy (no inline script or style
  anywhere), `X-Frame-Options: DENY`, `nosniff`, no referrer, no CORS. The GUI
  renders everything from the server, a VM, a container or an image as text,
  never as HTML. A link a program in a VM prints into a terminal is only
  shown, with its full address, in the app's own dialog; nothing opens by
  itself.
- **QEMU's monitor and serial console** of each VM and container have no
  password, and the monitor can run programs on this PC, so where they listen
  is the secret. On Windows they listen on a random loopback address
  (127.x.y.z, never 127.0.0.1: slirp maps the guests' `10.0.2.2` to 127.0.0.1
  only) and a random port, both new at every start - about 2^38 combinations.
  If no such address can be bound, the start fails with an error instead of
  falling back to 127.0.0.1 (unless `allowSharedLoopback` is set in
  `config.json`). On Linux and macOS they are unix sockets in the data folder,
  or in a private folder (0700, owned by you, checked before use) when that
  path is too long. They never appear in an API reply.
- **Process identity.** A QEMU the manager did not start itself (one that kept
  running while the manager was closed) is only taken over, and only ever
  killed, after its own monitor confirms it is that VM (`info name`), or, for
  a container, after its pid file and the shared QEMU process listing agree:
  Windows reuses process ids, and a recorded pid can belong to another VM,
  another data folder's manager or the Android emulator by now. The same holds
  for a base image build left behind by a closed manager.
- **ssh** uses a known_hosts file per VM (`accept-new`; deleted when the VM is
  deleted or reset), batch mode and only the manager's key. Each VM makes its
  own SSH host keys at its first boot, so one VM's root cannot pose as another
  VM (clones would otherwise share their template's keys). The private key's
  permissions are applied again at every start (Windows OpenSSH refuses a key
  that others can read).
- **Guest commands:** everything passed into a guest shell (image references,
  container, volume and project names, environment, volumes, ports, paths) is
  validated and quoted. Container environment values (passwords, API keys) go
  to the VM but never into task logs: the logged command shows `NAME=***`.
- **The QEMU installer** (Windows) is checked against its published sha512 and
  its Authenticode signature, which must be the QEMU publisher's (Stefan Weil /
  Universität Mannheim) and chain to a certificate authority this PC trusts -
  the certificate has expired, which is accepted; a self-made one with the same
  name is not. An unsigned installer or another signer is refused unless
  `config.json` says `"allowUnsignedQemu": true`.
- **microVM containers** are isolated by the hypervisor, one VM per image; the
  app runs as root with full capabilities inside its own VM. Everything a
  container prints is untrusted: the manager reads only its strict
  `__DEVBOX_*` status lines (capped), and the GUI shows the rest as text.
  Environment values are stored in the private data folder, listed by name
  only (values with `reveal=1`), never logged, and the run spec that carries
  them is deleted once the guest has read it. Under TCG a container is not a
  security boundary (QEMU's own policy); the GUI and Claude say so. Resources
  are bounded: the memory check before a start, the per-boot log cap, sparse
  volumes with a fixed size, the 512 MB copy-in cap and a RAM root that fills
  up with ENOSPC instead of a crash.
- **Supply chain**:
  - Images come over HTTPS only (plain HTTP only for a registry on this PC).
  - Every manifest and blob is checked against its sha256 digest.
  - Credentials are never sent to another host after a redirect.
  - Layers are unpacked in memory with limits on entries, size and path
    depth, never onto the disk.
  - The microVM kernel packages are checked against Alpine's signing keys:
    the signed package index, then each package's size, hashes and own
    signature.
- **Shared folders**: a key per share, the jail, read-only enforced by the
  server, and bounded resources (see [Shared folders](#shared-folders-live)).
  Inside the guest the key is visible to every program there.

If the page shows **Access token needed**, open the link the console printed,
start the launcher again, or paste the token from `<data>/manager-token`.

### What a VM can and cannot reach

Guests are root sandboxes with outbound NAT (QEMU user networking). SSH login
is by key only. The serial console logs in as root without a password; guests
cannot reach it, the manager's API opens it only for callers with the token,
and its socket is private like the monitor's (see Known limits). From inside
any VM, any container in it, or any microVM container:

- **It can reach** the internet and your network, as this PC does. Through
  `10.0.2.2` it can also connect to **anything on this PC that listens on
  127.0.0.1 or on the network**: that includes **every other VM's SSH and app
  forwards, every container's published ports** and other programs' local
  servers (a dev server or a database you run on localhost). VMs and
  containers are therefore **not isolated from each other's published ports**:
  treat them as one trust zone, and do not run an untrusted image next to a
  VM, container or local service that holds secrets.
- **It is refused by** the manager's API: without the token every call answers
  401 (a request with its own `Host: 10.0.2.2:<port>` also gets 403, but a
  guest can fake that header - the token is what stops it). Another VM's SSH
  port answers, but logging in needs the private key, which stays on this PC.
  The shared-folder server on 127.0.0.1:5640 answers too, but it serves a share
  only to a client that presents that share's key.
- **It cannot reach** any VM's or container's QEMU monitor or serial console.

A VM still running from **version 1** of the manager (adopted after an upgrade)
is the exception until it is restarted: its monitor listens on
127.0.0.1:25000+ (reachable from every VM) and its ports on all network
interfaces. The GUI and Claude's `status` show a **Restart now** warning for it.

Known limits: the QEMU monitor and serial console sockets have no password.
VMs cannot reach them, but programs already running on this PC under any user
can if they find them - the monitor can run programs as you (`migrate exec:`),
and the serial console is a root shell in the guest. The manager trusts the
programs already running on this PC. On Windows, a web page in a browser that
does not block requests to local addresses would have to guess a random
127.x.y.z address and port (new at every VM start), which is not practical.

## Troubleshooting

**Where the logs are** (all in the data folder; also `GET /api/log` and
`GET /api/container/logs`):

| File | What |
|---|---|
| `logs/manager.log` | the manager's own messages and errors (`@manager`), including every shared-folder disconnect and its reason |
| `logs/tasks.log` | every task's log lines (`@tasks`) |
| `logs/qemu-<vm>.log` | QEMU's own output for a VM (why it did not start) |
| `sandboxes/<vm>-serial.log` | the VM's console: boot messages, kernel errors (Serial console tab, MCP `serial_log`) |
| `sandboxes/base-bake.log`, `logs/qemu-bake.log` | the base-image build (`@bake`) |
| `logs/manager-console.log` | the console of a manager the MCP server started headless |
| `microvms/<id>/console.log`, `stdout.log`, `stderr.log`, `qemu.log` | a container's boot and init messages, its output, and QEMU's output (Logs tab, MCP `image_logs`) |

`manager.log` and `tasks.log` are capped at about 5 MB, with one older copy
(`.1`). A VM in state `error` shows the reason, QEMU's output and the console
tail on its Overview tab. A failed container shows its exit code, the reason
and the init messages in the "What went wrong" box of its Overview tab; its
Logs tab has the console.

**The port is in use.** For the manager itself, the next free port of the
following 20 is used and printed; if all are taken, start with `--port <n>`.
For a VM or container, the start stops with "host port N ... is in use by
another program": close that program (the Network tab shows its process id)
or change the forward. On Linux, ports below 1024 need root; use e.g.
`8080:80`.

**"UNPROTECTED PRIVATE KEY FILE" / bad permissions.** The manager restricts the
key to your user at every start and before every setup. If ssh still complains
(for example after the folder was copied with a tool that added permissions),
stop the manager and run
`icacls "<data>\seed\id_dev" /reset` then
`icacls "<data>\seed\id_dev" /inheritance:r /grant:r "%USERNAME%:F"` on
Windows, or `chmod 600 <data>/seed/id_dev` on Linux/macOS.

**A tool is missing.** The Setup card names it with the install command for your
system ([Prerequisites](#prerequisites)). A tool in an unusual place can be
pinned in `<data>/config.json` (`qemuDir`, `ssh`, `sshKeygen`, `scp`,
`sevenZip`). Setup on Windows needs 7-Zip only to unpack QEMU.

**WHPX.**
- "Hardware acceleration: not available" on Windows: turn on **Windows
  Hypervisor Platform** (Control Panel > Programs > Turn Windows features on or
  off; needs an administrator and a restart; hardware virtualisation must be
  enabled in the firmware), then start the manager again. Detection runs once
  at start-up.
- A VM that dies at once under WHPX is retried with TCG automatically, and the
  task log says why. To always use TCG, set Acceleration to TCG for that VM or
  in the gear dialog.
- "Kernel panic - not syncing" on a very busy PC: the start is retried once by
  itself. Bases built by this version boot with `no_timer_check`, which avoids
  it.
- Slow VMs: check the accelerator on the Overview tab. Under TCG a boot takes
  1.5-2 minutes; that is expected.

**VMs from a v1 base boot slowly or stay on UTC.** A base built by v1 lacks
`tzdata`, `no_timer_check` and the boot-time tweaks (about 30 s to SSH instead
of 13 s). Rebuild it once no VM is a clone of it: freeze the VMs you want to
keep into templates (a frozen template does not depend on the base), delete
the clones, then move `devbox-base.qcow2` out of the data folder: the Setup
card offers **Set up everything** again (or call `POST /api/install/base`).

**The base build fails with "installing the toolchain inside the guest failed".**
The guest had no internet or DNS, usually because of a VPN or a proxy. The log
`@bake` shows the console.

**"busy: ... is still running" (409).** Another task holds that VM or container
(or the base image, or QEMU); wait for it. The Tasks card shows it with its
log.

**"template ... is missing".** A clone cannot start without the template it
was made from; restore the file into `vm-bases/` (or `devbox-base.qcow2`).
Rebuilding the base is refused while VMs are clones of it.

**Docker images (microVMs).**
- "the microVM kernel is not installed" (`NO_KERNEL`): press **Set up for
  Docker images** on the Setup card (or `POST /api/setup {"only": "microvm"}`).
- "shared folders need the updated microVM kernel": the Setup card offers
  **Update (no download)**; it rebuilds the kernel folder from the packages
  already downloaded in a few seconds. Do it while no container runs.
- A container that exits with **125** failed in the engine: its Logs tab
  (Console) and the "What went wrong" box show the reason, e.g. a volume or a
  shared folder that could not be mounted, or "the VM did not boot within
  90 s" with the last console lines. **126/127**: the user or the command does
  not exist in the image; the message says which.
- "the repository does not exist or needs a login" / "no such tag": check
  the reference. Only public images can be pulled. "rate limit reached": the
  Docker Hub anonymous pull quota is used up; wait. The Images card shows what
  is left. Cached images still run.
- "is not in the local image cache (pull policy "never")": pull it first, or
  use the pull policy `missing`.
- "both engines run linux/amd64 images only": the image has no linux/amd64
  variant (for example arm64 only). zstd-compressed layers need Node 22.15 or
  newer, or Docker inside a VM.
- "memory ... is too small for a ... image held in RAM": give it at least the
  size the message names, or leave Memory empty for the automatic size. "not
  enough free memory": this PC does not have that much free memory; stop
  something first (the message lists what runs).
- "volume ... is in use by ...": another running container has that named
  volume; a volume attaches to one running container at a time.
- `SPEC_TOO_LARGE`: the environment is over 30 KB; put the configuration in a
  file and copy it in.
- "path too long for QEMU on Windows": the data folder's path is too long for
  QEMU (259 characters); move it to a shorter path (`--data`).
- "the shared folder ... does not exist any more": the folder was moved or
  deleted; change the container's volumes.
- A container that is too big for RAM, or needs PID 1, privileged mode or
  Docker itself, ends with **Run with Docker-in-VM instead**.
- Right after a manager restart a container's shared folder answers with I/O
  errors for a few seconds (nginx: 500) until it is mounted again.
- `QEMU install ... stop every container first` (409): Windows locks the QEMU
  files while containers run.

**Shared folders.**
- A dev server does not reload when you edit on Windows: file-watch events
  do not cross the share. Switch it to polling (`CHOKIDAR_USEPOLLING=1`,
  `WATCHPACK_POLLING=true`, vite `server.watch.usePolling`).
- A share shows **not mounted**: the list shows the last reason a mount ended.
  A running VM is mounted again after its next boot or manager start. To force
  it now, remove and add the share, or restart the VM. `logs/manager.log` has
  every disconnect and its reason.
- `python -m venv` fails inside a shared folder: absolute symlinks are
  refused; use `python -m venv --copies`, or keep the virtual environment on
  the VM's own disk.
- "Permission denied" as the `dev` user in a VM: files in a VM's share belong
  to root; use root (the default SSH user) or a read-only share for `dev`.
- Very slow `npm install` or `git status` in a shared folder: small files cost
  milliseconds each over the share. Keep `node_modules` on the VM's disk, or
  use copy-in for a container.

**Claude does not see the tools.** Check that the paths in the configuration
are absolute and exist, then run `node tools/mcp-probe.js mcp-server.js status`
with the same `VM_MANAGER_ROOT`. If the manager could not be started headless,
`<data>/logs/manager-console.log` says why. After editing the server's code,
call `restart_server`.

A manager that was killed hard leaves `run/manager.json` behind; that is
harmless, because the next launch checks whether the manager in it answers.
Running VMs and containers are picked up again by the next manager.

## Files

The data folder (default `data/` next to `server.js`):

```
<data>/
  vms.json                 VM registry (version 2; saved only on change, atomically,
                           with vms.json.bak; a v1 vms.json beside the code is moved here once)
  containers.json          microVM container registry (same rules, containers.json.bak)
  config.json              optional settings (port, tool paths, ninepPort, ...)
  manager-token            API access token (owner-only)
  devbox-base.qcow2        the base template
  vm-alpine.qcow2(.json)   the pristine Alpine download and where it came from (url, sha512)
  vm-bases/                more templates (e.g. docker-ready.qcow2)
  sandboxes/               VM disks and consoles: <vm>.qcow2, <vm>-serial.log, base-bake.log
  seed/id_dev(.pub)        the SSH key for all guests
  qemu/                    managed QEMU install (Windows)
  downloads/               downloads in progress (*.part) and the bake's work disk
  run/                     manager.json (pid, port, url - for the MCP server and a second
                           launch), <vm>.pid, known_hosts/<vm>, the shared-folder lists
                           <vm>.shares and ctr-<id>.shares (private; deleted when the guest
                           stops), and on Linux/macOS the monitor and serial sockets
  logs/                    manager.log, tasks.log, qemu-<vm>.log, qemu-bake.log,
                           manager-console.log
  kernel/                  the microVM kernel: the verified Alpine packages, <kver>/
                           (vmlinuz-virt, busybox, modules, manifest.json), host.json
                           (this PC's CPU model and clock rate; host-tcg.json for TCG)
  images/                  the image cache: blobs/sha256/ (as pulled, verified),
                           refs.json, index.json, rootfs/*.json, initrd/ (boot images)
  microvms/<id>/           one folder per container: console.log, stdout.log, stderr.log,
                           qemu.log, qemu.pid (+ *.prev.log of the previous boot; spec.sh
                           and copyin.cpio only while needed)
  volumes/                 named volumes: <name>.qcow2 (+ <name>.lock while attached)
```

The program:

```
server.js            entry point (CLI, one manager per data folder, shutdown)
mcp-server.js        MCP server entry point
lib/                 the backend modules - see docs/ARCHITECTURE.md
lib/oci/             registry client, layer flattening, image cache
lib/microvm/         the microVM engine (kernel, init, run, containers)
lib/ninep/           the 9P2000.L file server for shared folders
lib/mcp/             MCP protocol and tools
public/              index.html, app.js, app.css, vendor/ (xterm.js, offline)
tools/               check-sources.js (are the download sources alive?),
                     mcp-probe.js (MCP protocol probe)
tests/               node:test tests
vm-manager.cmd/.sh   launchers
```

## API

All JSON on `http://127.0.0.1:<port>`. Every `/api/*` route except
`/api/ping` needs the `X-DevBox-Token` header; every POST needs
`Content-Type: application/json`. Errors are `{ok: false, error, code}` with
400 bad input, 401 missing or wrong token, 403 host/origin, 404 unknown route,
VM, container, session or task, 405 wrong method, 409 busy or conflicting
state (a busy answer names the task in `holder`), 413 body over 1 MB, 415 not
JSON, 500 unexpected. Input is checked before anything starts: bad input is a
400, never a failed task.

**Read**

| Route | Answer |
|---|---|
| `GET /api/ping` | public: `{app: "devbox-vm-manager", version, rootId}`; with `?nonce=<16-128 hex>` also `proof` = HMAC-SHA256(token, `devbox-ping\|<nonce>\|<port>`), so a client can check it talks to the real manager before sending the token |
| `GET /api/state` | `version, host, platform {os, arch, accel, lanAddresses}, settings, prereqs, bases, vms, containers, microvm {ready, kver, accel, machine, reason, needsUpdate}, tasks {running, recent}, limits, stateWarning, dataRoot, managerPort` |
| `GET /api/network` | `{rows, listenersAvailable}`: every forward of every VM and container with its exposure, listening state, pid, conflicts |
| `GET /api/tasks` | `{tasks}`: summaries, newest first (the last 50 are kept) |
| `GET /api/task?id=` | `{task}` with its full log (no id: the latest task) |
| `GET /api/log?name=<vm>\|@manager\|@tasks\|@bake&tail=` | `{name, text, lines, size, truncated}`; `tail` 300 by default, at most 5000 lines, from the last 256 KB |
| `GET /api/vm/docker?name=` | Docker state: containers (with their URLs), images, networks, volumes |
| `GET /api/vm/docker/logs?name=&container=&tail=` | `{text, truncated}`; `tail` 250 by default |
| `GET /api/about` | version, data folder, node path, `mcpServer`, `mcpConfig` (the Connect Claude snippet) |
| `GET /api/session/stream?id=&token=&since=` | Server-Sent Events: `{t, n}` output chunks (`n` = byte offset; reconnect with `since=n`), `{exit}` at the end |
| `GET /api/containers?all=` | microVM containers (Docker images run without Docker): `{containers}`, env values redacted; `all=0` only the live ones |
| `GET /api/container?id=&reveal=` | `{container}`: the record (id, name or a unique id prefix of 3+ characters) with `live {phase, ready, stopAcknowledged}`, `timings`, `logSizes`, `initMessages`, `consoleTail`, `warnings`, `fallback`; `reveal=1` shows env values; share keys never appear |
| `GET /api/container/logs?id=&stream=stdout\|stderr\|console\|qemu&tail=&prev=` | `{text, size, truncated}` from the last 256 KB (stdout and stderr byte for byte) |
| `GET /api/container/logs/stream?id=&stream=&since=&token=` | Server-Sent Events like the terminal stream: `{t, n}`, `{reset}`, `{exit}` |
| `GET /api/images` | the local image cache: `{images: [{references, configDigest, manifestDigest, compressedBytes, rootfsBytes, initrdBytes, lastUsed, pulledAt, usedBy, warnings, complete, runtime, compat}], rateLimit, cacheBytes}` |
| `GET /api/volumes` | named volumes: `{volumes: [{name, virtualBytes, fileBytes, createdAt, attached, usedBy: [{id, name, running}]}]}` |
| `GET /api/shares?owner=<vm\|container id or name>` | `{owner, kind, running, port, problem, shares: [{id, hostPath, guestPath, readOnly, status: mounted\|not-mounted\|pending\|unavailable\|stopped, connections, openFiles, bytesRead, bytesWritten, lastClose}], caveat}`; without `owner` every share. Never a key |
| `GET /api/fs/dirs?path=` | folder browser for the shared-folder picker: `{path, parent, home, roots, readable, dirs: [{name, path, readable, refused?}]}`, sub-folders only (Windows: also the drives); starts at the user profile |

Container, image and volume routes answer with these codes besides the usual
ones:

| Code | HTTP | When |
|---|---|---|
| `NO_KERNEL` | 409 | the microVM kernel is not installed (`action: "install-kernel"`) |
| `PREREQ_MISSING` | 409 | QEMU is not installed (`action: "install-qemu"`) |
| `NO_SUCH_CONTAINER` | 404 | unknown id, name or id prefix |
| `NAME_IN_USE`, `PORT_CONFLICT` | 409 | the name or a host port is taken (the message names the holder) |
| `RUNNING`, `NOT_RUNNING`, `LOST` | 409 | the container is (not) running; a lost record (or a VM running without supervision) can only be stopped or removed |
| `STARTING_UP` | 409 | the manager has just started and is still checking the containers that kept running (after 15 s) |
| `IMAGE_IN_USE`, `VOLUME_IN_USE` | 409 | removing an image or a volume a container uses |
| `NOT_COMPATIBLE` | 409 | engine `microvm` with a request that needs Docker; carries `fallback: {engine, code, reason}` |
| `BAD_REFERENCE`, `NOT_SUPPORTED`, `SPEC_TOO_LARGE` | 400 | a malformed image reference; `-it`/tty; an environment over 30 KB |

What can only be found while a run or start task works (the pull, the image,
the boot) ends that task with a message that says what happened. The
container record keeps it: status `error`, `exitCode` 125 (none when a
fallback is offered), `exitReason`, `lastError` and `fallback`. These are: no
such repository or tag, the registry's pull quota, "not in the local image
cache" with pull policy `never`, no linux/amd64 variant, zstd layers on an
older Node, an image that needs Docker ("not compatible with the microVM
engine", with `fallback`), too little memory for the image or on this PC, a
named volume attached elsewhere, a shared folder that is gone, a kernel
that predates shared folders, an image too large to ever boot as a microVM
(`IMAGE_TOO_LARGE`, before the download), too little free disk space
(`NO_SPACE`, before the download and again before unpacking), a layer that
breaks the unpacking limits (`LIMIT`), and a folder of an older record on a
network path (`NETWORK_PATH`).

**Change, answered at once**

| Route | Body | Answer |
|---|---|---|
| `POST /api/settings` | `{accel?, defaultExpose?: "local"\|"lan"}` | `{settings}` |
| `POST /api/vm/settings` | `{name, mem?, cpus?, accel?, autostart?, note?, ephemeral?, sshLan?}` (note, autostart and ephemeral save even while a task works on the VM; the others wait for it: 409 `BUSY`) | `{vm, pendingRestart}` |
| `POST /api/vm/ports` | `{name, ports: [{host, guest, lan}] or "8080:80, lan:3000", base?}` (the complete list; `base` = the list you edited: 409 `CHANGED` if the forwards changed meanwhile) **or** `{name, add?: [mapping], remove?: [host]}` (single changes applied to the current list; `add` replaces a forward with the same host and guest port, e.g. to switch `lan`) | `{ports, applied: "live"\|"saved"\|"restart", warnings, pendingRestart}`; 409 `PORT_CONFLICT` naming the holder when a host port is taken (nothing is changed then) |
| `POST /api/vm/forget` | `{name}` (a record whose disk is missing) | `{forgotten}` |
| `POST /api/vm/shares` | `{name, action: "add", hostPath, guestPath, readOnly?}` or `{name, action: "remove", guestPath \| id}` (under the VM's lock: 409 `BUSY` during a start or stop) | `{name, share \| removed, applied: "live"\|"next-start", mounted \| unmounted, pending, warnings, shares, caveat}` |
| `POST /api/session/open` | `{name, kind: "ssh"\|"serial", user?: "root"\|"dev", cols?, rows?, replace?}` | `{id, kind, command}` |
| `POST /api/session/input` | `{id, data}` | `{}` |
| `POST /api/session/resize` | `{id, cols, rows}` | `{applied}` |
| `POST /api/session/close` | `{id}` | `{closed}` |
| `POST /api/container/run` | `{image, name?, cmd?, entrypoint?, env?: ["K=V"] \| {K: V}, ports?: [{host, guest, proto?, lan?}] or "8080:80/udp", lan?, volumes?: ["name:/path[:ro][,nocopy]", "C:\\dir:/path[:ro]"], copyIn?: ["C:\\dir:/path"], copyInOwner?: "user"\|"root", workdir?, user?, hostname?, mem?, cpus?, accel?, machine?: "auto"\|"microvm"\|"q35", network?: "default"\|"none", stopSignal?, stopTimeout?, pull?: "missing"\|"always"\|"never", autoRemove?, autostart?, ephemeral?, note?, createdBy?, engine?: "auto"\|"microvm"\|"docker-vm", privileged?, hostNetwork?, restartPolicy?, keepOnFailure?}` | **202** `{task, engine: "microvm", reason, container: {id, name}}`: the `ctr-run` task, whose result has `status`, `exitCode`, `exitReason`, `urls`, 4 KB `stdout`/`stderr` tails, `warnings`, `timings`, `fallback?`. Or `{task, engine: "docker-vm", reason, vm}` (the quick deploy) when the request needs Docker |
| `POST /api/container/kill` | `{id, signal}` | `{id, signal, sent}` |
| `POST /api/container/remove` | `{id, force?}` | `{removed, name}` (volumes are kept); 409 `RUNNING` without `force` |
| `POST /api/container/settings` | `{id, name?, note?, autostart?, autoRemove?, mem?, cpus?, ports?, env?}` | `{container, pendingRestart}` (applies at the next start) |
| `POST /api/container/fallback` | `{id, keepOnFailure?}` (the container must be stopped) | **202** `{task, engine: "docker-vm", vm, warnings}`: the same image with Docker inside a new VM; the container's host ports move to it |
| `POST /api/image/remove` | `{image \| configDigest, force?}` | `{untagged, removed, files, freedBytes, kept}`; 409 `IMAGE_IN_USE` |
| `POST /api/volume/create` | `{name, sizeGB?}` | `{volume: {name, virtualBytes, file}, created}` |
| `POST /api/volume/remove` | `{name}` | `{removed}`; 409 while attached to a running container |

**Tasks**: these answer **202** `{ok: true, task: {id, kind, title, vm, ctr, status}}` at
once; follow the task with `GET /api/task?id=`.

| Route | Body |
|---|---|
| `POST /api/setup` | `{only?: "microvm"}`: SSH key, QEMU (Windows), microVM kernel, Alpine image, base image (VMs can still be started meanwhile, unless it installs QEMU); `only: "microvm"` stops after the kernel ("Set up for Docker images") |
| `POST /api/install/qemu` | `{}`: install or update QEMU (Windows; all VMs and containers stopped) |
| `POST /api/install/base` | `{}`: download Alpine if needed and build the base |
| `POST /api/install/kernel` | `{update?}`: the microVM kernel (verified Alpine linux-virt + busybox-static; reuses verified packages already downloaded; `update` checks the Alpine index for a newer one) |
| `POST /api/container/start` | `{id}`: boot an existing container again (files outside volumes and shared folders are reset) |
| `POST /api/container/stop` | `{id, timeoutS?, force?}`: accepted while the container is still being pulled or booted; result `{id, exitCode, how, ms}` |
| `POST /api/image/pull` | `{image}`: pull (or refresh) an image into the cache |
| `POST /api/images/prune` | `{}`: remove images no container uses |
| `POST /api/vm/create` | `{name, template?, mem?, cpus?, accel?, port?, ports?, sshLan?, start?, waitS?, ephemeral?, autostart?, note?, createdBy?}` |
| `POST /api/vm/start` | `{name, waitS?}` (default: 240 s, 600 s under TCG) |
| `POST /api/vm/stop` | `{name, force?, timeoutS?}` (default: 45 s, 90 s under TCG). `force` also cancels a start that still waits for the guest, and cuts short a normal stop that still waits for the power-off |
| `POST /api/vm/restart` | `{name, force?, timeoutS?, waitS?}` |
| `POST /api/vm/delete` | `{name}` |
| `POST /api/vm/reset` | `{name, waitS?}` |
| `POST /api/vm/resize` | `{name, sizeGB}` |
| `POST /api/vm/growfs` | `{name}` |
| `POST /api/vm/compact` | `{name}` |
| `POST /api/vm/freeze` | `{name, as?}` (default `<name>-base`) |
| `POST /api/vm/snapshot` | `{name, action: "create"\|"revert"\|"delete"\|"list", snapshot?}` |
| `POST /api/vm/docker/install` | `{name}` |
| `POST /api/vm/docker/pull` | `{name, image}` |
| `POST /api/vm/docker/run` | `{name, image, containerName?, ports?, volumes?, env?, restart?, args?}` |
| `POST /api/vm/docker/action` | `{name, id, action: "start"\|"stop"\|"restart"\|"pause"\|"unpause"\|"rm"}` |
| `POST /api/vm/docker/rmi` | `{name, image}` |
| `POST /api/vm/docker/inspect` | `{name, image}` |
| `POST /api/vm/compose` | `{name, project?, yaml}` |
| `POST /api/vm/docker/deploy` | `{name, image, containerName?, ports?, env?, volumes?, lan?, privileged?, hostNetwork?, restartPolicy?, pull?}` |
| `POST /api/vm/quickdeploy` | `{image, name?, template?, mem?, cpus?, ports?, env?, volumes?, containerName?, lan?, privileged?, hostNetwork?, restartPolicy?, pull?, keepOnFailure?, ephemeral?, waitS?, createdBy?}` |

Lists (`ports`, `env`, `volumes`, `args`) are arrays, or text with one entry per
line. The route table, with the module function behind each route and its
locks, is at the top of `lib/http.js` (container routes: `lib/microvm/routes.js`,
shared folders: `lib/shares-routes.js`).

## Development

```
npm test                                  # = node --test tests/  (Node 18.17+, no dependencies)
node tools/check-sources.js [report-file] # are the QEMU / Alpine download sources still valid?
npm run probe -- status                   # MCP protocol probe with one tool call
```

Tests never write to a real data folder (two only read the image cache in
`data/images` when it is there), never download, and start QEMU only on
blank scratch disks (skipped when QEMU is not installed). The container
lifecycle runs against a fake QEMU, the OCI tests against a mock registry.
The real microVM boot tests are opt-in, because they need the kernel and
QEMU: `DEVBOX_BOOT_TESTS=1 node --test tests/microvm-boot.test.js`. So is the
end-to-end matrix, which runs the real manager with real microVMs through its
API (about 80 s, 140 s with the VM cases; it borrows the kernel and the cached images of `data/` as
hard links on a scratch data root, downloads nothing, and ends only its own
QEMUs): `DEVBOX_E2E=1 node --test tests/microvm-e2e.test.js`
(`DEVBOX_E2E_PORT=<n>` picks the manager's port, `DEVBOX_E2E_VM=1` adds the
full-VM shared-folder case). Start a test instance with its own data and port:
`node server.js --no-open --port 8790 --data ./scratch`.
How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Changes: [CHANGELOG.md](CHANGELOG.md). Open items and known gaps: [TODO.md](TODO.md).
Bundled third-party material: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Screenshots

These screenshots show the previous (v1) GUI. v2 keeps its look and adds the
Setup card, **Run a Docker image**, the Containers and Images cards, the task
center, shared folders, the Serial console tab, per-forward LAN checkboxes
and the settings dialog.

**Dashboard**: host meters, prerequisites, templates and the VM list.

![Dashboard](docs/screenshots/01-dashboard.png)

**VM overview**: status, the SSH command, resources, disk, template, forwards.

![Overview](docs/screenshots/02-overview.png)

**VM settings**: resources, port forwards, disk, freeze, delete.

![Settings](docs/screenshots/03-settings.png)

**Docker tab**: containers, images, networks and volumes.

![Docker](docs/screenshots/04-docker.png)

**Network view**: every forward across all VMs, listening state, owner, conflicts.

![Network](docs/screenshots/05-network.png)

**Terminal**: a real shell in the browser.

![Terminal](docs/screenshots/06-terminal.png)

**New VM dialog** (v2 uses the **Create a VM** card instead).

![New VM dialog](docs/screenshots/07-new-vm-dialog.png)

**Deploy box with a preset**.

![Deploy an image](docs/screenshots/08-deploy-preset.png)
