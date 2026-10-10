'use strict';
/*
 * Configuration: where the data lives, which port the GUI uses, where every
 * file under the data root is, the host limits, the access token, and the
 * command line.
 *
 * CFG is ONE shared object. configure() rewrites its properties in place and
 * never replaces the object, so every module that did
 *   const { CFG } = require('./config');
 * sees the values chosen on the command line. For the same reason no module may
 * copy a CFG value into a top-level constant at require time - read CFG.x at
 * the moment it is needed.
 *
 * Precedence (spec section 2): CLI flags > environment > <root>/config.json >
 * defaults.
 *
 *   data root : --data <dir> > VM_MANAGER_ROOT > the legacy home layout (if
 *               ~/sandboxes or ~/devbox-base.qcow2 exists, so old installs keep
 *               working) > <app dir>/data (portable-app style, gitignored)
 *   port      : --port > VM_MANAGER_PORT > config.json "port" > 8777
 *   tools     : config.json "qemuDir", "ssh", "sshKeygen", "scp", "sevenZip"
 *               override the discovery in platform.js
 *   engine    : config.json keys of ENGINE_SETTINGS (microVM root filesystem
 *               and memory, TCG translation caches, full-VM default memory,
 *               the Alpine download, image auto-prune, disk floors) > the
 *               profile default: "lightProfile": true picks the light column
 *               of that table, so the manager fits inside another VM. The
 *               profile only changes DEFAULTS - an explicit key always wins.
 *               POST /api/settings writes them (updateEngineSettings).
 *
 * Requiring this file only computes defaults. It may READ (does the legacy
 * layout exist, is there a config.json) but never writes, listens or spawns,
 * so tests can load any lib/ module safely.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// The folder that holds server.js, public/ and lib/.
const APP_DIR = path.resolve(__dirname, '..');
const APP_NAME = 'devbox-vm-manager';
const DEFAULT_PORT = 8777;
const MB = 1024 * 1024;

const CFG = {};

// Normalise a directory to forward slashes with no trailing slash, the form the
// rest of the code builds paths from (Node, QEMU and ssh accept it on every OS).
// A bare drive ("C:") or the POSIX root keeps its slash so it stays absolute.
function normDir(p) {
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (s === '') s = '/';
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  return s;
}
const join = (...parts) => path.posix.join(...parts);

let versionCache = null;
function version() {
  if (versionCache) return versionCache;
  try { versionCache = String(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || '0.0.0'); }
  catch (e) { versionCache = '0.0.0'; }
  return versionCache;
}

// First 12 hex chars of sha256(data root): lets a second launch (or the MCP
// server) tell "the manager for THIS data folder" from any other copy.
function rootId(root) {
  const r = path.resolve(String(root || CFG.root)).replace(/\\/g, '/').replace(/\/+$/, '');
  const key = process.platform === 'win32' ? r.toLowerCase() : r;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// An existing v1 install kept everything directly in the home folder.
function legacyHomeRoot(home) {
  if (!home) return null;
  try {
    if (fs.existsSync(path.join(home, 'sandboxes')) || fs.existsSync(path.join(home, 'devbox-base.qcow2'))) return home;
  } catch (e) { /* unreadable home: not a legacy layout */ }
  return null;
}

