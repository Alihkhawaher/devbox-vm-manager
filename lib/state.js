'use strict';
/*
 * The VM registry: <root>/vms.json, schema version 2 (spec section 4).
 *
 *   { "version": 2,
 *     "settings": { "accel": "auto", "defaultExpose": "local" },
 *     "vms": { "<name>": { port, sshLan, mem, cpus, accel, template, ports[],
 *              autostart, note, ephemeral, createdBy, createdAt,
 *              pendingFsResize, personalized, pendingRestart, lastError,
 *              shares: [{hostPath, guestPath, readOnly, id, secret}],
 *              runtime: {pid, startedAt, accel, monitor, serial} | null } } }
 *   (shares: live shared folders, lib/shares.js - an additive field, so the
 *   schema version stays 2; an older v2 manager drops it on its next save)
 *
 * Rules that fix the v1 data-loss bugs (BUG-4, OPS-6, MNT-11, BUG-17):
 *  - saveState() writes ONLY when the serialised registry changed, and always
 *    atomically (tmp + fsync + rename), keeping the previous file as .bak.
 *  - A file that cannot be parsed is renamed to vms.json.corrupt-<time>
 *    (never overwritten), the .bak is tried, and a warning is surfaced in
 *    /api/state. A file that cannot be READ (permissions) blocks all writes.
 *  - A VM whose disk is missing is never dropped; it shows as "missing".
 *  - Write errors are logged and surfaced, never swallowed.
 *
 * `state` is the single shared registry object. It is never replaced, only
 * mutated, so `const { state } = require('./state')` is always live.
 * Nothing touches the disk until loadState() is called.
 */
const fs = require('fs');
const path = require('path');
const { CFG } = require('./config');
const {
  exists, nowIso, atomicWriteFileSync, isVmName, vmNameError, badRequest, notFound, log, logError, errMsg,
} = require('./util');

const ACCELS = ['auto', 'whpx', 'kvm', 'hvf', 'tcg'];
const EXPOSE = ['local', 'lan'];

const state = { version: 2, settings: { accel: 'auto', defaultExpose: 'local' }, vms: {} };

// Bookkeeping that is NOT part of the registry file.
const meta = {
  lastWritten: null,   // exact text of the last successful write (or read)
  noWrite: null,       // reason writes are blocked (file exists but unreadable)
  warnings: [],        // shown in /api/state as stateWarning
  writeError: null,
  migratedFrom: null,  // registry version found by the last loadState() (1 = a v1 file)
};

function warn(msg) {
  if (meta.warnings.indexOf(msg) === -1) meta.warnings.push(msg);
  logError(msg);
}
// For other modules: a problem the user must see in the GUI (and MCP status).
function addWarning(msg) { warn(String(msg)); }
// Was the registry a v1 file when this manager started? (vm.adoptRunning only
// adopts VMs by their SSH port for such an upgrade - spec section 5.)
function migratedFromV1() { return meta.migratedFrom === 1; }
function stateWarning() {
  const all = meta.warnings.slice();
  if (meta.writeError) all.push(meta.writeError);
  return all.length ? all.join(' | ') : null;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------
function cleanMapping(p) {
  if (!p || typeof p !== 'object') return null;
  const host = parseInt(p.host, 10), guest = parseInt(p.guest, 10);
  if (!(host >= 1 && host <= 65535 && guest >= 1 && guest <= 65535)) return null;
  const m = { host: host, guest: guest };
  const c = parseInt(p.container, 10);
  if (c >= 1 && c <= 65535) m.container = c;
  if (typeof p.owner === 'string' && p.owner) m.owner = p.owner.slice(0, 128);
  m.lan = p.lan === true;
  // absent = TCP; a UDP forward must stay UDP across a manager restart
  if (p.proto === 'udp') m.proto = 'udp';
  return m;
}

// Live shared folders (lib/shares.js): {hostPath, guestPath, readOnly, id,
// secret}. The secret stays in this private file only; the API never shows
// it. Malformed entries are dropped.
function cleanShare(s) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.hostPath !== 'string' || !s.hostPath || typeof s.guestPath !== 'string' || !s.guestPath) return null;
  if (typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.id)) return null;
  if (typeof s.secret !== 'string' || !/^[A-Za-z0-9._~+=-]{16,256}$/.test(s.secret)) return null;
  return { hostPath: s.hostPath, guestPath: s.guestPath, readOnly: s.readOnly === true, id: s.id, secret: s.secret };
}

