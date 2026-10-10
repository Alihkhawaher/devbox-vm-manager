'use strict';
/*
 * In-browser terminal sessions (spec section 10).
 *
 * Two kinds, both bridged to the browser the same way (output as Server-Sent
 * Events, input as POST); the VM is never affected by a session ending:
 *
 *  - ssh: the system ssh client with a pty (ssh -tt). The remote command
 *    reports the pty's name (an OSC escape the manager strips from the
 *    output), applies the initial size and execs a login shell. Resizing runs
 *    `stty -F <pty> cols C rows R` over a separate SSH call; the kernel then
 *    sends SIGWINCH to whatever runs in the terminal.
 *    An appliance VM (lib/appliance.js) runs its OWN SSH server: the session
 *    logs in with the guest's account (body.user, default the VM's sshUser)
 *    and a password typed in the GUI (body.password), handed to ssh through
 *    SSH_ASKPASS (lib/ssh.js askpassEnv) - kept in memory only while the
 *    session lives (resizes log in again), never written to the state or a log.
 *  - serial: the VM's serial console socket (the QEMU chardev on a random
 *    private 127.x.y.z or a unix socket - never reachable from guests). This is the passwordless
 *    root console that works while the guest boots or when SSH/network is
 *    broken (XTR-2); it replaces v1's "boot console window" + Git Bash path
 *    (BUG-7). QEMU serves one client at a time, so opening a serial session
 *    closes the previous one of that VM.
 *
 * Rules (SEC-9, BUG-13, MNT-9):
 * - ids are random UUIDs (not guessable); at most 16 live sessions.
 * - output is buffered (last 200 KB) with a running offset n, so a browser
 *   that reconnects with ?since=<n> gets only what it missed.
 * - a session nobody has watched for 60 s is closed (kills ssh / closes the
 *   socket), all sessions of a VM close when it stops, all close on manager
 *   shutdown.
 * - every stream has an 'error' listener: a keystroke racing a dying ssh must
 *   never crash the manager (BUG-14).
 *
 * Exported for http.js:
 *   open(body) -> {id, kind, command}     input(body) -> {}
 *   resize(body) -> {applied}             close(body) -> {closed}
 *   stream(req, res, {id, since})
 * and closeSession(id), closeVmSessions(name), closeAllSessions(), shutdown(),
 * listSessions().
 */
const crypto = require('crypto');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const platform = require('./platform');
const ssh = require('./ssh');
const st = require('./state');
const vmMod = require('./vm');
const { badRequest, notFound, conflict, errMsg, clampInt, tailFile, probeSsh } = require('./util');

const MAX_SESSIONS = 16;
const BUF_MAX = 200000;       // characters of output kept for replay
const IDLE_MS = 60000;        // no SSE client for this long -> close
const KEEP_CLOSED_MS = 30000; // a finished session is kept briefly so a reconnect sees {exit}
const PTY_WAIT_MS = 4000;     // how long output may be held back while looking for the pty name

const sessions = new Map();
let reaper = null;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
// The remote command of an ssh session: report the pty (OSC 777, ignored by
// terminals if it ever got through), set the size, show the motd (sshd skips
// it when a command is given), then become a login shell. A guest without
// stty (LibreELEC's busybox has none) gets the size as COLUMNS/LINES, which
// busybox programs read when the pty reports none.
function sshRemoteCommand(cols, rows) {
  return "printf '\\033]777;devbox-pty;%s\\007' \"$(tty)\"; stty cols " + cols + ' rows ' + rows +
    ' 2>/dev/null || export COLUMNS=' + cols + ' LINES=' + rows + '; [ -r /etc/motd ] && cat /etc/motd; exec "${SHELL:-/bin/sh}" -l';
}

// eslint-disable-next-line no-control-regex
const PTY_MARK_RE = /\x1b\]777;devbox-pty;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
// Find and remove the pty marker. Returns {pty, rest} (pty null when the
// reported name is not a plain tty path) or null when there is no marker. Pure.
function extractPtyMarker(text) {
  const m = String(text).match(PTY_MARK_RE);
  if (!m) return null;
  const name = m[1].trim();
  return {
    pty: /^\/dev\/(pts\/\d+|tty[A-Za-z0-9]+)$/.test(name) ? name : null,
    rest: text.slice(0, m.index) + text.slice(m.index + m[0].length),
  };
}

