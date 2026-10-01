'use strict';
/*
 * The container registry file (lib/microvm/store.js, vms.json's rules) and
 * the hooks the rest of the app calls into lib/microvm/containers.js: the
 * /api/state summaries (env never shown), port reservations shared with VMs,
 * network rows, the QEMU-install guard, the route table (implemented, token-
 * protected, errors mapped) and task/lock plumbing (spec.ctr,
 * ctr:<id>/ctr-stop:<id>). The lifecycle itself: microvm-supervisor.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { CFG } = config;
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const ports = require('../lib/ports');
const platform = require('../lib/platform');
const store = require('../lib/microvm/store');
const containers = require('../lib/microvm/containers');
const route = require('../lib/route');
const { createServer, ROUTES } = require('../lib/http');
const { useTempRoot, resetConfig, rm, request } = require('./helpers');

const rec = (o) => Object.assign({
  id: '3f9c1a2b7d4e', name: 'nginx-3f9c', image: 'nginx:alpine', reference: 'docker.io/library/nginx:alpine',
  createdAt: '2026-09-30T10:00:00.000Z', env: ['SECRET_TOKEN=hunter2'], ports: [{ host: 18080, guest: 80, proto: 'tcp', lan: false }],
  status: 'exited', exitCode: 0, runtime: null,
}, o || {});

test('store: empty start, save only on change (atomic, .bak), unknown fields kept, reload', () => {
  const root = useTempRoot('store');
  try {
    store.load();
    assert.deepEqual(store.list(), []);
    assert.equal(store.save(), true);
    assert.equal(fs.readFileSync(CFG.containersFile, 'utf8'), JSON.stringify({ version: 1, containers: {} }, null, 2) + '\n');
    const m1 = fs.statSync(CFG.containersFile).mtimeMs;
    assert.equal(store.save(), true, 'unchanged: nothing written');
    assert.equal(fs.statSync(CFG.containersFile).mtimeMs, m1);
    store.put(rec({ futureField: { x: 1 } }));
    store.save();
    assert.ok(fs.existsSync(CFG.containersFile + '.bak'), 'the previous file is kept as .bak');
    assert.deepEqual(fs.readdirSync(CFG.root).filter((f) => /\.tmp$/.test(f)), []);
    store.load();
    assert.deepEqual(store.get('3f9c1a2b7d4e').futureField, { x: 1 }, 'fields this version does not know survive');
    assert.equal(store.get('nope'), null);
    assert.throws(() => store.put({ id: 'short' }), /12-hex/);
    assert.equal(store.remove('3f9c1a2b7d4e'), true);
    assert.equal(store.remove('3f9c1a2b7d4e'), false);
    assert.match(store.newId(), /^[0-9a-f]{12}$/);
    assert.equal(store.isId('3F9C1A2B7D4E'), false);
  } finally { resetConfig(); rm(root); store.load(); }
});

test('store: a damaged file is kept aside and never overwritten; the .bak restores; bad records dropped with a warning', () => {
  const root = useTempRoot('store-bad');
  try {
    store.load();
    store.put(rec());
    store.save();
    store.put(rec({ id: 'aaaaaaaaaaaa', name: 'second' }));
    store.save(); // .bak now holds the first version
    fs.writeFileSync(CFG.containersFile, '{ not json');
    store.load();
    const aside = fs.readdirSync(CFG.root).filter((f) => f.startsWith('containers.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(CFG.root, aside[0]), 'utf8'), '{ not json');
    assert.deepEqual(store.list().map((r) => r.id), ['3f9c1a2b7d4e'], 'restored from containers.json.bak');
    assert.match(store.warning(), /could not be parsed/);
    assert.match(containers.stateWarning(), /could not be parsed/);
    fs.writeFileSync(CFG.containersFile, JSON.stringify({ version: 1, containers: { 'bad id': {}, bbbbbbbbbbbb: 'x', cccccccccccc: rec({ id: 'wrong' }) } }));
    store.load();
    assert.deepEqual(store.list().map((r) => r.id), ['cccccccccccc'], 'the key is the id');
    assert.match(store.warning(), /not valid/);
    // written by a newer app: read, but never written back
    fs.writeFileSync(CFG.containersFile, JSON.stringify({ version: 2, containers: {} }));
    store.load();
    store.put(rec());
    assert.equal(store.save(), false);
    assert.equal(JSON.parse(fs.readFileSync(CFG.containersFile, 'utf8')).version, 2);
    assert.match(store.warning(), /newer version/);
  } finally { resetConfig(); rm(root); store.load(); }
});

test('hooks: summaries without env values, reserved ports shared with VMs, network rows, running containers', async () => {
  const root = useTempRoot('hooks');
  try {
    st.loadState();
    containers.load();
    assert.deepEqual(containers.summaries(), []);
    store.put(rec());
    store.put(rec({ id: 'bbbbbbbbbbbb', name: 'dns', ports: [{ host: 15353, guest: 53, proto: 'udp', lan: true }], runtime: { pid: process.pid, memMB: 256 }, status: 'running' }));
    const s = containers.summaries();
    assert.equal(s.length, 2);
    assert.ok(!JSON.stringify(s).includes('hunter2') && !JSON.stringify(s).includes('SECRET_TOKEN'), 'env names and values stay out of /api/state');
    assert.deepEqual(s[0].urls, [{ url: 'http://127.0.0.1:18080/', hostPort: 18080, lan: false }]);
    assert.deepEqual(s[1].urls, [], 'udp: no URL');
    assert.equal(s[1].mem, 256);
    // VMs and deploys can never take a container's port, running or not
    const r = ports.reservedPorts();
    assert.match(r.get(18080), /container "nginx-3f9c"/);
    assert.match(r.get(15353), /container "dns"/);
    assert.ok(!ports.reservedPorts({ exceptContainer: '3f9c1a2b7d4e' }).has(18080));
    await assert.rejects(ports.validateMappings('somevm', [{ host: 18080, guest: 80, lan: false }]), (e) => e.code === 'PORT_CONFLICT');
    const rows = containers.networkRows();
    assert.deepEqual(rows.map((x) => [x.kind, x.host, x.proto, x.owner]), [['container', 18080, 'tcp', 'container nginx-3f9c'], ['container', 15353, 'udp', 'container dns']]);
    // running = its QEMU pid is in the (one, shared) process listing
    assert.deepEqual(await containers.runningContainers(new Set([process.pid])), [{ id: 'bbbbbbbbbbbb', name: 'dns', pid: process.pid }]);
    assert.deepEqual(await containers.runningContainers(new Set()), []);
    // the Network view lists them (the listing itself may be unavailable)
    const net = await require('../lib/vm').networkOverview();
    const ctrRows = net.rows.filter((x) => x.kind === 'container');
    assert.deepEqual(ctrRows.map((x) => x.host).sort(), [15353, 18080]);
    assert.equal(ctrRows.find((x) => x.proto === 'udp').listening, false, 'the TCP listener list says nothing about UDP');
  } finally { resetConfig(); rm(root); store.load(); }
});

test('microvmStatus: not ready without QEMU or kernel, with the reason', () => {
  const root = useTempRoot('mvstatus');
  const orig = platform.findTool;
  try {
    platform.findTool = () => null;
    const a = containers.microvmStatus();
    assert.deepEqual([a.ready, a.kver], [false, null]);
    assert.match(a.reason, /QEMU/);
    platform.findTool = (n) => (n === 'qemu' ? '/fake/qemu' : null);
    const b = containers.microvmStatus();
    assert.equal(b.ready, false);
    assert.match(b.reason, /kernel is not installed/);
  } finally { platform.findTool = orig; resetConfig(); rm(root); }
});

test('run: a bad field is a 400 even before Setup (checked before NO_KERNEL / PREREQ_MISSING)', async () => {
  const root = useTempRoot('run-order');
  const orig = platform.findTool;
  try {
    store.load();
    platform.findTool = (n) => (n === 'qemu' ? '/fake/qemu' : null); // no kernel installed
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', rootfs: 'tmpfs' }), (e) => e.status === 400 && /rootfs must be disk or ram/.test(e.message));
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', mem: 64 }), (e) => e.status === 400 && e.code === 'MEMORY_TOO_SMALL');
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', ports: ['notaport'] }), (e) => e.status === 400);
    // a valid request still says what is missing
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine' }), (e) => e.status === 409 && e.code === 'NO_KERNEL');
    platform.findTool = () => null;
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', rootfs: 'tmpfs' }), (e) => e.status === 400);
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine' }), (e) => e.status === 409 && e.code === 'PREREQ_MISSING');
    assert.deepEqual(store.list(), [], 'no record for a refused run');
  } finally { platform.findTool = orig; resetConfig(); rm(root); store.load(); }
});

test('tasks: spec.ctr is in the summary; ctr:<id> and ctr-stop:<id> are separate locks', async () => {
  tasks._reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = tasks.start({ kind: 'ctr-run', title: 'Run nginx', ctr: '3f9c1a2b7d4e', locks: ['ctr:3f9c1a2b7d4e'] }, () => gate);
  assert.equal(run.ctr, '3f9c1a2b7d4e');
  assert.equal(run.vm, null);
  assert.equal(tasks.ctrBusy('3f9c1a2b7d4e'), run.id);
  // a stop is accepted while the run still pulls or boots
  const stop = tasks.start({ kind: 'ctr-stop', title: 'Stop nginx', ctr: '3f9c1a2b7d4e', locks: ['ctr-stop:3f9c1a2b7d4e'] }, async () => 'stopped');
  assert.equal((await tasks.wait(stop.id)).status, 'done');
  assert.throws(() => tasks.start({ kind: 'ctr-start', locks: ['ctr:3f9c1a2b7d4e'] }, async () => {}), (e) => e.code === 'BUSY');
  release();
  await tasks.wait(run.id);
  assert.equal(tasks.ctrBusy('3f9c1a2b7d4e'), null);
  tasks._reset();
});

test('route helpers: taskRoute carries vm/ctr, accepted() answers 202', () => {
  const r = route.taskRoute({ path: '/x', kind: 'k', validate: () => ({}), run: async () => {} });
  assert.deepEqual(r.task.locks({ name: 'a' }), ['vm:a']);
  assert.equal(r.task.vm({ name: 'a' }), 'a');
  assert.equal(r.task.ctr({}), null);
  const out = route.accepted({ id: 't1' }, { engine: 'docker-vm' });
  assert.equal(route.statusOf(out), 202);
  assert.equal(route.statusOf({}), 200);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { task: { id: 't1' }, engine: 'docker-vm' }, 'the status is not part of the body');
});

// every container/image/volume/share route exists and is behind the token;
// the engine's routes are implemented (bodies below are chosen so that
// nothing is pulled or created: each answers a 4xx or an empty listing)
test('HTTP: the microVM and shared-folder routes are registered, token-protected and implemented', async () => {
  const root = useTempRoot('routes');
  tasks._reset();
  st.loadState();
  containers.load();
  const token = config.ensureToken();
  const server = createServer({ token: token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const json = { 'Content-Type': 'application/json', 'X-DevBox-Token': token };
  try {
    const want = ['GET /api/containers', 'GET /api/container', 'GET /api/container/logs', 'GET /api/container/logs/stream', 'GET /api/images', 'GET /api/volumes',
      'POST /api/container/run', 'POST /api/container/start', 'POST /api/container/stop', 'POST /api/container/kill', 'POST /api/container/remove',
      'POST /api/container/settings', 'POST /api/container/fallback', 'POST /api/image/pull', 'POST /api/image/remove', 'POST /api/images/prune',
      'POST /api/volume/create', 'POST /api/volume/remove', 'POST /api/install/kernel', 'GET /api/shares', 'POST /api/vm/shares', 'GET /api/fs/dirs'];
    const served = ROUTES.map((r) => r.method + ' ' + r.path);
    for (const w of want) assert.ok(served.includes(w), w);
    assert.equal(new Set(served).size, served.length, 'no route twice');
    const bodies = {
      'POST /api/container/run': { image: 'Not A Ref!' },
      'POST /api/image/pull': { image: 'Not A Ref!' },
      'POST /api/image/remove': { image: 'nosuch:1' },
      'POST /api/images/prune': {},
      'POST /api/volume/create': { name: '../bad' },
      'POST /api/volume/remove': { name: 'nosuch' },
    };
    const engine = want.filter((x) => x !== 'POST /api/install/kernel' && !/shares|fs\/dirs/.test(x));
    for (const w of want.filter((x) => x !== 'POST /api/install/kernel')) {
      const [method, p] = w.split(' ');
      const noAuth = await request(port, { method, path: p, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? {} : undefined });
      assert.equal(noAuth.status, 401, w + ' needs the token');
      if (!engine.includes(w)) continue; // the shared-folder routes belong to lib/shares.js
      if (w === 'GET /api/container/logs/stream') {
        const r = await request(port, { method, path: p + '?id=nosuch&token=' + token, headers: json });
        assert.equal(r.status, 404, r.text);
        continue;
      }
      const r = await request(port, { method, path: p + (method === 'GET' ? '?id=nosuch' : ''), headers: json, body: method === 'POST' ? (bodies[w] || { id: 'nosuch' }) : undefined });
      assert.notEqual(r.status, 501, w + ': ' + r.text);
      assert.ok([200, 202, 400, 404, 409].includes(r.status), w + ': ' + r.status + ' ' + r.text);
      if (r.status >= 400) assert.ok(r.json && r.json.ok === false && r.json.code, w);
    }
    const none = await request(port, { path: '/api/container?id=nosuch', headers: json });
    assert.deepEqual([none.status, none.json.code], [404, 'NO_SUCH_CONTAINER']);
    const badRef = await request(port, { method: 'POST', path: '/api/container/run', headers: json, body: { image: 'Not A Ref!' } });
    assert.deepEqual([badRef.status, badRef.json.code], [400, 'BAD_REFERENCE']);
    const list = await request(port, { path: '/api/containers', headers: json });
    assert.deepEqual(list.json.containers, []);
    // /api/state carries the containers and the microVM readiness
    const s = await request(port, { path: '/api/state', headers: json });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.containers, []);
    assert.equal(typeof s.json.microvm.ready, 'boolean');
    assert.ok('microvm' in s.json.prereqs, 'the "microVM kernel" prerequisite row');
    assert.equal(s.json.prereqs.microvm.action, 'install-kernel');
    assert.equal(s.json.prereqs.microvm.required, false);
  } finally {
    await new Promise((r) => server.close(r));
    tasks._reset();
    resetConfig();
    rm(root);
  }
});

test('POST /api/install/kernel: refused up front without QEMU (409), otherwise a task', async () => {
  const install = require('../lib/install');
  const orig = platform.findTool;
  try {
    platform.findTool = () => null;
    await assert.rejects(install.validateInstallKernel({}), (e) => e.status === 409 && e.code === 'PREREQ_MISSING');
    platform.findTool = (n) => (n === 'qemu' ? '/fake/qemu' : null);
    assert.deepEqual(await install.validateInstallKernel({ update: true }), { update: true });
    const r = ROUTES.find((x) => x.path === '/api/install/kernel');
    assert.deepEqual([r.task.kind, r.task.locks({})], ['install-kernel', ['kernel']]);
  } finally { platform.findTool = orig; }
});
