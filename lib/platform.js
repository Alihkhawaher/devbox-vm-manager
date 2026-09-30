'use strict';
/*
 * Everything that differs between Windows, Linux and macOS lives here:
 * finding the external tools, listing QEMU processes, listing listening
 * sockets, checking whether a port is free, the address for QEMU's private
 * monitor/serial sockets, hardware acceleration, opening a browser, free disk
 * space, locking down private files, and install instructions.
 *
 * The text parsers (tasklist CSV, ps, netstat, ss, lsof, /proc/net/tcp) are
 * pure functions, exported and unit-tested with fixtures - including a German
 * netstat, because Windows translates the state column (OPS-1).
 *
 * Nothing runs at require time; results that are expensive to compute are
 * cached (refresh() / redetect() clear the caches).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { CFG } = require('./config');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// tool discovery
// ---------------------------------------------------------------------------
// Short names used across the code -> the real program name.
const TOOL_ALIASES = {
  qemu: 'qemu-system-x86_64', 'qemu-system-x86_64': 'qemu-system-x86_64',
  'qemu-img': 'qemu-img', qemuImg: 'qemu-img',
  ssh: 'ssh', 'ssh-keygen': 'ssh-keygen', sshKeygen: 'ssh-keygen', scp: 'scp',
  '7z': '7z', sevenZip: '7z',
};
// config.json keys that pin a tool to an exact file
const OVERRIDE_KEY = { ssh: 'ssh', 'ssh-keygen': 'sshKeygen', scp: 'scp', '7z': 'sevenZip' };

function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
function exeName(name) { return IS_WIN ? name + '.exe' : name; }

function wellKnownDirs(name) {
  const env = process.env;
  if (IS_WIN) {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const sys = env.SystemRoot || 'C:\\Windows';
    const local = env.LOCALAPPDATA || '';
    const profile = env.USERPROFILE || '';
    if (/^qemu/.test(name)) return [path.join(pf, 'qemu'), path.join(pf86, 'qemu'), local && path.join(local, 'Programs', 'qemu')];
    if (name === '7z') {
      return [path.join(pf, '7-Zip'), path.join(pf86, '7-Zip'), local && path.join(local, 'Programs', '7-Zip'),
        profile && path.join(profile, 'scoop', 'apps', '7zip', 'current')];
    }
    // ssh, ssh-keygen, scp: the Windows OpenSSH client first, Git's MSYS copy last
    return [path.join(sys, 'System32', 'OpenSSH'), path.join(pf, 'OpenSSH'), path.join(pf, 'OpenSSH-Win64'),
      path.join(pf, 'Git', 'usr', 'bin'), local && path.join(local, 'Programs', 'Git', 'usr', 'bin')];
  }
  if (IS_MAC) return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];
  return ['/usr/bin', '/usr/local/bin', '/bin', '/usr/libexec'];
}

// Git for Windows / MSYS2 ship their own ssh.exe, which lands first on PATH
// in a Git Bash window. It is a last resort only: the Windows OpenSSH client
// is preferred (its path handling and key-permission checks are native).
const MSYS_DIR = /[\\/](git|msys64|msys2|mingw64|cygwin64)[\\/](usr[\\/])?bin$/i;

function searchPath(file, opts) {
  const raw = process.env.PATH || process.env.Path || '';
  for (let d of raw.split(path.delimiter)) {
    d = d.trim().replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    if (opts && opts.skipMsys && MSYS_DIR.test(d.replace(/[\\/]+$/, ''))) continue;
    const f = path.join(d, file);
    if (isFile(f)) return f;
  }
  return null;
}

const toolCache = new Map();
const MISS_TTL_MS = 30000; // re-look for missing tools now and then (user installs one)

// Absolute path of a tool, or null. Order (spec section 3): config.json
// override -> <root>/qemu (managed install) -> PATH -> well-known folders.
function findTool(alias) {
  const name = TOOL_ALIASES[alias] || alias;
  const hit = toolCache.get(name);
  if (hit && (hit.path || Date.now() - hit.at < MISS_TTL_MS)) return hit.path;
  const file = exeName(name);
  const ov = CFG.toolOverrides || {};
  const cands = [];
  if (/^qemu/.test(name)) {
    if (ov.qemuDir) cands.push(path.join(ov.qemuDir, file));
    cands.push(path.join(CFG.qemuDir, file));
  }
  if (OVERRIDE_KEY[name] && ov[OVERRIDE_KEY[name]]) cands.unshift(ov[OVERRIDE_KEY[name]]);
  const sshFamily = /^(ssh|ssh-keygen|scp)$/.test(name);
  let found = cands.find(isFile) || searchPath(file, { skipMsys: IS_WIN && sshFamily });
  if (!found) {
    for (const d of wellKnownDirs(name)) {
      if (!d) continue;
      const f = path.join(d, file);
      if (isFile(f)) { found = f; break; }
    }
  }
  if (!found && IS_WIN && sshFamily) found = searchPath(file); // any MSYS copy on PATH
  if (!found && name === '7z' && !IS_WIN) found = searchPath('7za') || searchPath('7zz');
  found = found ? path.resolve(found) : null;
  toolCache.set(name, { path: found, at: Date.now() });
  return found;
}

// Forget cached tool locations and the accel probe (after installing QEMU).
function refresh() { toolCache.clear(); accelCache = null; accelResult = null; }

// ---------------------------------------------------------------------------
// processes
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function killPid(pid) {
  if (!pid) return false;
  try { process.kill(pid); return true; } catch (e) { return false; }
}

// `tasklist /FO CSV /NH` rows: "image","pid","session","#","mem". Any line that
// is not CSV (the localised "INFO: No tasks are running..." message) is simply
// not a match, so the Windows display language does not matter.
function parseTasklistCsv(stdout) {
  const pids = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]*)","(\d+)"/);
    if (m && /^qemu-system-/i.test(m[1])) pids.add(parseInt(m[2], 10));
  }
  return pids;
}

// macOS `ps -axo pid=,comm=`: "  123 /opt/homebrew/bin/qemu-system-x86_64"
function parsePs(stdout) {
  const pids = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m && /^qemu-system-/.test(path.posix.basename(m[2]))) pids.add(parseInt(m[1], 10));
  }
  return pids;
}

function execText(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs || 15000 },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch (e) { resolve(null); }
  });
}

// Set of pids of running qemu-system-* processes, or null when the listing
// failed (callers then keep what they knew - a failed listing never means
// "nothing is running", OPS-1).
async function listQemuPids() {
  if (IS_WIN) {
    // tasklist takes 1.5-4.5 s on a busy PC and ran past 15 s when the CPU was
    // pegged at 100% (a failed listing means "cannot tell", never "not running")
    const out = await execText('tasklist', ['/FI', 'IMAGENAME eq qemu-system-*', '/FO', 'CSV', '/NH'], 60000);
    return out === null ? null : parseTasklistCsv(out);
  }
  if (IS_LINUX) {
    try {
      const pids = new Set();
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          // comm is truncated to 15 chars ("qemu-system-x86"), still a clear match
          if (/^qemu-system-/.test(fs.readFileSync('/proc/' + d + '/comm', 'utf8'))) pids.add(parseInt(d, 10));
        } catch (e) { /* process ended while we looked */ }
      }
      return pids;
    } catch (e) { /* no /proc: fall through to ps */ }
  }
  const out = await execText('ps', ['-axo', 'pid=,comm=']);
  return out === null ? null : parsePs(out);
}

