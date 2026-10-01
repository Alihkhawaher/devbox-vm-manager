'use strict';
/*
 * microVM containers: the registry (containers.json via store.js), the API
 * operations, the supervisor, the stop protocol and autostart (microVM spec
 * sections 6-11). One container = one OCI image run as its own headless
 * microVM (run.js); nothing here needs a Docker Engine.
 *
 * THIS FILE IS THE CONTRACT the rest of the app calls. The hooks are wired
 * into lib/http.js, lib/ports.js, lib/vm.js, lib/install.js and server.js
 * and keep their names and shapes:
 *
 * Manager lifecycle (server.js):
 *   load({pendingAdoption})    read containers.json (store.js); never throws.
 *                              pendingAdoption: operations on existing
 *                              records (start, stop, kill, remove, settings,
 *                              fallback, volume/image removal) wait until
 *                              adoptAll() has run (409 STARTING_UP after 15 s)
 *   adoptAll()                 async: re-attach watchers to containers that
 *                              kept running while the manager was down (pid
 *                              listed as a QEMU, equal to its qemu.pid, and
 *                              its monitor answering with the container's
 *                              -name); mark the others exited with what their
 *                              console says (spec 7.3); a QEMU proven (by its
 *                              command line) to be a container's but not
 *                              adoptable gets a "lost" record that can only
 *                              be stopped or removed
 *   autostartAll()             async: start autostart containers, one task
 *                              after another (like VM autostart)
 *   shutdown()                 stop the supervisors' timers only - the
 *                              containers keep running (like VMs)
 * Read-only views, cheap enough for every poll:
 *   summaries()                -> [{id, name, image, status, exitCode, ports,
 *                                 urls, mem, startedAt, busy, ...}] (/api/state)
 *   microvmStatus()            -> {ready, kver, accel, machine, reason, needsUpdate}
 *   reservedPorts(opts)        -> [{port, why}] every record's host ports
 *                              (and pendingPorts: edits of a running one)
 *   liveContainers()           -> [{id, name, status}] starting or running
 *   networkRows()              -> rows for vm.networkOverview
 *   runningContainers(pids?)   -> async [{id, name, pid}] whose QEMU runs
 *   stateWarning()             -> text or null
 * API operations (lib/microvm/routes.js): listContainers, getContainer,
 *   getLogs, streamLogs, runRoute, validateStart/opStart,
 *   validateStop/opStop, kill, removeRoute, updateSettings, fallbackRoute,
 *   listVolumes, createVolume, removeVolume, validatePull/opPull,
 *   removeImageRoute, validatePrune/opPrune.
 *
 * STATUS MACHINE (spec 6.2)
 *   created -> preparing (pull, flatten, volumes, ports) -> booting (QEMU
 *   spawned) -> running (__DEVBOX_READY) -> stopping -> exited (exitCode)
 *   Any failure -> error. exited/error records keep their logs and ports
 *   until Remove, as in Docker (bug V11a); autoRemove (--rm) removes them.
 * EXIT CODES are Docker's (spec 6.3): the app's own 0-255 (128+N = killed
 *   by signal N), 126/127 from init with the reason, 125 = the engine
 *   failed (no exit marker, kernel panic, QEMU failed, boot timeout, a
 *   volume/copy-in/shared folder could not be set up), null = stopped
 *   before the app started, or stopped outside the manager.
 *
 * ONE SOURCE OF TRUTH (bug V11c): the supervisor writes the outcome into
 * the record; the run and stop tasks only read it.
 *
 * THE STOP PROTOCOL (spec 7.4; bugs V2, V5, V11b): a stop is its own task
 * (lock ctr-stop:<id>), accepted while the run task still pulls or boots.
 *   - not spawned yet: the run task is aborted (its pull too); the record
 *     ends "stopped before the app started" and no VM is created;
 *   - spawned: "__DEVBOX_STOP <timeout>" (or "__DEVBOX_KILL KILL" when
 *     forced) is sent over a short console connection EVERY SECOND until
 *     the guest acknowledges with __DEVBOX_STOPPING (or exits) - a socket
 *     write is not a delivery; when the console cannot be reached for 3 s
 *     the ACPI power button is pressed (HMP system_powerdown);
 *   - then timeout + 5 s for __DEVBOX_EXIT; else "__DEVBOX_KILL KILL" and
 *     5 s more - init still syncs, trims and unmounts the volumes;
 *   - only then HMP quit, and a kill of the pid if it is still a QEMU. A
 *     timeout is therefore SIGKILL after N s, never a power cut (bug V5).
 *   The result says honestly how it went: graceful | killed after N s |
 *   killed (force) | forced (quit) | stopped before the app started |
 *   already exited.
 *
 * VOLUMES are exclusive (bug V1): the start re-reads the registry after the
 * slow image preparation and takes <name>.lock (volumes.js) - QEMU does not
 * lock images on Windows.
 * ROOT FILE SYSTEM (record.rootfs, chosen at run time: the request's
 * `rootfs`, else config.json microvmRootfs, else disk - never switched to
 * RAM automatically):
 *   disk  the image stays on its shared, read-only image disk (rootdisk.js)
 *         and the container writes into its own overlay, microvms/<id>/
 *         root.qcow2 - created at its first start, KEPT across stops and
 *         restarts (Docker's writable layer), deleted with the record, by
 *         start {fresh: true}, or at the first start after a switch to ram.
 *         Once the overlay exists the container stays bound to its image by
 *         config digest (record.rootDisk): a restart never re-resolves the
 *         tag. Guest RAM: record.mem, else CFG.microvmMemMB (128).
 *   ram   the whole image in guest RAM (the v2.0 engine), reset at every
 *         start; opt-in only.
 * LIVE SHARED FOLDERS (SPEC-shares section 4): a host folder in `volumes`
 * is served by the manager's 9P server (lib/shares.js registerFor at start,
 * disconnect + unregister after QEMU exits); init mounts it before the app
 * starts and fails the start (125, with the reason) when it cannot. The
 * share records {hostPath, guestPath, readOnly, id, secret} live in the
 * container record; secrets never leave the registry file and the private
 * fw_cfg file (never an API reply, a log or a command line).
 *
 * Nothing runs at require time.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const { CFG } = require('../config');
const { state } = require('../state');
const platform = require('../platform');
const tasks = require('../tasks');
const store = require('./store');
const { ApiError, badRequest, conflict, errMsg, log, logError, sleep, toBool, intInRange, networkPathError } = require('../util');

// Heavy or cyclic modules are loaded on first use (ports.js requires this
// file lazily too), so requiring this file stays cheap.
const lazy = (p) => { let m = null; return () => m || (m = require(p)); };
const runMod = lazy('./run');
const planMod = lazy('./plan');
const kernelMod = lazy('./kernel');
const volumesMod = lazy('./volumes');
const copyinMod = lazy('./copyin');
const compatMod = lazy('./compat');
const factsMod = lazy('./facts');
const validateMod = lazy('./validate');
const logsMod = lazy('./logs');
const initramfsMod = lazy('./initramfs');
const imagesMod = lazy('../oci/images');
const registryMod = lazy('../oci/registry');
const sharesMod = lazy('../shares');
const rootdiskMod = lazy('./rootdisk');
const portsMod = lazy('../ports');
const routeMod = lazy('../route');
const monitorMod = lazy('../monitor');

const LIVE_STATUSES = ['preparing', 'booting', 'running', 'stopping'];
const MAX_INIT_MESSAGES = 20;
const MAX_CONSOLE_LINES = 30;
const BOOT_TIMEOUT_S = { tcg: 240, other: 90 };
const SHARE_DIR = '/.devbox/shares/';
const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// the live side: one Live per container that is starting or running
// ---------------------------------------------------------------------------
class Live extends EventEmitter {
  constructor(id) {
    super();
    this.setMaxListeners(100);
    this.id = id;
    this.phase = 'preparing';        // preparing -> spawned -> ended
    this.ac = new AbortController();
    this.rt = null;                  // runtime (with child when spawned here)
    this.child = null;
    this.childExited = false;
    this.watcher = null;
    this.bootTimer = null;
    this.markers = {};
    this.ack = false;                // __DEVBOX_STOPPING seen
    this.ready = false;
    this.readyAt = null;
    this.initAt = null;
    this.exitSeen = false;
    this.ended = false;
    this.errorText = null;           // __DEVBOX_ERROR=<text>
    this.console = [];               // last console lines
    this.initMessages = [];
    this.volumeLocks = [];
    this.sharesRegistered = false;
    this.forced = false;
    this.bootTimedOut = false;
    this.result = null;
    this.endedP = new Promise((r) => { this.resolveEnded = r; });
    this.spawnedP = new Promise((r) => { this.resolveSpawned = r; });
  }
  changed() { this.emit('change'); }
  // resolves true once pred() holds, false after ms (undefined = no limit)
  waitFor(pred, ms) {
    if (pred()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (v) => { clearTimeout(timer); this.removeListener('change', check); resolve(v); };
      const check = () => { if (pred()) done(true); };
      this.on('change', check);
      if (ms !== undefined && ms !== Infinity) timer = setTimeout(() => done(!!pred()), Math.max(0, ms));
    });
  }
}

const lives = new Map();       // id -> Live
const releasing = new Set();   // ids whose ports are being handed to a Docker VM (fallback)
let pruneTimer = null;         // the image auto-prune (armAutoPrune)

// Until adoptAll() has looked at the records that kept running while no
// manager watched them, `lives` does not know them: a Start would boot a
// second QEMU on the same volume, a Stop would answer "already exited" and
// leave the VM running, a Remove would drop a running record (correct-4).
// The server starts listening before adoption finishes (it waits for the
// VMs' tasklist first), so operations on EXISTING records wait for it here.
// load({pendingAdoption: true}) arms the gate; adoptAll() opens it.
let adoptGate = null;          // {promise, open, done}
const ADOPT_WAIT_MS = 15000;
function armAdoptGate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  adoptGate = { promise, open: () => { adoptGate.done = true; open(); }, done: false };
}
async function whenAdopted(ms) {
  const g = adoptGate;
  if (!g || g.done) return;
  let timer;
  const ok = await Promise.race([g.promise.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), ms === undefined ? ADOPT_WAIT_MS : ms); })]);
  clearTimeout(timer);
  if (!ok) throw new ApiError(409, 'STARTING_UP', 'the manager is still checking the containers that kept running while it was away - try again in a few seconds');
}

const isLive = (id) => lives.has(id);
const runDirOf = (id) => path.join(CFG.microvmsDir, id);
const logsOf = (id) => {
  const d = runDirOf(id);
  return { console: path.join(d, 'console.log'), stdout: path.join(d, 'stdout.log'), stderr: path.join(d, 'stderr.log'), qemu: path.join(d, 'qemu.log') };
};
const nameOf = (id) => { const r = store.get(id); return r ? r.name : null; };
const overlayOf = (id) => path.join(runDirOf(id), 'root.qcow2');
// the root file system a record runs with (a record of v2.0.0 has none: disk)
const rootfsOf = (rec) => (rec && rec.rootfs === 'ram' ? 'ram' : 'disk');
function sizeOrNull(f) { try { return fs.statSync(f).size; } catch (e) { return null; } }

function save() { return store.save(); }

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
// opts.pendingAdoption: the caller runs adoptAll() later (server.js) - until
// it has, operations on existing records wait for it (correct-4)
function load(opts) {
  try { store.load(); }
  catch (e) { log('containers.json could not be loaded: ' + (e && e.message)); }
  if (opts && opts.pendingAdoption) armAdoptGate();
  return store.data;
}

function shutdown() {
  clearTimeout(pruneTimer);
  pruneTimer = null;
  for (const L of lives.values()) {
    clearTimeout(L.bootTimer);
    if (L.watcher) { try { L.watcher.stop(); } catch (e) { /* stopped */ } }
  }
  lives.clear();
}

// Computed from the records every time: once a lost VM is stopped or its
// record removed, the note goes away (correct-13).
function lostNote() {
  const lost = store.list().filter((r) => r.lost && r.runtime && r.runtime.pid);
  if (!lost.length) return null;
  return lost.length + ' microVM(s) are still running without supervision (' + lost.map((r) => r.name).join(', ') + ') - stop them in Containers';
}

function stateWarning() {
  const w = [store.warning(), lostNote()].filter(Boolean);
  return w.length ? w.join(' | ') : null;
}

// ---------------------------------------------------------------------------
// read-only views
// ---------------------------------------------------------------------------
function urlsOf(rec) {
  return (rec.ports || []).filter((p) => (p.proto || 'tcp') === 'tcp').map((p) => {
    const u = { url: 'http://127.0.0.1:' + p.host + '/', hostPort: p.host, lan: !!p.lan };
    if (p.lan) u.lanUrls = platform.lanAddresses().map((a) => 'http://' + a + ':' + p.host + '/');
    return u;
  });
}

// env values are secrets: never in a summary (spec 6.1)
function summaries() {
  return store.list().map((r) => ({
    id: r.id, name: r.name, image: r.image, status: r.status || 'created', exitCode: r.exitCode === undefined ? null : r.exitCode,
    exitReason: r.exitReason || null,
    ports: (r.ports || []).map((p) => ({ host: p.host, guest: p.guest, proto: p.proto || 'tcp', lan: !!p.lan })),
    urls: (r.ports || []).filter((p) => (p.proto || 'tcp') === 'tcp').map((p) => ({ url: 'http://127.0.0.1:' + p.host + '/', hostPort: p.host, lan: !!p.lan })),
    mem: r.runtime && r.runtime.memMB ? r.runtime.memMB : (r.mem || null),
    startedAt: r.startedAt || null, readyAt: r.readyAt || null, endedAt: r.endedAt || null,
    busy: tasks.ctrBusy(r.id),
    ephemeral: !!r.ephemeral, autostart: !!r.autostart, autoRemove: !!r.autoRemove, createdBy: r.createdBy || null,
    pendingRestart: !!r.pendingRestart, lost: !!r.lost,
    accel: r.runtime ? r.runtime.effectiveAccel || r.runtime.accel : null,
    fallback: r.fallback ? Object.assign({ engine: r.fallback.engine, code: r.fallback.code, reason: r.fallback.reason }, Number.isInteger(r.fallback.memMB) ? { memMB: r.fallback.memMB } : {}) : null,
    // ports edited while it runs: published at its next start (correct-8)
    pendingPorts: Array.isArray(r.pendingPorts) ? r.pendingPorts.map((p) => ({ host: p.host, guest: p.guest, proto: p.proto || 'tcp', lan: !!p.lan })) : null,
    volumes: (r.volumes || []).map((v) => ({ name: v.name, target: v.target, readonly: !!v.readonly })),
    shares: (r.shares || []).map((s) => ({ id: s.id, hostPath: s.hostPath, guestPath: s.guestPath, readOnly: !!s.readOnly })),
    // disk root: the writable layer's file size (one stat per record and poll)
    rootfs: rootfsOf(r),
    rootDiskBytes: rootfsOf(r) === 'disk' ? sizeOrNull(overlayOf(r.id)) : null,
    // QEMU paused it: the host disk is full (checkPaused, cr-6)
    paused: r.paused && r.paused.reason ? r.paused.reason : null,
  }));
}

