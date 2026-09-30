'use strict';
/*
 * End to end: the REAL manager (server.js) with REAL QEMU microVMs, driven
 * through its HTTP API - the matrix of microVM spec section 18.2 and the
 * shared-folder cases of SPEC-shares section 9. OPT-IN: skipped unless
 *   DEVBOX_E2E=1
 * and QEMU, the microVM kernel and the cached approved images are there.
 * It never downloads anything: images come from the cache (pull "missing"
 * finds every one of them).
 *
 *   DEVBOX_E2E_SOURCE   data root to borrow the kernel, the image cache and
 *                       (for the VM cases) the base image and SSH key from
 *                       (default: <app>/data)
 *   DEVBOX_E2E_PORT     port for the manager (default: a free one)
 *   DEVBOX_E2E_VM=1     also the full-VM shared-folder cases (a VM from
 *                       devbox-base.qcow2: minutes)
 *
 * It runs on a SCRATCH data root: the cache files are HARD LINKS (same
 * volume, no copy, the originals are never written); the scratch root and
 * everything the manager creates there is removed afterwards. It tracks the
 * QEMU pids of ITS containers and VMs and ends only those (proven by their
 * command line naming the scratch root) - other QEMUs on this PC are never
 * touched.
 */
const test = require('node:test');
const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const platform = require('../lib/platform');
const { request } = require('./helpers');
const { NinepClient } = require('./helpers/ninep-client');

const APP = path.join(__dirname, '..');
const SOURCE = process.env.DEVBOX_E2E_SOURCE || path.join(APP, 'data');
const WANT_VM = process.env.DEVBOX_E2E_VM === '1';
const IMAGES = ['hello-world', 'alpine', 'busybox', 'nginx:alpine'];

function why() {
  if (process.env.DEVBOX_E2E !== '1') return 'set DEVBOX_E2E=1 to run the real-QEMU end-to-end matrix';
  if (!platform.findTool('qemu')) return 'QEMU is not installed';
  const kdir = path.join(SOURCE, 'kernel');
  let kver = null;
  try { kver = fs.readdirSync(kdir).find((d) => fs.existsSync(path.join(kdir, d, 'manifest.json'))); } catch (e) { kver = null; }
  if (!kver) return 'no microVM kernel in ' + kdir;
  let refs = {};
  try { refs = JSON.parse(fs.readFileSync(path.join(SOURCE, 'images', 'refs.json'), 'utf8')); } catch (e) { return 'no image cache in ' + SOURCE; }
  const missing = IMAGES.filter((i) => !Object.keys(refs).some((r) => r === 'docker.io/library/' + (i.includes(':') ? i : i + ':latest')));
  if (missing.length) return 'images not cached (no downloads here): ' + missing.join(', ');
  return null;
}
const SKIP = why();