async function isQemuPid(pid, pids) {
  if (!pid) return false;
  const set = pids || await listQemuPids();
  return set ? set.has(pid) : false;
}

// ---------------------------------------------------------------------------
// listening sockets (Network view only - never per status poll)
// ---------------------------------------------------------------------------
// "127.0.0.1:80" / "[::]:80" / "*:80" / "0.0.0.0:*" -> {host, port}
function splitHostPort(s) {
  const t = String(s || '').trim();
  let m = t.match(/^\[([^\]]*)\]:(\d+|\*)$/);
  if (!m) m = t.match(/^(.*):(\d+|\*)$/);
  if (!m) return null;
  let host = m[1].replace(/%.*$/, '');
  if (host === '*' || host === '') host = '0.0.0.0';
  if (host.indexOf('::ffff:') === 0) host = host.slice(7);
  const port = m[2] === '*' ? 0 : parseInt(m[2], 10);
  return { host: host, port: port };
}

// Windows `netstat -ano`. A LISTENING row is recognised by its FOREIGN address
// being 0.0.0.0:0 or [::]:0 - never by the state word, which Windows
// translates (LISTENING, ABHÖREN, ÉCOUTE, ESCUCHANDO, ...).
function parseNetstat(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+.*?\s(\d+)\s*$/i);
    if (!m) continue;
    if (!/^(0\.0\.0\.0:0|\[::\]:0)$/.test(m[2])) continue;
    const local = splitHostPort(m[1]);
    if (!local || !local.port) continue;
    rows.push({ port: local.port, address: local.host, pid: parseInt(m[3], 10) });
  }
  return rows;
}