function microvmStatus() {
  const kernel = kernelMod();
  const plan = planMod();
  const k = kernel.kernelStatus();
  const facts = plan.readHostFacts();
  const qemu = platform.findTool('qemu');
  let reason = null;
  if (!qemu) reason = 'QEMU is not installed';
  else if (!k.installed) reason = 'the microVM kernel is not installed (Setup: "Set up for Docker images")';
  else if (!k.ok) reason = 'the microVM kernel does not verify: ' + k.error;
  else if (k.needsUpdate) reason = 'the microVM kernel is ready but misses newer features (' + (k.missingFeatures || []).join(', ') + '): update it in Setup for shared folders';
  const machine = facts && Array.isArray(facts.machines) && facts.machines.length
    ? (facts.machines.indexOf('microvm') >= 0 ? 'microvm' : 'q35') : null;
  return {
    ready: !!(qemu && k.ok), kver: k.kver || null, accel: facts ? facts.accel : null, machine,
    reason, needsUpdate: !!k.needsUpdate,
    // what a run gets when it does not say (config.json / the light profile)
    defaults: {
      rootfs: validateMod().effectiveRootfs(null), memMB: plan.recommendedDiskMemMB(), minMemMB: plan.DISK_MIN_MEM_MB,
      ramMinMemMB: plan.RAM_MIN_MEM_MB,
      tcgTbSizeMB: Number.isInteger(CFG.tcgTbSizeMB) && CFG.tcgTbSizeMB >= 0 ? CFG.tcgTbSizeMB : require('./qemu-args').TCG_TB_SIZE_MB,
    },
    lightProfile: !!CFG.lightProfile,
  };
}

// opts: {exceptContainer: id} (its own ports are being replaced)
// A running container whose ports were edited holds BOTH lists until its
// next start: QEMU still binds the old ports, the new ones are promised
// (correct-8).
function reservedPorts(opts) {
  opts = opts || {};
  const out = [];
  for (const r of store.list()) {
    if (r.id === opts.exceptContainer || releasing.has(r.id)) continue;
    for (const p of r.ports || []) {
      if (p && p.host) out.push({ port: p.host, why: 'a published port of container "' + r.name + '"' });
    }
    for (const p of Array.isArray(r.pendingPorts) ? r.pendingPorts : []) {
      if (p && p.host) out.push({ port: p.host, why: 'a port container "' + r.name + '" publishes at its next start' });
    }
  }
  return out;
}

// Containers that are starting or running in this manager (a QEMU update
// must wait for them: correct-18) -> [{id, name, status}]
function liveContainers() {
  return store.list().filter((r) => isLive(r.id)).map((r) => ({ id: r.id, name: r.name, status: r.status }));
}

function networkRows() {
  const rows = [];
  for (const r of store.list()) {
    for (const p of r.ports || []) {
      rows.push({ vm: null, container: r.id, kind: 'container', host: p.host, guest: p.guest, proto: p.proto || 'tcp', lan: !!p.lan, owner: 'container ' + r.name, pid: r.runtime ? r.runtime.pid : null });
    }
  }
  return rows;
}

// pids: an optional Set from platform.listQemuPids() (one listing per poll)
async function runningContainers(pids) {
  const withRt = store.list().filter((r) => r.runtime && r.runtime.pid);
  if (!withRt.length) return [];
  const set = pids || await platform.listQemuPids();
  return withRt.filter((r) => (set ? set.has(r.runtime.pid) : platform.pidAlive(r.runtime.pid)))
    .map((r) => ({ id: r.id, name: r.name, pid: r.runtime.pid }));
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------
const noSuch = (q) => new ApiError(404, 'NO_SUCH_CONTAINER', 'no container "' + String(q).slice(0, 80) + '"');

// An id, a name, or a unique id prefix of 3+ characters (spec 6.1).
function findRecord(q) {
  if (q === undefined || q === null || q === '') throw badRequest('id is required (a container id, name or id prefix)');
  const s = String(q);
  const byId = store.get(s);
  if (byId) return byId;
  const all = store.list();
  const byName = all.find((r) => r.name === s);
  if (byName) return byName;
  if (/^[0-9a-f]{3,11}$/.test(s)) {
    const m = all.filter((r) => r.id.startsWith(s));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw badRequest('"' + s + '" matches ' + m.length + ' containers - use more of the id');
  }
  throw noSuch(s);
}

function redact(e) {
  const s = String(e);
  const i = s.indexOf('=');
  return i < 0 ? s : s.slice(0, i + 1) + '***';
}

// What the API shows of a record: env values only with reveal, never a
// share secret, never the private control endpoints.
function publicRecord(rec, o) {
  o = o || {};
  const out = Object.assign({}, rec);
  out.env = (rec.env || []).map((e) => (o.reveal ? e : redact(e)));
  out.shares = (rec.shares || []).map((s) => ({ id: s.id, hostPath: s.hostPath, guestPath: s.guestPath, readOnly: !!s.readOnly }));
  if (rec.runtime) {
    const rt = rec.runtime;
    // a runtime from a v2.0 manager has no rootfs: it booted a RAM root
    out.runtime = { pid: rt.pid, startedAt: rt.startedAt, accel: rt.accel, effectiveAccel: rt.effectiveAccel, machine: rt.machine, memMB: rt.memMB, cpus: rt.cpus, rootfs: rt.rootfs === 'disk' ? 'disk' : 'ram' };
  }
  out.rootfs = rootfsOf(rec);
  out.rootDisk = rec.rootDisk && typeof rec.rootDisk === 'object'
    ? Object.assign({}, rec.rootDisk, { overlayBytes: sizeOrNull(overlayOf(rec.id)) }) : null;
  delete out.stopRequest;
  out.urls = urlsOf(rec);
  out.busy = tasks.ctrBusy(rec.id);
  return out;
}

function nameTaken(name, exceptId) {
  return store.list().some((r) => r.id !== exceptId && r.name.toLowerCase() === String(name).toLowerCase());
}

function uniqueId() {
  for (;;) {
    const id = store.newId();
    if (!store.get(id) && !fs.existsSync(runDirOf(id))) return id;
  }
}

function defaultName(familiar, id) {
  const base = runMod().imageBaseName(familiar).replace(/^[^A-Za-z0-9]+/, '') || 'ctr';
  for (let n = 4; n <= 12; n++) {
    const name = (base.slice(0, 50) + '-' + id.slice(0, n));
    if (!nameTaken(name)) return name;
  }
  return 'ctr-' + id;
}

// The microVM engine can start anything at all: QEMU and a kernel.
function requireEngineReady() {
  if (!platform.findTool('qemu')) {
    throw new ApiError(409, 'PREREQ_MISSING', 'QEMU is not installed - ' + platform.installHints().qemu, { action: 'install-qemu' });
  }
  if (!kernelMod().findKernelDir()) {
    throw new ApiError(409, 'NO_KERNEL', 'the microVM kernel is not installed yet - run Setup ("Set up for Docker images", about a minute)', { action: 'install-kernel' });
  }
}

function portInUse(port) {
  return new ApiError(409, 'PORT_CONFLICT', 'host port ' + port + ' is in use by another program on this PC (on 127.0.0.1 or 0.0.0.0) - pick another port');
}

// Every host port of `list` against everything the manager has promised.
function checkReserved(list, id) {
  const reserved = portsMod().reservedPorts({ exceptContainer: id });
  for (const p of list || []) {
    const why = reserved.get(p.host);
    if (why) throw new ApiError(409, 'PORT_CONFLICT', 'host port ' + p.host + ' is already used by ' + why);
  }
}

async function checkFree(list) {
  for (const p of list || []) {
    if ((p.proto || 'tcp') !== 'tcp') continue;
    if (!(await platform.isPortFree(p.host))) throw portInUse(p.host);
  }
}

// lib/shares.validateShare's host-side checks for a folder that will be
// shared or copied in (exists, is a folder, not the data root, not a system
// folder); the guest path given there is a placeholder - container targets
// follow Docker's rules (validate.js), not a full VM's.
function validateHostDir(hostPath, what) {
  try {
    const r = sharesMod().validateShare({ hostPath, guestPath: '/devbox-check', readOnly: false }, { existing: [], dataRoot: CFG.root });
    return { hostPath: r.share.hostPath, warnings: r.warnings || [] };
  } catch (e) {
    throw new ApiError(e.status || 400, e.status && e.code ? e.code : 'BAD_REQUEST', (what ? what + ': ' : '') + errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// run (create + start)
// ---------------------------------------------------------------------------
async function runRoute(body) {
  body = body || {};
  const V = validateMod();
  const compat = compatMod();
  const engine = String(body.engine || 'auto').toLowerCase();
  if (!V.ENGINES.includes(engine)) throw badRequest('engine must be auto, microvm or docker-vm');
  // a bad rootfs is a 400 on EVERY engine (cov-7): Docker-in-VM ignores the
  // field, but a request that goes there must not pass with a value the
  // microVM engine refuses
  V.rootfsField(body.rootfs);
  const req = compat.requestRules(body);
  if (req && req.error) throw new ApiError(req.error.status, req.error.code, req.error.message);
  const ref = V.imageRef(body.image);
  if (engine === 'docker-vm') return dockerVmRoute(body, 'engine "docker-vm" was requested');
  if (req) {
    // decided from the request alone, before any work: Docker-in-VM
    if (engine === 'auto') return dockerVmRoute(body, req.reason);
    throw new ApiError(409, 'NOT_COMPATIBLE', req.reason + ' - use engine "docker-vm" or "auto"', { fallback: { engine: 'docker-vm', code: req.code, reason: req.reason } });
  }
  // the request is checked BEFORE the engine's readiness: a bad field is a
  // 400 on every PC, not a 409 NO_KERNEL that changes to a 400 after Setup
  const defaultLan = !!(state.settings && state.settings.defaultExpose === 'lan');
  const f = V.runFields(body, { defaultLan });
  const m = V.mountsField(body, { validateHostDir, maxShares: sharesMod().MAX_SHARES || 8 });
  requireEngineReady();
  tasks.assertFree('qemu');
  // everything below up to store.put is synchronous: two runs with the same
  // name or port cannot both pass
  if (f.name && nameTaken(f.name)) throw conflict('a container called "' + f.name + '" already exists', 'NAME_IN_USE');
  if (f.ports) checkReserved(f.ports, null);
  const id = uniqueId();
  const rec = {
    id, name: f.name || defaultName(ref.familiar, id), image: String(body.image).trim(), reference: ref.canonical,
    manifestDigest: null, configDigest: null,
    createdAt: iso(), createdBy: f.createdBy, ephemeral: f.ephemeral, autoRemove: f.autoRemove, autostart: f.autostart, note: f.note,
    engine: engine === 'microvm' ? 'microvm' : 'auto',
    cmd: f.cmd, entrypoint: f.entrypoint, env: f.env, workdir: f.workdir, user: f.user, hostname: f.hostname,
    ports: f.ports, lan: f.lan,
    volumes: m.volumes, shares: [], copyIn: m.copyIn, copyInOwner: f.copyInOwner,
    network: f.network, mem: f.mem, cpus: f.cpus, accel: f.accel, machine: f.machine,
    stopSignal: f.stopSignal, stopTimeout: f.stopTimeout, pull: f.pull,
    // an omitted rootfs takes the global setting NOW (then it is the record's)
    rootfs: V.effectiveRootfs(f.rootfs), rootDisk: null,
    status: 'created', exitCode: null, exitReason: null, initMessages: [],
    startedAt: null, readyAt: null, endedAt: null, lastError: null, warnings: m.warnings.slice(), fallback: null,
    stopRequest: null, runtime: null, timings: null, pendingRestart: false,
  };
  // the share records get their id and secret now (lib/shares.js)
  for (const s of m.shares) rec.shares.push(sharesMod().newShare(s, id, rec.shares));
  store.put(rec);
  try {
    if (rec.ports) await checkFree(rec.ports);
  } catch (e) { store.remove(id); throw e; }
  save();
  let task;
  try {
    task = tasks.start({ kind: 'ctr-run', title: 'Run ' + rec.image + ' (' + rec.name + ')', ctr: id, locks: ['ctr:' + id] }, (t) => opRun(t, { id, name: rec.name }));
  } catch (e) { store.remove(id); save(); throw e; }
  return routeMod().accepted(task, {
    engine: 'microvm',
    reason: engine === 'auto' ? 'nothing in the request needs Docker: it runs as its own microVM (the image is checked before it boots)' : 'engine "microvm" was requested',
    container: { id, name: rec.name },
  });
}

// The quick-deploy body for a run request (or a container record) that goes
// to Docker inside a full VM. Named volumes stay Docker named volumes in the
// VM: they keep the copy-up semantics the microVM gave them.
function quickDeployBody(src, o) {
  o = o || {};
  const V = validateMod();
  const lan = src.lan === undefined || src.lan === null ? !!(state.settings && state.settings.defaultExpose === 'lan') : toBool(src.lan, false);
  const ports = Array.isArray(src.ports) && src.ports.length && typeof src.ports[0] === 'object' && 'auto' in src.ports[0]
    ? src.ports : (V.portsField(src.ports, { defaultLan: lan }) || []);
  const env = Array.isArray(src.env) && src.env.every((e) => typeof e === 'string' && e.indexOf('=') > 0) ? src.env : V.envField(src.env);
  const volumes = [];
  const skipped = [];
  const mounts = o.mounts || V.mountsField({ volumes: src.volumes, copyIn: src.copyIn }, {});
  for (const v of mounts.volumes) volumes.push(v.name + ':' + v.target + (v.readonly ? ':ro' : ''));
  for (const s of mounts.shares) skipped.push('the shared folder ' + s.hostPath + ' -> ' + s.guestPath);
  for (const c of mounts.copyIn) skipped.push('the copy-in folder ' + c.hostDir + ' -> ' + c.target);
  const body = {
    // proto kept: a UDP publish must stay UDP in the Docker VM
    image: src.image, ports: ports.map((p) => Object.assign({ host: p.host, guest: p.guest, lan: !!p.lan }, p.proto === 'udp' ? { proto: 'udp' } : {})), env, volumes, lan,
    privileged: toBool(src.privileged, false), hostNetwork: toBool(src.hostNetwork, false),
    keepOnFailure: toBool(src.keepOnFailure, false), ephemeral: toBool(src.ephemeral, false),
    createdBy: V.createdByOf(src.createdBy),
  };
  if (src.restartPolicy) body.restartPolicy = String(src.restartPolicy);
  if (o.vmName) body.name = o.vmName;
  return { body, skipped };
}

async function dockerVmRoute(body, reason) {
  const deploy = require('../deploy');
  const q = quickDeployBody(body);
  if (q.skipped.length) {
    throw badRequest('Docker-in-VM cannot use ' + q.skipped.join(', ') + ' (host folders are shared with microVM containers only) - use a named volume, or engine "microvm"');
  }
  const vmName = typeof body.name === 'string' && require('../util').isVmName(body.name) ? body.name : undefined;
  if (vmName) q.body.name = vmName;
  const a = await deploy.validateQuickDeploy(q.body);
  const task = routeMod().startTask({ kind: 'quickdeploy', title: 'New VM ' + a.name + ' from ' + a.image, vm: a.name, locks: ['vm:' + a.name] },
    (t) => deploy.opQuickDeploy(t, a), a);
  return routeMod().accepted(task, { engine: 'docker-vm', reason, vm: a.name });
}

async function opRun(t, a) { return startFlow(t, a.id, { first: true }); }

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
// The ports the NEXT start publishes: an edit made while it ran, else the
// current list (null = the image's EXPOSE ports)
const nextPorts = (rec) => (Array.isArray(rec.pendingPorts) ? rec.pendingPorts : rec.ports);

async function validateStart(body) {
  body = body || {};
  await whenAdopted();
  const rec = findRecord(body.id);
  if (isLive(rec.id)) throw conflict('container "' + rec.name + '" is already running or starting', 'RUNNING');
  if (rec.lost) throw conflict('this container runs without supervision (its record was lost, or the manager stopped while it started); it can only be stopped or removed', 'LOST');
  requireEngineReady();
  tasks.assertFree('qemu');
  checkReserved(nextPorts(rec), rec.id);
  await checkFree(nextPorts(rec));
  // fresh: drop the writable layer first (disk root; a RAM root resets anyway)
  return { id: rec.id, name: rec.name, fresh: toBool(body.fresh, false) };
}

// Delete a container's writable layer (inside its ctr:<id> task only).
function dropOverlay(rec) {
  const f = overlayOf(rec.id);
  try { fs.rmSync(f, { force: true }); }
  catch (e) { throw new ApiError(409, 'RUNNING', 'the writable layer of container "' + rec.name + '" is open in another program (' + (e.code || errMsg(e)) + ')'); }
  const had = !!rec.rootDisk;
  rec.rootDisk = null;
  save();
  return had;
}

async function opStart(t, a) {
  const rec = store.get(a.id);
  if (rec && a.fresh) {
    dropOverlay(rec);
    t.log('Started fresh: changes outside volumes were dropped (the image is looked up again)');
  } else if (rec && rec.status === 'exited' && rec.endedAt) {
    if (rootfsOf(rec) === 'ram') t.log('Files changed outside volumes and shared folders were reset: the root file system of this container is RAM');
    else if (fs.existsSync(overlayOf(rec.id))) t.log('Files changed outside volumes are kept (its writable layer) until the container is removed or started fresh');
  }
  return startFlow(t, a.id, { first: false });
}

class Aborted extends Error { constructor() { super('stopped before the app started'); this.code = 'ABORTED'; } }
const isAbort = (e) => e && (e.code === 'ABORTED' || e instanceof Aborted);

function fallbackError(fb) {
  return new ApiError(409, 'NOT_COMPATIBLE', 'not compatible with the microVM engine: ' + fb.reason + ' - use "Run with Docker-in-VM instead" (POST /api/container/fallback)', { fallback: fb });
}

// Registry errors become task errors whose message names the problem.
function prepareError(e, rec) {
  if (isAbort(e)) return e;
  const c = e && e.code;
  if (c === 'UNAUTHORIZED') return new ApiError(404, 'IMAGE_NOT_FOUND', rec.image + ': the repository does not exist or needs a login (UNAUTHORIZED)');
  if (c === 'NOT_FOUND') return new ApiError(404, 'IMAGE_NOT_FOUND', errMsg(e) + ' (NOT_FOUND: no such tag)');
  if (c === 'NOT_PRESENT') return new ApiError(409, 'NOT_PRESENT', errMsg(e));
  // disk root (and the free-space checks of both roots)
  if (c === 'NO_SPACE' || c === 'IMAGE_GONE' || c === 'ROOT_DISK_MISSING' || c === 'IMAGE_TOO_LARGE' || c === 'KERNEL_UPDATE') {
    if (e instanceof ApiError) return e;
    const extra = {};
    if (e.hint) extra.hint = e.hint;
    if (e.action) extra.action = e.action;
    return new ApiError(409, c, errMsg(e), extra);
  }
  if (c === 'RATE_LIMITED') return new ApiError(429, 'RATE_LIMITED', errMsg(e), { rateLimit: e.rateLimit || null });
  if (c === 'NO_PLATFORM') return new ApiError(409, 'NO_PLATFORM', errMsg(e) + ' (both engines run linux/amd64 images only)');
  if (c === 'ZSTD_UNSUPPORTED') {
    const fb = { engine: 'docker-vm', code: 'ZSTD_UNSUPPORTED', reason: 'the image has zstd-compressed layers, which this Node (' + process.versions.node + ') cannot unpack' };
    return rec.engine === 'microvm'
      ? new ApiError(409, 'ZSTD_UNSUPPORTED', errMsg(e), { hint: 'Node 22.15+ or use the Docker VM engine' })
      : fallbackError(fb);
  }
  if (c && /^[A-Z_]+$/.test(c) && !e.status) return Object.assign(new Error(c + ': ' + errMsg(e)), { code: c });
  return e;
}

function memoryInUse() {
  const rows = [];
  for (const name of Object.keys(state.vms || {})) {
    const vm = state.vms[name];
    if (vm && vm.runtime && vm.runtime.pid && platform.pidAlive(vm.runtime.pid)) rows.push('VM "' + name + '" ' + vm.mem + ' MB');
  }
  for (const r of store.list()) if (isLive(r.id) && r.runtime && r.runtime.memMB) rows.push('container "' + r.name + '" ' + r.runtime.memMB + ' MB');
  return rows;
}

async function chooseAccel(rec) {
  if (rec.accel && rec.accel !== 'auto') return rec.accel;
  const g = state.settings && state.settings.accel;
  if (g && g !== 'auto') return g;
  const d = await platform.detectAccel();
  return d.recommended || 'tcg';
}

function preferredHostPort(guest) {
  if (guest >= 1024) return guest;
  if (guest === 80) return 8080;
  if (guest === 443) return 8443;
  return 8000 + guest;
}

function readTail(file, bytes) {
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, st.size - n);
      return b.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}

// o: {first: the ctr-run task (pull policy as requested, engine rules as
// requested) | a later start}
async function startFlow(t, id, o) {
  o = o || {};
  const rec0 = store.get(id);
  if (!rec0) throw noSuch(id);
  if (isLive(id)) throw conflict('container "' + rec0.name + '" is already running or starting', 'RUNNING');
  const L = new Live(id);
  lives.set(id, L);
  // ports edited while it ran apply now (validateStart checked them)
  if (Array.isArray(rec0.pendingPorts)) { rec0.ports = rec0.pendingPorts; delete rec0.pendingPorts; }
  Object.assign(rec0, {
    status: 'preparing', exitCode: null, exitReason: null, initMessages: [], startedAt: iso(), readyAt: null, endedAt: null,
    lastError: null, fallback: null, stopRequest: null, runtime: null, pendingRestart: false, timings: {},
  });
  delete rec0.paused;
  rec0.warnings = (o.first ? rec0.warnings || [] : []).slice();
  save();
  const t0 = Date.now();
  try {
    await prepareAndLaunch(t, L, o, t0);
  } catch (e) {
    releaseResources(L);
    lives.delete(id);
    L.phase = 'ended';
    L.ended = true;
    const r = store.get(id);
    const stopped = isAbort(e) || L.ac.signal.aborted;
    const msg = stopped ? 'stopped before the app started' : errMsg(e);
    if (r) {
      r.status = stopped ? 'exited' : 'error';
      r.exitCode = stopped || e.fallback ? null : 125;
      r.exitReason = msg;
      r.lastError = stopped ? null : msg;
      r.fallback = e.fallback || null;
      r.endedAt = iso();
      r.stopRequest = null;
      r.runtime = null;
      if (r.autoRemove && stopped) removeRecord(r);
      save();
    }
    L.result = { exitCode: stopped ? null : (e.fallback ? null : 125), exitReason: msg, stopped, how: stopped ? 'stopped before the app started' : null };
    L.resolveEnded(L.result);
    L.resolveSpawned();
    L.changed();
    if (stopped) {
      t.log('Stopped before the app started - no VM was left running');
      return { container: { id, name: rec0.name }, engine: 'microvm', status: 'exited', exitCode: null, stopped: true, exitReason: msg };
    }
    throw e;
  }
  // spawned: wait for the app to start (or for the end)
  t.step('Booting the microVM...');
  await L.waitFor(() => L.ready || L.ended);
  const rec = store.get(id);
  const summary = () => ({ container: { id, name: rec0.name }, engine: 'microvm' });
  if (!L.ready) {
    const r = L.result || {};
    if (r.stopped || r.exitCode === null) {
      t.log('Stopped before the app started');
      return Object.assign(summary(), { status: 'exited', exitCode: null, stopped: true, exitReason: r.exitReason || 'stopped before the app started' });
    }
    const err = new ApiError(500, 'CONTAINER_FAILED', 'the container stopped before its app started (exit code ' + r.exitCode + '): ' + (r.exitReason || 'see the console log'));
    if (r.fallback) err.fallback = r.fallback;
    throw err;
  }
  if (rec && rec.timings) t.log('Ready in ' + ((L.readyAt - t0) / 1000).toFixed(1) + ' s');
  const tcp = ((rec && rec.ports) || []).filter((p) => (p.proto || 'tcp') === 'tcp');
  if (tcp.length && !L.ended) {
    t.step('Waiting for the app to answer on port ' + tcp[0].host + '...');
    const tp = Date.now();
    const ok = await waitAnswer(tcp[0].host, 20000, () => L.ended);
    const r = store.get(id);
    if (ok && r) { r.timings = Object.assign({}, r.timings, { firstResponseMs: Date.now() - t0 }); save(); t.log('Port ' + tcp[0].host + ' answered after ' + ((Date.now() - tp) / 1000).toFixed(1) + ' s'); }
    else if (!L.ended) t.warn('nothing answered on port ' + tcp[0].host + ' within 20 s (the app may still be starting - see its logs)');
  } else if (!L.ended) {
    // one-shot commands: report their exit when it comes at once
    await L.waitFor(() => L.ended, 1500);
  }
  const r = store.get(id) || rec0;
  if (L.ended) {
    const res = L.result || {};
    t.log('The app exited with code ' + res.exitCode + (res.exitReason ? ' (' + res.exitReason + ')' : ''));
    return Object.assign(summary(), {
      status: 'exited', exitCode: res.exitCode, exitReason: res.exitReason || null, fallback: res.fallback || null,
      stdout: res.stdoutTail || '', stderr: res.stderrTail || '', warnings: (r.warnings || []).slice(), timings: r.timings || null,
    });
  }
  const urls = urlsOf(r);
  if (urls.length) t.log('Open: ' + urls.map((u) => u.url + (u.lan ? ' (LAN: ' + (u.lanUrls || []).join(' ') + ')' : '')).join('  '));
  return Object.assign(summary(), { status: 'running', urls, warnings: (r.warnings || []).slice(), timings: r.timings || null });
}

function probeTcp(port, ms) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect({ host: '127.0.0.1', port });
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(ok); };
    // slirp accepts on the host at once and closes again when nothing
    // listens in the guest: a connection that stays open (or sends data) is
    // an app that answered
    const timer = setTimeout(() => finish(true), ms);
    s.once('data', () => finish(true));
    s.once('close', () => finish(false));
    s.once('error', () => finish(false));
  });
}
async function waitAnswer(port, totalMs, stop) {
  const end = Date.now() + totalMs;
  while (Date.now() < end && !stop()) {
    if (await probeTcp(port, 400)) return true;
    await sleep(150);
  }
  return false;
}