function cleanEndpoint(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.path === 'string' && e.path) return { path: e.path };
  const port = parseInt(e.port, 10);
  if (typeof e.host === 'string' && port >= 1 && port <= 65535) return { host: e.host, port: port };
  return null;
}

function cleanRuntime(r) {
  if (!r || typeof r !== 'object') return null;
  const pid = parseInt(r.pid, 10);
  if (!(pid > 0)) return null;
  const out = {
    pid: pid,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : null,
    accel: typeof r.accel === 'string' ? r.accel : null,
    monitor: cleanEndpoint(r.monitor),
    serial: cleanEndpoint(r.serial),
  };
  // appliance VMs: the private VNC endpoint of the screen (lib/screen.js)
  if (r.display) out.display = cleanEndpoint(r.display);
  if (r.legacy) out.legacy = true;
  return out;
}

// Appliance VMs (lib/appliance.js) boot a disk image or ISO of ANY operating
// system with a screen instead of SSH: firmware, disk bus, sound and where the
// image came from. null for an ordinary Alpine VM. Pure.
const FIRMWARES = ['uefi', 'bios'];
const BUSES = ['virtio', 'sata'];
// the display adapter: virtio-vga (a VGA for the firmware, virtio-gpu for the
// OS - what Linux images drive best) or std (QEMU's plain VGA, for systems
// without a virtio-gpu driver)
const VGAS = ['virtio', 'std'];
function cleanAppliance(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    firmware: FIRMWARES.indexOf(a.firmware) >= 0 ? a.firmware : 'uefi',
    bus: BUSES.indexOf(a.bus) >= 0 ? a.bus : 'virtio',
    vga: VGAS.indexOf(a.vga) >= 0 ? a.vga : 'virtio',
    sound: a.sound !== false,
    source: typeof a.source === 'string' ? a.source.slice(0, 1000) : '',
    sourceSha256: typeof a.sourceSha256 === 'string' && /^[0-9a-f]{64}$/i.test(a.sourceSha256) ? a.sourceSha256.toLowerCase() : null,
    media: a.media === 'iso' ? 'iso' : 'disk',   // iso: the image stays a CD-ROM beside an empty disk
  };
}

// v1 stored the template as an absolute path ("base"); v2 stores its name.
function templateNameFromBase(base) {
  if (!base || typeof base !== 'string') return null;
  const b = path.basename(base.replace(/\\/g, '/')).replace(/\.qcow2$/i, '');
  return b || null;
}

// A complete record with defaults for everything not given. Pure.
function newVmRecord(f) {
  f = f || {};
  return {
    port: f.port || null,
    sshLan: f.sshLan === true,
    mem: f.mem || CFG.defaultMem,
    cpus: f.cpus || CFG.defaultCpus,
    accel: ACCELS.indexOf(f.accel) >= 0 ? f.accel : 'auto',
    template: f.template === undefined ? 'devbox-base' : f.template,
    ports: (f.ports || []).map(cleanMapping).filter(Boolean),
    autostart: f.autostart === true,
    note: typeof f.note === 'string' ? f.note.slice(0, 500) : '',
    ephemeral: f.ephemeral === true,
    createdBy: typeof f.createdBy === 'string' ? f.createdBy.slice(0, 32) : 'gui',
    createdAt: f.createdAt || nowIso(),
    pendingFsResize: f.pendingFsResize === true,
    personalized: f.personalized === true,
    pendingRestart: f.pendingRestart === true,
    lastError: f.lastError && typeof f.lastError === 'object' ? f.lastError : null,
    shares: Array.isArray(f.shares) ? f.shares.map(cleanShare).filter(Boolean) : [],
    // 'alpine' (the Linux sandbox with SSH) or 'appliance' (any OS image with a screen)
    kind: f.kind === 'appliance' ? 'appliance' : 'alpine',
    appliance: f.kind === 'appliance' ? cleanAppliance(f.appliance) : null,
    runtime: cleanRuntime(f.runtime),
  };
}

