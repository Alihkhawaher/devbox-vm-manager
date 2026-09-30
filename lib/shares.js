'use strict';
/*
 * Live shared folders: the manager-level service (one per manager process)
 * around the manager's own 9P2000.L server (lib/ninep/server.js). Guests -
 * full VMs and microVM containers alike - mount a share over QEMU user
 * networking (slirp maps the guest's 10.0.2.2 to the host's 127.0.0.1):
 *   mount -t 9p -o trans=tcp,port=P,version=9p2000.L,msize=524288,cache=mmap,
 *                  aname=<id>:<secret>,uname=boot-<bootid>[,ro] 10.0.2.2 <path>
 * The Windows QEMU build has no virtfs/virtio-fs, so this is the way to share
 * a folder live and both ways (spec SPEC-shares.md; NINEP-REPORT.md).
 *
 * THE SERVER: started lazily, once, on 127.0.0.1:<CFG.ninepPort> (default
 * 5640). Running VMs' mounts and fw_cfg lists name the port, so it must stay
 * the same across manager restarts: a port picked because 5640 was busy is
 * saved into config.json (config.setConfigValue).
 *
 * SHARES: {hostPath, guestPath, readOnly, id, secret} - id "<owner>-<n>",
 * secret from generateSecret(), both made when the share is added and kept
 * with the owner record (vms.json vm.shares, containers.json likewise). A
 * secret is NEVER logged, returned by the API or put on a command line (QEMU's
 * or ssh's): the list reaches the guest through a fw_cfg FILE in <root>/run,
 * readable by this user only (platform.protectPrivateFile) and deleted when
 * the owner stops, and SSH scripts go to the guest on stdin. uid/gid: 0:0 for
 * VMs (their SSH user is root); containers pass their USER's numeric ids.
 *
 * FULL VMs. The fw_cfg list QEMU gets at start is read by the guest's
 * devbox-shares OpenRC service (lib/assets/devbox-shares.initd) at every boot,
 * with no SSH involved. Everything else happens over SSH, one `sh -s` per
 * step, serialised per VM (the scripts are lib/ninep/guest.js):
 *  - after every start (once the start task has finished - it names the guest
 *    and pins its new host key first): the service is installed if the image
 *    predates it (the bake of older bases did not have it), and whatever the
 *    boot did not mount is mounted. That covers the first boot of such an
 *    image, which has no service yet.
 *  - share added to a running VM: registered, then mounted; removed: unmounted
 *    and unregistered (the guest loses access at once either way).
 *  - manager restart (restoreRunning): the Linux 9p TCP transport never
 *    reconnects, so every running VM's shares are registered again and
 *    re-mounted (the dead mounts lazily detached first).
 *  - reboot inside the VM: QEMU keeps the list it was STARTED with, so shares
 *    added or removed live are not in it. For such a VM ("stale" list) the
 *    manager watches for a new boot - a 9P attach from a new boot id, or SSH
 *    going away and coming back - and mounts what the boot did not.
 *
 * LIFECYCLE HOOKS (called by lib/vm.js and the microVM engine):
 *   registerFor(ownerKind, ownerId, shares, opts) -> Promise<{port, file,
 *       args, warnings}>   at start: shares registered with the server, the
 *       fw_cfg file written; `args` go on the QEMU command line ([] when the
 *       owner has no shares - then nothing is started at all)
 *   disconnect(ownerId)      after QEMU exited: close the owner's 9P
 *                            connections (the Linux 9p transport never
 *                            reconnects; a dead boot's mounts must go)
 *   unregister(ownerId)      ...and forget its shares + fw_cfg file
 *   add(ownerKind, ownerId, share, {t}) / remove(ownerKind, ownerId,
 *       share|guestPath, {t})  on a RUNNING owner -> {applied: 'live' |
 *                            'next-start', mounted|unmounted, pending,
 *                            warnings}. Containers: added shares apply at
 *                            their next start (v1); a removed one loses
 *                            access at once.
 *   restoreRunning()         manager start: re-register the running VMs'
 *                            shares and re-mount them over SSH (background)
 *   status(ownerId)          per share: mounted?, connections, open files,
 *                            bytes, counters, recent close reasons - no secrets
 *   registered(ownerId)      the share ids registered for the owner
 *   shutdown()               manager exit: close the server
 * PURE HELPERS: validateShare(input, opts), newShare(input, ownerId,
 *   existing), publicShare(share), fwcfgFile(ownerKind, ownerId),
 *   writeFwcfg(file, port, shares), shareUidGid(user), CAVEAT (the text the
 *   GUI, README and MCP show about file watching and chmod).
 * API (lib/shares-routes.js): listShares(q), vmSharesAction(body),
 *   listDirs(q).
 *
 * Nothing runs at require time.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { CFG } = config;
const platform = require('./platform');
const guest = require('./ninep/guest');
const util = require('./util');
const ssh = require('./ssh');
const tasks = require('./tasks');
const st = require('./state');
const { badRequest, notFound, log, logError, errMsg } = util;

const DEFAULT_PORT = 5640;
const MAX_SHARES = 8;
const OWNER_KINDS = ['vm', 'container'];
// spec SPEC-shares.md section 8: the same words in the GUI, README and MCP
const CAVEAT = 'Edits you make on Windows appear in the VM within a few tens of milliseconds, and files written in the VM are saved on Windows immediately. ' +
  'Changes made on Windows do not raise file-watch (inotify) events inside the VM, so dev servers that watch files need polling mode ' +
  '(e.g. CHOKIDAR_USEPOLLING=1, WATCHPACK_POLLING=true, vite server.watch.usePolling). Execute bits set with chmod +x are not stored ' +
  '(scripts and binaries are detected automatically); symlinks must stay inside the shared folder.';
// What a share's access means INSIDE the guest (sec-6). The share's
// credential is a mount option, and Linux shows 9p mount options in
// /proc/mounts to every process; the server checks the credential, not
// which program uses it. So any program in the guest - a Docker container
// in a VM that bind-mounts only a sub-folder or mounts it ":ro" too - can
// open its own session to the WHOLE folder with the share's access. Only
// the share's own read-only flag is enforced by the manager.
const ACCESS_NOTE = 'Every program in the VM or container can use the WHOLE shared folder with the share\'s access (read-write unless the share is ' +
  'read-only) - also a Docker container inside a VM that only sees a sub-folder or mounts it ":ro": those do not limit it. Share only folders ' +
  'the guest may change, and make the share read-only when it should not.';
// A mount job waits this long for a guest to answer on SSH: a first boot
// under TCG emulation can take many minutes.
const SSH_WAIT_MS = 15 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 120000;
// How often a VM with a stale boot-time list is checked for a reboot (one SSH
// banner probe - a TCP connect, no ssh process). Tests shorten it.
let WATCH_MS = 5000;
const MAX_DIRS = 2000;

let server = null;          // the NinepServer once started
let starting = null;        // promise while it starts
let generation = 0;         // bumped by shutdown(): a start that finishes later is discarded
// ownerId -> {kind, id, shares: Map<shareId, share>, file, fwcfg (the list
// QEMU was started with), uid, gid, bootTag ("boot-<id>" last mounted in),
// problem, job, pending, watch, startTask, chain}
const owners = new Map();

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------
function port() { return server ? server.port : null; }

async function listenOn(p) {
  const { createServer } = require('./ninep/server');
  return createServer({
    host: '127.0.0.1', port: p,
    // every closed mount is logged with its reason (never a secret)
    log: (level, msg) => { try { log(msg); } catch (e) { /* logging must not break the server */ } },
    onAttach: (info) => onAttach(info),
  });
}