// Linux `ss -ltnpH`: "LISTEN 0 4096 127.0.0.1:2223 0.0.0.0:* users:(("qemu-system-x86",pid=4312,fd=12))"
// The process column only appears for our own processes (no root needed for those).
function parseSs(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*LISTEN\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const local = splitHostPort(m[1]);
    if (!local || !local.port) continue;
    const p = (m[3] || '').match(/pid=(\d+)/);
    rows.push({ port: local.port, address: local.host, pid: p ? parseInt(p[1], 10) : null });
  }
  return rows;
}

// /proc/net/tcp and tcp6 (fallback when ss is missing): state 0A = LISTEN,
// addresses are little-endian hex. No pids here.
function parseProcNetTcp(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*\d+:\s+([0-9A-Fa-f]+):([0-9A-Fa-f]{4})\s+[0-9A-Fa-f]+:[0-9A-Fa-f]{4}\s+0A\s/);
    if (!m) continue;
    let address = '0.0.0.0';
    if (m[1].length === 8) {
      const n = parseInt(m[1], 16);
      address = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
    } else if (/^0+$/.test(m[1])) address = '::';
    else address = 'ipv6';
    rows.push({ port: parseInt(m[2], 16), address: address, pid: null });
  }
  return rows;
}

// macOS `lsof -nP -iTCP -sTCP:LISTEN`:
// "qemu-syst 12345 ali 12u IPv4 0xabc 0t0 TCP 127.0.0.1:2223 (LISTEN)"
function parseLsof(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\S+\s+(\d+)\s+.*\sTCP\s+(\S+)\s+\(LISTEN\)\s*$/);
    if (!m) continue;
    const local = splitHostPort(m[2]);
    if (!local || !local.port) continue;
    rows.push({ port: local.port, address: local.host, pid: parseInt(m[1], 10) });
  }
  return rows;
}

// [{port, address, pid}] for every listening TCP socket, or null on failure.
async function listListeners() {
  if (IS_WIN) {
    const out = await execText('netstat', ['-ano', '-p', 'TCP']);
    const out6 = await execText('netstat', ['-ano', '-p', 'TCPv6']);
    if (out === null && out6 === null) return null;
    return parseNetstat(out || '').concat(parseNetstat(out6 || ''));
  }
  if (IS_MAC) {
    const out = await execText('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    return out === null ? null : parseLsof(out);
  }
  const ss = await execText('ss', ['-ltnpH']);
  if (ss !== null) return parseSs(ss);
  try {
    let txt = fs.readFileSync('/proc/net/tcp', 'utf8');
    try { txt += '\n' + fs.readFileSync('/proc/net/tcp6', 'utf8'); } catch (e) {}
    return parseProcNetTcp(txt);
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------
function canListen(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    try {
      s.listen({ port: port, host: host, exclusive: true }, () => s.close(() => resolve(true)));
    } catch (e) { resolve(false); }
  });
}

// Free only if we could bind it on BOTH 127.0.0.1 and 0.0.0.0: Windows lets a
// wildcard bind coexist with another program's loopback bind (and vice versa),
// and QEMU may need either (spec section 3).
// The probe itself binds the port for a moment, so two probes of the SAME
// port at once would make each other fail (found in a review: two port
// changes at the same time got a false "in use by another program"). Probes
// of one port therefore run one after another.
const portProbes = new Map(); // port -> tail of its probe chain
async function probePortFree(port) {
  if (!(await canListen(port, '127.0.0.1'))) return false;
  return canListen(port, '0.0.0.0');
}
function isPortFree(port) {
  if (!(port >= 1 && port <= 65535)) return Promise.resolve(false);
  const prev = portProbes.get(port) || Promise.resolve();
  const p = prev.then(() => probePortFree(port));
  const tail = p.catch(() => false);
  portProbes.set(port, tail);
  tail.then(() => { if (portProbes.get(port) === tail) portProbes.delete(port); });
  return p;
}

// A port the OS considers free right now on `host` (listen on 0, read, close).
function freeLocalPort(host) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ port: 0, host: host || '127.0.0.1', exclusive: true }, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// A random loopback address 127.a.b.c with a in 1-254 and c in 1-254: never
// in 127.0.x.x (so never 127.0.0.1, see internalHost) and never a .0/.255
// host part. About 16.5 million choices. Pure apart from the randomness.
function randomLoopback() {
  const r = crypto.randomBytes(3);
  return '127.' + (1 + (r[0] % 254)) + '.' + r[1] + '.' + (1 + (r[2] % 254));
}