let ROOT = null, PORT = 0, TOKEN = null, MANAGER = null, H = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ scratch root
function linkTree(src, dst, filter) {
  let names;
  try { names = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  fs.mkdirSync(dst, { recursive: true });
  for (const d of names) {
    const s = path.join(src, d.name), t = path.join(dst, d.name);
    if (filter && !filter(s, d)) continue;
    if (d.isDirectory()) linkTree(s, t, filter);
    else if (d.isFile()) { try { fs.linkSync(s, t); } catch (e) { fs.copyFileSync(s, t); } }
  }
}
// busybox is left COLD in the scratch root (no boot image, no rootfs
// sidecar): the cold-build case flattens it from the linked blobs
let COLD = null; // its config digest hex (first 12)
function makeScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-'));
  // kernel packages and assets, host facts: shared read-only
  linkTree(path.join(SOURCE, 'kernel'), path.join(root, 'kernel'), (s) => !/\.tmp$|\.part$/.test(s));
  // the image cache: blobs, refs, sidecars and initrds (content-keyed, so a
  // link is exactly what a rebuild would write); index.json is a copy - the
  // manager rewrites it
  const img = path.join(SOURCE, 'images');
  try {
    const refs = JSON.parse(fs.readFileSync(path.join(img, 'refs.json'), 'utf8'));
    const bb = refs['docker.io/library/busybox:latest'];
    COLD = bb && bb.configDigest ? bb.configDigest.slice(7) : null;
  } catch (e) { COLD = null; }
  const notCold = (s) => !COLD || path.basename(s).indexOf(COLD.slice(0, 12)) !== 0;
  linkTree(path.join(img, 'blobs'), path.join(root, 'images', 'blobs'), (s) => !/\.part$/.test(s));
  linkTree(path.join(img, 'rootfs'), path.join(root, 'images', 'rootfs'), (s) => /\.json$/.test(s) && notCold(s));
  linkTree(path.join(img, 'initrd'), path.join(root, 'images', 'initrd'), (s) => /\.initrd$/.test(s) && notCold(s));
  for (const f of ['refs.json', 'index.json']) { try { fs.copyFileSync(path.join(img, f), path.join(root, 'images', f)); } catch (e) { /* rebuilt */ } }
  if (WANT_VM) {
    fs.linkSync(path.join(SOURCE, 'devbox-base.qcow2'), path.join(root, 'devbox-base.qcow2'));
    fs.mkdirSync(path.join(root, 'seed'), { recursive: true });
    for (const f of ['id_dev', 'id_dev.pub']) fs.copyFileSync(path.join(SOURCE, 'seed', f), path.join(root, 'seed', f));
  }
  return root;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startManager() {
  const out = fs.openSync(path.join(ROOT, 'e2e-manager.log'), 'a');
  const child = spawn(process.execPath, [path.join(APP, 'server.js'), '--data', ROOT, '--port', String(PORT), '--no-open'], { stdio: ['ignore', out, out], windowsHide: true });
  fs.closeSync(out);
  const mf = path.join(ROOT, 'run', 'manager.json');
  for (let i = 0; i < 200; i++) {
    try { const j = JSON.parse(fs.readFileSync(mf, 'utf8')); if (j.pid === child.pid) break; } catch (e) { /* not yet */ }
    if (child.exitCode !== null) throw new Error('the manager exited: ' + fs.readFileSync(path.join(ROOT, 'e2e-manager.log'), 'utf8').slice(-2000));
    await sleep(100);
  }
  TOKEN = fs.readFileSync(path.join(ROOT, 'manager-token'), 'utf8').trim();
  H = { 'Content-Type': 'application/json', 'X-DevBox-Token': TOKEN };
  // adoption and share restore run in the background: wait until it answers
  for (let i = 0; i < 100; i++) { try { const r = await api('GET', '/api/state'); if (r.status === 200) break; } catch (e) { /* starting */ } await sleep(200); }
  return child;
}
function stopManager(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
}

// ------------------------------------------------------------ API helpers
async function api(method, p, body) { return request(PORT, { method, path: p, headers: H, body }); }
async function task(id, ms) {
  const end = Date.now() + (ms || 180000);
  for (;;) {
    const r = await api('GET', '/api/task?id=' + encodeURIComponent(id));
    const t = r.json && r.json.task;
    if (t && t.status !== 'running' && t.status !== 'queued') return t;
    if (Date.now() > end) throw new Error('task ' + id + ' still running');
    await sleep(250);
  }
}
async function run(body, ms) {
  const r = await api('POST', '/api/container/run', Object.assign({ createdBy: 'api', ephemeral: true }, body));
  if (r.status !== 202) return { status: r.status, json: r.json };
  const t = await task(r.json.task.id, ms);
  return { status: 202, id: r.json.container && r.json.container.id, task: t, start: r.json };
}
async function rec(id) { const r = await api('GET', '/api/container?id=' + id); return r.json && r.json.container; }
async function until(fn, ms, what) {
  const end = Date.now() + (ms || 30000);
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + (what || 'condition')); await sleep(200); }
}
async function ended(id, ms) { return until(async () => { const r = await rec(id); return r && (r.status === 'exited' || r.status === 'error') ? r : null; }, ms || 60000, 'container ' + id + ' to end'); }
async function logs(id, stream) { const r = await api('GET', '/api/container/logs?id=' + id + '&stream=' + stream + '&tail=5000'); return (r.json && r.json.text) || ''; }
async function stop(id, o) {
  const r = await api('POST', '/api/container/stop', Object.assign({ id }, o || {}));
  assert.equal(r.status, 202, r.text);
  return task(r.json.task.id, 120000);
}
async function remove(id) { return api('POST', '/api/container/remove', { id, force: true }); }
function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p || '/', timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}
const qp = async () => { const s = await freePort(); return s; };

