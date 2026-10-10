# Changelog

## 2.3.1

- **Type text into a VM**: `POST /api/vm/keys` and the MCP tool `send_keys`
  take `text` (at most 256 characters, plain ASCII on a US keyboard layout,
  `\n` = Enter), typed before the `keys`. Made while installing Debian 13
  unattended: the preseed address was typed into GRUB's boot line
  (`auto=true priority=critical url=http://10.0.2.2:<port>/preseed.cfg`), and
  the installer took it from there. A character a US keyboard cannot type is
  a 400.
- Learned on Windows (QEMU 11.1, ANGLE): a Linux desktop under Xorg cannot use
  the 3D window - glamor's first texture upload fails in the host's virgl
  (`COPY_TRANSFER3D: 22` after GL error 1282), whatever `VIRGL_DEBUG` says, so
  Xorg's picture is garbage. Kodi (OpenGL ES straight on GBM) works. Desktop
  guests run in the browser view, where Mesa draws in software (llvmpipe).

## 2.3.0

**Appliance VMs: a window with 3D graphics at full speed, and SSH to the
guest's own server.**

- **Screen: in the browser or in a window on this PC.** An appliance VM has a
  new setting `display` (create card, Settings, `POST /api/vm/settings`,
  `create_appliance_vm`, `start_vm(display=...)`). `window` opens the screen
  as a QEMU window on the PC that runs the manager with the 3D GPU
  `virtio-vga-gl`: the guest's OpenGL runs on this PC's graphics card through
  virgl. Kodi needs it (LibreELEC has no software OpenGL: on a plain VGA it
  stops with "failed to initialize egl"). The Overview's **Open in a window
  (3D, full speed)** / **Show in the browser** saves the setting and restarts
  (or starts) the VM. The window display is chosen from what the QEMU build
  offers (`-device help`, `-display help`): GTK with OpenGL ES on Windows, GTK
  or SDL in a desktop session on Linux, Cocoa without 3D on macOS. QEMU passes
  the window's size to the guest as its screen size, and GTK opens the window
  at the firmware's 640x480 (Kodi came up at 640x480), so on Windows the
  manager sizes the new window right after the start (1280x800 for the
  picture, at most 90 % of the screen): Kodi then drew at 1321x825 in a
  1321-pixel-wide window. Zoom-to-fit scales the picture when the window is
  resized later. Closing the window does not stop the VM (its close button is
  off: it would cut the guest's power).
- **Why 3D cannot be shown in the browser on Windows**: QEMU passes GL frames
  to VNC only through `egl-headless`, which allocates its copy texture as RGBA
  filled with BGRA data - accepted by desktop OpenGL, refused by OpenGL ES,
  which is what QEMU has on Windows (ANGLE). The VNC picture stayed black
  under ANGLE's Direct3D 11 and 9 back-ends while Kodi drew correctly in the
  guest and in a GTK window; ANGLE's Vulkan back-end crashed QEMU and its
  OpenGL back-end needs a WGL extension the AMD driver lacks. QEMU also
  refuses VNC next to a GL window.
- **Screenshots, Screen as text and keys of a VM in a window**:
  `lib/wincap.js` + `lib/assets/window-helper.ps1` capture QEMU's window
  (PrintWindow with full content: GL included, covered windows too; a
  minimized one is restored without the focus and minimized again) as the
  PPM QEMU's screendump writes, so screenshot and OCR work as before (about a
  second per picture, Windows only). Keys go through the monitor in both
  views. The WebSocket relay answers 409 `IN_WINDOW`.
- **SSH to an appliance**: its SSH port is now forwarded to the guest's port
  22 (this PC only, or the LAN), the Overview shows `ssh -p <port>
  <user>@127.0.0.1` with **Copy SSH command**, and the **Terminal** tab logs in
  with the guest's own account (`sshUser`, default root) and a password typed
  above it. The manager's key is offered first; the password reaches ssh
  only through `SSH_ASKPASS` (`lib/assets/askpass.js`: a one-time file in the
  private run folder, printed once and deleted; gone after 60 s anyway), is
  never stored, and lives in memory only while the session does (resizes log
  in again). Without a password: key only, batch mode. A guest without `stty`
  (LibreELEC) gets the terminal size as `COLUMNS`/`LINES`.
