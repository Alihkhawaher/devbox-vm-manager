'use strict';
/*
 * One OCI image = one microVM: the pure planning of a run plus the few file
 * writes it needs. Composes kernel assets (kernel.js), the image's rootfs
 * archive (lib/oci/cpio.js), the init archive (initramfs.js + init.sh) and
 * QEMU's command line (qemu-args.js). Spawning is run.js (containers) or
 * vmrun.startVm (the calibration boot).
 *
 *   resolveArgv(runtime, over)      Docker's ENTRYPOINT/CMD rules
 *   mergeEnv(base, over)            'K=V' lists, later keys replace earlier
 *   buildSpec(runtime, run)         run spec for initramfs.renderSpec
 *   initrdKey({configDigest, manifest})   content key of an image's initrd
 *   initrdFile({cacheDir, configDigest, key})
 *   ensureImageInitrd(o)            rootfs archive + base init archive, cached
 *                                   per CONTENT key (async)
 *   recommendedMemMB(initrdBytes, appMB)   RAM root: guest RAM for an image held in RAM
 *   recommendedDiskMemMB()          disk root: the default guest RAM (CFG.microvmMemMB)
 *   diskMemHint(runtime, over)      disk root: a higher default for apps known to
 *                                   need it (databases, JVMs) -> {what, memMB} | null
 *   ramAutoMemMB(imageBytes)        what a v2.0 RAM-root container got automatically
 *   planRun(o)                      -> {args, spec, specFile, logs, memMB, ...}
 *   parseConsole(text)              -> {exitCode, markers, kernelPanic}
 *   calibrateTscKhz(o)              one q35 boot -> host TSC kHz
 *   hostDefaults(o)                 host.json facts (CPU model, TSC, machines)
 *   checkQemuPath(p)                Windows MAX_PATH guard (resolved path)
 *   checkQemuPathRaw(s)             the same for a literal string (QEMU joins a
 *                                   relative backing name without normalising)
 *
 * INITRD KEY (bug V4b): sha256 over {INITRD_FORMAT, rootfs FORMAT_VERSION,
 * configDigest, kver, busybox sha256, sha256(init.sh), sorted module names},
 * truncated to 16 hex - never a path or an mtime (the prototype keyed on the
 * rootfs archive's mtime, so a concurrent re-flatten produced a second key
 * and the prune then deleted the initrd another run was about to boot). The
 * file name is <config hex 12>-<key 16>.initrd; it is built to a unique
 * .part and renamed, and when the target already exists the .part is
 * dropped and the target used ("exists = success") - Windows cannot rename
 * over a file a QEMU has open.
 *
 * HOST FACTS (bug A): host.json is keyed by {qemuVersion, accel} with the
 * DETECTED accelerator (platform.detectAccel), not "whpx because this is
 * Windows". The calibration boot runs WITHOUT a TCG fallback, so a PC where
 * WHPX does not work cannot cache a bogus TSC frequency labelled whpx. KVM and
 * HVF need no calibration (kvmclock). host.json also records which machine
 * types this QEMU has, so a build without "microvm" falls back to q35. The
 * calibration's base.initrd is deleted afterwards (bug 12e).
 *
 * TCG NEEDS THE TSC TOO (found in the integration E2E): microvm has no HPET
 * or ACPI PM timer, so the kernel calibrates the TSC against the PIT alone.
 * On a busy host a TCG guest misses the PIT windows ("Fast TSC calibration
 * failed ... No reference (HPET/PMTIMER) available"), marks the TSC unstable
 * and then hangs for good in calibrate_delay waiting for a jiffy that never
 * comes (18 of 24 boots with 8 in parallel; 0 of 24 with tsc_early_khz).
 * A TCG guest's TSC runs at the host TSC rate, so TCG facts reuse the
 * hardware accelerator's measured value when there is one, else measure it
 * with the same q35 boot under TCG (q35 has HPET), else the nominal clock.
 * The facts of an accelerator that is not the detected one live in their own
 * file (host-tcg.json): a TCG run must not overwrite the WHPX facts (it did,
 * and the next WHPX start re-ran the calibration boot).
 *
 * Run layout (runDir = CFG.microvmsDir/<id>):
 *   spec.sh        the rendered spec, handed to the guest through fw_cfg
 *   console.log    ttyS0: kernel messages + __DEVBOX_* markers (QEMU writes
 *                  it itself, so it survives a restart of the manager)
 *   stdout.log     container stdout (virtio-serial port devbox.stdout)
 *   stderr.log     container stderr (virtio-serial port devbox.stderr)
 * The console is also a socket QEMU listens on (a private endpoint, see
 * qemu-args.js "CONTROL ENDPOINTS"): the manager connects to it to watch
 * markers and to send "__DEVBOX_STOP" / "__DEVBOX_KILL <SIG>"; the HMP
 * monitor serves system_powerdown and quit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('../config');
const initramfs = require('./initramfs');
const { buildQemuArgs, kernelAppend } = require('./qemu-args');
const hostcpu = require('./hostcpu');

const INITRD_FORMAT = 1; // bump when the base archive layout changes
const HOST_FACTS_VERSION = 2;
// Disk root (the image stays on its ext4 disk; spike measurements, WHPX):
// 128 MB runs every image tried (a 606 MB one too), 112 MB python's
// import-heavy test 3/3, 96 MB boots 10/10 with the needed-modules initrd
// but thrashes the page cache under that workload - so 96 is the floor and
// 128 the default. A RAM root needs at least 128.
const DISK_MIN_MEM_MB = 96;
const RAM_MIN_MEM_MB = 128;
const DISK_DEFAULT_MEM_MB = 128;

// ---------------------------------------------------------------- spec
const asList = (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v.map(String) : v === '' ? [] : [String(v)]);

// Docker: --entrypoint replaces ENTRYPOINT and drops the image CMD; a
// command after the image name replaces CMD.
function resolveArgv(runtime, over) {
  runtime = runtime || {};
  over = over || {};
  const ep = asList(over.entrypoint);
  const entrypoint = ep !== undefined ? ep : (runtime.entrypoint || []);
  const cmdOver = asList(over.cmd);
  const cmd = cmdOver !== undefined ? cmdOver : ep !== undefined ? [] : (runtime.cmd || []);
  const argv = entrypoint.concat(cmd);
  if (!argv.length) throw new Error('no command specified (the image has no ENTRYPOINT/CMD and none was given)');
  return argv;
}

function mergeEnv(base, over) {
  const out = [];
  const index = new Map();
  const add = (k, v) => {
    if (!/^[^=\0]+$/.test(k)) throw new Error('bad environment variable name ' + JSON.stringify(k));
    if (index.has(k)) out[index.get(k)] = k + '=' + v;
    else { index.set(k, out.length); out.push(k + '=' + v); }
  };
  for (const src of [base, over]) {
    if (!src) continue;
    const list = Array.isArray(src) ? src : Object.entries(src).map(([k, v]) => k + '=' + v);
    for (const e of list) {
      const i = String(e).indexOf('=');
      if (i <= 0) throw new Error('environment entries must be K=V: ' + JSON.stringify(e));
      add(String(e).slice(0, i), String(e).slice(i + 1));
    }
  }
  return out;
}

// run: {entrypoint, cmd, env, user, workdir, hostname, net (default on),
//       volumes: [{target, readonly, nocopy}] (disk i gets serial "vol<i>"),
//       copyIn: {targets: ['/app', ...], owner: 'user'|'root'} (the archive
//       itself is a read-only raw disk with serial "devbox-copyin", see
//       init.sh; planRun extraDrives),
//       shares: [{id, target, readonly}] (live shared folders; the port and
//       secrets travel in the fw_cfg file lib/shares.js writes),
//       stopSignal, stopTimeout, extraHosts, sysctls, acpiButton, logCap,
//       debug}
function buildSpec(runtime, run) {
  runtime = runtime || {};
  run = run || {};
  const pick = (a, b) => (a !== undefined && a !== null ? a : b);
  return {
    argv: resolveArgv(runtime, run),
    env: mergeEnv(runtime.env, run.env),
    workdir: pick(run.workdir, runtime.workingDir) || '/',
    user: pick(run.user, runtime.user) || '',
    hostname: run.hostname || 'devbox',
    net: run.net === false ? false : (run.net || {}),
    volumes: (run.volumes || []).map((v, i) => ({ serial: v.serial || 'vol' + i, target: v.target, readonly: !!v.readonly, nocopy: !!v.nocopy })),
    copyIn: run.copyIn && run.copyIn.targets && run.copyIn.targets.length
      ? { targets: run.copyIn.targets.slice(), owner: run.copyIn.owner === 'root' ? 'root' : 'user' } : null,
    shares: (run.shares || []).map((s) => ({ id: s.id, target: s.target, readonly: !!s.readonly })),
    logCap: run.logCap === undefined ? undefined : run.logCap,
    stopSignal: pick(run.stopSignal, runtime.stopSignal) || 'TERM',
    stopTimeout: pick(run.stopTimeout, 10),
    extraHosts: run.extraHosts || [],
    sysctls: run.sysctls || {},
    acpiButton: !!run.acpiButton,
    rng: run.rng !== false,
    trim: run.trim !== false,
    debug: !!run.debug,
    // pure default ram: the calibration boot has no root disk; the engine
    // always says which
    rootfs: run.rootfs === 'disk' ? 'disk' : 'ram',
  };
}

// ---------------------------------------------------------------- initrd
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// QEMU for Windows opens files with the ANSI/MAX_PATH APIs: a path of 260
// characters or more fails with "No such file or directory" (measured: 258
// boots, 266 fails). Throw early with a useful message instead.
const WIN_MAX_PATH = 259;
function checkQemuPath(p, platform) {
  if ((platform || process.platform) !== 'win32' || !p) return p;
  checkQemuPathRaw(path.resolve(p), platform);
  return p;
}
// The literal string, as QEMU will hand it to Windows: for an overlay QEMU
// joins the overlay's folder and the RELATIVE backing name without
// normalising ".." (path_combine), so "<root>/microvms/<id>/../../images/
// disks/<name>.qcow2" must fit, not just the resolved path.
function checkQemuPathRaw(s, platform) {
  if ((platform || process.platform) !== 'win32' || !s) return s;
  if (String(s).length > WIN_MAX_PATH) {
    const e = new Error('path too long for QEMU on Windows (' + String(s).length + ' > ' + WIN_MAX_PATH + ' characters): ' + s +
      ' - move the data folder to a shorter path (--data)');
    e.code = 'PATH_TOO_LONG';
    throw e;
  }
  return s;
}

function configHex(configDigest) {
  const hex = String(configDigest || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('bad image config digest ' + configDigest);
  return hex;
}

// o: {configDigest, manifest} -> 16 hex (see "INITRD KEY")
function initrdKey(o) {
  const { FORMAT_VERSION } = require('../oci/cpio');
  const busySha = (o.manifest.sha256 && o.manifest.sha256['busybox.static']) || '';
  return sha256(JSON.stringify({
    f: INITRD_FORMAT, rootfs: FORMAT_VERSION, config: 'sha256:' + configHex(o.configDigest),
    kver: o.manifest.kver, busybox: busySha, init: sha256(initramfs.initScript()),
    modules: Object.keys(o.manifest.modules).sort(),
  })).slice(0, 16);
}

// short names: QEMU on Windows cannot open paths of 260+ characters
function initrdFile(o) {
  return path.join(o.cacheDir || path.join(CFG.imagesDir, 'initrd'), configHex(o.configDigest).slice(0, 12) + '-' + o.key + '.initrd');
}

// The initrd a run boots: the image's rootfs archive followed by the base
// init archive (busybox, init, every module in the manifest; no spec - that
// comes through fw_cfg), zero-padded between them. Built once per content
// key; every run reuses it untouched.
// o: {configDigest, manifest, kernelDir, cacheDir?, rootfsCpio: path |
//     async () => path (only called on a miss, so the rootfs archive can be
//     re-created from the blobs when it was deleted)}
// -> {file, key, cached, bytes}
async function ensureImageInitrd(o) {
  const key = initrdKey(o);
  const file = initrdFile({ cacheDir: o.cacheDir, configDigest: o.configDigest, key });
  checkQemuPath(file);
  const have = () => { try { return fs.statSync(file).size; } catch (e) { return null; } };
  const size0 = have();
  if (size0 !== null) return { file, key, cached: true, bytes: size0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rootfs = typeof o.rootfsCpio === 'function' ? await o.rootfsCpio() : o.rootfsCpio;
  const base = await initramfs.buildInitArchive({ kernelDir: o.kernelDir, manifest: o.manifest });
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  try {
    fs.copyFileSync(rootfs, part);
    const st = fs.statSync(part);
    const pad = (512 - (st.size % 512)) % 512;
    fs.appendFileSync(part, Buffer.concat([Buffer.alloc(pad), base]));
    if (have() === null) {
      try { fs.renameSync(part, file); }
      catch (e) { if (have() === null) throw e; } // another writer won the race
    }
  } finally {
    fs.rmSync(part, { force: true });
  }
  return { file, key, cached: false, bytes: have() };
}

// Guest RAM an initramfs-rooted run needs: while booting, the initrd and
// its unpacked copy are both in RAM (measured with -m steps of 16 MB and
// initramfs_options=size=90%: 53.6 MB initrd boots at 208 MB, not 192;
// 68.5 MB boots at 224, not 208), and afterwards the image stays in RAM as
// the tmpfs root. appMB is what the container itself should have left.
// The boot term is 2.2 x the initrd: a 612 MB initrd panicked ("System is
// deadlocked on memory") at 1,328 MB = 2 x + 90, and booted at 1,456
// (disk-root spike).
function recommendedMemMB(initrdBytes, appMB) {
  const mib = initrdBytes / 1048576;
  const boot = 2.2 * mib + 90;
  const run = mib + 48 + (appMB === undefined ? 128 : appMB);
  return Math.ceil(Math.max(boot, run, 128) / 16) * 16;
}

// Guest RAM of a disk-root run when none is given: the image streams through
// the page cache, so its size does not matter (CFG.microvmMemMB: 128, 112
// with the light profile).
function recommendedDiskMemMB() {
  const v = Number(CFG.microvmMemMB);
  return Number.isInteger(v) && v >= DISK_MIN_MEM_MB ? v : DISK_DEFAULT_MEM_MB;
}

// Apps whose own start-up needs more than the disk root's small default,
// recognised by the program the image starts or its environment - never by
// the image's SIZE (that no longer costs RAM). MySQL/MariaDB and MongoDB
// allocate a few hundred MB as they start, a JVM sizes its heap from the
// RAM it sees (1/4 of 128 MB is 32 MB), Elasticsearch wants a 1 GB heap,
// PostgreSQL's default shared_buffers alone is 128 MB (cr-3). Only the
// DEFAULT moves: a memory_mb the user gave always wins.
const HUNGRY_APPS = [
  { what: 'Elasticsearch/OpenSearch', memMB: 1024, prog: /^(elasticsearch|opensearch|eswrapper|opensearch-docker-entrypoint\.sh)$/, env: /^(ELASTIC_CONTAINER|ES_JAVA_HOME|OPENSEARCH_HOME)=/ },
  { what: 'MySQL/MariaDB', memMB: 512, prog: /^(mysqld|mariadbd|mysqld_safe|mariadbd-safe)$/, env: /^(MYSQL_MAJOR|MYSQL_VERSION|MARIADB_VERSION|MARIADB_MAJOR)=/ },
  { what: 'MongoDB', memMB: 512, prog: /^(mongod|mongos)$/, env: /^(MONGO_MAJOR|MONGO_VERSION)=/ },
  { what: 'a Java (JVM) app', memMB: 512, prog: /^java$/, env: /^(JAVA_HOME|JAVA_VERSION|JDK_VERSION|JRE_VERSION)=/ },
  { what: 'PostgreSQL', memMB: 256, prog: /^(postgres|postmaster|pg_ctl)$/, env: /^(PG_MAJOR|PG_VERSION)=/ },
];
// runtime: registry.runtimeConfig; over: {entrypoint, cmd} (the run's own,
// null/undefined = the image's) -> {what, memMB} | null
function diskMemHint(runtime, over) {
  runtime = runtime || {};
  over = over || {};
  const has = (v) => v !== undefined && v !== null;
  const ep = has(over.entrypoint) ? over.entrypoint : (runtime.entrypoint || []);
  const cmd = has(over.cmd) ? over.cmd : (has(over.entrypoint) ? [] : (runtime.cmd || []));
  const progs = [].concat(ep || [], cmd || []).map((a) => String(a).split('/').pop());
  const env = (runtime.env || []).map(String);
  for (const h of HUNGRY_APPS) {
    if (progs.some((p) => h.prog.test(p)) || env.some((e) => h.env.test(e))) return { what: h.what, memMB: h.memMB };
  }
  return null;
}

// What a v2.0 container got when its memory was automatic: the RAM root's
// max(256, recommendedMemMB(initrd)) - kept as its explicit memory when it
// first starts from a disk root, so a database that relied on it does not
// drop to 128 MB without notice (cr-3). imageBytes: the initrd's size (or
// the rootfs archive's); unknown -> 256.
function ramAutoMemMB(imageBytes) {
  return imageBytes > 0 ? Math.max(256, recommendedMemMB(imageBytes)) : 256;
}

// ---------------------------------------------------------------- plan
// o: {kernelDir, manifest, initrd, runDir, spec (buildSpec),
//     machine ('microvm'|'q35'), accel, accelFallback, cpuModel, tscKhz,
//     memMB, cpus, tcgTbSizeMB,
//     ports: [{hostPort, guestPort, proto, hostAddr}],
//     volumes: [{file, format}] (same order as spec.volumes),
//     console: {host, port} | {path}   (QEMU listens; logged to logs.console)
//     monitor: {host, port} | {path}   (HMP; QEMU listens)
//     name, kernel (path; default vmlinuz-virt), kernelArgs: [extra],
//     logs: {console, stdout, stderr}, pidFile,
//     fwcfg: [{name: 'opt/devbox/...', file}] (extra fw_cfg files; SMALL
//     ones only: the guest's fw_cfg sysfs read re-skips to its offset with
//     single-byte port reads for every 4 KB chunk, so reading N bytes costs
//     ~N^2/8K port exits - 1 MB did not finish in 10 minutes under WHPX),
//     extraDrives: [{id, file, format ('raw'), serial, readonly (true)}]
//     (e.g. the copy-in archive as a read-only raw disk),
//     extraMemMB (RAM for content added to the RAM root at start, e.g.
//     copy-in bytes; added to the recommended size), allowLowMemory,
//     writeSpec(file, text) (default fs.writeFileSync; the engine writes the
//     spec - env values inside - as a private file),
//     rootDisk: {file (the overlay), backing (absolute image disk),
//     backingRel (as stored in the overlay)} - disk root (spec.rootfs
//     'disk'): the FIRST drive, id root, serial devbox-root, qcow2, rw}
// Memory: a RAM root needs the image in RAM (recommendedMemMB of the initrd);
// a disk root gets o.memMB, else recommendedDiskMemMB(), never below
// DISK_MIN_MEM_MB, and copy-in costs it no RAM (the files land on the disk).
function planRun(o) {
  const machine = o.machine || 'microvm';
  const accel = o.accel || 'tcg';
  if (machine === 'microvm' && accel === 'whpx' && !o.tscKhz) {
    throw new Error('microvm under WHPX needs tscKhz (hostDefaults/calibrateTscKhz): the kernel hangs calibrating the TSC otherwise');
  }
  const spec = o.spec;
  const vols = o.volumes || [];
  if (vols.length !== (spec.volumes || []).length) throw new Error('planRun: volumes and spec.volumes differ in length');
  fs.mkdirSync(o.runDir, { recursive: true });
  const specText = initramfs.renderSpecFor(spec, o.manifest);
  const specFile = path.join(o.runDir, 'spec.sh');
  // env values are secrets: the engine passes a private writer (sec-5)
  if (o.writeSpec) o.writeSpec(specFile, specText);
  else fs.writeFileSync(specFile, specText);
  const logs = Object.assign({
    console: path.join(o.runDir, 'console.log'),
    stdout: path.join(o.runDir, 'stdout.log'),
    stderr: path.join(o.runDir, 'stderr.log'),
  }, o.logs || {});
  const disk = spec.rootfs === 'disk';
  if (disk && !(o.rootDisk && o.rootDisk.file)) throw new Error('planRun: a disk-root spec needs o.rootDisk (the overlay)');
  if (!disk && o.rootDisk) throw new Error('planRun: o.rootDisk is only for a disk-root spec');
  let initrdBytes = 0;
  let minMem, memMB;
  if (disk) {
    minMem = DISK_MIN_MEM_MB;
    memMB = o.memMB || recommendedDiskMemMB();
    if (memMB < minMem && !o.allowLowMemory) {
      const e = new Error('memory ' + memMB + ' MB is too small: a microVM with its image on disk needs >= ' + minMem + ' MB');
      e.code = 'MEMORY_TOO_SMALL';
      throw e;
    }
  } else {
    try { initrdBytes = fs.statSync(o.initrd).size; } catch (e) { /* planned before the initrd exists */ }
    const extraMB = Math.max(0, Math.ceil(o.extraMemMB || 0));
    minMem = (initrdBytes ? recommendedMemMB(initrdBytes, 0) : RAM_MIN_MEM_MB) + extraMB;
    memMB = o.memMB || Math.max(256, (initrdBytes ? recommendedMemMB(initrdBytes) : 256) + extraMB);
    if (memMB < minMem && !o.allowLowMemory) {
      const e = new Error('memory ' + memMB + ' MB is too small for a ' + Math.round(initrdBytes / 1048576) + ' MB image held in RAM' +
        (extraMB ? ' plus ' + extraMB + ' MB of copied-in files' : '') + ' (needs >= ' + minMem + ' MB)');
      e.code = 'MEMORY_TOO_SMALL';
      throw e;
    }
  }
  const rootDrive = disk ? [{ id: 'root', path: o.rootDisk.file, format: 'qcow2', serial: 'devbox-root', readonly: false }] : [];
  const qo = {
    name: o.name || 'devbox-microvm', machine, accel, accelFallback: o.accelFallback, cpu: o.cpuModel || undefined, whpxOpts: o.whpxOpts,
    cpus: o.cpus || 1, memMB, tcgTbSizeMB: o.tcgTbSizeMB,
    kernel: o.kernel || path.join(o.kernelDir, 'vmlinuz-virt'), initrd: o.initrd,
    append: kernelAppend({ tscKhz: machine === 'microvm' ? o.tscKhz : 0, extra: o.kernelArgs || [] }),
    console: o.console
      ? { socket: Object.assign({}, o.console, { server: true }), logfile: logs.console }
      : { null: true, logfile: logs.console },
    monitor: o.monitor || undefined,
    net: spec.net === false ? false : { hostfwd: (o.ports || []).map((p) => ({ proto: p.proto || 'tcp', hostAddr: p.hostAddr, hostPort: p.hostPort, guestPort: p.guestPort })) },
    // the root disk first: /dev/vda, probed before anything else
    drives: rootDrive.concat(vols.map((v, i) => ({ id: 'vol' + i, path: v.file, format: v.format || 'qcow2', serial: spec.volumes[i].serial, readonly: spec.volumes[i].readonly })))
      .concat((o.extraDrives || []).map((d, i) => ({ id: d.id || 'xd' + i, path: d.file, format: d.format || 'raw', serial: d.serial, readonly: d.readonly !== false }))),
    vports: [
      { name: 'devbox.stdout', chardev: { file: logs.stdout } },
      { name: 'devbox.stderr', chardev: { file: logs.stderr } },
    ],
    rng: spec.rng !== false,
    fwcfg: [{ name: 'opt/devbox/spec', file: specFile }].concat(o.fwcfg || []),
    pidFile: o.pidFile,
  };
  for (const f of qo.fwcfg) {
    // QEMU: fw_cfg file names are at most 55 characters; opt/ is the
    // namespace reserved for users
    if (!/^opt\/[A-Za-z0-9_.\/-]{1,51}$/.test(f.name)) throw new Error('bad fw_cfg name ' + f.name);
  }
  const paths = [qo.kernel, qo.initrd, logs.console, logs.stdout, logs.stderr, o.pidFile]
    .concat(qo.fwcfg.map((f) => f.file), qo.drives.map((d) => d.path));
  for (const p of paths) checkQemuPath(p);
  if (disk) {
    // the image disk QEMU opens as the backing file, by the literal path it
    // builds from the overlay's folder and the stored relative name
    if (o.rootDisk.backing) checkQemuPath(o.rootDisk.backing);
    if (o.rootDisk.backingRel && !path.isAbsolute(o.rootDisk.backingRel)) {
      checkQemuPathRaw(path.dirname(path.resolve(o.rootDisk.file)) + '/' + o.rootDisk.backingRel);
    }
  }
  return { args: buildQemuArgs(qo), spec, specText, specFile, logs, qemuOpts: qo, memMB, minMemMB: minMem };
}

