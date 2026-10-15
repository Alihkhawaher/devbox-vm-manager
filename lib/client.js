'use strict';
/*
 * Minimal client for the manager's HTTP API, used by the MCP server
 * (mcp-server.js) and tools/. It finds the running manager for a data root
 * through <root>/run/manager.json, authenticates with <root>/manager-token,
 * and starts a headless manager when none is running.
 *
 *   const client = require('./client');
 *   const c = await client.connect({ root, start: true });  // finds or starts
 *   const s = await c.get('/api/state');
 *   const { task } = await c.post('/api/vm/start', { name: 'web' });
 *   const done = await client.waitForTask(c, task.id, { timeoutMs: 300000 });
 *
 * Errors from the API reject with an Error carrying .status, .code and .body
 * (the manager's {ok:false, error, code}). Network failures carry .code
 * 'ECONNREFUSED' etc. and .status undefined.
 *
 * Never prints anything: the MCP server's stdout is reserved for protocol.
 *
 * Why a manager is STARTED rather than the VMs being driven from here: the
 * manager owns the registry, the locks and the task history, and it must
 * outlive the MCP server (a host restarts MCP servers freely; VMs and running
 * tasks must not notice). So it is spawned detached, with no window, and its
 * console output goes to <root>/logs/manager-console.log.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { CFG, APP_DIR, APP_NAME, rootId, pingProof } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONSOLE_LOG_CAP = 2 * 1024 * 1024;

function managerFile(root) { return path.join(root || CFG.root, 'run', 'manager.json'); }
function tokenFile(root) { return path.join(root || CFG.root, 'manager-token'); }
function consoleLogFile(root) { return path.join(root || CFG.root, 'logs', 'manager-console.log'); }

// {pid, port, url, startedAt, version, root} or null
function readManagerInfo(root) {
  try {
    const j = JSON.parse(fs.readFileSync(managerFile(root), 'utf8'));
    return j && Number.isInteger(j.port) && j.port >= 1 && j.port <= 65535 ? j : null;
  } catch (e) { return null; }
}
function readToken(root) {
  try {
    const t = fs.readFileSync(tokenFile(root), 'utf8').trim();
    return /^[0-9a-f]{32,128}$/i.test(t) ? t : null;
  } catch (e) { return null; }
}

// The last few lines of the headless manager's console output, for error
// messages ("the manager did not start: <why>").
function consoleTail(root, lines) {
  try {
    const f = consoleLogFile(root);
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    try {
      const len = Math.min(size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return redactToken(buf.toString('utf8')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-(lines || 6)).join('\n');
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}
// These lines end up in MCP tool errors (and so in Claude's transcript):
// never with an access token in them. Older managers printed the full link.
function redactToken(text) { return String(text || '').replace(/([#?&]token=)[0-9a-f]{16,}/gi, '$1<hidden - see the manager-token file>'); }

// GETs reuse connections: a long wait polls /api/task every 1.5 s, and one
// connection per poll leaves thousands of TIME_WAIT sockets behind on
// Windows. Idle keep-alive sockets are unref'd by Node, so they never keep
// the process alive. POSTs use a fresh connection: they are not retried.
let getAgent = null;
function agentFor(method) {
  if (method !== 'GET') return false;
  if (!getAgent) getAgent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 1000 });
  return getAgent;
}

// One HTTP request to 127.0.0.1:port. Resolves {status, body (parsed JSON or
// null), text}; rejects only on network errors / timeout. A GET that fails
// because the server had just closed the reused idle connection is retried
// once on a new one.
function request(port, method, p, opts) {
  return requestOnce(port, method, p, opts || {}).catch((e) => {
    if (method === 'GET' && e && e.reusedSocket && /ECONNRESET|EPIPE/.test(String(e.code))) return requestOnce(port, method, p, opts || {});
    throw e;
  });
}
function requestOnce(port, method, p, opts) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    let payload = null;
    if (opts.token) headers['X-DevBox-Token'] = opts.token;
    if (method === 'POST') {
      payload = Buffer.from(JSON.stringify(opts.body === undefined ? {} : opts.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers, agent: agentFor(method) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        resolve({ status: res.statusCode, body: body, text: text });
      });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs || 30000, () => {
      const e = new Error('the manager did not answer ' + method + ' ' + p + ' within ' + Math.round((opts.timeoutMs || 30000) / 1000) + ' s');
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    });
    req.on('error', (e) => { if (e && req.reusedSocket) e.reusedSocket = true; reject(e); });
    req.end(payload || undefined);
  });
}

// GET /api/ping on a port: the ping body when it is a devbox manager, else
// null. With a token, the body also says `verified`: the manager proved it
// knows that token (HMAC over a fresh nonce and THIS port - config.pingProof).
// /api/ping is public, so anything can answer "I am devbox-vm-manager for
// your data folder" (a stale run/manager.json, another program on a port of
// the fallback scan); only a verified one gets the token (security-8).
async function ping(port, timeoutMs, token) {
  try {
    const nonce = token ? crypto.randomBytes(16).toString('hex') : null;
    const r = await request(port, 'GET', '/api/ping' + (nonce ? '?nonce=' + nonce : ''), { timeoutMs: timeoutMs || 2000 });
    if (!(r.status === 200 && r.body && r.body.app === APP_NAME)) return null;
    const body = Object.assign({}, r.body, { verified: false });
    if (nonce && typeof r.body.proof === 'string') {
      const want = Buffer.from(pingProof(token, nonce, port), 'hex');
      const got = Buffer.from(r.body.proof, 'hex');
      body.verified = got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    return body;
  } catch (e) { return null; }
}

// The running manager for this data root: {port, url, pid, version} or null.
// It must answer with this root's rootId AND prove it knows this root's
// token (when there is a token file; without one no manager has ever run).
// opts.port: also try this port when run/manager.json is missing or stale
// (a manager of an older build, or one whose file was deleted by hand).
// opts.token: the token to check against (default: the root's token file).
async function findManager(root, opts) {
  root = root || CFG.root;
  opts = opts || {};
  const want = rootId(root);
  const token = opts.token || readToken(root);
  const ours = (p) => !!p && p.rootId === want && (!token || p.verified);
  const info = readManagerInfo(root);
  if (info) {
    const p = await ping(info.port, 2000, token);
    if (ours(p)) return { port: info.port, url: 'http://127.0.0.1:' + info.port + '/', pid: info.pid, version: p.version };
  }
  if (opts.port && (!info || info.port !== opts.port)) {
    const p = await ping(opts.port, 1500, token);
    if (ours(p)) return { port: opts.port, url: 'http://127.0.0.1:' + opts.port + '/', pid: null, version: p.version };
  }
  return null;
}

function apiError(r, method, p) {
  const b = r.body || {};
  const e = new Error(b.error || ('HTTP ' + r.status + ' from ' + method + ' ' + p + (r.text ? ': ' + r.text.slice(0, 200) : '')));
  e.status = r.status;
  e.code = b.code || null;
  e.body = b;
  return e;
}

// A client bound to one manager. opts: {port, token, root, pid, version, started}
function createClient(opts) {
  const root = opts.root || CFG.root;
  const port = opts.port;
  const call = async (method, p, body, timeoutMs) => {
    // read the token per call: it survives manager restarts, but a user may
    // delete the file to rotate it
    const token = opts.token || readToken(root);
    const r = await request(port, method, p, { token: token, body: body, timeoutMs: timeoutMs });
    if (r.status < 200 || r.status >= 300 || !r.body || r.body.ok === false) throw apiError(r, method, p);
    return r.body;
  };
  return {
    root: root,
    port: port,
    url: 'http://127.0.0.1:' + port + '/',
    pid: opts.pid || null,
    version: opts.version || null,
    started: !!opts.started,   // true when connect() had to start this manager
    get: (p, timeoutMs) => call('GET', p, undefined, timeoutMs),
    post: (p, body, timeoutMs) => call('POST', p, body, timeoutMs),
    ping: () => ping(port, 2000, opts.token || readToken(root)),
  };
}

// Start a manager with no browser, detached from this process, its console
// output appended to <root>/logs/manager-console.log (rotated at ~2 MB).
// Returns {pid, child}.
// The root goes in through VM_MANAGER_ROOT (not --data) so the manager
// behaves exactly as when the user starts it (e.g. the one-time move of an
// old vms.json still happens). VM_MANAGER_PORT, if set, passes through too.
function startManager(root, opts) {
  root = root || CFG.root;
  opts = opts || {};
  const logFile = consoleLogFile(root);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    if (fs.statSync(logFile).size > CONSOLE_LOG_CAP) {
      fs.rmSync(logFile + '.1', { force: true });
      fs.renameSync(logFile, logFile + '.1');
    }
  } catch (e) { /* no log yet */ }
  const isNew = !fs.existsSync(logFile);
  const fd = fs.openSync(logFile, 'a', 0o600);
  // a manager's console output may hold paths and errors worth keeping to
  // this user (older managers even printed the access token here)
  if (isNew) { try { require('./platform').protectPrivateFile(logFile); } catch (e) { /* best effort */ } }
  try {
    fs.writeSync(fd, '\n=== ' + new Date().toISOString() + ' started headless by pid ' + process.pid + ' ===\n');
    const env = Object.assign({}, process.env, { VM_MANAGER_ROOT: root }, opts.env || {});
    const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js'), '--no-open'], {
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: APP_DIR, env: env,
    });
    child.on('error', () => { /* reported through the wait loop */ });
    child.unref();
    return { pid: child.pid, child: child };
  } finally { fs.closeSync(fd); }
}