// Address for QEMU's monitor and serial TCP sockets (Windows), resolved per
// VM start. Neither socket has a password, and the HMP monitor can run
// programs as the user (migrate exec:...), so two rules (SEC-4):
//  - never 127.0.0.1: slirp maps the guests' 10.0.2.2 to it, so every VM
//    could reach it. Any other 127.x.y.z is out of their reach, and Windows
//    answers on all of 127/8 without any configuration.
//  - not predictable: a web page in a browser without Local Network Access
//    protection could spray HTTP requests (whose body lines HMP would run) at
//    a fixed address; a fresh random 127.a.b.c per start plus the OS's random
//    port leaves about 2^24 x 2^14 targets instead of 2^14.
// Falls back to 127.0.0.2, then FAILS CLOSED (rejects with a clear error)
// unless config.json says "allowSharedLoopback": true - only then 127.0.0.1,
// with a warning in /api/state. Linux/macOS use unix sockets in a private
// folder instead: null tells callers to do that.
async function internalHost() {
  if (!IS_WIN) return null;
  for (let i = 0; i < 3; i++) {
    const a = randomLoopback();
    if (await canListen(0, a)) return a;
  }
  if (await canListen(0, '127.0.0.2')) return '127.0.0.2';
  if (CFG.allowSharedLoopback) {
    const msg = 'no private loopback address (127.x.y.z) can be bound on this PC, so the QEMU monitor and serial console of new VMs listen on 127.0.0.1, where the VMs themselves can reach them (allowSharedLoopback is set in config.json)';
    try { require('./state').addWarning(msg); } catch (e) { /* state not loaded (tools) */ }
    return '127.0.0.1';
  }
  const e = new Error('cannot bind any loopback address other than 127.0.0.1 (tried 127.x.y.z and 127.0.0.2), and 127.0.0.1 would let the VMs reach the QEMU monitor - ' +
    'check security software that restricts loopback addresses, or accept the risk with "allowSharedLoopback": true in ' + (CFG.configFile || 'config.json'));
  e.code = 'NO_PRIVATE_LOOPBACK';
  throw e;
}

// Non-internal IPv4 addresses of this PC (to show LAN URLs). Cached for 30 s:
// os.networkInterfaces() is synchronous and took 70-350 ms on a Windows PC
// with many virtual adapters - on every /api/state poll, blocking the server.
let lanCache = null;
function lanAddresses() {
  if (lanCache && Date.now() - lanCache.at < 30000) return lanCache.list.slice();
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  lanCache = { list: out, at: Date.now() };
  return out.slice();
}

// ---------------------------------------------------------------------------
// hardware acceleration
// ---------------------------------------------------------------------------
let accelCache = null;   // promise of the result
let accelResult = null;  // the result once known

// Probe processes still alive; killed if this process exits mid-probe (a
// paused diskless QEMU would otherwise linger forever on Windows).
const probes = new Set();
let probeExitHook = false;