// ---------------------------------------------------------------- results
// Markers are guest output (untrusted): only the strict __DEVBOX_NAME[=value]
// shape counts, and only the LAST exit marker.
function parseConsole(text) {
  const s = String(text || '');
  const markers = {};
  let exitCode = null;
  const re = /__DEVBOX_([A-Z_]{1,32})(?:=(\S{0,300}))?/g;
  let m;
  while ((m = re.exec(s))) {
    markers[m[1]] = m[2] === undefined ? true : m[2];
    if (m[1] === 'EXIT' && /^\d{1,3}$/.test(m[2] || '')) exitCode = parseInt(m[2], 10);
  }
  return { exitCode, markers, kernelPanic: /Kernel panic - not syncing/.test(s) };
}

// ---------------------------------------------------------------- host facts
const versionCache = new Map();
function qemuVersionOf(qemu) {
  if (!qemu) return null;
  if (!versionCache.has(qemu)) {
    const { runSync } = require('../util');
    versionCache.set(qemu, runSync(qemu, ['--version']).split('\n')[0].trim() || null);
  }
  return versionCache.get(qemu);
}

// Machine types this QEMU build has (`-machine help`), e.g. ['microvm','q35'].
function qemuMachines(qemu) {
  const { runSync } = require('../util');
  const out = runSync(qemu, ['-machine', 'help'], 20000);
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s/.exec(line.trim() + ' ');
    if (m && /^(microvm|q35|pc)$/.test(m[1])) names.push(m[1]);
  }
  return names;
}