// Start the 9P server once; resolves it. Port: config.json ninepPort, else
// 5640; if that is taken by another program, a free port is used and saved.
// opts.port (tests: 0 = OS-assigned) overrides the configured port.
function ensureServer(opts) {
  if (server) return Promise.resolve(server);
  if (starting) return starting;
  const gen = generation;
  starting = (async () => {
    const wanted = opts && opts.port !== undefined ? opts.port : (CFG.ninepPort || DEFAULT_PORT);
    let s;
    try { s = await listenOn(wanted); }
    catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      s = await listenOn(0);
      logError('9p: port ' + wanted + ' is in use by another program - shared folders use port ' + s.port + ' (saved in config.json)');
    }
    if (gen !== generation) { await s.close(); throw new Error('the manager is shutting down'); }
    // saved only when it differs from what was asked for (a fallback port, or
    // an OS-assigned one for port 0): the default needs no entry, so a data
    // root that never met a busy 5640 gets no config.json at all
    if (s.port !== wanted) {
      try { if (config.setConfigValue('ninepPort', s.port)) CFG.ninepPort = s.port; }
      catch (e) { logError('could not save the shared-folder port in config.json', e); }
    }
    server = s;
    return s;
  })().finally(() => { starting = null; });
  return starting;
}

async function shutdown() {
  generation++;
  const s = server;
  server = null;
  for (const o of owners.values()) stopWatch(o);
  owners.clear();
  if (s) { try { await s.close(); } catch (e) { /* closing anyway */ } }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
function normPath(p) {
  let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase();
  return s;
}
// is a equal to or inside b (case-insensitive on Windows/macOS)
function samePathPrefix(a, b) {
  const x = normPath(a), y = normPath(b);
  return x === y || x.startsWith(y + '/');
}

function realOr(p) { try { return fs.realpathSync.native(p); } catch (e) { return p; } }

function systemFolders() {
  return platform.IS_WIN ? [process.env.SystemRoot || 'C:\\Windows'] : ['/proc', '/sys', '/dev', '/boot'];
}

// Why a host folder can never be shared (lexical check on a real path), or null.
function refusal(real, dataReal) {
  if (samePathPrefix(real, dataReal)) return 'it is inside the manager\'s data folder';
  if (samePathPrefix(dataReal, real)) return 'it contains the manager\'s data folder';
  for (const d of systemFolders()) if (d && samePathPrefix(real, d)) return 'it is a system folder (' + d + ')';
  return null;
}

// The same rule by FILE IDENTITY (volume + file index), not by spelling: a
// path that names the data folder another way (a mapped drive, a second
// mount, an 8.3 name, some other alias the lexical check does not know)
// still resolves to the same folder on disk. real or one of its parents
// being the data folder = inside it; real being the data folder or one of
// ITS parents = contains it. Only on local paths (network ones are refused
// before any file call). -> a refusal text or null
function fileId(p) {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.ino ? s.dev + ':' + s.ino : null;
  } catch (e) { return null; }
}
function identityRefusal(real, dataRoot) {
  const dataId = fileId(dataRoot);
  if (!dataId) return null;
  let p = real;
  for (let i = 0; i < 256; i++) {
    if (fileId(p) === dataId) return 'it is inside the manager\'s data folder';
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  const realId = fileId(real);
  if (!realId) return null;
  p = realOr(dataRoot);
  for (let i = 0; i < 256; i++) {
    if (fileId(p) === realId) return 'it contains the manager\'s data folder';
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  return null;
}

// Check one share request. input: {hostPath, guestPath, readOnly}.
// opts: {existing: [shares of the same owner], dataRoot (CFG.root), replaceId}
// -> {share: {hostPath (real, normalised), guestPath, readOnly}, warnings}
// Throws a 400 naming the problem.
function validateShare(input, opts) {
  opts = opts || {};
  if (!input || typeof input !== 'object') throw badRequest('a shared folder needs hostPath and guestPath');
  const warnings = [];
  const hp = input.hostPath;
  if (typeof hp !== 'string' || !hp.trim()) throw badRequest('hostPath (the folder on this PC) is required');
  if (hp.length > 4096 || hp.indexOf('\0') !== -1) throw badRequest('hostPath is not a valid folder path');
  // BEFORE any file call (sec-1): opening a UNC path sends the user's
  // Windows sign-in to that host, and "\\localhost\C$\...\data" would slip
  // past the text comparison with the data folder below
  const net0 = util.networkPathError(hp.trim());
  if (net0) throw badRequest('hostPath: ' + net0);
  if (!path.isAbsolute(hp.trim())) throw badRequest('hostPath must be an absolute path, e.g. ' + (platform.IS_WIN ? 'C:\\Users\\me\\project' : '/home/me/project'));
  let real;
  try { real = fs.realpathSync.native(hp.trim()); } catch (e) { throw badRequest('the folder ' + hp + ' does not exist'); }
  // a mapped network drive (Z:\) resolves to its \\server\share form
  const net1 = util.networkPathError(real);
  if (net1) throw badRequest('hostPath: ' + hp + ' is on a network drive - ' + net1);
  let stt;
  try { stt = fs.statSync(real); } catch (e) { throw badRequest('the folder ' + hp + ' cannot be read (' + (e.code || e.message) + ')'); }
  if (!stt.isDirectory()) throw badRequest(hp + ' is a file, not a folder');
  // listing it is what the guest does first: refuse a folder this user cannot open
  try { fs.opendirSync(real).closeSync(); } catch (e) {
    throw badRequest('the folder ' + hp + ' cannot be read (' + (e.code || e.message) + ')');
  }
  const dataRoot = opts.dataRoot || CFG.root;
  const why = refusal(real, realOr(dataRoot)) || identityRefusal(real, dataRoot);
  if (why) {
    if (/data folder/.test(why)) {
      throw badRequest('the manager\'s data folder (' + dataRoot + ') cannot be shared, nor a folder that contains it: it holds the VM disks, the SSH key and the access token');
    }
    throw badRequest('system folders cannot be shared (' + real + ')');
  }
  if (path.parse(real).root.replace(/[\\/]+$/, '') === real.replace(/[\\/]+$/, '')) warnings.push('this shares a whole drive (' + real + ') with the guest');
  const home = os.homedir();
  if (home && samePathPrefix(home, real)) warnings.push('this shares your whole user profile (' + real + ') with the guest, including browser data and keys');
  const gwhy = guest.validateGuestPath(input.guestPath);
  if (gwhy) throw badRequest(gwhy);
  const gp = input.guestPath;
  const existing = (opts.existing || []).filter((s) => !opts.replaceId || s.id !== opts.replaceId);
  if (existing.some((s) => s.guestPath === gp)) throw badRequest('another shared folder already uses ' + gp);
  // one share mounted inside another would create its mount point on the
  // OTHER share's host folder (and fail on a read-only one)
  const nest = existing.find((s) => typeof s.guestPath === 'string' && (gp.startsWith(s.guestPath + '/') || s.guestPath.startsWith(gp + '/')));
  if (nest) throw badRequest(gp + ' and the shared folder at ' + nest.guestPath + ' would be nested - pick a path outside it');
  if (existing.length >= MAX_SHARES) throw badRequest('at most ' + MAX_SHARES + ' shared folders per VM or container');
  const ro = input.readOnly;
  if (ro !== undefined && ro !== null && typeof ro !== 'boolean') throw badRequest('readOnly must be true or false');
  return { share: { hostPath: real, guestPath: gp, readOnly: ro === true }, warnings };
}

// The id stem of an owner: the name itself (ids are "<stem>-<n>" and at
// most 64 characters), or for long names a prefix plus a hash, so two long
// names that share their first characters still get different ids.
function idStem(ownerId) {
  const s = String(ownerId).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  if (s && s.length <= 55) return s;
  return (s.slice(0, 46) || 'share') + '-' + crypto.createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 8);
}

// A new share record with its id and secret. existing: the owner's shares.
function newShare(input, ownerId, existing) {
  const { generateSecret } = require('./ninep/server');
  const ids = new Set((existing || []).map((s) => s.id));
  const stem = idStem(ownerId);
  let n = 1;
  while (ids.has(stem + '-' + n)) n++;
  return { hostPath: input.hostPath, guestPath: input.guestPath, readOnly: !!input.readOnly, id: stem + '-' + n, secret: generateSecret() };
}

// What the API may show (never the secret).
function publicShare(s) {
  return { id: s.id, hostPath: s.hostPath, guestPath: s.guestPath, readOnly: !!s.readOnly };
}

function checkOwner(kind, id) {
  if (OWNER_KINDS.indexOf(kind) === -1) throw new Error('shares: owner kind must be vm or container');
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(id)) throw new Error('shares: bad owner id');
}