function sizeOf(body, key, def, min, max) { return clampInt(body[key], min, max, def); }

// ---------------------------------------------------------------------------
// output buffer + SSE
// ---------------------------------------------------------------------------
function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.closed && now - s.closedAt > KEEP_CLOSED_MS) sessions.delete(s.id);
      else if (!s.closed && !s.res && now - s.lastSeen > IDLE_MS) closeSession(s.id);
    }
    if (!sessions.size) { clearInterval(reaper); reaper = null; }
  }, 10000);
  reaper.unref();
}

function sseWrite(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); return true; } catch (e) { return false; }
}

function push(sess, text) {
  if (!text) return;
  sess.buf += text;
  sess.total += text.length;
  if (sess.buf.length > BUF_MAX) {
    const cut = sess.buf.length - BUF_MAX;
    sess.buf = sess.buf.slice(cut);
    sess.bufStart += cut;
  }
  if (sess.res) queueSse(sess, text);
}

// Output is sent in small batches, not as it arrives: the serial console
// delivers the guest's UART output a byte or two at a time, and one SSE event
// per read turned a 28 KB boot log into ~23 000 events (~560 KB of JSON, and
// as many terminal writes in the browser). A batch leaves after SSE_BATCH_MS
// or once it is SSE_BATCH_MAX characters long; `n` stays the running offset.
const SSE_BATCH_MS = 20;
const SSE_BATCH_MAX = 16384;
function queueSse(sess, text) {
  sess.out += text;
  if (sess.out.length >= SSE_BATCH_MAX) return flushSse(sess);
  if (!sess.outTimer) sess.outTimer = setTimeout(() => flushSse(sess), SSE_BATCH_MS);
}
function flushSse(sess) {
  clearTimeout(sess.outTimer);
  sess.outTimer = null;
  const t = sess.out;
  sess.out = '';
  if (t && sess.res) sseWrite(sess.res, { t: t, n: sess.total });
}
// A viewer (re)connected or left: whatever was queued for the old one is
// covered by the replay from `since`, so it must not be sent again.
function dropQueued(sess) {
  clearTimeout(sess.outTimer);
  sess.outTimer = null;
  sess.out = '';
}

function finish(sess, code) {
  if (sess.closed) return;
  flushPending(sess);
  flushSse(sess);
  sess.closed = true;
  sess.closedAt = Date.now();
  sess.exitCode = code;
  clearTimeout(sess.ptyTimer);
  if (sess.res) {
    sseWrite(sess.res, { exit: code, n: sess.total });
    try { sess.res.end(); } catch (e) {}
    sess.res = null;
  }
}

// ssh stdout: hold output back until the pty marker was seen (it is the very
// first thing the remote command prints), then pass everything through.
function onSshOut(sess, text) {
  if (sess.ptyKnown) return push(sess, text);
  sess.pending += text;
  const m = extractPtyMarker(sess.pending);
  if (m) {
    sess.pending = '';
    sess.ptyKnown = true;
    sess.pty = m.pty;
    clearTimeout(sess.ptyTimer);
    push(sess, m.rest);
    if (sess.pty && sess.wantSize) applyResize(sess);
    return;
  }
  if (sess.pending.length > 16384) flushPending(sess);
}
function flushPending(sess) {
  if (sess.ptyKnown) return;
  sess.ptyKnown = true;
  clearTimeout(sess.ptyTimer);
  const p = sess.pending;
  sess.pending = '';
  push(sess, p);
}

function newSession(name, kind, user, cols, rows) {
  return {
    id: crypto.randomUUID(), name: name, kind: kind, user: user, child: null, sock: null, res: null,
    buf: '', bufStart: 0, total: 0, out: '', outTimer: null, closed: false, closedAt: 0, exitCode: null, lastSeen: Date.now(),
    pty: null, ptyKnown: kind !== 'ssh', pending: '', ptyTimer: null,
    wantSize: { cols: cols, rows: rows }, resizing: false, createdAt: Date.now(),
  };
}