// Boot the kernel once on q35 (HPET + PIT there) with just the base archive
// and read the kernel's TSC calibration. o: {qemu, kernelDir, manifest,
// workDir, accel, cpuModel, endpoints: {monitor, serial} (fresh private
// endpoints, vm.runtimeEndpoints), whpxOpts (the host probe's), timeoutMs}. Returns kHz or null; throws
// when QEMU silently used TCG instead of the requested accelerator.
async function calibrateTscKhz(o) {
  const { startVm, qemuErrorLines } = require('./vmrun');
  const dir = o.workDir;
  fs.mkdirSync(dir, { recursive: true });
  const initrd = path.join(dir, 'base.initrd');
  try {
    fs.writeFileSync(initrd, await initramfs.buildInitArchive({ kernelDir: o.kernelDir, manifest: o.manifest }));
    // the refined calibration runs ~1 s after boot; wait for it
    const spec = buildSpec({}, {
      entrypoint: ['/.devbox/busybox', 'sh', '-c', 'i=0; while [ $i -lt 40 ] && ! /.devbox/busybox dmesg | /.devbox/busybox grep -q "Refined TSC"; do /.devbox/busybox usleep 100000; i=$((i+1)); done; /.devbox/busybox dmesg | /.devbox/busybox grep "tsc:"'],
      net: false, rng: false,
    });
    const plan = planRun({
      kernelDir: o.kernelDir, manifest: o.manifest, initrd, runDir: dir, spec, machine: 'q35', accel: o.accel,
      accelFallback: false, cpuModel: o.cpuModel, whpxOpts: o.whpxOpts, console: o.endpoints.serial, name: 'devbox-tsc-calibration',
    });
    const h = await startVm({ qemu: o.qemu, args: plan.args, console: o.endpoints.serial, timeoutMs: o.timeoutMs || 60000 });
    const r = await h.done;
    // no exit marker: QEMU could not start with this accelerator (there is
    // no TCG fallback on purpose), crashed, or the boot timed out
    if (r.exitCode === null) {
      throw new Error('the calibration boot did not finish under ' + o.accel + (r.stderr ? ': ' + qemuErrorLines(r.stderr).slice(-2).join(' | ') : ''));
    }
    const out = fs.existsSync(plan.logs.stdout) ? fs.readFileSync(plan.logs.stdout, 'utf8') : '';
    return hostcpu.parseTscKhz(out) || hostcpu.parseTscKhz(r.output);
  } finally {
    // the calibration files are never needed again (bug 12e: 5.4 MB left behind)
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* busy: next setup */ }
  }
}

