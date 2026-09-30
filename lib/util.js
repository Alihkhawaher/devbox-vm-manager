'use strict';
/*
 * Small helpers shared by every module: file checks, running a program,
 * socket probes, byte formatting, name validation, shell quoting, API errors,
 * atomic writes, reading only the end of a big log, and the manager log.
 *
 * Nothing here keeps state except the manager-log file name (setLogFile).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, execFileSync } = require('child_process');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (e) { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// errors the HTTP layer turns into status codes (spec section 12)
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}
const badRequest = (msg, extra) => new ApiError(400, 'BAD_REQUEST', msg, extra);
const notFound = (msg) => new ApiError(404, 'NOT_FOUND', msg);
const conflict = (msg, code) => new ApiError(409, code || 'CONFLICT', msg);
// A feature whose endpoint exists but whose implementation has not landed yet.
const notImplemented = (what) => new ApiError(501, 'NOT_IMPLEMENTED', what + ' is not implemented yet');

const errMsg = (e) => String((e && e.message) || e || 'unknown error');

// ---------------------------------------------------------------------------
// running programs
// ---------------------------------------------------------------------------
// Resolves {code, stdout, stderr, error}; never rejects. A missing program
// (cmd null/undefined, ENOENT) is code 127 with a readable error.
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    if (!cmd) return resolve({ code: 127, stdout: '', stderr: 'program not found', error: new Error('program not found') });
    let child;
    try {
      child = execFile(cmd, args || [], Object.assign({ windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, opts || {}),
        (err, stdout, stderr) => resolve({
          code: err ? (typeof err.code === 'number' ? err.code : (err.code === 'ENOENT' ? 127 : 1)) : 0,
          stdout: String(stdout || ''), stderr: String(stderr || '') || (err && !stderr ? errMsg(err) : ''),
          error: err || null,
        }));
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: errMsg(e), error: e });
    }
    // execFile already reports spawn errors through the callback; this only
    // makes sure an 'error' on stdin (EPIPE) can never become uncaught.
    if (child && child.stdin) child.stdin.on('error', () => {});
  });
}

function runSync(cmd, args, timeoutMs) {
  if (!cmd) return '';
  try {
    const r = execFileSync(cmd, args || [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs || 15000 });
    return String(r).trim();
  } catch (e) { return ''; }
}

// Keeps the first `head` bytes and the last `tail` bytes of a stream, so a
// command that prints megabytes cannot exhaust memory yet both the start
// (what it was doing) and the end (the error) survive.
class OutputCapture {
  constructor(maxBytes, headShare) {
    this.max = Math.max(1024, maxBytes || 16 * 1024 * 1024);
    this.headMax = Math.floor(this.max * (headShare === undefined ? 0.2 : headShare));
    this.tailMax = this.max - this.headMax;
    this.head = [];
    this.headLen = 0;
    this.tail = [];
    this.tailLen = 0;
    this.total = 0;
  }
  push(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.total += b.length;
    let rest = b;
    if (this.headLen < this.headMax) {
      const take = rest.subarray(0, this.headMax - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      rest = rest.subarray(take.length);
    }
    if (!rest.length) return;
    this.tail.push(rest);
    this.tailLen += rest.length;
    while (this.tailLen > this.tailMax && this.tail.length) {
      const over = this.tailLen - this.tailMax;
      const first = this.tail[0];
      if (first.length <= over) { this.tail.shift(); this.tailLen -= first.length; }
      else { this.tail[0] = first.subarray(over); this.tailLen -= over; }
    }
  }
  get truncated() { return this.total > this.headLen + this.tailLen; }
  text() {
    const h = Buffer.concat(this.head).toString('utf8');
    const t = Buffer.concat(this.tail).toString('utf8');
    if (!this.truncated) return h + t;
    const dropped = this.total - this.headLen - this.tailLen;
    return h + '\n[... ' + dropped + ' bytes omitted ...]\n' + t;
  }
}

// ---------------------------------------------------------------------------
// socket probes
// ---------------------------------------------------------------------------
// Only a real sshd banner means the guest is usable.
function probeSsh(port, timeoutMs, host) {
  return new Promise((resolve) => {
    let settled = false, buf = '', sock = null;
    const done = (v) => { if (settled) return; settled = true; try { if (sock) sock.destroy(); } catch (e) {} resolve(v); };
    try { sock = net.connect({ host: host || '127.0.0.1', port: port }); } catch (e) { return done(false); }
    sock.setTimeout(timeoutMs || 1500);
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.indexOf('SSH-') !== -1) done(true); });
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
    sock.on('close', () => done(false));
  });
}

// Does anything accept connections on host:port?
function portListening(port, timeoutMs, host) {
  return new Promise((resolve) => {
    let settled = false, sock = null;
    const done = (v) => { if (settled) return; settled = true; try { if (sock) sock.destroy(); } catch (e) {} resolve(v); };
    try { sock = net.connect({ host: host || '127.0.0.1', port: port }); } catch (e) { return done(false); }
    sock.setTimeout(timeoutMs || 1200);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// formatting, names, quoting, numbers
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

// Turn arbitrary text into a file-name-safe token (for DERIVED names, e.g. a
// container name from an image). Missing values give '' so "no name" is
// detectable. User-chosen names are VALIDATED with vmNameError() instead.
function safeName(n) {
  if (n === undefined || n === null) return '';
  return String(n).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Windows refuses these as file names whatever the extension ("con.qcow2").
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;

// VM / template names: they become file names on every OS and the guest
// hostname, so keep them short and plain. Returns null when valid, else why.
function vmNameError(name) {
  if (name === undefined || name === null || name === '') return 'a name is required';
  if (typeof name !== 'string') return 'the name must be text';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)) {
    return 'use 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit (got "' + name.slice(0, 80) + '")';
  }
  if (WIN_DEVICE.test(name.split('.')[0])) return '"' + name + '" is a reserved device name on Windows';
  if (/\.$/.test(name)) return 'the name cannot end with "."';
  return null;
}
const isVmName = (n) => vmNameError(n) === null;

// Guest-side identifiers (spec section 8).
const isContainerName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s);
const isImageRef = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(s);
const isComposeProject = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(s);

// Single-quote a value for a POSIX shell (the guest's /bin/sh).
const shq = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";

// Strict integer parse: numbers that are integers, or strings of digits.
// Anything else (NaN, '12abc', 1.5, true) is null - never NaN.
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d{1,15}\s*$/.test(v)) return parseInt(v, 10);
  return null;
}
// Lenient: out-of-range values are clamped, garbage gives the default.
function clampInt(v, min, max, def) {
  const n = toInt(v);
  if (n === null) return def;
  return Math.min(max, Math.max(min, n));
}
// Validating: undefined gives the default, anything invalid is a 400.
function intInRange(v, min, max, def, label) {
  if (v === undefined || v === null || v === '') return def;
  const n = toInt(v);
  if (n === null || n < min || n > max) throw badRequest(label + ' must be a whole number between ' + min + ' and ' + max);
  return n;
}
// Accept real booleans and the obvious strings; undefined gives the default.
function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
  if (v === 0 || v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  throw badRequest('expected true or false, got ' + JSON.stringify(v));
}
// A list given as an array or as text with one item per line (commas are kept:
// values like "JAVA_OPTS=-Xms1g,-Xmx2g" must survive, XTR-11).
function toList(v, label) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (typeof x !== 'string' && typeof x !== 'number') throw badRequest((label || 'list') + ' entries must be text');
      return String(x).trim();
    }).filter(Boolean);
  }
  if (typeof v !== 'string') throw badRequest((label || 'list') + ' must be an array or text with one entry per line');
  return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }

// Host paths that reach OTHER machines (sec-1). On Windows a UNC path
// (\\server\share, //server/share, \\?\UNC\server\share, \\host@SSL\x) or a
// device path other than a plain drive (\\.\pipe\x) makes Windows connect
// to that host over SMB or WebDAV the moment anything opens it - even a
// stat() - and hand it the user's NTLM credentials. Its text also never
// matches the manager's own folders (\\localhost\C$\...\data IS the data
// folder), so a lexical guard lets it through. Such paths are refused
// BEFORE any file-system call. Only the long-path forms of a local drive
// ("\\?\C:\..." and "\\.\C:\...") pass. Other systems: always null (a POSIX
// "//x" is just "/x"). -> the reason, or null. Pure.
function networkPathError(p, platformName) {
  if ((platformName || process.platform) !== 'win32') return null;
  const s = String(p === undefined || p === null ? '' : p);
  if (!/^[\\/]{2}/.test(s)) return null;
  if (/^[\\/]{2}[?.][\\/][A-Za-z]:([\\/]|$)/.test(s)) return null;
  return 'network and UNC paths such as ' + s.slice(0, 80) + ' cannot be used - only folders on this PC\'s own drives ' +
    '(opening one would connect to another computer and send it your Windows sign-in)';
}

// Write via <file>.tmp + fsync + rename, so a crash or power loss leaves the
// old file or the new one, never a truncated mix (BUG-4). Windows can refuse
// the rename for a moment while antivirus or an indexer holds the target, so
// retry briefly before giving up.
// opts.tmpDir: write the temp file THERE and rename it into place. A file
// renamed within one drive keeps the permissions it was created with, so a
// temp file made in a private folder (<root>/run, locked to this user)
// gives the target that folder's private ACL on every write, without an
// icacls call per save (sec-5: vms.json and containers.json hold secrets).
// Falls back to a temp file next to the target when the rename cannot
// cross (another drive).
function atomicWriteFileSync(file, data, mode, opts) {
  const dir = opts && opts.tmpDir;
  let tmp = dir ? path.join(dir, path.basename(file) + '.' + process.pid + '.tmp') : file + '.tmp';
  const writeTmp = () => {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  try { writeTmp(); }
  catch (e) {
    if (!dir) throw e;
    tmp = file + '.tmp';
    writeTmp();
  }
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      lastErr = e;
      if (e.code === 'EXDEV' && tmp !== file + '.tmp') {
        try { fs.unlinkSync(tmp); } catch (x) { /* gone */ }
        return atomicWriteFileSync(file, data, mode);
      }
      if (!/^(EPERM|EACCES|EBUSY)$/.test(e.code)) break;
      sleepSync(40 * (i + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch (e) {}
  throw lastErr;
}

// Read only the END of a (possibly huge) log: at most maxBytes from the end,
// then the last `lines` lines. A guest can write to its serial port as fast as
// it likes, so reading the whole file on every poll would freeze the manager
// (SEC-11). Never throws; a missing file gives exists:false.
function tailFile(file, opts) {
  opts = opts || {};
  const maxBytes = Math.max(1024, opts.maxBytes || 256 * 1024);
  const lines = clampInt(opts.lines, 1, 5000, 300);
  let fd = null;
  try {
    const st = fs.statSync(file);
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString('utf8');
    // starting mid-file: the first line is probably partial, drop it
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
    // opts.exact: the bytes as written (a program's own output: CRs and the
    // final newline kept, so `echo hi` reads back as "hi\n", like exec)
    let all = (opts.exact ? text : text.replace(/\r\n/g, '\n')).split('\n');
    const eol = all.length > 1 && all[all.length - 1] === '';
    if (all.length && all[all.length - 1] === '') all.pop();
    const truncated = start > 0 || all.length > lines;
    all = all.slice(-lines);
    const out = all.join('\n') + (opts.exact && eol && all.length ? '\n' : '');
    return { exists: true, text: out, lineCount: all.length, size: size, truncated: truncated };
  } catch (e) {
    return { exists: false, text: '', lineCount: 0, size: 0, truncated: false, error: e.code === 'ENOENT' ? null : errMsg(e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

// Append to a log that is capped at ~maxBytes: when full, the current file
// becomes <file>.1 (replacing the previous one), so a log never exceeds about
// twice the cap on disk (spec section 2: ~5 MB x 2).
function appendRotating(file, text, maxBytes) {
  const cap = maxBytes || 5 * 1024 * 1024;
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { /* new file */ }
    if (size > 0 && size + Buffer.byteLength(text) > cap) {
      try { fs.rmSync(file + '.1', { force: true }); } catch (e) {}
      try { fs.renameSync(file, file + '.1'); } catch (e) {}
    }
    fs.appendFileSync(file, text);
  } catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text); } catch (e2) {}
    }
  }
}