function liveCount() { return Array.from(sessions.values()).filter((s) => !s.closed).length; }

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------
// POST /api/session/open {name (or vm), kind, user?, cols?, rows?, replace?}
async function open(body) {
  body = body || {};
  const name = vmMod.requireVmName(body.name !== undefined ? body.name : body.vm);
  const kind = body.kind === undefined || body.kind === null || body.kind === '' ? 'ssh' : body.kind;
  if (kind !== 'ssh' && kind !== 'serial') throw badRequest('kind must be "ssh" or "serial"');
  const vm = st.getVm(name);
  const appl = vm.kind === 'appliance';
  let user;
  if (appl) {
    // the guest's own account
    user = body.user === undefined || body.user === null || body.user === '' ? ((vm.appliance && vm.appliance.sshUser) || 'root') : body.user;
    if (typeof user !== 'string' || !st.SSH_USER_RE.test(user)) throw badRequest('user must be a plain user name (letters, digits, "_", "-", ".")');
  } else {
    user = body.user === undefined || body.user === null || body.user === '' || body.user === 'root' ? 'root' : body.user;
    if (user !== 'root' && user !== 'dev') throw badRequest('user must be "root" or "dev"');
  }
  let password = null;
  if (body.password !== undefined && body.password !== null && body.password !== '') {
    if (!appl) throw badRequest('a password is only used for appliance VMs (the others trust the manager\'s key)');
    if (typeof body.password !== 'string' || body.password.length > 1024 || /[\r\n\0]/.test(body.password)) throw badRequest('password must be one line of text');
    password = body.password;
  }
  const cols = sizeOf(body, 'cols', 120, 20, 1000);
  const rows = sizeOf(body, 'rows', 32, 5, 500);
  if (body.replace !== undefined && body.replace !== null && body.replace !== '') {
    if (typeof body.replace !== 'string') throw badRequest('replace must be a session id');
    closeSession(body.replace);
  }
  if (liveCount() >= MAX_SESSIONS) throw conflict('too many open terminal sessions (' + MAX_SESSIONS + ') - close some first', 'TOO_MANY_SESSIONS');
  return kind === 'serial' ? openSerial(name, cols, rows) : openSsh(name, user, cols, rows, password);
}

async function openSsh(name, user, cols, rows, password) {
  const vm = await vmMod.requireSshReady(name);
  const bin = platform.findTool('ssh');
  if (!bin) throw conflict('the OpenSSH client (ssh) was not found - ' + platform.installHints().ssh, 'PREREQ_MISSING');
  const appl = vm.kind === 'appliance';
  const sess = newSession(name, 'ssh', user, cols, rows);
  const target = { name: name, port: vm.port };
  const remote = sshRemoteCommand(cols, rows);
  const args = appl ? ssh.guestArgs(target, { user: user, password: !!password, tty: true, cmd: remote }) : ssh.sshArgs(target, { user: user, tty: true, cmd: remote });
  const ap = appl && password ? ssh.askpassEnv(password) : null;
  let child;
  try {
    child = spawn(bin, args, {
      windowsHide: true,
      // the pty request carries the client's TERM; ssh.exe spawned without a
      // console would otherwise send something xterm.js does not match
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }, ap ? ap.env : {}),
    });
  } catch (e) {
    if (ap) ap.cleanup();
    throw new Error('could not start ssh: ' + errMsg(e));
  }
  if (ap) child.on('exit', () => ap.cleanup());
  // an appliance session keeps the password for its resizes (in memory only)
  if (appl) Object.defineProperty(sess, 'guest', { value: { password: password }, enumerable: false });
  sess.child = child;
  sess.wantSize = null; // applied by the remote command
  sessions.set(sess.id, sess);
  startReaper();
  sess.ptyTimer = setTimeout(() => flushPending(sess), PTY_WAIT_MS);
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  child.stdout.on('data', (d) => onSshOut(sess, out.write(d)));
  child.stderr.on('data', (d) => push(sess, err.write(d)));
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdin.on('error', () => push(sess, '\r\n[manager] the connection to the VM closed\r\n'));
  child.on('error', (e) => { push(sess, '\r\n[manager] could not start ssh: ' + errMsg(e) + '\r\n'); finish(sess, 255); });
  child.on('exit', (code) => finish(sess, code === null ? 0 : code));
  return { id: sess.id, kind: 'ssh', command: appl ? ssh.guestCommandText(vm.port, user) : ssh.sshCommandText(vm.port, user) };
}