// One start at a time per data root inside this process: two tool calls
// arriving together must not spawn two managers.
const starting = new Map();

async function startAndWait(root, opts) {
  const timeoutMs = opts.timeoutMs || 20000;
  const hint = opts.port;
  const { child } = startManager(root, opts);
  let exited = null, spawnError = null;
  child.on('exit', (code) => { exited = { code: code }; });
  child.on('error', (e) => { spawnError = e; });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(300);
    const m = await findManager(root, { port: hint });
    if (m) return m;
    if (spawnError) throw new Error('could not start the VM manager (' + process.execPath + '): ' + spawnError.message);
    // exit code 0 = it found a copy already serving this folder and handed
    // over; keep polling for that one. Anything else is a real failure.
    if (exited && exited.code !== 0) {
      await sleep(200);
      const why = consoleTail(root, 8);
      throw new Error('the VM manager stopped right after starting (exit code ' + exited.code + ')' +
        (why ? ':\n' + why : '') + '\nFull output: ' + consoleLogFile(root));
    }
  }
  const why = consoleTail(root, 6);
  throw new Error('the VM manager did not start within ' + Math.round(timeoutMs / 1000) + ' s' +
    (why ? '. Its last output:\n' + why : '') + '\nFull output: ' + consoleLogFile(root));
}