// ---------------------------------------------------------------------------
// manager log: console + <root>/logs/manager.log once the entry point sets it
// ---------------------------------------------------------------------------
let logFile = null;
let logToConsole = true;
function setLogFile(f, toConsole) {
  logFile = f || null;
  if (toConsole !== undefined) logToConsole = !!toConsole;
}
function stamp() { const d = new Date(); return d.toISOString().replace('T', ' ').slice(0, 19); }
function log(msg) {
  const text = String(msg);
  if (logToConsole) console.log('  ' + text);
  if (logFile) appendRotating(logFile, stamp() + ' ' + text + '\n');
}
function logError(msg, err) {
  const text = String(msg) + (err ? ': ' + (err.stack || errMsg(err)) : '');
  if (logToConsole) console.error('  ' + text);
  if (logFile) appendRotating(logFile, stamp() + ' ERROR ' + text + '\n');
}

module.exports = {
  exists, sizeOf, nowIso, sleep, sleepSync,
  ApiError, badRequest, notFound, conflict, notImplemented, errMsg,
  run, runSync, OutputCapture,
  probeSsh, portListening,
  fmtBytes, safeName, vmNameError, isVmName, isContainerName, isImageRef, isComposeProject, shq,
  toInt, clampInt, intInRange, toBool, toList,
  atomicWriteFileSync, networkPathError, tailFile, appendRotating,
  setLogFile, log, logError,
};