function connectSocket(ep, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false, sock = null;
    const end = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) { try { if (sock) sock.destroy(); } catch (x) {} reject(e); } else resolve(sock);
    };
    const timer = setTimeout(() => end(new Error('timed out')), timeoutMs || 4000);
    try { sock = ep.path ? net.connect({ path: ep.path }) : net.connect({ host: ep.host, port: ep.port }); }
    catch (e) { return end(e); }
    sock.once('connect', () => end(null));
    sock.once('error', (e) => end(e));
  });
}

async function openSerial(name, cols, rows) {
  const vm = st.getVm(name);
  if (!(await vmMod.isRunning(name))) throw conflict('"' + name + '" is not running - start it first', 'NOT_RUNNING');
  const ep = vm.runtime && vm.runtime.serial;
  if (!ep || vm.runtime.legacy) {
    throw conflict('"' + name + '" was started by an older version of the manager, which had no serial console socket - restart it once', 'NO_SERIAL');
  }
  // one client at a time: this replaces any other serial session of the VM
  for (const s of Array.from(sessions.values())) if (s.name === name && s.kind === 'serial') closeSession(s.id);
  let sock;
  try { sock = await connectSocket(ep, 4000); }
  catch (e) { throw conflict('cannot connect to the serial console of "' + name + '": ' + errMsg(e), 'NO_SERIAL'); }
  const sess = newSession(name, 'serial', 'root', cols, rows);
  sess.sock = sock;
  sessions.set(sess.id, sess);
  startReaper();
  // what the console printed before we attached (QEMU keeps a log of it)
  const prev = tailFile(st.serialLogPath(name), { lines: 40, maxBytes: 64 * 1024 }).text;
  if (prev.trim()) push(sess, prev.replace(/\r?\n/g, '\r\n') + '\r\n');
  push(sess, '\r\n[manager] connected to the serial console of "' + name + '" - press Enter for a prompt\r\n');
  const dec = new StringDecoder('utf8');
  sock.on('data', (d) => push(sess, dec.write(d)));
  sock.on('error', (e) => push(sess, '\r\n[manager] serial console error: ' + errMsg(e) + '\r\n'));
  sock.on('close', () => { push(sess, '\r\n[manager] the serial console closed (the VM stopped?)\r\n'); finish(sess, 0); });
  applyResize(sess);
  return { id: sess.id, kind: 'serial', command: null };
}

// ---------------------------------------------------------------------------
// input / resize / close
// ---------------------------------------------------------------------------
// Type into a session. Returns false when there is no such (live) session.
function writeInput(id, data) {
  const s = sessions.get(id);
  if (!s || s.closed) return false;
  const text = String(data === undefined || data === null ? '' : data);
  try {
    if (s.kind === 'serial') { if (!s.sock) return false; s.sock.write(text); }
    else { if (!s.child) return false; s.child.stdin.write(text); }
  } catch (e) { /* the 'error' listeners report it */ }
  s.lastSeen = Date.now();
  return true;
}

// POST /api/session/input {id, data}
function input(body) {
  body = body || {};
  if (typeof body.id !== 'string' || !body.id) throw badRequest('id is required');
  if (typeof body.data !== 'string') throw badRequest('data must be text');
  if (body.data.length > 65536) throw badRequest('too much input at once (max 64 KB)');
  if (!writeInput(body.id, body.data)) throw notFound('terminal session not found (it may have ended)');
  return {};
}

// Apply the newest wanted size with one SSH call at a time; sizes requested
// meanwhile are coalesced into the next call.
async function applyResize(sess) {
  if (sess.resizing || sess.closed || !sess.wantSize) return;
  const dev = sess.kind === 'serial' ? '/dev/ttyS0' : sess.pty;
  if (!dev) return;
  const vm = st.state.vms[sess.name];
  if (!vm) return;
  const want = sess.wantSize;
  sess.wantSize = null;
  sess.resizing = true;
  try {
    // the serial console has no SSH of its own: resize through SSH when it is up
    if (sess.kind === 'serial' && !(await probeSsh(vm.port, 800))) return;
    const cmd = 'stty -F ' + dev + ' cols ' + want.cols + ' rows ' + want.rows;
    // an appliance guest: its own account again (the manager's key is not there)
    if (sess.guest) await ssh.sshExecGuest({ name: sess.name, port: vm.port }, cmd, { user: sess.user, password: sess.guest.password, timeoutMs: 15000 });
    else if (vm.kind !== 'appliance') await ssh.sshExec({ name: sess.name, port: vm.port }, cmd, { timeoutMs: 10000 });
    sess.size = want;
  } catch (e) { /* best effort */ }
  finally {
    sess.resizing = false;
    if (sess.wantSize && !sess.closed) applyResize(sess);
  }
}

