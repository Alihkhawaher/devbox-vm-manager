'use strict';
/*
 * The screen of an appliance VM (lib/appliance.js) in the browser, and for
 * Claude.
 *
 * QEMU draws the guest's display on a plain VNC server bound to the VM's
 * private display endpoint (vm.runtime.display: the same random 127.x.y.z
 * as its monitor on Windows, 127.0.0.1 elsewhere - a port the guests cannot
 * reach and nobody can guess; VNC itself has no password). Nothing else ever
 * listens for the screen. The browser runs noVNC (public/vendor/novnc, MPL
 * 2.0) and speaks WebSocket; this module is the relay in between:
 *
 *   GET /api/vm/screen?name=<vm>&token=<token>   Upgrade: websocket
 *
 * The http server's 'upgrade' event lands in handleUpgrade(): the same Host
 * and Origin checks as every request (lib/http.js), the token from the query
 * string (a browser WebSocket cannot set headers, like EventSource), the VM
 * must exist and have a display, then lib/ws.js completes the handshake and
 * the frames are piped byte for byte to a TCP connection to QEMU's VNC port,
 * with backpressure both ways. Several browsers may watch at once (QEMU
 * serves every VNC client); closing the tab closes the relay connection and
 * nothing else. A refused upgrade is answered with a plain HTTP error and the
 * socket closed - never a half-open connection.
 *
 * A VM shown in a WINDOW on this PC (appliance display "window": 3D
 * graphics, lib/appliance.js) has no VNC server: the relay refuses it (409
 * IN_WINDOW), and screenshots and OCR read QEMU's window instead
 * (lib/wincap.js, Windows) - screendump cannot read a 3D screen.
 *
 * Without a browser:
 *   screenshot(name) -> PNG Buffer: the monitor's `screendump` into a
 *     temporary file (QEMU writes PPM; lib/png.js turns it into PNG), or the
 *     window capture for a VM in a window, for GET /api/vm/screenshot?name=
 *     and the MCP tool screenshot_vm, so Claude can look at the screen it is
 *     testing.
 *   sendKeys(name, keys) -> the monitor's `sendkey` per key (QEMU key names:
 *     "ret", "up", "ctrl-alt-delete", "a"...), for POST /api/vm/keys and the
 *     MCP tool send_keys: a remote control for the guest.
 *   screenText(name) -> the same screendump read by OCR (lib/ocr.js, Windows'
 *     own engine): {text, lines: [{text, x, y, w, h}], ms, ...}, for
 *     GET /api/vm/screen-text and the MCP tools screen_text / wait_for_text.
 *
 * Exports: handleUpgrade(req, socket, head, {token, hostAllowed,
 * originAllowed}), screenshot(name), screenText(name, opts), grabPpm(name),
 * sendKeys(name, keys), validKey(k), relayCount(), screenOf(name),
 * displayOf(name).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const st = require('./state');
const monitor = require('./monitor');
const ws = require('./ws');
const png = require('./png');
const ocr = require('./ocr');
const wincap = require('./wincap');
const { badRequest, conflict, notFound, vmNameError } = require('./util');

const CONNECT_TIMEOUT_MS = 5000;
let relays = 0;
function relayCount() { return relays; }

// The screen of a running appliance VM: {vm, display: VNC endpoint | null,
// window: true when it is a QEMU window on this PC}.
function screenOf(name) {
  const why = vmNameError(name || '');
  if (why) throw badRequest('bad VM name: ' + why);
  const vm = st.state.vms[name];
  if (!vm) throw notFound('no VM called "' + name + '"');
  if (vm.kind !== 'appliance') throw badRequest('"' + name + '" is not an appliance VM: it has a terminal and a serial console, not a screen');
  const rt = vm.runtime;
  if (rt && rt.window) return { vm: vm, display: null, window: true };
  const d = rt && rt.display;
  if (!d) throw conflict('"' + name + '" is not running - start it first', 'NOT_RUNNING');
  return { vm: vm, display: d, window: false };
}
// The VNC screen (the browser relay): not for a VM shown in a window.
function displayOf(name) {
  const s = screenOf(name);
  if (s.window) {
    throw conflict('the screen of "' + name + '" is a window on the PC that runs the manager (3D graphics, full speed) - switch it to the browser view to watch it here', 'IN_WINDOW');
  }
  return s;
}

function refuse(socket, status, text) {
  const body = JSON.stringify({ ok: false, error: text });
  try {
    socket.write('HTTP/1.1 ' + status + '\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
  } catch (e) { /* gone */ }
  try { socket.destroy(); } catch (e) {}
}