function readHostFacts(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file || CFG.hostFactsFile, 'utf8'));
    return c && c.version === HOST_FACTS_VERSION ? c : null;
  } catch (e) { return null; }
}

// Is a cached host.json valid for this QEMU and accelerator? Pure. WHPX
// needs the TSC frequency; TCG needs it to have been ATTEMPTED (a failed
// measurement is not repeated at every start: those runs use q35 instead).
function hostFactsValid(c, qemuVersion, accel, probeId) {
  return !!c && c.version === HOST_FACTS_VERSION && c.qemuVersion === qemuVersion && c.accel === accel &&
    (accel !== 'whpx' || !!c.tscKhz) && (accel !== 'tcg' || !!c.tscKhz || !!c.tscTried) &&
    // WHPX facts measured with another CPU setting than the host probe's are stale
    (accel !== 'whpx' || probeId === undefined || (c.probeId || null) === probeId);
}

// The host probe's WHPX setting (lib/hostprobe.js), or null when the probe has
// not run (or chose something else): {id, cpu, accelOpts}
function probedWhpx() {
  const b = require('../hostprobe').best();
  return b && b.accel === 'whpx' ? b : null;
}

// Where the facts of `accel` are cached: host.json for the detected
// (recommended) accelerator, host-<accel>.json for another one - a run the
// user pinned to TCG must not replace the WHPX facts. Pure.
function hostFactsFileFor(accel, detected, base) {
  const f = base || CFG.hostFactsFile;
  if (!accel || !detected || accel === detected) return f;
  return f.replace(/\.json$/i, '') + '-' + String(accel).replace(/[^a-z0-9]/gi, '') + '.json';
}