// Find the manager for `root`, or (start !== false) start one headless and
// wait up to timeoutMs (20 s) for it to answer. Resolves a client.
//   opts: {root, start, timeoutMs, token, port (hint; defaults to the
//          configured port when root is this process's data root), env}
async function connect(opts) {
  opts = opts || {};
  const root = opts.root || CFG.root;
  const hint = opts.port || (rootId(root) === rootId(CFG.root) ? CFG.serverPort : null);
  let m = await findManager(root, { port: hint });
  let started = false;
  if (!m && opts.start !== false) {
    const key = rootId(root);           // one folder, whatever name (junction) it is reached by
    let p = starting.get(key);
    if (!p) {
      p = startAndWait(root, Object.assign({}, opts, { port: hint })).finally(() => starting.delete(key));
      starting.set(key, p);
    }
    m = await p;
    started = true;
  }
  if (!m) throw new Error('the VM manager is not running for ' + root);
  return createClient({ root: root, port: m.port, token: opts.token, pid: m.pid, version: m.version, started: started });
}

// Poll GET /api/task until the task ends or timeoutMs passes. Resolves the
// full task (with its log); if it is still running at the deadline, resolves
// it anyway with status 'running' (the caller decides what to tell the user).
// A few transient network errors are tolerated (the manager may be busy);
// a 404 means the manager restarted and forgot the task: rejects with
// .code 'TASK_GONE'.
async function waitForTask(client, id, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const every = opts.pollMs || 1500;
  const limit = opts.timeoutMs === undefined ? 300000 : opts.timeoutMs;
  let failures = 0;
  let last = null;
  for (;;) {
    let task = null;
    try {
      const r = await client.get('/api/task?id=' + encodeURIComponent(id));
      task = r.task;
      failures = 0;
    } catch (e) {
      if (e.status === 404) {
        const gone = new Error('task ' + id + ' is no longer known to the manager (it restarted, or the task is older than the last 50)');
        gone.code = 'TASK_GONE';
        throw gone;
      }
      if (e.status || ++failures > 5) throw e;
      task = null;
    }
    if (task) {
      last = task;
      if (opts.onUpdate) { try { opts.onUpdate(task); } catch (e) { /* observer errors are not ours */ } }
      if (task.status !== 'running') return task;
    }
    if (Date.now() - t0 >= limit) return last || { id: id, status: 'running', step: null, log: [] };
    await sleep(Math.max(10, Math.min(every, limit - (Date.now() - t0))));
  }
}

module.exports = {
  readManagerInfo, readToken, consoleTail, redactToken, consoleLogFile, managerFile, tokenFile,
  request, ping, findManager, createClient, startManager, connect, waitForTask,
};