async function prepareAndLaunch(t, L, o, t0) {
  const id = L.id;
  const run = runMod(), plan = planMod(), compat = compatMod();
  const signal = L.ac.signal;
  const checkAbort = () => { if (signal.aborted) throw new Aborted(); };
  let rec = store.get(id);
  const warn = (w) => {
    const r = store.get(id);
    if (r && (r.warnings || []).indexOf(w) < 0) { r.warnings = (r.warnings || []).concat([w]).slice(-30); }
    t.warn(w);
  };
  const engine = o.first ? (rec.engine || 'auto') : 'microvm';
  const capMB = compat.memCapMB(CFG);
  tasks.assertFree('qemu');

  // 0. the root file system and the writable layer it may already have
  const rootfs = rootfsOf(rec);
  const runDir = runDirOf(id);
  const overlay = overlayOf(id);
  if (rootfs === 'ram' && (rec.rootDisk || fs.existsSync(overlay))) {
    // a RAM root never keeps a writable layer: the switch from disk drops it
    if (dropOverlay(rec)) warn('the writable layer was dropped: this container now holds its image in RAM (rootfs "ram")');
  }
  // disk root with a writable layer: bound to its image by config digest
  // (Docker semantics - a later pull of the tag does not change it)
  let bound = null;
  if (rootfs === 'disk' && fs.existsSync(overlay)) {
    const backing = rootdiskMod().overlayBacking(runDir);
    let cd = rec.rootDisk && rec.rootDisk.configDigest;
    if (!cd && backing) { const m = rootdiskMod().readDiskMetaFor(backing); cd = m ? m.configDigest : null; }
    if (!backing || !cd) {
      throw new ApiError(409, 'ROOT_DISK_MISSING', 'the writable layer of this container names no image disk this manager can find - start it fresh (drops the changes outside volumes) or remove it', { hint: 'fresh' });
    }
    bound = { configDigest: cd, disk: backing };
  } else if (rootfs === 'disk' && rec.rootDisk) {
    // the layer file is gone (deleted outside the manager): a fresh start
    rec.rootDisk = null;
    save();
  }

  // 1. the image: pull (zero requests for a cached tag), preflight BEFORE
  //    the flatten, then the image disk (disk root) or the initrd (RAM
  //    root) by content key (spec 7.1)
  const pull = o.first ? rec.pull : (rec.pull === 'always' ? 'always' : rec.pull === 'never' ? 'never' : 'missing');
  // the image disk (or initrd) is claimed INSIDE the image lock, the moment
  // it exists: from then on a forced image removal or a prune that waited
  // for that lock counts it as in use - its overlay only comes much later,
  // in step 11b (cr-1)
  const onRoot = (r) => { if (r.disk) L.disk = r.disk; if (r.initrd) L.initrd = r.initrd; };
  let prep;
  try {
    if (bound) {
      t.step('Preparing the image disk of ' + rec.image + '...');
      prep = await run.prepareRootByDigest(bound.configDigest, { t, signal, disk: bound.disk, onRoot });
    } else {
      t.step('Resolving ' + rec.image + '...');
      prep = await run.prepareImage(rec.image, {
        pull, t, signal, rootfs, onRoot,
        // called once the manifest and config are known, before any layer
        // is downloaded or flattened
        preflight: (img) => {
          // the image this start uses is known from here on: an image
          // removal or prune in the meantime must count it as used (correct-6)
          const r = store.get(id);
          if (r && img.configDigest) {
            r.configDigest = img.configDigest;
            if (img.manifestDigest) r.manifestDigest = img.manifestDigest;
            save();
          }
          const runtime = registryMod().runtimeConfig(img.config);
          const d = compat.decide(compat.imageRules({
            runtime, over: { entrypoint: rec.entrypoint, cmd: rec.cmd }, compressedBytes: img.totalCompressed, capMB,
            recommendedMemMB: plan.recommendedMemMB, rootfs,
          }), engine);
          for (const w of d.warnings) warn(w);
          if (d.fallback) throw fallbackError(d.fallback);
        },
      });
    }
  } catch (e) { throw prepareError(e, rec); }
  const disk = prep.rootfs === 'disk';
  // built (or found) and about to be booted: never GC'd from now on (onRoot
  // set it already, under the lock; a stand-in prepare may not call it)
  if (disk) L.disk = prep.disk;
  else L.initrd = prep.initrd;
  try { imagesMod().noteRateLimit(prep.rateLimit); } catch (e) { /* display only */ }
  if (!disk && prep.cached && prep.cached.initrd === false) {
    // a new initrd (a new image, or a new init/kernel): initrds of earlier
    // versions go - but only unreferenced ones older than 10 minutes that
    // no live container booted (images.pruneInitrds, bug V4b)
    try {
      const idx = imagesMod().readIndex();
      const keep = Object.keys(idx.images).map((k) => idx.images[k].initrd && idx.images[k].initrd.file).filter(Boolean)
        .map((f) => path.join(CFG.imagesDir, 'initrd', f)).concat([prep.initrd]);
      imagesMod().pruneInitrds({ keep, inUse: liveInitrds() });
    } catch (e) { /* tidy-up only */ }
  }
  rec = store.get(id);
  if (!rec) throw new Error('the container was removed while it was starting');
  if (prep.reference) rec.reference = prep.reference;
  if (prep.manifestDigest) rec.manifestDigest = prep.manifestDigest;
  rec.configDigest = prep.configDigest;
  rec.timings = Object.assign({}, rec.timings, disk
    ? { pullMs: prep.timings.pullMs, diskMs: prep.timings.diskMs }
    : { pullMs: prep.timings.pullMs, flattenMs: prep.timings.flattenMs, initrdMs: prep.timings.initrdMs });
  for (const w of (prep.warnings || []).slice(0, 10)) if ((rec.warnings || []).indexOf('image: ' + w) < 0) rec.warnings = (rec.warnings || []).concat(['image: ' + w]);
  save();
  checkAbort();

  // 2. rootfs-level rules: exact size (RAM root), s6-overlay (spec 14.3);
  //    a disk root's facts come from its image disk's sidecar
  const facts = disk ? factsMod().diskFacts(prep) : factsMod().imageFacts(prep.initrd);
  const d2 = compat.decide(compat.rootfsRules({
    runtime: prep.runtime, over: { entrypoint: rec.entrypoint, cmd: rec.cmd }, initrdBytes: prep.initrdBytes, capMB,
    recommendedMemMB: plan.recommendedMemMB, facts, warnings: prep.warnings, rootfs: prep.rootfs,
  }), engine);
  for (const w of d2.warnings) warn(w);
  if (d2.fallback) throw fallbackError(d2.fallback);

  // 3. re-read the registry AFTER the slow part (bug V1): what is attached
  //    now is what counts
  rec = store.get(id);
  if (!rec) throw new Error('the container was removed while it was starting');
  if ((rec.shares || []).length && !((prep.manifest.features || {}).ninep || []).length) {
    throw new ApiError(409, 'KERNEL_UPDATE', 'shared folders need the updated microVM kernel - update it in Setup (no download: it is rebuilt from the cached packages)', { action: 'install-kernel' });
  }
  fs.mkdirSync(runDir, { recursive: true });

  // 4. accelerator and host facts (the first use under WHPX measures the
  //    TSC with one short boot)
  const accel = await chooseAccel(rec);
  if (accel === 'tcg') warn('running under TCG software emulation: slower, and not a security boundary');
  t.step('Checking this PC (' + accel + ')...');
  // the host-facts step may boot QEMU (the TSC calibration): not while
  // "Update QEMU" replaces its files (correct-18 - the pull above can take
  // minutes, so the check at the top is not enough)
  tasks.assertFree('qemu');
  const host = await run.hostFacts({ t, accel });
  checkAbort();

  // 5. volumes: create on first use, then the exclusive attach lock - once
  //    per volume: two disks on one qcow2 would mount ext4 twice (correct-2;
  //    the API refuses such a list, this guards records from before that)
  const volumes = volumesMod();
  const vols = [];
  for (const v of rec.volumes || []) {
    if (L.volumeLocks.some((n) => n.toLowerCase() === String(v.name).toLowerCase())) {
      throw new ApiError(409, 'VOLUME_IN_USE', 'volume "' + v.name + '" is listed twice for this container - a volume can be mounted once per container (remove the container and run it again with one entry)');
    }
    const r = volumes.ensureVolume(CFG.volumesDir, v.name, {});
    if (r.created) t.log('Created volume "' + v.name + '" (' + Math.round(r.sizeBytes / 1073741824) + ' GiB, sparse; seeded from the image at first use)');
    volumes.acquireLock(CFG.volumesDir, v.name, { containerId: id, isLive, nameOf });
    L.volumeLocks.push(v.name);
    vols.push({ file: r.file, target: v.target, readonly: !!v.readonly, nocopy: !!v.nocopy });
  }
  checkAbort();

  // 6. published ports: the image's EXPOSE ports when none were given
  //    (same host port when free), then every one must be free on BOTH
  //    127.0.0.1 and 0.0.0.0 right now (bug V7)
  if (rec.ports === null || rec.ports === undefined) {
    const list = [];
    const taken = new Set();
    for (const e of prep.runtime.exposedPorts || []) {
      const m = /^(\d{1,5})(?:\/(tcp|udp))?$/i.exec(String(e));
      if (!m) continue;
      const guest = parseInt(m[1], 10);
      if (!(guest >= 1 && guest <= 65535)) continue;
      const host = await portsMod().allocHostPort(preferredHostPort(guest), { taken });
      taken.add(host);
      list.push({ host, guest, proto: (m[2] || 'tcp').toLowerCase(), lan: !!rec.lan, auto: true });
    }
    rec = store.get(id);
    if (!rec) throw new Error('the container was removed while it was starting');
    rec.ports = list;
    save();
    for (const p of list) portsMod().release(p.host);
    if (list.length) t.log('Published the image\'s ports: ' + list.map((p) => p.host + ' -> ' + p.guest + (p.proto === 'udp' ? '/udp' : '') + (p.lan ? ' [LAN]' : ' [this PC only]')).join(', '));
  }
  await checkFree(rec.ports);
  checkAbort();

  // 7. copy-in: a one-way copy of host folders, made at every start and
  //    extracted over the container's files (a disk root keeps files deleted
  //    on the host since the last start - cr-7)
  let copy = null;
  const extraDrives = [];
  let extraMB = 0;
  // a record from before the network-path rule (sec-1): never opened -
  // even a stat() would connect to that host and send it the Windows sign-in
  for (const c of (rec.copyIn || []).map((x) => x.hostDir).concat((rec.shares || []).map((s) => s.hostPath))) {
    const why = networkPathError(c);
    if (why) throw new ApiError(409, 'NETWORK_PATH', why + ' - remove the container and run it again with a local folder');
  }
  if ((rec.copyIn || []).length) {
    t.step('Packing ' + rec.copyIn.length + ' folder(s) to copy into the container...');
    copy = await copyinMod().packCopyIn(rec.copyIn.map((c) => ({ hostDir: c.hostDir, target: c.target })), path.join(runDir, 'copyin.cpio'));
    for (const s of copy.skipped.slice(0, 20)) warn('copy-in: skipped ' + s.path + ': ' + s.reason);
    t.log('Copy-in: ' + copy.files + ' files, ' + (copy.bytes / 1048576).toFixed(1) + ' MB');
    extraDrives.push({ id: 'copyin', file: copy.file, format: 'raw', serial: 'devbox-copyin', readonly: true });
    // a RAM root holds the copied files in RAM; a disk root writes them to its disk
    const inVolume = (tg) => vols.some((v) => tg === v.target || tg.startsWith(v.target + '/'));
    if (!disk && !copy.targets.every(inVolume)) extraMB = Math.ceil(copy.bytes / 1048576);
  }
  checkAbort();

  // 8. live shared folders: registered with the manager's 9P server; the
  //    guest finds the port and secrets in a private fw_cfg file
  const fwcfg = [];
  if ((rec.shares || []).length) {
    for (const s of rec.shares) {
      let ok = false;
      try { ok = fs.statSync(s.hostPath).isDirectory(); } catch (e) { ok = false; }
      if (!ok) throw new ApiError(409, 'SHARE_MISSING', 'the shared folder ' + s.hostPath + ' (for ' + s.guestPath + ') does not exist any more');
    }
    const ids = factsMod().resolveUser(rec.user !== null && rec.user !== undefined ? rec.user : prep.runtime.user, facts);
    // kept with the runtime: a manager that re-adopts this container must
    // serve the shares with the SAME owner (the image's USER), not root's
    // (correct-3)
    L.shareIds = { uid: ids.uid, gid: ids.gid };
    const shares = sharesMod();
    const reg = await shares.registerFor('container', id, rec.shares.map((s) => Object.assign({}, s, { guestPath: SHARE_DIR + s.id })), { uid: ids.uid, gid: ids.gid });
    L.sharesRegistered = true;
    if (reg.warnings && reg.warnings.length) {
      // the service names the internal mount point: show the user's path
      // (correct-15)
      // (longest id first: "abc-1" must not rewrite part of "abc-10")
      const byLen = rec.shares.slice().sort((a, b) => b.id.length - a.id.length);
      const shown = reg.warnings.map((w) => {
        let out = w;
        for (const s of byLen) out = out.split(SHARE_DIR + s.id).join(s.guestPath);
        return out;
      });
      throw new ApiError(409, 'SHARE_FAILED', shown.join('; '));
    }
    fwcfg.push({ name: 'opt/devbox/shares', file: reg.file });
    t.log('Shared folders: ' + rec.shares.map((s) => s.hostPath + ' -> ' + s.guestPath + (s.readOnly ? ' (read-only)' : '')).join(', ') +
      ' (live, 9P server on 127.0.0.1:' + reg.port + ', files owned by ' + ids.uid + ':' + ids.gid + ' in the container)');
  }

  // 9. memory: a RAM root holds the image (spec 7.2); a disk root gets the
  //    default whatever the image size (it streams through the page
  //    cache) - more for apps known to need it, and a v2.0 container keeps
  //    what it had (cr-3). WHPX commits all of it.
  if (rec.autoMemFromRam) {
    delete rec.autoMemFromRam;
    if (disk && !rec.mem) {
      const idx = imagesMod().readIndex().images[rec.configDigest] || {};
      const bytes = (idx.initrd && idx.initrd.bytes) || idx.rootfsBytes || 0;
      rec.mem = Math.min(plan.ramAutoMemMB(bytes), CFG.maxMem || 16384);
      t.log('This container was created by an earlier version with automatic memory, sized to hold its image in RAM: it keeps ' + rec.mem +
        ' MB now that its image stays on disk (disk roots need about ' + plan.recommendedDiskMemMB() + ' MB plus what the app uses) - lower it in its Settings if the app needs less');
    }
    save();
  }
  let memMB;
  if (!disk) memMB = rec.mem || Math.max(256, plan.recommendedMemMB(prep.initrdBytes) + extraMB);
  else if (rec.mem) memMB = rec.mem;
  else {
    memMB = plan.recommendedDiskMemMB();
    const hint = plan.diskMemHint(prep.runtime, { entrypoint: rec.entrypoint, cmd: rec.cmd });
    const want = hint ? Math.min(hint.memMB, CFG.maxMem || 16384) : 0;
    if (want > memMB) {
      t.log(hint.what + ' needs more than the ' + memMB + ' MB default: this start gets ' + want + ' MB (set the memory of the container to change it)');
      memMB = want;
    }
  }
  const freeMB = Math.floor(os.freemem() / 1048576);
  if (memMB + 64 > freeMB - 512) {
    const inUse = memoryInUse();
    throw new ApiError(409, 'MEMORY_BUDGET', 'not enough free memory: this container needs ' + memMB + ' MB and this PC has ' + freeMB + ' MB free' +
      (inUse.length ? ' (running: ' + inUse.join(', ') + ')' : '') + ' - stop something first');
  }

  // 10. machine: microvm unless QEMU lacks it or the devices do not fit its
  //     8 virtio-mmio slots (bug H); SMP only on q35 until tested (bug G)
  const machines = (host && host.machines && host.machines.length) ? host.machines : ['microvm', 'q35'];
  let machine = rec.machine && rec.machine !== 'auto' ? rec.machine : (machines.includes('microvm') ? 'microvm' : 'q35');
  const devices = (rec.network === 'none' ? 0 : 1) + 1 + 1 + (copy ? 1 : 0) + vols.length + (disk ? 1 : 0);
  if (machine === 'microvm' && devices > 8 && (!rec.machine || rec.machine === 'auto')) {
    machine = 'q35';
    t.log('More than 8 virtio devices: using the q35 machine (about 0.8 s slower to boot)');
  }
  // microvm has no HPET/ACPI PM timer: without a known TSC frequency the
  // guest kernel may hang calibrating it (WHPX always, TCG on a busy host)
  if (machine === 'microvm' && (accel === 'whpx' || accel === 'tcg') && !(host && host.tscKhz)) {
    machine = 'q35';
    t.log('No TSC frequency measured for this PC: using the q35 machine');
  }
  let cpus = rec.cpus || 1;
  if (cpus > 1 && machine === 'microvm') {
    warn('more than 1 vCPU is not tested on the microvm machine yet: using 1 (set machine "q35" for more)');
    cpus = 1;
  }

  // 11. the run spec (fw_cfg; at most 32 KB, bug I)
  const spec = plan.buildSpec(prep.runtime, {
    entrypoint: rec.entrypoint === null ? undefined : rec.entrypoint,
    cmd: rec.cmd === null ? undefined : rec.cmd,
    env: rec.env || [], workdir: rec.workdir || undefined, user: rec.user === null ? undefined : rec.user,
    hostname: rec.hostname || id,
    net: rec.network === 'none' ? false : undefined,
    volumes: vols.map((v) => ({ target: v.target, readonly: v.readonly, nocopy: v.nocopy })),
    shares: (rec.shares || []).map((s) => ({ id: s.id, target: s.guestPath, readonly: !!s.readOnly })),
    copyIn: copy ? { targets: copy.targets, owner: rec.copyInOwner === 'root' ? 'root' : 'user' } : null,
    stopSignal: rec.stopSignal || undefined, stopTimeout: rec.stopTimeout === undefined || rec.stopTimeout === null ? 10 : rec.stopTimeout,
    // like Docker Desktop: the host, as the guest sees it through slirp
    extraHosts: rec.network === 'none' ? [] : [{ host: 'host.docker.internal', ip: '10.0.2.2' }],
    acpiButton: true,
    logCap: (CFG.containerLogCapMB || 1024) * 1048576,
    rootfs: prep.rootfs,
  });
  checkAbort();

  // 11b. disk root: room to write, the writable layer, the boot archive
  let rootDisk = null, initrd = prep.initrd;
  if (disk) {
    const minFree = Number.isInteger(CFG.minFreeDiskMB) && CFG.minFreeDiskMB >= 0 ? CFG.minFreeDiskMB : 1024;
    const free = platform.diskFree(runDir).free;
    if (free !== null && free < minFree * 1048576) {
      throw new ApiError(409, 'NO_SPACE', 'a container\'s writable layer grows on this disk: ' + Math.floor(free / 1048576) + ' MB free, ' + minFree + ' MB needed (config.json minFreeDiskMB) - free some space first');
    }
    rec = store.get(id);
    if (!rec) throw new Error('the container was removed while it was starting');
    let backingRel;
    if (!fs.existsSync(overlay)) {
      // ROOT_DISK_MISSING when the disk went after all (it is claimed in the
      // image lock, so only something outside this manager deletes it now):
      // a clear error instead of QEMU failing on a missing backing file
      let ov;
      try { ov = rootdiskMod().createRootOverlay(runDir, prep.disk, prep.virtualBytes); }
      catch (e) { throw prepareError(e, rec); }
      if (ov.absolute) warn('the data folder\'s microvms or images folder is a symbolic link: this container\'s writable layer names its image disk by its full path (' + ov.backing + '), so moving the data folder breaks it');
      backingRel = ov.backing;
      // saved BEFORE the spawn: GC must see the reference from now on
      rec.rootDisk = {
        configDigest: prep.configDigest, disk: path.relative(CFG.root, prep.disk).split(path.sep).join('/'),
        createdAt: iso(), virtualBytes: prep.virtualBytes,
      };
      save();
      t.log('New writable layer on the image disk (' + Math.round(prep.virtualBytes / 1073741824) + ' GiB, sparse): files changed outside volumes are kept until the container is removed or started fresh');
    } else {
      // the overlay names its own disk: that is what QEMU opens (a writer or
      // format bump may have built a newer disk for the image since; the
      // old one is referenced, so GC kept it)
      const b = require('./qcow2').readBacking(overlay);
      const backing = b && b.name ? path.resolve(runDir, b.name) : null;
      if (!backing || !fs.existsSync(backing)) {
        throw new ApiError(409, 'ROOT_DISK_MISSING', 'the image disk this container\'s writable layer was made from is gone - start it fresh (drops the changes outside volumes) or remove it', { hint: 'fresh' });
      }
      if (rootdiskMod().normKey(backing) !== rootdiskMod().normKey(prep.disk)) prep.disk = backing;
      backingRel = b.name;
      if (!rec.rootDisk) {
        rec.rootDisk = { configDigest: prep.configDigest, disk: path.relative(CFG.root, backing).split(path.sep).join('/'), createdAt: iso(), virtualBytes: prep.virtualBytes };
        save();
      }
    }
    L.disk = prep.disk;
    L.overlay = overlay;
    rootDisk = { file: overlay, backing: prep.disk, backingRel };
    let di;
    try { di = await rootdiskMod().ensureDiskInitrd({ kernelDir: prep.kernelDir, manifest: prep.manifest, spec }); }
    catch (e) { throw prepareError(e, rec); }
    initrd = di.file;
    L.initrd = di.file;
    checkAbort();
  }

  // 12. spawn (detached; the registry is saved before the start counts)
  t.step('Starting the microVM (' + machine + ', ' + accel + ', ' + memMB + ' MB, ' + (disk ? 'disk' : 'RAM') + ' root)...');
  tasks.assertFree('qemu'); // correct-18: not from a QEMU being replaced
  const rt = await run.launch({
    id, runDir, prep, host, spec, t, initrd, rootDisk,
    ports: (rec.ports || []).map((p) => ({ hostPort: p.host, guestPort: p.guest, proto: p.proto || 'tcp', lan: !!p.lan })),
    volumes: vols.map((v) => ({ file: v.file, format: 'qcow2' })),
    extraDrives, extraMemMB: extraMB, fwcfg, accel, machine, memMB, cpus,
    // env values are secrets: spec.sh is written private (sec-5)
    writeSpec: (file, text) => platform.writePrivateFileSync(file, text, { required: true }),
    // the runtime is recorded the moment QEMU is spawned, not after the
    // start window (up to 3.4 s): a manager that exits in between leaves a
    // record the next one re-adopts, not an untracked VM holding the
    // container's ports and volumes (spec 7.2, correct-5, spec-3)
    onSpawn: (r) => {
      const x = store.get(id);
      if (!x) return;
      x.runtime = r ? runtimeRecord(r, L) : null;
      if (r) x.status = x.stopRequest ? 'stopping' : 'booting';
      save();
    },
  });
  L.rt = rt;
  L.child = rt.child || null;
  if (L.child) L.child.once('exit', () => { L.childExited = true; });
  rec = store.get(id);
  if (rec) {
    rec.runtime = runtimeRecord(rt, L);
    rec.status = rec.stopRequest ? 'stopping' : 'booting';
    rec.timings = Object.assign({}, rec.timings, { spawnMs: Date.now() - t0 });
    save();
  }
  if (rt.effectiveAccel !== rt.accel) warn('QEMU could not use ' + rt.accel + ' and fell back to TCG software emulation: slower, and not a security boundary');
  L.phase = 'spawned';
  L.t0 = t0;
  attachWatcher(L, { adopted: false });
  L.resolveSpawned();
  L.changed();
  if (!rec) {
    // removed while it spawned: stop it at once
    stopSpawned(null, L, { timeoutS: 0, force: true }).catch(() => {});
  }
}

