'use strict';
/*
 * The VM screen relay (lib/screen.js) through the real HTTP server: every
 * refusal of the WebSocket upgrade (host, origin, token, unknown route, no
 * such VM, not an appliance, not running), the plain-GET answer (426), the
 * screenshot route's refusals, send_keys validation, and one real relay:
 * a fake "VNC server" on 127.0.0.1 behind a fake running appliance record,
 * a hand-written WebSocket client, bytes both ways.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const config = require('../lib/config');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const screen = require('../lib/screen');
const ws = require('../lib/ws');
const { createServer } = require('../lib/http');
const { useTempRoot, resetConfig, rm, request } = require('./helpers');

async function withServer(fn) {
  const root = useTempRoot('screen');
  tasks._reset();
  st.loadState();
  const token = config.ensureToken();
  const server = createServer({ token: token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn({ port: port, token: token, root: root }); }
  finally { await new Promise((r) => server.close(r)); tasks._reset(); resetConfig(); rm(root); }
}

// A raw upgrade request; resolves {status, headers, socket} (the socket stays open on 101)
function upgrade(port, path, headers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port: port, path: path, method: 'GET',
      headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Protocol': 'binary' }, headers || {}) });
    // head: bytes that arrived right behind the 101 (the VNC greeting, usually)
    req.on('upgrade', (res, socket, head) => resolve({ status: 101, headers: res.headers, socket: socket, key: key, head: head }));
    req.on('response', (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() })); });
    req.on('error', reject);
    req.end();
  });
}

// Server frames are unmasked (lib/ws.decodeFrames reads CLIENT frames, which
// must be masked): a small parser for what the browser side receives.
function decodeServerFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const fin = !!(buf[i] & 0x80), opcode = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f, off = i + 2;
    if (len === 126) { if (off + 2 > buf.length) break; len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (off + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
    if (off + len > buf.length) break;
    frames.push({ fin: fin, opcode: opcode, payload: buf.subarray(off, off + len) });
    i = off + len;
  }
  return frames;
}

function mask(payload) {
  const m = crypto.randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ m[i % 4];
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), m, out]);
}

test('plain GET /api/vm/screen answers 426 with the WebSocket hint; the screenshot route refuses unknown and stopped VMs', () => withServer(async (s) => {
  const auth = { 'X-DevBox-Token': s.token };
  const r = await request(s.port, { path: '/api/vm/screen?name=k', headers: auth });
  assert.equal(r.status, 426);
  assert.equal(r.json.code, 'UPGRADE_REQUIRED');
  assert.equal(r.headers.upgrade, 'websocket');
  assert.equal((await request(s.port, { path: '/api/vm/screen?name=k' })).status, 401, 'token required');
  assert.equal((await request(s.port, { path: '/api/vm/screenshot?name=k', headers: auth })).status, 404);
  st.state.vms.k = st.newVmRecord({ port: 2222 });
  assert.equal((await request(s.port, { path: '/api/vm/screenshot?name=k', headers: auth })).status, 400, 'not an appliance');
  st.state.vms.a = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2223 });
  const r2 = await request(s.port, { path: '/api/vm/screenshot?name=a', headers: auth });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.code, 'NOT_RUNNING');
  // the screen as text: the same refusals (off Windows it is 501 for every VM: there is no engine)
  const txt = (n) => request(s.port, { path: '/api/vm/screen-text?name=' + n, headers: auth });
  if (process.platform === 'win32') {
    assert.equal((await txt('nope')).status, 404);
    assert.equal((await txt('k')).status, 400, 'not an appliance');
    const r3 = await txt('a');
    assert.equal(r3.status, 409);
    assert.equal(r3.json.code, 'NOT_RUNNING');
  } else {
    const r3 = await txt('a');
    assert.equal(r3.status, 501);
    assert.equal(r3.json.code, 'OCR_UNAVAILABLE');
  }
  assert.equal((await request(s.port, { path: '/api/vm/screen-text?name=a' })).status, 401, 'token required');
  // keys: the same checks, plus the key names
  const post = (body) => request(s.port, { method: 'POST', path: '/api/vm/keys', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: body });
  assert.equal((await post({ name: 'a', keys: 'up ret' })).status, 409);
  assert.ok(screen.validKey('ctrl-alt-delete') && screen.validKey('kp_1') && screen.validKey('f12'));
  assert.ok(!screen.validKey('up ret') && !screen.validKey('') && !screen.validKey('a;b') && !screen.validKey('x'.repeat(49)));
}));

test('the upgrade is refused with a real HTTP status for: bad host, bad origin, no token, unknown route, no such VM, not running', () => withServer(async (s) => {
  const t = encodeURIComponent(s.token);
  assert.equal((await upgrade(s.port, '/api/vm/screen?name=k&token=' + t, { Host: 'evil.example:' + s.port })).status, 403);
  assert.equal((await upgrade(s.port, '/api/vm/screen?name=k&token=' + t, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await upgrade(s.port, '/api/vm/screen?name=k')).status, 401);
  assert.equal((await upgrade(s.port, '/api/other?token=' + t)).status, 404);
  assert.equal((await upgrade(s.port, '/api/vm/screen?name=k&token=' + t)).status, 404);
  st.state.vms.k = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2222 });
  const r = await upgrade(s.port, '/api/vm/screen?name=k&token=' + t);
  assert.equal(r.status, 409, 'not running');
  assert.equal(screen.relayCount(), 0);
}));

test('a real relay: bytes flow both ways between the browser socket and the VM\'s VNC endpoint, and the relay closes with the VNC side', () => withServer(async (s) => {
  // a fake VNC server: greets with "RFB 003.008\n" and echoes everything back upper-cased
  const conns = [];
  const vnc = net.createServer((c) => { conns.push(c); c.write('RFB 003.008\n'); c.on('data', (d) => c.write(d.toString().toUpperCase())); });
  await new Promise((r) => vnc.listen(0, '127.0.0.1', r));
  const vport = vnc.address().port;
  st.state.vms.k = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2222,
    runtime: { pid: process.pid, monitor: { host: '127.0.0.1', port: 1 }, serial: { host: '127.0.0.1', port: 2 }, display: { host: '127.0.0.1', port: vport } } });
  try {
    const r = await upgrade(s.port, '/api/vm/screen?name=k&token=' + encodeURIComponent(s.token), { Origin: 'http://127.0.0.1:' + s.port });
    assert.equal(r.status, 101);
    assert.equal(r.headers['sec-websocket-accept'], ws.acceptKey(r.key));
    assert.equal(r.headers['sec-websocket-protocol'], 'binary');
    const sock = r.socket;
    let got = r.head && r.head.length ? Buffer.from(r.head) : Buffer.alloc(0);
    const next = (pred) => new Promise((resolve) => {
      const check = () => { const f = decodeServerFrames(got); if (pred(f)) { resolve(f); return true; } return false; };
      if (check()) return;
      sock.on('data', (d) => { got = Buffer.concat([got, d]); check(); });
    });
    // the greeting arrives as a binary frame
    let frames = await next((f) => f.length >= 1);
    assert.equal(frames[0].opcode, 2);
    assert.equal(frames[0].payload.toString(), 'RFB 003.008\n');
    assert.equal(screen.relayCount(), 1);
    // browser -> VNC -> back
    sock.write(mask(Buffer.from('hello vnc')));
    frames = await next((f) => f.length >= 2);
    assert.equal(frames[1].payload.toString(), 'HELLO VNC');
    // the VNC side goes away (QEMU stopped): the browser gets a close frame
    for (const c of conns) c.destroy();
    frames = await next((f) => f.some((x) => x.opcode === 8));
    assert.ok(frames.some((x) => x.opcode === 8), 'close frame after the VNC side closed');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(screen.relayCount(), 0);
    sock.destroy();
  } finally {
    try { vnc.close(); } catch (e) {}
  }
}));