// Bring one stored record (v1 or v2) to the v2 shape. Pure.
function normalizeVm(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const port = parseInt(raw.port, 10);
  const f = Object.assign({}, raw, {
    port: port >= 1 && port <= 65535 ? port : null,
    mem: parseInt(raw.mem, 10) > 0 ? parseInt(raw.mem, 10) : undefined,
    cpus: parseInt(raw.cpus, 10) > 0 ? parseInt(raw.cpus, 10) : undefined,
    template: raw.template !== undefined ? raw.template : (templateNameFromBase(raw.base) || 'devbox-base'),
    // v1 records carried pid/startedAt at the top level: never trusted in v2
    // (a pid from a previous boot can belong to any process now, BUG-2)
    runtime: raw.runtime,
  });
  if (f.template === 'devbox-base.qcow2') f.template = 'devbox-base';
  return newVmRecord(f);
}

// Whole-file migration. Pure: returns {version, settings, vms, migratedFrom,
// dropped}. `dropped` lists the record names that cannot be kept because v2
// names are stricter than v1's (v1 took any [A-Za-z0-9._-], e.g. "_test" or
// "foo."): loadState() reports each one instead of losing it silently.
function migrate(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const from = raw.version === 2 ? 2 : (raw.vms ? 1 : 0);
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = {
    accel: ACCELS.indexOf(s.accel) >= 0 ? s.accel : 'auto',
    defaultExpose: EXPOSE.indexOf(s.defaultExpose) >= 0 ? s.defaultExpose : 'local',
  };
  const vms = {};
  const dropped = [];
  const src = raw.vms && typeof raw.vms === 'object' ? raw.vms : {};
  for (const name of Object.keys(src)) {
    if (!isVmName(name)) { dropped.push(name); continue; } // cannot be a file we manage
    vms[name] = normalizeVm(src[name]);
  }
  return { version: 2, settings: settings, vms: vms, migratedFrom: from, dropped: dropped };
}

// ---------------------------------------------------------------------------
// paths per VM (all under the data root)
// ---------------------------------------------------------------------------
const j = (...p) => path.posix.join(...p);
function diskPath(name) { return j(CFG.sandboxDir, name + '.qcow2'); }
// appliance VMs: the UEFI variable store (a private copy per VM) and the ISO
// that stays attached as a CD-ROM (media 'iso')
function varsPath(name) { return j(CFG.sandboxDir, name + '-vars.fd'); }
function mediaPath(name) { return j(CFG.sandboxDir, name + '-media.iso'); }
function serialLogPath(name) { return j(CFG.sandboxDir, name + '-serial.log'); }
const logPath = serialLogPath; // v1 name
function qemuLogPath(name) { return j(CFG.logsDir, 'qemu-' + name + '.log'); }
function pidFilePath(name) { return j(CFG.runDir, name + '.pid'); }
function knownHostsPath(name) { return j(CFG.knownHostsDir, name); }

// Disk names in sandboxes/ ([] when the folder does not exist yet), or null
// when the folder exists but cannot be read - then nothing may change.
function listDisks() {
  try {
    return fs.readdirSync(CFG.sandboxDir).filter((f) => /\.qcow2$/i.test(f)).map((f) => f.replace(/\.qcow2$/i, ''));
  } catch (e) {
    return e.code === 'ENOENT' ? [] : null;
  }
}

// Lowest SSH port no VM uses (SSH or forward) and that is not the manager's.
// Synchronous and registry-only: ports.allocSshPort() also checks the OS.
function nextFreeSshPortSync() {
  const taken = new Set([CFG.serverPort, CFG.bakeSshPort]);
  for (const vm of Object.values(state.vms)) {
    if (vm.port) taken.add(vm.port);
    for (const p of vm.ports || []) taken.add(p.host);
  }
  let p = CFG.firstSshPort;
  while (taken.has(p) && p < 65535) p++;
  return p;
}