// What containers.json keeps of a spawned QEMU (never the child handle).
// shareIds: the owner the shared folders are served with, for a manager
// that re-adopts the container (correct-3).
function runtimeRecord(rt, L) {
  const out = {
    pid: rt.pid, startedAt: rt.startedAt, accel: rt.accel, effectiveAccel: rt.effectiveAccel, machine: rt.machine, memMB: rt.memMB, cpus: rt.cpus,
    initrd: rt.initrd, monitor: rt.monitor, console: rt.console,
    // disk root: the image disk it boots (GC: in use) and its writable layer
    rootfs: rt.rootfs === 'disk' ? 'disk' : 'ram', disk: rt.disk || null, overlay: rt.overlay || null,
  };
  if (L && L.shareIds) out.shareIds = { uid: L.shareIds.uid, gid: L.shareIds.gid };
  return out;
}

// Give back what a start took when it fails before (or without) a VM.
function releaseResources(L) {
  const volumes = volumesMod();
  for (const n of L.volumeLocks) { try { volumes.releaseLock(CFG.volumesDir, n, L.id); } catch (e) { /* stale lock, taken over later */ } }
  L.volumeLocks = [];
  if (L.sharesRegistered) {
    try { sharesMod().disconnect(L.id); sharesMod().unregister(L.id); } catch (e) { /* gone */ }
    L.sharesRegistered = false;
  }
  const d = runDirOf(L.id);
  for (const f of ['copyin.cpio', 'spec.sh']) { try { fs.rmSync(path.join(d, f), { force: true }); } catch (e) { /* busy */ } }
}