// Can QEMU start with this accelerator? A paused, diskless VM that is still
// alive after ~2.5 s means yes; an immediate exit means no.
function probeAccel(qemu, accel) {
  if (!probeExitHook) {
    probeExitHook = true;
    process.on('exit', () => { for (const c of probes) { try { c.kill(); } catch (e) {} } });
  }
  return new Promise((resolve) => {
    let child = null, done = false, timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child) child.kill(); } catch (e) {}
      probes.delete(child);
      resolve(v);
    };
    try {
      child = spawn(qemu, ['-accel', accel, '-machine', 'q35', '-display', 'none', '-S', '-nodefaults', '-m', '64'],
        { stdio: 'ignore', windowsHide: true });
    } catch (e) { return resolve(false); }
    probes.add(child);
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));
    timer = setTimeout(() => finish(true), 2500);
  });
}

// {available: [...,'tcg'], recommended} - cached; redetect() forgets it.
// Windows: WHPX (needs the Windows Hypervisor Platform feature); Linux: KVM
// when /dev/kvm is usable; Intel macOS: HVF. TCG (pure emulation) always works.
function detectAccel(qemuPath) {
  if (accelCache) return accelCache;
  accelCache = (async () => {
    const q = qemuPath || findTool('qemu');
    const available = [];
    if (q) {
      if (IS_WIN) {
        if (await probeAccel(q, 'whpx,kernel-irqchip=off')) available.push('whpx');
      } else if (IS_LINUX) {
        try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); available.push('kvm'); } catch (e) {}
      } else if (IS_MAC && process.arch === 'x64') {
        if (await probeAccel(q, 'hvf')) available.push('hvf');
      }
      available.push('tcg');
    }
    accelResult = { available: available, recommended: available[0] || null };
    return accelResult;
  })();
  return accelCache;
}
function redetect() { accelCache = null; accelResult = null; }
// Non-blocking view for /api/state. Detection itself is started by the entry
// point (and after a QEMU install), never by a status poll.
function accelStatus() {
  if (accelResult) return Object.assign({ detecting: false }, accelResult);
  return { available: null, recommended: null, detecting: !!accelCache };
}