// Disks without a record (copied in by hand, or v1 state lost) get one.
// Their template is unknown (null) until vm.fillUnknownTemplates() reads the
// backing file. Returns the names added.
function syncDisks() {
  const disks = listDisks();
  if (disks === null) return [];
  const added = [];
  for (const n of disks) {
    if (state.vms[n] || !isVmName(n)) continue;
    state.vms[n] = newVmRecord({ port: nextFreeSshPortSync(), template: null, createdBy: 'discovered' });
    added.push(n);
  }
  for (const [n, vm] of Object.entries(state.vms)) if (!vm.port) vm.port = nextFreeSshPortSync();
  if (added.length) log('found ' + added.length + ' disk(s) without a record: ' + added.join(', '));
  return added;
}

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------
function readText(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), error: null }; }
  catch (e) { return { text: null, error: e }; }
}

function parseRegistry(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the top level is not a JSON object');
  return raw;
}

function stampForFile() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Adopt a v1 vms.json that lived beside the code (OPS-7): copy it into the
// data root and rename the old one so it is never used again. Never for an
// explicit --data folder: a scratch or test instance must not take over the
// real registry.
function migrateLegacyLocation() {
  const legacy = CFG.legacyStateFile;
  if (CFG.rootSource === '--data') return false;
  if (!legacy || path.resolve(legacy) === path.resolve(CFG.stateFile) || !exists(legacy)) return false;
  try {
    fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
    fs.copyFileSync(legacy, CFG.stateFile);
    try { fs.renameSync(legacy, legacy + '.migrated'); } catch (e) { /* read-only checkout: the copy is what matters */ }
    log('moved the VM registry from ' + legacy + ' to ' + CFG.stateFile);
    return true;
  } catch (e) {
    warn('could not move the old registry ' + legacy + ' into the data folder: ' + errMsg(e));
    return false;
  }
}

function applyRegistry(m) {
  state.version = 2;
  state.settings = m.settings;
  state.vms = m.vms;
}

// Load (or create) the registry. Never overwrites a file it could not parse.
function loadState() {
  meta.warnings = [];
  meta.noWrite = null;
  meta.writeError = null;
  meta.lastWritten = null;
  if (CFG.configWarning) warn(CFG.configWarning);

  let r = readText(CFG.stateFile);
  if (r.error && r.error.code === 'ENOENT') {
    if (migrateLegacyLocation()) r = readText(CFG.stateFile);
    else if (exists(CFG.stateFile + '.bak')) {
      // a crash between the backup copy and the rename would leave only .bak
      r = readText(CFG.stateFile + '.bak');
      if (!r.error) warn('vms.json was missing; restored it from vms.json.bak');
    }
  }

  let raw = null;
  if (r.error && r.error.code !== 'ENOENT') {
    meta.noWrite = 'vms.json exists but cannot be read (' + errMsg(r.error) + ') - changes are NOT being saved';
    warn(meta.noWrite);
  } else if (r.text !== null) {
    try { raw = parseRegistry(r.text); meta.lastWritten = r.text; }
    catch (e) {
      const aside = CFG.stateFile + '.corrupt-' + stampForFile();
      try { fs.renameSync(CFG.stateFile, aside); } catch (e2) { /* keep going; noWrite below protects it */ }
      if (exists(CFG.stateFile)) {
        meta.noWrite = 'vms.json is damaged and could not be moved aside - changes are NOT being saved';
      }
      warn('vms.json could not be parsed (' + errMsg(e) + '); it was kept as ' + path.basename(aside) + ' and the VM list starts from the disks found');
      const bak = readText(CFG.stateFile + '.bak');
      if (!bak.error && bak.text) {
        try { raw = parseRegistry(bak.text); warn('restored the VM settings from vms.json.bak'); }
        catch (e3) { /* the backup is damaged too: start from the disks */ }
      }
    }
  }

  const m = migrate(raw || {});
  applyRegistry(m);
  meta.migratedFrom = m.migratedFrom;
  for (const n of m.dropped) {
    warn('the VM "' + n + '" from the old registry was not imported: its name is not valid any more (use 1-63 letters, digits, ".", "_" or "-", ' +
      'starting with a letter or digit, not ending with ".") - rename sandboxes/' + n + '.qcow2 (and ' + n + '-serial.log) to a valid name and restart the manager' +
      (m.migratedFrom === 1 ? '; its old settings are kept in the vms.json.v1-* copy' : ''));
  }
  if (m.migratedFrom === 1) {
    // The .bak kept by saveState() is overwritten by the SECOND save, so the
    // only copy of the v1 file (settings of VMs that could not be imported,
    // port lists, notes) would be gone within seconds: keep one for good.
    const copy = CFG.stateFile + '.v1-' + stampForFile();
    try {
      if (exists(CFG.stateFile)) { fs.copyFileSync(CFG.stateFile, copy); log('kept a copy of the version 1 registry as ' + path.basename(copy)); }
    } catch (e) { warn('could not keep a copy of the version 1 registry (' + errMsg(e) + ') - vms.json.bak holds it until the next change'); }
    log('upgraded vms.json from version 1 to version 2');
  }
  syncDisks();
  saveState();
  return state;
}