// ---------------------------------------------------------------------------
// supervision
// ---------------------------------------------------------------------------
// Liveness is platform.pidAlive, polled with the console (250 ms): exact
// while the pid cannot be reused - for a QEMU started here our process
// handle pins it; an adopted one was matched against the shared
// listQemuPids() listing and its qemu.pid at adoption. No per-container
// tasklist ever runs (it takes seconds on a busy Windows PC).
function attachWatcher(L, o) {
  const run = runMod();
  const rt = Object.assign({}, L.rt, { logs: logsOf(L.id) });
  let lastLogCheck = 0, lastPauseCheck = Date.now();
  L.watcher = run.watch(rt, {
    pollMs: 250,
    isAlive: async () => {
      if (!L.logLimit && Date.now() - lastLogCheck >= LOG_CHECK_MS) { lastLogCheck = Date.now(); checkLogSizes(L, rt.logs); }
      if (Date.now() - lastPauseCheck >= PAUSE_CHECK_MS) { lastPauseCheck = Date.now(); checkPaused(L).catch((e) => logError('container ' + L.id + ': pause check failed', e)); }
      return !L.childExited && platform.pidAlive(rt.pid);
    },
    onMarker: (name, value) => onMarker(L, name, value),
    onConsole: (line) => onConsole(L, line),
  });
  L.watcher.exited.then((res) => finalize(L, res)).catch((e) => logError('container ' + L.id + ': watcher failed', e));
  if (!o.adopted) {
    const accel = (L.rt && (L.rt.effectiveAccel || L.rt.accel)) || 'tcg';
    const limit = accel === 'tcg' ? BOOT_TIMEOUT_S.tcg : BOOT_TIMEOUT_S.other;
    L.bootTimer = setTimeout(() => {
      if (L.initAt || L.ended) return;
      L.bootTimedOut = true;
      L.bootLimitS = limit;
      log('container ' + L.id + ': no sign of the guest after ' + limit + ' s - stopping it');
      runMod().forceStop(L.rt, { child: L.child }).catch(() => {});
    }, limit * 1000);
    if (L.bootTimer.unref) L.bootTimer.unref();
  }
}

// The per-boot log cap, enforced on the HOST (sec-4). Init caps each output
// stream inside the guest, but the app runs as root there: it can kill that
// watchdog, write to the virtio port itself, or flood /dev/console, and
// QEMU writes whatever arrives straight into these files. A log that passes
// the cap (plus slack for the guest's own cap to act first) stops the
// container. Checked every LOG_CHECK_MS from the watcher's poll: one stat
// per file.
const LOG_CHECK_MS = 2000;
const LOG_CAP_SLACK = 64 * 1048576;
function logCapBytes() { return (CFG.containerLogCapMB || 1024) * 1048576; }
function checkLogSizes(L, logs) {
  // the guest's own cap acts at the cap; the host steps in once a stream is
  // clearly past it (64 MB more, or the cap again for a small one)
  const limit = logCapBytes() + Math.min(LOG_CAP_SLACK, logCapBytes());
  for (const k of ['stdout', 'stderr', 'console']) {
    let size = 0;
    try { size = fs.statSync(logs[k]).size; } catch (e) { continue; }
    if (size <= limit) continue;
    L.logLimit = { stream: k, bytes: size, capMB: Math.round(logCapBytes() / 1048576) };
    log('container ' + L.id + ': its ' + k + ' log passed ' + L.logLimit.capMB + ' MB for this boot - stopping it (the disk of this PC must not fill up)');
    // KILL inside the guest first (init still syncs the volumes), quit after 5 s
    stopSpawned(null, L, { timeoutS: 0, force: true }).catch((e) => logError('container ' + L.id + ': could not stop it after the log limit', e));
    return;
  }
}

// A full host disk (cr-6). A container's writable layer and its volumes are
// qcow2 files that grow as the guest writes (the layer up to the image
// disk's virtual size, 8 GiB or more). When the host disk is full, QEMU's
// default error policy for them (werror=enospc) PAUSES the guest instead of
// failing the write - the guest's file systems stay intact - and nothing
// else would tell: the record would say "running" while the app hangs. So
// while the disk is nearly full (one statfs every PAUSE_CHECK_MS; the
// monitor is only asked then), `info status` is read: a guest paused with
// io-error gets record.paused with the reason (lists, GUI, MCP), and once
// there is room again it is resumed (HMP cont). A stop of a paused guest
// quits its QEMU at once (stopSpawned).
const PAUSE_CHECK_MS = 5000;
const PAUSE_LOW_BYTES = 256 * 1048576;
const RESUME_FREE_BYTES = 512 * 1048576;
function lowestFree(rec) {
  const dirs = [runDirOf(rec.id)].concat((rec.volumes || []).length ? [CFG.volumesDir] : []);
  let min = null;
  for (const d of dirs) {
    const f = platform.diskFree(d).free;
    if (f !== null && (min === null || f < min)) min = f;
  }
  return min;
}
function setPaused(L, paused) {
  L.paused = paused;
  const r = store.get(L.id);
  if (r) { if (paused) r.paused = paused; else delete r.paused; save(); }
  L.changed();
}
async function checkPaused(L, o) {
  o = o || {};
  if (L.pauseBusy || L.ended || !L.rt || !L.rt.monitor) return;
  const rec = store.get(L.id);
  if (!rec) return;
  const free = o.free !== undefined ? o.free : lowestFree(rec);
  if (!L.paused && !(free !== null && free < PAUSE_LOW_BYTES)) return;
  L.pauseBusy = true;
  try {
    const st = await monitorMod().queryStatus(L.rt.monitor, 3000);
    if (!st || L.ended) return;
    const mb = (b) => (b === null ? '?' : Math.floor(b / 1048576) + ' MB');
    if (!st.running && st.reason === 'io-error') {
      if (!L.paused) {
        setPaused(L, {
          at: iso(),
          reason: 'paused by QEMU: the disk of this PC is full (' + mb(free) + ' free), so the container\'s writable layer or a volume could not grow - free some space and it resumes by itself, or stop it',
        });
        log('container ' + L.id + ': ' + L.paused.reason);
      } else if (free === null || free >= RESUME_FREE_BYTES) {
        const c = await monitorMod().cont(L.rt.monitor);
        if (c.ok && !L.ended) { setPaused(L, null); log('container ' + L.id + ': resumed - the disk of this PC has ' + mb(free) + ' free again'); }
      }
    } else if (L.paused && st.running) {
      setPaused(L, null); // resumed some other way
    }
  } finally { L.pauseBusy = false; }
}

function onMarker(L, name, value) {
  const rec = store.get(L.id);
  L.markers[name] = value === undefined ? true : value;
  if (name === 'INIT') {
    L.initAt = Date.now();
    clearTimeout(L.bootTimer);
    // QEMU read the spec (env values are secrets) when it started
    try { fs.rmSync(path.join(runDirOf(L.id), 'spec.sh'), { force: true }); } catch (e) { /* busy */ }
    if (rec && L.t0) { rec.timings = Object.assign({}, rec.timings, { initMs: L.initAt - L.t0 }); save(); }
    // a late accelerator line: the TCG warning was wrong after all
    if (rec && rec.runtime && rec.runtime.effectiveAccel !== rec.runtime.accel) {
      let text = '';
      try { text = fs.readFileSync(logsOf(L.id).qemu, 'utf8'); } catch (e) { /* gone */ }
      if (require('../vm').effectiveAccel(rec.runtime.accel, text) === rec.runtime.accel) {
        rec.runtime.effectiveAccel = rec.runtime.accel;
        if (L.rt) L.rt.effectiveAccel = rec.runtime.accel;
        rec.warnings = (rec.warnings || []).filter((w) => !/fell back to TCG/.test(w));
        save();
      }
    }
  } else if (name === 'ROOT') {
    // disk root: stage 2 runs on the root disk (after switch_root)
    if (rec && L.t0) { rec.timings = Object.assign({}, rec.timings, { rootMs: Date.now() - L.t0 }); save(); }
  } else if (name === 'READY') {
    L.ready = true;
    L.readyAt = Date.now();
    if (rec) {
      if (rec.status !== 'stopping') rec.status = 'running';
      if (!L.adopted || !rec.readyAt) rec.readyAt = iso();
      if (L.t0) rec.timings = Object.assign({}, rec.timings, { readyMs: L.readyAt - L.t0 });
      save();
    }
  } else if (name === 'STOPPING') {
    L.ack = true;
  } else if (name === 'EXIT') {
    L.exitSeen = true;
  }
  L.changed();
}

function onConsole(L, line) {
  const s = String(line).slice(0, 300);
  L.console.push(s);
  if (L.console.length > MAX_CONSOLE_LINES) L.console.shift();
  // init's own messages, and errors of its shell ("/.devbox/init: line N:")
  const m = /^devbox-init: (.*)$/.exec(s) || /^(\/\.devbox\/init: .*)$/.exec(s);
  if (m) {
    L.initMessages.push(m[1]);
    if (L.initMessages.length > MAX_INIT_MESSAGES) L.initMessages.shift();
  }
  // kept when seen: the call trace that follows is longer than the tail
  const p = !L.panicLine && /Kernel panic - not syncing:\s*(.{0,160})/.exec(s);
  if (p) L.panicLine = p[1].trim();
  const e = /__DEVBOX_ERROR=(.*)$/.exec(String(line));
  if (e) L.errorText = e[1].slice(0, 300).trim();
}