// ------------------------------------------------------------ teardown
async function endOurQemus() {
  // ours: the runtime pids in the scratch registries whose command line
  // names the scratch root (their initrd, disks and logs live there)
  const pids = new Set();
  for (const f of ['containers.json', 'vms.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const r of Object.values(j.containers || j.vms || {})) if (r && r.runtime && r.runtime.pid) pids.add(r.runtime.pid);
    } catch (e) { /* none */ }
  }
  for (const pid of pids) {
    if (!platform.pidAlive(pid)) continue;
    const cmd = await platform.processCommandLine(pid);
    if (cmd && cmd.indexOf(path.basename(ROOT)) !== -1 && /qemu-system/i.test(cmd)) platform.killPid(pid);
  }
}

describe('microVM end to end (real QEMU)', { skip: SKIP || false }, () => {
  before(async () => {
    ROOT = makeScratch();
    PORT = process.env.DEVBOX_E2E_PORT ? parseInt(process.env.DEVBOX_E2E_PORT, 10) : await freePort();
    MANAGER = await startManager();
  });
  after(async () => {
    try {
      const r = await api('GET', '/api/containers');
      for (const c of (r.json && r.json.containers) || []) await remove(c.id);
      const s = await api('GET', '/api/state');
      for (const v of (s.json && s.json.vms) || []) {
        const d = await api('POST', '/api/vm/delete', { name: v.name, force: true });
        if (d.status === 202) await task(d.json.task.id, 180000).catch(() => {});
      }
    } catch (e) { /* the manager may be gone */ }
    await stopManager(MANAGER);
    await endOurQemus();
    await sleep(500);
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* a file held briefly */ }
  });

  test('hello-world: its greeting on stdout, exit 0', async () => {
    const r = await run({ image: 'hello-world' });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const c = await ended(r.id);
    assert.equal(c.exitCode, 0);
    assert.match(await logs(r.id, 'stdout'), /Hello from Docker!/);
    await remove(r.id);
  });

  test('alpine: exit code and separate stdout / stderr', async () => {
    const r = await run({ image: 'alpine', cmd: ['sh', '-c', 'echo hi; echo err >&2; exit 3'] });
    const c = await ended(r.id);
    assert.equal(c.exitCode, 3);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'hi');
    assert.equal((await logs(r.id, 'stderr')).trim(), 'err');
    await remove(r.id);
  });

  test('errors: a missing command is 127 and an unknown user 126, both with the reason', async () => {
    const a = await run({ image: 'alpine', cmd: ['/no/such/cmd'] });
    const ca = await ended(a.id);
    assert.equal(ca.exitCode, 127);
    assert.ok(ca.exitReason, 'a reason');
    const b = await run({ image: 'alpine', cmd: ['true'], user: 'nobody-here' });
    const cb = await ended(b.id);
    assert.equal(cb.exitCode, 126);
    assert.match(cb.exitReason, /unable to find user/);
    await remove(a.id); await remove(b.id);
  });

  test('nginx:alpine: HTTP 200 on this PC only; a graceful stop keeps the record', async () => {
    const hp = await qp();
    const r = await run({ image: 'nginx:alpine', ports: [hp + ':80'] });
    assert.equal(r.task.status, 'done', r.task.error);
    const res = await until(async () => { const g = await get(hp); return g.status === 200 ? g : null; }, 20000, 'nginx to answer');
    assert.match(res.body, /nginx/i);
    const c = await rec(r.id);
    assert.equal(c.ports[0].lan, false);
    assert.ok(!c.urls[0].lanUrls, 'no LAN address');
    const s = await stop(r.id);
    assert.equal(s.status, 'done', s.error);
    assert.equal(s.result.how, 'graceful');
    assert.ok((await rec(r.id)), 'kept until Remove');
    await remove(r.id);
  });

  test('a squatter on 127.0.0.1:P makes a LAN port on P fail up front (V7)', async () => {
    const squat = net.createServer();
    await new Promise((r) => squat.listen(0, '127.0.0.1', r));
    try {
      const r = await run({ image: 'nginx:alpine', ports: ['lan:' + squat.address().port + ':80'] });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'PORT_CONFLICT');
    } finally { squat.close(); }
  });

  test('live shared folder: nginx serves a folder of this PC, and an edit on this PC is served at once (SPEC-shares 9)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'first version\n');
    const hp = await qp();
    const r = await run({ image: 'nginx:alpine', ports: [hp + ':80'], volumes: [dir + ':/usr/share/nginx/html:ro'] });
    try {
      assert.equal(r.task.status, 'done', r.task.error);
      await until(async () => (await get(hp)).body === 'first version\n', 20000, 'the first version');
      fs.writeFileSync(path.join(dir, 'index.html'), 'second version\n');
      await until(async () => (await get(hp)).body === 'second version\n', 5000, 'the edit to be served');
      // the share's secret: a wrong one is refused by the 9P server
      const sh = await api('GET', '/api/shares?owner=' + r.id);
      assert.equal(sh.status, 200);
      assert.ok(!sh.text.includes('secret'), 'no secret in the API');
      const c9 = await NinepClient.connect({ port: sh.json.port, host: '127.0.0.1', timeoutMs: 3000 });
      try {
        await c9.version(65536);
        await assert.rejects(c9.attach(0, sh.json.shares[0].id + ':' + 'x'.repeat(32), { uname: 'boot-e2e' }));
      } finally { c9.close(); }
    } finally {
      await stop(r.id); await remove(r.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a volume below a shared folder is mounted after it, not hidden by it (correct-1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-proj-'));
    try {
      const r = await run({ image: 'alpine', volumes: [dir + ':/app', 'e2e-nm:/app/nm'], cmd: ['sh', '-c', 'echo in-volume >/app/nm/x && echo on-host >/app/y && cat /proc/mounts | grep -c " /app/nm "'] });
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, c.exitReason || '');
      assert.equal((await logs(r.id, 'stdout')).trim(), '1', 'the volume is mounted at /app/nm');
      assert.equal(fs.readFileSync(path.join(dir, 'y'), 'utf8'), 'on-host\n');
      assert.ok(!fs.existsSync(path.join(dir, 'nm', 'x')), 'the file went to the volume, not to the folder on this PC');
      const r2 = await run({ image: 'alpine', volumes: ['e2e-nm:/data'], cmd: ['cat', '/data/x'] });
      await ended(r2.id);
      assert.equal((await logs(r2.id, 'stdout')).trim(), 'in-volume');
      await remove(r.id); await remove(r2.id);
    } finally {
      await api('POST', '/api/volume/remove', { name: 'e2e-nm' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('volume race: two runs on one volume at once - one gets VOLUME_IN_USE (V1)', async () => {
    const body = { image: 'alpine', volumes: ['e2e-race:/data'], cmd: ['sh', '-c', 'echo x >/data/f; sleep 5'] };
    const [a, b] = await Promise.all([run(body), run(body)]);
    const errs = [a, b].filter((x) => x.task && x.task.status === 'error');
    assert.equal(errs.length, 1, JSON.stringify([a.task && a.task.error, b.task && b.task.error]));
    assert.match(errs[0].task.error, /in use/);
    for (const x of [a, b]) { await ended(x.id, 30000).catch(() => {}); await remove(x.id); }
    await api('POST', '/api/volume/remove', { name: 'e2e-race' });
  });

  test('stop during boot at 0, 500 and 1000 ms: never left running, never the 15 s force (V2)', async () => {
    for (const ms of [0, 500, 1000]) {
      const r = await api('POST', '/api/container/run', { image: 'alpine', cmd: ['sleep', '30'], createdBy: 'api' });
      assert.equal(r.status, 202);
      const id = r.json.container.id;
      await sleep(ms);
      const t0 = Date.now();
      const s = await stop(id, { timeoutS: 2 });
      assert.equal(s.status, 'done', s.error);
      assert.ok(Date.now() - t0 < 15000, 'took ' + (Date.now() - t0) + ' ms');
      assert.ok(/stopped before the app started|graceful|killed/.test(s.result.how), s.result.how);
      await ended(id, 20000);
      await remove(id);
    }
  });

  test('4 concurrent runs all start, each with its own control endpoints (V3)', async () => {
    const rs = await Promise.all([0, 1, 2, 3].map(() => run({ image: 'hello-world' })));
    for (const r of rs) {
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, JSON.stringify(c.exitReason));
      await remove(r.id);
    }
  });

  test('3 concurrent cold builds of one image: all start, one boot image is built (V4)', async (t) => {
    if (!COLD) { t.skip('busybox is not in the cache'); return; }
    const dir = path.join(ROOT, 'images', 'initrd');
    const before = fs.readdirSync(dir).filter((f) => f.startsWith(COLD.slice(0, 12)));
    assert.deepEqual(before, [], 'cold at the start');
    const rs = await Promise.all([0, 1, 2].map(() => run({ image: 'busybox', cmd: ['echo', 'cold-ok'] })));
    for (const r of rs) {
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, c.exitReason || '');
      assert.equal((await logs(r.id, 'stdout')).trim(), 'cold-ok');
      await remove(r.id);
    }
    const after = fs.readdirSync(dir).filter((f) => f.startsWith(COLD.slice(0, 12)) && /\.initrd$/.test(f));
    assert.equal(after.length, 1, 'one build: ' + after.join(', '));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), [], 'no temp file left');
  });

  test('copy-in: nested folders, a script made executable, owned by the container user', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-copyin-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'a.txt'), 'copied\n');
      fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho ran\n');
      const r = await run({ image: 'alpine', user: 'nobody', copyIn: [dir + ':/in'], cmd: ['sh', '-c', 'cat /in/sub/deeper/a.txt; stat -c "%a %U" /in/run.sh; /in/run.sh'] });
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, c.exitReason || '');
      assert.deepEqual((await logs(r.id, 'stdout')).trim().split('\n'), ['copied', '755 nobody', 'ran']);
      await remove(r.id);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('TCG (no hardware acceleration): hello-world and nginx still run, with the warning', async () => {
    const t0 = Date.now();
    const r = await run({ image: 'hello-world', accel: 'tcg' });
    const c = await ended(r.id, 60000);
    assert.equal(c.exitCode, 0, c.exitReason || '');
    assert.ok(Date.now() - t0 < 30000, 'within 30 s: ' + (Date.now() - t0) + ' ms');
    assert.ok((c.warnings || []).some((w) => /TCG/.test(w)), 'says it is not a security boundary');
    await remove(r.id);
    const hp = await qp();
    const n = await run({ image: 'nginx:alpine', accel: 'tcg', ports: [hp + ':80'] }, 120000);
    assert.equal(n.task.status, 'done', n.task.error);
    await until(async () => (await get(hp)).status === 200, 30000, 'nginx under TCG');
    const s = await stop(n.id);
    assert.equal(s.status, 'done', s.error);
    await remove(n.id);
  });

  test('a forced stop keeps what was written to a volume just before (V5)', async () => {
    const r = await run({ image: 'alpine', volumes: ['e2e-v5:/data'], cmd: ['sh', '-c', 'echo kept >/data/f; sync; sleep 60'] });
    await sleep(1500);
    const s = await stop(r.id, { timeoutS: 1 });
    assert.equal(s.status, 'done', s.error);
    const r2 = await run({ image: 'alpine', volumes: ['e2e-v5:/data'], cmd: ['cat', '/data/f'] });
    await ended(r2.id);
    assert.equal((await logs(r2.id, 'stdout')).trim(), 'kept');
    await remove(r.id); await remove(r2.id);
    await api('POST', '/api/volume/remove', { name: 'e2e-v5' });
  });

  test('filling the RAM root gives ENOSPC and a normal exit, not a panic (V6)', async () => {
    const r = await run({ image: 'alpine', mem: 256, cmd: ['sh', '-c', 'dd if=/dev/zero of=/tmp/fill bs=1M count=400 2>&1; echo rc=$?'] });
    const c = await ended(r.id, 90000);
    assert.notEqual(c.exitCode, 125, c.exitReason || '');
    assert.match(await logs(r.id, 'stdout'), /No space left on device|rc=1/);
    await remove(r.id);
  });

  test('a start of a large memory request above what is free is refused (MEMORY_BUDGET)', async (t) => {
    const want = Math.floor(os.freemem() / 1048576) + 1024;
    const r = await run({ image: 'hello-world', mem: want });
    if (r.status === 400) { t.skip('the memory limit of this manager is below the free memory'); return; }
    assert.equal(r.task.status, 'error');
    assert.match(r.task.error, /not enough free memory/);
    await remove(r.id);
  });

  test('QEMU cannot be replaced while a container runs (409)', async () => {
    const hp = await qp();
    const r = await run({ image: 'nginx:alpine', ports: [hp + ':80'] });
    try {
      const q = await api('POST', '/api/install/qemu', {});
      assert.equal(q.status === 409 || q.status === 400, true, q.text);
      if (q.status === 409 && platform.findTool('7z')) assert.equal(q.json.code, 'VMS_RUNNING');
    } finally { await stop(r.id); await remove(r.id); }
  });

  test('manager restart: the container keeps running, is re-adopted, its live share is re-mounted, and stops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-restart-'));
    fs.writeFileSync(path.join(dir, 'index.html'), 'before restart\n');
    const hp = await qp();
    const r = await run({ image: 'nginx:alpine', ports: [hp + ':80'], volumes: [dir + ':/usr/share/nginx/html'] });
    try {
      assert.equal(r.task.status, 'done', r.task.error);
      await until(async () => (await get(hp)).body === 'before restart\n', 20000, 'the page');
      await stopManager(MANAGER);
      MANAGER = await startManager();
      await until(async () => { const c = await rec(r.id); return c && c.status === 'running' && c.live ? c : null; }, 30000, 'the re-adoption');
      fs.writeFileSync(path.join(dir, 'index.html'), 'after restart\n');
      // the guest heals its dead 9P mount within a few seconds
      await until(async () => (await get(hp)).body === 'after restart\n', 30000, 'the re-mounted share to serve the edit');
      const s = await stop(r.id);
      assert.equal(s.status, 'done', s.error);
      assert.equal(s.result.how, 'graceful');
    } finally { await remove(r.id); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('MCP: run_image hello-world with wait_for "exit" returns its output and exit 0', async () => {
    const env = Object.assign({}, process.env, { VM_MANAGER_ROOT: ROOT, VM_MANAGER_PORT: String(PORT) });
    const child = spawn(process.execPath, [path.join(APP, 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); w(m); }
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const r = await rpc('tools/call', { name: 'run_image', arguments: { image: 'hello-world', wait_for: 'exit', remove_on_exit: true } });
      assert.ok(r.result && !r.result.isError, JSON.stringify(r));
      const v = JSON.parse(r.result.content[0].text);
      assert.equal(v.exit_code, 0);
      assert.match(v.stdout, /Hello from Docker!/);
    } finally { child.kill(); }
  });

  test('full VM: a live shared folder both ways, read-only, back after a reboot inside the VM, shared by two VMs, removed while running (SPEC-shares 9)', { skip: !WANT_VM && 'set DEVBOX_E2E_VM=1 (boots two full VMs: about a minute)' }, async () => {
    const config = require('../lib/config');
    const ssh = require('../lib/ssh');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-vmshare-'));
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-e2e-vmro-'));
    fs.writeFileSync(path.join(dir, 'from-host.txt'), 'hello from the host\n');
    const name = 'e2e-share';
    const c = await api('POST', '/api/vm/create', { name, start: true, mem: 1024, ephemeral: true });
    assert.equal(c.status, 202, c.text);
    const ct = await task(c.json.task.id, 900000);
    assert.equal(ct.status, 'done', ct.error);
    const add = await api('POST', '/api/vm/shares', { name, action: 'add', hostPath: dir, guestPath: '/mnt/proj' });
    assert.equal(add.status, 200, add.text);
    assert.equal(add.json.applied, 'live');
    const addRo = await api('POST', '/api/vm/shares', { name, action: 'add', hostPath: ro, guestPath: '/mnt/ro', readOnly: true });
    assert.equal(addRo.status, 200, addRo.text);
    config.configure({ data: ROOT });
    const vm = (await api('GET', '/api/state')).json.vms.find((x) => x.name === name);
    const sh = (cmd) => ssh.sshExec({ name, port: vm.port }, cmd, { timeoutMs: 60000, connectTimeout: 10 });
    await until(async () => /hello from the host/.test((await sh('cat /mnt/proj/from-host.txt')).stdout || ''), 60000, 'the host file in the VM');
    await sh('echo from-vm > /mnt/proj/from-vm.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'from-vm.txt'), 'utf8'), 'from-vm\n', 'written in the VM, saved on this PC');
    const w = await sh('touch /mnt/ro/x 2>&1; echo rc=$?');
    assert.match(w.stdout, /Read-only|rc=1/);
    // a reboot INSIDE the VM: QEMU still has the (empty) list it started
    // with, so the manager notices the new boot and mounts the shares again
    await sh('(sleep 1; reboot) >/dev/null 2>&1 &');
    await sleep(8000);
    await until(async () => { try { return /hello from the host/.test((await sh('cat /mnt/proj/from-host.txt')).stdout || ''); } catch (e) { return false; } }, 180000, 'the share back after the reboot');
    // a second VM sharing the same folder through its own share
    const name2 = 'e2e-share2';
    const c2 = await api('POST', '/api/vm/create', { name: name2, start: true, mem: 1024, ephemeral: true });
    assert.equal(c2.status, 202, c2.text);
    assert.equal((await task(c2.json.task.id, 900000)).status, 'done');
    const add2 = await api('POST', '/api/vm/shares', { name: name2, action: 'add', hostPath: dir, guestPath: '/mnt/same' });
    assert.equal(add2.status, 200, add2.text);
    const vm2 = (await api('GET', '/api/state')).json.vms.find((x) => x.name === name2);
    const sh2 = (cmd) => ssh.sshExec({ name: name2, port: vm2.port }, cmd, { timeoutMs: 60000, connectTimeout: 10 });
    await until(async () => /from-vm/.test((await sh2('cat /mnt/same/from-vm.txt')).stdout || ''), 60000, 'VM 2 sees what VM 1 wrote');
    const d2 = await api('POST', '/api/vm/delete', { name: name2, force: true });
    if (d2.status === 202) await task(d2.json.task.id, 180000);
    const rm = await api('POST', '/api/vm/shares', { name, action: 'remove', guestPath: '/mnt/proj' });
    assert.equal(rm.status, 200, rm.text);
    const after = await sh('cat /mnt/proj/from-host.txt 2>&1; echo rc=$?');
    assert.ok(!/hello from the host/.test(after.stdout), 'access revoked');
    const d = await api('POST', '/api/vm/delete', { name, force: true });
    if (d.status === 202) await task(d.json.task.id, 180000);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ro, { recursive: true, force: true });
  });
});