// <root>/run/<vm>.shares or <root>/run/ctr-<id>.shares
function fwcfgFile(ownerKind, ownerId) {
  checkOwner(ownerKind, ownerId);
  return path.join(CFG.runDir, (ownerKind === 'container' ? 'ctr-' : '') + ownerId + '.shares');
}

// Write the guest's share list (secrets inside: private file). In the
// locked run/ folder (platform.protectPrivateDir at start) it simply
// inherits the folder's private ACL; otherwise it is made private while
// still EMPTY, then filled and renamed into place (a rename keeps its
// permissions), so the secrets never sit in a file other accounts could
// read, not even for a moment. When it cannot be made private the start
// fails instead of writing the secrets (sec-5).
function writeFwcfg(file, p, shares) {
  const text = guest.fwcfgContent(p, shares);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform.inLockedDir(file)) {
    platform.writePrivateFileSync(file, text, { atomic: true });
    return file;
  }
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    const pr = platform.protectPrivateFile(tmp);
    if (!pr.ok) {
      if (platform.IS_WIN) throw new Error('could not make the shared-folder list ' + file + ' readable by this user only (' + pr.error + ') - the shared folders were not set up');
      logError('could not restrict ' + file + ': ' + pr.error);
    }
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* renamed */ }
  }
  return file;
}

// A container's USER as a numeric uid:gid for its shares; names are not
// resolvable on the host, so they map to 0:0 (the guest then enforces
// nothing beyond what root may do). Pure.
function shareUidGid(user) {
  const m = /^(\d{1,10})(?::(\d{1,10}))?$/.exec(String(user || '').trim());
  if (!m) return { uid: 0, gid: 0 };
  const uid = parseInt(m[1], 10);
  return { uid, gid: m[2] !== undefined ? parseInt(m[2], 10) : uid };
}

// Two share lists (fw_cfg text) are the same list whatever their order.
function canon(text) { return String(text || '').split('\n').filter(Boolean).sort().join('\n'); }

function lastLine(r) {
  const lines = String((r && (r.stderr || r.stdout)) || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith(guest.MARK));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : 'no output';
}

// ---------------------------------------------------------------------------
// owners
// ---------------------------------------------------------------------------
function newOwner(kind, id, opts) {
  opts = opts || {};
  return {
    kind: kind, id: id, shares: new Map(), file: null, fwcfg: null,
    uid: kind === 'vm' ? 0 : (opts.uid || 0), gid: kind === 'vm' ? 0 : (opts.gid || 0),
    bootTag: null, problem: null, job: null, pending: null, watch: null, startTask: null,
    chain: Promise.resolve(),
  };
}

function shareDef(sh, o) {
  return { id: sh.id, root: sh.hostPath, secret: sh.secret, readOnly: !!sh.readOnly, uid: o.uid, gid: o.gid };
}

