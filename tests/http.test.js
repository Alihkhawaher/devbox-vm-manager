'use strict';
/*
 * lib/http.js end to end on an ephemeral port with a temporary data root:
 * token (401), Host allow-list and Origin (403), content type (415), body
 * limits (413/400), security headers, static-file safety, the route table
 * (404/405), validation before tasks, 202 task starts and 409 busy.
 * Nothing here starts QEMU or ssh.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { CFG } = config;
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const { createServer, ROUTES } = require('../lib/http');
const { useTempRoot, resetConfig, rm, request } = require('./helpers');

async function withServer(fn) {
  const root = useTempRoot('http');
  tasks._reset();
  st.loadState();
  const token = config.ensureToken();
  const server = createServer({ token: token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const auth = { 'X-DevBox-Token': token };
  const json = Object.assign({ 'Content-Type': 'application/json' }, auth);
  try {
    await fn({ port: port, token: token, auth: auth, json: json, root: root });
  } finally {
    await new Promise((r) => server.close(r));
    tasks._reset();
    resetConfig();
    rm(root);
  }
}

function assertSecurityHeaders(r) {
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['content-security-policy'], /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS, ever');
}

test('GET /api/ping is public and identifies this manager + data root', () => withServer(async (s) => {
  const r = await request(s.port, { path: '/api/ping' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.app, 'devbox-vm-manager');
  assert.equal(r.json.rootId, config.rootId());
  assert.match(r.json.version, /^\d+\.\d+\.\d+/);
  assertSecurityHeaders(r);
  assert.equal(r.headers['cache-control'], 'no-store');
}));

test('GET /api/ping?nonce= proves the token without revealing it: HMAC over the nonce AND this port (security-8)', () => withServer(async (s) => {
  const nonce = 'a1'.repeat(16);
  const r = await request(s.port, { path: '/api/ping?nonce=' + nonce });
  assert.equal(r.status, 200);
  assert.equal(r.json.proof, config.pingProof(s.token, nonce, s.port));
  assert.notEqual(r.json.proof, config.pingProof(s.token, nonce, s.port + 1), 'bound to the port: a relay on another port cannot reuse it');
  assert.equal(r.text.indexOf(s.token), -1);
  // no nonce, or a malformed one: no proof
  assert.equal((await request(s.port, { path: '/api/ping' })).json.proof, undefined);
  assert.equal((await request(s.port, { path: '/api/ping?nonce=xyz' })).json.proof, undefined);
  // the real client verifies it
  const client = require('../lib/client');
  assert.equal((await client.ping(s.port, 2000, s.token)).verified, true);
  assert.equal((await client.ping(s.port, 2000, 'ef'.repeat(24))).verified, false);
}));

test('the setup task blocks VM starts ("qemu" lock) only when it installs QEMU (correctness-7)', () => {
  const route = ROUTES.find((r) => r.path === '/api/setup');
  assert.deepEqual(route.task.locks({ installQemu: false }), ['global', 'kernel', 'template:devbox-base']);
  assert.deepEqual(route.task.locks({ installQemu: true }), ['global', 'kernel', 'qemu', 'template:devbox-base']);
  // "Set up for Docker images" stops after the microVM kernel: the base image is not locked
  assert.deepEqual(route.task.locks({ installQemu: false, only: 'microvm' }), ['global', 'kernel']);
  assert.equal(route.task.title({ only: 'microvm' }), 'Set up for Docker images');
});

test('a task that cannot start (409 BUSY) hands back the ports its validator claimed', () => withServer(async (s) => {
  const ports = require('../lib/ports');
  ports._resetClaims();
  fs.mkdirSync(CFG.sandboxDir, { recursive: true });
  fs.writeFileSync(CFG.base, ''); // a "template" is enough for the validator
  const platform = require('../lib/platform');
  const saved = { findTool: platform.findTool, isPortFree: platform.isPortFree };
  platform.findTool = (n) => (n === 'qemu-img' || n === 'qemu' ? '/fake/' + n : saved.findTool(n));
  let release;
  const gate = new Promise((r) => { release = r; });
  let holder = null;
  try {
    // another request takes the VM's lock while this one is being validated
    // (between its checks and tasks.start): the validation passes, the start fails
    platform.isPortFree = async () => {
      if (!holder) holder = tasks.start({ kind: 'create', title: 'Create newvm', vm: 'newvm', locks: ['vm:newvm'] }, () => gate);
      return true;
    };
    const r = await request(s.port, { method: 'POST', path: '/api/vm/create', headers: s.json, body: { name: 'newvm', ports: '38911:80', port: 38912 } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'BUSY');
    assert.ok(holder, 'the lock was taken during the validation');
    assert.equal(ports.reservedPorts().has(38911), false, 'not left claimed');
    assert.equal(ports.reservedPorts().has(38912), false);
  } finally { release(); platform.findTool = saved.findTool; platform.isPortFree = saved.isPortFree; }
}));

test('401 without the token, with a wrong token, and for unknown API paths', () => withServer(async (s) => {
  for (const headers of [{}, { 'X-DevBox-Token': 'x'.repeat(48) }, { 'X-DevBox-Token': '' }]) {
    const r = await request(s.port, { path: '/api/state', headers: headers });
    assert.equal(r.status, 401);
    assert.deepEqual([r.json.ok, r.json.code], [false, 'UNAUTHORIZED']);
    assert.match(r.json.error, /access token/);
    assertSecurityHeaders(r);
  }
  assert.equal((await request(s.port, { path: '/api/nope' })).status, 401);
  // ?token= is accepted ONLY on the SSE stream route
  assert.equal((await request(s.port, { path: '/api/state?token=' + s.token })).status, 401);
  const sse = await request(s.port, { path: '/api/session/stream?id=nope&token=' + s.token });
  assert.equal(sse.status, 404, 'authenticated by query token, then: no such session');
}));

test('GET /api/state with the token: 200, the documented shape, no-store', () => withServer(async (s) => {
  const r = await request(s.port, { path: '/api/state', headers: s.auth });
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.ok, true);
  for (const k of ['version', 'host', 'platform', 'settings', 'prereqs', 'bases', 'vms', 'tasks', 'limits', 'stateWarning', 'dataRoot']) assert.ok(k in j, k);
  assert.deepEqual(j.vms, []);
  assert.deepEqual(j.settings, { accel: 'auto', defaultExpose: 'local' });
  assert.deepEqual(Object.keys(j.tasks).sort(), ['recent', 'running']);
  assert.equal(j.limits.maxCpus, CFG.maxCpus);
  assert.equal(j.platform.os, process.platform);
  assert.ok('recommended' in j.platform.accel);
  assert.equal(j.prereqs.qemu.required, true);
  assert.equal(r.headers['cache-control'], 'no-store');
}));

test('403 for a foreign Host header (DNS rebinding) - on API and static files alike', () => withServer(async (s) => {
  for (const host of ['evil.example:' + s.port, 'evil.example', '127.0.0.1:1', '192.168.1.5:' + s.port]) {
    const a = await request(s.port, { path: '/api/ping', headers: { Host: host } });
    assert.equal(a.status, 403, host);
    const b = await request(s.port, { path: '/', headers: { Host: host } });
    assert.equal(b.status, 403, host);
    assertSecurityHeaders(b);
  }
  for (const host of ['localhost:' + s.port, 'LOCALHOST:' + s.port, '[::1]:' + s.port]) {
    assert.equal((await request(s.port, { path: '/api/ping', headers: { Host: host } })).status, 200, host);
  }
}));

test('403 for a foreign Origin, and for a cross-site POST without Origin', () => withServer(async (s) => {
  const bad = await request(s.port, { method: 'POST', path: '/api/settings', headers: Object.assign({ Origin: 'https://evil.example' }, s.json), body: { accel: 'tcg' } });
  assert.equal(bad.status, 403);
  assert.equal(st.state.settings.accel, 'auto', 'nothing changed');
  const nul = await request(s.port, { path: '/api/state', headers: Object.assign({ Origin: 'null' }, s.auth) });
  assert.equal(nul.status, 403);
  const site = await request(s.port, { method: 'POST', path: '/api/settings', headers: Object.assign({ 'Sec-Fetch-Site': 'cross-site' }, s.json), body: { accel: 'tcg' } });
  assert.equal(site.status, 403);
  const good = await request(s.port, { method: 'POST', path: '/api/settings', headers: Object.assign({ Origin: 'http://127.0.0.1:' + s.port, 'Sec-Fetch-Site': 'same-origin' }, s.json), body: { accel: 'tcg' } });
  assert.equal(good.status, 200);
  assert.deepEqual(good.json.settings, { accel: 'tcg', defaultExpose: 'local' });
}));

test('415 unless POST bodies are application/json (media type, parameters allowed)', () => withServer(async (s) => {
  for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    const headers = Object.assign({}, s.auth);
    if (ct) headers['Content-Type'] = ct;
    const r = await request(s.port, { method: 'POST', path: '/api/settings', headers: headers, body: '{"accel":"tcg"}' });
    assert.equal(r.status, 415, String(ct));
    assert.equal(r.json.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  const ok = await request(s.port, { method: 'POST', path: '/api/settings', headers: Object.assign({}, s.auth, { 'Content-Type': 'Application/JSON; charset=utf-8' }), body: '{"accel":"tcg"}' });
  assert.equal(ok.status, 200);
}));

test('413 for bodies over 1 MB; 400 for invalid JSON or a non-object; UTF-8 survives chunking', () => withServer(async (s) => {
  const big = await request(s.port, { method: 'POST', path: '/api/settings', headers: s.json, body: '{"x":"' + 'a'.repeat(1100 * 1024) + '"}' });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'PAYLOAD_TOO_LARGE');
  const bad = await request(s.port, { method: 'POST', path: '/api/settings', headers: s.json, body: '{"accel": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_JSON');
  const arr = await request(s.port, { method: 'POST', path: '/api/settings', headers: s.json, body: '[1,2]' });
  assert.equal(arr.status, 400);
  // a note with multi-byte characters is stored intact
  st.state.vms.web = st.newVmRecord({ port: 2223 });
  const note = 'Grüße – 日本語 – ✓';
  const r = await request(s.port, { method: 'POST', path: '/api/vm/settings', headers: s.json, body: Buffer.from(JSON.stringify({ name: 'web', note: note }), 'utf8') });
  assert.equal(r.status, 200, r.text);
  assert.equal(st.state.vms.web.note, note);
  assert.equal(r.json.vm.note, note);
}));

test('404 unknown route, 405 wrong method, 400/404/409 validation BEFORE any task starts', () => withServer(async (s) => {
  const nf = await request(s.port, { path: '/api/nope', headers: s.auth });
  assert.equal(nf.status, 404);
  assert.equal(nf.json.code, 'NOT_FOUND');
  const m = await request(s.port, { method: 'POST', path: '/api/state', headers: s.json, body: {} });
  assert.equal(m.status, 405);
  assert.match(m.headers.allow, /GET/);
  const unknownVm = await request(s.port, { method: 'POST', path: '/api/vm/start', headers: s.json, body: { name: 'nope' } });
  assert.equal(unknownVm.status, 404);
  const badName = await request(s.port, { method: 'POST', path: '/api/vm/start', headers: s.json, body: { name: '../../etc' } });
  assert.equal(badName.status, 400);
  const noName = await request(s.port, { method: 'POST', path: '/api/vm/create', headers: s.json, body: {} });
  assert.equal(noName.status, 400);
  assert.match(noName.json.error, /a name is required/);
  assert.equal(tasks.list().length, 0, 'no task was started for bad input');
  // Formerly 501 stubs, now real: their validators refuse this fixture (a
  // record with no disk) before any task starts. Never POST /api/setup or
  // /api/install/* here - they start real downloads.
  st.state.vms.web = st.newVmRecord({ port: 2223 }); // record only, no disk
  for (const [p, body, status] of [
    ['/api/vm/reset', { name: 'web' }, 409],
    ['/api/vm/compact', { name: 'web' }, 409],
    ['/api/vm/snapshot', { name: 'web', action: 'create', snapshot: 's1' }, 409],
    ['/api/vm/snapshot', { name: 'web', action: 'boom' }, 400],
    ['/api/session/resize', { id: 'x', cols: 80, rows: 24 }, 404],
  ]) {
    const r = await request(s.port, { method: 'POST', path: p, headers: s.json, body: body });
    assert.equal(r.status, status, p + ' ' + r.text);
    assert.equal(r.json.ok, false);
  }
  assert.equal(tasks.list().length, 0, 'still no task started');
}));

test('task POSTs reply 202 with the task; GET /api/task follows it; a held lock gives 409 with the holder', () => withServer(async (s) => {
  st.state.vms.web = st.newVmRecord({ port: 2223 });
  const r = await request(s.port, { method: 'POST', path: '/api/vm/stop', headers: s.json, body: { name: 'web' } });
  assert.equal(r.status, 202);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.task.kind, 'stop');
  assert.equal(r.json.task.vm, 'web');
  assert.equal(r.json.task.title, 'Stop web');
  const done = await tasks.wait(r.json.task.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { name: 'web', stopped: true, how: 'not-running' });
  const t = await request(s.port, { path: '/api/task?id=' + r.json.task.id, headers: s.auth });
  assert.equal(t.status, 200);
  assert.ok(t.json.task.log.some((l) => /is not running/.test(l)));
  assert.equal((await request(s.port, { path: '/api/task?id=nope', headers: s.auth })).status, 404);
  const list = await request(s.port, { path: '/api/tasks', headers: s.auth });
  assert.equal(list.json.tasks[0].id, r.json.task.id);

  let release;
  const gate = new Promise((res) => { release = res; });
  const holder = tasks.start({ kind: 'deploy', title: 'Deploy nginx to web', vm: 'web', locks: ['vm:web'] }, () => gate);
  const busy = await request(s.port, { method: 'POST', path: '/api/vm/stop', headers: s.json, body: { name: 'web' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, 'BUSY');
  assert.equal(busy.json.holder.id, holder.id);
  assert.match(busy.json.error, /Deploy nginx to web/);
  const busyPorts = await request(s.port, { method: 'POST', path: '/api/vm/ports', headers: s.json, body: { name: 'web', ports: '8080' } });
  assert.equal(busyPorts.status, 409, 'port changes respect the VM lock too');
  release();
  await tasks.wait(holder.id);
}));

test('POST /api/vm/ports on a stopped VM: parsed, validated, saved with the LAN choice', () => withServer(async (s) => {
  st.state.vms.web = st.newVmRecord({ port: 2223, ports: [{ host: 8080, guest: 80, container: 80, owner: 'nginx' }] });
  st.state.vms.db = st.newVmRecord({ port: 2224, ports: [{ host: 5432, guest: 5432 }] });
  const r = await request(s.port, { method: 'POST', path: '/api/vm/ports', headers: s.json, body: { name: 'web', ports: '8080:80, lan:3000' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.applied, 'saved');
  assert.deepEqual(r.json.ports, [
    { host: 8080, guest: 80, lan: false, container: 80, owner: 'nginx' },
    { host: 3000, guest: 3000, lan: true },
  ]);
  const clash = await request(s.port, { method: 'POST', path: '/api/vm/ports', headers: s.json, body: { name: 'web', ports: [{ host: 5432, guest: 1 }] } });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /VM "db"/);
  const own = await request(s.port, { method: 'POST', path: '/api/vm/ports', headers: s.json, body: { name: 'web', ports: '2223:22' } });
  assert.equal(own.status, 400);
}));

test('GET /api/log reads only the tail, never NaN; /api/about gives the MCP config', () => withServer(async (s) => {
  st.state.vms.web = st.newVmRecord({ port: 2223 });
  fs.mkdirSync(CFG.sandboxDir, { recursive: true });
  fs.writeFileSync(st.serialLogPath('web'), Array.from({ length: 1000 }, (_, i) => 'line ' + i).join('\n') + '\n');
  const a = await request(s.port, { path: '/api/log?name=web&tail=abc', headers: s.auth });
  assert.equal(a.status, 200);
  assert.equal(a.json.lines, 300);
  assert.ok(a.json.text.endsWith('line 999'));
  const b = await request(s.port, { path: '/api/log?name=web&tail=999999', headers: s.auth });
  assert.equal(b.json.lines, 1000);
  assert.equal((await request(s.port, { path: '/api/log?name=..%2F..%2Fsecret', headers: s.auth })).status, 400);
  assert.equal((await request(s.port, { path: '/api/log?name=ghost', headers: s.auth })).status, 404);
  assert.equal((await request(s.port, { path: '/api/log?name=@tasks', headers: s.auth })).status, 200);
  const about = await request(s.port, { path: '/api/about', headers: s.auth });
  assert.equal(about.status, 200);
  const cfg = about.json.mcpConfig.mcpServers['devbox-vms'];
  assert.equal(cfg.command, process.execPath);
  assert.equal(path.basename(cfg.args[0]), 'mcp-server.js');
  assert.equal(cfg.env.VM_MANAGER_ROOT, CFG.root);
  assert.equal(about.json.dataRoot, CFG.root);
}));

test('static files: only public/, known types, no traversal or dotfiles', () => withServer(async (s) => {
  const page = await request(s.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assertSecurityHeaders(page);
  const js = await request(s.port, { path: '/vendor/xterm.js' });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  for (const p of ['/vendor/..%2f..%2fserver.js', '/..%2fserver.js', '/%2e%2e/server.js', '/lib/http.js', '/server.js',
    '/.git/config', '/vendor/%00x.js', '/package.json', '/vendor/%2e%2e%5c..%5cserver.js', '/nope.html']) {
    const r = await request(s.port, { path: p });
    assert.ok(r.status === 404 || r.status === 400, p + ' -> ' + r.status);
  }
  const post = await request(s.port, { method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 405);
}));

test('the route table covers the whole spec section 12 API', () => {
  const have = new Set(ROUTES.map((r) => r.method + ' ' + r.path));
  const want = [
    'GET /api/ping', 'GET /api/state', 'GET /api/network', 'GET /api/tasks', 'GET /api/task', 'GET /api/log',
    'GET /api/vm/docker', 'GET /api/vm/docker/logs', 'GET /api/about', 'GET /api/session/stream',
    'POST /api/settings', 'POST /api/setup', 'POST /api/install/qemu', 'POST /api/install/base',
    'POST /api/vm/create', 'POST /api/vm/start', 'POST /api/vm/stop', 'POST /api/vm/restart', 'POST /api/vm/delete',
    'POST /api/vm/reset', 'POST /api/vm/settings', 'POST /api/vm/ports', 'POST /api/vm/resize', 'POST /api/vm/growfs',
    'POST /api/vm/compact', 'POST /api/vm/freeze', 'POST /api/vm/snapshot', 'POST /api/vm/forget',
    'POST /api/session/open', 'POST /api/session/input', 'POST /api/session/resize', 'POST /api/session/close',
    'POST /api/vm/docker/install', 'POST /api/vm/docker/pull', 'POST /api/vm/docker/run', 'POST /api/vm/docker/action',
    'POST /api/vm/docker/rmi', 'POST /api/vm/compose', 'POST /api/vm/docker/inspect', 'POST /api/vm/docker/deploy',
    'POST /api/vm/quickdeploy',
  ];
  for (const w of want) assert.ok(have.has(w), 'missing route ' + w);
  for (const r of ROUTES.filter((x) => x.task)) {
    assert.equal(typeof r.validate, 'function', r.path);
    assert.equal(typeof r.run, 'function', r.path);
  }
});
