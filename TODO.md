# To do

Open items after the 2.0.0 rework. Nothing here blocks normal use; see the README for
what works today.

## Next features

- [ ] **Use the normal `docker` command on Windows against a VM's Docker.** Per VM, write an
      SSH config entry and a `docker context` (`host=ssh://…`) so `docker build`,
      `docker compose up` and `docker ps` in a Windows terminal run inside the VM. Needs only
      the stand-alone Docker CLI binary (never Docker Desktop); offer it as an optional
      prerequisite with a verified download.
- [ ] **Refresh the README screenshots.** `docs/screenshots/` still shows the 1.x UI.

## Known gaps

- [ ] **Test on real Linux and macOS hosts.** Only Windows 10 (WHPX and TCG) has been run end
      to end. Unverified: `vm-manager.sh`, unix-socket monitor/serial paths, KVM/HVF
      detection, the `ss`/`lsof` listener parsers, macOS socket-path length handling.
- [ ] **"QEMU update available" indicator.** The Update QEMU action exists (Windows), but
      nothing tells the user a newer build is out.
- [ ] **Forward a compose project's published ports automatically** (Docker-in-VM), the way
      single-image deploys already do.
- [ ] **microVM engine:**
  - [ ] interactive `-it` and `exec` into a running container;
  - [ ] restart policies;
  - [ ] more than 1 vCPU per microVM (currently clamped to 1 until SMP is verified under
        WHPX on the `microvm` machine);
  - [ ] compose stacks on microVMs (needs networking between microVMs);
  - [ ] images larger than comfortably fit in RAM (the root filesystem is an initramfs):
        consider a disk-backed root for big images.
- [ ] **Shared folders: per-boot credentials.** A share's secret is visible inside its guest
      (`/proc/mounts`), so any program in that VM can reuse it. A per-owner endpoint or a
      credential bound to one boot would close that.
- [ ] **E2E cases not yet automated:** kernel setup on a fresh data folder (downloads),
      a data folder path longer than 259 characters, and privileged/host-network requests
      routed to Docker-in-VM by the Automatic engine.

## Watch upstream

- [ ] If official QEMU for Windows ever ships 9p (`-virtfs`) or virtio-fs host support, use
      it as a faster transport for shared folders and keep the built-in 9P server as the
      fallback.