// Register `list` with the server as the owner's shares (replacing an
// earlier registration). -> {o, good (the shares that could be registered), warnings}
async function attachOwner(kind, id, list, opts) {
  checkOwner(kind, id);
  const s = await ensureServer();
  const prev = owners.get(id);
  if (prev && prev.kind !== kind) throw new Error('shares: a VM and a container are both called "' + id + '"');
  if (prev) dropOwner(prev);
  const o = newOwner(kind, id, opts);
  const warnings = [];
  const good = [];
  for (const sh of list) {
    try {
      // a record from before the network-path rule is never opened (sec-1)
      const netWhy = util.networkPathError(sh.hostPath);
      if (netWhy) throw new Error(netWhy);
      // re-added every start: the folder may have been moved or recreated
      if (s.shares.has(sh.id)) s.removeShare(sh.id);
      s.addShare(shareDef(sh, o));
      o.shares.set(sh.id, sh);
      good.push(sh);
    } catch (e) {
      warnings.push('shared folder ' + sh.hostPath + ' -> ' + sh.guestPath + ' is not available: ' + errMsg(e));
    }
  }
  owners.set(id, o);
  return { o, good, warnings };
}

// Take an owner's shares off the server (its connections close) and stop
// its background work; the caller removes it from `owners`.
function dropOwner(o) {
  stopWatch(o);
  o.dropped = true;
  if (server) for (const id of o.shares.keys()) server.removeShare(id);
}

const isCurrent = (o) => owners.get(o.id) === o && !o.dropped;

// Run fn after the owner's previous SSH step (never two scripts in one guest at once).
function serial(o, fn) {
  const p = o.chain.then(() => fn());
  o.chain = p.catch(() => {});
  return p;
}

// Does the list QEMU was started with differ from the owner's shares now
// (shares added or removed while it runs, or another 9P port)? Then a
// reboot inside the guest mounts the old list, and the manager has to help.
function isStale(o) {
  if (o.kind !== 'vm' || !server) return false;
  let want;
  try { want = guest.fwcfgContent(server.port, Array.from(o.shares.values())); } catch (e) { return true; }
  return canon(want) !== canon(o.fwcfg);
}

// ---------------------------------------------------------------------------
// lifecycle hooks
// ---------------------------------------------------------------------------
// opts: {uid, gid} (containers; VMs are always 0:0)
async function registerFor(ownerKind, ownerId, shares, opts) {
  checkOwner(ownerKind, ownerId);
  opts = opts || {};
  const list = Array.isArray(shares) ? shares : [];
  if (!list.length) {
    if (owners.has(ownerId)) unregister(ownerId);
    return { port: null, file: null, args: [], warnings: [] };
  }
  const { o, good, warnings } = await attachOwner(ownerKind, ownerId, list, opts);
  const file = fwcfgFile(ownerKind, ownerId);
  writeFwcfg(file, server.port, good);
  o.file = file;
  o.fwcfg = guest.fwcfgContent(server.port, good);
  if (ownerKind === 'vm') {
    // mount what the boot does not (an image without the boot-time service)
    // once the start task that called us is over
    const h = tasks.holder('vm:' + ownerId);
    o.startTask = h ? h.id : null;
    schedule(o, 'start');
  }
  return { port: server.port, file, args: guest.qemuFwCfgArgs(file), warnings };
}

// Close the owner's 9P connections (keeps the shares registered).
function disconnect(ownerId) {
  const o = owners.get(ownerId);
  if (!o || !server) return 0;
  let n = 0;
  for (const id of o.shares.keys()) n += server.disconnectShare(id);
  return n;
}

// Forget the owner's shares and delete its fw_cfg file.
function unregister(ownerId) {
  const o = owners.get(ownerId);
  if (!o) return false;
  dropOwner(o);
  const file = o.file || (o.kind === 'vm' ? safeFwcfgFile(o.kind, o.id) : null);
  if (file) { try { fs.rmSync(file, { force: true }); } catch (e) { /* removed next start */ } }
  owners.delete(ownerId);
  return true;
}

function safeFwcfgFile(kind, id) { try { return fwcfgFile(kind, id); } catch (e) { return null; } }

function registered(ownerId) { const o = owners.get(ownerId); return o ? Array.from(o.shares.keys()) : []; }

// Per share id: live numbers from the server. "mounted" counts only the
// connections of the guest's current boot when that boot is known (a
// connection an earlier boot left behind is dead weight until superseded).
function liveStatus(o) {
  const res = new Map();
  if (!server || !o) return res;
  const stt = server.stats({ connections: true });
  const conns = stt.connectionList || [];
  for (const x of stt.shares) {
    if (!o.shares.has(x.id)) continue;
    const mine = conns.filter((c) => c.attached && c.shares.indexOf(x.id) >= 0);
    const current = mine.filter((c) => !o.bootTag || !c.boot || c.boot === o.bootTag);
    const closes = (stt.recentCloses || []).filter((c) => (c.shares || []).indexOf(x.id) >= 0)
      .map((c) => ({ reason: c.reason, at: c.at, openFiles: c.openFiles }));
    res.set(x.id, {
      id: x.id, mounted: current.length > 0, connections: x.connections, openFiles: x.openFiles, fids: x.fids,
      bytesRead: x.bytesRead, bytesWritten: x.bytesWritten, attaches: x.attaches, errors: x.errors,
      lastClose: closes.length ? closes[closes.length - 1] : null,
      recentCloses: closes.slice(-5),
    });
  }
  return res;
}

// Per share of the owner: live status from the server (no secrets).
function status(ownerId) {
  return Array.from(liveStatus(owners.get(ownerId)).values());
}

// ---------------------------------------------------------------------------
// full VMs: mounting over SSH
// ---------------------------------------------------------------------------
let serviceTextCache = null;
function serviceText() {
  if (serviceTextCache === null) {
    try { serviceTextCache = require('./install').sharesServiceScript(); }
    catch (e) { serviceTextCache = ''; logError('the devbox-shares service file is missing - shared folders are mounted over SSH only', e); }
  }
  return serviceTextCache;
}

function runningVm(o) {
  const v = st.state.vms[o.id];
  return v && v.runtime ? v : null;
}