// The one place that decides how a spawned container ended.
function finalize(L, res) {
  if (L.ended) return;
  L.ended = true;
  L.phase = 'ended';
  clearTimeout(L.bootTimer);
  const id = L.id;
  const rec = store.get(id);
  const markers = Object.assign({}, res.markers || {}, L.markers);
  let exitCode, reason = null;
  if (markers.NOSTART !== undefined) {
    exitCode = null;
    reason = 'stopped before the app started';
  } else if (res.clean) {
    exitCode = res.exitCode;
  } else if (L.bootTimedOut) {
    exitCode = 125;
    reason = 'the VM did not boot within ' + L.bootLimitS + ' s' + (L.console.length ? ' - last console lines: ' + L.console.slice(-5).join(' | ') : '');
  } else if (L.forced && !L.ready && markers.READY === undefined) {
    // stopped while the VM was still booting (e.g. a hung boot): the app never
    // ran, so there is no exit code of its own (spec 6.3), not a 137
    exitCode = null;
    reason = 'stopped before the app started (the VM had not finished booting)';
  } else if (L.forced) {
    exitCode = 137;
    reason = 'powered off: the guest did not stop in time';
  } else {
    exitCode = 125;
    reason = res.reason || 'the VM ended without an exit status';
    // name the panic (e.g. "Attempted to kill init!"): guest text, capped
    if (res.kernelPanic && L.panicLine) reason = 'guest kernel panic: ' + L.panicLine;
  }
  if (L.errorText) reason = L.errorText;
  if (L.paused && L.forced && L.ready) reason = 'powered off while QEMU had it paused: the disk of this PC was full';
  if (L.logLimit) {
    // the manager stopped it (sec-4): say so, whatever the guest printed
    if (!res.clean) exitCode = 137;
    reason = 'stopped by the manager: its ' + L.logLimit.stream + ' log passed the limit of ' + L.logLimit.capMB + ' MB for one boot';
  }
  const runDir = runDirOf(id);
  const stdoutTail = readTail(path.join(runDir, 'stdout.log'), 4096);
  const stderrTail = readTail(path.join(runDir, 'stderr.log'), 4096);
  if (!reason && (exitCode === 126 || exitCode === 127)) {
    const last = stderrTail.trim().split(/\r?\n/).pop();
    reason = (exitCode === 127 ? 'command not found' : 'command not executable') + (last ? ': ' + last.slice(0, 200) : '');
  }
  let fallback = null;
  const sinceReady = L.readyAt ? Date.now() - L.readyAt : null;
  // An end somebody ASKED for (a stop, a forced stop, the log limit) says
  // nothing about the image: a working image stopped 5 s after READY must
  // not get a "Run with Docker-in-VM instead" offer because its runtime
  // printed a cgroup warning on the way (correct-16).
  const requested = !!(rec && rec.stopRequest) || L.ack || L.forced || !!L.logLimit;
  // NEEDS_MEMORY offers "run with N MB" = 1.5 x what the image is
  // RECOMMENDED (spec 14.4), not 1.5 x what it had (a user's low setting);
  // a disk root's need does not follow the image: 1.5 x what it had (or
  // the default, whichever is more), so at least 192 - never an offer below
  // what already ran out (SPEC-diskroot section 7: max(192, 1.5 x mem))
  let recommended = null;
  if (L.rt && L.rt.rootfs === 'disk') recommended = Math.max(planMod().DISK_DEFAULT_MEM_MB, planMod().recommendedDiskMemMB(), Number(L.rt.memMB) || 0);
  else {
    try { if (L.rt && L.rt.initrd) recommended = planMod().recommendedMemMB(fs.statSync(L.rt.initrd).size); } catch (e) { recommended = null; }
  }
  // init's count of out-of-memory kills of this boot (the kernel's own
  // message never reaches the console): an OOM at any time earns the
  // "more memory" offer (cr-3)
  const oomKills = /^\d{1,9}$/.test(String(markers.OOM === undefined ? '' : markers.OOM)) ? parseInt(markers.OOM, 10) : 0;
  const c = requested ? null : compatMod().classify({
    exitCode, beforeReady: !L.ready, sinceReadyMs: sinceReady, console: L.console.join('\n'), stderrTail,
    initMessages: L.initMessages, exitReason: reason, memMB: L.rt && L.rt.memMB, oomKills,
    recommendedMemMB: recommended ? Math.max(recommended, (L.rt && L.rt.memMB) || 0) : null,
  });
  if (c && c.offer) {
    fallback = { engine: 'docker-vm', code: c.class, reason: c.reason };
    if (c.memMB) fallback.memMB = c.memMB;
  }
  if (c && !reason) reason = c.reason;
  // release what the run held
  const volumes = volumesMod();
  const volNames = L.volumeLocks.length ? L.volumeLocks : ((rec && rec.volumes) || []).map((v) => v.name);
  for (const n of volNames) { try { volumes.releaseLock(CFG.volumesDir, n, id); } catch (e) { /* stale */ } }
  L.volumeLocks = [];
  try { sharesMod().disconnect(id); sharesMod().unregister(id); } catch (e) { /* not registered */ }
  for (const f of ['copyin.cpio', 'spec.sh']) { try { fs.rmSync(path.join(runDir, f), { force: true }); } catch (e) { /* busy */ } }
  if (rec) {
    rec.status = exitCode === 125 ? 'error' : 'exited';
    rec.exitCode = exitCode;
    rec.exitReason = reason;
    rec.lastError = rec.status === 'error' ? reason : null;
    rec.initMessages = L.initMessages.slice();
    // the "why did it fail" view: the last console lines of a failed boot
    // (guest text: shown with textContent only)
    rec.consoleTail = exitCode === 125 ? L.console.slice(-MAX_CONSOLE_LINES) : [];
    rec.endedAt = iso();
    rec.runtime = null;
    rec.stopRequest = null;
    rec.fallback = fallback;
    delete rec.paused;
    if (oomKills > 0) {
      // even when the app survived it (a worker was killed): say so
      const w = 'out of memory: the kernel killed ' + oomKills + ' process' + (oomKills === 1 ? '' : 'es') + ' during the last run (' +
        ((L.rt && L.rt.memMB) || '?') + ' MB) - give the container more memory';
      rec.warnings = (rec.warnings || []).filter((x) => !/^out of memory: the kernel killed/.test(x)).concat([w]).slice(-30);
    }
    if (rec.autoRemove) removeRecord(rec);
    save();
  }
  lives.delete(id);
  L.result = {
    exitCode, exitReason: reason, stopped: markers.NOSTART !== undefined, fallback, stdoutTail, stderrTail,
    forced: L.forced, bootTimedOut: L.bootTimedOut,
  };
  L.resolveEnded(L.result);
  L.resolveSpawned();
  L.changed();
}

