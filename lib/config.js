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
  Object.assign(CFG, {
    appName: APP_NAME,
    appDir: APP_DIR,
    root: root,
    rootSource: rootSource,
    configFile: join(root, 'config.json'),
    configWarning: file.warning,
    // disks and images
    sandboxDir: join(root, 'sandboxes'),
    basesDir: join(root, 'vm-bases'),
    base: join(root, 'devbox-base.qcow2'),
    alpine: join(root, 'vm-alpine.qcow2'),
    downloadsDir: join(root, 'downloads'),
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
    // limits derived from this host (OPS-16)
    defaultMem: 1024,
    defaultCpus: 2,
    minMem: 256,
    maxMem: maxMemFor(os.totalmem()),
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
  return CFG;
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
// remember across restarts, e.g. the 9P port shares.js picked. Returns true
// when written; a config.json that cannot be parsed is never overwritten.
function setConfigValue(key, value) {
  const file = CFG.configFile;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  } catch (e) {
    if (e.code !== 'ENOENT') return false;
    data = {};
  }
  if (value === undefined) delete data[key]; else data[key] = value;
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
  version, rootId, readToken, ensureToken, protectToken, pingProof, ensureDirs, maxMemFor, normDir, setConfigValue,
};