// The http server's 'upgrade' handler. checks: {token: () => string,
// hostAllowed(host, port), originAllowed(origin, port), tokenOk(given, expected)}
function handleUpgrade(req, socket, head, checks) {
  const port = socket.localPort;
  if (!checks.hostAllowed(req.headers.host, port)) return refuse(socket, '403 Forbidden', 'this address is not allowed');
  if (req.headers.origin !== undefined && !checks.originAllowed(req.headers.origin, port)) return refuse(socket, '403 Forbidden', 'cross-origin requests are not allowed');
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1:' + port); } catch (e) { return refuse(socket, '400 Bad Request', 'bad URL'); }
  if (url.pathname !== '/api/vm/screen') return refuse(socket, '404 Not Found', 'no such WebSocket route: ' + url.pathname);
  if (!checks.tokenOk(url.searchParams.get('token'), checks.token())) return refuse(socket, '401 Unauthorized', 'missing or wrong access token');
  let d;
  try { d = displayOf(url.searchParams.get('name')); }
  catch (e) { return refuse(socket, (e.status || 500) + ' ' + (e.code || 'Error'), e.message); }

  const conn = ws.accept(req, socket, head, { protocols: ['binary'] });
  if (!conn) return;
  relays++;
  let closed = false;
  const vnc = net.connect({ host: d.display.host, port: d.display.port });
  vnc.setNoDelay(true);
  vnc.setTimeout(CONNECT_TIMEOUT_MS);
  const finish = (code, reason) => {
    if (closed) return;
    closed = true;
    relays--;
    try { vnc.destroy(); } catch (e) {}
    try { conn.close(code || 1000, reason || ''); } catch (e) {}
  };
  vnc.once('connect', () => { vnc.setTimeout(0); });
  vnc.on('timeout', () => finish(1011, 'the VM screen did not answer'));
  vnc.on('error', (e) => finish(1011, 'VM screen: ' + (e && e.message)));
  vnc.on('close', () => finish(1000, 'the VM screen closed'));
  // browser -> QEMU, with backpressure
  conn.on('message', (buf) => {
    if (closed) return;
    if (!vnc.write(buf)) { conn.socket.pause(); vnc.once('drain', () => { try { conn.socket.resume(); } catch (e) {} }); }
  });
  // QEMU -> browser
  vnc.on('data', (buf) => {
    if (closed) return;
    if (!conn.send(buf)) { vnc.pause(); conn.socket.once('drain', () => { try { vnc.resume(); } catch (e) {} }); }
  });
  conn.on('close', () => finish());
  conn.on('error', () => finish(1011, 'relay error'));
}