// <root>/config.json: optional user settings. A broken file is reported, not
// fatal - the manager must still start so the user can see the warning.
function readConfigFile(root) {
  const f = join(root, 'config.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { data: {}, warning: f + ' is not a JSON object - ignored' };
    return { data: j, warning: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { data: {}, warning: null };
    return { data: {}, warning: 'config.json ignored: ' + e.message };
  }
}

function portValue(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 65535 ? n : null;
}

// Memory limit derived from the host: leave ~1.5 GB for Windows/the desktop,
// round down to 256 MB, never below 1 GB (spec section 2, OPS-16).
function maxMemFor(totalBytes) {
  return Math.max(1024, Math.floor((totalBytes - 1.5 * 1024 * MB) / (256 * MB)) * 256);
}

// (Re)compute every setting.
//   opts: { data?, port?, env? (default process.env), home? (default homedir) }
// env/home are injectable so tests can check the precedence rules.
function configure(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const home = opts.home !== undefined ? opts.home : os.homedir();

  let root, rootSource;
  if (opts.data) { root = path.resolve(String(opts.data)); rootSource = '--data'; }
  else if (env.VM_MANAGER_ROOT) { root = path.resolve(String(env.VM_MANAGER_ROOT)); rootSource = 'VM_MANAGER_ROOT'; }
  else if (legacyHomeRoot(home)) { root = path.resolve(home); rootSource = 'existing install in your home folder'; }
  else { root = path.join(APP_DIR, 'data'); rootSource = 'default'; }
  root = normDir(root);

  const file = readConfigFile(root);
  const fc = file.data;

  let port = DEFAULT_PORT, portSource = 'default';
  if (opts.port) { port = opts.port; portSource = '--port'; }
  else if (portValue(env.VM_MANAGER_PORT)) { port = portValue(env.VM_MANAGER_PORT); portSource = 'VM_MANAGER_PORT'; }
  else if (portValue(fc.port)) { port = portValue(fc.port); portSource = 'config.json'; }

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // explicit opt-outs of a safety rule: only the JSON value true counts
  const optIn = (v) => v === true;
  const toolOverrides = {
    qemuDir: str(fc.qemuDir), ssh: str(fc.ssh), sshKeygen: str(fc.sshKeygen),
    scp: str(fc.scp), sevenZip: str(fc.sevenZip),
  };

  const runDir = join(root, 'run');
  const logsDir = join(root, 'logs');
  const maxMem = maxMemFor(os.totalmem());
  const engine = effectiveDefaults(fc, { maxMem: maxMem, minMem: MIN_VM_MEM });
  const warnings = [file.warning].concat(engine.warnings).filter(Boolean);
  Object.assign(CFG, {
    appName: APP_NAME,
    appDir: APP_DIR,
    root: root,
    rootSource: rootSource,
    configFile: join(root, 'config.json'),
    configWarning: warnings.length ? warnings.join('; ') : null,
    // disks and images
    sandboxDir: join(root, 'sandboxes'),
    basesDir: join(root, 'vm-bases'),
    base: join(root, 'devbox-base.qcow2'),
    alpine: join(root, 'vm-alpine.qcow2'),
    downloadsDir: join(root, 'downloads'),
    // appliance VMs: OS images downloaded from a URL, reused by later creates
    appliancesDownloadsDir: join(root, 'appliances', 'downloads'),
    // managed QEMU install (Windows auto-install target; platform.js looks here)
    qemuDir: join(root, 'qemu'),
    // SSH key shared by every VM
    seedDir: join(root, 'seed'),
    sshKey: join(root, 'seed', 'id_dev'),
    sshPub: join(root, 'seed', 'id_dev.pub'),
    // runtime files: pid files, monitor/serial sockets, known_hosts per VM
    runDir: runDir,
    knownHostsDir: join(runDir, 'known_hosts'),
    managerFile: join(runDir, 'manager.json'),
    // logs (size-capped rotation, see util.appendRotating)
    logsDir: logsDir,
    managerLog: join(logsDir, 'manager.log'),
    tasksLog: join(logsDir, 'tasks.log'),
    // registry + access token
    stateFile: join(root, 'vms.json'),
    // v1 kept vms.json beside the code; state.js migrates it once
    legacyStateFile: join(normDir(APP_DIR), 'vms.json'),
    tokenFile: join(root, 'manager-token'),
    // network
    serverPort: port,
    portSource: portSource,
    firstSshPort: 2223,
    firstPort: 2223, // v1 name, kept as an alias
    bakeSshPort: 2222,
    // limits derived from this host (OPS-16); defaultMem (full VMs) is an
    // engine setting: 1024, or 512 with the light profile
    defaultCpus: 2,
    minMem: MIN_VM_MEM,
    maxMem: maxMem,
    maxCpus: Math.max(1, os.cpus().length),
    minDiskGB: 2,
    maxDiskGB: 2048,
    toolOverrides: toolOverrides,
    // config.json opt-outs (both default false, both documented in the README):
    //  allowSharedLoopback - Windows: let QEMU's monitor/serial sockets use
    //    127.0.0.1 when no other loopback address can be bound (the VMs can
    //    then reach them); without it such a start fails with a clear error
    //  allowUnsignedQemu - install a QEMU installer that is not signed by its
    //    known publisher (see install.js authenticode)
    allowSharedLoopback: optIn(fc.allowSharedLoopback),
    allowUnsignedQemu: optIn(fc.allowUnsignedQemu),
    // --- microVM engine (one Docker image = one headless microVM) ---
    //  kernel/      verified Alpine packages + <kver>/ kernel assets, host.json
    //  images/      OCI blob cache, refs.json, index.json, rootfs/, initrd/
    //  microvms/    one run directory per container (logs, spec, pid file)
    //  volumes/     named volumes (<name>.qcow2 + <name>.lock)
    //  containers.json  the container registry (lib/microvm/store.js)
    kernelDir: join(root, 'kernel'),
    hostFactsFile: join(root, 'kernel', 'host.json'),
    imagesDir: join(root, 'images'),
    microvmsDir: join(root, 'microvms'),
    volumesDir: join(root, 'volumes'),
    containersFile: join(root, 'containers.json'),
    // optional config.json keys (numbers are MB)
    //  microvmMemCapMB   - above this a microVM is "too big" (default
    //                      min(2048, maxMem / 2)); compat.js uses it
    //  containerLogCapMB - per boot, per stream (default 1024)
    //  alpineMirror      - base URL for the kernel packages (https only)
    microvmMemCapMB: posInt(fc.microvmMemCapMB),
    containerLogCapMB: posInt(fc.containerLogCapMB),
    alpineMirror: httpsUrl(fc.alpineMirror),
    // --- live shared folders (lib/shares.js, lib/ninep/) ---
    //  ninepPort - the port of the manager's own 9P server on 127.0.0.1.
    //  Running VMs' mounts depend on it staying the same, so shares.js
    //  persists the port it actually used into config.json (default 5640).
    ninepPort: portValue(fc.ninepPort),
  });
  // --- engine settings and the light profile (ENGINE_SETTINGS below) ---
  //  lightProfile, microvmRootfs, microvmMemMB, tcgTbSizeMB, vmTcgTbSizeMB,
  //  defaultMem, keepAlpineDownload, imagePruneDays, minFreeDiskMB,
  //  microvmImageDiskGB, microvmImageMaxGB, engineExplicit
  applyEngine(engine);
  return CFG;
}

// ---------------------------------------------------------------------------
// engine settings and the light profile (SPEC-diskroot sections 9, 10, 13)
// ---------------------------------------------------------------------------
// The goal of the project is to be light enough to run inside another VM.
// One switch, config.json "lightProfile": true, lowers the DEFAULTS below;
// every key can also be set on its own in config.json, and an explicit key
// always beats the profile. The engine reads only the resolved CFG field
// (`cfg`), at the moment it needs it, so a change through POST /api/settings
// applies to the next VM or container without a restart.
//   normal / light: the defaults of the two profiles
//   min / max: whole numbers in that range; zeroOr: 0 is allowed too and
//     means "QEMU's own default"; max 'maxMem' = this host's memory limit
//   api: settable through POST /api/settings (the rest: config.json only)
// Where the numbers come from (measured on WHPX and TCG, SPEC-diskroot 1.4,
// 1.5): a disk-root microVM boots every image tried at 128 MB; python's
// import-heavy test needs 112 (fails at 96, the floor for small apps); a
// TCG translation cache of 64 MB instead of 128 saves ~84 MB per microVM for
// ~1.4 s more to the first answer; QEMU's default cache for a TCG VM is 1 GiB,
// committed up front on Windows (a 256 MB guest cost 1.33 GB).
const MIN_VM_MEM = 256;
const DISK_MIN_MEM_MB = 96;
const ENGINE_SETTINGS = {
  microvmRootfs: { cfg: 'microvmRootfs', normal: 'disk', light: 'disk', values: ['disk', 'ram'], api: true,
    what: 'the default root filesystem of a container: "disk" (the image stays on a shared read-only disk, about 128 MB of RAM) or "ram"' },
  microvmMemMB: { cfg: 'microvmMemMB', normal: 128, light: 112, min: DISK_MIN_MEM_MB, max: 'maxMem', unit: 'MB', api: true,
    what: 'the default memory of a disk-root container' },
  tcgTbSizeMB: { cfg: 'tcgTbSizeMB', normal: 128, light: 64, zeroOr: true, min: 16, max: 1024, unit: 'MB', api: true,
    what: 'the TCG translation cache of a container without hardware acceleration' },
  vmTcgTbSizeMB: { cfg: 'vmTcgTbSizeMB', normal: 0, light: 256, zeroOr: true, min: 64, max: 2048, unit: 'MB', api: true,
    what: 'the TCG translation cache of a full VM without hardware acceleration; QEMU\'s default is 1 GB' },
  vmDefaultMemMB: { cfg: 'defaultMem', normal: 1024, light: 512, min: MIN_VM_MEM, max: 'maxMem', unit: 'MB', api: true,
    what: 'the default memory of a new full VM' },
  keepAlpineDownload: { cfg: 'keepAlpineDownload', normal: true, light: false, bool: true, api: true,
    what: 'keep the Alpine download after the base image is built; without it a rebuild downloads it again' },
  imagePruneDays: { cfg: 'imagePruneDays', normal: 0, light: 7, min: 0, max: 365, unit: 'days', api: true,
    what: 'remove cached images no container used for this many days; 0 = never' },
  minFreeDiskMB: { cfg: 'minFreeDiskMB', normal: 1024, light: 1024, min: 0, max: 1048576, unit: 'MB',
    what: 'the free disk space a container start needs' },
  microvmImageDiskGB: { cfg: 'microvmImageDiskGB', normal: 8, light: 8, min: 1, max: 2048, unit: 'GB',
    what: 'the smallest virtual size of an image disk' },
  microvmImageMaxGB: { cfg: 'microvmImageMaxGB', normal: 16, light: 16, min: 1, max: 2048, unit: 'GB',
    what: 'the largest unpacked image a disk-root container accepts' },
};
const ENGINE_KEYS = Object.keys(ENGINE_SETTINGS);
// what POST /api/settings may change (lightProfile + the api keys)
const ENGINE_API_KEYS = ['lightProfile'].concat(ENGINE_KEYS.filter((k) => ENGINE_SETTINGS[k].api));

// The accepted range of one setting, for messages and the GUI.
function rangeOf(key, limits) {
  const d = ENGINE_SETTINGS[key];
  if (!d || d.bool || d.values) return null;
  const max = d.max === 'maxMem' ? limits.maxMem : d.max;
  return { min: d.min, max: max, zeroOr: !!d.zeroOr };
}

// One value -> {value} or {error} (a sentence naming the key). Pure.
//   limits: {maxMem}
function checkEngineValue(key, v, limits) {
  if (key === 'lightProfile') return typeof v === 'boolean' ? { value: v } : { error: 'lightProfile must be true or false' };
  const d = ENGINE_SETTINGS[key];
  if (!d) return { error: key + ' is not a setting' };
  if (d.bool) return typeof v === 'boolean' ? { value: v } : { error: key + ' must be true or false' };
  if (d.values) return d.values.indexOf(v) !== -1 ? { value: v } : { error: key + ' must be one of ' + d.values.map((x) => '"' + x + '"').join(', ') };
  const r = rangeOf(key, limits);
  const ok = Number.isInteger(v) && ((r.zeroOr && v === 0) || (v >= r.min && v <= r.max));
  if (ok) return { value: v };
  return { error: key + ' (' + d.what + ') must be a whole number of ' + d.unit + ': ' + (r.zeroOr ? '0 for QEMU\'s default, or ' : '') + r.min + ' to ' + r.max };
}

// The profile defaults of the api keys: {normal: {...}, light: {...}}. Pure.
function profileDefaults() {
  const out = { normal: {}, light: {} };
  for (const k of ENGINE_API_KEYS) {
    if (k === 'lightProfile') continue;
    out.normal[k] = ENGINE_SETTINGS[k].normal;
    out.light[k] = ENGINE_SETTINGS[k].light;
  }
  return out;
}

// config.json data -> the effective engine settings. Pure.
//   limits: {maxMem}
//   -> {lightProfile, values: {key: value} (config.json key names),
//       explicit: [keys config.json sets validly], warnings: [text]}
// A missing or null key takes the profile default; an invalid one is
// reported and takes the profile default too (the manager must still start).
function effectiveDefaults(fc, limits) {
  fc = fc || {};
  limits = limits || { maxMem: CFG.maxMem };
  const warnings = [];
  const explicit = [];
  let light = false;
  if (fc.lightProfile !== undefined && fc.lightProfile !== null) {
    const c = checkEngineValue('lightProfile', fc.lightProfile, limits);
    if (c.error) warnings.push('config.json: ' + c.error + ' - ignored');
    else { light = c.value; explicit.push('lightProfile'); }
  }
  const values = {};
  for (const k of ENGINE_KEYS) {
    const d = ENGINE_SETTINGS[k];
    values[k] = light ? d.light : d.normal;
    if (fc[k] === undefined || fc[k] === null) continue;
    const c = checkEngineValue(k, fc[k], limits);
    if (c.error) { warnings.push('config.json: ' + c.error + ' - using ' + JSON.stringify(values[k])); continue; }
    values[k] = c.value;
    explicit.push(k);
  }
  return { lightProfile: light, values: values, explicit: explicit, warnings: warnings };
}

// Put the resolved settings on CFG (in place, like configure()).
function applyEngine(engine) {
  CFG.lightProfile = engine.lightProfile;
  for (const k of ENGINE_KEYS) CFG[ENGINE_SETTINGS[k].cfg] = engine.values[k];
  CFG.engineExplicit = engine.explicit.slice();
}

// The engine settings as GET /api/state reports them (merged into
// state.settings by http.js): the effective values under their config.json
// names, which of them config.json sets, both profiles' defaults and the
// accepted ranges (the GUI checks input with them).
function engineSettings() {
  const out = { lightProfile: !!CFG.lightProfile };
  const ranges = {};
  for (const k of ENGINE_API_KEYS) {
    if (k === 'lightProfile') continue;
    out[k] = CFG[ENGINE_SETTINGS[k].cfg];
    const r = rangeOf(k, { maxMem: CFG.maxMem });
    if (r) ranges[k] = r;
  }
  out.explicit = (CFG.engineExplicit || []).filter((k) => ENGINE_API_KEYS.indexOf(k) !== -1);
  out.profileDefaults = profileDefaults();
  out.ranges = ranges;
  return out;
}

// POST /api/settings body -> {changes: {key: value | null}} with only the
// engine keys it names; null removes the key from config.json (back to the
// profile default). Every key is checked before anything is written; a bad
// one is a 400 naming the key and its range.
function validateEngineSettings(body) {
  body = body || {};
  const changes = {};
  for (const k of ENGINE_API_KEYS) {
    if (body[k] === undefined) continue;
    if (body[k] === null) { changes[k] = null; continue; }
    const c = checkEngineValue(k, body[k], { maxMem: CFG.maxMem });
    if (c.error) throw apiErr(400, 'BAD_REQUEST', c.error);
    changes[k] = c.value;
  }
  return { changes: changes };
}

// Write the engine keys of a POST /api/settings body into config.json (one
// atomic write) and re-resolve CFG in place. -> {settings: engineSettings()}
// The manager never rewrites a config.json it cannot parse (409).
function updateEngineSettings(body) {
  const { changes } = validateEngineSettings(body);
  if (!Object.keys(changes).length) return { settings: engineSettings() };
  const put = {};
  for (const k of Object.keys(changes)) put[k] = changes[k] === null ? undefined : changes[k];
  if (!setConfigValues(put)) {
    throw apiErr(409, 'CONFIG_UNREADABLE', CFG.configFile + ' cannot be parsed, so the settings were not saved - fix or delete that file, then try again');
  }
  const file = readConfigFile(CFG.root);
  applyEngine(effectiveDefaults(file.data, { maxMem: CFG.maxMem }));
  return { settings: engineSettings() };
}

// An Error the HTTP layer turns into {status, code} (the same shape as
// util.ApiError; util is not required here to keep config.js dependency-free).
function apiErr(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Optional positive whole number from config.json, else null (= default).
function posInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}
// Optional https:// base URL from config.json (ending in "/"), else null.
function httpsUrl(v) {
  if (typeof v !== 'string' || !/^https:\/\/[^\s"'<>]+$/i.test(v.trim())) return null;
  const s = v.trim();
  return s.endsWith('/') ? s : s + '/';
}

// Proof that a manager knows the token, for GET /api/ping?nonce= (the ping
// itself is public - guests and any local program can call it). A client
// sends a random nonce and only trusts (sends the token to, or opens the
// browser with #token= for) a port that answers with this value. The port is
// part of the message, so a fake server cannot simply relay the nonce to the
// real manager and pass its answer on: the real one proves its OWN port.
function pingProof(token, nonce, port) {
  return crypto.createHmac('sha256', String(token)).update('devbox-ping|' + nonce + '|' + port).digest('hex');
}

// ---------------------------------------------------------------------------
// access token (spec section 8): created once, reused across restarts
// ---------------------------------------------------------------------------
function readToken() {
  try {
    const t = fs.readFileSync(CFG.tokenFile, 'utf8').trim();
    return /^[0-9a-f]{32,128}$/i.test(t) ? t : null;
  } catch (e) { return null; }
}

// Returns the token, creating <root>/manager-token on first use. The file is
// made private (chmod 600 / Windows ACL) because it grants full API access.
function ensureToken() {
  const have = readToken();
  if (have) return have;
  fs.mkdirSync(CFG.root, { recursive: true });
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(CFG.tokenFile, t + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    // Another process created it a moment ago: use theirs. A malformed file
    // (hand-edited) is replaced.
    const again = readToken();
    if (again) return again;
    fs.writeFileSync(CFG.tokenFile, t + '\n', { mode: 0o600 });
  }
  protectToken();
  return t;
}

// Make the token file readable by this user only (chmod 600 / Windows ACL).
// server.js calls it on EVERY start, like ssh.protectKey(): the data folder is
// meant to be moved or copied, and a file copied into e.g. D:\VMs inherits
// that folder's ACL (Authenticated Users can read it). Returns {ok, error}.
function protectToken() {
  if (!fs.existsSync(CFG.tokenFile)) return { ok: true, error: null };
  // lazy require: platform.js depends on this module
  try { return require('./platform').protectPrivateFile(CFG.tokenFile); }
  catch (e) { return { ok: false, error: e.message }; }
}

// Folders the running manager writes to. Called by server.js, never at require.
function ensureDirs() {
  for (const d of [CFG.root, CFG.runDir, CFG.knownHostsDir, CFG.logsDir]) fs.mkdirSync(d, { recursive: true });
}

// Set (or with value undefined, remove) one key of <root>/config.json,
// keeping every other key and the user's own formatting choices out of it
// (the file is rewritten as 2-space JSON). Used for values the manager must
// remember across restarts, e.g. the 9P port shares.js picked, and for the
// engine settings of the GUI. Returns true when written; a config.json that
// cannot be parsed is never overwritten.
function setConfigValue(key, value) {
  const o = {};
  o[key] = value;
  return setConfigValues(o);
}
// Several keys in ONE write (an undefined value removes its key).
function setConfigValues(values) {
  const file = CFG.configFile;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  } catch (e) {
    if (e.code !== 'ENOENT') return false;
    data = {};
  }
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete data[key]; else data[key] = values[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return true;
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------
const USAGE = [
  'Usage: node server.js [options]',
  '',
  '  --port <n>     port for the GUI/API on 127.0.0.1 (default ' + DEFAULT_PORT + '; if it is taken,',
  '                 the next free port is used)',
  '  --data <dir>   data folder for disks, keys, templates, logs and vms.json',
  '                 (default: VM_MANAGER_ROOT, else an existing install in your',
  '                 home folder, else ./data next to server.js)',
  '  --no-open      do not open a browser window (the console prints the link)',
  '  --help         show this help',
  '',
  'Environment: VM_MANAGER_ROOT (data folder), VM_MANAGER_PORT (port).',
].join('\n');

// Parse the command line (process.argv.slice(2)). Pure: returns the options or
// throws an Error whose message says exactly what is wrong. Unknown arguments
// are collected in `unknown` (the entry point warns instead of refusing to start).
function parseArgs(argv) {
  const out = { port: null, data: null, noOpen: false, help: false, unknown: [] };
  const args = (argv || []).slice();
  for (let i = 0; i < args.length; i++) {
    let a = String(args[i]);
    let val = null;
    const eq = a.indexOf('=');
    if (a.indexOf('--') === 0 && eq > 2) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const needValue = () => {
      if (val !== null) return val;
      const next = args[i + 1];
      if (next === undefined || String(next).indexOf('--') === 0) throw new Error(a + ' needs a value');
      i++;
      return String(next);
    };
    if (a === '--port') {
      const v = needValue().trim();
      const n = /^\d{1,5}$/.test(v) ? parseInt(v, 10) : NaN;
      if (!(n >= 1 && n <= 65535)) throw new Error('--port must be a number between 1 and 65535 (got "' + v + '")');
      out.port = n;
    } else if (a === '--data') {
      const v = needValue().trim();
      if (!v) throw new Error('--data needs a folder path');
      out.data = v;
    } else if (a === '--no-open') {
      out.noOpen = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      out.unknown.push(String(args[i]));
    }
  }
  return out;
}

// Defaults are available as soon as the module loads (reads only).
configure({});

module.exports = {
  CFG, configure, parseArgs, USAGE, APP_DIR, APP_NAME, DEFAULT_PORT,
  version, rootId, readToken, ensureToken, protectToken, pingProof, ensureDirs, maxMemFor, normDir, setConfigValue, setConfigValues,
  // engine settings and the light profile
  ENGINE_SETTINGS, ENGINE_KEYS, ENGINE_API_KEYS, DISK_MIN_MEM_MB,
  effectiveDefaults, engineSettings, validateEngineSettings, updateEngineSettings, profileDefaults, checkEngineValue,
};