// One SSH step: install the boot-time service where it is missing, then
// mount the owner's shares (opts.only: those ids; opts.remount: detach
// whatever is mounted there first - after a manager restart every mount is
// dead; otherwise live mounts are kept). Resolves {ok, mounted, kept,
// failed, service, error}; never rejects.
async function mountNow(o, opts) {
  opts = opts || {};
  const vm = runningVm(o);
  if (!server || !isCurrent(o) || !vm) return { ok: false, skipped: true, mounted: [], kept: [], failed: [], error: null };
  const list = Array.from(o.shares.values()).filter((s) => !opts.only || opts.only.indexOf(s.id) !== -1);
  if (!list.length) return { ok: true, mounted: [], kept: [], failed: [], error: null };
  let script = '';
  const svc = serviceText();
  if (svc) script += guest.sshServiceScript(svc);
  script += guest.sshMountScript(server.port, list, { skipMounted: !opts.remount });
  const r = await ssh.sshExec({ name: o.id, port: vm.port }, 'sh -s', { input: script, timeoutMs: SCRIPT_TIMEOUT_MS, connectTimeout: 10 });
  const out = guest.parseScriptOutput(r.stdout);
  if (!isCurrent(o)) return { ok: false, skipped: true, mounted: [], kept: [], failed: [], error: null };
  if (out.boot) o.bootTag = 'boot-' + out.boot;
  if (out.service === 'installed') log('VM "' + o.id + '": installed the shared-folder service (devbox-shares) - its folders are mounted at every boot from now on');
  if (!out.ok.length && !out.kept.length && !out.fail.length) {
    o.problem = 'could not reach "' + o.id + '" over SSH to mount its shared folders: ' + lastLine(r);
    return { ok: false, mounted: [], kept: [], failed: list.map((s) => s.guestPath), service: out.service, error: o.problem };
  }
  if (out.ok.length) log('VM "' + o.id + '": mounted the shared folder' + (out.ok.length > 1 ? 's ' : ' ') + out.ok.join(', '));
  if (out.fail.length) {
    o.problem = 'could not mount ' + out.fail.join(', ') + ' in "' + o.id + '": ' + lastLine(r);
    logError('VM "' + o.id + '": ' + o.problem);
  } else o.problem = null;
  return { ok: !out.fail.length, mounted: out.ok, kept: out.kept, failed: out.fail, service: out.service, error: out.fail.length ? o.problem : null };
}

// Background mount work of a VM owner, one at a time; a request that comes
// in meanwhile runs after it (the strongest one wins: restore > start > resync).
//   start   after the start task: mount what the boot did not
//   restore after a manager restart: re-mount everything
//   resync  the guest rebooted: mount what the boot did not
const MODE_RANK = { resync: 1, start: 2, restore: 3 };
function schedule(o, mode) {
  if (o.kind !== 'vm') return null;
  if (o.job) {
    if (!o.pending || MODE_RANK[mode] > MODE_RANK[o.pending]) o.pending = mode;
    return o.job;
  }
  o.job = (async () => {
    try { await mountJob(o, mode); }
    catch (e) { o.problem = errMsg(e); logError('shared folders of "' + o.id + '"', e); }
  })().finally(() => {
    o.job = null;
    const next = o.pending;
    o.pending = null;
    if (next && isCurrent(o)) schedule(o, next);
  });
  return o.job;
}

async function mountJob(o, mode) {
  const deadline = Date.now() + SSH_WAIT_MS;
  // a start: its task waits for SSH, names the guest and pins the guest's new
  // host key - an ssh of ours in the middle of that would trip over the key
  while (isCurrent(o) && o.startTask) {
    const h = tasks.holder('vm:' + o.id);
    if (!h || h.id !== o.startTask || Date.now() > deadline) break;
    await util.sleep(1000);
  }
  o.startTask = null;
  for (;;) {
    const vm = runningVm(o);
    if (!isCurrent(o) || !vm) return;
    const h = tasks.holder('vm:' + o.id);
    if (h && /^(stop|delete|reset)$/.test(h.kind)) return; // going down: nothing to mount
    if (await util.probeSsh(vm.port, 3000)) break;
    if (Date.now() > deadline) {
      o.problem = '"' + o.id + '" did not answer on SSH, so its shared folders were not mounted - they are mounted at its next start';
      return;
    }
    await util.sleep(2000);
  }
  await serial(o, () => mountNow(o, { remount: mode === 'restore' }));
  updateWatch(o);
}

// A 9P attach: a mount from a NEW boot of a VM means it rebooted inside its
// QEMU process. If its boot-time list is stale, mount what the boot missed.
function onAttach(info) {
  if (!info || !info.boot) return;
  for (const o of owners.values()) {
    if (!o.shares.has(info.share)) continue;
    if (o.kind !== 'vm' || o.bootTag === info.boot) return;
    const rebooted = !!o.bootTag;
    o.bootTag = info.boot;
    // (a job that is running mounts everything anyway - including the mount
    // that announced this boot, when it was the job's own)
    if (rebooted && !o.job && isStale(o)) schedule(o, 'resync');
    return;
  }
}

// A VM whose boot-time list is stale is probed every WATCH_MS: SSH going
// away and coming back (a reboot) triggers a resync - also when none of the
// boot-time shares is left to announce the new boot through 9P.
function updateWatch(o) {
  const want = o.kind === 'vm' && isCurrent(o) && o.shares.size > 0 && isStale(o);
  if (want && !o.watch) {
    o.watch = { down: 0, busy: false, timer: setInterval(() => { watchTick(o); }, WATCH_MS) };
    if (o.watch.timer.unref) o.watch.timer.unref();
  } else if (!want) stopWatch(o);
}
function stopWatch(o) {
  if (o.watch) { clearInterval(o.watch.timer); o.watch = null; }
}
async function watchTick(o) {
  const w = o.watch;
  if (!w || w.busy || o.job) return;
  const vm = runningVm(o);
  if (!isCurrent(o) || !vm) return stopWatch(o);
  w.busy = true;
  try {
    const up = await util.probeSsh(vm.port, 3000);
    if (!up) w.down++;
    else if (w.down > 0) { w.down = 0; schedule(o, 'resync'); }
  } catch (e) { /* next tick */ } finally { w.busy = false; }
}

