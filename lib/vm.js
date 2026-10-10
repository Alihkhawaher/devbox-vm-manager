'use strict';
/*
 * VM lifecycle and status (spec sections 5, 7 and 9).
 *
 * Identity (BUG-6, SEC-8, OPS-1, OPS-15): a VM is running iff runtime.pid is
 * alive AND is a qemu-system process (platform.listQemuPids). A VM is never
 * identified by "whoever listens on its port", and a pid that is not QEMU is
 * never killed. A pid the manager did not spawn itself is only adopted, or
 * killed, once the VM's OWN monitor confirmed it is that VM (`info name`):
 * a pid recorded before a reboot or crash can belong to any other QEMU by now
 * (another VM, another data folder's manager, the Android emulator).
 * QEMU is spawned directly (no cmd/bash - BUG-7), detached, with -pidfile,
 * -display none, a private monitor and serial socket (Windows: a random
 * 127.x.y.z and a random port per start - out of the guests' reach, because
 * slirp maps 10.0.2.2 to 127.0.0.1 only, and not guessable by a web page;
 * Linux/macOS: unix sockets in the data folder or a private 0700 folder -
 * SEC-1/SEC-4), and every host forward bound to 127.0.0.1 (this PC only, the
 * default) or 0.0.0.0 (LAN) as the user chose per forward (SEC-5, OPS-14,
 * spec section 7). No -no-reboot: a guest `reboot` reboots (XTR-12).
 *
 * Status: stopped | booting | running | stopping | missing | error.
 * listVms() is cheap and safe to poll (OPS-5): normally NO process listing
 * (vmAlive: the QEMU child's own handle, or a pid already verified as QEMU;
 * a listing - shared, cached 1 s - only for pids not verified yet; killing
 * always re-lists), SSH banner probes in parallel and cached 5 s for running VMs,
 * statSync for disk sizes, no netstat, concurrent callers share one in-flight
 * computation, and the registry is written only when something changed.
 * Virtual disk size and snapshots come from `qemu-img info -U`, cached per
 * disk and refreshed in the background (never awaited by a poll).
 *
 * Every task operation takes the task context `t` first and is started by
 * http.js after its validate*() resolved (bad input -> 400 before any task):
 *   validateCreate   -> opCreate(t, a)      validateStart    -> opStart(t, a)
 *   validateStop     -> opStop(t, a)        validateRestart  -> opRestart(t, a)
 *   validateDelete   -> opDelete(t, a)      validateReset    -> opReset(t, a)
 *   validateResize   -> opResize(t, a)      validateGrowFs   -> opGrowFs(t, a)
 *   validateCompact  -> opCompact(t, a)     validateFreeze   -> opFreeze(t, a)
 *   validateSnapshot -> opSnapshot(t, a)    (create | revert | delete | list)
 * Direct (non-task) calls: listVms(), hostState(), listTemplates(),
 * networkOverview(), updateSettings(body), setPorts(body), forgetVm(body).
 * Start-up: adoptRunning(), autostartAll().
 *
 * Start (spec section 9): checks the disk, its backing template and every
 * host port, spawns QEMU with the chosen acceleration (per-VM > global >
 * detected; a hardware accelerator is listed with TCG after it, and a VM that
 * dies within 20 s under it is retried once with TCG), waits for SSH
 * (default 240 s) and reports the QEMU output + serial tail when it fails.
 * The first boot of a clone names the guest after the VM and gives it the
 * host's time zone (XTR-16, XTR-17).
 *
 * Stop (XTR-1, BUG-21): SSH poweroff (bounded 15 s) or ACPI through the
 * monitor -> wait (45 s default, progress every 10 s) -> monitor quit -> kill
 * the verified QEMU pid. A force stop also cancels a start that is still
 * waiting for the guest, and cuts short a normal stop that is still waiting
 * for the guest to power off, instead of waiting for either to time out.
 *
 * CPU model (microVM spec item J): under WHPX a VM gets qemu64 plus the
 * host's own SSSE3/SSE4.x/POPCNT/... flags (whpxCpuModel) instead of QEMU's
 * default model, which is not even x86-64-v2; the TCG fallback after a
 * hardware accelerator gets a 256 MB translation cache instead of 1 GiB of
 * committed memory. A start whose private monitor/serial port was taken
 * between choosing and binding it retries with fresh endpoints.
 *
 * Shared folders (lib/shares.js): opStart registers vm.shares with the
 * manager's 9P server and passes the list to the guest over fw_cfg (extra
 * QEMU arguments); clearRuntime() - QEMU gone for whatever reason - closes
 * their connections and unregisters them; opDelete drops them with the
 * record. runtimeEndpoints() is shared with the microVM engine.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { CFG, rootId } = require('./config');
const platform = require('./platform');
const st = require('./state');
const { state } = st;
const tasks = require('./tasks');
const ports = require('./ports');
const monitor = require('./monitor');
const ssh = require('./ssh');
const shares = require('./shares');
const appliance = require('./appliance');
const {
  exists, sizeOf, nowIso, run, sleep, probeSsh, portListening, fmtBytes, tailFile, log, errMsg, shq,
  badRequest, notFound, conflict, vmNameError, isVmName, toBool, intInRange,
} = require('./util');

const isAppliance = (vm) => !!(vm && vm.kind === 'appliance');

const START_KINDS = /^(start|restart|create|quickdeploy|reset)$/;
const STOP_KINDS = /^(stop|delete)$/;
const GB = 1024 * 1024 * 1024;

function requireVmName(name, label) {
  const why = vmNameError(name);
  if (why) throw badRequest('bad ' + (label || 'VM') + ' name: ' + why);
  return name;
}

// The record of a VM, for validators and sync routes. A VM that is still
// being created has no record until its disk exists, but its create (or
// quick deploy) task already holds vm:<name>: answer 409 BUSY naming that
// task, so the GUI and Claude wait for it instead of hearing "no VM called X".
function lookupVm(name) {
  requireVmName(name);
  if (!st.state.vms[name]) tasks.assertFree('vm:' + name);
  return st.getVm(name);
}

// Last non-empty line of a program's output, for error messages.
function lastLine(r) {
  const lines = String((r && (r.stderr || r.stdout)) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : 'no output';
}

// ---------------------------------------------------------------------------
// QEMU command line (pure)
// ---------------------------------------------------------------------------
// q35 (PCIe) is the modern machine type and what the accelerator probe uses;
// QEMU builds without it fall back to the default machine (opStart).
const MACHINE = 'q35';

// Locally administered QEMU prefix + the SSH port: stable per VM, unique per port.
function macForPort(port) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return '52:54:00:00:' + h(Math.floor(port / 256) % 256) + ':' + h(port % 256);
}

// SSH is always forwarded; app forwards live in vm.ports. Each forward binds
// 127.0.0.1 (this PC only) or 0.0.0.0 (LAN), as the user chose.
function netdevFor(vm) {
  // an appliance has no SSH: its port number only keeps the MAC unique
  let nd = 'user,id=n0' + (isAppliance(vm) ? '' : ',hostfwd=' + ports.hostfwdRule({ host: vm.port, guest: 22, lan: !!vm.sshLan }));
  for (const p of vm.ports || []) {
    if (p && ports.validPort(p.host) && ports.validPort(p.guest)) nd += ',hostfwd=' + ports.hostfwdRule(p);
  }
  return nd;
}

// QEMU option values are comma-separated key=value lists: a literal comma in
// a path must be doubled.
const qv = (s) => String(s).replace(/,/g, ',,');

function chardevSpec(id, ep) {
  const where = ep.path ? 'path=' + qv(ep.path) : 'host=' + ep.host + ',port=' + ep.port;
  return 'socket,id=' + id + ',' + where + ',server=on,wait=off';
}

// TCG translation-block cache (MB) when QEMU falls back from a hardware
// accelerator to emulation: QEMU's default on a 64-bit host is 1 GiB, and on
// Windows it is COMMITTED up front - about 900 MB of extra commit for every
// VM that falls back (microVM spec item J; microVMs measured 1.33 GB -> 430
// MB with 128). Full VMs run bigger guests, so 256.
const TCG_FALLBACK_TB_MB = 256;

// Acceleration: a hardware accelerator is listed first with TCG after it, so
// QEMU falls back to emulation by itself when the first one fails to init.
// A VM that asks for TCG itself keeps QEMU's default cache (it is the
// primary engine there and a smaller cache means more retranslation) -
// unless config.json "vmTcgTbSizeMB" (the light profile: 256) caps it: on a
// PC without acceleration, often itself a VM, the 1 GiB committed per VM is
// what makes it heavy. Read at every start, so the setting needs no restart.
function accelArgs(accel) {
  if (!accel || accel === 'tcg') return ['-accel', CFG.vmTcgTbSizeMB > 0 ? 'tcg,tb-size=' + CFG.vmTcgTbSizeMB : 'tcg', '-cpu', 'max'];
  return ['-accel', accel === 'whpx' ? 'whpx,kernel-irqchip=off' : accel, '-accel', 'tcg,tb-size=' + TCG_FALLBACK_TB_MB];
}
// CPU model for hardware accelerators. KVM/HVF honour the model, and the
// default (qemu64) lacks SSE4.2/POPCNT, so x86-64-v2 images (UBI 9 and
// friends) would refuse to run: "max" is the host's CPU there, and still
// valid if QEMU falls back to TCG.
// WHPX: QEMU's default model under WHPX is NOT the host CPU (measured: the
// guest lacks SSSE3, SSE4.1/4.2 and POPCNT - not even x86-64-v2 - so RHEL
// 9 / UBI 9 based images fail inside Docker VMs), and "-cpu host" / "max"
// abort ("WHPX: Unexpected VP exit code 4"). So qemu64 plus the flags the
// host really has (lib/microvm/hostcpu.whpxCpuModel, from the host's
// IsProcessorFeaturePresent): cpuModel. Without a known model (probe
// failed) WHPX keeps QEMU's default.
function cpuArgs(accel, cpuModel) {
  if (accel === 'kvm' || accel === 'hvf') return ['-cpu', 'max'];
  if (accel === 'whpx' && cpuModel) return ['-cpu', cpuModel];
  return [];
}

// The WHPX CPU model for this host (see cpuArgs), or null. From the host
// facts the microVM setup recorded (kernel/host.json) when present, else one
// PowerShell probe (~1 s) per manager process. Never rejects.
let cpuModelPromise = null;
function whpxCpuModel() {
  if (!platform.IS_WIN) return Promise.resolve(null);
  if (!cpuModelPromise) {
    cpuModelPromise = (async () => {
      const hostcpu = require('./microvm/hostcpu');
      try {
        const facts = JSON.parse(fs.readFileSync(CFG.hostFactsFile, 'utf8'));
        if (facts && facts.features) return hostcpu.whpxCpuModel(facts.features);
      } catch (e) { /* no host facts yet */ }
      try { return hostcpu.whpxCpuModel(await hostcpu.probeWindowsCpuFeatures()); }
      catch (e) { return null; }
    })();
  }
  return cpuModelPromise;
}

// o: {name, disk, mem, cpus, accel, cpuModel, machine, netdev, mac, monitor,
//     serial, serialLog, pidFile, extraArgs}
// machine: undefined = MACHINE, null = QEMU's default. extraArgs: more QEMU
// arguments, e.g. the shared-folder list (lib/shares.js: -fw_cfg ...).
// -display none, not -nographic: the serial port goes to its own socket
// (interactive console, XTR-2) and is also logged to <vm>-serial.log.
function qemuArgs(o) {
  const a = ['-name', o.name, '-m', String(o.mem), '-smp', String(o.cpus)];
  if (o.machine !== null) a.push('-machine', o.machine || MACHINE);
  a.push(...accelArgs(o.accel), ...cpuArgs(o.accel, o.cpuModel));
  // an appliance brings its own drive arguments (bus, CD-ROM, boot order)
  if (o.drives) a.push(...o.drives);
  else a.push('-drive', 'file=' + qv(o.disk) + ',if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap');
  a.push('-netdev', o.netdev, '-device', 'virtio-net-pci,netdev=n0,mac=' + o.mac);
  a.push('-display', 'none');
  a.push('-chardev', chardevSpec('ser0', o.serial) + (o.serialLog ? ',logfile=' + qv(o.serialLog) + ',logappend=off' : ''), '-serial', 'chardev:ser0');
  a.push('-chardev', chardevSpec('mon0', o.monitor), '-mon', 'chardev=mon0,mode=readline');
  if (o.pidFile) a.push('-pidfile', o.pidFile);
  if (o.extraArgs && o.extraArgs.length) a.push(...o.extraArgs);
  return a;
}

// What QEMU really runs with. With several -accel options QEMU falls back
// silently; its own output tells: WHPX announces itself, a failed KVM/HVF
// init is reported. Pure.
function effectiveAccel(requested, qemuOutput) {
  const out = String(qemuOutput || '');
  if (!requested || requested === 'tcg') return 'tcg';
  if (requested === 'whpx') return /Windows Hypervisor Platform accelerator is operational/i.test(out) ? 'whpx' : 'tcg';
  if (new RegExp('\\b' + requested + '\\b', 'i').test(out) && /(fail|could not|cannot|not supported|unavailable|error)/i.test(out)) return 'tcg';
  return requested;
}

// ---------------------------------------------------------------------------
// guest personalisation (pure helpers)
// ---------------------------------------------------------------------------
// VM names allow "." and "_", hostnames do not: map to [A-Za-z0-9-], <= 63.
function guestHostname(name) {
  const h = String(name || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '');
  return h || 'devbox';
}

// An IANA zone name we are willing to put into a path in the guest.
function validTimezone(tz) {
  const s = String(tz || '');
  return s.length < 64 && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(s) ? s : null;
}

