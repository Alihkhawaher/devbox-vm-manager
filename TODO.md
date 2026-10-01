# To do

Open items after 2.1.0 (the disk root and the light profile). Nothing here blocks normal use; see the README for
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
  - [ ] compose stacks on microVMs (needs networking between microVMs).
- [ ] **Disk root follow-ups** (the image disk and writable layers, SPEC-diskroot 16):
  - [ ] ext4 xattrs (in-inode `security.capability`) in the image disk, so a disk root no
        longer drops file capabilities (the FILE_CAPS warning);
  - [ ] htree indexes for large image directories (linear today: a 20,000-entry
        directory works, but lookups are O(n));
  - [ ] light profile: drop an image's layer blobs once its image disk is built (needs
        `pullImage` to skip the layer step when the disk exists; download again only when
        a format bump forces a rebuild);
  - [ ] "compact" a writable layer (fstrim + a rewrite without `qemu-img`) - only if
        users hit large layers;
  - [ ] the guest's ~20 MB of unreclaimable slab at 128 MB (the same on a RAM root): find
        what allocates it - it would lower the memory floor further;
  - [ ] gzip the disk-root boot archive (about 2 MB less at boot) if a lower floor is
        wanted;
  - [ ] a per-container root size (`--storage-opt size`).
- [ ] **Shared folders: per-boot credentials.** A share's secret is visible inside its guest
      (`/proc/mounts`), so any program in that VM can reuse it. A per-owner endpoint or a
      credential bound to one boot would close that.
- [ ] **Test inside real outer hypervisors.** The "Running inside another VM" steps were
      checked against the vendors' documentation, and TCG was measured with acceleration
      forced off on a physical PC - but the manager has not yet run inside a Hyper-V,
      VMware, VirtualBox or Proxmox VM, with and without nested virtualization. That run
      would also check the outer-hypervisor detection (`Win32_ComputerSystem` / DMI) on each.
- [ ] **Check the 2.1 GUI in a real browser:** the Root filesystem choice, the Disk / RAM
      badges, **Start fresh**, Settings > Light profile and **How to turn it on**. The 2.1
      run checked them with a fake page and the route and element-id tests only.
- [ ] **E2E cases not yet automated:**
  - [ ] kernel setup on a fresh data folder (downloads);
  - [ ] a data folder path longer than 259 characters;
  - [ ] privileged/host-network requests routed to Docker-in-VM by the Automatic engine;
  - [ ] a container that fills the data folder's disk (QEMU pauses it; the unit tests
        drive the pause and resume through a fake monitor - a real run needs a nearly
        full disk);
  - [ ] an OOM kill long after the start of a real app (the `__DEVBOX_OOM` marker and its
        classification are unit-tested).
- [ ] **Disk root: a container that is too small can thrash instead of failing.** Out of
      memory kills are reported (`__DEVBOX_OOM`), but page-cache thrashing is not: the
      kernel's pressure stall information (`/proc/pressure/memory`) could tell, if the
      microVM kernel has PSI.

## Watch upstream

- [ ] If official QEMU for Windows ever ships 9p (`-virtfs`) or virtio-fs host support, use
      it as a faster transport for shared folders and keep the built-in 9P server as the
      fallback.