// {version, qemuVersion, accel, cpuModel, tscKhz, tscSource, features,
//  machines, createdAt}, cached in CFG.hostFactsFile (hostFactsFileFor).
// o: {kernelDir, manifest, t?, qemu?, accel? (default: the DETECTED one),
//     cacheFile?, endpoints? (default vm.runtimeEndpoints('_tsc')), force?,
//     calibrate? (tests: replaces calibrateTscKhz)}
// One measurement per facts file at a time: four TCG containers started
// together on a fresh PC must not run four calibration boots.
const factsInflight = new Map();
async function hostDefaults(o) {
  o = o || {};
  const platform = require('../platform');
  const qemu = o.qemu || platform.findTool('qemu');
  if (!qemu) throw new Error('QEMU is not installed');
  const detected = (await platform.detectAccel(qemu)).recommended || 'tcg';
  const accel = o.accel || detected;
  const qemuVersion = qemuVersionOf(qemu);
  const cacheFile = o.cacheFile || hostFactsFileFor(accel, detected);
  const cached = readHostFacts(cacheFile);
  const pw = accel === 'whpx' ? probedWhpx() : null;
  if (!o.force && hostFactsValid(cached, qemuVersion, accel, pw ? pw.id : null)) return cached;
  if (factsInflight.has(cacheFile)) return factsInflight.get(cacheFile);
  const p = computeHostFacts(o, { platform, qemu, detected, accel, qemuVersion, cacheFile });
  factsInflight.set(cacheFile, p);
  try { return await p; } finally { factsInflight.delete(cacheFile); }
}