// ---------------------------------------------------------------------------
// desktop integration, disks, private files, time zone
// ---------------------------------------------------------------------------
// Open a URL in the default browser. Never throws.
function openBrowser(url) {
  try {
    const u = String(url);
    if (!/^https?:\/\/[^\s"<>^&|%]+$/.test(u)) return false;
    let child;
    if (IS_WIN) {
      // `start` is a cmd built-in; the empty "" is the window title. The URL is
      // validated above (no quotes, &, |, ^, %), so this quoting is safe.
      child = spawn('cmd', ['/d', '/s', '/c', 'start "" "' + u + '"'],
        { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    } else {
      child = spawn(IS_MAC ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) { return false; }
}

// Free space on the volume holding `dir` (Node >= 18.15 has statfsSync).
function diskFree(dir) {
  let d = path.resolve(String(dir || CFG.root));
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (typeof fs.statfsSync !== 'function') return { total: null, free: null, path: d, error: 'Node 18.15+ is needed to read free disk space' };
  try {
    const s = fs.statfsSync(d);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, path: d, error: null };
  } catch (e) { return { total: null, free: null, path: d, error: e.message }; }
}

// Make a file readable by the current user only. REQUIRED on Windows because
// the default data root is inside the project folder, where inherited ACLs
// are too open and Windows OpenSSH refuses the key ("UNPROTECTED PRIVATE KEY
// FILE"). Returns {ok, error}.
function protectPrivateFile(file) {
  if (!IS_WIN) {
    try { fs.chmodSync(file, 0o600); return { ok: true, error: null }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const user = process.env.USERNAME || (() => { try { return os.userInfo().username; } catch (e) { return ''; } })();
  if (!user) return { ok: false, error: 'cannot tell the current user name' };
  const who = process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' + user : user;
  const target = path.win32.normalize(path.resolve(file));
  // /reset first: it drops EXPLICIT entries (e.g. "Everyone: read" added by a
  // copy tool), which /inheritance:r alone would keep - and OpenSSH refuses
  // the key while any of them remains.
  try { execFileSync('icacls', [target, '/reset'], { windowsHide: true, stdio: 'ignore', timeout: 20000 }); } catch (e) { /* next step decides */ }
  for (const principal of [who, user]) {
    try {
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', principal + ':F'],
        { windowsHide: true, stdio: 'ignore', timeout: 20000 });
      return { ok: true, error: null };
    } catch (e) { /* try the next form of the name */ }
  }
  return { ok: false, error: 'icacls could not restrict ' + target };
}

// The names icacls may know the current user by (DOMAIN\user first).
function userPrincipals() {
  const user = process.env.USERNAME || (() => { try { return os.userInfo().username; } catch (e) { return ''; } })();
  if (!user) return [];
  return process.env.USERDOMAIN ? [process.env.USERDOMAIN + '\\' + user, user] : [user];
}

// ---------------------------------------------------------------------------
// private folders and files (sec-5)
// ---------------------------------------------------------------------------
// Share secrets (vms.json, containers.json, the fw_cfg share lists) and
// container env values (containers.json, microvms/<id>/spec.sh) must not be
// readable by other accounts of this PC: one read secret is read-write
// access to a shared folder through the 9P server on 127.0.0.1. The default
// data root sits inside the program folder, whose inherited ACL lets every
// signed-in user read (and modify) it. Locking the manager's OWN subfolders
// (run/, microvms/) once per start makes everything created in them
// private; files that live in the data root itself are written as a temp
// file in run/ and renamed into place, which keeps run/'s private ACL
// (NTFS keeps a file's ACL across a rename on one drive). The data root
// itself is never re-permissioned: it may be the user's home folder (an
// install from before v2).
const lockedDirs = new Set(); // folders this process locked successfully
// Set once the manager tried to lock its folders (server start). Before that
// (unit tests, tools) files are written as they always were: the per-file
// fallback below costs two icacls runs per write.
let privacyAttempted = false;

function normDir(p) {
  const s = path.resolve(p).replace(/[\\/]+$/, '');
  return IS_WIN ? s.toLowerCase() : s;
}
// Is file inside a folder this process locked?
function inLockedDir(file) {
  const f = normDir(file);
  for (const d of lockedDirs) if (f.startsWith(d + path.sep)) return true;
  return false;
}

// Lock a folder (created if missing) to the current user: Windows - its ACL
// is reset to one inheritable "full control" entry for this user, which is
// propagated to the files already in it; elsewhere mode 0700. -> {ok, error}
function protectPrivateDir(dir) {
  privacyAttempted = true;
  const abs = path.resolve(dir);
  try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  if (!IS_WIN) {
    try { fs.chmodSync(abs, 0o700); lockedDirs.add(normDir(abs)); return { ok: true, error: null }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const target = path.win32.normalize(abs);
  // /reset drops explicit entries another tool added to the folder itself
  try { execFileSync('icacls', [target, '/reset'], { windowsHide: true, stdio: 'ignore', timeout: 30000 }); } catch (e) { /* next step decides */ }
  for (const principal of userPrincipals()) {
    try {
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', principal + ':(OI)(CI)F'], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
      lockedDirs.add(normDir(abs));
      return { ok: true, error: null };
    } catch (e) { /* try the next form of the name */ }
  }
  return { ok: false, error: 'icacls could not restrict ' + target };
}

// Write a file that holds secrets so that no other account can read it -
// not even for a moment.
//   o.atomic   temp file + rename (a crash leaves the old or the new file)
//   o.tmpDir   a LOCKED folder on the same drive for the temp file (files
//              that live outside the locked folders: the registries)
//   o.required throw when the file cannot be made private (default: log
//              once and write it anyway - a registry that cannot be saved is
//              worse than one that is only as private as its folder)
// Fast path: the file is in a locked folder, or o.tmpDir is locked (no
// icacls call); also before any folder was locked (see privacyAttempted).
// Otherwise the temp file is made private while still EMPTY, then filled
// and renamed into place.
const warnedPrivate = new Set();
function writePrivateFileSync(file, data, o) {
  o = o || {};
  const util = require('./util');
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (inLockedDir(abs) || !privacyAttempted) {
    if (o.atomic) return util.atomicWriteFileSync(abs, data, 0o600);
    fs.writeFileSync(abs, data, { mode: 0o600 });
    return undefined;
  }
  if (o.tmpDir && lockedDirs.has(normDir(o.tmpDir))) return util.atomicWriteFileSync(abs, data, 0o600, { tmpDir: o.tmpDir });
  const tmp = abs + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    const pr = protectPrivateFile(tmp);
    if (!pr.ok) {
      if (o.required && IS_WIN) throw new Error('could not make ' + abs + ' readable by this user only (' + pr.error + ') - its secrets were not written');
      if (!warnedPrivate.has(abs)) {
        warnedPrivate.add(abs);
        try { util.logError('could not restrict ' + abs + ' to this user (' + pr.error + ') - it is only as private as its folder'); } catch (e) { /* logging only */ }
      }
    }
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
      if (o.atomic) fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    let lastErr = null;
    for (let i = 0; i < 6; i++) {
      try { fs.renameSync(tmp, abs); return undefined; }
      catch (e) {
        lastErr = e;
        if (!/^(EPERM|EACCES|EBUSY)$/.test(e.code)) break;
        util.sleepSync(40 * (i + 1));
      }
    }
    throw lastErr;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* renamed, or removed next time */ }
  }
}

// ---------------------------------------------------------------------------
// process identity
// ---------------------------------------------------------------------------
// The command line of a running process, or null when it cannot be read
// (gone, no permission, the listing failed). Proves which program a pid is
// before the manager adopts or kills it (pids are reused). Windows needs a
// CIM query (about a second), so callers use it only for rare cases.
async function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (IS_LINUX) {
    try {
      const b = fs.readFileSync('/proc/' + pid + '/cmdline');
      return b.length ? b.toString('utf8').split('\0').join(' ').trim() : null;
    } catch (e) { return null; }
  }
  if (IS_WIN) {
    const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], 30000);
    const s = out === null ? '' : out.trim();
    return s || null;
  }
  const out = await execText('ps', ['-o', 'args=', '-p', String(pid)]);
  const s = out === null ? '' : out.trim();
  return s || null;
}

function hostTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

function osInfo() {
  return { os: process.platform, arch: process.arch, release: os.release() };
}

// Exact instructions for missing tools, per OS (spec section 3).
function installHints() {
  if (IS_WIN) {
    return {
      qemu: 'Use "Set up everything" (downloads QEMU into the data folder), or install it from https://qemu.weilnetz.de/w64/',
      ssh: 'Windows Settings > System > Optional features > Add a feature > "OpenSSH Client"',
      sevenZip: 'Install 7-Zip from https://www.7-zip.org or run: winget install 7zip.7zip',
      accel: 'Optional, for speed: turn on the Windows feature "Windows Hypervisor Platform" (Control Panel > Programs > Turn Windows features on or off), then restart.',
    };
  }
  if (IS_MAC) {
    return {
      qemu: 'brew install qemu',
      ssh: 'The OpenSSH client ships with macOS (ssh, ssh-keygen, scp).',
      sevenZip: 'Not needed on macOS.',
      accel: process.arch === 'x64' ? 'HVF is used automatically when available.' : 'Apple Silicon runs x86 guests with TCG emulation (slower).',
    };
  }
  return {
    qemu: 'Debian/Ubuntu: sudo apt install qemu-system-x86 qemu-utils openssh-client   Fedora: sudo dnf install qemu-system-x86 qemu-img openssh-clients   Arch: sudo pacman -S qemu-base openssh',
    ssh: 'Debian/Ubuntu: sudo apt install openssh-client   Fedora: sudo dnf install openssh-clients',
    sevenZip: 'Not needed on Linux.',
    accel: 'For speed, make /dev/kvm usable: sudo usermod -aG kvm $USER, then log out and in again.',
  };
}

module.exports = {
  IS_WIN, IS_MAC, IS_LINUX,
  findTool, refresh,
  pidAlive, killPid, listQemuPids, isQemuPid,
  parseTasklistCsv, parsePs, parseNetstat, parseSs, parseProcNetTcp, parseLsof, splitHostPort,
  listListeners,
  canListen, isPortFree, freeLocalPort, internalHost, randomLoopback, lanAddresses,
  detectAccel, redetect, accelStatus,
  openBrowser, diskFree, protectPrivateFile, hostTimezone, osInfo, installHints,
  protectPrivateDir, writePrivateFileSync, inLockedDir, processCommandLine,
  _lockedDirs: lockedDirs,
  _setPrivacyAttempted: (v) => { privacyAttempted = !!v; },
};