// ---------------------------------------------------------------------------
// screenshot and keys through the QEMU monitor
// ---------------------------------------------------------------------------
// The screen as raw PPM: the monitor's screendump, or the capture of the
// QEMU window of a VM shown in a window (Windows; screendump cannot read 3D).
async function grabPpm(name) {
  const d = screenOf(name);
  if (d.window) return wincap.capture(d.vm.runtime.pid);
  const mon = monitor.monitorFor(d.vm);
  if (!mon) throw conflict('"' + name + '" has no monitor', 'NOT_RUNNING');
  const file = path.join(os.tmpdir(), 'devbox-screen-' + crypto.randomBytes(6).toString('hex') + '.ppm');
  try {
    // the monitor takes the path as typed: forward slashes keep QEMU's
    // own option parser happy on Windows too
    const r = await monitor.monitorCmd(mon, 'screendump ' + file.replace(/\\/g, '/'), { timeoutMs: 15000 });
    if (!r.ok) throw new Error('screendump failed: ' + (r.error || r.text || 'no reply'));
    // QEMU writes the file after it answers on a busy guest: wait for it briefly
    let buf = null;
    for (let i = 0; i < 20 && !buf; i++) {
      try { buf = fs.readFileSync(file); if (!buf.length) buf = null; } catch (e) { buf = null; }
      if (!buf) await new Promise((res) => setTimeout(res, 100));
    }
    if (!buf) throw new Error('QEMU wrote no screenshot file');
    return buf;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch (e) {}
  }
}

async function screenshot(name) {
  return png.ppmToPng(await grabPpm(name));
}

// The screen as text (lib/ocr.js: Windows' OCR engine), with each line's
// position. opts.scale: 1-3 (default: 2 up to 2000 px wide, else 1).
async function screenText(name, opts) {
  const a = ocr.available();
  if (!a.ok) { const e = new Error(a.why); e.status = 501; e.code = 'OCR_UNAVAILABLE'; throw e; }
  const img = png.parsePpm(await grabPpm(name));
  const r = await ocr.recognize(img, { scale: opts && opts.scale });
  return Object.assign({ name: name, engine: 'windows-ocr' }, r);
}

// A QEMU key name (sendkey): "a", "ret", "esc", "ctrl-alt-delete", "kp_1"...
const KEY_RE = /^[a-z0-9_]+(-[a-z0-9_]+){0,3}$/i;
function validKey(k) { return typeof k === 'string' && k.length <= 48 && KEY_RE.test(k); }

// keys: ["up", "up", "ret"] or "up up ret" (at most 64 per call, each held
// 100 ms by QEMU), delayMs between keys (default 150; a boot loader polling
// the keyboard under emulation drops keys typed faster - 300-500 helps).
// Returns {sent: n}.
async function sendKeys(name, keys, delayMs) {
  const d = screenOf(name);   // keys go through the monitor: browser or window view alike
  const mon = monitor.monitorFor(d.vm);
  if (!mon) throw conflict('"' + name + '" has no monitor', 'NOT_RUNNING');
  const list = Array.isArray(keys) ? keys : String(keys || '').trim().split(/\s+/).filter(Boolean);
  if (!list.length) throw badRequest('keys: give one or more QEMU key names, e.g. "up up ret" or "ctrl-alt-delete"');
  if (list.length > 64) throw badRequest('at most 64 keys per call');
  for (const k of list) if (!validKey(k)) throw badRequest('not a key name: ' + JSON.stringify(k) + ' (QEMU names: a-z, 0-9, ret, esc, tab, spc, up, down, left, right, backspace, f1-f12, ctrl-alt-delete, ...)');
  const gap = delayMs === undefined || delayMs === null || delayMs === '' ? 150 : Number(delayMs);
  if (!(gap >= 50 && gap <= 2000)) throw badRequest('delayMs must be between 50 and 2000');
  let sent = 0;
  for (const k of list) {
    const r = await monitor.monitorCmd(mon, 'sendkey ' + k, { timeoutMs: 5000 });
    if (!r.ok) throw new Error('sendkey ' + k + ' failed: ' + (r.error || r.text || 'no reply'));
    sent++;
    await new Promise((res) => setTimeout(res, gap));
  }
  return { name: name, sent: sent, delayMs: gap };
}

module.exports = { handleUpgrade, screenshot, screenText, grabPpm, sendKeys, validKey, relayCount, displayOf, screenOf };