// Delete a record and its run directory - with a disk root's writable layer
// (volumes are never removed). An image disk only this container still used
// (its image was force-removed) goes too, in the background.
function removeRecord(rec) {
  store.remove(rec.id);
  try { sharesMod().unregister(rec.id); } catch (e) { /* not registered */ }
  try { fs.rmSync(sharesMod().fwcfgFile('container', rec.id), { force: true }); } catch (e) { /* none */ }
  try { fs.rmSync(runDirOf(rec.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (e) { logError('could not delete the run folder of container ' + rec.id + ': ' + errMsg(e)); }
  if (rec.rootDisk) {
    rootdiskMod().pruneImageDisks({ records: () => store.list(), inUse: () => liveDisks(), minAgeMs: 0 })
      .catch((e) => logError('could not tidy up the image disks: ' + errMsg(e)));
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------
async function validateStop(body) {
  body = body || {};
  await whenAdopted();
  const rec = findRecord(body.id);
  const force = toBool(body.force, false);
  const def = rec.stopTimeout === undefined || rec.stopTimeout === null ? 10 : rec.stopTimeout;
  const timeoutS = intInRange(body.timeoutS, 0, 3600, def, 'timeoutS');
  return { id: rec.id, name: rec.name, force, timeoutS };
}

async function opStop(t, a) {
  const t0 = Date.now();
  const rec = store.get(a.id);
  if (!rec) return { id: a.id, exitCode: null, how: 'already removed', ms: 0 };
  const L = lives.get(a.id);
  if (!L) {
    if (rec.lost && rec.runtime && rec.runtime.pid) {
      t.log('This container runs without supervision: stopping its QEMU process');
      // its pid was proven to be this container's QEMU when it was found;
      // pids are reused, so it is proven again before anything is killed
      // (correct-13)
      const pid = rec.runtime.pid;
      let r = 'already-gone';
      if (platform.pidAlive(pid)) {
        const cmd = await platform.processCommandLine(pid);
        if (cmd === null && platform.pidAlive(pid)) {
          throw new Error('cannot confirm that pid ' + pid + ' is still this container\'s QEMU - end it in Task Manager (qemu-system-x86_64) if it is');
        }
        if (cmd !== null && cmd.indexOf(runMod().qemuName(rec.id)) !== -1) r = await runMod().forceStop(rec.runtime);
        if (r === 'failed') throw new Error('QEMU (pid ' + pid + ') did not stop - end it in Task Manager (qemu-system-x86_64)');
      }
      rec.runtime = null;
      rec.status = 'exited';
      rec.endedAt = iso();
      // a real record (not a "record lost" stand-in) can be started again
      if (rec.reference) delete rec.lost;
      for (const v of rec.volumes || []) { try { volumesMod().releaseLock(CFG.volumesDir, v.name, rec.id); } catch (e) { /* stale */ } }
      save();
      return { id: a.id, exitCode: null, how: 'forced (' + r + ')', ms: Date.now() - t0 };
    }
    t.log('"' + rec.name + '" is not running');
    return { id: a.id, exitCode: rec.exitCode === undefined ? null : rec.exitCode, how: 'already exited', ms: 0 };
  }
  rec.stopRequest = { at: iso(), timeoutS: a.timeoutS, force: !!a.force };
  rec.status = 'stopping';
  save();
  L.changed();
  if (L.phase === 'preparing') {
    t.log('Stopping before the app started...');
    L.ac.abort();
    await Promise.race([L.endedP, L.spawnedP]);
    if (L.phase !== 'spawned') {
      const r = await L.endedP;
      return { id: a.id, exitCode: r.exitCode, how: 'stopped before the app started', ms: Date.now() - t0 };
    }
  }
  const how = await stopSpawned(t, L, { timeoutS: a.timeoutS, force: !!a.force });
  const r = await Promise.race([L.endedP, sleep(15000).then(() => null)]);
  const res = r || L.result || {};
  if (res.stopped) return { id: a.id, exitCode: null, how: 'stopped before the app started', ms: Date.now() - t0 };
  if (how === 'graceful' && res.exitCode === 137) {
    return { id: a.id, exitCode: 137, how: 'killed after ' + a.timeoutS + ' s', ms: Date.now() - t0 };
  }
  return { id: a.id, exitCode: res.exitCode === undefined ? null : res.exitCode, how, ms: Date.now() - t0 };
}

// The acknowledged stop of a spawned VM (see the header). -> how
async function stopSpawned(t, L, o) {
  const run = runMod();
  const say = (m) => { if (t) t.log(m); };
  const rt = L.rt;
  const gone = () => L.ended || L.childExited || !platform.pidAlive(rt.pid);
  const t0 = Date.now();
  const cmd = o.force ? '__DEVBOX_KILL KILL\n' : '__DEVBOX_STOP ' + Math.max(0, Math.round(o.timeoutS)) + '\n';
  // a guest QEMU paused for a full disk (checkPaused) runs no code at all:
  // nothing it could still write would reach the disk, so it is quit at once
  // instead of waiting out every step below for an answer that cannot come
  const frozen = !!L.paused;
  if (frozen) say('The VM is paused because the disk of this PC is full: it cannot run its own stop - ending its QEMU process');
  // force: KILL is acknowledged at once by any guest that runs init; one
  // that has not answered in 5 s (e.g. hung while booting) is quit - it
  // used to wait timeoutS + 5 s (20 s by default) for an ack that never came
  const deadline = frozen ? t0 : t0 + (o.force ? 5 : Math.max(0, o.timeoutS) + 5) * 1000;
  let failSince = null, acpi = false, sent = 0;
  // A: resend until acknowledged
  while (!gone() && !L.ack && !L.exitSeen && Date.now() < deadline) {
    try { await run.sendConsole(rt.console, cmd, 1000); sent++; failSince = null; }
    catch (e) { if (failSince === null) failSince = Date.now(); }
    if (!o.force && !acpi && failSince !== null && Date.now() - failSince >= 3000 && rt.monitor) {
      acpi = true;
      say('The console does not answer: pressing the ACPI power button');
      try { await monitorMod().systemPowerdown(rt.monitor); } catch (e) { /* monitor gone too */ }
    }
    await L.waitFor(() => L.ack || L.exitSeen || L.ended, 1000);
  }
  if (sent > 1) say('The stop request was sent ' + sent + ' times before the guest took it');
  // A': acknowledged - wait for the exit until the deadline
  if (!o.force) await L.waitFor(() => L.exitSeen || L.ended, Math.max(0, deadline - Date.now()));
  else if (L.ack) await L.waitFor(() => L.exitSeen || L.ended, 5000);
  let how = o.force ? 'killed (force)' : 'graceful';
  // B: no exit yet - SIGKILL inside the guest; init still syncs and unmounts
  if (!L.exitSeen && !L.ended && !o.force && !frozen) {
    how = 'killed after ' + (o.timeoutS + 5) + ' s';
    say('No exit after ' + (o.timeoutS + 5) + ' s: sending SIGKILL to the app');
    const end = Date.now() + 5000;
    while (!gone() && !L.exitSeen && Date.now() < end) {
      try { await run.sendConsole(rt.console, '__DEVBOX_KILL KILL\n', 1000); } catch (e) { /* console gone */ }
      await L.waitFor(() => L.exitSeen || L.ended, 1000);
    }
  }
  // after the exit marker init powers off: give QEMU a moment to go
  if (L.exitSeen) await L.waitFor(() => L.ended || L.childExited || !platform.pidAlive(rt.pid), 5000);
  // C: only now a forced end - HMP quit, then the process (through this
  // manager's own handle when it spawned it: correct-7)
  if (!gone()) {
    if (!L.exitSeen) { L.forced = true; how = 'forced (quit)'; }
    say('Stopping the QEMU process');
    const r = await run.forceStop(rt, { child: L.child });
    // the watcher needs a poll or two to notice
    if (r !== 'failed') await L.waitFor(() => L.ended || L.childExited || !platform.pidAlive(rt.pid), 2000);
    if (r === 'failed' || !gone()) {
      // an honest failure, not "forced (quit)" while the VM keeps running:
      // the record goes back to what it is, and the task fails
      L.forced = false;
      const rec = store.get(L.id);
      if (rec && !L.ended) {
        rec.stopRequest = null;
        rec.status = L.ready ? 'running' : 'booting';
        save();
      }
      L.changed();
      throw new Error('QEMU (pid ' + rt.pid + ') did not stop - end it in Task Manager (qemu-system-x86_64), then refresh');
    }
  }
  return how;
}

// ---------------------------------------------------------------------------
// kill / remove / settings
// ---------------------------------------------------------------------------
async function kill(body) {
  body = body || {};
  await whenAdopted();
  const rec = findRecord(body.id);
  const sig = String(body.signal || 'KILL').toUpperCase().replace(/^SIG/, '');
  if (!initramfsMod().SIGNALS.includes(sig)) throw badRequest('signal must be one of ' + initramfsMod().SIGNALS.join(', '));
  const L = lives.get(rec.id);
  if (!L || L.phase !== 'spawned' || !L.rt || !L.rt.console) throw conflict('container "' + rec.name + '" is not running', 'NOT_RUNNING');
  await runMod().sendConsole(L.rt.console, '__DEVBOX_KILL ' + sig + '\n', 1500);
  return { id: rec.id, signal: sig, sent: true };
}

async function removeRoute(body) {
  body = body || {};
  await whenAdopted();
  const rec = findRecord(body.id);
  const force = toBool(body.force, false);
  if (isLive(rec.id) || (rec.lost && rec.runtime)) {
    if (!force) throw conflict('container "' + rec.name + '" is running - stop it first, or remove with force', 'RUNNING');
    const a = { id: rec.id, name: rec.name, force: true, timeoutS: 0 };
    await tasks.runAndWait({ kind: 'ctr-stop', title: 'Force stop container ' + rec.name, ctr: rec.id, locks: ['ctr-stop:' + rec.id] }, (t) => opStop(t, a));
  }
  if (isLive(rec.id)) throw conflict('container "' + rec.name + '" could not be stopped', 'RUNNING');
  const r = store.get(rec.id);
  if (r) {
    for (const v of r.volumes || []) { try { volumesMod().releaseLock(CFG.volumesDir, v.name, r.id); } catch (e) { /* stale */ } }
    removeRecord(r);
    save();
  }
  return { removed: rec.id, name: rec.name };
}

async function updateSettings(body) {
  body = body || {};
  await whenAdopted();
  const V = validateMod();
  const rec = findRecord(body.id);
  const has = (k) => body[k] !== undefined;
  const next = {};
  if (has('name')) {
    const n = V.nameField(body.name);
    if (!n) throw badRequest('name cannot be empty');
    if (nameTaken(n, rec.id)) throw conflict('a container called "' + n + '" already exists', 'NAME_IN_USE');
    next.name = n;
  }
  if (has('note')) next.note = String(body.note === null ? '' : body.note).slice(0, V.LIMITS.note);
  if (has('autostart')) next.autostart = toBool(body.autostart, false);
  if (has('autoRemove')) next.autoRemove = toBool(body.autoRemove, false);
  if ((next.autostart === undefined ? rec.autostart : next.autostart) && (next.autoRemove === undefined ? rec.autoRemove : next.autoRemove)) {
    throw badRequest('autostart and "remove when it exits" cannot both be on');
  }
  if (has('ephemeral')) next.ephemeral = toBool(body.ephemeral, false);
  // the root file system applies at the next start; disk -> ram drops the
  // writable layer then
  let note = null;
  if (has('rootfs')) {
    const v = V.rootfsField(body.rootfs);
    if (!v) throw badRequest('rootfs must be disk or ram');
    next.rootfs = v;
    if (v === 'ram' && rootfsOf(rec) === 'disk' && fs.existsSync(overlayOf(rec.id))) note = 'the writable layer (files changed outside volumes) is dropped at the next start';
  }
  const rootfsAfter = next.rootfs || rootfsOf(rec);
  if (has('mem')) next.mem = body.mem === null || body.mem === '' ? null : V.memField(body.mem, rootfsAfter);
  else if (next.rootfs && rec.mem) V.memField(rec.mem, rootfsAfter); // e.g. 112 MB is too little for a RAM root
  if (has('cpus')) next.cpus = intInRange(body.cpus, 1, CFG.maxCpus || 64, 1, 'vCPUs');
  if (has('stopTimeout')) next.stopTimeout = intInRange(body.stopTimeout, 0, 3600, 10, 'stopTimeout (s)');
  if (has('env')) next.env = V.envField(body.env);
  // Ports (correct-8): a RUNNING container keeps publishing - and QEMU keeps
  // binding - its current ports until it starts again, so an edit goes to
  // pendingPorts: URLs keep pointing at what answers, and the old ports stay
  // reserved while the new ones are promised. A stopped container gets them
  // at once; the new host ports are claimed across the free-port probe, so
  // two edits at once cannot both take the same port.
  const claimOwner = 'ctr:' + rec.id;
  const claimed = [];
  let portsList = null;
  if (has('ports')) {
    const defaultLan = !!(state.settings && state.settings.defaultExpose === 'lan');
    portsList = V.portsField(body.ports === null ? [] : body.ports, { defaultLan }) || [];
    checkReserved(portsList, rec.id);
    if (!isLive(rec.id)) {
      const mine = new Set((rec.ports || []).map((p) => p.host));
      const fresh = portsList.filter((p) => !mine.has(p.host));
      for (const p of fresh) { portsMod().claim(p.host, 60000, claimOwner); claimed.push(p.host); }
      try { await checkFree(fresh); }
      catch (e) { for (const p of claimed) portsMod().release(p, claimOwner); throw e; }
    }
  }
  try {
    const r = store.get(rec.id);
    if (!r) throw noSuch(body.id);
    const live = isLive(r.id);
    if (portsList) {
      if (!live) { next.ports = portsList; next.pendingPorts = undefined; }
      else if (JSON.stringify(portsList) === JSON.stringify(r.ports)) next.pendingPorts = undefined;
      else next.pendingPorts = portsList;
    }
    const restartFields = ['mem', 'cpus', 'env', 'stopTimeout', 'rootfs'];
    const needsRestart = live && (restartFields.some((k) => next[k] !== undefined && JSON.stringify(next[k]) !== JSON.stringify(r[k])) ||
      Array.isArray(next.pendingPorts));
    for (const k of Object.keys(next)) {
      if (next[k] === undefined) delete r[k];
      else r[k] = next[k];
    }
    if (needsRestart) r.pendingRestart = true;
    save();
    return Object.assign({ container: publicRecord(r), pendingRestart: !!r.pendingRestart }, note ? { note } : {});
  } finally {
    // saved (or refused): the record reserves them from here on
    for (const p of claimed) portsMod().release(p, claimOwner);
  }
}

// "Run with Docker-in-VM instead": a quick deploy of the same image, ports
// (same LAN choice), env and named volumes. The container must be stopped;
// its host ports go to the new VM.
async function fallbackRoute(body) {
  body = body || {};
  await whenAdopted();
  const rec = findRecord(body.id);
  if (isLive(rec.id)) throw conflict('stop container "' + rec.name + '" first: its ports go to the new VM', 'RUNNING');
  const deploy = require('../deploy');
  const q = quickDeployBody({
    image: rec.image, ports: rec.ports || [], env: rec.env || [], lan: rec.lan, ephemeral: rec.ephemeral, createdBy: rec.createdBy,
    keepOnFailure: body.keepOnFailure,
  }, { mounts: { volumes: rec.volumes || [], shares: rec.shares || [], copyIn: rec.copyIn || [] } });
  const warnings = q.skipped.map((s) => s + ' is not carried over (host folders are shared with microVM containers only)');
  // the container's own ports must not count against the VM that takes them
  // over, from validation until the record lets go of them (before the task
  // runs: its first synchronous steps already check reservations)
  releasing.add(rec.id);
  let task, a;
  const oldPorts = rec.ports;
  const oldNote = rec.note, oldFallback = rec.fallback;
  try {
    a = await deploy.validateQuickDeploy(q.body);
    const r0 = store.get(rec.id);
    if (!r0 || isLive(rec.id)) throw conflict('container "' + rec.name + '" changed meanwhile - try again', 'RUNNING');
    r0.ports = [];
    try {
      task = routeMod().startTask({ kind: 'quickdeploy', title: 'New VM ' + a.name + ' from ' + a.image, vm: a.name, locks: ['vm:' + a.name] }, async (t) => {
        for (const w of warnings) t.warn(w);
        return deploy.opQuickDeploy(t, a);
      }, a);
    } catch (e) { r0.ports = oldPorts; throw e; }
  } finally { releasing.delete(rec.id); }
  const r = store.get(rec.id);
  if (r) {
    r.fallback = Object.assign({}, r.fallback || { engine: 'docker-vm' }, { vm: a.name, at: iso() });
    r.note = (r.note ? r.note + ' | ' : '') + 'replaced by the Docker VM "' + a.name + '"';
    save();
  }
  // A deploy that fails later (the pull inside the VM, a VM that is deleted
  // again) must not leave the container without its ports: [] means
  // "publish nothing" at its next start, silently (correct-11).
  tasks.wait(task.id).then((done) => {
    if (!done || done.status !== 'error') return;
    const x = store.get(rec.id);
    if (!x || isLive(rec.id) || !Array.isArray(x.ports) || x.ports.length) return;
    x.ports = oldPorts;
    x.note = oldNote;
    x.fallback = oldFallback || null;
    save();
    log('container ' + rec.name + ': the Docker-in-VM deploy failed - its published ports are back');
  }).catch(() => { /* the task list lost it: nothing to restore from */ });
  return routeMod().accepted(task, { engine: 'docker-vm', vm: a.name, warnings });
}

// ---------------------------------------------------------------------------
// list / details / logs
// ---------------------------------------------------------------------------
async function listContainers(q) {
  q = q || {};
  const all = q.all === undefined ? true : !!q.all;
  return { containers: store.list().filter((r) => all || isLive(r.id)).map((r) => publicRecord(r)) };
}

async function getContainer(q) {
  q = q || {};
  const rec = findRecord(q.id);
  const out = publicRecord(rec, { reveal: !!q.reveal });
  const L = lives.get(rec.id);
  out.live = L ? { phase: L.phase, ready: L.ready, stopAcknowledged: L.ack } : null;
  out.logSizes = logsMod().sizes(runDirOf(rec.id));
  out.consoleTail = L ? L.console.slice(-10) : [];
  return { container: out };
}

async function getLogs(q) {
  q = q || {};
  const rec = findRecord(q.id);
  const r = logsMod().readLog(runDirOf(rec.id), { stream: q.stream, tail: q.tail, prev: q.prev });
  return Object.assign({ id: rec.id, running: isLive(rec.id) }, r);
}

function streamLogs(req, res, q) {
  q = q || {};
  let rec;
  try {
    rec = findRecord(q.id);
    logsMod().checkStream(q.stream, 'stdout');
  } catch (e) {
    res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: errMsg(e), code: e.code || 'BAD_REQUEST' }));
    return;
  }
  const id = rec.id;
  logsMod().follow(req, res, {
    runDir: runDirOf(id), stream: q.stream || 'stdout', since: q.since,
    isLive: () => isLive(id),
    exitCode: () => { const r = store.get(id); return r ? r.exitCode : null; },
  });
}

// ---------------------------------------------------------------------------
// volumes
// ---------------------------------------------------------------------------
function volumeUsers(name) {
  const key = String(name).toLowerCase();
  return store.list().filter((r) => (r.volumes || []).some((v) => String(v.name).toLowerCase() === key))
    .map((r) => ({ id: r.id, name: r.name, running: isLive(r.id) }));
}

async function listVolumes() {
  const volumes = volumesMod();
  return {
    volumes: volumes.listVolumes(CFG.volumesDir).map((v) => ({
      name: v.name, virtualBytes: v.virtualBytes, fileBytes: v.fileBytes, createdAt: v.createdAt, usedBy: volumeUsers(v.name),
      attached: !!volumes.readLock(CFG.volumesDir, v.name),
    })),
  };
}

async function createVolume(body) {
  body = body || {};
  const volumes = volumesMod();
  const name = String(body.name || '');
  try { volumes.checkName(name); } catch (e) { throw badRequest(e.message); }
  const sizeGB = intInRange(body.sizeGB, 1, 4096, 8, 'sizeGB');
  const r = volumes.ensureVolume(CFG.volumesDir, name, { sizeBytes: sizeGB * 1024 ** 3 });
  return { volume: { name: r.name, virtualBytes: r.sizeBytes, file: path.basename(r.file) }, created: r.created };
}

async function removeVolume(body) {
  body = body || {};
  await whenAdopted();
  const volumes = volumesMod();
  const name = String(body.name || '');
  try { volumes.checkName(name); } catch (e) { throw badRequest(e.message); }
  // refused only while ATTACHED (spec 10): a stopped container that names
  // the volume gets a new, empty one at its next start (the GUI says so)
  const running = volumeUsers(name).filter((u) => u.running);
  if (running.length) throw new ApiError(409, 'VOLUME_IN_USE', 'volume "' + name + '" is attached to running container ' + running.map((u) => '"' + u.name + '"').join(', ') + ' - stop it first');
  const lock = volumes.readLock(CFG.volumesDir, name);
  if (lock && volumes.lockHeld(lock, { containerId: null, isLive })) throw new ApiError(409, 'VOLUME_IN_USE', 'volume "' + name + '" is attached right now');
  try { volumes.removeVolume(CFG.volumesDir, name); }
  catch (e) {
    if (e.code === 'NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', e.message);
    if (e.code === 'EBUSY' || e.code === 'EPERM') throw new ApiError(409, 'VOLUME_IN_USE', 'volume "' + name + '" is open in another program');
    throw e;
  }
  return { removed: name };
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------
async function validatePull(body) {
  body = body || {};
  const ref = validateMod().imageRef(body.image);
  return { image: String(body.image).trim(), reference: ref.canonical };
}

// Pre-warm the cache: pull (always re-resolves the tag) and, with a kernel,
// build what the default root file system boots (the image disk, or the
// initrd for a RAM root), so the next run starts at once.
async function opPull(t, a) {
  if (kernelMod().findKernelDir()) {
    try {
      const p = await runMod().prepareImage(a.image, { pull: 'always', t, rootfs: validateMod().effectiveRootfs(null) });
      try { imagesMod().noteRateLimit(p.rateLimit); } catch (e) { /* display only */ }
      t.log('Ready: ' + p.reference + ' (' + (p.downloadedBytes / 1048576).toFixed(1) + ' MB downloaded)');
      return {
        reference: p.reference, configDigest: p.configDigest, manifestDigest: p.manifestDigest, downloadedBytes: p.downloadedBytes,
        compressedBytes: p.compressedBytes, initrdBytes: p.initrdBytes, diskBytes: p.diskBytes || null, rootfs: p.rootfs, warnings: p.warnings,
      };
    } catch (e) { throw prepareError(e, { image: a.image, engine: 'microvm' }); }
  }
  t.step('Pulling ' + a.image + ' (the microVM kernel is not installed: the image is only downloaded)');
  let img;
  try {
    img = await registryMod().pullImage(a.image, {
      root: CFG.imagesDir, pullPolicy: 'always',
      // free disk space for what is still to download, checked before it is (sec-3)
      beforeLayers: (info) => { if (info.missingBytes > 0) imagesMod().requireSpace(info.missingBytes + 64 * 1048576, 'downloading ' + a.image); },
    });
  }
  catch (e) { throw prepareError(e, { image: a.image, engine: 'microvm' }); }
  try { imagesMod().noteRateLimit(img.rateLimit); } catch (e) { /* display only */ }
  try { imagesMod().updateIndex(img.configDigest, { references: [img.reference], manifestDigest: img.manifestDigest, compressedBytes: img.totalCompressed }); } catch (e) { /* rebuilt later */ }
  return { reference: img.reference, configDigest: img.configDigest, manifestDigest: img.manifestDigest, downloadedBytes: img.downloadedBytes, compressedBytes: img.totalCompressed };
}

// The initrds of live containers - also of those still starting, whose
// initrd is built (or found) but not booted yet (correct-6).
function liveInitrds() {
  const out = [];
  for (const [id, L] of lives) {
    const r = store.get(id);
    if (L.initrd) out.push(L.initrd);
    if (r && r.runtime && r.runtime.initrd) out.push(r.runtime.initrd);
  }
  return out;
}
// The image disks of live containers - also of those still starting, whose
// disk is built (or found) but not booted yet.
function liveDisks() {
  const out = [];
  for (const [id, L] of lives) {
    const r = store.get(id);
    if (L.disk) out.push(L.disk);
    if (r && r.runtime && r.runtime.disk) out.push(r.runtime.disk);
  }
  return out;
}
// The references live containers use: one that is still pulling has no
// config digest yet (correct-6).
function liveRefs() {
  return store.list().filter((r) => isLive(r.id) && r.reference).map((r) => r.reference);
}

// Who uses what, read by images.js UNDER each image's lock - never a list
// taken before it: a container that is starting holds that lock while its
// image disk is built and claims the disk inside it (cr-1).
function gcContext() {
  return { records: () => store.list(), inUse: () => liveInitrds(), disksInUse: () => liveDisks(), liveRefs: () => liveRefs() };
}

async function removeImageRoute(body) {
  body = body || {};
  await whenAdopted();
  const images = imagesMod();
  return images.removeImage({ image: body.image, configDigest: body.configDigest, force: toBool(body.force, false) }, gcContext());
}

async function validatePrune(body) {
  await whenAdopted();
  return { all: body && body.all !== undefined ? toBool(body.all, true) : true };
}

// a.olderThanDays: only images unused for that long (the auto-prune)
async function opPrune(t, a) {
  const images = imagesMod();
  const r = await images.pruneImages(Object.assign(gcContext(), {
    t, olderThanDays: a && a.olderThanDays > 0 ? a.olderThanDays : undefined,
  }));
  t.log('Removed ' + r.images.length + ' image(s), ' + r.files + ' file(s); freed ' + (r.freedBytes / 1048576).toFixed(1) + ' MB');
  return r;
}

// Light profile: images nobody used for CFG.imagePruneDays are pruned - 5
// minutes after the manager starts, then once a day, as an "image-prune"
// task (skipped while a container is being started). CFG is read at every
// tick, so a settings change applies without a restart; 0 = off.
const PRUNE_FIRST_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 3600 * 1000;
function autoPruneTick() {
  pruneTimer = setTimeout(autoPruneTick, PRUNE_EVERY_MS);
  if (pruneTimer.unref) pruneTimer.unref();
  const days = Number(CFG.imagePruneDays);
  if (!(days > 0)) return null;
  if (tasks.running().some((x) => x.kind === 'ctr-run' || x.kind === 'ctr-start' || x.kind === 'image-prune')) return null;
  try {
    return tasks.start({ kind: 'image-prune', title: 'Prune images unused for ' + days + ' days', locks: [] }, (t) => opPrune(t, { all: true, olderThanDays: days }));
  } catch (e) { log('image auto-prune skipped: ' + errMsg(e)); return null; }
}
function armAutoPrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(autoPruneTick, PRUNE_FIRST_MS);
  if (pruneTimer.unref) pruneTimer.unref();
}

// ---------------------------------------------------------------------------
// adoption, autostart
// ---------------------------------------------------------------------------
function readPidFile(id) {
  try {
    const n = parseInt(fs.readFileSync(path.join(runDirOf(id), 'qemu.pid'), 'utf8').trim(), 10);
    return n > 0 ? n : null;
  } catch (e) { return null; }
}

// A container that ended while no manager watched it: its console tells.
function endedWhileAway(rec) {
  const r = runMod().readExit(runDirOf(rec.id));
  const m = r.markers || {};
  if (m.NOSTART !== undefined) { rec.exitCode = null; rec.exitReason = 'stopped before the app started'; }
  else if (r.exitCode !== null) {
    rec.exitCode = r.exitCode;
    // the marker parser stops at a space: take init's whole line
    const e = /__DEVBOX_ERROR=([^\r\n]{1,300})/.exec(readTail(logsOf(rec.id).console, 65536));
    rec.exitReason = e ? e[1] : null;
  } else { rec.exitCode = null; rec.exitReason = 'stopped outside the manager (no exit status)'; }
  rec.status = rec.exitCode === 125 ? 'error' : 'exited';
  rec.runtime = null;
  rec.stopRequest = null;
  rec.endedAt = rec.endedAt || iso();
  delete rec.paused;
  for (const v of rec.volumes || []) { try { volumesMod().releaseLock(CFG.volumesDir, v.name, rec.id); } catch (e) { /* stale */ } }
  try { fs.rmSync(sharesMod().fwcfgFile('container', rec.id), { force: true }); } catch (e) { /* none */ }
  for (const f of ['copyin.cpio', 'spec.sh']) { try { fs.rmSync(path.join(runDirOf(rec.id), f), { force: true }); } catch (e) { /* busy */ } }
  // --rm is honoured for an exit nobody watched too (spec 7.3, correct-12):
  // a detached run that ended while the manager was down must not keep its
  // record and its reserved host ports
  if (rec.autoRemove) removeRecord(rec);
}

// The owner the shared folders of an adopted container are served with:
// what its start recorded (runtime.shareIds), else the image's USER from
// the rootfs sidecar - never root's by default, or a non-root app loses
// write access to its folder after a manager restart (correct-3).
function adoptShareIds(rec) {
  const rt = rec.runtime || {};
  if (rt.shareIds && Number.isInteger(rt.shareIds.uid) && Number.isInteger(rt.shareIds.gid)) return { uid: rt.shareIds.uid, gid: rt.shareIds.gid };
  // a disk root's initrd holds no image: its facts and runtime come from the
  // image disk's sidecar
  const diskMeta = rt.rootfs === 'disk' && rt.disk ? rootdiskMod().readDiskMetaFor(rt.disk) : null;
  let user = rec.user;
  if (user === null || user === undefined) {
    try {
      const meta = diskMeta || (rec.configDigest ? require('../oci/cpio').readRootfsMeta(CFG.imagesDir, rec.configDigest) : null);
      user = meta && meta.runtime ? meta.runtime.user || '' : '';
    } catch (e) { user = ''; }
  }
  const facts = diskMeta ? factsMod().diskFacts(diskMeta) : (rt.initrd ? factsMod().imageFacts(rt.initrd) : {});
  return factsMod().resolveUser(user || '', facts);
}

async function adopt(rec) {
  const L = new Live(rec.id);
  L.phase = 'spawned';
  L.adopted = true;
  L.rt = Object.assign({}, rec.runtime);
  // what it booted stays in use (GC); a v2.0 runtime has no rootfs: RAM root
  L.initrd = L.rt.initrd || null;
  if (L.rt.rootfs === 'disk') { L.disk = L.rt.disk || null; L.overlay = L.rt.overlay || null; }
  // paused for a full disk when the last manager left: the check goes on
  if (rec.paused) L.paused = rec.paused;
  lives.set(rec.id, L);
  // the attach locks are this manager's now
  for (const v of rec.volumes || []) {
    try { volumesMod().acquireLock(CFG.volumesDir, v.name, { containerId: rec.id, isLive, nameOf }); L.volumeLocks.push(v.name); }
    catch (e) { logError('container ' + rec.name + ': volume ' + v.name + ': ' + errMsg(e)); }
  }
  // live shared folders: the mounts of the old manager died with it; the
  // same share ids and secrets are registered again and the guest re-mounts
  if ((rec.shares || []).length) {
    try {
      const ids = adoptShareIds(rec);
      L.shareIds = ids;
      await sharesMod().registerFor('container', rec.id, rec.shares.map((s) => Object.assign({}, s, { guestPath: SHARE_DIR + s.id })), { uid: ids.uid, gid: ids.gid });
      L.sharesRegistered = true;
      if (!rec.runtime.shareIds) rec.runtime.shareIds = { uid: ids.uid, gid: ids.gid };
    } catch (e) { logError('container ' + rec.name + ': shared folders could not be registered again', e); }
  }
  rec.stopRequest = null;
  const seen = runMod().readExit(runDirOf(rec.id)).markers || {};
  rec.status = seen.READY !== undefined ? 'running' : 'booting';
  if (seen.READY !== undefined) L.ready = true;
  L.resolveSpawned();
  attachWatcher(L, { adopted: true });
}

// Is pid the QEMU of container id? Its HMP monitor answers `info name` with
// the -name it was started with (the check lib/vm.js makes before adopting a
// VM, SEC-8). -> true | false (another QEMU) | null (no answer)
async function confirmCtrIdentity(id, rt) {
  if (!rt || !rt.monitor) return null;
  const want = runMod().qemuName(id);
  let got = await monitorMod().infoName(rt.monitor, 5000);
  if (got === null) got = await monitorMod().infoName(rt.monitor, 10000); // a busy PC
  if (got === null) return null;
  return got === want;
}

async function adoptAll() {
  try { return await adoptAllNow(); }
  finally {
    if (adoptGate) adoptGate.open();
    // called once at manager start: the light profile's image auto-prune
    armAutoPrune();
  }
}

// Spec 7.3: a record's QEMU is adopted when its pid is alive, is listed as
// a running QEMU and equals the qemu.pid its QEMU wrote (spec-4) - and its
// monitor confirms the name. A missing qemu.pid means a gone QEMU (the
// launch deletes the file before every spawn, QEMU writes it at once). A
// pid that cannot be checked at all (no listing, no monitor answer) is
// never marked exited - its volumes and ports would be handed out again
// while it may run - and never adopted blind: it is kept as an
// unsupervised VM that can be stopped.
async function adoptAllNow() {
  const out = { adopted: 0, exited: 0, lost: 0 };
  let pids = null;
  for (let i = 0; i < 2 && pids === null; i++) {
    try { pids = await platform.listQemuPids(); } catch (e) { pids = null; }
  }
  const vmPids = new Set();
  for (const n of Object.keys(state.vms || {})) { const rt = state.vms[n] && state.vms[n].runtime; if (rt && rt.pid) vmPids.add(rt.pid); }
  const run = runMod();
  const unsupervised = (rec, pid, why) => {
    rec.lost = true;
    rec.status = 'running';
    rec.runtime = Object.assign({ startedAt: null, accel: null, machine: null, memMB: null, monitor: null, console: null }, rec.runtime || {}, { pid });
    rec.exitReason = why;
    out.lost++;
    log('container ' + rec.name + ': ' + why);
  };
  for (const rec of store.list()) {
    if (isLive(rec.id)) continue;
    const rt = rec.runtime;
    if (rt && rt.pid) {
      const running = pids ? pids.has(rt.pid) : platform.pidAlive(rt.pid);
      if (rec.lost) {
        // an unsupervised VM found by an earlier manager: still there?
        if (!running) { rec.runtime = null; rec.status = 'exited'; rec.endedAt = rec.endedAt || iso(); if (rec.reference) delete rec.lost; }
        continue;
      }
      const filePid = readPidFile(rec.id);
      if (platform.pidAlive(rt.pid) && running && filePid === rt.pid && !vmPids.has(rt.pid)) {
        const ok = await confirmCtrIdentity(rec.id, rt);
        if (ok === true || (ok === null && pids !== null)) {
          if (ok === null) log('container ' + rec.name + ': its QEMU monitor does not answer; adopted on its pid and qemu.pid');
          try { await adopt(rec); out.adopted++; log('re-adopted container ' + rec.name + ' (pid ' + rt.pid + ')'); continue; }
          catch (e) { logError('could not re-adopt container ' + rec.name, e); lives.delete(rec.id); }
        } else if (ok === null) {
          unsupervised(rec, rt.pid, 'the manager could not confirm that pid ' + rt.pid + ' is still this container\'s VM (no process list, no monitor answer) - stop it, or end it in Task Manager');
          continue;
        }
      }
      endedWhileAway(rec);
      out.exited++;
    } else if (LIVE_STATUSES.includes(rec.status)) {
      // the manager ended while this container was starting: normally
      // before any QEMU (the runtime is recorded the moment QEMU is
      // spawned). A QEMU that wrote its qemu.pid and says it is this
      // container is running unsupervised (correct-5).
      const pid = readPidFile(rec.id);
      const cmd = pid && pids && pids.has(pid) && !vmPids.has(pid) ? await platform.processCommandLine(pid) : null;
      if (cmd && cmd.indexOf(run.qemuName(rec.id)) !== -1) {
        unsupervised(rec, pid, 'the manager stopped while this container was starting; its VM kept running without supervision - stop it (then start it again)');
        continue;
      }
      rec.status = 'exited';
      rec.exitCode = null;
      rec.exitReason = 'the manager stopped while the container was starting';
      rec.endedAt = iso();
      rec.stopRequest = null;
      out.exited++;
    }
  }
  // QEMU processes of containers whose record is gone ("record lost"): a
  // qemu.pid alone proves nothing (pids are reused - by other managers' and
  // other programs' QEMUs too), so only a QEMU whose command line names this
  // container counts; when that cannot be read, nothing is listed
  // (correct-13)
  let dirs = [];
  try { dirs = fs.readdirSync(CFG.microvmsDir); } catch (e) { dirs = []; }
  const knownPids = new Set(store.list().filter((r) => r.runtime && r.runtime.pid).map((r) => r.runtime.pid));
  for (const d of dirs) {
    if (!store.isId(d) || store.get(d)) continue;
    const pid = readPidFile(d);
    if (!pid || !pids || !pids.has(pid) || !platform.pidAlive(pid) || vmPids.has(pid) || knownPids.has(pid)) continue;
    const cmd = await platform.processCommandLine(pid);
    if (!cmd || cmd.indexOf(run.qemuName(d)) === -1) continue;
    store.put({
      id: d, name: 'lost-' + d.slice(0, 6), image: '(unknown: the record was lost)', reference: null, createdAt: iso(), createdBy: 'api',
      lost: true, status: 'running', exitCode: null, ports: [], volumes: [], shares: [], env: [], copyIn: [],
      runtime: { pid, startedAt: null, accel: null, machine: null, memMB: null, monitor: null, console: null },
    });
    knownPids.add(pid);
    out.lost++;
  }
  save();
  return out;
}

async function autostartAll() {
  let started = 0;
  for (const rec of store.list()) {
    if (!rec.autostart || isLive(rec.id) || rec.lost) continue;
    try {
      const a = await validateStart({ id: rec.id });
      const task = tasks.start({ kind: 'ctr-start', title: 'Autostart container ' + rec.name, ctr: rec.id, locks: ['ctr:' + rec.id] }, (t) => opStart(t, a));
      log('autostart: container ' + rec.name);
      const done = await tasks.wait(task.id);
      if (done && done.status === 'error') log('autostart of container "' + rec.name + '" failed: ' + String(done.error).split('\n')[0]);
      else started++;
    } catch (e) {
      log('autostart of container "' + rec.name + '" skipped: ' + errMsg(e));
    }
  }
  return { started };
}

module.exports = {
  load, adoptAll, autostartAll, shutdown, stateWarning,
  summaries, microvmStatus, reservedPorts, networkRows, runningContainers, liveContainers,
  listContainers, getContainer, getLogs, streamLogs, runRoute,
  validateStart, opStart, validateStop, opStop, kill, removeRoute, updateSettings, fallbackRoute,
  listVolumes, createVolume, removeVolume,
  validatePull, opPull, removeImageRoute, validatePrune, opPrune,
  // for tests and the MCP/GUI helpers
  findRecord, publicRecord, quickDeployBody, isLive, opRun,
  _internal: {
    lives, Live, finalize, stopSpawned, attachWatcher, startFlow, probeTcp, releasing, whenAdopted, checkLogSizes, adoptShareIds, checkPaused,
    armAdoptGate, liveInitrds, liveRefs, liveDisks, autoPruneTick, armAutoPrune,
  },
};
