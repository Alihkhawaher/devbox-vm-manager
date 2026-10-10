'use strict';
/*
 * HTTP API + static GUI files (spec sections 8 and 12).
 *
 * createServer() only builds the server; server.js decides where it listens
 * (always 127.0.0.1). Requiring this module has no side effects.
 *
 * SECURITY, applied to every request in this order:
 *   1. Host must be 127.0.0.1:<port>, localhost:<port> or [::1]:<port>
 *      (the port the request arrived on), else 403 - stops DNS rebinding (SEC-3).
 *   2. Origin, when present, must be http://(127.0.0.1|localhost|[::1]):<port>,
 *      else 403 - stops cross-site requests (SEC-2). A POST without Origin
 *      but with a cross-site Sec-Fetch-Site is refused too.
 *   3. /api/* (except GET /api/ping) needs the header X-DevBox-Token: <token>
 *      (compared in constant time), else 401 (SEC-1: VM guests reach the host
 *      loopback through 10.0.2.2, so the API must not trust "local").
 *      GET /api/session/stream may pass ?token= instead (EventSource cannot
 *      set headers).
 *   4. POST needs Content-Type application/json, else 415; the body is capped
 *      at 1 MB (413), must be a JSON object (400), is decoded once as UTF-8 and
 *      an aborted upload never leaves the request hanging (BUG-23).
 *   Every response carries nosniff, X-Frame-Options DENY, Referrer-Policy
 *   no-referrer and a strict CSP (no inline script/style anywhere, SEC-15).
 *   API responses are Cache-Control: no-store. No CORS headers, ever.
 *
 * STATIC: GET / /index.html /app.js /app.css /vendor/* ... - only files inside
 * public/ (resolved + prefix-checked), only known MIME types, else 404.
 *
 * ERRORS are always {ok:false, error, code} with: 400 bad input, 401 no/bad
 * token, 403 host/origin, 404 unknown route/VM/session/task, 405 wrong
 * method, 409 busy (lock) or conflicting state, 413 body too large,
 * 415 wrong content type, 501 not implemented yet, 500 unexpected.
 * Task-starting POSTs validate FIRST (bad input never starts a task), then
 * reply 202 {ok:true, task:{id, kind, title, vm, status, ...}}; follow it with
 * GET /api/task?id=.
 *
 * ROUTE TABLE  (route -> module.function; "task" routes call
 *               validate(body) then run(t, args) inside tasks.start)
 *   GET  /api/ping?nonce=          (public) -> {app, version, rootId, proof?}
 *   GET  /api/state                -> vm.listVms, vm.hostState, install.prereqs,
 *                                     install.accelHint, vm.listTemplates, tasks.overview,
 *                                     state.stateWarning, settings (state + config.engineSettings)
 *   GET  /api/network              -> vm.networkOverview()
 *   GET  /api/tasks                -> tasks.list()
 *   GET  /api/task?id=             -> tasks.get(id)   (no id: tasks.latest())
 *   GET  /api/log?name=&tail=      -> util.tailFile(serial log | @manager | @tasks | @bake)
 *   GET  /api/vm/docker?name=      -> docker.getDockerState(name)
 *   GET  /api/vm/docker/logs?name=&container=&tail= -> docker.getDockerLogs(q)
 *   GET  /api/about                -> version, data root, node, MCP config
 *   GET  /api/host/probe           -> hostprobe.read(), state(), keyNow()
 *   POST /api/host/probe     task  -> hostprobe.validateProbe / hostprobe.opProbe
 *   GET  /api/session/stream?id=&token=&since= -> sessions.stream(req, res, {id, since})
 *   GET  /api/vm/screenshot?name=  -> screen.screenshot(name) (image/png)
 *   GET  /api/vm/screen-text?name=&scale= -> screen.screenText(name) (OCR; 501 off Windows)
 *   GET  /api/vm/screen?name=&token= (Upgrade: websocket) -> screen.handleUpgrade: the
 *                                     live screen of an appliance VM, relayed to noVNC
 *   POST /api/vm/keys              -> screen.sendKeys(name, keys)
 *   POST /api/vm/create-appliance task -> appliance.validateCreate / appliance.opCreate
 *   POST /api/vm/eject       task  -> appliance.validateEject / appliance.opEject
 *   POST /api/settings             -> state.updateSettings (accel, defaultExpose) +
 *                                     config.updateEngineSettings (light profile, engine)
 *   POST /api/vm/settings          -> vm.updateSettings(body)
 *   POST /api/vm/ports             -> vm.setPorts(body)
 *   POST /api/vm/forget            -> vm.forgetVm(body)
 *   POST /api/session/open         -> sessions.open(body)
 *   POST /api/session/input        -> sessions.input(body)
 *   POST /api/session/resize       -> sessions.resize(body)
 *   POST /api/session/close        -> sessions.close(body)
 *   POST /api/setup          task  -> install.validateSetup / install.opSetup
 *   POST /api/install/qemu   task  -> install.validateInstallQemu / install.opInstallQemu
 *   POST /api/install/base   task  -> install.validateBuildBase / install.opBuildBase
 *   POST /api/vm/create      task  -> vm.validateCreate / vm.opCreate
 *   POST /api/vm/start       task  -> vm.validateStart / vm.opStart
 *   POST /api/vm/stop        task  -> vm.validateStop / vm.opStop
 *   POST /api/vm/restart     task  -> vm.validateRestart / vm.opRestart
 *   POST /api/vm/delete      task  -> vm.validateDelete / vm.opDelete
 *   POST /api/vm/reset       task  -> vm.validateReset / vm.opReset
 *   POST /api/vm/resize      task  -> vm.validateResize / vm.opResize
 *   POST /api/vm/growfs      task  -> vm.validateGrowFs / vm.opGrowFs
 *   POST /api/vm/compact     task  -> vm.validateCompact / vm.opCompact
 *   POST /api/vm/freeze      task  -> vm.validateFreeze / vm.opFreeze
 *   POST /api/vm/snapshot    task  -> vm.validateSnapshot / vm.opSnapshot
 *   POST /api/vm/docker/install task -> docker.validateDockerVm / docker.opDockerInstall
 *   POST /api/vm/docker/pull task  -> docker.validatePull / docker.opDockerPull
 *   POST /api/vm/docker/run  task  -> docker.validateRun / docker.opDockerRun
 *   POST /api/vm/docker/action task -> docker.validateAction / docker.opDockerAction
 *   POST /api/vm/docker/rmi  task  -> docker.validateRmi / docker.opDockerRmi
 *   POST /api/vm/compose     task  -> docker.validateCompose / docker.opCompose
 *   POST /api/vm/docker/inspect task -> docker.validateInspect / docker.opImageInspect
 *   POST /api/vm/docker/deploy task -> deploy.validateDeploy / deploy.opDeploy
 *   POST /api/vm/quickdeploy task  -> deploy.validateQuickDeploy / deploy.opQuickDeploy
 *   POST /api/install/kernel task  -> install.validateInstallKernel / install.opInstallKernel
 *   + microvm.ROUTES  (lib/microvm/routes.js: containers, images, volumes -
 *                      its header lists every route -> function)
 *   + shares.ROUTES   (lib/shares-routes.js: shared folders, folder browser)
 * Locks: every VM route takes 'vm:<name>'; freeze also 'template:<as>';
 * install/qemu 'global'+'qemu'; install/base 'global'+'template:devbox-base';
 * install/kernel 'kernel'; setup 'global'+'kernel'+'template:devbox-base'
 * ({only:'microvm'}: 'global'+'kernel'), plus 'qemu' only when it installs
 * QEMU. Container routes: 'ctr:<id>' / 'ctr-stop:<id>' (see routes.js).
 * Route objects and their helpers (taskRoute, accepted, ctx.q) are
 * documented in lib/route.js.
 * The Host check (1) stops DNS rebinding and ordinary requests from guests;
 * a guest can still send any Host header it likes to 10.0.2.2:<port>, so it
 * is the token (3) that keeps the guests out.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { CFG, version, rootId, readToken, pingProof } = config;
const platform = require('./platform');
const st = require('./state');
const tasks = require('./tasks');
const ports = require('./ports');
const vm = require('./vm');
const install = require('./install');
const sessions = require('./sessions');
const docker = require('./docker');
const deploy = require('./deploy');
const route = require('./route');
const containers = require('./microvm/containers');
const microvmRoutes = require('./microvm/routes');
const sharesRoutes = require('./shares-routes');
const appliance = require('./appliance');
const screen = require('./screen');
const hostprobe = require('./hostprobe');
const {
  exists, tailFile, clampInt, errMsg, logError, vmNameError, badRequest, notFound,
} = require('./util');

const BODY_LIMIT = 1024 * 1024;
// connect-src: 'self' plus the WebSocket form of this same origin (the VM
// screen relay, GET /api/vm/screen): browsers do not all count ws:// under
// 'self', so it is spelled out per port in securityHeaders()
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
  "connect-src 'self'%WS%; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function cspFor(port) {
  // (no ws://[::1]: Chrome rejects a bracketed IPv6 host in a CSP source list)
  const p = port ? ' ws://127.0.0.1:' + port + ' ws://localhost:' + port : '';
  return CSP.replace('%WS%', p);
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', cspFor(res.req && res.req.socket && res.req.socket.localPort));
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function send(res, status, body, type, cache) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': cache || 'no-store',
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : b);
}

function sendError(res, status, code, message, extra) {
  send(res, status, Object.assign({ ok: false, error: message, code: code }, extra || {}));
}

const DEFAULT_CODE = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 501: 'NOT_IMPLEMENTED' };

function errorResponse(res, e) {
  let status = e && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500;
  if (e && e.code === 'NOT_IMPLEMENTED') status = 501;
  const code = status === 500 ? 'INTERNAL' : ((e && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code)) ? e.code : (DEFAULT_CODE[status] || 'ERROR'));
  if (status === 500) logError('request failed', e);
  const extra = {};
  if (e && e.holder) extra.holder = e.holder;
  // machine-readable details some errors carry (spec microVM section 11):
  // the Docker-VM fallback offer, a hint, the setup action, rate-limit reset
  if (status !== 500 && e) {
    for (const k of ['fallback', 'hint', 'action', 'rateLimit', 'conflict']) {
      if (e[k] !== undefined && e[k] !== null && typeof e[k] !== 'function') extra[k] = e[k];
    }
  }
  sendError(res, status, code, errMsg(e), extra);
}

// ---------------------------------------------------------------------------
// request checks
// ---------------------------------------------------------------------------
function hostAllowed(host, port) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return h === '127.0.0.1:' + port || h === 'localhost:' + port || h === '[::1]:' + port;
}
function originAllowed(origin, port) {
  const o = String(origin).toLowerCase();
  return o === 'http://127.0.0.1:' + port || o === 'http://localhost:' + port || o === 'http://[::1]:' + port;
}
function isJsonType(ct) {
  return String(ct || '').split(';')[0].trim().toLowerCase() === 'application/json';
}
function tokenOk(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Resolves {value} or {status, code, message}. Always settles: on overflow,
// abort or error as well as on 'end'.
function readBody(req, limit) {
  const max = limit || BODY_LIMIT;
  return new Promise((resolve) => {
    let done = false, size = 0;
    const chunks = [];
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const declared = parseInt(req.headers['content-length'] || '-1', 10);
    if (declared > max) {
      req.resume();
      return finish({ status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'the request body is larger than 1 MB' });
    }
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) { req.resume(); return finish({ status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'the request body is larger than 1 MB' }); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish({ value: {} });
      let v;
      try { v = JSON.parse(text); }
      catch (e) { return finish({ status: 400, code: 'BAD_JSON', message: 'the request body is not valid JSON: ' + e.message }); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return finish({ status: 400, code: 'BAD_REQUEST', message: 'the request body must be a JSON object' });
      finish({ value: v });
    });
    req.on('error', () => finish({ status: 400, code: 'ABORTED', message: 'the request was aborted' }));
    req.on('close', () => { if (!req.complete) finish({ status: 400, code: 'ABORTED', message: 'the request was aborted' }); });
  });
}

// ---------------------------------------------------------------------------
// GET handlers
// ---------------------------------------------------------------------------
const qp = (c, k) => c.url.searchParams.get(k);

// The global settings: the VM registry's (accel, defaultExpose, in vms.json)
// merged with the engine settings and light profile (config.json, see
// config.engineSettings) - one object for the GUI and the MCP status.
function allSettings() {
  return Object.assign({}, st.state.settings, config.engineSettings());
}

// POST /api/settings: {accel?, defaultExpose?} go to the VM registry, the
// engine keys (lightProfile, microvmRootfs, microvmMemMB, tcgTbSizeMB,
// vmTcgTbSizeMB, vmDefaultMemMB, keepAlpineDownload, imagePruneDays; null =
// back to the profile default) to config.json. EVERY field is checked before
// anything is saved, so a bad value never leaves half a change behind.
// -> {settings} (both merged)
function updateSettings(body) {
  body = body || {};
  if (body.accel !== undefined && st.ACCELS.indexOf(body.accel) === -1) throw badRequest('accel must be one of ' + st.ACCELS.join(', '));
  if (body.defaultExpose !== undefined && st.EXPOSE.indexOf(body.defaultExpose) === -1) throw badRequest('defaultExpose must be "local" (this PC only) or "lan"');
  config.validateEngineSettings(body);
  // config.json first: it is the one that can still refuse (409 when the
  // file cannot be parsed), and then nothing at all has changed
  config.updateEngineSettings(body);
  if (body.accel !== undefined || body.defaultExpose !== undefined) st.updateSettings({ accel: body.accel, defaultExpose: body.defaultExpose });
  return { settings: allSettings() };
}

async function getState() {
  const vms = await vm.listVms();
  return {
    version: version(),
    host: vm.hostState(),
    platform: Object.assign(platform.osInfo(), { accel: platform.accelStatus(), lanAddresses: platform.lanAddresses() }),
    settings: allSettings(),
    // how to get hardware acceleration when the PC has none (nested
    // virtualization in the outer hypervisor), else null
    accelHint: install.accelHint(),
    prereqs: install.prereqs(),
    bases: vm.listTemplates(),
    vms: vms,
    // the host probe: which accelerator / CPU setting this PC runs VMs with
    hostProbe: hostprobe.state(),
    // microVM containers (registry only - no process listing per poll) and
    // whether Docker images can run without a full VM
    containers: containers.summaries(),
    microvm: containers.microvmStatus(),
    tasks: tasks.overview(),
    limits: {
      minMem: CFG.minMem, maxMem: CFG.maxMem, defaultMem: CFG.defaultMem,
      maxCpus: CFG.maxCpus, defaultCpus: Math.min(CFG.defaultCpus, CFG.maxCpus),
      minDiskGB: CFG.minDiskGB, maxDiskGB: CFG.maxDiskGB, firstSshPort: CFG.firstSshPort,
    },
    stateWarning: [st.stateWarning(), vm.legacyWarning(), containers.stateWarning()].filter(Boolean).join(' | ') || null,
    dataRoot: CFG.root,
    sshKey: CFG.sshKey,
    managerPort: CFG.serverPort,
  };
}

function getTask(c) {
  const id = qp(c, 'id');
  const t = id ? tasks.get(id) : tasks.latest();
  if (id && !t) throw notFound('no task with id ' + id + ' (only the last ' + tasks.MAX_TASKS + ' are kept)');
  return { task: t };
}

// Serial log of a VM, or @manager / @tasks / @bake. Reads only the last
// 256 KB; tail defaults to 300 lines, max 5000, never NaN (SEC-11).
function getLog(c) {
  const name = qp(c, 'name') || '';
  const lines = clampInt(qp(c, 'tail'), 1, 5000, 300);
  let file;
  if (name === '@manager') file = CFG.managerLog;
  else if (name === '@tasks') file = CFG.tasksLog;
  else if (name === '@bake') file = path.posix.join(CFG.sandboxDir, 'base-bake.log');
  else {
    const why = vmNameError(name);
    if (why) throw badRequest('bad VM name: ' + why);
    file = st.serialLogPath(name);
    if (!st.state.vms[name] && !exists(file)) throw notFound('no VM called "' + name + '"');
  }
  const r = tailFile(file, { lines: lines, maxBytes: 256 * 1024 });
  return { name: name, text: r.exists ? r.text : '(no log yet)', lines: r.lineCount, size: r.size, truncated: r.truncated };
}

function getAbout(c) {
  const mcpServer = path.join(CFG.appDir, 'mcp-server.js');
  const port = c.req.socket.localPort;
  return {
    app: CFG.appName,
    version: version(),
    dataRoot: CFG.root,
    rootId: rootId(),
    url: 'http://127.0.0.1:' + port + '/',
    node: process.execPath,
    nodeVersion: process.versions.node,
    platform: platform.osInfo(),
    mcpServer: mcpServer,
    mcpServerExists: exists(mcpServer),
    // env pins the MCP server to THIS data folder, whatever its defaults
    mcpConfig: { mcpServers: { 'devbox-vms': { command: process.execPath, args: [mcpServer], env: { VM_MANAGER_ROOT: CFG.root } } } },
  };
}

// ---------------------------------------------------------------------------
// route table
// ---------------------------------------------------------------------------
const vmLock = (a) => ['vm:' + a.name];
function taskRoute(p, kind, title, locks, validate, run) {
  return route.taskRoute({ path: p, kind: kind, title: title, locks: locks || vmLock, validate: validate, run: run });
}

// Setup locks: always 'global' + 'kernel'; the base image only when setup
// goes that far ({only:'microvm'} stops after the kernel); 'qemu' (which
// blocks every VM start) only while QEMU itself is installed.
function setupLocks(a) {
  const l = ['global', 'kernel'];
  if (a && a.installQemu) l.push('qemu');
  if (!(a && a.only === 'microvm')) l.push('template:devbox-base');
  return l;
}

// GET /api/ping (public). With ?nonce=<16-128 hex> it also answers
// proof = HMAC(token, nonce + this port): a client only trusts a manager that
// proves it knows the token, so it never hands the token (or opens a browser
// with #token=) to some other program that answers on the port (security-8).
function ping(c) {
  const out = { app: CFG.appName, version: version(), rootId: rootId() };
  const nonce = qp(c, 'nonce');
  if (nonce && /^[0-9a-f]{16,128}$/i.test(nonce) && c.token) out.proof = pingProof(c.token, nonce, c.req.socket.localPort);
  return out;
}

const ROUTES = [
  { method: 'GET', path: '/api/ping', auth: false, handler: ping },
  { method: 'GET', path: '/api/state', handler: getState },
  { method: 'GET', path: '/api/network', handler: () => vm.networkOverview() },
  { method: 'GET', path: '/api/tasks', handler: () => ({ tasks: tasks.list() }) },
  { method: 'GET', path: '/api/task', handler: getTask },
  { method: 'GET', path: '/api/log', handler: getLog },
  { method: 'GET', path: '/api/vm/docker', handler: (c) => docker.getDockerState(qp(c, 'name')) },
  { method: 'GET', path: '/api/vm/docker/logs', handler: (c) => docker.getDockerLogs({ name: qp(c, 'name'), container: qp(c, 'container'), tail: qp(c, 'tail') }) },
  { method: 'GET', path: '/api/about', handler: getAbout },
  // the host probe's last result (lib/hostprobe.js): every candidate, the best, whether it still applies
  { method: 'GET', path: '/api/host/probe', handler: () => ({ probe: hostprobe.read(), state: hostprobe.state(), key: hostprobe.keyNow() }) },
  { method: 'GET', path: '/api/session/stream', queryToken: true, raw: true, handler: (c) => sessions.stream(c.req, c.res, { id: qp(c, 'id'), since: qp(c, 'since') }) },
  // the screen of an appliance VM as a PNG (Claude's screenshot_vm, the GUI's "Save screenshot")
  // (?format=json wraps it as {name, bytes, png_base64} for clients that only read JSON, like the MCP tools)
  { method: 'GET', path: '/api/vm/screenshot', raw: true, handler: async (c) => {
    const buf = await screen.screenshot(qp(c, 'name'));
    if (qp(c, 'format') === 'json') send(c.res, 200, { ok: true, name: qp(c, 'name'), bytes: buf.length, png_base64: buf.toString('base64') });
    else send(c.res, 200, buf, 'image/png');
  } },
  // the screen as text (OCR, Windows only: 501 OCR_UNAVAILABLE elsewhere)
  { method: 'GET', path: '/api/vm/screen-text', handler: (c) => screen.screenText(qp(c, 'name'), { scale: qp(c, 'scale') }) },
  // the live screen is a WebSocket (see createServer's 'upgrade' handler); a plain GET is told so
  { method: 'GET', path: '/api/vm/screen', queryToken: true, raw: true, handler: (c) => {
    c.res.setHeader('Upgrade', 'websocket');
    sendError(c.res, 426, 'UPGRADE_REQUIRED', 'open /api/vm/screen?name=&token= as a WebSocket (the GUI\'s Screen tab does); GET /api/vm/screenshot?name= gives a PNG');
  } },

  { method: 'POST', path: '/api/settings', handler: (c) => updateSettings(c.body) },
  { method: 'POST', path: '/api/vm/settings', handler: (c) => vm.updateSettings(c.body) },
  { method: 'POST', path: '/api/vm/ports', handler: (c) => vm.setPorts(c.body) },
  { method: 'POST', path: '/api/vm/forget', handler: (c) => vm.forgetVm(c.body) },
  { method: 'POST', path: '/api/session/open', handler: (c) => sessions.open(c.body) },
  { method: 'POST', path: '/api/session/input', handler: (c) => sessions.input(c.body) },
  { method: 'POST', path: '/api/session/resize', handler: (c) => sessions.resize(c.body) },
  { method: 'POST', path: '/api/session/close', handler: (c) => sessions.close(c.body) },
  { method: 'POST', path: '/api/vm/keys', handler: (c) => screen.sendKeys((c.body || {}).name, (c.body || {}).keys, (c.body || {}).delayMs) },

  // 'qemu' (which blocks every VM start) only while QEMU itself is installed:
  // a setup that only builds the base image leaves the VMs alone
  taskRoute('/api/setup', 'setup', (a) => (a && a.only === 'microvm' ? 'Set up for Docker images' : 'Set up everything'), setupLocks, install.validateSetup, install.opSetup),
  taskRoute('/api/install/qemu', 'install-qemu', () => 'Install QEMU', () => ['global', 'qemu'], install.validateInstallQemu, install.opInstallQemu),
  taskRoute('/api/install/base', 'build-base', () => 'Build the base image', () => ['global', 'template:devbox-base'], install.validateBuildBase, install.opBuildBase),
  taskRoute('/api/install/kernel', 'install-kernel', () => 'Install the microVM kernel', () => ['kernel'], install.validateInstallKernel, install.opInstallKernel),
  // test boots under each candidate setting -> the best way to run VMs on this PC
  taskRoute('/api/host/probe', 'probe', () => 'Probe this PC for the best VM settings', () => ['host-probe', 'kernel'], hostprobe.validateProbe, hostprobe.opProbe),
  taskRoute('/api/vm/create', 'create', (a) => 'Create ' + a.name, null, vm.validateCreate, vm.opCreate),
  // appliance VMs: any OS image with a screen (lib/appliance.js)
  taskRoute('/api/vm/create-appliance', 'create', (a) => 'Create the appliance ' + a.name, null, appliance.validateCreate, appliance.opCreate),
  taskRoute('/api/vm/eject', 'eject', (a) => 'Remove the CD-ROM of ' + a.name, null, appliance.validateEject, appliance.opEject),
  taskRoute('/api/vm/start', 'start', (a) => 'Start ' + a.name, null, vm.validateStart, vm.opStart),
  taskRoute('/api/vm/stop', 'stop', (a) => (a.force ? 'Force stop ' : 'Stop ') + a.name, null, vm.validateStop, vm.opStop),
  taskRoute('/api/vm/restart', 'restart', (a) => 'Restart ' + a.name, null, vm.validateRestart, vm.opRestart),
  taskRoute('/api/vm/delete', 'delete', (a) => 'Delete ' + a.name, null, vm.validateDelete, vm.opDelete),
  taskRoute('/api/vm/reset', 'reset', (a) => 'Reset ' + a.name + ' to its template', null, vm.validateReset, vm.opReset),
  taskRoute('/api/vm/resize', 'resize', (a) => 'Resize the disk of ' + a.name, null, vm.validateResize, vm.opResize),
  taskRoute('/api/vm/growfs', 'growfs', (a) => 'Grow the filesystem of ' + a.name, null, vm.validateGrowFs, vm.opGrowFs),
  taskRoute('/api/vm/compact', 'compact', (a) => 'Compact the disk of ' + a.name, null, vm.validateCompact, vm.opCompact),
  taskRoute('/api/vm/freeze', 'freeze', (a) => 'Freeze ' + a.name + ' into ' + a.as, (a) => ['vm:' + a.name, 'template:' + a.as], vm.validateFreeze, vm.opFreeze),
  taskRoute('/api/vm/snapshot', 'snapshot', (a) => 'Snapshot ' + (a.action || '') + ' on ' + a.name, null, vm.validateSnapshot, vm.opSnapshot),
  taskRoute('/api/vm/docker/install', 'docker-install', (a) => 'Install Docker in ' + a.name, null, docker.validateDockerVm, docker.opDockerInstall),
  taskRoute('/api/vm/docker/pull', 'docker-pull', (a) => 'Pull ' + a.image + ' into ' + a.name, null, docker.validatePull, docker.opDockerPull),
  taskRoute('/api/vm/docker/run', 'docker-run', (a) => 'Run ' + a.image + ' in ' + a.name, null, docker.validateRun, docker.opDockerRun),
  taskRoute('/api/vm/docker/action', 'docker-action', (a) => 'docker ' + a.action + ' ' + a.id + ' in ' + a.name, null, docker.validateAction, docker.opDockerAction),
  taskRoute('/api/vm/docker/rmi', 'docker-rmi', (a) => 'Remove image ' + a.image + ' from ' + a.name, null, docker.validateRmi, docker.opDockerRmi),
  taskRoute('/api/vm/compose', 'compose', (a) => 'Compose project ' + a.project + ' in ' + a.name, null, docker.validateCompose, docker.opCompose),
  taskRoute('/api/vm/docker/inspect', 'docker-inspect', (a) => 'Inspect ' + a.image, null, docker.validateInspect, docker.opImageInspect),
  taskRoute('/api/vm/docker/deploy', 'deploy', (a) => 'Deploy ' + a.image + ' to ' + a.name, null, deploy.validateDeploy, deploy.opDeploy),
  taskRoute('/api/vm/quickdeploy', 'quickdeploy', (a) => 'New VM ' + a.name + ' from ' + a.image, null, deploy.validateQuickDeploy, deploy.opQuickDeploy),
].concat(microvmRoutes.ROUTES, sharesRoutes.ROUTES);

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return sendError(res, 400, 'BAD_REQUEST', 'bad path'); }
  if (rel === '/') rel = '/index.html';
  if (rel.indexOf('\0') !== -1 || rel.split(/[\\/]/).some((seg) => seg.charAt(0) === '.' && seg !== '')) {
    return sendError(res, 404, 'NOT_FOUND', 'not found');
  }
  const pub = path.resolve(CFG.appDir, 'public');
  const file = path.resolve(pub, rel.replace(/^[\\/]+/, ''));
  if (file.indexOf(pub + path.sep) !== 0) return sendError(res, 404, 'NOT_FOUND', 'not found');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return sendError(res, 404, 'NOT_FOUND', 'not found');
  let data;
  try {
    const stt = await fs.promises.stat(file);
    if (!stt.isFile()) return sendError(res, 404, 'NOT_FOUND', 'not found');
    data = await fs.promises.readFile(file);
  } catch (e) { return sendError(res, 404, 'NOT_FOUND', 'not found'); }
  return send(res, 200, data, type, 'no-cache');
}

async function handleApi(req, res, url, token) {
  const pathname = url.pathname;
  const r = ROUTES.find((x) => x.path === pathname && (x.method === req.method || (x.method === 'GET' && req.method === 'HEAD')));
  if (!(r && r.auth === false)) {
    const given = req.headers['x-devbox-token'] || (r && r.queryToken ? url.searchParams.get('token') : null);
    if (!tokenOk(given, token)) {
      // no paths or other details here: unauthenticated callers include guests
      return sendError(res, 401, 'UNAUTHORIZED', 'missing or wrong access token - open the manager with the link it printed at start-up, or paste the token from the manager-token file in its data folder');
    }
  }
  if (!r) {
    const allowed = ROUTES.filter((x) => x.path === pathname).map((x) => x.method);
    if (allowed.length) { res.setHeader('Allow', allowed.join(', ')); return sendError(res, 405, 'METHOD_NOT_ALLOWED', pathname + ' only accepts ' + allowed.join(', ')); }
    return sendError(res, 404, 'NOT_FOUND', 'no such API route: ' + pathname);
  }
  let body = null;
  if (r.method === 'POST') {
    if (!isJsonType(req.headers['content-type'])) {
      return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'POST requests must be sent as Content-Type: application/json');
    }
    const rb = await readBody(req);
    if (rb.status) {
      if (rb.status === 413) res.setHeader('Connection', 'close');
      return sendError(res, rb.status, rb.code, rb.message);
    }
    body = rb.value;
  }
  const ctx = { req: req, res: res, url: url, body: body, token: token, q: (k) => url.searchParams.get(k) };
  if (r.task) {
    const args = await r.validate(body || {});
    const spec = {
      kind: r.task.kind, title: r.task.title(args),
      vm: r.task.vm ? r.task.vm(args) : (args && args.name ? args.name : null),
      ctr: r.task.ctr ? r.task.ctr(args) : null,
      locks: r.task.locks(args),
    };
    let summary;
    try { summary = tasks.start(spec, (t) => r.run(t, args)); }
    catch (e) {
      // the validator may have claimed host ports for this task (args.claimed):
      // a task that never starts must not keep them from everyone else
      ports.releaseClaims(args);
      throw e;
    }
    return send(res, 202, { ok: true, task: summary });
  }
  const out = await r.handler(ctx);
  if (r.raw) return undefined;
  return send(res, route.statusOf(out), Object.assign({ ok: true }, out || {}));
}

async function handler(req, res, getToken) {
  securityHeaders(res);
  const port = req.socket.localPort;
  if (!hostAllowed(req.headers.host, port)) return sendError(res, 403, 'FORBIDDEN', 'this address is not allowed - open http://127.0.0.1:' + port + '/');
  if (req.headers.origin !== undefined && !originAllowed(req.headers.origin, port)) {
    return sendError(res, 403, 'FORBIDDEN', 'cross-origin requests are not allowed');
  }
  if (req.method === 'POST' && req.headers.origin === undefined) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return sendError(res, 403, 'FORBIDDEN', 'cross-site requests are not allowed');
  }
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1:' + port); } catch (e) { return sendError(res, 400, 'BAD_REQUEST', 'bad URL'); }
  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) {
    return handleApi(req, res, url, typeof getToken === 'function' ? getToken() : getToken);
  }
  return serveStatic(req, res, url.pathname);
}

// opts: {token} - defaults to <root>/manager-token read at request time.
function createServer(opts) {
  opts = opts || {};
  const getToken = () => opts.token || readToken();
  const server = http.createServer((req, res) => {
    handler(req, res, getToken).catch((e) => errorResponse(res, e));
  });
  // the VM screen relay (lib/screen.js): the only WebSocket this server speaks
  server.on('upgrade', (req, socket, head) => {
    try { screen.handleUpgrade(req, socket, head, { token: getToken, hostAllowed, originAllowed, tokenOk }); }
    catch (e) { logError('screen upgrade failed', e); try { socket.destroy(); } catch (x) {} }
  });
  server.on('clientError', (err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) {}
  });
  return server;
}

module.exports = {
  createServer, handler, ROUTES, CSP,
  send, sendError, errorResponse, readBody, hostAllowed, originAllowed, isJsonType, tokenOk,
};