// Share added to a RUNNING owner: register it, then (VMs) mount it now.
// -> {applied: 'live'|'next-start', mounted, pending, warnings}
async function add(ownerKind, ownerId, share, opts) {
  checkOwner(ownerKind, ownerId);
  const t = (opts && opts.t) || null;
  if (ownerKind !== 'vm') {
    return { applied: 'next-start', mounted: false, pending: false, warnings: ['a running container gets a new shared folder when it is started again'] };
  }
  const s = await ensureServer();
  let o = owners.get(ownerId);
  if (o && o.kind !== ownerKind) throw new Error('shares: a VM and a container are both called "' + ownerId + '"');
  if (!o) {
    const rec = st.state.vms[ownerId];
    const others = (rec && Array.isArray(rec.shares) ? rec.shares : []).filter((x) => validShareRecord(x) && x.id !== share.id);
    if (others.length) {
      // A running VM WITH shares but no owner yet: the manager restarted
      // and restoreRunning has not got to it (it runs after the adoption
      // of VMs and containers, while the API is already served). Its other
      // shares' mounts died with the old manager: register ALL of them and
      // re-mount everything - restoreRunning then finds the owner and
      // leaves it alone (correct-9).
      const all = others.concat([share]);
      const r = await attachOwner('vm', ownerId, all, {});
      r.o.file = fwcfgFile('vm', ownerId);
      try { r.o.fwcfg = fs.readFileSync(r.o.file, 'utf8'); } catch (e) { r.o.fwcfg = ''; }
      schedule(r.o, 'restore');
      updateWatch(r.o);
      const warnings = r.warnings.slice();
      if (t) for (const w of warnings) t.warn(w);
      const ok = r.o.shares.has(share.id);
      if (t && ok) t.log(share.guestPath + ' and the other shared folders of "' + ownerId + '" are being mounted (the manager was restarted)');
      return {
        applied: ok ? 'live' : 'next-start', mounted: false, pending: ok,
        warnings: ok ? warnings : warnings.concat(['the folder cannot be shared right now - it is mounted when the VM starts next time']),
      };
    }
    // started without shares (or by an earlier manager run): what QEMU got
    // at start is the list file still on disk, if any
    o = newOwner('vm', ownerId);
    o.file = fwcfgFile('vm', ownerId);
    try { o.fwcfg = fs.readFileSync(o.file, 'utf8'); } catch (e) { o.fwcfg = ''; }
    owners.set(ownerId, o);
  }
  try {
    if (s.shares.has(share.id)) s.removeShare(share.id);
    s.addShare(shareDef(share, o));
  } catch (e) {
    return { applied: 'next-start', mounted: false, pending: false, warnings: ['the folder cannot be shared right now: ' + errMsg(e)] };
  }
  o.shares.set(share.id, share);
  updateWatch(o);
  const vm = runningVm(o);
  if (!vm || !(await util.probeSsh(vm.port, 5000))) {
    schedule(o, 'resync');
    return { applied: 'live', mounted: false, pending: true, warnings: ['"' + ownerId + '" does not answer on SSH yet - ' + share.guestPath + ' is mounted as soon as it does'] };
  }
  if (t) t.step('Mounting ' + share.guestPath + ' in "' + ownerId + '"...');
  const r = await serial(o, () => mountNow(o, { only: [share.id], remount: true }));
  if (r.ok) {
    if (t) t.log('mounted ' + share.hostPath + ' at ' + share.guestPath + (share.readOnly ? ' (read-only)' : ''));
    return { applied: 'live', mounted: true, pending: false, warnings: [] };
  }
  const why = r.error || 'the folder could not be mounted';
  if (t) t.warn(why);
  return { applied: 'next-start', mounted: false, pending: false, warnings: [why + ' - it is mounted when the VM starts next time'] };
}

// Share removed from a RUNNING owner: unmount it in the guest (VMs, over
// SSH), then take it off the server - the guest loses access either way.
// share: the share record or its guest path.
// -> {applied: 'live', unmounted, warnings}
async function remove(ownerKind, ownerId, share, opts) {
  checkOwner(ownerKind, ownerId);
  const t = (opts && opts.t) || null;
  const guestPath = typeof share === 'string' ? share : (share && share.guestPath);
  const wantId = share && typeof share === 'object' ? share.id : null;
  const o = owners.get(ownerId);
  const sh = o ? Array.from(o.shares.values()).find((x) => (wantId && x.id === wantId) || x.guestPath === guestPath) : null;
  const warnings = [];
  let unmounted = false;
  const vm = o && ownerKind === 'vm' ? runningVm(o) : null;
  if (vm && sh && typeof guestPath === 'string' && !guest.validateGuestPath(guestPath)) {
    if (t) t.step('Unmounting ' + guestPath + ' in "' + ownerId + '"...');
    if (await util.probeSsh(vm.port, 3000)) {
      const r = await serial(o, () => ssh.sshExec({ name: ownerId, port: vm.port }, 'sh -s', { input: guest.sshUnmountScript([guestPath]), timeoutMs: 30000, connectTimeout: 10 }));
      unmounted = guest.parseScriptOutput(r.stdout).gone.indexOf(guestPath) !== -1;
      if (!unmounted) warnings.push('could not unmount ' + guestPath + ' in "' + ownerId + '" (' + lastLine(r) + ') - its access is revoked anyway');
    } else {
      warnings.push('"' + ownerId + '" does not answer on SSH: its access to the folder is revoked, and ' + guestPath + ' shows as a broken mount until it restarts');
    }
  }
  if (sh) {
    if (server) server.removeShare(sh.id);
    o.shares.delete(sh.id);
    updateWatch(o);
  }
  if (t) t.log('no longer shared: ' + (sh ? sh.hostPath + ' -> ' : '') + guestPath);
  return { applied: 'live', unmounted, warnings };
}

// Manager start (after the running VMs were adopted): the 9P transport of
// their mounts died with the previous manager, so register their shares
// again and re-mount them over SSH in the background. Returns at once.
async function restoreRunning() {
  cleanupFiles();
  const names = Object.keys(st.state.vms).filter((n) => {
    const v = st.state.vms[n];
    return v && v.runtime && !v.runtime.legacy && Array.isArray(v.shares) && v.shares.length;
  });
  let restored = 0;
  for (const name of names) {
    if (owners.has(name)) continue; // a start registered it meanwhile
    try {
      const vm = st.state.vms[name];
      const { o, warnings } = await attachOwner('vm', name, vm.shares, {});
      for (const w of warnings) logError('VM "' + name + '": ' + w);
      o.file = fwcfgFile('vm', name);
      // what QEMU was started with (the file is only rewritten at a start)
      try { o.fwcfg = fs.readFileSync(o.file, 'utf8'); } catch (e) { o.fwcfg = ''; }
      schedule(o, 'restore');
      updateWatch(o);
      restored++;
    } catch (e) { logError('could not restore the shared folders of "' + name + '"', e); }
  }
  if (restored) log('shared folders: re-mounting the folders of ' + restored + ' running VM' + (restored > 1 ? 's' : '') + ' (9P server on 127.0.0.1:' + port() + ')');
  return { restored };
}