async function computeHostFacts(o, c) {
  const { platform, qemu, detected, accel, qemuVersion, cacheFile } = c;
  const say = (m) => { if (o.t) o.t.log(m); };
  const calibrate = o.calibrate || calibrateTscKhz;
  const out = { version: HOST_FACTS_VERSION, qemuVersion, accel, cpuModel: null, tscKhz: null, tscSource: null, features: null, machines: qemuMachines(qemu) };
  const measure = async (cpuModel, why) => {
    try {
      const endpoints = o.endpoints || await require('../vm').runtimeEndpoints('_tsc');
      if (why) say(why);
      const khz = await calibrate({
        qemu, kernelDir: o.kernelDir, manifest: o.manifest, workDir: path.join(path.dirname(cacheFile), 'tsc-calibration'),
        accel, cpuModel, whpxOpts: out.whpxOpts, endpoints, timeoutMs: accel === 'tcg' ? 180000 : undefined,
      });
      if (khz) { out.tscKhz = khz; out.tscSource = 'q35 calibration boot' + (accel === 'tcg' ? ' (TCG)' : ''); }
    } catch (e) { out.tscError = String(e.message || e); say('TSC calibration failed: ' + out.tscError); }
    if (!out.tscKhz && platform.IS_WIN) {
      const mhz = await hostcpu.windowsNominalMhz();
      if (mhz) { out.tscKhz = mhz * 1000; out.tscSource = 'registry ~MHz (nominal)'; }
    }
  };
  if (accel === 'whpx') {
    out.features = await hostcpu.probeWindowsCpuFeatures();
    // the host probe's CPU model and WHPX options when it has run (it boots a
    // guest with each candidate: on some PCs the flag-based model panics the
    // guest kernel), else the model from the host's CPU flags
    const pw = probedWhpx();
    out.cpuModel = pw ? (pw.cpu || null) : hostcpu.whpxCpuModel(out.features);
    if (pw) { out.whpxOpts = pw.accelOpts || ''; out.probeId = pw.id; }
    await measure(out.cpuModel);
  } else if (accel === 'tcg') {
    // the host TSC rate: measured under the hardware accelerator if this PC
    // has one (same CPU, any QEMU version), else one q35 boot under TCG
    const hw = detected !== 'tcg' ? readHostFacts(o.hwFactsFile || hostFactsFileFor(detected, detected)) : null;
    if (hw && hw.tscKhz && hw.accel === detected) {
      out.tscKhz = hw.tscKhz;
      out.tscSource = 'host TSC (measured under ' + detected + ')';
    } else {
      await measure(undefined, 'Measuring this PC\'s clock for TCG microVMs (one short test boot, up to a minute without hardware acceleration)...');
    }
    out.tscTried = true;
  }
  out.createdAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
  fs.renameSync(tmp, cacheFile);
  say('Host facts: ' + accel + (out.cpuModel ? ', CPU model ' + out.cpuModel : '') + (out.tscKhz ? ', TSC ' + out.tscKhz + ' kHz (' + out.tscSource + ')' : '') +
    ', machines ' + (out.machines.join(', ') || 'unknown'));
  return out;
}

module.exports = {
  resolveArgv, mergeEnv, buildSpec, initrdKey, initrdFile, ensureImageInitrd, planRun, parseConsole,
  calibrateTscKhz, hostDefaults, hostFactsFileFor, readHostFacts, hostFactsValid, qemuVersionOf, qemuMachines, checkQemuPath,
  checkQemuPathRaw, recommendedMemMB, recommendedDiskMemMB, diskMemHint, ramAutoMemMB, INITRD_FORMAT, HOST_FACTS_VERSION, WIN_MAX_PATH,
  DISK_MIN_MEM_MB, RAM_MIN_MEM_MB, DISK_DEFAULT_MEM_MB,
};