- Tested on Windows 10 with QEMU 11.1, WHPX and a Radeon RX 550: LibreELEC
  12.2.1's Kodi in a window with 3D (`GL_RENDERER = virgl (ANGLE (AMD, Radeon
  (TM) RX 550 ... Direct3D...))`), its first-run wizard driven through
  `send_keys` and Screen as text on the captured window, SSH switched on
  there, and the Terminal tab logged in as root with the password. Kodi's
  VA-API probe is refused by the host (`CREATE_VIDEO_BUFFER: 22`) but only
  breaks that probe's own GPU context.
- Tests: `tests/appliance-window.test.js` (window display choice, QEMU
  arguments, settings, guest SSH arguments, the askpass helper, sessions,
  screen routing; `WINCAP_E2E=1` captures and sizes a real window).

## 2.2.0

**Appliance VMs: boot any operating-system image with a screen - and a probe
that finds how this PC really runs VMs best.**

### Probe this PC (hardware acceleration helps, it is never required)

- **The host probe** (`lib/hostprobe.js`; Setup card **Probe this PC**,
  `POST /api/host/probe`, MCP `probe_host`; setup runs it once) boots the
  microVM kernel on q35 with 2 vCPUs under each candidate setting and runs a
  self-check inside (CPU flags, two parallel floating-point jobs, a checksum).
  The first candidate that passes - the host CPU, the host CPU without
  XSAVE/AVX, the old flag model, x86-64-v2, then the Hyper-V LAPIC and
  irqchip variants, QEMU's default model, and TCG as the reference - is used
  by every VM, appliance and container whose accelerator is automatic. The
  result is keyed to the QEMU version, CPU and OS build.
- Found with it on a Windows 10 laptop with QEMU 11.1: the WHPX CPU model this
  manager used (qemu64 + the AVX/XSAVE family) made every Linux guest panic in
  `fpstate_reset` 0.3 s into its boot, so VMs froze and the microVM
  calibration never finished; with XSAVE hidden, WHPX boots the same test
  guest about 13x faster than TCG.
- **Hypervisor faults**: QEMU 11.1 pauses a VM whose guest hit a fatal WHPX
  fault (QEMU stays alive - nothing looked wrong but a frozen screen); older
  QEMU exits. The status poll now checks `info status` for WHPX VMs (at most
  every 10 s) and the exit log; an automatic VM is restarted under TCG at once
  and keeps `accelFallback` (shown on its Overview) until an accelerator is
  chosen in its Settings. The appliance-only "force TCG" rule of 2.2's first
  draft is gone: the probe replaces it.
- WHPX accelerator options: with a probe, plain `-accel whpx` (QEMU 11.1
  tunes kernel-irqchip per Windows version itself) unless the probe chose
  otherwise; without one, the old `kernel-irqchip=off`.
- **The accelerator in use is QEMU's own answer**: QEMU 11.1 no longer prints
  "Windows Hypervisor Platform accelerator is operational", so every WHPX VM
  was recorded and shown as TCG ("whpx was not usable"), and every WHPX
  container got a false "fell back to TCG" warning. VMs and containers now ask
  the monitor `info accelerators` (the active one is bracketed: `qtest tcg
  [whpx]`); the log check stays for QEMU builds without that command.
- Measured after the probe on the same laptop: LibreELEC's splash in ~25 s
  under WHPX (about 3 min under TCG), a new Alpine VM to SSH in 19 s, an Alpine
  container in ~4 s end to end.

### Appliance VMs

- **Create an appliance VM** (a new card in the GUI, `POST /api/vm/create-appliance`,
  MCP `create_appliance_vm`): a `.img`, `.img.gz`, `.qcow2` disk image or a
  `.iso` installer, from a file on this PC or an https:// URL (downloaded once
  into `<data>/appliances/downloads`, checked against a sha256 when given, and
  reused). The image is converted to the VM's qcow2 disk and grown to the
  chosen size; an ISO stays attached as a CD-ROM beside an empty disk until
  **Remove CD-ROM** (`POST /api/vm/eject`), and a disk image marked as
  **installation media** (`install`) stays a second bootable disk beside an
  empty one in the same way. UEFI by default, with the edk2
  firmware that ships inside the QEMU package (a private variable store per
  VM); BIOS on request. virtio or SATA disk bus, a sound card that plays on
  this PC's speakers, an absolute-position USB tablet for the mouse. The
  first use was LibreELEC (Kodi) tried out before going on a mini PC.
- **Screen tab**: the VM's display in the browser (noVNC, vendored under
  `public/vendor/novnc`, MPL 2.0), with keyboard, mouse, fit-to-window,
  Ctrl+Alt+Del, full screen and **Save screenshot**. QEMU's VNC server binds
  the VM's private endpoint only (the same unguessable 127.x.y.z as its
  monitor on Windows); the manager relays it to the browser over its own
  WebSocket route `GET /api/vm/screen` (token, Host and Origin checked like
  every request) through `lib/ws.js`, a small RFC 6455 server written on the
  standard library. Nothing listens for the screen anywhere else.
- For Claude: `screenshot_vm` (QEMU's `screendump`, turned into a PNG by
  `lib/png.js`, saved under `<data>/screenshots`) and `send_keys` (QEMU
  `sendkey` names), so it can look at the screen it is testing and drive it.
  `GET /api/vm/screenshot?name=` and `POST /api/vm/keys` for everyone else.
- **Screen as text** (Windows): `GET /api/vm/screen-text`, the MCP tools
  `screen_text` and `wait_for_text`, `send_keys wait_for`, and a **Screen as
  text** button on the Screen tab. Windows' own OCR engine (Windows.Media.Ocr)
  in one persistent PowerShell 5.1 helper (`lib/ocr.js`,
  `lib/assets/ocr-helper.ps1`): 0.1-0.6 s per screen, screens up to 2000 px
  enlarged 2x first, phrase matching by edit distance that tolerates OCR's
  slips. Driving LibreELEC's installer by waiting for its dialogs' words
  instead of for a still picture removes 30-100 s of waiting per step. 501
  `OCR_UNAVAILABLE` elsewhere; the screenshot is unaffected.
- Appliance VMs have no SSH: the status is "running" as soon as the screen
  answers, Stop sends an ACPI power-off, the Terminal and Docker tabs are
  hidden for them, and their SSH port number is never forwarded (it only
  keeps the MAC unique). Snapshots, resize, compact, delete work as before;
  freezing one into a template is refused (templates are Alpine sandboxes).
- `connect-src` in the CSP names this origin's `ws://` form so the relay is
  allowed; `img-src` allows `blob:` for the saved screenshot.