// Share lists (they hold secrets) of VMs that are not running any more -
// left behind when a VM stopped while no manager was running - and temp
// files of a write that never finished.
function cleanupFiles() {
  let names;
  try { names = fs.readdirSync(CFG.runDir); } catch (e) { return; }
  for (const f of names) {
    let gone = false;
    // also the registries' temp files (written in run/ to stay private,
    // platform.writePrivateFileSync) of a manager that crashed mid-save
    const tmp = /\.shares\.(\d+)\.tmp$/.exec(f) || /^(?:vms|containers)\.json(?:\.bak)?\.(\d+)\.tmp$/.exec(f);
    if (tmp) gone = parseInt(tmp[1], 10) !== process.pid;
    else {
      const m = /^(.+)\.shares$/.exec(f);
      if (!m || m[1].startsWith('ctr-')) continue; // containers: the engine's records
      const vm = st.state.vms[m[1]];
      gone = !owners.has(m[1]) && !(vm && vm.runtime);
    }
    if (gone) { try { fs.rmSync(path.join(CFG.runDir, f), { force: true }); } catch (e) { /* next start */ } }
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function validShareRecord(s) {
  return !!(s && typeof s === 'object' && typeof s.id === 'string' && typeof s.guestPath === 'string' && typeof s.hostPath === 'string');
}

function containerRecords() {
  try {
    return require('./microvm/store').list().map((r) => ({
      id: r.id, name: typeof r.name === 'string' ? r.name : null,
      shares: Array.isArray(r.shares) ? r.shares.filter(validShareRecord) : [],
    }));
  } catch (e) { return []; }
}

// One row per share: the public fields plus a status for the GUI chip:
// mounted | not-mounted | pending (a mount job runs or waits for SSH) |
// unavailable (running, but the folder could not be registered - moved or
// deleted) | stopped (the owner is not running).
function shareRows(id, list, running) {
  const o = owners.get(id);
  const live = liveStatus(o);
  return list.filter(validShareRecord).map((s) => {
    const L = live.get(s.id);
    let status;
    if (!running) status = 'stopped';
    else if (!o || !o.shares.has(s.id)) status = 'unavailable';
    else if (L && L.mounted) status = 'mounted';
    else if (o.job) status = 'pending';
    else status = 'not-mounted';
    return Object.assign(publicShare(s), {
      status: status, mounted: status === 'mounted',
      connections: L ? L.connections : 0, openFiles: L ? L.openFiles : 0,
      bytesRead: L ? L.bytesRead : 0, bytesWritten: L ? L.bytesWritten : 0,
      lastClose: L ? L.lastClose : null,
    });
  });
}

function ownerView(kind, id, list, running, name) {
  const o = owners.get(id);
  return {
    owner: id, name: name || id, kind: kind, running: !!running, port: port(),
    problem: running && o ? o.problem : null,
    shares: shareRows(id, list, running),
    caveat: CAVEAT, access: ACCESS_NOTE,
  };
}

// GET /api/shares?owner=<VM name | container id or name>: that owner's
// shares with their live status; without owner: every share of every VM and
// container ({owner, kind} on each row). Never a secret.
function listShares(q) {
  q = q || {};
  const owner = q.owner;
  if (owner === undefined || owner === null || owner === '') {
    const rows = [];
    for (const name of Object.keys(st.state.vms).sort()) {
      const vm = st.state.vms[name];
      for (const r of shareRows(name, vm.shares || [], !!vm.runtime)) rows.push(Object.assign({ owner: name, kind: 'vm' }, r));
    }
    for (const c of containerRecords()) {
      for (const r of shareRows(c.id, c.shares, owners.has(c.id))) rows.push(Object.assign({ owner: c.id, ownerName: c.name, kind: 'container' }, r));
    }
    return { port: port(), shares: rows, caveat: CAVEAT, access: ACCESS_NOTE };
  }
  if (typeof owner !== 'string' || !util.isContainerName(owner)) throw badRequest('owner must be a VM name or a container id or name');
  const vm = st.state.vms[owner];
  if (vm) return ownerView('vm', owner, vm.shares || [], !!vm.runtime);
  const c = containerRecords().find((x) => x.id === owner || x.name === owner);
  if (c) return ownerView('container', c.id, c.shares, owners.has(c.id), c.name);
  throw notFound('no VM or container called "' + owner + '"');
}

// POST /api/vm/shares {name, action: 'add', hostPath, guestPath, readOnly?}
//                  | {name, action: 'remove', guestPath | id}
// Saved in vms.json with the VM (under its lock, like a port change); on a
// running VM applied at once. -> {name, share|removed, applied: 'live' |
// 'next-start', mounted|unmounted, pending, warnings, shares, caveat}
async function vmSharesAction(body) {
  body = body || {};
  const vmMod = require('./vm');
  const name = vmMod.requireVmName(body.name);
  const vm0 = vmMod.lookupVm(name);
  const action = body.action;
  if (action !== 'add' && action !== 'remove') throw badRequest('action must be "add" or "remove"');
  if (action === 'add') {
    const input = { hostPath: body.hostPath, guestPath: body.guestPath, readOnly: body.readOnly };
    const pre = validateShare(input, { existing: vm0.shares || [] }); // bad input: 400 before any lock
    const title = 'Share ' + pre.share.hostPath + ' with ' + name + ' at ' + pre.share.guestPath;
    return tasks.runAndWait({ kind: 'share-add', title: title, vm: name, locks: ['vm:' + name] }, async (t) => {
      const vm = st.getVm(name);
      const v = validateShare(input, { existing: vm.shares || [] });
      const sh = newShare(v.share, name, vm.shares || []);
      vm.shares = (vm.shares || []).concat([sh]);
      st.saveState();
      const warnings = v.warnings.slice();
      for (const w of warnings) t.warn(w);
      let res = { applied: 'next-start', mounted: false, pending: false, warnings: [] };
      if (await vmMod.isRunning(name)) res = await add('vm', name, sh, { t: t });
      else t.log('saved: ' + sh.hostPath + ' is mounted at ' + sh.guestPath + ' when "' + name + '" starts');
      return {
        name: name, share: publicShare(sh), applied: res.applied, mounted: !!res.mounted, pending: !!res.pending,
        warnings: warnings.concat(res.warnings), shares: vm.shares.map(publicShare), caveat: CAVEAT,
      };
    });
  }
  const byId = body.guestPath === undefined || body.guestPath === null;
  const key = byId ? body.id : body.guestPath;
  if (typeof key !== 'string' || !key) throw badRequest('guestPath (the path in the VM) of the shared folder to remove is required');
  const find = (list) => (list || []).find((s) => (byId ? s.id : s.guestPath) === key);
  const missing = () => notFound('"' + name + '" has no shared folder ' + (byId ? key : 'at ' + key));
  if (!find(vm0.shares)) throw missing();
  return tasks.runAndWait({ kind: 'share-remove', title: 'Stop sharing ' + key + ' with ' + name, vm: name, locks: ['vm:' + name] }, async (t) => {
    const vm = st.getVm(name);
    const sh = find(vm.shares);
    if (!sh) throw missing();
    vm.shares = (vm.shares || []).filter((x) => x !== sh);
    st.saveState();
    let res = { applied: 'next-start', unmounted: false, warnings: [] };
    if (await vmMod.isRunning(name)) res = await remove('vm', name, sh, { t: t });
    else t.log('removed: ' + sh.hostPath + ' is no longer mounted at ' + sh.guestPath);
    for (const w of res.warnings) t.warn(w);
    return {
      name: name, removed: publicShare(sh), applied: res.applied, unmounted: !!res.unmounted,
      warnings: res.warnings, shares: vm.shares.map(publicShare),
    };
  });
}

// The drives of this PC (Windows: C:\ ... Z:\ that answer within 1.5 s,
// cached briefly - a disconnected network drive can take long) or ['/'].
let rootsCache = null;
async function driveRoots() {
  if (!platform.IS_WIN) return ['/'];
  if (rootsCache && Date.now() - rootsCache.at < 15000) return rootsCache.list.slice();
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const probe = (l) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    fsp.stat(l + ':\\').then((s) => s.isDirectory(), () => false).then((ok) => { clearTimeout(timer); resolve(ok); });
  });
  const ok = await Promise.all(letters.map(probe));
  const list = letters.filter((l, i) => ok[i]).map((l) => l + ':\\');
  rootsCache = { at: Date.now(), list: list };
  return list.slice();
}