// Shell script (run with `sh -s` over SSH) that names the guest, sets its
// time zone and gives it its OWN SSH host keys. /etc/hosts is rewritten field
// by field with awk, not with a sed regex: the old name (a template frozen
// from another VM) may contain dots. The zone file is COPIED to /etc/localtime
// (a regular file, which is what the Docker localtime fix expects).
// Host keys: every clone starts with its template's keys, so without new ones
// any guest's root would hold the private key the manager pins for all its
// sibling VMs (SEC-12). The new set is made aside (ssh-keygen -A -f <prefix>),
// then swapped in, then sshd is told to re-read them (SIGHUP: it re-executes
// itself; this session keeps running) - personalize() then pins the new key.
// opts.root (tests only) runs it against a scratch folder instead of / and
// leaves the running hostname and the host keys alone. Pure.
function personalizeScript(hostname, tz, opts) {
  const root = (opts && opts.root) || '';
  return [
    'new=' + shq(hostname) + '; tz=' + shq(tz || '') + '; R=' + shq(root),
    'old=$(head -n 1 "$R/etc/hostname" 2>/dev/null)',
    'case "$old" in ""|*[!A-Za-z0-9.-]*) old=$([ -z "$R" ] && hostname 2>/dev/null) ;; esac',
    'echo "$new" > "$R/etc/hostname" || { echo "could not write /etc/hostname"; exit 11; }',
    'if [ -z "$R" ]; then hostname "$new" || { echo "could not set the hostname"; exit 11; }; fi',
    'if [ -n "$old" ] && [ "$old" != "$new" ] && [ -f "$R/etc/hosts" ]; then',
    '  awk -v o="$old" -v n="$new" \'{ for (i = 1; i <= NF; i++) { if ($i == o) $i = n; else if (index($i, o ".") == 1) $i = n substr($i, length(o) + 1) } print }\' "$R/etc/hosts" > "$R/etc/hosts.devbox" && cat "$R/etc/hosts.devbox" > "$R/etc/hosts"',
    '  rm -f "$R/etc/hosts.devbox"',
    'fi',
    'awk -v n="$new" \'{ for (i = 2; i <= NF; i++) if ($i == n) f = 1 } END { exit !f }\' "$R/etc/hosts" 2>/dev/null || printf \'127.0.1.1\\t%s\\n\' "$new" >> "$R/etc/hosts"',
    'echo "hostname: $new"',
    'if [ -n "$tz" ]; then',
    '  if [ -f "$R/usr/share/zoneinfo/$tz" ]; then',
    '    [ -d "$R/etc/localtime" ] && rmdir "$R/etc/localtime" 2>/dev/null',
    '    cp "$R/usr/share/zoneinfo/$tz" "$R/etc/localtime.devbox" && mv -f "$R/etc/localtime.devbox" "$R/etc/localtime" && echo "$tz" > "$R/etc/timezone" && echo "time zone: $tz"',
    '  else',
    '    echo "time zone: $tz is not installed in this guest (no tzdata) - it stays on UTC"',
    '  fi',
    'fi',
    'if [ -z "$R" ] && command -v ssh-keygen >/dev/null 2>&1; then',
    '  k=/run/devbox-hostkeys; rm -rf "$k"; mkdir -p "$k/etc/ssh" && chmod 700 "$k"',
    '  if ssh-keygen -A -f "$k" >/dev/null 2>&1 && ls "$k"/etc/ssh/ssh_host_*_key >/dev/null 2>&1; then',
    '    rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub && mv -f "$k"/etc/ssh/ssh_host_* /etc/ssh/ && echo "ssh host keys: new for this VM"',
    '    p=$(cat /run/sshd.pid 2>/dev/null || cat /var/run/sshd.pid 2>/dev/null)',
    '    if [ -n "$p" ]; then kill -HUP "$p"; else rc-service sshd reload >/dev/null 2>&1 || true; fi',
    '  else',
    '    echo "ssh host keys: could not make new ones - this VM keeps its template\'s keys"',
    '  fi',
    '  rm -rf "$k"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

// Grow the root filesystem to the size of its disk (after a disk resize).
// Handles a root on a partition (growpart first) and ext*/xfs/btrfs, and
// exits non-zero when growing failed. Run with `sh -s`. Pure.
function growFsScript() {
  return [
    'dev=$(awk \'$2 == "/" { d = $1 } END { print d }\' /proc/mounts)',
    'fs=$(awk \'$2 == "/" { t = $3 } END { print t }\' /proc/mounts)',
    '[ "$dev" = /dev/root ] && dev=$(readlink -f /dev/root 2>/dev/null || echo /dev/root)',
    'echo "root filesystem: $dev ($fs)"',
    'case "$dev" in',
    '  /dev/*[0-9])',
    '    disk=$(echo "$dev" | sed -E \'s/p?[0-9]+$//\'); part=$(echo "$dev" | sed -E \'s/^.*[^0-9]([0-9]+)$/\\1/\')',
    '    if [ "$disk" != "$dev" ] && [ -b "$disk" ]; then',
    '      if command -v growpart >/dev/null 2>&1; then growpart "$disk" "$part" || true; else echo "growpart is not installed - only the filesystem is grown"; fi',
    '    fi ;;',
    'esac',
    'case "$fs" in',
    '  ext2|ext3|ext4) resize2fs "$dev" 2>&1 ;;',
    '  xfs) xfs_growfs / 2>&1 ;;',
    '  btrfs) btrfs filesystem resize max / 2>&1 ;;',
    '  *) echo "cannot grow a $fs filesystem"; false ;;',
    'esac',
    'rc=$?',
    'echo "--"',
    'df -h / | tail -n 1',
    'exit $rc',
    '',
  ].join('\n');
}

function snapshotNameError(s) {
  if (s === undefined || s === null || s === '') return 'a snapshot name is required';
  if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(s)) {
    return 'use 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit';
  }
  return null;
}

// `qemu-img info --output=json` -> the fields we use. Pure; throws on bad JSON.
function parseQemuImgInfo(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || typeof j !== 'object') throw new Error('not a qemu-img info object');
  return {
    format: j.format || null,
    virtualSize: typeof j['virtual-size'] === 'number' ? j['virtual-size'] : null,
    actualSize: typeof j['actual-size'] === 'number' ? j['actual-size'] : null,
    backing: j['backing-filename'] || null,
    backingFull: j['full-backing-filename'] || null,
    backingFormat: j['backing-filename-format'] || null,
    snapshots: (Array.isArray(j.snapshots) ? j.snapshots : []).map((s) => ({
      id: String(s.id),
      name: String(s.name),
      date: typeof s['date-sec'] === 'number' ? new Date(s['date-sec'] * 1000).toISOString() : null,
      vmStateBytes: typeof s['vm-state-size'] === 'number' ? s['vm-state-size'] : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// disks: qemu-img info, cached for status polls
// ---------------------------------------------------------------------------
// -U (force share): readable while QEMU has the disk open.
async function diskInfo(file) {
  const qi = platform.findTool('qemu-img');
  if (!qi) return { ok: false, error: 'qemu-img was not found' };
  const r = await run(qi, ['info', '--output=json', '-U', file], { timeout: 30000 });
  if (r.code !== 0) return { ok: false, error: lastLine(r) };
  try { return Object.assign({ ok: true, error: null }, parseQemuImgInfo(r.stdout)); }
  catch (e) { return { ok: false, error: 'unreadable qemu-img output' }; }
}

const infoCache = new Map(); // name -> {key, at, virtualSize, snapshots, busy}
let infoRuns = 0;

function diskKey(name) {
  try { const s = fs.statSync(st.diskPath(name)); return s.size + ':' + s.mtimeMs; } catch (e) { return null; }
}

async function refreshInfo(name) {
  const c = infoCache.get(name) || { key: null, at: 0, virtualSize: null, snapshots: [], busy: false };
  infoCache.set(name, c);
  c.busy = true;
  infoRuns++;
  try {
    const key = diskKey(name);
    const i = await diskInfo(st.diskPath(name));
    c.key = key;
    c.at = Date.now();
    if (i.ok) { c.virtualSize = i.virtualSize; c.snapshots = i.snapshots.map((s) => ({ name: s.name, date: s.date, id: s.id })); }
  } finally { c.busy = false; infoRuns--; }
  return c;
}

// On Windows a file another process has open cannot be deleted or replaced
// (EPERM). Found on a real run: a status poll's background `qemu-img info`
// was still reading a VM's disk when its delete task removed it, and the
// delete failed. So operations that delete or replace a disk first wait for a
// read in flight (no new ones start while a task holds the VM - describeVm),
// and retry briefly on EPERM/EBUSY/EACCES, which also covers an antivirus
// scanner looking at a disk QEMU just closed.
async function infoIdle(name, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    const c = infoCache.get(name);
    if (!c || !c.busy) return;
    await sleep(100);
  }
}
async function retryFs(what, fn) {
  let last = null;
  for (let i = 0; i < 25; i++) {
    try { return fn(); }
    catch (e) {
      last = e;
      if (!/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e;
      await sleep(200);
    }
  }
  throw new Error(what + ' failed: ' + errMsg(last) + ' - another program (antivirus, a backup or sync tool) may be holding the file; try again in a moment');
}

// Cached {virtualSize, snapshots} for a status poll. A running VM's disk
// changes all the time, so it is re-read at most once a minute; a stopped
// one whenever the file changed. Never waits for qemu-img.
function cachedInfo(name, running) {
  const c = infoCache.get(name);
  const key = diskKey(name);
  const stale = !c || (c.key !== key && (!running || Date.now() - c.at > 60000));
  if (key && stale && !(c && c.busy) && infoRuns < 2 && platform.findTool('qemu-img')) refreshInfo(name).catch(() => {});
  return c || null;
}

// ---------------------------------------------------------------------------
// runtime identity
// ---------------------------------------------------------------------------
const children = new Map();   // name -> {child, pid, startedAt, exited, code, signal, spawnError}
const probeCache = new Map(); // name -> {pid, ok, at, fails, inflight} (sshUp)
const pidsCache = { value: null, at: 0, inflight: null };
// Names a force stop was requested for while another task held the VM: a
// start gives up waiting for the guest, a normal stop stops waiting for the
// power-off (XTR-1). Set and cleared by validateStop only.
const forceRequested = new Set();

// pid -> VM name, for pids whose identity is CONFIRMED: the VM's own monitor
// answered `info name` with its name while that pid ran (or, for a VM adopted
// from v1, the pid listened on its SSH port). A pid is only reused after its
// process has gone, so the entry holds while pidAlive() says yes.
const identity = new Map();

// Pids a process listing showed as qemu-system-* and that have been alive
// ever since. A pid is only reused after its process is gone, so while
// pidAlive() says yes it is still that QEMU; once it is gone it is dropped.
const verifiedPids = new Set();
function noteQemuPids(set) { if (set) for (const p of set) verifiedPids.add(p); }

// Pids of running QEMU processes; one listing shared by concurrent callers and
// reused for maxAgeMs. On a failed listing the last good answer is kept.
async function qemuPids(maxAgeMs) {
  const age = maxAgeMs === undefined ? 1000 : maxAgeMs;
  if (pidsCache.value && Date.now() - pidsCache.at < age) return pidsCache.value;
  if (!pidsCache.inflight) {
    pidsCache.inflight = platform.listQemuPids().then((v) => {
      if (v) { pidsCache.value = v; pidsCache.at = Date.now(); noteQemuPids(v); }
      return v;
    }).finally(() => { pidsCache.inflight = null; });
  }
  const v = await pidsCache.inflight;
  return v || pidsCache.value;
}

function aliveIn(vm, pids) {
  const pid = vm && vm.runtime && vm.runtime.pid;
  if (!pid) return false;
  return pids ? pids.has(pid) : platform.pidAlive(pid);
}

// Is the VM's recorded QEMU process running? Cheap enough for every status
// poll (OPS-5). Found on a real run: `tasklist` takes 1.5-4.5 s on a busy
// Windows PC, and it ran on every /api/state while any VM was up - the
// GUI's polling alone made booting guests measurably slower.
//  - a QEMU this manager started: Node holds its process handle, so the pid
//    cannot be reused while it has not exited - exact, no listing at all;
//  - a pid a listing already showed as QEMU: alive while the pid is;
//  - anything else (e.g. a VM adopted at start-up): one shared listing.
// Killing never relies on this: stillQemu() is exact (own handle or a fresh listing).
async function vmAlive(name, vm) {
  const pid = vm && vm.runtime && vm.runtime.pid;
  if (!pid) return false;
  const c = children.get(name);
  // own child: its 'exit' event can trail the process's end by a moment, so
  // also ask the OS (exact here - our handle keeps the pid from being reused)
  if (c && c.child && c.pid === pid) return !c.exited && platform.pidAlive(pid);
  if (verifiedPids.has(pid)) {
    if (platform.pidAlive(pid)) return true;
    verifiedPids.delete(pid);
    return false;
  }
  return aliveIn(vm, await qemuPids(1000));
}

async function isRunning(name) {
  const vm = state.vms[name];
  if (!vm || !vm.runtime) return false;
  return vmAlive(name, vm);
}

// Is pid (the QEMU of VM `name`) still that QEMU? true / false (gone) / null
// (cannot tell: the process listing failed). This decides whether a pid may
// be KILLED, so it is exact: a QEMU this manager started is known through
// its own process handle (the pid cannot be reused while Node holds it);
// anything else needs a fresh listing. Found on a real run: on a PC at 100%
// CPU `tasklist` ran past its timeout, and a VM could not be stopped or
// deleted at all - although the manager had started that QEMU itself.
async function stillQemu(name, pid) {
  const c = children.get(name);
  // (the 'exit' event can arrive a moment after the process ended - found on
  // a real run: a clean power-off was then reported as 'could not be stopped')
  if (c && c.child && c.pid === pid) return !c.exited && platform.pidAlive(pid);
  if (!platform.pidAlive(pid)) return false;
  const pids = await platform.listQemuPids();
  noteQemuPids(pids);
  return pids ? pids.has(pid) : null;
}

// Is pid really the QEMU of VM `name`? true / false (it is another VM's, or
// gone) / null (cannot tell: its monitor does not answer). Decides whether a
// pid the manager did not spawn may be adopted or KILLED (SEC-8, BUG-6).
async function confirmIdentity(name, vm, timeoutMs) {
  const rt = vm && vm.runtime;
  const pid = rt && rt.pid;
  if (!pid) return false;
  const c = children.get(name);
  if (c && c.child && c.pid === pid) return !c.exited; // spawned here: our handle pins the pid
  if (!platform.pidAlive(pid)) { identity.delete(pid); return false; }
  if (identity.get(pid) === name) return true;
  if (rt.legacy || !rt.monitor) return null; // a v1 QEMU has no -name to ask for
  const got = await monitor.infoName(rt.monitor, timeoutMs);
  if (got === null) return null;
  if (got !== name) return false;
  identity.set(pid, name);
  return true;
}

// Wait until pid is gone; with t, log progress every 10 s (BUG-21). abort()
// (optional) is polled: true ends the wait early (a force stop came in).
async function waitGone(pid, ms, t, what, abort) {
  const t0 = Date.now();
  let last = t0;
  while (Date.now() - t0 < ms) {
    if (!platform.pidAlive(pid)) return true;
    if (abort && abort()) return false;
    if (t && Date.now() - last >= 10000) {
      last = Date.now();
      t.log('  ' + (what || 'waiting') + ' (' + Math.round((last - t0) / 1000) + ' s)...');
    }
    await sleep(500);
  }
  return !platform.pidAlive(pid);
}

// ---------------------------------------------------------------------------
// unix socket paths (Linux/macOS)
// ---------------------------------------------------------------------------
// sun_path holds 104 bytes on macOS and 108 on Linux (incl. the NUL); stay
// below 100. Order: <runDir>/<name>.mon (readable), <runDir>/<hash>.m (short
// names for long VM names), then a PRIVATE folder under $XDG_RUNTIME_DIR,
// /tmp or the temp folder for a long data path. That last folder is checked:
// in a shared /tmp another local user could create "our" folder first and
// swap the sockets for fake ones (the manager would then send them what the
// user types in the serial console).
const SUN_MAX = 100;
const fitsSun = (p) => Buffer.byteLength(p) < SUN_MAX;
let privateDirCache = null;

// A folder only this user can use: a real directory (not a symlink), owned by
// us, no group/other permissions. Pure apart from the lstat.
function dirIsPrivate(dir) {
  try {
    const s = fs.lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && s.uid !== process.getuid()) return false;
    return (s.mode & 0o077) === 0;
  } catch (e) { return false; }
}

function privateSocketDir(base) {
  if (!base || !path.isAbsolute(base)) return null;
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  // stable per user + data folder first (no litter), else a fresh mkdtemp
  const stable = path.posix.join(b, 'devbox-' + uid + '-' + rootId(CFG.root).slice(0, 8));
  try { fs.mkdirSync(stable, { mode: 0o700 }); } catch (e) { /* exists, or not creatable */ }
  if (dirIsPrivate(stable)) return stable;
  try {
    const d = fs.mkdtempSync(path.posix.join(b, 'devbox-')).replace(/\\/g, '/'); // created 0700
    if (dirIsPrivate(d)) return d;
  } catch (e) { /* not writable */ }
  return null;
}

// {monitor, serial} socket paths for `key` (a VM name, or "_bake").
function socketPaths(key) {
  const full = { monitor: path.posix.join(CFG.runDir, key + '.mon'), serial: path.posix.join(CFG.runDir, key + '.ser') };
  if (fitsSun(full.monitor) && fitsSun(full.serial)) return full;
  const h = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 10);
  const shortIn = (dir) => ({ monitor: path.posix.join(dir, h + '.m'), serial: path.posix.join(dir, h + '.s') });
  const inRun = shortIn(CFG.runDir);
  if (fitsSun(inRun.monitor)) return inRun;
  if (privateDirCache && dirIsPrivate(privateDirCache) && fitsSun(shortIn(privateDirCache).monitor)) return shortIn(privateDirCache);
  for (const base of [process.env.XDG_RUNTIME_DIR, '/tmp', os.tmpdir()]) {
    if (!base || !fitsSun(path.posix.join(base, 'devbox-XXXXXXXXXXXXXXXXXX', h + '.m'))) continue;
    const dir = privateSocketDir(base);
    if (dir && fitsSun(shortIn(dir).monitor)) { privateDirCache = dir; return shortIn(dir); }
  }
  throw new Error('no private folder with a short enough path for the QEMU sockets of "' + key + '" (unix socket paths are limited to about 100 bytes) - move the data folder to a shorter path');
}

function removeRuntimeFiles(name, rt) {
  const files = [st.pidFilePath(name)];
  if (rt && rt.monitor && rt.monitor.path) files.push(rt.monitor.path);
  if (rt && rt.serial && rt.serial.path) files.push(rt.serial.path);
  for (const f of files) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
}

function closeVmSessions(name) {
  // lazy: sessions.js depends on this module
  try { require('./sessions').closeVmSessions(name); } catch (e) { /* no sessions module loaded */ }
}

// QEMU is gone (stopped, crashed, never came up): forget its runtime. Its
// shared folders' 9P connections are closed and the shares unregistered -
// the Linux 9p transport never reconnects, so a dead boot's mounts must not
// linger, and the next start registers them afresh (lib/shares.js).
function clearRuntime(name, vm) {
  const rt = vm.runtime;
  vm.runtime = null;
  if (rt && rt.pid && identity.get(rt.pid) === name) identity.delete(rt.pid);
  children.delete(name);
  probeCache.delete(name);
  removeRuntimeFiles(name, rt);
  closeVmSessions(name);
  shares.disconnect(name);
  shares.unregister(name);
  st.saveState();
}

// Last lines of QEMU's own output and of the serial console: what the user
// needs to see when a VM failed to boot.
function diagnostics(name) {
  const q = tailFile(st.qemuLogPath(name), { lines: 15 });
  const s = tailFile(st.serialLogPath(name), { lines: 30 });
  const parts = [];
  if (q.text.trim()) parts.push('QEMU said:\n' + q.text.trim());
  if (s.text.trim()) parts.push('Serial console (last lines):\n' + s.text.trim());
  return parts.join('\n');
}

// The process of a VM is gone and no task owns the VM: record why.
function noteExit(name, vm) {
  const c = children.get(name);
  const rt = vm.runtime;
  let msg = null;
  if (c && c.exited) {
    const early = rt && rt.startedAt && Date.now() - Date.parse(rt.startedAt) < 30000;
    if (c.spawnError) msg = 'QEMU could not start: ' + errMsg(c.spawnError);
    else if (c.code !== 0 || early) {
      msg = 'QEMU exited unexpectedly' + (c.code !== null && c.code !== undefined ? ' (exit code ' + c.code + ')' : (c.signal ? ' (' + c.signal + ')' : ''));
    }
  }
  if (msg) {
    vm.lastError = { at: nowIso(), message: msg, detail: diagnostics(name) };
    log('VM "' + name + '": ' + msg);
  }
  clearRuntime(name, vm);
}

// running vs booting for status polls: a real sshd banner. A slow guest (TCG
// emulation, a busy PC) can take seconds to send it - found on a real run:
// banners took 0.4-3.5 s under TCG, and with a 0.9 s probe a running VM kept
// flipping to "booting" in most polls, which made Claude's tools refuse to
// run commands in it. So a probe may take up to PROBE_TIMEOUT_MS, a poll waits
// for it at most PROBE_WAIT_MS and otherwise answers from the last result
// (the probe finishes in the background for the next poll), and a VM seen
// running stays "running" until two probes in a row have failed.
const PROBE_TIMEOUT_MS = 5000;
const PROBE_WAIT_MS = 1000;
const PROBE_FRESH_MS = 5000;
function newProbe(pid, ok) { return { pid: pid, ok: !!ok, at: ok ? Date.now() : 0, fails: 0, inflight: null }; }
function sshUp(name, vm) {
  const pid = vm.runtime.pid;
  let c = probeCache.get(name);
  if (!c || c.pid !== pid) { c = newProbe(pid, false); probeCache.set(name, c); }
  if (c.ok && Date.now() - c.at < PROBE_FRESH_MS) return Promise.resolve(true);
  if (!c.inflight) {
    c.inflight = probeSsh(vm.port, PROBE_TIMEOUT_MS).then((ok) => {
      c.inflight = null;
      c.at = Date.now();
      if (ok) { c.ok = true; c.fails = 0; }
      else if (c.ok && c.fails === 0) c.fails = 1; // one miss: still running
      else { c.ok = false; c.fails++; }
      return c.ok;
    });
  }
  return Promise.race([c.inflight, sleep(PROBE_WAIT_MS).then(() => c.ok)]);
}

// Is SSH up on a running VM, by the same cached, tolerant check as the status
// poll (one slow banner under TCG does not count as "down"), else one direct
// probe of up to 5 s. For readers such as the Docker tab (UI-8).
async function sshReady(name) {
  const vm = state.vms[name];
  if (!vm) return false;
  if (vm.runtime && (await sshUp(name, vm))) return true;
  return probeSsh(vm.port, PROBE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// status (GET /api/state)
// ---------------------------------------------------------------------------
function publicVm(name, vm) {
  const rt = vm.runtime;
  return {
    name: name,
    status: 'stopped',
    port: vm.port,
    sshLan: !!vm.sshLan,
    sshCommand: ssh.sshCommandText(vm.port),
    mem: vm.mem,
    cpus: vm.cpus,
    accel: vm.accel,
    effectiveAccel: rt ? rt.accel : null,
    template: vm.template,
    ports: (vm.ports || []).map((p) => Object.assign({}, p)),
    autostart: !!vm.autostart,
    note: vm.note || '',
    ephemeral: !!vm.ephemeral,
    createdBy: vm.createdBy,
    createdAt: vm.createdAt,
    startedAt: rt ? rt.startedAt : null,
    pid: rt ? rt.pid : null,
    diskBytes: null,
    virtualSizeBytes: null,
    pendingRestart: !!vm.pendingRestart,
    pendingFsResize: !!vm.pendingFsResize,
    personalized: !!vm.personalized,
    hostname: guestHostname(name),
    snapshots: [],
    busy: tasks.vmBusy(name),
    lastError: vm.lastError || null,
    hasLog: exists(st.serialLogPath(name)),
    mac: macForPort(vm.port),
    liveForwarding: !!(rt && rt.monitor && !rt.legacy),
    serialConsole: !!(rt && rt.serial && !rt.legacy),
    // started by v1: its monitor (127.0.0.1:25000+) is reachable from every
    // VM and its forwards from the LAN until it is restarted (security-9)
    legacy: !!(rt && rt.legacy),
    // live shared folders - never their secrets
    shares: (vm.shares || []).map(shares.publicShare),
    // 'alpine' (SSH sandbox) or 'appliance' (any OS image with a screen)
    kind: vm.kind || 'alpine',
    appliance: appliance.describe(vm),
    // the screen relay can be opened (GET /api/vm/screen, an upgrade to WebSocket)
    screen: !!(rt && rt.display && !rt.legacy),
  };
}

// The warning /api/state shows while VMs started by v1 are still running.
function legacyWarning() {
  const names = Object.keys(state.vms).filter((n) => state.vms[n].runtime && state.vms[n].runtime.legacy);
  if (!names.length) return null;
  return (names.length === 1 ? 'the VM "' + names[0] + '" was' : 'the VMs ' + names.map((n) => '"' + n + '"').join(', ') + ' were') +
    ' started by the old version 1 of the manager: its QEMU monitor (which can run programs on this PC) is reachable from every VM, and its ports from the network - restart ' +
    (names.length === 1 ? 'it' : 'them') + ' now (Stop, then Start)';
}

async function describeVm(name) {
  const vm = state.vms[name];
  if (!vm) return null;
  let diskBytes = null, missing = false;
  try { diskBytes = fs.statSync(st.diskPath(name)).size; } catch (e) { missing = e.code === 'ENOENT'; }
  const busy = tasks.holder('vm:' + name);
  const stopping = !!(busy && STOP_KINDS.test(busy.kind));
  const starting = !!(busy && START_KINDS.test(busy.kind));
  let status;
  const alive = !!(vm.runtime && (await vmAlive(name, vm)));
  if (alive) {
    // an appliance has no SSH: it runs as soon as its screen answers
    status = stopping ? 'stopping' : ((isAppliance(vm) ? await displayUp(vm) : await sshUp(name, vm)) ? 'running' : 'booting');
  } else {
    // gone: unless a task owns the VM (it records the outcome itself)
    if (vm.runtime && !busy) noteExit(name, vm);
    if (missing) status = 'missing';
    else if (stopping) status = 'stopping';
    else if (starting) status = 'booting';
    else status = vm.lastError ? 'error' : 'stopped';
  }
  const out = publicVm(name, vm);
  out.status = status;
  out.diskBytes = diskBytes;
  if (!missing) {
    // while a task works on the VM, show the cached values but start no new
    // qemu-img read: the task may be about to delete or replace the disk
    const info = busy ? (infoCache.get(name) || null) : cachedInfo(name, alive);
    if (info) { out.virtualSizeBytes = info.virtualSize; out.snapshots = (info.snapshots || []).map((s) => Object.assign({}, s)); }
  }
  return out;
}

let listInflight = null;
// All VMs for the GUI/API, sorted by name. Concurrent callers share one run.
function listVms() {
  if (!listInflight) listInflight = computeList().finally(() => { listInflight = null; });
  return listInflight;
}
async function computeList() {
  if (st.syncDisks().length) fillUnknownTemplates().catch(() => {});
  // liveness per VM without a process listing in the normal case (vmAlive)
  const names = Object.keys(state.vms).sort((a, b) => a.localeCompare(b));
  const out = await Promise.all(names.map((n) => describeVm(n)));
  st.saveState();
  return out.filter(Boolean);
}
async function getVmPublic(name) { return describeVm(name); }

function hostState() {
  const d = platform.diskFree(CFG.root);
  const memTotal = os.totalmem(), memFree = os.freemem();
  return {
    // CFG.maxCpus is os.cpus().length, read once: os.cpus() costs 15-400 ms per call
    // on a many-core Windows PC, and this runs on every poll
    hostname: os.hostname(), platform: process.platform, arch: process.arch, cpus: CFG.maxCpus,
    memTotal: memTotal, memFree: memFree, memUsed: memTotal - memFree,
    diskTotal: d.total, diskFree: d.free, diskUsed: d.total !== null && d.free !== null ? d.total - d.free : null,
    diskPath: d.path, diskError: d.error || null, dataRoot: CFG.root,
  };
}

// ---------------------------------------------------------------------------
// templates (base images)
// ---------------------------------------------------------------------------
function templateFile(name) {
  return name === 'devbox-base' ? CFG.base : path.posix.join(CFG.basesDir, name + '.qcow2');
}
function findTemplate(name) {
  if (!name || (name !== 'devbox-base' && !isVmName(name))) return null;
  const f = templateFile(name);
  return exists(f) ? f : null;
}
// usedBy counts VMs by template NAME (clones and VMs made from it).
function listTemplates() {
  const usedBy = {};
  for (const vm of Object.values(state.vms)) if (vm.template) usedBy[vm.template] = (usedBy[vm.template] || 0) + 1;
  const out = [];
  if (exists(CFG.base)) out.push({ name: 'devbox-base', file: CFG.base, size: sizeOf(CFG.base), isDefault: true, usedBy: usedBy['devbox-base'] || 0 });
  try {
    for (const f of fs.readdirSync(CFG.basesDir).sort()) {
      if (!/\.qcow2$/i.test(f)) continue;
      const n = f.replace(/\.qcow2$/i, '');
      if (n.toLowerCase() === 'devbox-base' || !isVmName(n)) continue;
      const p = path.posix.join(CFG.basesDir, f);
      out.push({ name: n, file: p, size: sizeOf(p), isDefault: false, usedBy: usedBy[n] || 0 });
    }
  } catch (e) { /* no vm-bases folder yet */ }
  return out;
}
const listBases = listTemplates;
const findBase = (name) => findTemplate(name || 'devbox-base');

// Records created for disks found on disk have template null: read the
// backing file to fill it in, so template usage counts stay right (OPS-7).
async function fillUnknownTemplates() {
  const qi = platform.findTool('qemu-img');
  if (!qi) return;
  let changed = false;
  for (const name of Object.keys(state.vms)) {
    const vm = state.vms[name];
    if (vm.template !== null || !exists(st.diskPath(name))) continue;
    const i = await diskInfo(st.diskPath(name));
    if (!i.ok) continue;
    if (state.vms[name]) { state.vms[name].template = i.backing ? (st.templateNameFromBase(i.backing) || '') : ''; changed = true; }
  }
  if (changed) st.saveState();
}

// The backing file of a VM's disk (its template), relative to the sandboxes
// folder so the data root can move between machines. null = standalone disk.
async function backingOf(name) {
  const i = await diskInfo(st.diskPath(name));
  if (!i.ok) throw new Error('cannot read the disk of "' + name + '": ' + i.error);
  if (!i.backing) return { info: i, rel: null, full: null };
  const full = i.backingFull || path.resolve(CFG.sandboxDir, i.backing);
  const rel = path.isAbsolute(i.backing) ? path.relative(CFG.sandboxDir, full).replace(/\\/g, '/') : i.backing;
  return { info: i, rel: rel, full: full };
}

function templateMissingMessage(name, vm, full) {
  const t = vm.template || st.templateNameFromBase(full) || 'its template';
  return 'template "' + t + '" is missing (' + full + ') - "' + name + '" is a thin clone of it and cannot be used without it';
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
async function validateCreate(body) {
  body = body || {};
  const name = requireVmName(body.name);
  if (state.vms[name] || exists(st.diskPath(name))) throw conflict('a VM called "' + name + '" already exists', 'EXISTS');
  tasks.assertFree('vm:' + name);
  const template = body.template === undefined || body.template === null || body.template === '' ? 'devbox-base' : body.template;
  if (template !== 'devbox-base') requireVmName(template, 'template');
  const tf = findTemplate(template);
  if (!tf) {
    if (template === 'devbox-base') throw conflict('the base image is not built yet - run the one-click setup (or build the base image) first', 'NO_BASE');
    throw notFound('no template called "' + template + '"');
  }
  tasks.assertFree('template:' + template);
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  const mem = intInRange(body.mem, CFG.minMem, CFG.maxMem, Math.min(CFG.defaultMem, CFG.maxMem), 'Memory (MB)');
  const cpus = intInRange(body.cpus, 1, CFG.maxCpus, Math.min(CFG.defaultCpus, CFG.maxCpus), 'vCPUs');
  const accel = body.accel === undefined || body.accel === null || body.accel === '' ? 'auto' : body.accel;
  if (st.ACCELS.indexOf(accel) === -1) throw badRequest('accel must be one of ' + st.ACCELS.join(', '));
  let port = null;
  if (body.port !== undefined && body.port !== null && body.port !== '') port = intInRange(body.port, 1024, 65535, null, 'SSH port');
  const mappings = ports.parsePortSpec(body.ports === undefined ? [] : body.ports, { sshPort: port || undefined });
  const start = toBool(body.start, false);
  if (start) tasks.assertFree('qemu');
  const a = {
    name: name, template: template, templateFile: tf, mem: mem, cpus: cpus, accel: accel, port: port,
    ports: mappings, sshLan: toBool(body.sshLan, false),
    start: start, waitS: intInRange(body.waitS, 0, 1800, null, 'waitS'),
    ephemeral: toBool(body.ephemeral, false), autostart: toBool(body.autostart, false),
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
    createdBy: typeof body.createdBy === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(body.createdBy) ? body.createdBy : 'api',
  };
  // Every port checked here is CLAIMED for the new VM in the same breath (no
  // await in between), so a concurrent create cannot take it too, and
  // opCreate's automatic SSH port cannot land on one of the VM's own
  // forwards (BUG-20). opCreate releases the claims once the record holds
  // the ports; a request that fails here releases them at once.
  const held = [];
  try {
    if (port) {
      const why = ports.reservedPorts({ exceptVm: name }).get(port);
      if (why) throw new ports.PortConflict('port ' + port + ' is already used by ' + why);
      ports.claim(port, 300000, name);
      held.push(port);
      if (!(await platform.isPortFree(port))) throw new ports.PortConflict('port ' + port + ' is in use by another program');
    }
    await ports.validateMappings(name, mappings, { sshPort: port || undefined, claim: mappings.map((m) => m.host), claimMs: 300000 });
  } catch (e) {
    for (const p of held) ports.release(p, name);
    throw e;
  }
  a.claimed = held.concat(mappings.map((m) => m.host)); // (http.js releases them if the task cannot start)
  return a;
}

// qemu-img create of a thin clone with a RELATIVE backing path: the data
// folder can be moved or copied to another machine and the clones still find
// their template. sizeBytes (optional) makes the overlay bigger than its base.
async function createOverlay(disk, templatePath, sizeBytes) {
  const qi = platform.findTool('qemu-img');
  if (!qi) throw new Error('qemu-img was not found - ' + platform.installHints().qemu);
  const backing = path.relative(path.dirname(disk), templatePath).replace(/\\/g, '/');
  const args = ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', backing, disk];
  if (sizeBytes) args.push(String(sizeBytes));
  const r = await run(qi, args);
  if (r.code !== 0) throw new Error('qemu-img create failed: ' + lastLine(r));
}

async function opCreate(t, a) {
  if (!platform.findTool('qemu-img')) throw new Error('qemu-img was not found - ' + platform.installHints().qemu);
  if (state.vms[a.name] || exists(st.diskPath(a.name))) throw new Error('a VM called "' + a.name + '" already exists');
  const tf = findTemplate(a.template);
  if (!tf) throw new Error('template "' + a.template + '" is missing');
  t.step('Creating "' + a.name + '" from the template ' + a.template + '...');
  // hold the VM's own forwards (and a chosen SSH port) until the record owns
  // them: the automatic SSH port must not be one of them (BUG-20)
  const held = (a.ports || []).map((m) => m.host).concat(a.port ? [a.port] : []);
  for (const p of held) ports.claim(p, 300000, a.name);
  let port = null;
  try {
    port = a.port || await ports.allocSshPort();
    fs.mkdirSync(CFG.sandboxDir, { recursive: true });
    await createOverlay(st.diskPath(a.name), tf);
    state.vms[a.name] = st.newVmRecord({
      port: port, mem: a.mem, cpus: a.cpus, accel: a.accel, template: a.template, ports: a.ports,
      sshLan: a.sshLan, ephemeral: a.ephemeral, autostart: a.autostart, note: a.note, createdBy: a.createdBy,
    });
    infoCache.delete(a.name);
    ssh.forgetHostKey(a.name); // a VM of the same name may have existed before
    st.saveState();
  } finally {
    if (port && port !== a.port) ports.release(port);
    for (const p of held) ports.release(p, a.name);
  }
  t.log('Created "' + a.name + '": SSH port ' + port + ', ' + a.mem + ' MB, ' + a.cpus + ' vCPU, ' +
    fmtBytes(sizeOf(st.diskPath(a.name))) + ' on disk' +
    (a.ports.length ? '; forwards ' + a.ports.map(ports.describe).join(', ') : ''));
  const result = { name: a.name, port: port, template: a.template, ssh: ssh.sshCommandText(port) };
  if (a.start) Object.assign(result, await opStart(t, { name: a.name, waitS: a.waitS }));
  return result;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function validateStart(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  tasks.assertFree('qemu');
  if (await isRunning(name)) throw conflict('"' + name + '" is already running', 'RUNNING');
  if (!exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" is missing - remove the record or restore the file', 'MISSING');
  if (!platform.findTool('qemu')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  const i = await diskInfo(st.diskPath(name));
  if (i.ok && i.backing) {
    const full = i.backingFull || path.resolve(CFG.sandboxDir, i.backing);
    if (!exists(full)) throw conflict(templateMissingMessage(name, state.vms[name], full), 'TEMPLATE_MISSING');
  }
  return { name: name, waitS: intInRange(body.waitS, 0, 1800, null, 'waitS') };
}

// The default wait for SSH: 240 s with hardware acceleration (a clone boots in
// ~15 s under WHPX). TCG emulation is several times slower - 109 s measured on
// an idle PC, over 240 s on a busy one - so it gets 600 s.
function bootWaitS(accel) { return accel === 'tcg' ? 600 : 240; }

// Accel choice: per-VM > global setting > detected recommendation.
async function chooseAccel(vm) {
  if (vm.accel && vm.accel !== 'auto') return vm.accel;
  const g = state.settings && state.settings.accel;
  if (g && g !== 'auto') return g;
  const d = await platform.detectAccel();
  return d.recommended || 'tcg';
}

// A fresh private monitor + serial endpoint for one start: Windows a random
// 127.x.y.z (throws when none can be bound, platform.internalHost), else unix
// sockets (socketPaths). QEMU creates the socket files itself.
async function runtimeEndpoints(name, withDisplay) {
  const host = await platform.internalHost();
  if (host) {
    const mon = await platform.freeLocalPort(host);
    let ser = await platform.freeLocalPort(host);
    if (ser === mon) ser = await platform.freeLocalPort(host);
    const out = { monitor: { host: host, port: mon }, serial: { host: host, port: ser } };
    if (withDisplay) out.display = { host: host, port: await freeDisplayPort(host, [mon, ser]) };
    return out;
  }
  const p = socketPaths(name);
  fs.mkdirSync(path.posix.dirname(p.monitor), { recursive: true, mode: 0o700 });
  for (const f of [p.monitor, p.serial]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  const out = { monitor: { path: p.monitor }, serial: { path: p.serial } };
  // QEMU's VNC server is TCP only (no unix socket on every build): a private
  // port on 127.0.0.1 is what the screen relay connects to
  if (withDisplay) out.display = { host: '127.0.0.1', port: await freeDisplayPort('127.0.0.1', []) };
  return out;
}

// A free port for QEMU's VNC server on `host`: QEMU takes a display NUMBER
// (port 5900 + N, N >= 0), so the port is picked from 5900..6899 at random
// and checked by binding it exclusively, like freeLocalPort does for port 0.
async function freeDisplayPort(host, avoid) {
  const net = require('net');
  const tryBind = (port) => new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port: port, host: host, exclusive: true }, () => s.close(() => resolve(true)));
  });
  for (let i = 0; i < 60; i++) {
    const port = 5900 + crypto.randomInt(0, 1000);
    if (avoid.indexOf(port) !== -1) continue;
    if (await tryBind(port)) return port;
  }
  throw new Error('no free port for the VM screen (VNC) on ' + host + ' between 5900 and 6899');
}

// extra: {cpuModel, extraArgs} (see qemuArgs)
function spawnQemu(name, vm, accel, machine, ep, extra) {
  extra = extra || {};
  const qemu = platform.findTool('qemu');
  fs.mkdirSync(CFG.runDir, { recursive: true });
  fs.mkdirSync(CFG.logsDir, { recursive: true });
  const pidFile = st.pidFilePath(name);
  try { fs.rmSync(pidFile, { force: true }); } catch (e) {}
  let drives = null, extraArgs = extra.extraArgs || [];
  if (isAppliance(vm)) {
    const ap = appliance.qemuArgs(vm, {
      disk: st.diskPath(name), media: exists(st.mediaPath(name)) ? st.mediaPath(name) : null,
      firmware: appliance.firmwareFiles(), vars: st.varsPath(name), display: ep.display,
      sound: appliance.hostAudioBackend(),
    });
    drives = ap.drives;
    extraArgs = extraArgs.concat(ap.extra);
  }
  const args = qemuArgs({
    name: name, disk: st.diskPath(name), drives: drives, mem: vm.mem, cpus: vm.cpus, accel: accel, cpuModel: extra.cpuModel, machine: machine,
    netdev: netdevFor(vm), mac: macForPort(vm.port), monitor: ep.monitor, serial: ep.serial,
    serialLog: st.serialLogPath(name), pidFile: pidFile, extraArgs: extraArgs,
  });
  const rec = { child: null, pid: null, startedAt: Date.now(), exited: false, code: null, signal: null, spawnError: null, accel: accel };
  const fd = fs.openSync(st.qemuLogPath(name), 'w');
  try {
    rec.child = spawn(qemu, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  } catch (e) {
    rec.exited = true;
    rec.spawnError = e;
    return rec;
  } finally { fs.closeSync(fd); }
  rec.pid = rec.child.pid || null;
  rec.child.on('error', (e) => { rec.exited = true; rec.spawnError = e; });
  rec.child.on('exit', (code, signal) => { rec.exited = true; rec.code = code; rec.signal = signal; });
  rec.child.unref();
  children.set(name, rec);
  return rec;
}

// An appliance is "up" when QEMU's VNC server answers on the display
// endpoint (the guest itself has no SSH and may never have a network).
function displayUp(vm) {
  const d = vm.runtime && vm.runtime.display;
  return d ? portListening(d.port, 1500, d.host) : Promise.resolve(false);
}

async function waitForBoot(t, name, vm, rec, waitS) {
  if (rec.spawnError || !rec.pid) return 'died';
  if (!waitS) return rec.exited ? 'died' : 'nowait';
  const t0 = Date.now();
  let lastNote = t0;
  while (Date.now() - t0 < waitS * 1000) {
    if (rec.exited) return 'died';
    if (forceRequested.has(name)) return 'aborted';
    if (isAppliance(vm) ? await displayUp(vm) : await probeSsh(vm.port, 4000)) return 'up';
    // a panicked kernel never comes up (panic=0: it just hangs); the serial
    // log is started afresh with each QEMU (logappend=off)
    if (KERNEL_PANIC_RE.test(tailFile(st.serialLogPath(name), { lines: 120, maxBytes: 16384 }).text)) return 'panic';
    if (Date.now() - lastNote >= 15000) {
      lastNote = Date.now();
      const last = tailFile(st.serialLogPath(name), { lines: 1, maxBytes: 4096 }).text.trim();
      t.log('still booting... ' + Math.round((lastNote - t0) / 1000) + ' s' + (last ? ' - console: ' + last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 120) : ''));
    }
    await sleep(1500);
  }
  return rec.exited ? 'died' : 'timeout';
}

const KERNEL_PANIC_RE = /Kernel panic - not syncing/;
// QEMU could not bind a socket chardev (monitor/serial): its own words on
// Windows and POSIX (microVM spec item J(e))
const CONTROL_BIND_RE = /Failed to find an available port|Failed to bind socket|Address already in use|Only one usage of each socket address/i;

// End a QEMU this start spawned (it is ours: Node holds its process handle,
// so no process listing is needed): quit through its monitor, else end it.
async function endOwnQemu(name, vm, rec) {
  if (vm.runtime && vm.runtime.monitor && !rec.exited) await monitor.quit(vm.runtime.monitor);
  if (rec.pid && !(await waitGone(rec.pid, 5000))) {
    try { rec.child.kill(); } catch (e) { /* already gone */ }
    await waitGone(rec.pid, 5000);
  }
  if (vm.runtime) clearRuntime(name, vm);
}

// A just-stopped QEMU can hold its listening socket for a moment after the
// process ended, so give a busy port a few seconds before calling it taken.
async function waitPortFree(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 10000)) {
    if (await platform.isPortFree(port)) return true;
    await sleep(700);
  }
  return platform.isPortFree(port);
}

function startResult(name, vm) {
  if (isAppliance(vm)) return { name: name, kind: 'appliance', screen: !!(vm.runtime && vm.runtime.display), accel: vm.runtime ? vm.runtime.accel : null };
  return { name: name, port: vm.port, ssh: ssh.sshCommandText(vm.port), accel: vm.runtime ? vm.runtime.accel : null };
}

// Record which accelerator QEMU actually uses (it falls back silently).
function noteEffectiveAccel(t, vm, requested, name) {
  if (!vm.runtime) return;
  const eff = effectiveAccel(requested, tailFile(st.qemuLogPath(name), { lines: 40 }).text);
  if (eff !== vm.runtime.accel) { vm.runtime.accel = eff; st.saveState(); }
  if (eff === 'tcg') t.log('Acceleration: TCG (software emulation - works everywhere, but slower)' + (requested !== 'tcg' ? '; ' + requested + ' was not usable' : ''));
  else t.log('Acceleration: ' + eff.toUpperCase() + ' (hardware)');
}

// The guest has just switched to its own host keys: forget the template's key
// and pin the new one now (accept-new), while the start task still runs, so
// the first command after the start (GUI terminal, Claude's exec) connects
// cleanly. sshd re-executes itself on SIGHUP: give it a moment to listen.
async function pinNewHostKey(t, name, vm) {
  ssh.forgetHostKey(name);
  for (let i = 0; i < 20; i++) {
    if (await probeSsh(vm.port, 3000)) {
      const r = await ssh.sshExec({ name: name, port: vm.port }, 'true', { timeoutMs: 20000 });
      if (r.ok) return true;
    }
    await sleep(500);
  }
  t.warn('the guest has new SSH host keys, but SSH did not answer again yet - the key is pinned on the next connection');
  return false;
}

// First boot of a clone: name the guest after the VM, give it the host's time
// zone and its own SSH host keys. Never fails the start: it is retried on the
// next start.
async function personalize(t, name, vm) {
  const host = guestHostname(name);
  const tz = validTimezone(platform.hostTimezone());
  t.step('First boot: naming the guest "' + host + '"' + (tz ? ' and setting its time zone to ' + tz : '') + '...');
  // (new host keys: an RSA key takes a few seconds under TCG emulation)
  const r = await ssh.sshExec({ name: name, port: vm.port }, 'sh -s', { input: personalizeScript(host, tz), timeoutMs: 120000 });
  const out = (r.stdout + '\n' + r.stderr).trim();
  if (r.ok) {
    vm.personalized = true;
    st.saveState();
    if (out) t.log(out);
    if (/ssh host keys: new/.test(r.stdout)) await pinNewHostKey(t, name, vm);
    return true;
  }
  t.warn('could not personalise the guest (exit ' + r.code + '): ' + lastLine(r) + ' - it is tried again on the next start');
  return false;
}

async function opStart(t, a) {
  const name = a.name;
  const vm = st.getVm(name);
  if (await isRunning(name)) { t.log('"' + name + '" is already running'); return startResult(name, vm); }
  if (!exists(st.diskPath(name))) throw new Error('the disk of "' + name + '" is missing (' + st.diskPath(name) + ')');
  if (!platform.findTool('qemu')) throw new Error('QEMU is not installed - ' + platform.installHints().qemu);
  // a thin clone cannot start without its template (the backing file)
  const info = await diskInfo(st.diskPath(name));
  if (info.ok && info.backing) {
    const full = info.backingFull || path.resolve(CFG.sandboxDir, info.backing);
    if (!exists(full)) throw new Error(templateMissingMessage(name, vm, full));
  } else if (!info.ok && vm.template && !findTemplate(vm.template)) {
    throw new Error(templateMissingMessage(name, vm, templateFile(vm.template)));
  }
  t.step('Checking the host ports of "' + name + '"...');
  const binds = (isAppliance(vm) ? [] : [{ host: vm.port, what: 'SSH' }]).concat((vm.ports || []).map((p) => ({ host: p.host, what: 'forward ' + p.host + ' -> ' + p.guest })));
  for (const b of binds) {
    if (!(await waitPortFree(b.host, 8000))) {
      throw new Error('host port ' + b.host + ' (' + b.what + ') is in use by another program - free it or change it in the VM settings');
    }
  }
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < vm.mem + 256) t.warn('only ' + freeMB + ' MB of memory is free on this PC but this VM wants ' + vm.mem + ' MB - it may be slow or fail to boot');

  let accel = await chooseAccel(vm);
  // how long to wait for SSH unless the caller chose (waitS null/undefined)
  const autoWait = a.waitS === undefined || a.waitS === null;
  let waitS = autoWait ? bootWaitS(accel) : a.waitS;
  let machine; // undefined = MACHINE (q35), null = QEMU's default
  let retriedAccel = false, retriedMachine = false, retriedPanic = false, retriedPorts = 0;
  vm.lastError = null;
  const cancelled = () => new Error('the start of "' + name + '" was cancelled: a force stop was requested');
  // live shared folders: registered with the manager's 9P server; the guest
  // reads the list from fw_cfg at every boot (lib/shares.js). Nothing at
  // all happens for a VM without shares.
  const sh = await shares.registerFor('vm', name, vm.shares || []);
  for (const w of sh.warnings) t.warn(w);
  if (sh.args.length) t.log('Shared folders: ' + (vm.shares || []).length + ' (9P server on 127.0.0.1:' + sh.port + ')');
  try {
    for (;;) {
      // a force stop that came in while this task stopped the VM (restart,
      // reset) or before a retry: do not boot a QEMU only to kill it again
      if (forceRequested.has(name)) throw cancelled();
      const ep = await runtimeEndpoints(name, isAppliance(vm));
      const cpuModel = accel === 'whpx' ? await whpxCpuModel() : null;
      t.step('Starting QEMU for "' + name + '" (' + accel + ', ' + vm.mem + ' MB, ' + vm.cpus + ' vCPU)...');
      const rec = spawnQemu(name, vm, accel, machine, ep, { cpuModel: cpuModel, extraArgs: sh.args });
      await sleep(400);
      if (!rec.spawnError && rec.pid) {
        vm.runtime = { pid: rec.pid, startedAt: nowIso(), accel: accel, monitor: ep.monitor, serial: ep.serial };
        if (ep.display) vm.runtime.display = ep.display;
        vm.pendingRestart = false;
        st.saveState();
        t.log('QEMU pid ' + rec.pid + '; waiting for ' + (isAppliance(vm) ? 'the screen' : 'SSH') + (waitS ? ' (up to ' + waitS + ' s)' : '') + '...');
      }
      const outcome = await waitForBoot(t, name, vm, rec, waitS);
      if (outcome === 'up') break;
      if (outcome === 'aborted') throw cancelled();
      if (outcome === 'nowait') {
        await sleep(1100);
        noteEffectiveAccel(t, vm, accel, name);
        t.log('Not waiting for ' + (isAppliance(vm) ? 'the screen' : 'SSH') + '; the VM keeps booting.');
        return startResult(name, vm);
      }
      if (outcome === 'panic') {
        // Seen on a real run with the PC's CPU at 100%: the kernel's early
        // "IO-APIC + timer" check timed out and it panicked, and the start then
        // waited its full timeout for a guest that could never come up. Bases
        // baked now boot with no_timer_check; for any other panic, stop at once
        // and try exactly once more (a timing problem passes, a broken disk not).
        const diag = diagnostics(name);
        await endOwnQemu(name, vm, rec);
        if (!retriedPanic) {
          retriedPanic = true;
          t.log('The guest kernel panicked while booting' + (diag ? ':\n' + diag : '') + '\nStarting it once more...');
          continue;
        }
        vm.lastError = { at: nowIso(), message: 'the guest kernel panicked while booting (twice)', detail: diag };
        st.saveState();
        throw new Error(vm.lastError.message + ' - see its serial console output below' + (diag ? '\n' + diag : ''));
      }
      if (outcome === 'died') {
        const early = Date.now() - rec.startedAt < 20000;
        const diag = diagnostics(name);
        if (vm.runtime) clearRuntime(name, vm);
        // what QEMU said, minus WHPX's "accelerator is operational" success line
        const said = tailFile(st.qemuLogPath(name), { lines: 15 }).text
          .split('\n').filter((l) => !/accelerator is operational/i.test(l)).join('\n');
        // a private monitor/serial port was taken between choosing it and
        // QEMU's bind (another start, another program): fresh endpoints
        if (early && !rec.spawnError && retriedPorts < 2 && CONTROL_BIND_RE.test(said) && !/host forwarding/i.test(said)) {
          retriedPorts++;
          t.log('A private QEMU control port was taken meanwhile - retrying with new ones...');
          continue;
        }
        // retry without hardware acceleration only when it may be the cause
        // (QEMU said nothing, or named the accelerator) - not for a bad disk
        const accelSuspect = !said.trim() || /whpx|kvm|hvf|accel|hypervisor|vcpu/i.test(said);
        if (accel !== 'tcg' && early && !retriedAccel && !rec.spawnError && accelSuspect) {
          t.log('QEMU stopped right away with ' + accel + ' acceleration' + (diag ? ':\n' + diag : '') + '\nRetrying once with TCG (software emulation)...');
          accel = 'tcg';
          retriedAccel = true;
          if (autoWait) waitS = bootWaitS(accel);
          continue;
        }
        if (machine !== null && early && !retriedMachine && !rec.spawnError && /machine/i.test(said)) {
          t.log('QEMU does not accept the ' + MACHINE + ' machine type here' + (diag ? ':\n' + diag : '') + '\nRetrying with its default machine type...');
          machine = null;
          retriedMachine = true;
          continue;
        }
        vm.lastError = {
          at: nowIso(),
          message: rec.spawnError ? 'QEMU could not start: ' + errMsg(rec.spawnError) : 'QEMU exited while booting' + (rec.code !== null ? ' (exit code ' + rec.code + ')' : ''),
          detail: diag,
        };
        st.saveState();
        throw new Error(vm.lastError.message + (diag ? '\n' + diag : ''));
      }
      // timeout: QEMU is alive but the guest never answered on SSH
      const diag = diagnostics(name);
      throw new Error((isAppliance(vm) ? 'The screen' : 'SSH') + ' did not come up within ' + waitS + ' s. The VM is still running - open its serial console to see why, or force-stop it.' + (diag ? '\n' + diag : ''));
    }
    // (the runtime can be gone if something cleared it meanwhile - never crash on it)
    if (!vm.runtime) throw new Error('"' + name + '" lost its runtime record while booting - check the VM list and start it again');
    probeCache.set(name, newProbe(vm.runtime.pid, true));
    noteEffectiveAccel(t, vm, accel, name);
    if (isAppliance(vm)) {
      t.log('The screen is up: open the Screen tab of "' + name + '" to watch it boot');
      return startResult(name, vm);
    }
    t.log('SSH is up: ' + ssh.sshCommandText(vm.port));
    if (!vm.personalized) await personalize(t, name, vm);
    return startResult(name, vm);
  } catch (e) {
    // a start that failed leaves no shares registered (a running VM keeps
    // them: clearRuntime() drops them once its QEMU is gone)
    if (!vm.runtime) shares.unregister(name);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// stop / restart / delete / forget
// ---------------------------------------------------------------------------
async function validateStop(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  const a = { name: name, force: toBool(body.force, false), timeoutS: intInRange(body.timeoutS, 5, 600, null, 'timeoutS') };
  // A force stop must work when the guest hangs (XTR-1), yet the task that
  // holds the VM may be waiting for that very guest: a start waiting for SSH
  // (up to 240 s, 600 s under TCG) or a normal stop waiting for the power-off
  // (up to 45/90 s). Tell it to give up, and wait briefly for it to end;
  // the force stop then runs as its own task.
  if (a.force) {
    const h = tasks.holder('vm:' + name);
    if (h && (START_KINDS.test(h.kind) || h.kind === 'stop')) {
      forceRequested.add(name);
      try { await Promise.race([tasks.wait(h.id), sleep(20000)]); }
      finally { forceRequested.delete(name); }
    }
  }
  return a;
}

// Did an `ssh ... poweroff` that ended with exit 255 end because the guest
// went down (its sshd was killed mid-session: fine), or because ssh never got
// in (key refused, host key mismatch, key file permissions)? OpenSSH exits
// 255 for both; only the first counts as a power-off.
function sshDropped(r) {
  if (!r || r.code !== 255 || r.timedOut) return false;
  if (r.noStderr) return true; // (LogLevel=ERROR hides "closed by remote host")
  return /closed by remote host|broken pipe|connection reset|connection to \S+ closed|connection closed/i.test(r.stderr || '') &&
    !/permission denied|host key|unprotected private key|load key|could not resolve|connection refused/i.test(r.stderr || '');
}

// How long a clean shutdown may take unless the caller chose: 45 s, and 90 s
// under TCG emulation - measured there: a VM with Docker needed 35-40 s to
// power off, too close to 45 s (after the wait QEMU is told to quit).
function stopWaitS(vm) { return vm && vm.runtime && vm.runtime.accel === 'tcg' ? 90 : 45; }

// SSH poweroff -> ACPI power-off via the monitor -> wait -> monitor quit ->
// kill (only a verified QEMU pid). Bounded at every step: never hangs (XTR-1).
async function opStop(t, a) {
  const name = a.name;
  const vm = st.getVm(name);
  const timeoutS = a.timeoutS || stopWaitS(vm);
  const pid = vm.runtime && vm.runtime.pid;
  if (!pid || !(await vmAlive(name, vm))) {
    if (vm.runtime) clearRuntime(name, vm); else closeVmSessions(name);
    t.log('"' + name + '" is not running');
    return { name: name, stopped: true, how: 'not-running' };
  }
  closeVmSessions(name);
  const mon = monitor.monitorFor(vm);
  const forced = () => forceRequested.has(name);
  let how = null;
  if (!a.force) {
    if (!isAppliance(vm) && await probeSsh(vm.port, 3000)) {
      t.step('Asking the guest to power off (over SSH)...');
      const r = await ssh.sshExec({ name: name, port: vm.port }, 'sync; poweroff', { timeoutMs: 15000, connectTimeout: 6 });
      // 255 counts only when the connection DROPPED (the guest went down); an
      // ssh that could not log in falls through to the ACPI power-off
      if (r.ok || sshDropped(r)) how = 'poweroff';
      else t.log('The SSH power-off did not work (' + (r.timedOut ? 'timed out' : 'exit ' + r.code + (r.stderr && !r.noStderr ? ': ' + lastLine({ stderr: r.stderr }) : '')) + ').');
    }
    if (!how && mon && !forced()) {
      t.step('Sending an ACPI power-off through the QEMU monitor...');
      const r = await monitor.systemPowerdown(mon);
      if (r.ok) how = 'acpi';
      else t.log('The monitor did not accept it: ' + r.error);
    }
    if (how) {
      t.log('Waiting up to ' + timeoutS + ' s for the guest to shut down...');
      if (!(await waitGone(pid, timeoutS * 1000, t, 'still shutting down', forced))) {
        t.log(forced() ? 'A force stop was requested - ending QEMU now.' : 'The guest did not power off within ' + timeoutS + ' s.');
      }
    }
  }
  // "quit" goes to this VM's own monitor socket, so it is tried even when
  // the process listing cannot confirm the pid (null): it can only end this
  // VM's QEMU. Only a KILL needs the pid to be confirmed as QEMU.
  if (mon && platform.pidAlive(pid) && (await stillQemu(name, pid)) !== false) {
    t.step((a.force ? 'Force stop' : 'Stopping') + ': telling QEMU to quit...');
    await monitor.quit(mon);
    await waitGone(pid, 5000);
  }
  const still = await stillQemu(name, pid);
  if (still === null) throw new Error('cannot verify that pid ' + pid + ' is QEMU (the process list is unavailable) - not killing it');
  if (still) {
    // Some QEMU has this pid - but is it THIS VM's? A pid recorded before a
    // reboot or crash may belong to another VM's QEMU by now (SEC-8, BUG-6):
    // only a pid this manager spawned, or one the VM's own monitor confirmed,
    // is ever killed.
    const who = await confirmIdentity(name, vm);
    if (who === false) {
      clearRuntime(name, vm);
      t.log('pid ' + pid + ' now belongs to another QEMU, not to "' + name + '" - "' + name + '" was not running; the other process was left alone');
      return { name: name, stopped: true, how: 'not-running' };
    }
    if (who !== true) {
      throw new Error('pid ' + pid + ' is a QEMU process, but its monitor does not answer, so it cannot be confirmed to be "' + name + '" - not killing it. ' +
        'If it is this VM, end qemu-system-x86_64 (pid ' + pid + ') in Task Manager / with kill, then try again.');
    }
    t.step('Ending the QEMU process (pid ' + pid + ')...');
    platform.killPid(pid);
    await waitGone(pid, 8000);
    if (await stillQemu(name, pid)) throw new Error('QEMU (pid ' + pid + ') is still running and could not be stopped');
    if (!how) how = a.force ? 'force' : 'kill';
  }
  clearRuntime(name, vm);
  t.log('"' + name + '" stopped');
  return { name: name, stopped: true, how: how || 'quit' };
}

async function validateRestart(body) {
  const a = await validateStop(body);
  tasks.assertFree('qemu');
  a.waitS = intInRange((body || {}).waitS, 0, 1800, null, 'waitS');
  return a;
}
async function opRestart(t, a) {
  await opStop(t, { name: a.name, force: a.force, timeoutS: a.timeoutS });
  return opStart(t, { name: a.name, waitS: a.waitS });
}

async function validateDelete(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  return { name: name };
}
async function opDelete(t, a) {
  const name = a.name;
  const vm = st.getVm(name);
  if (vm.runtime) await opStop(t, { name: name, force: false });
  t.step('Deleting the files of "' + name + '"...');
  await infoIdle(name);
  for (const f of [st.diskPath(name), st.varsPath(name), st.mediaPath(name), st.serialLogPath(name), st.qemuLogPath(name), st.pidFilePath(name)]) {
    if (exists(f)) { await retryFs('deleting ' + path.basename(f), () => fs.rmSync(f, { force: true })); t.log('Deleted ' + path.basename(f)); }
  }
  ssh.forgetHostKey(name);
  // its shared folders go with the record (the folders on this PC stay)
  shares.unregister(name);
  delete state.vms[name];
  children.delete(name);
  probeCache.delete(name);
  infoCache.delete(name);
  st.saveState();
  t.log('VM "' + name + '" removed');
  return { name: name, deleted: true };
}

// Remove the record of a VM whose disk is gone (status "missing").
async function forgetVm(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  tasks.assertFree('vm:' + name);
  if (exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" still exists - use Delete to remove the VM and its disk');
  if (await isRunning(name)) throw conflict('"' + name + '" is running');
  delete state.vms[name];
  infoCache.delete(name);
  ssh.forgetHostKey(name);
  st.saveState();
  return { name: name, forgotten: true };
}

// ---------------------------------------------------------------------------
// settings and port forwards (quick, not tasks)
// ---------------------------------------------------------------------------
// Always succeeds for note/autostart/ephemeral; mem/cpus/accel/sshLan on a
// running VM are saved and flagged pendingRestart (BUG-9, MNT-4): only real
// changes count, so re-sending the current values never needs a restart.
async function updateSettings(body) {
  body = body || {};
  const name = requireVmName(body.name);
  const vm = lookupVm(name);
  if (body.ports !== undefined) throw badRequest('port forwards are changed with POST /api/vm/ports');
  // Only the values a running task may read (a start reads mem/cpus/accel
  // and the SSH exposure) wait for the VM to be free. A note, autostart or
  // "temporary" can be saved at any time - also during a 10-minute boot
  // under TCG (spec section 9, MNT-4).
  if (['mem', 'cpus', 'accel', 'sshLan'].some((k) => body[k] !== undefined)) tasks.assertFree('vm:' + name);
  const next = {};
  if (body.mem !== undefined) next.mem = intInRange(body.mem, CFG.minMem, CFG.maxMem, vm.mem, 'Memory (MB)');
  if (body.cpus !== undefined) next.cpus = intInRange(body.cpus, 1, CFG.maxCpus, vm.cpus, 'vCPUs');
  if (body.accel !== undefined) {
    if (st.ACCELS.indexOf(body.accel) === -1) throw badRequest('accel must be one of ' + st.ACCELS.join(', '));
    next.accel = body.accel;
  }
  if (body.sshLan !== undefined) next.sshLan = toBool(body.sshLan, vm.sshLan);
  if (body.autostart !== undefined) next.autostart = toBool(body.autostart, vm.autostart);
  if (body.ephemeral !== undefined) next.ephemeral = toBool(body.ephemeral, vm.ephemeral);
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') throw badRequest('note must be text');
    next.note = body.note.slice(0, 500);
  }
  const running = await isRunning(name);
  let restart = false;
  for (const k of Object.keys(next)) {
    if (running && /^(mem|cpus|accel|sshLan)$/.test(k) && next[k] !== vm[k]) restart = true;
    vm[k] = next[k];
  }
  if (restart) vm.pendingRestart = true;
  if (!running) vm.pendingRestart = false;
  st.saveState();
  return { vm: await getVmPublic(name), pendingRestart: !!vm.pendingRestart };
}

// A list of host ports (numbers or numeric strings), for {remove: [...]}.
function hostPortList(v) {
  const items = Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(/[,\s]+/).filter(Boolean);
  return items.map((x) => {
    const s = String(x && typeof x === 'object' ? x.host : x).trim();
    const n = /^\d{1,5}$/.test(s) ? parseInt(s, 10) : NaN;
    if (!ports.validPort(n)) throw badRequest('remove takes host ports (1-65535), got ' + JSON.stringify(x));
    return n;
  });
}
// (protocol too: turning 53/tcp into 53/udp is a close plus an open)
const fwdSame = (x, y) => x.host === y.host && x.guest === y.guest && !!x.lan === !!y.lan && ports.protoOf(x) === ports.protoOf(y);

// Change a VM's app forwards. Two forms:
//   {name, ports}          - the COMPLETE new list (the GUI's editor);
//                            optional base = the list the caller edited: if
//                            the forwards changed meanwhile (a deploy, Claude)
//                            the answer is 409 CHANGED instead of silently
//                            closing what was added
//   {name, add?, remove?}  - single changes applied to the CURRENT list under
//                            the VM lock (forward_port): add replaces a
//                            forward with the same host AND guest port (to
//                            switch its exposure), a different forward on the
//                            same host port is a 409; remove takes host ports
// On a running VM the difference is applied live through the monitor (with
// bind addresses, so the user's local/LAN choice holds). A forward whose host
// port another program holds is refused (409) and the live changes are
// undone: a restart could not bind it either, and the VM could then not
// start at all. Anything else that cannot be applied live is saved and
// flagged pendingRestart. Metadata of unchanged rows is kept (BUG-10, MNT-1).
async function setPorts(body) {
  body = body || {};
  const name = requireVmName(body.name);
  const vm0 = lookupVm(name);
  const hasList = body.ports !== undefined, hasOps = body.add !== undefined || body.remove !== undefined;
  if (!hasList && !hasOps) throw badRequest('ports is required: an array like [{host: 8080, guest: 80, lan: false}] or text like "8080:80, lan:3000" - or add/remove to change single forwards');
  if (hasList && hasOps) throw badRequest('send either ports (the complete list) or add/remove, not both');
  // parse first: bad input is a 400 before anything is locked
  const list = hasList ? ports.parsePortSpec(body.ports, { sshPort: vm0.port }) : null;
  const base = body.base !== undefined && body.base !== null ? ports.parsePortSpec(body.base, {}) : null;
  const add = body.add !== undefined ? ports.parsePortSpec(body.add, { sshPort: vm0.port }) : [];
  const remove = body.remove !== undefined ? hostPortList(body.remove) : [];
  return tasks.runAndWait({ kind: 'ports', title: 'Change port forwards of ' + name, vm: name, locks: ['vm:' + name] }, async (t) => {
    const vm = st.getVm(name);
    const cur = vm.ports || [];
    const warnings = [];
    let merged;
    if (list) {
      if (base && (base.length !== cur.length || base.some((b) => !cur.some((o) => fwdSame(o, b))))) {
        throw conflict('the port forwards of "' + name + '" changed since you loaded them (now: ' + (cur.map(ports.describe).join(', ') || 'none') + ') - reload and make your change again', 'CHANGED');
      }
      merged = ports.mergeMappings(cur, list);
    } else {
      for (const m of add) {
        const o = cur.find((x) => x.host === m.host);
        if (o && o.guest !== m.guest) throw new ports.PortConflict('host port ' + m.host + ' already forwards to guest port ' + o.guest + ' of "' + name + '" - remove that forward first, or pick another host port');
      }
      for (const h of remove) if (!cur.some((o) => o.host === h)) warnings.push('there was no forward on host port ' + h);
      const drop = new Set(remove.concat(add.map((m) => m.host)));
      merged = cur.filter((o) => !drop.has(o.host)).map((o) => Object.assign({}, o)).concat(ports.mergeMappings(cur, add));
    }
    const removed = cur.filter((o) => !merged.some((m) => fwdSame(m, o)));
    const added = merged.filter((m) => !cur.some((o) => fwdSame(m, o)));
    const oldHosts = new Set(cur.map((o) => o.host));
    // new host ports are checked AND claimed in one step (no await between),
    // so a port change on another VM cannot pass the same check meanwhile
    const fresh = added.filter((m) => !oldHosts.has(m.host)).map((m) => m.host);
    ports.checkMappings(name, merged, {});
    for (const p of fresh) ports.claim(p, 120000, name);
    try {
      const running = await isRunning(name);
      await ports.validateMappings(name, merged, { checkFree: running ? fresh : [] });
      let applied = running ? 'live' : 'saved';
      if (running && (added.length || removed.length)) {
        if (!monitor.monitorFor(vm) || vm.runtime.legacy) {
          applied = 'restart';
          warnings.push('this VM was started by an older version of the manager - restart it to apply the new forwards');
        } else {
          const done = { removed: [], added: [] };
          for (const o of removed) {
            const r = await monitor.removeForwardLive(vm, o);
            if (r.ok) { done.removed.push(o); t.log('removed ' + ports.describe(o)); }
            else { applied = 'restart'; warnings.push('could not remove ' + ports.describe(o) + ' live: ' + r.why); }
          }
          for (const m of added) {
            const r = await monitor.addForwardLive(vm, m);
            if (r.ok) { done.added.push(m); t.log('added ' + ports.describe(m)); continue; }
            if (!(await platform.isPortFree(m.host))) {
              // held by someone: saving it for a restart would leave a VM
              // that cannot start ("port in use") - refuse, undo, name the holder
              for (const q of done.added) await monitor.removeForwardLive(vm, q);
              for (const q of done.removed) await monitor.addForwardLive(vm, q);
              const who = ports.reservedPorts({ exceptVm: name }).get(m.host);
              throw new ports.PortConflict('host port ' + m.host + ' could not be opened: ' + (who ? 'it is already used by ' + who : 'another program on this PC is using it') + ' - pick another port (nothing was changed)');
            }
            applied = 'restart';
            warnings.push('could not add ' + ports.describe(m) + ' live: ' + r.why);
          }
        }
      }
      vm.ports = merged;
      if (applied === 'restart') vm.pendingRestart = true;
      st.saveState();
      for (const w of warnings) t.warn(w);
      t.log('forwards: ' + (merged.map(ports.describe).join(', ') || '(none)') + ' - ' + applied);
      return { name: name, ports: merged.map((p) => Object.assign({}, p)), applied: applied, warnings: warnings, pendingRestart: !!vm.pendingRestart };
    } finally {
      for (const p of fresh) ports.release(p, name);
    }
  });
}

// ---------------------------------------------------------------------------
// disk: resize, grow filesystem, compact, freeze into a template
// ---------------------------------------------------------------------------
async function validateResize(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  const raw = body.sizeGB !== undefined ? body.sizeGB : body.size;
  if (raw === undefined || raw === null || raw === '') throw badRequest('sizeGB is required');
  const sizeGB = intInRange(raw, CFG.minDiskGB, CFG.maxDiskGB, null, 'Disk size (GB)');
  if (await isRunning(name)) throw conflict('stop the VM before resizing its disk', 'RUNNING');
  if (!exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" is missing', 'MISSING');
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed', 'PREREQ_MISSING');
  const i = await diskInfo(st.diskPath(name));
  if (i.ok && i.virtualSize && sizeGB * GB <= i.virtualSize) {
    throw badRequest('the disk is already ' + fmtBytes(i.virtualSize) + ' - disks can only grow (pick more than ' + Math.floor(i.virtualSize / GB) + ' GB)');
  }
  return { name: name, sizeGB: sizeGB };
}
async function opResize(t, a) {
  const vm = st.getVm(a.name);
  if (await isRunning(a.name)) throw new Error('stop the VM before resizing its disk');
  t.step('Resizing the disk of "' + a.name + '" to ' + a.sizeGB + ' GB...');
  await infoIdle(a.name);
  const r = await run(platform.findTool('qemu-img'), ['resize', st.diskPath(a.name), a.sizeGB + 'G']);
  if (r.code !== 0) throw new Error('qemu-img resize failed: ' + lastLine(r));
  vm.pendingFsResize = true;
  st.saveState();
  await refreshInfo(a.name).catch(() => {});
  t.log('The virtual disk is now ' + a.sizeGB + ' GB. Start the VM, then use "Grow filesystem" to use the new space.');
  return { name: a.name, sizeGB: a.sizeGB };
}

// The VM must be running AND answer on SSH (shared guard, MNT-16).
async function requireSshReady(name) {
  requireVmName(name);
  const vm = lookupVm(name);
  if (!(await isRunning(name))) throw conflict('"' + name + '" is not running - start it first', 'NOT_RUNNING');
  // up to 5 s: a guest under TCG on a busy PC can take seconds to send its banner
  if (!(await probeSsh(vm.port, 5000))) throw conflict('"' + name + '" is still booting - SSH is not ready yet', 'BOOTING');
  return vm;
}

async function validateGrowFs(body) {
  body = body || {};
  const name = requireVmName(body.name);
  await requireSshReady(name);
  return { name: name };
}
async function opGrowFs(t, a) {
  const vm = await requireSshReady(a.name);
  t.step('Growing the root filesystem inside "' + a.name + '"...');
  const r = await ssh.sshExec({ name: a.name, port: vm.port }, 'sh -s', { input: growFsScript(), timeoutMs: 180000 });
  const out = (r.stdout + '\n' + r.stderr).trim();
  if (out) t.log(out);
  if (r.code !== 0) throw new Error('growing the filesystem failed (exit ' + r.code + '): ' + lastLine(r));
  vm.pendingFsResize = false;
  st.saveState();
  return { name: a.name };
}

// Compact / reclaim space (XTR-7). Running: `fstrim` in the guest, so QEMU
// (discard=unmap) frees the clusters inside the qcow2 for reuse. Stopped:
// rewrite the overlay with only the clusters that differ from its template
// (qemu-img convert -B <relative template>), then atomically replace it -
// this shrinks the file. Internal snapshots would be lost by the rewrite, so
// it is refused while the VM has any.
async function validateCompact(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  if (!exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" is missing', 'MISSING');
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed', 'PREREQ_MISSING');
  if (await isRunning(name)) {
    await requireSshReady(name);
    return { name: name, mode: 'trim' };
  }
  const i = await diskInfo(st.diskPath(name));
  if (!i.ok) throw conflict('cannot read the disk of "' + name + '": ' + i.error);
  if (i.snapshots.length) {
    throw conflict('"' + name + '" has ' + i.snapshots.length + ' snapshot(s); compacting rewrites the disk and would drop them - delete the snapshots first', 'HAS_SNAPSHOTS');
  }
  if (i.backing) {
    const full = i.backingFull || path.resolve(CFG.sandboxDir, i.backing);
    if (!exists(full)) throw conflict(templateMissingMessage(name, state.vms[name], full), 'TEMPLATE_MISSING');
  }
  return { name: name, mode: 'rewrite' };
}
async function opCompact(t, a) {
  const name = a.name;
  const vm = st.getVm(name);
  const disk = st.diskPath(name);
  const before = sizeOf(disk);
  if (await isRunning(name)) {
    await requireSshReady(name);
    if (vm.runtime && vm.runtime.legacy) t.warn('this VM was started by an older version of the manager without discard support - restart it once, then compact again');
    t.step('Trimming free space inside "' + name + '" (fstrim)...');
    // util-linux fstrim knows -a (all filesystems); BusyBox's needs a mount point
    const r = await ssh.sshExec({ name: name, port: vm.port }, 'fstrim -av 2>/dev/null || fstrim -v / 2>&1', { timeoutMs: 600000 });
    const out = (r.stdout + '\n' + r.stderr).trim();
    if (out) t.log(out);
    if (r.code !== 0) throw new Error('fstrim failed (exit ' + r.code + '): ' + lastLine(r));
    t.log('Freed space is now reusable inside the disk file. To shrink the file itself, stop the VM and compact again.');
    return { name: name, mode: 'trim', bytesBefore: before, bytesAfter: sizeOf(disk) };
  }
  const qi = platform.findTool('qemu-img');
  const b = await backingOf(name);
  if (b.info.snapshots.length) throw new Error('"' + name + '" has snapshots - delete them first (compacting would drop them)');
  if (b.full && !exists(b.full)) throw new Error(templateMissingMessage(name, vm, b.full));
  const d = platform.diskFree(CFG.sandboxDir);
  if (d.free !== null && d.free < before * 1.1 + 256 * 1024 * 1024) {
    throw new Error('not enough free disk space to compact: ' + fmtBytes(d.free) + ' free, up to ' + fmtBytes(before) + ' needed for the temporary copy');
  }
  const tmp = disk + '.compact';
  try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  t.step('Compacting the disk of "' + name + '" (' + fmtBytes(before) + ')...');
  const args = ['convert', '-O', 'qcow2'];
  if (b.rel) args.push('-F', b.info.backingFormat || 'qcow2', '-B', b.rel);
  args.push(disk, tmp);
  try {
    const r = await run(qi, args, { timeout: 60 * 60000 });
    if (r.code !== 0) throw new Error('qemu-img convert failed: ' + lastLine(r));
    const chk = await diskInfo(tmp);
    if (!chk.ok || chk.virtualSize !== b.info.virtualSize) throw new Error('the compacted copy does not look right (' + (chk.error || 'size differs') + ') - the original disk was kept');
    if (await isRunning(name)) throw new Error('"' + name + '" was started during the compaction - the original disk was kept');
    await infoIdle(name);
    await retryFs('replacing the disk with its compacted copy', () => fs.renameSync(tmp, disk));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  }
  const after = sizeOf(disk);
  await refreshInfo(name).catch(() => {});
  t.log('Compacted: ' + fmtBytes(before) + ' -> ' + fmtBytes(after) + ' (' + fmtBytes(Math.max(0, before - after)) + ' freed).');
  return { name: name, mode: 'rewrite', bytesBefore: before, bytesAfter: after };
}

async function validateFreeze(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  const as = body.as === undefined || body.as === null || body.as === '' ? name + '-base' : body.as;
  requireVmName(as, 'template');
  // NTFS is case-insensitive, and "devbox-base" is always the built-in base
  // image: a second "devbox-base" could never be selected (XTR-13).
  if (as.toLowerCase() === 'devbox-base') throw badRequest('"devbox-base" is the built-in base image - pick another template name');
  if (isAppliance(state.vms[name])) throw conflict('an appliance VM cannot become a template (templates are for the Alpine sandboxes) - snapshot it instead', 'APPLIANCE');
  const clash = listTemplates().find((x) => x.name.toLowerCase() === as.toLowerCase());
  if (clash || findTemplate(as)) throw conflict('a template called "' + (clash ? clash.name : as) + '" already exists - pick another name (templates are never overwritten: VMs may be clones of them)', 'EXISTS');
  tasks.assertFree('template:' + as);
  if (await isRunning(name)) throw conflict('stop the VM before freezing it into a template', 'RUNNING');
  if (!exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" is missing', 'MISSING');
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed', 'PREREQ_MISSING');
  return { name: name, as: as };
}
async function opFreeze(t, a) {
  if (await isRunning(a.name)) throw new Error('stop the VM before freezing it into a template');
  fs.mkdirSync(CFG.basesDir, { recursive: true });
  const dest = templateFile(a.as);
  if (exists(dest)) throw new Error('a template called "' + a.as + '" already exists');
  const b = await backingOf(a.name);
  if (b.full && !exists(b.full)) throw new Error(templateMissingMessage(a.name, st.getVm(a.name), b.full));
  const d = platform.diskFree(CFG.basesDir);
  const need = (b.info.actualSize || sizeOf(st.diskPath(a.name))) + (b.full ? sizeOf(b.full) : 0);
  if (d.free !== null && d.free < need + 256 * 1024 * 1024) {
    throw new Error('not enough free disk space for the template: ' + fmtBytes(d.free) + ' free, about ' + fmtBytes(need) + ' needed');
  }
  const part = dest + '.part';
  t.step('Freezing "' + a.name + '" into the template "' + a.as + '" (flattening the backing chain)...');
  try {
    const r = await run(platform.findTool('qemu-img'), ['convert', '-O', 'qcow2', st.diskPath(a.name), part], { timeout: 60 * 60000, maxBuffer: 64 * 1024 * 1024 });
    if (r.code !== 0) throw new Error('qemu-img convert failed: ' + lastLine(r));
    fs.renameSync(part, dest);
  } finally {
    try { fs.rmSync(part, { force: true }); } catch (e) {}
  }
  t.log('Template "' + a.as + '" created: ' + fmtBytes(sizeOf(dest)) + '. New VMs can now be created from it.');
  return { name: a.name, template: a.as, bytes: sizeOf(dest) };
}

// ---------------------------------------------------------------------------
// reset to template (XTR-8)
// ---------------------------------------------------------------------------
// Recreates the overlay from the template: everything done inside the VM is
// gone, its settings, ports and name stay. A disk that was enlarged keeps its
// size (the filesystem then needs "Grow filesystem" again).
async function validateReset(body) {
  body = body || {};
  const name = requireVmName(body.name);
  const vm = lookupVm(name);
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed', 'PREREQ_MISSING');
  if (vm.template === null) await fillUnknownTemplates().catch(() => {});
  if (vm.template === null) throw conflict('the template of "' + name + '" is unknown - it cannot be reset', 'NO_TEMPLATE');
  if (vm.template === '') throw conflict('"' + name + '" is a standalone disk, not a clone of a template - there is nothing to reset it to', 'NO_TEMPLATE');
  const tf = findTemplate(vm.template);
  if (!tf) throw conflict('template "' + vm.template + '" is missing - "' + name + '" cannot be reset', 'TEMPLATE_MISSING');
  tasks.assertFree('template:' + vm.template);
  if ((await isRunning(name))) tasks.assertFree('qemu');
  return { name: name, template: vm.template, waitS: intInRange(body.waitS, 0, 1800, null, 'waitS') };
}
async function opReset(t, a) {
  const name = a.name;
  const vm = st.getVm(name);
  const tf = findTemplate(a.template);
  if (!tf) throw new Error('template "' + a.template + '" is missing');
  const wasRunning = await isRunning(name);
  if (wasRunning) await opStop(t, { name: name, force: false });
  const disk = st.diskPath(name);
  let size = null;
  const old = exists(disk) ? await diskInfo(disk) : { ok: false };
  const base = await diskInfo(tf);
  if (old.ok && base.ok && old.virtualSize > base.virtualSize) size = old.virtualSize;
  t.step('Resetting "' + name + '" to the template ' + a.template + '...');
  const tmp = disk + '.reset';
  try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  try {
    await createOverlay(tmp, tf, size);
    // the overlay's backing path is relative to ITS folder: same as the disk's
    await infoIdle(name);
    await retryFs('replacing the disk with a fresh copy of the template', () => fs.renameSync(tmp, disk));
  } finally { try { fs.rmSync(tmp, { force: true }); } catch (e) {} }
  ssh.forgetHostKey(name);
  vm.personalized = false;
  vm.pendingFsResize = !!size;
  vm.lastError = null;
  st.saveState();
  await refreshInfo(name).catch(() => {});
  t.log('"' + name + '" is back to a fresh copy of ' + a.template + (size ? ' (disk kept at ' + fmtBytes(size) + ' - use "Grow filesystem" after it starts)' : '') + '. Its settings and port forwards are unchanged.');
  const result = { name: name, template: a.template, reset: true };
  if (wasRunning) Object.assign(result, await opStart(t, { name: name, waitS: a.waitS }));
  return result;
}

// ---------------------------------------------------------------------------
// snapshots (XTR-8): qcow2 internal snapshots of a STOPPED VM
// ---------------------------------------------------------------------------
async function listSnapshots(name) {
  const i = await diskInfo(st.diskPath(name));
  if (!i.ok) throw new Error('cannot read the disk of "' + name + '": ' + i.error);
  return i.snapshots;
}

async function validateSnapshot(body) {
  body = body || {};
  const name = requireVmName(body.name);
  lookupVm(name);
  const action = body.action === undefined || body.action === null || body.action === '' ? 'list' : body.action;
  if (['create', 'revert', 'delete', 'list'].indexOf(action) === -1) throw badRequest('action must be create, revert, delete or list');
  if (!exists(st.diskPath(name))) throw conflict('the disk of "' + name + '" is missing', 'MISSING');
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed', 'PREREQ_MISSING');
  if (action === 'list') return { name: name, action: action, snapshot: null };
  const why = snapshotNameError(body.snapshot);
  if (why) throw badRequest('bad snapshot name: ' + why);
  if (await isRunning(name)) throw conflict('stop "' + name + '" first - snapshots are taken, restored and deleted while the VM is stopped', 'RUNNING');
  const have = await listSnapshots(name).catch((e) => { throw conflict(errMsg(e)); });
  // qemu-img happily creates two snapshots with one name; we never do
  const found = have.some((s) => s.name === body.snapshot);
  if (action === 'create' && found) throw conflict('a snapshot called "' + body.snapshot + '" already exists', 'EXISTS');
  if (action !== 'create' && !found) throw notFound('"' + name + '" has no snapshot called "' + body.snapshot + '"');
  return { name: name, action: action, snapshot: body.snapshot };
}
async function opSnapshot(t, a) {
  const name = a.name;
  const disk = st.diskPath(name);
  if (a.action === 'list') {
    const snapshots = await listSnapshots(name);
    t.log(snapshots.length ? snapshots.map((s) => s.name + '  ' + (s.date || '')).join('\n') : '(no snapshots)');
    return { name: name, action: 'list', snapshots: snapshots };
  }
  if (await isRunning(name)) throw new Error('stop "' + name + '" first');
  const flag = { create: '-c', revert: '-a', delete: '-d' }[a.action];
  const verb = { create: 'Taking', revert: 'Restoring', delete: 'Deleting' }[a.action];
  t.step(verb + ' snapshot "' + a.snapshot + '" of "' + name + '"...');
  await infoIdle(name);
  const r = await run(platform.findTool('qemu-img'), ['snapshot', flag, a.snapshot, disk], { timeout: 30 * 60000 });
  if (r.code !== 0) throw new Error('qemu-img snapshot failed: ' + lastLine(r));
  const snapshots = await listSnapshots(name).catch(() => []);
  await refreshInfo(name).catch(() => {});
  if (a.action === 'revert') t.log('"' + name + '" is back at the state of "' + a.snapshot + '"; everything after it was discarded.');
  else if (a.action === 'create') t.log('Snapshot "' + a.snapshot + '" taken. Restore it any time while the VM is stopped.');
  else t.log('Snapshot "' + a.snapshot + '" deleted.');
  return { name: name, action: a.action, snapshot: a.snapshot, snapshots: snapshots };
}

// ---------------------------------------------------------------------------
// network overview (GET /api/network - the only place that lists sockets)
// ---------------------------------------------------------------------------
// Who can reach a listening address: this PC only, or the network too.
function scopeOf(address) {
  if (!address) return null;
  if (/^127\./.test(address) || address === '::1' || address === 'localhost') return 'local';
  return 'lan';
}

async function networkOverview() {
  const listeners = await platform.listListeners();
  const byPort = new Map();
  for (const l of listeners || []) {
    if (!byPort.has(l.port)) byPort.set(l.port, []);
    byPort.get(l.port).push(l);
  }
  const rows = [{ vm: null, kind: 'manager', host: CFG.serverPort, guest: null, lan: false, container: null, owner: null }];
  if (byPort.has(CFG.bakeSshPort)) rows.push({ vm: null, kind: 'bake', host: CFG.bakeSshPort, guest: 22, lan: false, container: null, owner: null });
  for (const name of Object.keys(state.vms).sort()) {
    const vm = state.vms[name];
    rows.push({ vm: name, kind: 'ssh', host: vm.port, guest: 22, lan: !!vm.sshLan, container: null, owner: null });
    for (const p of vm.ports || []) {
      rows.push({ vm: name, kind: 'app', host: p.host, guest: p.guest, lan: !!p.lan, container: p.container || null, owner: p.owner || null });
    }
  }
  // microVM containers' published ports (owner "container <name>"); their
  // QEMU pid identifies which listener is theirs
  const ctrPid = new Map();
  for (const c of require('./microvm/containers').networkRows()) {
    rows.push({ vm: null, kind: 'container', host: c.host, guest: c.guest, lan: !!c.lan, container: c.container, owner: c.owner, proto: c.proto });
    if (c.pid) ctrPid.set(rows[rows.length - 1], c.pid);
  }
  // one TCP and one UDP forward may share a port number; the listener list
  // is TCP only, so a UDP forward's listening state is unknown (empty)
  const keyOf = (r) => (r.proto === 'udp' ? 'udp:' : 'tcp:') + r.host;
  const count = {};
  for (const r of rows) count[keyOf(r)] = (count[keyOf(r)] || 0) + 1;
  for (const r of rows) {
    const ls = r.proto === 'udp' ? [] : (byPort.get(r.host) || []);
    const vm = r.vm ? state.vms[r.vm] : null;
    const ownPid = vm && vm.runtime ? vm.runtime.pid : (ctrPid.get(r) || null);
    const mine = ownPid ? ls.filter((l) => l.pid === ownPid) : [];
    const pick = mine[0] || ls[0] || null;
    r.listening = ls.length > 0;
    r.pid = pick ? pick.pid : null;
    r.address = pick ? pick.address : null;
    r.byVm = mine.length > 0;
    // what it is really bound to vs. what the user chose (a VM started
    // before a change keeps the old binding until it restarts)
    r.scope = mine.length ? (mine.some((l) => scopeOf(l.address) === 'lan') ? 'lan' : 'local') : (pick ? scopeOf(pick.address) : null);
    r.exposure = r.lan ? 'lan' : 'local';
    r.mismatch = !!(r.byVm && r.scope && r.scope !== r.exposure);
    r.pendingRestart = !!(vm && vm.pendingRestart);
    r.conflict = count[keyOf(r)] > 1 || !!((r.vm || r.container) && r.listening && ownPid && !r.byVm && r.pid !== null);
  }
  rows.sort((x, y) => x.host - y.host);
  return { rows: rows, listenersAvailable: listeners !== null };
}

// ---------------------------------------------------------------------------
// manager start-up: adopt running VMs, then autostart
// ---------------------------------------------------------------------------
// Records keep runtime.pid across manager restarts (VMs are detached and keep
// running). A recorded pid is only kept when it is still a QEMU process AND
// that VM's own monitor confirms it (`info name`): after a reboot or a crash
// the pid can belong to any other QEMU (SEC-8, BUG-6). Everything else is
// cleared. Only right after an upgrade from a v1 registry, records without a
// runtime whose SSH port is held by a QEMU process are adopted (v1 kept no
// pids); their monitor is the v1 one, so they are flagged "legacy".
//
// Runs in the background after the server started listening, so it only
// touches records nobody changed meanwhile: a start (or create) that spawned
// its QEMU during the process listing has a runtime this function never saw,
// and clearing it would orphan that QEMU and crash the start (found in a
// review - the MCP server starts the manager and calls create_vm at once).
async function adoptRunning() {
  const before = new Map(Object.keys(state.vms).map((n) => [n, state.vms[n].runtime]));
  const untouched = (name) => {
    const vm = state.vms[name];
    return !!vm && vm.runtime === before.get(name) && !tasks.vmBusy(name) && !children.has(name);
  };
  const pids = await platform.listQemuPids();
  if (!pids) return;
  noteQemuPids(pids);
  const owner = new Map(); // pid -> the first record that claims it
  const clear = (name, why) => {
    const vm = state.vms[name];
    log('VM "' + name + '": ' + why + ' - not running');
    removeRuntimeFiles(name, vm.runtime);
    vm.runtime = null;
  };
  let listeners;
  const listen = async () => (listeners === undefined ? (listeners = await platform.listListeners()) : listeners);
  await Promise.all(Array.from(before.keys()).map(async (name) => {
    const rt = before.get(name);
    if (!rt || !untouched(name)) return;
    if (!pids.has(rt.pid)) return clear(name, 'its QEMU (pid ' + rt.pid + ') is gone');
    if (owner.has(rt.pid)) return clear(name, 'pid ' + rt.pid + ' is already the QEMU of "' + owner.get(rt.pid) + '"');
    owner.set(rt.pid, name);
    let ok;
    if (rt.legacy) {
      // a v1 QEMU has no -name: the evidence that made it ours is still the
      // same, i.e. it holds this VM's SSH port
      const ls = await listen();
      ok = ls ? ls.some((l) => l.port === state.vms[name].port && l.pid === rt.pid) : null;
      if (ok) identity.set(rt.pid, name);
    } else {
      ok = await confirmIdentity(name, state.vms[name], 5000);
      if (ok === null) ok = await confirmIdentity(name, state.vms[name], 10000); // a busy PC
    }
    if (!untouched(name)) return;
    if (ok === true) log('VM "' + name + '" is still running (pid ' + rt.pid + ')' + (rt.legacy ? ' - started by version 1: restart it soon' : ''));
    else if (ok === false) clear(name, 'pid ' + rt.pid + ' now belongs to another QEMU process (left alone)');
    else clear(name, 'its recorded QEMU (pid ' + rt.pid + ') does not answer on its monitor, so it cannot be confirmed to be this VM (left alone - end it by hand if it is)');
  }));
  const orphans = Object.keys(state.vms).filter((n) => !state.vms[n].runtime && !tasks.vmBusy(n) && !children.has(n));
  if (st.migratedFromV1() && orphans.length && pids.size) {
    const ls = (await listen()) || [];
    const taken = new Set(Object.values(state.vms).map((v) => v.runtime && v.runtime.pid).filter(Boolean));
    for (const name of orphans) {
      const vm = state.vms[name];
      if (!vm || vm.runtime || tasks.vmBusy(name) || children.has(name)) continue;
      const l = ls.find((x) => x.port === vm.port && pids.has(x.pid) && !taken.has(x.pid));
      if (!l) continue;
      taken.add(l.pid);
      identity.set(l.pid, name);
      vm.runtime = {
        pid: l.pid, startedAt: null, accel: null,
        monitor: { host: '127.0.0.1', port: 25000 + (vm.port - 2222) }, serial: null, legacy: true,
      };
      log('adopted the running VM "' + name + '" (pid ' + l.pid + ', started by version 1) - restart it: its QEMU monitor is reachable from every VM and its ports from the network until then');
    }
  }
  st.saveState();
}

// Start every autostart VM, one after another, each as a normal task (so a
// failure is logged and releases its lock - BUG-2, OPS-3).
async function autostartAll() {
  for (const name of Object.keys(state.vms)) {
    const vm = state.vms[name];
    if (!vm || !vm.autostart) continue;
    try {
      if (await isRunning(name)) continue;
      const a = await validateStart({ name: name });
      const task = tasks.start({ kind: 'start', title: 'Autostart ' + name, vm: name, locks: ['vm:' + name] }, (t) => opStart(t, a));
      log('autostart: ' + name);
      const done = await tasks.wait(task.id);
      if (done && done.status === 'error') log('autostart of "' + name + '" failed: ' + String(done.error).split('\n')[0]);
    } catch (e) {
      log('autostart of "' + name + '" skipped: ' + errMsg(e));
    }
  }
}

module.exports = {
  MACHINE, macForPort, netdevFor, qemuArgs, accelArgs, cpuArgs, chardevSpec, qv, effectiveAccel,
  whpxCpuModel, runtimeEndpoints, freeDisplayPort, isAppliance, displayUp, TCG_FALLBACK_TB_MB, CONTROL_BIND_RE,
  guestHostname, validTimezone, personalizeScript, growFsScript, snapshotNameError, parseQemuImgInfo, scopeOf,
  requireVmName, lookupVm, isRunning, requireSshReady, sshReady, qemuPids, closeVmSessions, retryFs, infoIdle,
  socketPaths, dirIsPrivate, confirmIdentity, sshDropped, legacyWarning,
  listVms, getVmPublic, hostState, diskInfo, listSnapshots,
  listTemplates, listBases, findTemplate, findBase, templateFile, fillUnknownTemplates,
  validateCreate, opCreate,
  validateStart, opStart, chooseAccel, waitPortFree,
  validateStop, opStop, validateRestart, opRestart, validateDelete, opDelete, forgetVm,
  updateSettings, setPorts,
  validateResize, opResize, validateGrowFs, opGrowFs, validateCompact, opCompact, validateFreeze, opFreeze,
  validateReset, opReset, validateSnapshot, opSnapshot,
  networkOverview, adoptRunning, autostartAll,
  // tests only: the QEMU children this manager spawned, confirmed identities
  _internal: { children: children, identity: identity, forceRequested: forceRequested, resetCpuModel: () => { cpuModelPromise = null; } },
};
