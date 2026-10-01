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
 *   DEVBOX_E2E_VM=1     also the full-VM cases (VMs from devbox-base.qcow2:
 *                       minutes; with DEVBOX_E2E_VM_TCG=1 also a light-
 *                       profile VM under forced TCG: several minutes more)
 *   DEVBOX_E2E_BIG=0    skip the synthetic ~600 MB image (built locally in
 *                       the scratch cache: about a minute)
 *   DEVBOX_E2E_MAX_GUESTS  how many guests may run at once (default 3; the
 *                       concurrency cases use this many)
 *   DEVBOX_E2E_REPORT   a file to write the measurements to (JSON)
 *
 * The default root file system is the DISK root (SPEC-diskroot): every case
 * below runs on it unless it asks for rootfs "ram"; the disk-root section
 * adds the cases of SPEC-diskroot section 14.2 - among them the guest-view
 * check (what a container sees of its image disk, listed from inside the
 * guest, equals the tree built on this PC, for every cached approved image
 * and a synthetic edge image) and, LAST because it empties the scratch
 * cache, the prune of image disks and disk boot archives (files back-dated
 * past the 10-minute age rule).
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
const WANT_VM_TCG = WANT_VM && process.env.DEVBOX_E2E_VM_TCG === '1';
const WANT_BIG = process.env.DEVBOX_E2E_BIG !== '0';
const MAX_GUESTS = Math.max(2, parseInt(process.env.DEVBOX_E2E_MAX_GUESTS || '3', 10) || 3);
const IMAGES = ['hello-world', 'alpine', 'busybox', 'nginx:alpine'];
// cached in the source (optional: their cases skip without them)
function cachedImage(ref) {
  try {
    const refs = JSON.parse(fs.readFileSync(path.join(SOURCE, 'images', 'refs.json'), 'utf8'));
    const canon = ref.includes('/') ? 'docker.io/' + ref : 'docker.io/library/' + ref;
    return !!refs[canon.includes(':') ? canon : canon + ':latest'];
  } catch (e) { return false; }
}
// measurements for the report (DEVBOX_E2E_REPORT), also printed as test
// diagnostics
const REPORT = {};
function note(t, key, value) {
  REPORT[key] = value;
  try { t.diagnostic(key + ': ' + JSON.stringify(value)); } catch (e) { /* no diagnostics */ }
}

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
  // never the disk-root boot archives (disk-*.initrd): a cache hit refreshes
  // a file's mtime (rootdisk.ensureDiskInitrd), which through a hard link
  // would touch the source's file - they are rebuilt in ~20 ms anyway
  linkTree(path.join(img, 'initrd'), path.join(root, 'images', 'initrd'), (s) => /\.initrd$/.test(s) && !/^disk-/.test(path.basename(s)) && notCold(s));
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
function getHost(host, port, p, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: p || '/', timeout: ms || 5000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}
const get = (port, p) => getHost('127.0.0.1', port, p);
const qp = async () => { const s = await freePort(); return s; };
// the first non-internal IPv4 address of this PC: a LAN port answers there
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a && (a.family === 'IPv4' || a.family === 4) && !a.internal && !/^169\.254\./.test(a.address)) return a.address;
  }
  return null;
}
// QEMU's private memory and working set (Windows; null elsewhere)
function qemuMem(pid) {
  if (!platform.IS_WIN || !pid) return null;
  try {
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      '$p = Get-Process -Id ' + Number(pid) + '; "$($p.PrivateMemorySize64) $($p.WorkingSet64)"'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const [pm, ws] = out.trim().split(/\s+/).map(Number);
    return { privateMB: Math.round(pm / 1048576), workingSetMB: Math.round(ws / 1048576) };
  } catch (e) { return null; }
}
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
function sha256File(f) { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
// POST a run and time its first HTTP 200 on 127.0.0.1:hp from the request
// (the run task waits for READY and a port probe; the app may answer sooner)
async function firstHttp(body, hp, ms) {
  const t0 = Date.now();
  const r = await api('POST', '/api/container/run', Object.assign({ createdBy: 'api', ephemeral: true }, body));
  assert.equal(r.status, 202, r.text);
  let first = null;
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) {
    if ((await getHost('127.0.0.1', hp, '/', 1000)).status === 200) { first = Date.now() - t0; break; }
    await sleep(50);
  }
  const t = await task(r.json.task.id, ms);
  assert.equal(t.status, 'done', t.error);
  assert.ok(first !== null, 'no HTTP 200 within ' + (ms || 30000) + ' ms');
  return { id: r.json.container.id, firstMs: first, task: t };
}

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
    try { await api('POST', '/api/settings', { lightProfile: null }); } catch (e) { /* gone */ }
    await stopManager(MANAGER);
    await endOurQemus();
    if (process.env.DEVBOX_E2E_REPORT) {
      try { fs.writeFileSync(process.env.DEVBOX_E2E_REPORT, JSON.stringify(REPORT, null, 1)); } catch (e) { /* report only */ }
    }
    await sleep(500);
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { /* a file held briefly */ }
  });

  // a run's root file system, from its record: the default is the disk root
  // (an image disk + this container's writable layer), booted through the
  // small initramfs (timings.rootMs: stage 2 on the disk)
  function assertDiskRoot(c) {
    assert.equal(c.rootfs, 'disk', 'the default root file system');
    assert.ok(c.rootDisk && /^images\/disks\/[a-f0-9]{12}-[a-f0-9]{16}\.qcow2$/.test(c.rootDisk.disk), JSON.stringify(c.rootDisk));
    assert.ok(fs.existsSync(path.join(ROOT, 'microvms', c.id, 'root.qcow2')), 'its writable layer');
    assert.ok(c.timings && c.timings.rootMs > 0, 'stage 2 ran on the disk: ' + JSON.stringify(c.timings));
  }

  test('hello-world: its greeting on stdout, exit 0 (disk root by default)', async (t) => {
    const t0 = Date.now();
    const r = await run({ image: 'hello-world' });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const c = await ended(r.id);
    assert.equal(c.exitCode, 0);
    assert.match(await logs(r.id, 'stdout'), /Hello from Docker!/);
    assertDiskRoot(c);
    note(t, 'hello-world disk root', { exitAfterMs: Date.parse(c.endedAt) - t0, timings: c.timings });
    await remove(r.id);
  });

  test('alpine: exit code and separate stdout / stderr', async () => {
    const r = await run({ image: 'alpine', cmd: ['sh', '-c', 'echo hi; echo err >&2; exit 3'] });
    const c = await ended(r.id);
    assert.equal(c.exitCode, 3);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'hi');
    assert.equal((await logs(r.id, 'stderr')).trim(), 'err');
    assertDiskRoot(c);
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

  test('concurrent runs all start, each with its own control endpoints (V3)', async () => {
    // as many as may run at once on this PC (DEVBOX_E2E_MAX_GUESTS)
    const rs = await Promise.all(Array.from({ length: MAX_GUESTS }, () => run({ image: 'hello-world' })));
    for (const r of rs) {
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, JSON.stringify(c.exitReason));
      await remove(r.id);
    }
  });

  test('3 concurrent cold builds of one image: all start, one image disk is built (V4)', async (t) => {
    if (!COLD) { t.skip('busybox is not in the cache'); return; }
    // the default root file system is the disk: the boot image of an image
    // is its image disk (images/disks/<cfg12>-<key>.qcow2 + its sidecar)
    const dir = path.join(ROOT, 'images', 'disks');
    fs.mkdirSync(dir, { recursive: true });
    const before = fs.readdirSync(dir).filter((f) => f.startsWith(COLD.slice(0, 12)));
    assert.deepEqual(before, [], 'cold at the start');
    const rs = await Promise.all(Array.from({ length: Math.min(3, MAX_GUESTS) }, () => run({ image: 'busybox', cmd: ['echo', 'cold-ok'] })));
    for (const r of rs) {
      const c = await ended(r.id);
      assert.equal(c.exitCode, 0, c.exitReason || '');
      assert.equal((await logs(r.id, 'stdout')).trim(), 'cold-ok');
      await remove(r.id);
    }
    const after = fs.readdirSync(dir).filter((f) => f.startsWith(COLD.slice(0, 12)) && /\.qcow2$/.test(f));
    assert.equal(after.length, 1, 'one build: ' + after.join(', '));
    assert.ok(fs.existsSync(path.join(dir, after[0] + '.json')), 'with its sidecar');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), [], 'no temp file left');
  });

  test('busybox: env with spaces and quotes, default PATH and HOME, workdir created, hostname, user, nofile (disk root)', async () => {
    const r = await run({
      image: 'busybox', env: ['A=with space', 'B=it\'s "quoted"'], workdir: '/work/dir', hostname: 'e2e-host',
      cmd: ['sh', '-c', 'echo "A=$A"; echo "B=$B"; echo "PATH=$PATH"; echo "HOME=$HOME"; pwd; hostname; id -u; ulimit -Sn; ulimit -Hn'],
    });
    const c = await ended(r.id);
    assert.equal(c.exitCode, 0, c.exitReason || '');
    assert.deepEqual((await logs(r.id, 'stdout')).trim().split('\n'), [
      'A=with space', 'B=it\'s "quoted"', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root',
      '/work/dir', 'e2e-host', '0', '1024', '524288',
    ]);
    assertDiskRoot(c);
    const u = await run({ image: 'busybox', user: 'nobody', cmd: ['sh', '-c', 'id -u; id -g'] });
    const cu = await ended(u.id);
    assert.equal(cu.exitCode, 0, cu.exitReason || '');
    assert.deepEqual((await logs(u.id, 'stdout')).trim().split('\n'), ['65534', '65534']);
    await remove(r.id); await remove(u.id);
  });

  test('nginx:alpine with a LAN port: HTTP 200 on this PC and on its LAN address (disk root)', async (t) => {
    const hp = await qp();
    const r = await run({ image: 'nginx:alpine', ports: ['lan:' + hp + ':80'] });
    try {
      assert.equal(r.task.status, 'done', r.task.error);
      await until(async () => (await get(hp)).status === 200, 20000, 'nginx on 127.0.0.1');
      const c = await rec(r.id);
      assert.equal(c.ports[0].lan, true);
      assert.ok(c.urls[0].lanUrls && c.urls[0].lanUrls.length, JSON.stringify(c.urls));
      const ip = lanAddress();
      if (ip) assert.equal((await getHost(ip, hp)).status, 200, 'on ' + ip + ':' + hp);
      else t.diagnostic('no LAN address on this PC: only 127.0.0.1 was checked');
      assertDiskRoot(c);
    } finally { await stop(r.id); await remove(r.id); }
  });

  test('nginx-unprivileged: runs as USER 101 and answers on a LAN port (disk root)', { skip: !cachedImage('nginxinc/nginx-unprivileged:alpine') && 'nginx-unprivileged is not cached' }, async () => {
    const img = 'nginxinc/nginx-unprivileged:alpine';
    const u = await run({ image: img, entrypoint: ['id'], cmd: ['-u'] });
    const cu = await ended(u.id);
    assert.equal(cu.exitCode, 0, cu.exitReason || '');
    assert.equal((await logs(u.id, 'stdout')).trim(), '101');
    await remove(u.id);
    const hp = await qp();
    const r = await run({ image: img, ports: ['lan:' + hp + ':8080'] });
    try {
      assert.equal(r.task.status, 'done', r.task.error);
      const res = await until(async () => { const g = await get(hp); return g.status === 200 ? g : null; }, 20000, 'nginx-unprivileged to answer');
      assert.match(res.body, /nginx/i);
      const ip = lanAddress();
      if (ip) assert.equal((await getHost(ip, hp)).status, 200, 'on ' + ip + ':' + hp);
      assertDiskRoot(await rec(r.id));
    } finally { await stop(r.id); await remove(r.id); }
  });

  test('python:3-alpine: its standard library, TLS 1.3 from inside the guest, the clock within 5 s of this PC (disk root)', { skip: !cachedImage('python:3-alpine') && 'python:3-alpine is not cached' }, async (t) => {
    // a TLS handshake only (no request, nothing downloaded): the CA bundle,
    // DNS and the guest clock
    const py = [
      'import ssl, socket, time, sqlite3, asyncio, json, decimal, hashlib',
      'ctx = ssl.create_default_context()',
      'try:',
      '    s = socket.create_connection(("dl-cdn.alpinelinux.org", 443), timeout=15)',
      '    w = ctx.wrap_socket(s, server_hostname="dl-cdn.alpinelinux.org")',
      '    print("TLS", w.version(), flush=True)',
      '    w.close()',
      'except (socket.gaierror, socket.timeout, ConnectionError) as e:',
      '    print("NOTLS", type(e).__name__, e, flush=True)',
      'print("TIME", time.time(), flush=True)',
    ].join('\n');
    const t0 = Date.now();
    const r = await run({ image: 'python:3-alpine', cmd: ['python3', '-c', py] });
    const c = await ended(r.id, 90000);
    assert.equal(c.exitCode, 0, c.exitReason || (await logs(r.id, 'stderr')));
    const out = await logs(r.id, 'stdout');
    const tm = /TIME ([0-9.]+)/.exec(out);
    assert.ok(tm, out);
    const skew = Math.abs(Date.parse(c.endedAt) / 1000 - Number(tm[1]));
    assert.ok(skew < 5, 'clock skew ' + skew + ' s');
    if (/NOTLS/.test(out)) t.diagnostic('no network to dl-cdn.alpinelinux.org, TLS not checked: ' + out.trim().split('\n')[0]);
    else assert.match(out, /^TLS TLSv1\.3$/m);
    assertDiskRoot(c);
    note(t, 'python TLS (disk root)', { result: out.trim().split('\n')[0], clockSkewS: Math.round(skew * 100) / 100, exitAfterMs: Date.parse(c.endedAt) - t0 });
    await remove(r.id);
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

  // TCG: hello-world's exit and nginx's first HTTP 200 from the request, and
  // nginx's QEMU memory - SPEC-diskroot 14.2: <= 340 MB private at the
  // normal profile's 128 MB cache, <= 250 MB with the light profile
  async function tcgPair(t, label, privateMax) {
    const t0 = Date.now();
    const r = await run({ image: 'hello-world', accel: 'tcg' }, 120000);
    const c = await ended(r.id, 120000);
    assert.equal(c.exitCode, 0, c.exitReason || '');
    const helloMs = Date.parse(c.endedAt) - t0;
    assert.ok(helloMs < 40000, 'hello-world within 40 s: ' + helloMs + ' ms');
    assert.ok((c.warnings || []).some((w) => /TCG/.test(w)), 'says it is not a security boundary');
    assertDiskRoot(c);
    await remove(r.id);
    const hp = await qp();
    const n = await firstHttp({ image: 'nginx:alpine', accel: 'tcg', ports: [hp + ':80'] }, hp, 120000);
    try {
      assert.ok(n.firstMs <= 40000, 'nginx under TCG: first HTTP 200 after ' + n.firstMs + ' ms');
      await sleep(2000);
      const cn = await rec(n.id);
      assert.deepEqual([cn.runtime.rootfs, cn.runtime.effectiveAccel], ['disk', 'tcg']);
      const m = qemuMem(cn.runtime.pid);
      const cmd = await platform.processCommandLine(cn.runtime.pid);
      const tb = /tb-size=(\d+)/.exec(cmd || '');
      note(t, label, { helloExitMs: helloMs, nginxFirstHttp200Ms: n.firstMs, guestMB: cn.runtime.memMB, tbSizeMB: tb ? Number(tb[1]) : null, qemu: m });
      if (m) assert.ok(m.privateMB <= privateMax, 'QEMU private ' + m.privateMB + ' MB > ' + privateMax);
      return { guestMB: cn.runtime.memMB, tbSizeMB: tb ? Number(tb[1]) : null };
    } finally {
      const s = await stop(n.id);
      assert.equal(s.status, 'done', s.error);
      await remove(n.id);
    }
  }

  test('TCG (no hardware acceleration): hello-world and nginx still run on the disk root, with the warning', async (t) => {
    const r = await tcgPair(t, 'TCG normal profile', 340);
    assert.deepEqual([r.guestMB, r.tbSizeMB], [128, 128]);
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
    const r = await run({ image: 'alpine', mem: 256, rootfs: 'ram', cmd: ['sh', '-c', 'dd if=/dev/zero of=/tmp/fill bs=1M count=400 2>&1; echo rc=$?'] });
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

  // ---------------------------------------------------------- disk root
  // (the default root file system; SPEC-diskroot section 14.2)
  const privateMB = (pid) => {
    if (!platform.IS_WIN) return null;
    try {
      const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ').PrivateMemorySize64'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      return Math.round(Number(out.trim()) / 1048576);
    } catch (e) { return null; }
  };

  test('disk root: nginx at the default 128 MB answers, QEMU stays light; mem 96 works too', async (t) => {
    const hp = await qp();
    const t0 = Date.now();
    const r = await run({ image: 'nginx:alpine', ports: [hp + ':80'] });
    assert.equal(r.task.status, 'done', r.task.error);
    await until(async () => (await get(hp)).status === 200, 20000, 'nginx to answer');
    const first = Date.now() - t0;
    const c = await rec(r.id);
    assert.deepEqual([c.rootfs, c.runtime.rootfs, c.runtime.memMB], ['disk', 'disk', 128]);
    assert.ok(c.rootDisk && /^images\/disks\/[a-f0-9]{12}-[a-f0-9]{16}\.qcow2$/.test(c.rootDisk.disk), JSON.stringify(c.rootDisk));
    const mb = privateMB(c.runtime.pid);
    if (mb !== null) assert.ok(mb <= 200, 'QEMU private memory ' + mb + ' MB');
    assert.ok(first < 20000, 'first HTTP 200 after ' + first + ' ms');
    note(t, 'nginx disk root at the default memory', { firstHttp200Ms: first, guestMB: c.runtime.memMB, qemuPrivateMB: mb });
    await stop(r.id); await remove(r.id);
    const hp2 = await qp();
    const r2 = await run({ image: 'nginx:alpine', ports: [hp2 + ':80'], mem: 96 });
    assert.equal(r2.task.status, 'done', r2.task.error);
    await until(async () => (await get(hp2)).status === 200, 20000, 'nginx at 96 MB');
    assert.equal((await rec(r2.id)).runtime.memMB, 96);
    await stop(r2.id); await remove(r2.id);
  });

  test('disk root: files outside volumes persist across a restart and go with a fresh start; RAM root is opt-in and resets', async () => {
    const cmd = ['sh', '-c', 'if [ -f /keep ]; then echo found; else echo made >/keep; echo created; fi'];
    const r = await run({ image: 'alpine', cmd });
    await ended(r.id);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'created');
    const s = await api('POST', '/api/container/start', { id: r.id });
    await task(s.json.task.id);
    await ended(r.id);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'found', 'the writable layer was kept');
    const f = await api('POST', '/api/container/start', { id: r.id, fresh: true });
    const ft = await task(f.json.task.id);
    assert.ok(ft.log.some((l) => /Started fresh/.test(l)), ft.log.join('\n'));
    await ended(r.id);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'created');
    await remove(r.id);
    assert.ok(!fs.existsSync(path.join(ROOT, 'microvms', r.id)), 'the layer goes with the container');
    const m = await run({ image: 'alpine', cmd, rootfs: 'ram' });
    await ended(m.id);
    const s2 = await api('POST', '/api/container/start', { id: m.id });
    await task(s2.json.task.id);
    await ended(m.id);
    assert.equal((await logs(m.id, 'stdout')).trim(), 'created', 'a RAM root resets at every start');
    assert.equal((await rec(m.id)).rootfs, 'ram');
    await remove(m.id);
  });

  test('disk root: containers of one image share ONE image disk that is never written; each keeps its own writes across ITS restart, a new one starts clean; rmi refuses while they exist', async (t) => {
    const cmd = ['sh', '-c', 'if [ -f /mine ]; then echo "kept $(cat /mine)"; else echo none; fi; echo "$MARK" >/mine'];
    const ids = [];
    // four containers, at most MAX_GUESTS running at once
    const batch = Math.min(3, MAX_GUESTS);
    for (let i = 0; i < 4; i += batch) {
      const rs = await Promise.all(Array.from({ length: Math.min(batch, 4 - i) }, (_, k) => run({ image: 'alpine', env: ['MARK=c' + (i + k)], cmd })));
      for (const r of rs) { assert.equal(r.status, 202, JSON.stringify(r.json)); ids.push(r.id); await ended(r.id); }
    }
    const recs = [];
    for (const id of ids) recs.push(await rec(id));
    for (const c of recs) { assert.equal(c.exitCode, 0, c.exitReason || ''); assertDiskRoot(c); }
    for (const id of ids) assert.equal((await logs(id, 'stdout')).trim(), 'none');
    const disks = new Set(recs.map((c) => c.rootDisk.disk));
    assert.equal(disks.size, 1, 'one image disk: ' + Array.from(disks).join(', '));
    const diskFile = path.join(ROOT, Array.from(disks)[0]);
    const cfg12 = path.basename(diskFile).slice(0, 12);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'images', 'disks')).filter((f) => f.startsWith(cfg12) && /\.qcow2$/.test(f)), [path.basename(diskFile)]);
    const sha0 = sha256File(diskFile);
    const mtime0 = fs.statSync(diskFile).mtimeMs;
    // every writable layer names it RELATIVELY (the data folder stays movable)
    const qcow2 = require('../lib/microvm/qcow2');
    for (const id of ids) {
      const b = qcow2.readBacking(path.join(ROOT, 'microvms', id, 'root.qcow2'));
      assert.deepEqual(b, { name: '../../images/disks/' + path.basename(diskFile), format: 'qcow2' });
    }
    // a container's own write survives ITS stop/start ...
    const s = await api('POST', '/api/container/start', { id: ids[1] });
    assert.equal(s.status, 202, s.text);
    assert.equal((await task(s.json.task.id)).status, 'done');
    await ended(ids[1]);
    assert.equal((await logs(ids[1], 'stdout')).trim(), 'kept c1');
    // ... and a new container of the image starts from the clean image
    const n = await run({ image: 'alpine', env: ['MARK=c9'], cmd });
    ids.push(n.id);
    await ended(n.id);
    assert.equal((await logs(n.id, 'stdout')).trim(), 'none');
    assert.equal(sha256File(diskFile), sha0, 'the shared image disk is never written');
    assert.equal(fs.statSync(diskFile).mtimeMs, mtime0);
    // the image cannot be removed while its containers exist
    const rm = await api('POST', '/api/image/remove', { image: 'alpine' });
    assert.equal(rm.status, 409, rm.text);
    assert.equal(rm.json.code, 'IMAGE_IN_USE');
    assert.ok(fs.existsSync(diskFile));
    const layers = [];
    for (const id of ids) layers.push((await rec(id)).rootDisk.overlayBytes);
    note(t, 'one image disk, five containers', { diskFileBytes: fs.statSync(diskFile).size, writableLayerBytes: layers });
    for (const id of ids) await remove(id);
    assert.ok(fs.existsSync(diskFile), 'the image disk stays with its image');
  });

  // ---- the guest's view of an image disk (SPEC-diskroot 14.2, cov-8; the
  // spike's check.js ported): a container of the image lists every path of
  // its root file system from INSIDE the guest - busybox find/stat/sha256sum
  // as root, no network, nothing of the image needed - and the listing must
  // equal the tree the engine builds on this PC from the same layers
  // (lib/oci/layers + the runtime basics + /.devbox), field by field: type,
  // mode, owner, links, size, mtime, sha256, symlink target, device number.
  const GUEST_LIST = [
    'B=/.devbox/busybox', 'cd /',
    "echo '#STAT'", "$B find . -xdev -exec $B stat -c '%n\t%f\t%u\t%g\t%h\t%s\t%Y' {} +",
    "echo '#SHA'", '$B find . -xdev -type f -exec $B sha256sum {} +',
    "echo '#LNK'", '$B find . -xdev -type l | while IFS= read -r l; do printf \'%s\\t%s\\n\' "$l" "$($B readlink "$l")"; done',
    "echo '#DEV'", "$B find . -xdev \\( -type c -o -type b \\) -exec $B stat -c '%n\t%t\t%T' {} +",
    "echo '#END'",
  ].join('\n');
  // the layers of a cached image in the scratch root
  function scratchImage(ref) {
    const registry = require('../lib/oci/registry');
    const root = path.join(ROOT, 'images');
    const refs = registry.readRefs(root);
    const canon = registry.parseImageRef(ref).canonical;
    const r = refs[canon];
    if (!r) return null;
    const blob = (d) => JSON.parse(fs.readFileSync(registry.blobPath(root, d), 'utf8'));
    const m = blob(r.platformDigest || r.manifestDigest);
    const cfg = blob(r.configDigest);
    return { config: cfg, layers: m.layers.map((l, i) => ({ path: registry.blobPath(root, l.digest), diffId: cfg.rootfs.diff_ids[i] })) };
  }
  // what the guest must see, built the way rootdisk.ensureImageDisk builds
  // the disk ("/" is always 0755 root:root - cr-2)
  async function expectedView(img) {
    const layers = require('../lib/oci/layers');
    const tree = await layers.buildTree(img.layers);
    require('../lib/oci/cpio').addRuntimeBasics(tree, {});
    if (!tree.lookup('.devbox')) tree.addExtra({ path: '.devbox', type: 'dir', mode: 0o755, mtime: 0 });
    const crypto = require('crypto');
    const out = new Map();
    const nlinks = new Map();
    for (const [, n] of tree.walk()) if (n.type === 'file') nlinks.set(n.inode, (nlinks.get(n.inode) || 0) + 1);
    const subdirs = (node) => { let k = 0; for (const x of node.children.values()) if (x.type === 'dir') k++; return k; };
    const TYPE = { dir: 0o040000, file: 0o100000, symlink: 0o120000, fifo: 0o010000, char: 0o020000, block: 0o060000 };
    const put = (p, n) => {
      const perm = n.type === 'symlink' ? 0o777 : ((n.type === 'file' ? n.inode.mode : n.mode) & 0o7777);
      const e = { mode: TYPE[n.type] | perm, uid: n.uid, gid: n.gid };
      if (n.type === 'file') Object.assign(e, { uid: n.inode.uid, gid: n.inode.gid, size: n.inode.size, nlink: nlinks.get(n.inode), mtime: n.inode.mtime });
      else if (n.type === 'dir') Object.assign(e, { nlink: 2 + subdirs(n), mtime: n.mtime });
      else if (n.type === 'symlink') Object.assign(e, { nlink: 1, size: Buffer.byteLength(n.linkpath), target: n.linkpath, mtime: n.mtime });
      else Object.assign(e, { nlink: 1, size: 0, mtime: n.mtime, rdev: n.type === 'char' || n.type === 'block' ? [n.rdevmajor, n.rdevminor] : undefined });
      out.set(p, e);
    };
    put('.', tree.root);
    Object.assign(out.get('.'), { mode: 0o040755, uid: 0, gid: 0 });
    for (const [p, n] of tree.walk()) put('./' + p, n);
    // the data of a hardlink group rides on its LAST path (emitTree)
    const EMPTY = crypto.createHash('sha256').digest('hex');
    const byPath = new Map();
    await layers.emitTree(tree, async (entry, data) => {
      if (entry.type !== 'file' || !entry.size || data == null) return;
      const h = crypto.createHash('sha256');
      if (Buffer.isBuffer(data)) h.update(data); else for await (const x of data) h.update(x);
      byPath.set('./' + entry.path, h.digest('hex'));
    }, { includeRoot: false });
    const byInode = new Map();
    for (const [p, n] of tree.walk()) if (n.type === 'file') { if (!byInode.has(n.inode)) byInode.set(n.inode, []); byInode.get(n.inode).push('./' + p); }
    for (const [inode, paths] of byInode) {
      const sha = inode.size ? paths.map((p) => byPath.get(p)).find(Boolean) : EMPTY;
      for (const p of paths) out.get(p).sha = sha;
    }
    return out;
  }
  function parseView(text) {
    const sec = {}; let cur = null;
    for (const line of text.split('\n')) {
      if (/^#[A-Z]+$/.test(line)) { cur = line.slice(1); sec[cur] = []; continue; }
      if (cur && line) sec[cur].push(line);
    }
    const got = new Map();
    for (const l of sec.STAT || []) {
      const f = l.split('\t');
      got.set(f[0], { mode: parseInt(f[1], 16), uid: +f[2], gid: +f[3], nlink: +f[4], size: +f[5], mtime: +f[6] });
    }
    for (const l of sec.SHA || []) { const m = /^([0-9a-f]{64})\s+(.*)$/.exec(l); if (m && got.get(m[2])) got.get(m[2]).sha = m[1]; }
    for (const l of sec.LNK || []) { const i = l.indexOf('\t'); const e = got.get(l.slice(0, i)); if (e) e.target = l.slice(i + 1); }
    for (const l of sec.DEV || []) { const f = l.split('\t'); const e = got.get(f[0]); if (e) e.rdev = [parseInt(f[1], 16), parseInt(f[2], 16)]; }
    return { got, complete: !!sec.END };
  }
  // What init itself changes on the root (and what mounts hide) is not the
  // image's: the mount points' own children, /etc's three files rewritten at
  // every boot (and /etc made when the image has none), the workdir made
  // when missing.
  const MOUNTED = ['./dev', './proc', './sys', './.devbox'];
  const INIT_FILES = ['./etc/resolv.conf', './etc/hosts', './etc/hostname'];
  function compareView(exp, got, o) {
    const diffs = [];
    const under = (p) => MOUNTED.some((m) => p.startsWith(m + '/'));
    const fields = ['mode', 'uid', 'gid', 'nlink', 'size', 'mtime', 'sha', 'target', 'rdev'];
    // /etc, and the workdir with every folder above it, when the image has none
    const wd = String(o.workdir || '').split('/').filter(Boolean);
    const made = new Set(['./etc'].concat(wd.map((_, i) => './' + wd.slice(0, i + 1).join('/'))).filter((p) => !exp.has(p)));
    const touched = new Set([...made].map((p) => (p.lastIndexOf('/') > 1 ? p.slice(0, p.lastIndexOf('/')) : '.')));
    for (const [p, e] of exp) {
      if (under(p)) continue;
      const g = got.get(p);
      if (!g) { diffs.push(p + ': missing in the guest'); continue; }
      if (MOUNTED.includes(p) || INIT_FILES.includes(p) || p === './etc') continue;
      for (const k of fields) {
        if (e[k] === undefined) continue;
        if (k === 'size' && (e.mode & 0o170000) === 0o040000) continue;
        // a folder gains a subfolder when init makes /etc or the workdir in it
        if (touched.has(p) && (k === 'mtime' || k === 'nlink')) continue;
        const a = JSON.stringify(e[k]), b = JSON.stringify(g[k]);
        if (a !== b) diffs.push(p + ': ' + k + ' expected ' + a + ' got ' + b);
      }
    }
    for (const p of got.keys()) {
      if (exp.has(p) || INIT_FILES.includes(p) || made.has(p) || [...made].some((m) => p.startsWith(m + '/'))) continue;
      diffs.push(p + ': extra in the guest');
    }
    return diffs;
  }
  // a synthetic image with what real images rarely have together: "./" at
  // 0700 owned by a build user (cr-2), suid/sgid/sticky, owners above 65535,
  // a mtime past 2038, hardlinks that survive the removal of their first
  // path, fast and slow symlinks, a 1.5 MB file, a long name, whiteouts and
  // an opaque directory
  function edgeImage() {
    const mk = require('./oci-mkimage');
    const crypto = require('crypto');
    const big = crypto.createCipheriv('aes-128-ctr', Buffer.alloc(16, 7), Buffer.alloc(16)).update(Buffer.alloc(1536 * 1024 + 123));
    const l1 = mk.tarBuffer([
      { path: './', type: 'dir', mode: 0o700, uid: 1000, gid: 1000, mtime: 1600000000 },
      { path: 'etc', type: 'dir' },
      { path: 'etc/passwd', type: 'file', data: 'root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000::/home/app:/bin/sh\n' },
      { path: 'd', type: 'dir', mode: 0o750, uid: 101, gid: 102 }, { path: 'd/a', type: 'file', data: 'a\n' }, { path: 'd/b', type: 'file', data: 'b\n', uid: 101 },
      { path: 'opq', type: 'dir' }, { path: 'opq/old', type: 'file', data: 'old\n' },
      { path: 'hl', type: 'dir' }, { path: 'hl/orig', type: 'file', data: 'hard\n' },
      { path: 'hl/link', type: 'hardlink', linkpath: 'hl/orig' }, { path: 'hl/link2', type: 'hardlink', linkpath: 'hl/orig' },
      { path: 'big.bin', type: 'file', data: big }, { path: 'empty', type: 'file', data: '' },
      { path: 'suid', type: 'file', data: '#!/bin/sh\n', mode: 0o4755 }, { path: 'sgid', type: 'dir', mode: 0o2775 }, { path: 'sticky', type: 'dir', mode: 0o1777 },
      { path: 'fast', type: 'symlink', linkpath: 'x'.repeat(59) }, { path: 'slow', type: 'symlink', linkpath: '/' + 'z'.repeat(150) },
      { path: 'owned', type: 'file', data: 'mine\n', mode: 0o640, uid: 100000, gid: 70000, mtime: 2240611200 },
      { path: 'n' + 'a'.repeat(200), type: 'file', data: 'long name\n' },
      { path: 'deep/a/b/c/d', type: 'dir' }, { path: 'deep/a/b/c/d/leaf', type: 'file', data: 'leaf\n' },
    ]);
    const l2 = mk.tarBuffer([
      { path: 'd', type: 'dir', mode: 0o750, uid: 101, gid: 102 }, { path: 'd/.wh.a', type: 'file' },
      { path: 'opq', type: 'dir' }, { path: 'opq/.wh..wh..opq', type: 'file' }, { path: 'opq/new', type: 'file', data: 'new\n' },
      { path: 'hl', type: 'dir' }, { path: 'hl/.wh.orig', type: 'file' },
      { path: 'later', type: 'file', data: 'layer 2\n' },
    ]);
    mk.putLocalImage(path.join(ROOT, 'images'), 'e2eedge', { layers: [{ tar: l1 }, { tar: l2 }], config: { Cmd: ['/nothing'], WorkingDir: '/srv/app' } });
    return 'e2eedge';
  }

  test('disk root: the guest sees exactly the image - every path, mode, owner, link, size, time and byte - for every cached approved image and an edge image (cov-8)', async (t) => {
    const refs = ['hello-world', 'alpine', 'busybox', 'nginx:alpine', 'nginxinc/nginx-unprivileged:alpine', 'python:3-alpine'].filter(cachedImage);
    refs.push(edgeImage());
    const summary = {};
    for (const ref of refs) {
      const img = scratchImage(ref);
      if (!img) { summary[ref] = 'not cached in the scratch root'; continue; }
      // one guest at a time; root, no network: only the listing runs
      const r = await run({ image: ref, entrypoint: ['/.devbox/busybox', 'sh', '-c', GUEST_LIST], cmd: [], user: '0:0', network: 'none', ports: [] }, 300000);
      assert.equal(r.status, 202, JSON.stringify(r.json));
      const c = await ended(r.id, 300000);
      assert.equal(c.exitCode, 0, ref + ': ' + (c.exitReason || ''));
      assertDiskRoot(c);
      const out = fs.readFileSync(path.join(ROOT, 'microvms', r.id, 'stdout.log'), 'utf8');
      const view = parseView(out);
      assert.ok(view.complete, ref + ': the listing was cut short: ' + out.slice(-500));
      const exp = await expectedView(img);
      const diffs = compareView(exp, view.got, { workdir: img.config.config && img.config.config.WorkingDir });
      summary[ref] = { entries: exp.size, guestEntries: view.got.size, diffs: diffs.length };
      assert.deepEqual(diffs.slice(0, 20), [], ref + ': ' + diffs.length + ' differences');
      const con = fs.readFileSync(path.join(ROOT, 'microvms', r.id, 'console.log'), 'utf8');
      assert.ok(!/EXT4-fs (error|warning)|JBD2.*error/i.test(con), ref + ': ' + con.slice(-1500));
      await remove(r.id);
    }
    note(t, 'guest view check', summary);
  });

  test('memory: disk root vs RAM root for nginx and python (guest RAM, QEMU private memory and working set, time to answer)', async (t) => {
    const st = (await api('GET', '/api/state')).json;
    const defMB = st.microvm.defaults.memMB;
    assert.equal(st.microvm.defaults.rootfs, 'disk');
    const out = {};
    const add = (k, v) => { (out[k] = out[k] || []).push(v); };
    // nginx, interleaved disk / ram, two each
    for (const rootfs of ['disk', 'ram', 'disk', 'ram']) {
      const hp = await qp();
      const x = await firstHttp(Object.assign({ image: 'nginx:alpine', ports: [hp + ':80'] }, rootfs === 'ram' ? { rootfs } : {}), hp);
      try {
        await sleep(1500);
        const c = await rec(x.id);
        assert.equal(c.runtime.rootfs, rootfs);
        add('nginx ' + rootfs, Object.assign({ guestMB: c.runtime.memMB, firstHttp200Ms: x.firstMs }, qemuMem(c.runtime.pid) || {}));
      } finally { await stop(x.id); await remove(x.id); }
    }
    // python: import a good part of the standard library, then idle so the
    // memory can be read
    if (cachedImage('python:3-alpine')) {
      const py = 'import ssl, sqlite3, asyncio, json, decimal, email.parser, http.client, hashlib, zlib, xml.etree.ElementTree, time\n' +
        'c = sqlite3.connect(":memory:"); c.execute("create table t(x)"); c.execute("insert into t values (1)")\n' +
        'print("imported", flush=True)\ntime.sleep(8)';
      for (const rootfs of ['disk', 'ram']) {
        const t0 = Date.now();
        const r = await api('POST', '/api/container/run', Object.assign({ image: 'python:3-alpine', cmd: ['python3', '-c', py], createdBy: 'api', ephemeral: true }, rootfs === 'ram' ? { rootfs } : {}));
        assert.equal(r.status, 202, r.text);
        const id = r.json.container.id;
        try {
          await until(async () => /imported/.test(await logs(id, 'stdout')), 60000, 'python to import');
          const importedMs = Date.now() - t0;
          await sleep(1500);
          const c = await rec(id);
          assert.equal(c.runtime.rootfs, rootfs);
          add('python ' + rootfs, Object.assign({ guestMB: c.runtime.memMB, importedMs }, qemuMem(c.runtime.pid) || {}));
          const e = await ended(id, 60000);
          assert.equal(e.exitCode, 0, e.exitReason || '');
        } finally { await remove(id); }
      }
    }
    note(t, 'memory disk vs RAM root', out);
    for (const app of ['nginx', 'python']) {
      if (!out[app + ' disk']) continue;
      for (const d of out[app + ' disk']) assert.equal(d.guestMB, defMB, app + ': the disk root gets the default whatever the image size');
      for (const r of out[app + ' ram']) assert.ok(r.guestMB >= 256, app + ' RAM root: ' + r.guestMB + ' MB');
      const dp = median(out[app + ' disk'].map((x) => x.privateMB));
      const rp = median(out[app + ' ram'].map((x) => x.privateMB));
      if (dp !== null && rp !== null) assert.ok(dp < rp, app + ': disk ' + dp + ' MB private vs RAM ' + rp);
    }
    const dn = median(out['nginx disk'].map((x) => x.privateMB));
    if (dn !== null) assert.ok(dn <= 200, 'nginx disk root: QEMU private ' + dn + ' MB');
    assert.ok(median(out['nginx disk'].map((x) => x.firstHttp200Ms)) <= median(out['nginx ram'].map((x) => x.firstHttp200Ms)) * 1.2 + 500, 'disk root answers about as soon as the RAM root');
  });

  test('a synthetic ~600 MB image runs on the disk root at the default memory and reads every byte; as a RAM root it is flagged for Docker-in-VM', { skip: !WANT_BIG && 'DEVBOX_E2E_BIG=0' }, async (t) => {
    const mk = require('./oci-mkimage');
    const crypto = require('crypto');
    const imagesDir = path.join(ROOT, 'images');
    if (!fs.existsSync(path.join(imagesDir, 'blobs', 'sha256', mk.BUSYBOX_LAYER.digest.slice(7)))) { t.skip('the busybox layer is not cached'); return; }
    // 4 uncompressed layers of ~150 MB: files of 64 KB .. 8 MB of noise
    // (written one layer at a time, so the test never holds 600 MB)
    const t0 = Date.now();
    const layers = [mk.BUSYBOX_LAYER];
    let expected = 0;
    for (let l = 0; l < 4; l++) {
      const ents = [{ path: 'data' + l, type: 'dir' }];
      let total = 0;
      for (let i = 0; total < 150 * 1048576; i++) {
        const size = [65536, 262144, 1048576, 8 * 1048576][i % 4] + i;
        const key = crypto.createHash('md5').update(l + ':' + i).digest();
        ents.push({ path: 'data' + l + '/f' + String(i).padStart(4, '0'), type: 'file', data: crypto.createCipheriv('aes-128-ctr', key, Buffer.alloc(16)).update(Buffer.alloc(size)) });
        total += size;
      }
      expected += total;
      const tar = mk.tarBuffer(ents);
      const hex = crypto.createHash('sha256').update(tar).digest('hex');
      fs.writeFileSync(path.join(imagesDir, 'blobs', 'sha256', hex), tar);
      layers.push({ digest: 'sha256:' + hex, size: tar.length, mediaType: 'application/vnd.oci.image.layer.v1.tar', diffId: 'sha256:' + hex });
    }
    mk.putLocalImage(imagesDir, 'e2ebig', { layers, config: { Cmd: ['sh'], Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'] } });
    const madeMs = Date.now() - t0;
    // disk root (the default), default memory: the image streams through the
    // page cache - a RAM root of it needs about 1.4 GB
    const t1 = Date.now();
    const r = await run({ image: 'e2ebig', cmd: ['sh', '-c', 'cat /data0/* /data1/* /data2/* /data3/* | wc -c; grep MemTotal /proc/meminfo'] }, 300000);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const c = await ended(r.id, 300000);
    assert.equal(c.exitCode, 0, c.exitReason || (await logs(r.id, 'stderr')));
    const lines = (await logs(r.id, 'stdout')).trim().split('\n');
    assert.equal(Number(lines[0].trim()), expected, 'every byte read back: ' + lines[0]);
    const memTotalMB = Math.round(Number((/MemTotal:\s+(\d+)/.exec(lines[1] || '') || [])[1]) / 1024);
    assertDiskRoot(c);
    assert.ok(c.timings.diskMs <= 15000, 'image disk built in ' + c.timings.diskMs + ' ms');
    const con = fs.readFileSync(path.join(ROOT, 'microvms', r.id, 'console.log'), 'utf8');
    assert.ok(!/Out of memory|oom-kill|EXT4-fs error/i.test(con), con.slice(-1500));
    const img = ((await api('GET', '/api/images')).json.images || []).find((i) => (i.references || []).some((x) => /e2ebig/.test(x)));
    note(t, 'big image (disk root)', {
      unpackedMB: Math.round(expected / 1048576), madeMs, diskBuildMs: c.timings.diskMs, readAllMs: Date.parse(c.endedAt) - t1,
      guestMemTotalMB: memTotalMB, diskFileMB: img && img.diskBytes ? Math.round(img.diskBytes / 1048576) : null, compat: img ? img.compat || null : null,
    });
    // the Images list does not call it too large for the default (disk) root
    if (img && img.compat) assert.ok(!/large|docker-vm/i.test(JSON.stringify(img.compat)), JSON.stringify(img.compat));
    await remove(r.id);
    // RAM root: flagged before anything boots (engine auto: a suggestion,
    // never a switch) - or refused outright when no VM could hold it
    const m = await run({ image: 'e2ebig', rootfs: 'ram', cmd: ['true'] }, 120000);
    if (m.status === 202) {
      assert.equal(m.task.status, 'error');
      const cm = await rec(m.id);
      assert.ok((cm.fallback && cm.fallback.code === 'LARGE_IMAGE') || /IMAGE_TOO_LARGE|too large/i.test(m.task.error), JSON.stringify([m.task.error, cm.fallback]));
      assert.equal(cm.runtime, null, 'nothing booted');
      note(t, 'big image (RAM root)', { error: m.task.error, fallback: cm.fallback });
      await remove(m.id);
    } else {
      assert.equal(m.status, 409, JSON.stringify(m.json));
      note(t, 'big image (RAM root)', m.json);
    }
  });

  test('disk root: a QEMU killed while writing starts again cleanly (the journal recovers, no ext4 error)', async () => {
    const r = await run({ image: 'alpine', cmd: ['sh', '-c', 'echo synced >/s; sync; i=0; while true; do echo $i >>/busy; i=$((i+1)); done'] });
    await sleep(1500);
    const c = await rec(r.id);
    assert.equal(c.status, 'running');
    platform.killPid(c.runtime.pid);
    await ended(r.id, 30000);
    // start it again (the same writable layer) and read that boot's console
    const st = await api('POST', '/api/container/start', { id: r.id });
    await task(st.json.task.id);
    await sleep(1500);
    const con = fs.readFileSync(path.join(ROOT, 'microvms', r.id, 'console.log'), 'utf8');
    assert.ok(!/EXT4-fs error/.test(con), con.slice(-2000));
    assert.match(con, /__DEVBOX_ROOT uptime=/);
    await stop(r.id, { force: true });
    await remove(r.id);
  });

  test('disk root: a force-removed image keeps the disk a stopped container boots; removing that container deletes it', async () => {
    const r = await run({ image: 'busybox', cmd: ['echo', 'still-here'] });
    await ended(r.id);
    const c = await rec(r.id);
    const disk = path.join(ROOT, c.rootDisk.disk);
    assert.ok(fs.existsSync(disk));
    const rm1 = await api('POST', '/api/image/remove', { image: 'busybox', force: true });
    assert.equal(rm1.status, 200, rm1.text);
    assert.ok(fs.existsSync(disk), 'kept for the container');
    assert.ok(rm1.json.kept.some((k) => /writable layer/.test(k.why)), rm1.text);
    const s = await api('POST', '/api/container/start', { id: r.id });
    const st = await task(s.json.task.id);
    assert.equal(st.status, 'done', st.error);
    await ended(r.id);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'still-here');
    await remove(r.id);
    await until(async () => !fs.existsSync(disk), 10000, 'the dangling disk to go');
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

  test('disk root: the data folder moved to another path - a stopped container still boots its writable layer (relative backing names)', async () => {
    const cmd = ['sh', '-c', 'if [ -f /keep ]; then echo "found $(cat /keep)"; else echo moved-test >/keep; echo created; fi'];
    const r = await run({ image: 'alpine', cmd });
    await ended(r.id);
    assert.equal((await logs(r.id, 'stdout')).trim(), 'created');
    // nothing of ours may run while the folder moves
    const live = ((await api('GET', '/api/containers')).json.containers || []).filter((c) => !['exited', 'error', 'created'].includes(c.status));
    assert.deepEqual(live.map((c) => c.id + ':' + c.status), []);
    await stopManager(MANAGER);
    const moved = ROOT + '-moved';
    for (let i = 0; ; i++) {
      try { fs.renameSync(ROOT, moved); break; } catch (e) {
        // a file handle closing a moment late (antivirus, the exited manager)
        if (i >= 20) throw e;
        await sleep(500);
      }
    }
    ROOT = moved;
    MANAGER = await startManager();
    const s = await api('POST', '/api/container/start', { id: r.id });
    assert.equal(s.status, 202, s.text);
    const st = await task(s.json.task.id);
    assert.equal(st.status, 'done', st.error);
    const c = await ended(r.id);
    assert.equal(c.exitCode, 0, c.exitReason || '');
    assert.equal((await logs(r.id, 'stdout')).trim(), 'found moved-test', 'the writable layer, through its relative backing name');
    await remove(r.id);
  });

  test('TCG with the light profile: hello-world and nginx run on a 112 MB disk root with the 64 MB translation cache', async (t) => {
    const set = await api('POST', '/api/settings', { lightProfile: true });
    assert.equal(set.status, 200, set.text);
    try {
      const st = (await api('GET', '/api/state')).json;
      assert.equal(st.microvm.lightProfile, true);
      assert.deepEqual([st.microvm.defaults.rootfs, st.microvm.defaults.memMB, st.microvm.defaults.tcgTbSizeMB], ['disk', 112, 64]);
      const r = await tcgPair(t, 'TCG light profile', 250);
      assert.deepEqual([r.guestMB, r.tbSizeMB], [112, 64]);
    } finally {
      const back = await api('POST', '/api/settings', { lightProfile: null });
      assert.equal(back.status, 200, back.text);
    }
    const st2 = (await api('GET', '/api/state')).json;
    assert.deepEqual([st2.microvm.lightProfile, st2.microvm.defaults.memMB], [false, 128]);
  });

  test('MCP: status shows the container defaults and the light profile; run_image runs a disk root by default and a RAM root only when asked', async (t) => {
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
      const call = async (name, args) => {
        const r = await rpc('tools/call', { name, arguments: args || {} });
        assert.ok(r.result && !r.result.isError, JSON.stringify(r));
        return JSON.parse(r.result.content[0].text);
      };
      const st = await call('status');
      assert.equal(st.light_profile, false);
      assert.deepEqual([st.microvm_defaults.rootfs, st.microvm_defaults.memory_mb, st.microvm_defaults.min_memory_mb, st.microvm_defaults.min_memory_mb_ram], ['disk', 128, 96, 128]);
      // the accelerator hint is there only when no hardware acceleration works
      const accel = (await api('GET', '/api/state')).json.platform.accel;
      if (accel && accel.recommended !== 'tcg') assert.equal(st.accel_hint, undefined);
      else assert.ok(st.accel_hint && st.accel_hint.steps.length, JSON.stringify(st.accel_hint));
      note(t, 'MCP status', { light_profile: st.light_profile, microvm_defaults: st.microvm_defaults, accel_hint: st.accel_hint ? 'present' : 'none (' + (accel && accel.recommended) + ')' });
      const v = await call('run_image', { image: 'hello-world', wait_for: 'exit', remove_on_exit: true });
      assert.equal(v.exit_code, 0);
      assert.match(v.stdout, /Hello from Docker!/);
      assert.equal(v.rootfs, 'disk');
      const ram = await call('run_image', { image: 'hello-world', wait_for: 'exit', remove_on_exit: true, rootfs: 'ram' });
      assert.equal(ram.exit_code, 0);
      assert.equal(ram.rootfs, 'ram');
      // the light profile, as status reports it
      await api('POST', '/api/settings', { lightProfile: true });
      try {
        const sl = await call('status');
        assert.equal(sl.light_profile, true);
        assert.deepEqual([sl.microvm_defaults.memory_mb, sl.microvm_defaults.tcg_cache_mb], [112, 64]);
      } finally { await api('POST', '/api/settings', { lightProfile: null }); }
    } finally { child.kill(); }
  });

  test('full VM with the light profile: created with 512 MB by default, boots to SSH, stops cleanly', { skip: !WANT_VM && 'set DEVBOX_E2E_VM=1 (boots a full VM)' }, async (t) => {
    const config = require('../lib/config');
    const ssh = require('../lib/ssh');
    const set = await api('POST', '/api/settings', { lightProfile: true });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.settings.vmDefaultMemMB, 512);
    config.configure({ data: ROOT });
    // a VM with the defaults, from create to SSH; then (opt-in) the same
    // under forced TCG, where QEMU's translation cache is the light 256 MB
    const boot = async (name, extra, sshMs) => {
      const t0 = Date.now();
      const c = await api('POST', '/api/vm/create', Object.assign({ name, start: true, ephemeral: true }, extra || {}));
      assert.equal(c.status, 202, c.text);
      const ct = await task(c.json.task.id, 900000);
      assert.equal(ct.status, 'done', ct.error);
      const vm = (await api('GET', '/api/state')).json.vms.find((x) => x.name === name);
      assert.equal(vm.mem, 512, 'the light profile\'s default memory');
      const sh = (cmd) => ssh.sshExec({ name, port: vm.port }, cmd, { timeoutMs: 60000, connectTimeout: 10 });
      const r = await until(async () => { try { const x = await sh('echo ok; free -m | sed -n 2p'); return /^ok/.test(x.stdout || '') ? x : null; } catch (e) { return null; } }, sshMs, 'SSH into ' + name);
      const sshAfterMs = Date.now() - t0;
      await sleep(3000);
      const m = qemuMem(vm.pid);
      const cmd = await platform.processCommandLine(vm.pid);
      const out = { sshAfterMs, guestFree: (r.stdout.split('\n')[1] || '').trim(), qemu: m, tbSize: (/tb-size=(\d+)/.exec(cmd || '') || [])[1] || null };
      const s = await api('POST', '/api/vm/stop', { name });
      assert.equal(s.status, 202, s.text);
      const stt = await task(s.json.task.id, 180000);
      assert.equal(stt.status, 'done', stt.error);
      const after = (await api('GET', '/api/state')).json.vms.find((x) => x.name === name);
      assert.equal(after.status, 'stopped', JSON.stringify(after));
      const d = await api('POST', '/api/vm/delete', { name, force: true });
      if (d.status === 202) await task(d.json.task.id, 180000);
      return out;
    };
    try {
      const w = await boot('e2e-light', null, 300000);
      note(t, 'full VM light profile (default accel)', w);
      if (WANT_VM_TCG) {
        const tc = await boot('e2e-light-tcg', { accel: 'tcg' }, 1200000);
        note(t, 'full VM light profile (TCG)', tc);
        assert.equal(tc.tbSize, '256');
        if (tc.qemu) assert.ok(tc.qemu.privateMB < 512 + 256 + 150, 'QEMU private ' + tc.qemu.privateMB + ' MB');
      }
    } finally { await api('POST', '/api/settings', { lightProfile: null }); }
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

  // LAST: "Prune unused images" also removes every image no container uses
  // from the scratch cache. The age rule (10 minutes) is met by back-dating
  // the files (cov-8).
  test('prune: image disks and disk boot archives nobody uses go once old; the disk a writable layer names and the archive a running container booted stay', async (t) => {
    const qcow2 = require('../lib/microvm/qcow2');
    const old = (f) => { const s = (Date.now() - 30 * 60 * 1000) / 1000; fs.utimesSync(f, s, s); };
    // a running container: its image disk and its boot archive are in use
    const r = await run({ image: 'alpine', cmd: ['sleep', '600'] });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const c = await until(async () => { const x = await rec(r.id); return x && x.status === 'running' ? x : null; }, 60000, 'alpine to run');
    const used = path.join(ROOT, c.rootDisk.disk);
    const ctrs = JSON.parse(fs.readFileSync(path.join(ROOT, 'containers.json'), 'utf8')).containers;
    const bootArchive = ctrs[r.id].runtime.initrd;
    assert.match(path.basename(bootArchive), /^disk-[a-f0-9]{16}\.initrd$/);
    // two copies of that disk under keys nobody indexes: one named by an
    // orphan writable layer (referenced), one by nothing (dangling)
    const sidecar = JSON.parse(fs.readFileSync(used + '.json', 'utf8'));
    const copy = (key) => {
      const f = used.replace(/-[a-f0-9]{16}\.qcow2$/, '-' + key + '.qcow2');
      fs.copyFileSync(used, f);
      fs.writeFileSync(f + '.json', JSON.stringify(Object.assign({}, sidecar, { key })));
      return f;
    };
    const named = copy('1'.repeat(16)), dangling = copy('2'.repeat(16));
    const orphanDir = path.join(ROOT, 'microvms', 'e2e0deadbeef');
    fs.mkdirSync(orphanDir, { recursive: true });
    qcow2.createOverlay(path.join(orphanDir, 'root.qcow2'), '../../images/disks/' + path.basename(named), sidecar.virtualBytes, { backingFormat: 'qcow2' });
    const spare = path.join(ROOT, 'images', 'initrd', 'disk-' + '3'.repeat(16) + '.initrd');
    fs.copyFileSync(bootArchive, spare);
    for (const f of [used, named, dangling, dangling + '.json', named + '.json', bootArchive, spare]) old(f);
    const p = await api('POST', '/api/images/prune', {});
    assert.equal(p.status, 202, p.text);
    const done = await task(p.json.task.id, 180000);
    assert.equal(done.status, 'done', done.error);
    const exists = (f) => fs.existsSync(f);
    assert.ok(!exists(dangling) && !exists(dangling + '.json'), 'the dangling disk went with its sidecar');
    assert.ok(!exists(spare), 'the unused boot archive went');
    assert.ok(exists(used), 'the running container\'s disk stays');
    assert.ok(exists(named), 'the disk an overlay names stays: ' + JSON.stringify(done.result.kept));
    assert.ok(exists(bootArchive), 'the archive the running container booted stays');
    assert.ok(done.result.kept.some((k) => k.file === path.basename(named) && /writable layer/.test(k.why)), JSON.stringify(done.result.kept));
    note(t, 'prune', { removedImages: done.result.images, files: done.result.files, kept: done.result.kept.length });
    await stop(r.id, { force: true });
    await remove(r.id);
    fs.rmSync(orphanDir, { recursive: true, force: true });
  });
});