// Write the registry if (and only if) it changed. Returns true when the file
// on disk now matches memory.
function saveState() {
  if (meta.noWrite) return false;
  const text = JSON.stringify({ version: 2, settings: state.settings, vms: state.vms }, null, 2) + '\n';
  if (text === meta.lastWritten) return true;
  try {
    fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
    // shared-folder secrets are in here: both files are written private
    // (sec-5 - a plain copy or write would inherit the data folder's ACL,
    // which lets every account of this PC read it)
    const platform = require('./platform');
    if (exists(CFG.stateFile)) {
      try { platform.writePrivateFileSync(CFG.stateFile + '.bak', fs.readFileSync(CFG.stateFile), { atomic: true, tmpDir: CFG.runDir }); }
      catch (e) { /* the atomic write still protects us */ }
    }
    platform.writePrivateFileSync(CFG.stateFile, text, { atomic: true, tmpDir: CFG.runDir });
    meta.lastWritten = text;
    if (meta.writeError) { log('vms.json is being saved again'); meta.writeError = null; }
    return true;
  } catch (e) {
    const msg = 'could not save vms.json: ' + errMsg(e);
    if (meta.writeError !== msg) logError(msg);
    meta.writeError = msg;
    return false;
  }
}

// ---------------------------------------------------------------------------
// lookups and global settings
// ---------------------------------------------------------------------------
// The record for a VALID existing name, else a 400/404 ApiError.
function getVm(name) {
  const why = vmNameError(name);
  if (why) throw badRequest('bad VM name: ' + why);
  const vm = state.vms[name];
  if (!vm) throw notFound('no VM called "' + name + '"');
  return vm;
}

// POST /api/settings {accel?, defaultExpose?} -> the settings
function updateSettings(body) {
  body = body || {};
  if (body.accel !== undefined) {
    if (ACCELS.indexOf(body.accel) === -1) throw badRequest('accel must be one of ' + ACCELS.join(', '));
    state.settings.accel = body.accel;
  }
  if (body.defaultExpose !== undefined) {
    if (EXPOSE.indexOf(body.defaultExpose) === -1) throw badRequest('defaultExpose must be "local" (this PC only) or "lan"');
    state.settings.defaultExpose = body.defaultExpose;
  }
  saveState();
  return { settings: Object.assign({}, state.settings) };
}

module.exports = {
  state, ACCELS, EXPOSE,
  loadState, saveState, stateWarning, addWarning, migratedFromV1, migrate, normalizeVm, newVmRecord, cleanMapping, cleanShare, templateNameFromBase,
  getVm, updateSettings, syncDisks, listDisks, nextFreeSshPortSync,
  diskPath, varsPath, mediaPath, serialLogPath, logPath, qemuLogPath, pidFilePath, knownHostsPath,
  cleanAppliance, FIRMWARES, BUSES, VGAS,
  _meta: meta,
};