- An appliance on a PC whose WHPX starts but never runs a guest (the microVM
  setup's calibration boot "did not finish under whpx") is run under TCG with
  QEMU's `max` CPU instead of the silent fallback with the WHPX CPU model,
  on which LibreELEC 12's kernel panics. `send_keys` / `POST /api/vm/keys`
  take `delayMs` for prompts that drop fast keys.

## 2.1.0

**Containers run from a disk now, so they need about 128 MB of RAM whatever
the image size - light enough to run the manager inside another VM.**

### Disk root (the new default for every image)

- The first run of an image writes it once into a read-only **image disk**
  (ext4 in a sparse qcow2, built in Node - as fast as the old in-memory boot
  image: 1 s for nginx, 5-6 s for a 606 MB image). Every container of that
  image shares it; each container gets its own copy-on-write **writable
  layer**, kept across stops and restarts until the container is removed, as
  in Docker. **Start fresh** drops it.
- Memory no longer follows the image: 128 MB by default (96 at least). nginx
  answers HTTP 200 after 1.3 s instead of 1.8 s, and its QEMU uses 170 MB
  instead of 292 MB. A 606 MB image that needed 1,456 MB as a RAM root runs
  at 96 MB. The end-to-end test, on a busier PC, measured the same memory
  (nginx 171 vs 293 MB, python 171 vs 292 MB) and 2.0 s vs 2.8 s to nginx's
  first answer. It also read a 601 MB image back byte for byte at the default
  128 MB.
- A disk-root container that runs out of memory is offered 1.5 times the
  memory it had (at least 192 MB) - also when that happens long after it
  started: init reports the kernel's out-of-memory kills (`__DEVBOX_OOM`),
  and a JVM, Node, Go or InnoDB out-of-memory error counts too.
- Apps known to need more than the small default get it unless the run sets
  its own memory: PostgreSQL 256 MB; MySQL, MariaDB, MongoDB and Java apps
  512 MB; Elasticsearch 1 GB (recognised by the program the image starts or
  its environment, never by its size; the start's log says so). Containers
  created by 2.0 with automatic memory keep their old RAM-root memory at
  their first disk-root start.
- If the data folder's disk fills up while a container writes, QEMU pauses
  it rather than lose the write: the list shows **paused: disk full** (MCP
  `paused`), it resumes by itself once there is room again, and a Stop ends
  it at once.
- Copy-in on a disk root copies the folder over the container's files at
  every start: files deleted on this PC are not deleted in the container
  (the GUI, MCP and README say so).
- The old in-memory root stays as an opt-in: **RAM** under Run > Advanced >
  Root filesystem, `rootfs: "ram"` in the API and MCP, or the default in
  Settings. Nothing ever switches to it by itself. Large images no longer go
  to Docker-in-VM because of their size.
- The GUI shows a **Disk** / **RAM** badge per container, the writable
  layer's size, and lets a container switch its root filesystem for its next
  start. The Images card shows each image disk's size.
- MCP: `run_image` and `deploy_image` take `rootfs` (default disk); their
  descriptions and the server instructions say what persists; results and
  `list_containers` carry `rootfs` and the writable layer's size;
  `memory_mb` goes down to 96. A full VM still needs 256 MB: `deploy_image`
  refuses less for `engine="docker-vm"` or `privileged`, and an automatic
  fallback to a full VM gives the VM its default instead.

### Light profile and running inside another VM

- **Settings > Light profile** (`"lightProfile": true` in `config.json`)
  lowers the defaults: containers 112 MB, a new full VM 512 MB, QEMU's TCG
  translation cache 64 MB for containers and 256 MB for full VMs (instead of
  QEMU's 1 GB), the Alpine download deleted after the base image is built,
  unused images pruned after 7 days. Each value can also be set on its own;
  an explicit value always wins. Measured under TCG with nginx: 229 MB of
  QEMU memory instead of 434 MB. A full VM created with the light profile's
  512 MB answered SSH 21 s after the request with WHPX (578 MB of QEMU
  memory), and 88 s under forced TCG (866 MB).
- Without hardware acceleration the GUI (**This PC > How to turn it on**,
  Settings > Acceleration), the Setup list and MCP `status` (`accel_hint`)
  say how to enable it: nested virtualization for Hyper-V, VMware
  Workstation and ESXi, VirtualBox and Proxmox/KVM (only the outer
  hypervisor's steps when the manager can tell which), the firmware switch on
  a physical PC, then the Windows Hypervisor Platform feature. The README has
  a new section, "Running inside another VM", with the same steps. They were
  checked against the vendors' documentation, which the section links to.
  The section also says what to expect under TCG.
- `POST /api/settings` takes the engine settings (written to `config.json`;
  `null` goes back to the profile default) and checks every field before
  anything is saved; `GET /api/state` reports them with both profiles'
  defaults and `accelHint`.
- `tools/mcp-probe.js` checks that `run_image` and `deploy_image` offer
  `rootfs` (`--expect-params` for more).

### Upgrading from 2.0

- Containers created by 2.0 have no root filesystem setting. They become
  disk-root containers, starting from the clean image as their RAM root did.
  A container that is running while the manager is updated keeps its RAM
  root until it stops.
- The first disk-root run of each cached image builds its image disk: about
  1 s for nginx, 5-6 s for a 600 MB image.
- Init changed, so the RAM root's boot images are built again the first
  time each one is needed.
- Restart the manager after updating. Running VMs and containers keep
  running and are picked up again. Claude's MCP server runs the new code
  after `restart_server` or a restart of Claude.

### Fixes

- Review fixes for the disk root, before release:
  - A forced image removal or a prune that waited for a starting
    container's image lock could delete the image disk that container was
    about to boot (and its later starts then failed). The start now claims
    its disk inside the lock, and removal and prune read who uses what
    under it; a disk that is gone anyway is a clear `ROOT_DISK_MISSING`
    instead of a QEMU failure.
  - `/` on an image disk took the mode and owner of the image's `./` tar
    entry: an image packed from a `0700` folder locked every non-root user
    out. It is 0755 root:root now, as in Docker (the RAM root gets root's
    owner too). Image disks are rebuilt once (new disk format).
  - A file with 1,021-1,360 extents (about 128-170 GiB with the normal extent
    size) made the image-disk writer overflow a block.
  - The disk root's `/.devbox` tmpfs (16 MB) could fill up with the path
    list of a large copy-in.
  - A shared disk boot archive could be pruned between a start finding it
    and booting it; a disk with no sidecar was deleted without the image's
    lock.
  - On Linux and macOS, a symbolic link for `microvms/` or `images/` broke
    the relative path a writable layer uses for its image disk: the manager
    now writes the full path in that case.
  - An image whose download alone is larger than `microvmImageMaxGB` is
    refused before the download, not after it.
  - Presets kept an earlier RAM choice for the root filesystem; a bad
    `rootfs` passed when the request went to Docker-in-VM; the Images list
    and MCP `list_images` lost the unpacked size of disk-root images; the
    first acceleration hint did not yet name the outer hypervisor.
  - The GUI shows when the light profile is on, and the memory fields say
    when a small value is too small.
- `POST /api/container/run` checked whether the engine was ready before it
  checked the request. On a PC without the kernel, a bad field got 409
  `NO_KERNEL` instead of 400. It now checks the request first, so a bad field
  (an unknown `rootfs`, memory below the floor, a bad port) is a 400 on every
  PC.

### Tests and documentation

- The end-to-end test (`tests/microvm-e2e.test.js`, opt-in) runs every case
  on the disk root unless the case asks for RAM. New cases:
  - busybox: environment, user, workdir, hostname and the open-files limit;
  - nginx on a LAN port, and nginx-unprivileged as `USER 101`;
  - a python TLS 1.3 handshake, and the guest clock against this PC's;
  - disk-root against RAM-root memory, for nginx and python;
  - a synthetic ~600 MB image;
  - one image disk shared by five containers;
  - a QEMU killed while it writes;
  - a force-removed image;
  - the data folder moved to another path;
  - TCG with the normal and the light profile;
  - MCP `status` and `run_image` with each root;
  - a light-profile full VM, also under forced TCG;
  - the guest-view check: a container lists its root from inside the guest
    (every path, mode, owner, link, size, time and byte) and it must equal
    the tree built on this PC - 0 differences for the six cached images and
    a synthetic edge image;
  - the prune of image disks and disk boot archives (files back-dated past
    the 10-minute age rule).

  Options: `DEVBOX_E2E_REPORT` writes the measurements, and
  `DEVBOX_E2E_MAX_GUESTS` caps how many guests run at once. In the 2.1 run,
  32 of 32 microVM cases and 2 of 2 full-VM cases passed.
- The image-disk writer is read back with a small ext4 reader
  (`tests/helpers/ext4read.js`), and the image-disk GC has its own tests.
  `npm test`: 675 tests, 670 pass, 5 skipped, 0 fail. A golden test pins
  the bytes of a fixed image's disk per disk format.
- `docs/ARCHITECTURE.md` describes the disk-root pipeline, the two boot
  stages, and the image disks and writable layers with their locks and GC.

## 2.0.0

**Docker images now run on Windows without Docker Desktop, WSL or Hyper-V.**
Each image runs as its own headless microVM. It is pulled straight from its
registry and booted with the Alpine kernel and a busybox init, with no Docker
Engine anywhere. Docker inside a full VM stays for compose stacks and as the
fallback for images the microVM engine cannot run. Folders of this PC can be
shared live with VMs and containers.

Under that, the backend was rewritten into modules with a hardened API. v2
also brings a new GUI, Linux and macOS support, per-forward port exposure,
and an MCP server (31 tools) so Claude can run images, create VMs and test in
them. v1 installs keep working: a v1 layout in the home folder is used as the
data folder, `vms.json` is migrated, and running VMs are adopted.

### Docker images without Docker (microVMs)

- **Run a Docker image**: the GUI card, `POST /api/container/run` and MCP
  `run_image`. The engine is Automatic (the default), microVM, or Docker
  inside a VM. Automatic runs a microVM when the request and the image allow
  it, else Docker in a new VM, and says why. Measured on a Windows 10 PC with
  WHPX and a cached image:
  - `hello-world` returns its output and exit code in 1.4 s, and
    `nginx:alpine` answers HTTP 200 after 1.8 s;
  - four containers started at once all answer within 2.8 s;
  - a graceful stop takes 0.12-0.35 s;
  - a 256 MB nginx guest costs 292 MB of RAM;
  - without hardware acceleration (TCG), hello-world takes 7.5-8 s.
- **Containers are kept until removed**, as in Docker:
  - exit codes follow Docker's: 125 is an engine failure with the reason;
    126/127 come with the guest's message; there is no code for a stop before
    the app started;
  - stdout, stderr, console and QEMU logs, live and for the previous boot;
  - Stop, Start, Remove, Kill and settings;
  - autostart, "remove when it exits", and temporary containers;
  - they keep running when the manager closes and are picked up again, and
    one that exited meanwhile shows its exit code.
- **An acknowledged stop protocol.** A stop is accepted during the pull and
  the boot too, and it is resent until the guest acknowledges it. A timeout
  means SIGKILL inside the guest, which still flushes and unmounts the
  volumes. A power-off happens only as the last resort. The result says how
  the container ended.
- **Ports**: this PC only unless LAN is ticked for that port. `/udp` is
  supported. When no ports are given, the image's EXPOSE ports are published
  (80 on 8080, 443 on 8443, other ports below 1024 on 8000+N). A LAN port is
  checked on 127.0.0.1 and 0.0.0.0, so another program on 127.0.0.1 cannot
  hijack its link. Containers reach each other at
  `host.docker.internal:<port>`.
- **Files**: named volumes (ext4 disks, seeded from the image at first use,
  one running container at a time), a folder of this PC as a live shared
  folder, and one-way copy-in at start (512 MB at most; scripts get 0755).
- **Image cache**: the Images card and `GET /api/images`, with pull, remove
  (Docker's `rmi` rules) and prune, and the Docker Hub pull quota. A cached
  tag makes no network request (pull policy `missing`). Boot images are built
  once per image and content. Concurrent first runs share one build, and
  cleanup goes by age and use.
- **Compatibility rules and a failure classifier.** Privileged mode, host
  networking, devices, compose, restart policies and the Docker socket are
  decided from the request, and Automatic sends them to Docker-in-VM up front.
  Other problems are found only after the pull: systemd and s6-overlay images
  (they must be PID 1), zstd layers on an older Node, and images too big to
  hold in RAM. For those the run never switches engine by itself: it ends
  with the reason and **Run with Docker-in-VM instead**
  (`POST /api/container/fallback`). Failures right after the start are
  classified: out of memory, needs PID 1, runs containers itself, a CPU
  feature, the wrong architecture.
- **Setup** gains a "microVM kernel" step (about 43 MB):
  `POST /api/install/kernel`, and **Set up for Docker images (about 1
  minute)** (`POST /api/setup {only: "microvm"}`), which is all images need.
  The Alpine package index and packages are verified against Alpine's RSA
  keys, which ship with the app. Verified packages already on disk are
  reused offline. One test boot measures this PC's clock for the microVMs.
- **Limits** are guarded and documented:
  - the root filesystem lives in RAM and is reset at every start;
  - a full root gives ENOSPC, never a kernel panic;
  - `-it` is refused (400 `NOT_SUPPORTED`);
  - there is no `exec` into a container and no compose;
  - more than 1 vCPU on the microvm machine is clamped with a warning;
  - the environment may be 30 KB at most;
  - QEMU paths over 259 characters get a clear error on Windows;
  - a start that would not fit in free memory is refused.

### Live shared folders

- A folder of this PC appears inside a VM or a container, both ways: an
  edit on Windows is seen within tens of milliseconds, and a write in the
  guest lands on Windows at once. The manager runs its own 9P2000.L file server
  on 127.0.0.1:5640 (`ninepPort`), because the Windows QEMU build has no 9p or
  virtio-fs. It works with any QEMU build and needs no admin rights.
- **VMs**: VM Settings > Shared folders (with a folder picker), MCP
  `share_folder`, `unshare_folder` and `list_shares`, and `POST
  /api/vm/shares`.
  - A share added or removed while the VM runs applies at once (0.5-0.8 s).
  - Every boot mounts the VM's shares, including a reboot inside the VM.
    This is done by the `devbox-shares` OpenRC service, which the base bake
    installs and which older VMs get over SSH the first time they need it.
  - After a manager restart the shares are mounted again within about a
    second.
- **Containers**: a folder of this PC in `volumes` is shared live. It is
  mounted before the app starts, and a mount that fails ends the start with
  125 and the reason. Files are owned by the image's numeric user. After a
  manager restart the guest re-mounts by itself (2.9 s measured).
- **Status per share**: mounted, mounting, not mounted (with the last
  reason), unavailable or not running, plus connections, open files and
  bytes (`GET /api/shares`). The folder picker uses `GET /api/fs/dirs`.
- The caveats are the same words in the GUI, the README and the MCP
  descriptions: file-watch events do not cross the share (dev servers need
  polling), chmod +x is not stored, and symlinks must stay inside the folder.

### Security

- The API needs an access token (`<data>/manager-token`, sent as
  `X-DevBox-Token`; the browser gets it through the `#token=` link). Before,
  any VM could drive the whole API through `10.0.2.2`, for example to delete
  other VMs.
- Host allow-list (DNS rebinding), Origin and Sec-Fetch-Site checks
  (cross-site requests), JSON-only POSTs capped at 1 MB, strict CSP and
  security headers, no CORS.
- Port forwards, SSH included, listen on 127.0.0.1 by default instead of every
  interface. LAN is an explicit choice per forward, and per container port.
- QEMU monitors and serial consoles moved from fixed 127.0.0.1 ports, which
  every guest could reach. On Windows they now use a random loopback address
  (127.x.y.z) and random ports, new at every start, so a web page cannot aim
  at them. Elsewhere they are unix sockets in the data folder or a checked
  private (0700) folder. If no such address can be bound, a start fails
  instead of falling back to 127.0.0.1 (`"allowSharedLoopback": true` in
  `config.json` allows it, with a warning). microVM containers get the same
  private endpoints.
- Only verified QEMU processes are ever killed. v1 identified a VM by whoever
  listened on its port, so Stop or Delete could kill another program. A QEMU
  the manager did not start itself is only taken over, or killed, after its own
  monitor confirms it is that VM (`info name`); the same for a base-image build
  left behind by a closed manager (`run/bake.json`). A container's QEMU is
  adopted only when its pid is a listed QEMU, equals the `qemu.pid` QEMU
  wrote, and its monitor names the container; a QEMU with no record is
  reported (and can be stopped) only when its command line names the
  container. A container's QEMU is recorded the moment it is spawned, so a
  manager that closes during a start leaves nothing untracked, and one it
  spawned itself is ended through its own process handle.
- Per-VM known_hosts with `accept-new` (host keys were not checked), and every
  clone makes its own SSH host keys at its first boot (clones shared their
  template's). The private key and the token are readable only by the user;
  the token's permissions are applied again at every start.
- The launcher and the MCP server hand the token only to a manager that proves
  it knows it (`GET /api/ping?nonce=` answers an HMAC bound to its port). A
  manager started without a console window never prints the token.
- Downloads are checked against the published sha512, and the QEMU
  installer's Authenticode signature must be its publisher's (Stefan Weil /
  Universität Mannheim) and chain to a trusted certificate authority -
  `"allowUnsignedQemu": true` in `config.json` overrides that.
- **Images**: HTTPS only (plain HTTP only for a registry on this PC, named
  literally: `*.localhost` is not trusted), sha256 checked for every manifest
  and blob, no credentials after a cross-host redirect, and a token realm on
  plain HTTP only for a plain-HTTP registry (an HTTPS registry cannot point the
  manager at a service on this PC). Before any layer is downloaded, the
  declared sizes are checked: too large to ever boot, or not enough free
  disk, and nothing is fetched; the exact unpacked size is checked again
  before anything is written. Layers are flattened in memory, never onto
  NTFS, with caps on entries, bytes (twice the microVM memory cap), path
  depth, path and link length (4096 bytes), PAX headers (1 MiB) and the
  total of the names kept. Image files under `/.devbox` (the engine's own
  folder: init, the run spec) are dropped, and init takes its spec from
  fw_cfg first. The microVM kernel is checked against Alpine's signing keys:
  the signed package index, then each package's size, hashes and signature.
- **microVM containers**: the hypervisor isolates each image in its own VM.
  Everything a container prints is untrusted: only strict, capped
  `__DEVBOX_*` lines are parsed, and the GUI shows the rest as text.
  Environment values are listed by name only (`reveal=1` shows them), never
  logged, and the run spec that carries them is written readable by the user
  only and deleted once the guest has read it. The per-boot log cap is also
  enforced on this PC: a container whose output grows far past it (an app in
  the guest can get around the guest's own cap) is stopped, so it cannot fill
  the disk, and a guest-written console log is only ever read at its ends.
  Under TCG the GUI and Claude say that a container is not a security
  boundary.
- **Shared folders**:
  - One random key per share, compared in constant time; failed attaches are
    slowed down, and repeated ones close the connection.
  - Keys are kept only in the registries and a per-guest fw_cfg file, all
    readable by the user only: the manager locks its `run/` and `microvms/`
    folders to the user at every start and writes `vms.json`,
    `containers.json` and their `.bak` copies so that they keep that lock
    (the default data folder is in the program folder, which every account
    may read). A share list that cannot be made private is not written. It
    is deleted when the guest stops. Keys are never logged, returned by the
    API or put on a command line.
  - Paths are jailed: `..` never climbs out, links never lead out (checked
    with realpath on every open and change), and Windows device names and
    8.3 aliases are refused.
  - Read-only is enforced by the server.
  - Connections, fids, open files and buffers are bounded per share.
  - The data folder, `~/.ssh`, the program folder and system folders cannot
    be shared - the data folder also when named another way (it is compared
    by identity on disk). Network and UNC paths (`\\localhost\C$\...`,
    `\\server\share`, mapped network drives) are refused by the API, the
    folder picker and MCP before anything opens them, so no SMB connection
    (and no Windows sign-in) is ever sent.
  - The key is visible in the guest's `/proc/mounts`, so every program in the
    guest can use the WHOLE share with its access - also a Docker container
    in a VM that sees only a sub-folder or mounts it `:ro`. This is
    documented in the GUI, the README and the MCP descriptions: the VM is the
    boundary, and the share's own read-only setting is what the manager
    enforces.
  - MCP port strings cannot open a port to the network by themselves
    (`0.0.0.0:`, `lan:`, `,lan`): only `lan=true` does.
- Everything sent into a guest shell is validated and quoted: image VOLUME
  paths, container, volume and project names, environment, ports. Container
  environment values are shown as `NAME=***` in task logs.
- MCP `upload`, `download`, `copy_in` and shared folders never copy the
  manager's token, SSH key, registries, config or disks, or `~/.ssh`, into a
  VM. They never write into the data or program folder, `~/.ssh` or a Startup
  folder. `DEVBOX_MCP_FILES` narrows them further.
- The GUI renders server, guest and image text as text (image metadata and
  Docker output could inject script). A link a VM prints into a terminal is
  shown in the app's own dialog instead of xterm's `confirm()` and
  `window.open()`.
- A VM still running from v1 is flagged with a **Restart now** warning in the
  GUI, `/api/state` and MCP `status` (its monitor stays reachable from guests
  until then).
- Terminal sessions have random ids, a limit of 16, and are closed when nobody
  watches them.
- The README no longer claims that VMs cannot reach each other; it says what a
  VM can and cannot reach.

### Fixes

- microVM containers and shared folders (from the integration review):
  - Volumes and shared folders are mounted in one list, parents first: a
    volume below a shared folder (`C:\project:/app` plus
    `node_modules:/app/node_modules`) or below another volume is no longer
    hidden by it, also after a shared folder is re-mounted.
  - A volume listed twice for one container is refused (two disks on one
    file corrupted it).
  - A volume's first seeding is all or nothing; a failed or interrupted copy
    is redone at the next start instead of leaving a half-filled volume.
  - After a manager restart, shared folders keep the image user as owner (a
    non-root app lost write access), and operations on existing containers
    wait for the adoption instead of treating running ones as stopped (a
    second QEMU on the same volume, ignored stops, removed running records).
  - A forced stop that cannot end QEMU says so instead of reporting
    `forced (quit)`; a user's stop no longer earns a Docker-in-VM suggestion;
    an out-of-memory failure offers **Run with N MB** (1.5 x what the image
    needs).
  - Port changes on a running container are kept until its next start: its
    links stay right, and old and new ports stay reserved.
  - Image removal and prune no longer delete the blobs or the new boot image
    of a container that is starting for the first time.
  - A Docker-in-VM fallback that fails gives the container its ports back;
    its confirmation says that named volumes start empty in the new VM.
  - `--rm` is honoured for a container that ended while the manager was
    closed; the "lost VM" note goes away once the VM is stopped.
  - The shared-folder server's port is reserved like the manager's own; a
    share added right after a manager restart brings the VM's other shares
    back too; a share that fails names the container path, not the internal
    mount point.
  - "Update QEMU" is refused while a container is still being prepared, and a
    start checks for it again before it boots QEMU.
  - GUI: the run result has **Stop**, the Memory field shows the default for
    the chosen image, the logs can show stdout and stderr together, and the
    port hint explains that ports below 1024 move up (80 -> 8080).
- Tasks always end and release their locks. A one-shot deploy that never
  finished, or a failed autostart, locked the GUI with 409 until a restart.
- `vms.json` is saved only on change and atomically, with a `.bak`. It was
  rewritten on every poll; a parse error reset every VM's settings, and a
  briefly unreadable disk folder deleted all records. Missing disks now show as
  `missing`.
- Downloads no longer hang on a stalled connection or leave truncated files
  that later runs trusted. Two downloads of one file at once no longer
  collide: each writer has its own `.part` file (image blobs, rootfs archives
  and boot images too, with "exists = success").
- The bake runs on a throwaway copy, needs an explicit success marker, a
  working toolchain and a clean shutdown, and refuses to replace a base that
  clones depend on.
- Nothing depends on English command output (`netstat`'s LISTENING) or on
  hard-coded tool paths.
- A taken manager port no longer crashes the start; the next free one is used.
- Deploy skips host ports in use instead of restarting the VM into a state
  where it could not boot; host-network deploys forward to the right port.
- Docker operations and grow-filesystem report failures instead of success.
- Editing ports keeps a deployed app's port metadata, and settings save on a
  running VM.
- Stop is bounded at every step (it could hang holding the global lock) and
  waits 45 s before quitting QEMU, 90 s under TCG (was 20 s).
- Terminal sessions no longer leak ssh processes, the terminal size matches
  the window, and fast tasks are reported.
- GUI: the template picker no longer resets every 2.5 s, switching VMs resets
  every tab, and forms are not wiped while you type.
- Full VMs under WHPX get a CPU model with the host's SSSE3, SSE4.x and POPCNT
  flags. QEMU's default WHPX model is not even x86-64-v2, so RHEL 9 / UBI 9
  based images failed in Docker VMs; they now run. The TCG fallback after a
  hardware accelerator commits 256 MB of translation cache instead of 1 GiB.
- A start whose private monitor or serial port was taken meanwhile retries
  with new ones.

Found and fixed by end-to-end tests on real VMs (Windows 10, QEMU 10.2, WHPX):

- Boot to SSH went from 31.5 s to 12-14 s: the base waits 1 s instead of 10 s
  in the boot menu, chronyd syncs in the background, and dhcpcd skips its ARP
  probe.
- A container that exits 0 at once ("Restarting (0)") failed silently: the
  deploy reported success. It now fails the deploy.
- Docker errors showed docker's "Run 'docker run --help'" footer instead of the
  cause.
- The serial console sent one event per 1-2 bytes (about 23,000 per boot); it
  now batches output every 20 ms.
- Status polls ran `tasklist` (1.5-4.5 s) on every poll while a VM ran, which
  slowed boots; running QEMUs are now tracked by their process handle.
- A guest kernel panic under WHPX on a busy host made a start wait 240 s. The
  base boots with `no_timer_check`, and a panic ends the wait with one retry.
- Stop and delete failed when `tasklist` timed out on a busy CPU, and a clean
  power-off could be reported as a failure.
- Under TCG a running VM flickered to `booting`, so MCP `exec` refused to run.
- Delete could fail with EPERM on Windows while a background `qemu-img` read
  held the disk open.
- Waits follow the accelerator (SSH 240 s, 600 s under TCG). MCP `timeout_s`
  never shortens a boot. `create_vm docker=true` checks that the daemon
  answers.

Found and fixed while turning the microVM prototype into the engine (each
with a regression test, and checked again end to end):

- Two runs at once could attach one volume read-write and lose a write. QEMU
  does not lock disk images on Windows. The start now re-reads the registry
  after the slow image preparation and takes a lock file per volume.
- A stop before the app was ready was silently lost, then became a 15 s hard
  kill: a socket write was treated as delivered. Stops are now acknowledged
  and resent, the guest listens for them from early in its boot, and a stop
  during the pull aborts it.
- Starts at the same time collided on their control ports. Each start now
  gets a random loopback address with ports picked by the OS, and a start
  whose port was taken retries.
- Concurrent first runs of one image failed on shared `.part` files, and a
  boot image keyed by a file time could be deleted while another run was
  about to boot it. Boot images are now keyed by content, built once under a
  per-image lock, and cleaned up only when old and unused.
- `stop` with a timeout was a power cut, and a file written 1 s earlier was
  lost. The timeout now means SIGKILL inside the guest, which still syncs.
- Writing a few hundred MB to the RAM root panicked the VM. The root is now
  capped, so the app gets ENOSPC.
- A LAN port was not checked on 127.0.0.1, so another program could answer
  its link.
- Init failures showed only a bare 125 or 126; they now carry the guest's
  message. QEMU's informational output is no longer shown as the error.
  Flatten warnings are shown.
- The calibration boot could cache a wrong clock rate labelled WHPX on a PC
  without WHPX. The package index was trusted over HTTPS alone. Flattening
  had no limits and container logs were unbounded. All of these are fixed.

Found and fixed by the microVM and shared-folder end-to-end runs (Windows 10,
QEMU 10.2, WHPX and TCG, on the real data folder):

- microVMs under TCG could hang for good while booting on a busy PC. The
  microvm machine has no HPET or ACPI PM timer, so the guest kernel
  calibrated the TSC against the PIT alone. When it missed its windows, the
  TSC was marked unstable and `calibrate_delay` waited for a tick that never
  came (18 of 24 boots with 8 in parallel). TCG runs now get the host's TSC
  frequency too: the one measured under WHPX, else from one q35 boot under
  TCG. 0 of 50 boots hung afterwards.
- A TCG run overwrote the WHPX host facts in `kernel/host.json`, so the next
  WHPX start ran the calibration boot again. TCG facts now live in
  `kernel/host-tcg.json`, and two runs share one calibration.
- A container stopped while its VM hung before init was recorded as exit 137
  "powered off". It is now "stopped before the app started" with no exit code,
  and a forced stop of such a VM takes about 5 s instead of 20 s.
- A UDP publish became TCP in these cases, and now stays UDP:
  - a quick deploy with a `/udp` port;
  - a run that fell back to Docker in a VM;
  - a VM's forwards after a manager restart;
  - the check of a live forward.
- Reading a cached image rewrote `images/refs.json` with a new "pulled at"
  time. This happened with pull policy "never" or a cached tag. The
  real-image test did it to the data folder at every run and re-created
  boot-image sources the engine had deleted.
- `config.json` got `{"ninepPort": 5640}` from every manager run although
  5640 was free; only a different (fallback) port is saved now.
- A container's stdout and stderr read back without their final newline
  (`echo hi` came back as "hi"); they are byte for byte now.
- MCP `run_image` offered `memory_mb` from 64, but the manager needs 128.

Found and fixed in a final review:

- A VM started while the manager was still re-adopting running VMs (the MCP
  server starts the manager and calls `create_vm` at once) lost its runtime
  record: its QEMU was orphaned and the start crashed.
- Two port changes, deploys or creates at the same time on different VMs could
  both take one host port (the second VM then could not start). Checked ports
  are now claimed at once, a forward whose port turns out to be taken is
  refused instead of saved for a restart, and two free-port probes of the same
  port no longer fail each other.
- MCP `forward_port` sent the whole forward list read a moment earlier, so two
  calls at once closed each other's forward. It now sends one change
  (`/api/vm/ports {add}`); the GUI's editor sends the list it loaded and gets
  409 `CHANGED` instead of silently closing a forward added meanwhile.
- MCP `cleanup` deleted temporary VMs made in the GUI, although it said it
  never would. It now deletes only VMs Claude created.
- A create's automatic SSH port could equal one of its own forwards.
- Setup blocked every VM start for the whole bake even when QEMU was already
  installed.
- Stop treated "ssh could not log in" (exit 255) as a power-off and waited the
  full timeout before quitting QEMU; a force stop could not interrupt a normal
  stop that was waiting, and the GUI's Force stop button was disabled while a
  start waited for a hung guest.
- Note, autostart and "temporary" could not be saved while any task held the VM.
- One slow SSH banner (TCG) hid the Docker tab's forms while the user typed.
- Upgrading a v1 registry dropped records whose names v2 does not accept
  without a word, and the only copy of the v1 file was overwritten; the names
  are now reported and `vms.json.v1-<time>` is kept.
- macOS: long VM names made the socket path too long for QEMU.
- MCP: an unknown tool name is now the JSON-RPC error -32602, as the
  specification says.

### New

- **MCP server** (`mcp-server.js`, 31 tools). It starts the manager headless
  when needed.
  - Readiness and setup: `status` reports `ready` and `ready_for_images`;
    `setup` has `images_only`.
  - Docker images: `run_image`, `stop_image`, `image_logs`,
    `list_containers`, `remove_container`, `pull_image`, `list_images`,
    `remove_image`, and `deploy_image` with `engine` auto|microvm|docker-vm
    (auto follows a Docker-in-VM fallback and says why).
  - Shared folders: `share_folder`, `unshare_folder`, `list_shares`.
  - VMs: create, start, stop, delete, reset and snapshots.
  - Work in a VM: `exec`, files and folders, port forwards.
  - `get_task`, `cleanup` (Claude's temporary VMs and containers) and
    `restart_server`.

  The instructions tell Claude when to use a microVM, a full VM or a live
  share. `tools/mcp-probe.js` checks the server with a real protocol
  conversation. The GUI's **Connect Claude** panel shows the configuration.
- **GUI**: the **Run a Docker image** card (engine choice, ports with LAN
  ticks, environment, volumes and folders with a folder picker, copy-in,
  presets), the **Containers** card with a detail panel (overview, "What went
  wrong", logs with follow, settings) and volumes, the **Images** card, and
  **Shared folders** in VM Settings.
- **Linux and macOS** support (`vm-manager.sh`); Windows parsing works in any
  display language.
- **Port exposure per forward**: this PC only by default, LAN when you tick
  it, with a global default for new forwards. `/udp` forwards.
- **One-click setup** (SSH key, QEMU on Windows, microVM kernel, Alpine image,
  base image) and **Update QEMU**.
- **Hardware acceleration** (WHPX, KVM, HVF) with automatic TCG fallback, per
  VM or global. The accelerator in use is shown.
- **Tasks** with live logs and locks; several run at once on different VMs
  and containers. Tasks carry `ctr` for the container they work on.
- **VMs**: restart, reset to template, snapshots, compact, force stop, live
  port changes on running VMs, settings saved while running, first-boot
  hostname and time zone, and an interactive serial console. A guest `reboot`
  now reboots.
- **Docker in a VM**: safe redeploy with rollback, forwards added live,
  removing a container removes its forwards, containers get the host's time
  zone, and quick deploy validates first and deletes its VM on failure. Lists
  take one entry per line, with commas kept.
- **Command line and config**: `--port`, `--data`, `--no-open`, `--help`,
  `VM_MANAGER_ROOT`, `VM_MANAGER_PORT`, `<data>/config.json` (also
  `ninepPort`, `containerLogCapMB`, `microvmMemCapMB`, `alpineMirror`). A
  second launch opens the running manager.
- **Logs** in `<data>/logs`: `manager.log`, `tasks.log` (size-capped), and
  QEMU's output per VM; per container in `<data>/microvms/<id>/`.
- **Tests** (`npm test`, node:test, no dependencies) and a `package.json`
  with no dependencies. The container lifecycle runs against a fake QEMU, the
  OCI code against a mock registry, the file server against a test client;
  real microVM boots are opt-in (`DEVBOX_BOOT_TESTS=1`).

### Changed

- New installs keep their data in `data/` next to `server.js`. v1 used the
  home folder, which is still used when a v1 install is found there.
- API routes and shapes changed: long operations answer 202 with a task, and
  the console routes are now `/api/session/*` (see README > API).
  `/api/state` also reports `containers` and `microvm`.
- The GUI's quick deploy card became **Run a Docker image**; Docker inside a
  VM is its engine for compose stacks and the fallback.
- Deploy adds forwards live through QEMU's monitor; a restart is only a
  fallback.
- Memory, vCPU and disk limits come from the host instead of fixed values.
- `tools/check-sources.js` uses the manager's own discovery code.
- `vm-manager.cmd` finds Node, passes its arguments through and keeps the
  window open after an error.
- The engine lives in new modules: `lib/oci` (registry client, layer
  flattening, the one cpio writer, image cache), `lib/microvm` (kernel setup,
  init, run planning, the container registry and supervisor) and `lib/ninep`
  with `lib/shares.js` (the file server and the shared-folder service).

### Removed

- The Git Bash "Show boot console window", replaced by the interactive
  **Serial console** tab.
- `-no-reboot` on normal starts, which turned a guest reboot into a power-off.
- Hard-coded Windows tool paths, and fixed ports for the QEMU monitors
  (25000+N) and the bake's seed server (8000).