// GET /api/fs/dirs?path= - the GUI's folder picker. The SUB-FOLDERS of path
// (default: the user profile; files are never listed), each with whether it
// can be opened and, where sharing it would be refused (the data folder, a
// folder containing it, a system folder), why.
// -> {path, parent, sep, home, roots, readable, error, dirs: [{name, path,
//     readable, link?, hidden?, refused?}], truncated}
async function listDirs(q) {
  q = q || {};
  const home = os.homedir();
  let p = q.path;
  if (p === undefined || p === null || p === '') p = home;
  if (typeof p !== 'string' || p.length > 4096 || p.indexOf('\0') !== -1) throw badRequest('path must be a folder path');
  // never even stat() a network path: Windows would connect to that host
  // and send it the user's sign-in (sec-1)
  const netWhy = util.networkPathError(p);
  if (netWhy) throw badRequest(netWhy);
  if (platform.IS_WIN && /^[A-Za-z]:$/.test(p)) p += '\\';
  if (!path.isAbsolute(p)) throw badRequest('path must be absolute, e.g. ' + (platform.IS_WIN ? 'C:\\Users' : '/home'));
  const abs = path.resolve(p);
  let stt;
  try { stt = await fsp.stat(abs); } catch (e) { throw notFound('there is no folder ' + abs); }
  if (!stt.isDirectory()) throw badRequest(abs + ' is a file, not a folder');
  const up = path.dirname(abs);
  const out = {
    path: abs, parent: up === abs ? null : up, sep: path.sep, home: home, roots: await driveRoots(),
    readable: true, error: null, dirs: [], truncated: false,
  };
  let ents;
  try { ents = await fsp.readdir(abs, { withFileTypes: true }); }
  catch (e) { out.readable = false; out.error = 'this folder cannot be opened (' + (e.code || errMsg(e)) + ')'; return out; }
  const cands = [];
  for (const d of ents) {
    if (d.isDirectory()) cands.push({ name: d.name, link: false });
    else if (d.isSymbolicLink()) cands.push({ name: d.name, link: true }); // junctions too: kept if they lead to a folder
  }
  cands.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  if (cands.length > MAX_DIRS) { out.truncated = true; cands.length = MAX_DIRS; }
  const dataReal = realOr(CFG.root);
  const rows = await Promise.all(cands.map(async (c) => {
    const full = path.join(abs, c.name);
    if (c.link) {
      // a link to a network share is not followed: listed as refused
      let target = null;
      try { target = await fsp.readlink(full); } catch (e) { target = null; }
      if (target && util.networkPathError(target)) {
        return { name: c.name, path: full, readable: false, link: true, refused: 'cannot be shared: it leads to a network location' };
      }
      try { if (!(await fsp.stat(full)).isDirectory()) return null; } catch (e) { /* dangling or no access: listed, not readable */ }
    }
    let readable = true;
    try { const h = await fsp.opendir(full); await h.close(); } catch (e) { readable = false; }
    const row = { name: c.name, path: full, readable: readable };
    if (c.link) row.link = true;
    if (/^[.$]/.test(c.name)) row.hidden = true;
    const why = refusal(full, dataReal);
    if (why) row.refused = 'cannot be shared: ' + why;
    return row;
  }));
  out.dirs = rows.filter(Boolean);
  return out;
}

module.exports = {
  DEFAULT_PORT, MAX_SHARES, CAVEAT, ACCESS_NOTE,
  ensureServer, port, shutdown,
  validateShare, newShare, publicShare, fwcfgFile, writeFwcfg, shareUidGid,
  registerFor, disconnect, unregister, status, registered, add, remove, restoreRunning,
  listShares, vmSharesAction, listDirs,
  _owners: owners,
  _internal: {
    onAttach: onAttach, isStale: isStale, schedule: schedule, cleanupFiles: cleanupFiles, idStem: idStem, driveRoots: driveRoots,
    identityRefusal: identityRefusal,
    setWatchMs: (ms) => { WATCH_MS = ms; },
  },
};