// POST /api/session/resize {id, cols, rows}
function resize(body) {
  body = body || {};
  if (typeof body.id !== 'string' || !body.id) throw badRequest('id is required');
  const s = sessions.get(body.id);
  if (!s || s.closed) throw notFound('terminal session not found (it may have ended)');
  s.lastSeen = Date.now();
  s.wantSize = { cols: sizeOf(body, 'cols', 120, 20, 1000), rows: sizeOf(body, 'rows', 32, 5, 500) };
  if (s.kind === 'ssh' && !s.pty) return { applied: s.ptyKnown ? 'unsupported' : 'queued' };
  applyResize(s);
  return { applied: 'queued' };
}

// End one session (no-op when it is already gone).
function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  if (!s.closed) {
    if (s.child) {
      try { s.child.stdin.end(); } catch (e) {}
      try { s.child.kill(); } catch (e) {}
    }
    if (s.sock) { try { s.sock.destroy(); } catch (e) {} }
  }
  finish(s, s.exitCode === null ? 0 : s.exitCode);
  if (s.guest) s.guest.password = null;
  sessions.delete(id);
  return true;
}

// POST /api/session/close {id}
function close(body) {
  body = body || {};
  if (typeof body.id !== 'string' || !body.id) throw badRequest('id is required');
  return { closed: closeSession(body.id) };
}

function closeVmSessions(name) {
  for (const s of Array.from(sessions.values())) if (s.name === name) closeSession(s.id);
}

function closeAllSessions() {
  for (const s of Array.from(sessions.values())) closeSession(s.id);
}

// Live sessions (no output), for diagnostics.
function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id, name: s.name, kind: s.kind, user: s.user, closed: s.closed, watched: !!s.res,
    bytes: s.total, createdAt: new Date(s.createdAt).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// SSE: GET /api/session/stream?id=&since=
// ---------------------------------------------------------------------------
// One viewer at a time: a new stream replaces the previous one. Chunks are
// {t, n} (n = running offset after this chunk); {exit, n} at the end;
// comment pings every 15 s keep proxies and the browser from timing out.
function stream(req, res, params) {
  const id = String((params && params.id) || '');
  const sess = sessions.get(id);
  if (!sess) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'terminal session not found', code: 'NOT_FOUND' }));
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  if (sess.res && sess.res !== res) { try { sess.res.end(); } catch (e) {} }
  dropQueued(sess); // the replay below covers it
  let since = parseInt(params && params.since, 10);
  if (!(since >= 0)) since = 0;
  if (since < sess.total) {
    const from = Math.max(since, sess.bufStart) - sess.bufStart;
    const replay = sess.buf.slice(from);
    if (since < sess.bufStart && since > 0) sseWrite(res, { t: '\r\n[manager] some earlier output was dropped\r\n', n: sess.bufStart });
    if (replay) sseWrite(res, { t: replay, n: sess.total });
  }
  if (sess.closed) {
    sseWrite(res, { exit: sess.exitCode, n: sess.total });
    return res.end();
  }
  sess.res = res;
  sess.lastSeen = Date.now();
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  const done = () => {
    clearInterval(ping);
    if (sess.res === res) { sess.res = null; sess.lastSeen = Date.now(); dropQueued(sess); }
  };
  req.on('close', done);
  res.on('error', done);
}

function shutdown() { closeAllSessions(); }

module.exports = {
  open, input, resize, close, stream,
  writeInput, closeSession, closeVmSessions, closeAllSessions, listSessions, shutdown,
  sshRemoteCommand, extractPtyMarker,
  MAX_SESSIONS,
};
