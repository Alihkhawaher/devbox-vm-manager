'use strict';
/*
 * The container lifecycle (lib/microvm/containers.js) end to end WITHOUT
 * QEMU: a fake QEMU (a node script written below) gets the very command line
 * the engine builds, parses it like QEMU would (-chardev sockets and log
 * files, -mon, -pidfile, -fw_cfg, hostfwd), serves the console and HMP
 * monitor sockets and plays the guest side of init.sh's console protocol
 * (INIT, READY, STOPPING, NOSTART, SIGNAL, ERROR, EXIT). Its behaviour comes
 * from FAKE_* variables in the container's environment, which reach it
 * through the rendered run spec (fw_cfg opt/devbox/spec) - the same path
 * real settings take.
 *
 * Covers (microVM spec 18.1 "Supervisor with a fake QEMU"): stop before
 * READY with the resend until STOPPING (bug V2), an abort during prepare,
 * KILL-then-EXIT order and the forced quit only at the end (bug V5), the
 * honest `how` (V11b), records kept until Remove (V11a), adoption after a
 * manager restart and an exit while it was down, 4 concurrent starts with
 * distinct control endpoints (V3), the volume lock race (V1), log rotation,
 * autoRemove, a failed setup (125 + the init message, V8), live shares on
 * the command line, and the HTTP routes.
 */
const test = require('node:test');
const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../lib/config');
const { CFG } = config;
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const platform = require('../lib/platform');
const run = require('../lib/microvm/run');
const store = require('../lib/microvm/store');
const containers = require('../lib/microvm/containers');
const volumes = require('../lib/microvm/volumes');
const shares = require('../lib/shares');
const { useTempRoot, resetConfig, rm, request } = require('./helpers');

const FAKE_QEMU = String.raw`'use strict';
const fs = require('fs');
const net = require('net');
const args = process.argv.slice(2);
const all = (name) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === name) out.push(args[i + 1]); return out; };
const kv = (s) => { const o = {}; for (const p of String(s).replace(/,,/g, '\u0001').split(',')) { const q = p.replace(/\u0001/g, ','); const i = q.indexOf('='); if (i > 0) o[q.slice(0, i)] = q.slice(i + 1); else o[q] = true; } return o; };
const chardevs = {};
for (const c of all('-chardev')) { const i = c.indexOf(','); const o = kv(c.slice(i + 1)); o.type = c.slice(0, i); chardevs[o.id] = o; }
const pidFile = all('-pidfile')[0];
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
const fw = {};
for (const f of all('-fw_cfg')) { const o = kv(f); fw[o.name] = o.file; }
const specText = fw['opt/devbox/spec'] ? fs.readFileSync(fw['opt/devbox/spec'], 'utf8') : '';
const words = [];
specText.slice(specText.indexOf('devbox_exec() {')).replace(/'((?:[^']|'\\'')*)'/g, (m, w) => { words.push(w.replace(/'\\''/g, "'")); return m; });
const env = {};
for (const w of words) { const m = /^(FAKE_[A-Z_]+)=(.*)$/.exec(w); if (m) env[m[1]] = m[2]; }
const num = (k, d) => (env[k] !== undefined ? Number(env[k]) : d);
const con = chardevs.con0, mon = chardevs.mon0;
const conLog = con.logfile;
const out = chardevs.vp0 && chardevs.vp0.path, err = chardevs.vp1 && chardevs.vp1.path;
const w = (s) => fs.appendFileSync(conLog, s);
fs.writeFileSync(conLog, '');
if (out) fs.writeFileSync(out, '');
if (err) fs.writeFileSync(err, '');
process.stdout.write('qemu-system-x86_64: info: Windows Hypervisor Platform accelerator is operational\n');
if (env.FAKE_RECORD) fs.writeFileSync(env.FAKE_RECORD, JSON.stringify({ args, fw, specText }));
let readerOn = false, appRunning = false, stopping = false, exited = false;
const TERM = env.FAKE_TERM || 'exit';
const STUCK = env.FAKE_STUCK || '';
function exit(code, nostart) {
  if (exited) return;
  exited = true;
  if (nostart) w('__DEVBOX_NOSTART\n');
  w('__DEVBOX_EXIT=' + code + '\n');
  setTimeout(() => process.exit(0), 60);
}
function onCmd(line) {
  if (!readerOn) return; // lost, like the 8250 FIFO reset while the driver loads
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === '__DEVBOX_STOP') {
    w('__DEVBOX_STOPPING\n');
    if (stopping) return;
    stopping = true;
    if (!appRunning) return;
    const t = arg !== undefined ? Number(arg) : 10;
    if (TERM === 'exit') setTimeout(() => exit(num('FAKE_TERM_CODE', 143)), 30);
    else if (STUCK !== 'timer' && STUCK !== 'all') setTimeout(() => exit(137), t * 1000);
  } else if (cmd === '__DEVBOX_KILL') {
    const sig = arg || 'KILL';
    if (!appRunning) { if (/^(KILL|TERM|INT|QUIT)$/.test(sig)) { stopping = true; w('__DEVBOX_STOPPING\n'); } return; }
    w('__DEVBOX_SIGNAL=' + sig + '\n');
    if (sig === 'KILL') { w('__DEVBOX_STOPPING\n'); if (STUCK !== 'all') setTimeout(() => exit(137), 30); }
  }
}
const srv = net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onCmd(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  s.on('error', () => {});
});
srv.listen(Number(con.port), con.host);
if (mon) {
  const m = net.createServer((s) => {
    s.write('QEMU 10.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
    s.on('data', (d) => {
      const c = d.toString().trim();
      if (c === 'quit') { w('[fake] quit\n'); s.end(); setTimeout(() => process.exit(0), 20); return; }
      // like QEMU: the -name it was started with (the identity check)
      if (c === 'info name') { s.write(c + '\r\n' + (all('-name')[0] || '') + '\r\n(qemu) '); return; }
      if (c === 'system_powerdown' && readerOn) onCmd('__DEVBOX_STOP');
      s.write(c + '\r\n(qemu) ');
    });
    s.on('error', () => {});
  });
  m.listen(Number(mon.port), mon.host);
}
const fwds = [];
for (const nd of all('-netdev')) for (const r of nd.split(',').filter((x) => x.startsWith('hostfwd='))) {
  const m = /^hostfwd=(tcp|udp):([\d.]+):(\d+)-:(\d+)$/.exec(r);
  if (m && m[1] === 'tcp') fwds.push({ host: m[2], port: Number(m[3]) });
}
// like QEMU: the host side of every forward listens from the start; an
// accepted connection is held open only once the "app" runs (FAKE_LISTEN)
for (const f of fwds) net.createServer((s) => { if (!(appRunning && env.FAKE_LISTEN)) s.destroy(); else s.on('error', () => {}); }).listen(f.port, f.host);
// FAKE_HANG: the kernel hangs before init (the TCG calibrate_delay hang):
// no marker, no reader - only the monitor's quit ends it
if (!env.FAKE_HANG) setTimeout(() => {
  w('[    0.10] Linux version fake\n__DEVBOX_INIT uptime=0.10\n');
  setTimeout(() => { readerOn = true; }, num('FAKE_READER_MS', 0));
  setTimeout(() => {
    if (env.FAKE_INIT_ERROR) { w('devbox-init: ' + env.FAKE_INIT_ERROR + '\n__DEVBOX_ERROR=' + env.FAKE_INIT_ERROR + '\n'); exit(125); return; }
    if (stopping) { exit(0, true); return; }
    w('__DEVBOX_READY\n');
    appRunning = true;
    if (out) fs.appendFileSync(out, (env.FAKE_STDOUT || 'hello from fake') + '\n');
    // an app flooding its output past every cap inside the guest
    if (out && env.FAKE_STDOUT_BYTES) fs.appendFileSync(out, Buffer.alloc(Number(env.FAKE_STDOUT_BYTES), 0x61));
    if (err && env.FAKE_STDERR) fs.appendFileSync(err, env.FAKE_STDERR + '\n');
    if (env.FAKE_DIE === 'nomarker') setTimeout(() => process.exit(1), 50);
    if (env.FAKE_EXIT_AFTER_MS !== undefined) setTimeout(() => exit(num('FAKE_EXIT_CODE', 0)), num('FAKE_EXIT_AFTER_MS', 0));
  }, num('FAKE_READY_MS', 80));
}, num('FAKE_BOOT_MS', 40));
`;

let fakeScript;
const spawned = [];
const orig = {};
let prepHook = null;

function fakeKernel() {
  const dir = path.join(CFG.kernelDir, '1.0.0-0-virt');
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  for (const f of ['busybox.static', 'vmlinuz-virt', 'modules/virtio_net.ko', 'modules/9p.ko']) fs.writeFileSync(path.join(dir, f), 'X');
  const manifest = {
    kver: '1.0.0-0-virt', modules: { virtio_net: { file: 'modules/virtio_net.ko' }, '9p': { file: 'modules/9p.ko' } },
    features: { net: ['virtio_net'], ninep: ['9p'] }, sha256: { 'busybox.static': 'x' },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

// run.prepareImage stand-in: an "image" whose runtime the test chooses
function fakePrep(k, runtime) {
  const initrd = path.join(CFG.imagesDir, 'initrd', 'aaaaaaaaaaaa-0000000000000000.initrd');
  fs.mkdirSync(path.dirname(initrd), { recursive: true });
  if (!fs.existsSync(initrd)) fs.writeFileSync(initrd, Buffer.alloc(4096));
  return {
    reference: 'docker.io/library/fake:latest', familiar: 'fake', configDigest: 'sha256:' + 'a'.repeat(64), manifestDigest: 'sha256:' + 'b'.repeat(64),
    runtime: Object.assign({ entrypoint: [], cmd: ['/app'], env: ['PATH=/bin'], workingDir: '/', user: '', exposedPorts: [], stopSignal: null, volumes: [], labels: {} }, runtime || {}),
    initrd, initrdBytes: 4096, initrdKey: '0000000000000000', rootfsBytes: 4096, kernelDir: k.dir, manifest: k.manifest,
    compressedBytes: 1000, downloadedBytes: 0, rateLimit: null, warnings: [], config: {}, cached: { image: true, initrd: true },
    timings: { pullMs: 1, flattenMs: 0, initrdMs: 0 },
  };
}

let K;
// ONE suite: tests/index.js loads every test file into one process, so the
// stubs below (platform.findTool, run.prepareImage, ...) must only be in
// place while these tests run - suite-level hooks, not file-level ones
describe('microVM containers with a fake QEMU', () => {
before(() => {
  useTempRoot('ctr-sup');
  st.loadState();
  containers.load();
  K = fakeKernel();
  fakeScript = path.join(CFG.root, 'fake-qemu.js');
  fs.writeFileSync(fakeScript, FAKE_QEMU);
  Object.assign(orig, {
    findTool: platform.findTool, detectAccel: platform.detectAccel, listQemuPids: platform.listQemuPids,
    prepareImage: run.prepareImage, hostFacts: run.hostFacts, launch: run.launch,
  });
  platform.findTool = (n) => (n === 'qemu' ? path.join(CFG.root, 'qemu-system-x86_64') : orig.findTool(n));
  platform.detectAccel = async () => ({ available: ['tcg'], recommended: 'tcg' });
  run.prepareImage = async (ref, o) => {
    if (prepHook) await prepHook(ref, o);
    if (o && o.signal && o.signal.aborted) throw Object.assign(new Error('stopped before the app started'), { code: 'ABORTED' });
    return fakePrep(K, (prepHook && prepHook.runtime) || null);
  };
  run.hostFacts = async () => ({ machines: ['microvm', 'q35'], tscKhz: 2000000, accel: 'tcg' });
  run.launch = (o) => orig.launch(Object.assign({}, o, {
    spawnFn: (qemu, args, qemuLog) => {
      const fd = fs.openSync(qemuLog, 'w');
      let child;
      try { child = spawn(process.execPath, [fakeScript].concat(args), { stdio: ['ignore', fd, fd], windowsHide: true }); }
      finally { fs.closeSync(fd); }
      spawned.push(child);
      return child;
    },
  }));
});

after(async () => {
  for (const c of spawned) { try { c.kill(); } catch (e) { /* gone */ } }
  containers.shutdown();
  Object.assign(platform, { findTool: orig.findTool, detectAccel: orig.detectAccel, listQemuPids: orig.listQemuPids });
  Object.assign(run, { prepareImage: orig.prepareImage, hostFacts: orig.hostFacts, launch: orig.launch });
  try { await shares.shutdown(); } catch (e) { /* not started */ }
  tasks._reset();
  const root = CFG.root;
  resetConfig();
  await new Promise((r) => setTimeout(r, 200));
  rm(root);
  store.load();
});

async function runC(body) {
  const r = await containers.runRoute(Object.assign({ image: 'fake', ports: [] }, body));
  return { id: r.container.id, name: r.container.name, task: r.task };
}
async function waitTask(id) { return tasks.wait(id); }
async function until(pred, ms, what) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out waiting for ' + (what || 'a condition'));
}
async function stopC(id, o) {
  const a = await containers.validateStop(Object.assign({ id }, o || {}));
  const s = tasks.start({ kind: 'ctr-stop', title: 'stop', ctr: a.id, locks: ['ctr-stop:' + a.id] }, (t) => containers.opStop(t, a));
  const done = await tasks.wait(s.id);
  assert.equal(done.status, 'done', JSON.stringify(done));
  return { result: done.result, log: tasks.get(s.id).log.join('\n') };
}
const envOf = (o) => Object.entries(o).map(([k, v]) => k + '=' + v);
const consoleOf = (id) => { try { return fs.readFileSync(path.join(CFG.microvmsDir, id, 'console.log'), 'utf8'); } catch (e) { return ''; } };

test('run: hello-world style one-shot - READY, output, exit code kept on the record (V11a)', async () => {
  const c = await runC({ env: envOf({ FAKE_EXIT_AFTER_MS: 50, FAKE_EXIT_CODE: 3, FAKE_STDOUT: 'Hello from Docker!' }) });
  const done = await waitTask(c.task.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.result.status, 'exited');
  assert.equal(done.result.exitCode, 3);
  assert.match(done.result.stdout, /Hello from Docker!/);
  const rec = store.get(c.id);
  await until(() => !containers.isLive(c.id), 5000, 'the end');
  assert.deepEqual([rec.status, rec.exitCode, rec.runtime], ['exited', 3, null]);
  assert.ok(rec.readyAt && rec.endedAt && rec.timings.readyMs >= 0);
  assert.ok(!fs.existsSync(path.join(CFG.microvmsDir, c.id, 'spec.sh')), 'the spec (env secrets) is deleted once the guest read it');
  // the record, logs and ports stay until Remove (bug V11a)
  const logs = await containers.getLogs({ id: c.id, stream: 'stdout' });
  assert.match(logs.text, /Hello from Docker!/);
  // stopping an exited container keeps it (bug V11a) and says so (V11b)
  const s = await stopC(c.id);
  assert.equal(s.result.how, 'already exited');
  assert.ok(store.get(c.id));
  await containers.removeRoute({ id: c.id });
  assert.equal(store.get(c.id), null);
  assert.ok(!fs.existsSync(path.join(CFG.microvmsDir, c.id)));
});

test('stop before READY: resent every second until the guest acknowledges; the app never starts (V2)', async () => {
  // the guest reads commands only 1.5 s after INIT (the 8250 FIFO is reset
  // while its driver loads): the first requests are lost
  const c = await runC({ env: envOf({ FAKE_READER_MS: 1500, FAKE_READY_MS: 2500 }) });
  await until(() => containers.isLive(c.id) && containers._internal.lives.get(c.id).phase === 'spawned', 10000, 'the spawn');
  const s = await stopC(c.id, { timeoutS: 5 });
  assert.equal(s.result.how, 'stopped before the app started');
  assert.equal(s.result.exitCode, null);
  assert.match(s.log, /sent [2-9] times/, s.log);
  const run1 = await waitTask(c.task.id);
  assert.equal(run1.status, 'done', run1.error);
  assert.equal(run1.result.stopped, true);
  const rec = store.get(c.id);
  assert.deepEqual([rec.status, rec.exitCode, rec.exitReason], ['exited', null, 'stopped before the app started']);
  assert.ok(!/__DEVBOX_READY/.test(consoleOf(c.id)));
});

test('stop during prepare: the run is aborted, no VM is created', async () => {
  let started;
  const gate = new Promise((r) => { started = r; });
  prepHook = async (ref, o) => {
    started();
    await new Promise((r) => { if (o.signal.aborted) r(); else o.signal.addEventListener('abort', r); });
  };
  try {
    const n = spawned.length;
    const c = await runC({});
    await gate;
    const s = await stopC(c.id);
    assert.equal(s.result.how, 'stopped before the app started');
    const r = await waitTask(c.task.id);
    assert.equal(r.status, 'done', r.error);
    assert.equal(store.get(c.id).exitReason, 'stopped before the app started');
    assert.equal(spawned.length, n, 'no QEMU was started');
    await containers.removeRoute({ id: c.id });
  } finally { prepHook = null; }
});

test('graceful stop of a running app; an app that ignores TERM gets KILL after the timeout - "killed", never "graceful" (V5, V11b)', async () => {
  const a = await runC({ env: envOf({ FAKE_TERM: 'exit' }) });
  assert.equal((await waitTask(a.task.id)).result.status, 'running');
  const s1 = await stopC(a.id, { timeoutS: 5 });
  assert.deepEqual([s1.result.how, s1.result.exitCode], ['graceful', 143]);
  // TERM ignored: the guest's own timer sends KILL after timeoutS
  const b = await runC({ env: envOf({ FAKE_TERM: 'ignore' }) });
  await waitTask(b.task.id);
  const s2 = await stopC(b.id, { timeoutS: 1 });
  assert.deepEqual([s2.result.exitCode, s2.result.how], [137, 'killed after 1 s']);
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

test('stop order: STOP, then KILL inside the guest (it still syncs), and a forced quit only at the very end (V5)', async () => {
  // the guest acknowledges but its own KILL timer never fires: the host
  // sends KILL after timeout + 5 s
  const a = await runC({ env: envOf({ FAKE_TERM: 'ignore', FAKE_STUCK: 'timer' }) });
  await waitTask(a.task.id);
  const t0 = Date.now();
  const s = await stopC(a.id, { timeoutS: 0 });
  assert.equal(s.result.exitCode, 137);
  assert.equal(s.result.how, 'killed after 5 s');
  assert.ok(Date.now() - t0 >= 4500);
  const con = consoleOf(a.id);
  assert.ok(con.indexOf('__DEVBOX_STOPPING') < con.indexOf('__DEVBOX_SIGNAL=KILL'), con);
  assert.ok(!/\[fake\] quit/.test(con), 'no power cut: the guest exited by itself');
  // a guest that ignores everything: forced (HMP quit) - only after KILL
  const b = await runC({ env: envOf({ FAKE_TERM: 'ignore', FAKE_STUCK: 'all' }) });
  await waitTask(b.task.id);
  const s2 = await stopC(b.id, { force: true });
  assert.equal(s2.result.how, 'forced (quit)');
  assert.equal(s2.result.exitCode, 137);
  const con2 = consoleOf(b.id);
  assert.ok(con2.indexOf('__DEVBOX_SIGNAL=KILL') >= 0 && con2.indexOf('__DEVBOX_SIGNAL=KILL') < con2.indexOf('[fake] quit'), con2);
  assert.match(store.get(b.id).exitReason, /did not stop/);
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

// Found in the integration E2E: a VM stuck while booting (before init) that
// the user stopped was recorded as exit 137 "powered off", as if the app had
// been killed; the app never ran, so it has no exit code (spec 6.3: null).
test('a stop while the VM hangs before init: forced quit, exit code null "stopped before the app started"', async () => {
  const c = await runC({ env: envOf({ FAKE_HANG: 1 }) });
  await until(() => containers.isLive(c.id) && containers._internal.lives.get(c.id).phase === 'spawned', 10000, 'the spawn');
  const s = await stopC(c.id, { force: true });
  assert.equal(s.result.how, 'forced (quit)');
  assert.equal(s.result.exitCode, null);
  const r = await waitTask(c.task.id);
  assert.notEqual(r.status, 'running');
  const rec = store.get(c.id);
  assert.equal(rec.exitCode, null);
  assert.match(rec.exitReason, /stopped before the app started/);
  await containers.removeRoute({ id: c.id });
});

test('failed setup: exit 125, status error, the init message as the reason (V8); engine failure without a marker is 125 too', async () => {
  const a = await runC({ env: envOf({ FAKE_INIT_ERROR: 'volume setup failed: cannot mount the disk of volume vol0 (/dev/vda)' }) });
  const r = await waitTask(a.task.id);
  assert.equal(r.status, 'error');
  assert.match(r.error, /cannot mount the disk of volume vol0/);
  const rec = store.get(a.id);
  assert.deepEqual([rec.status, rec.exitCode], ['error', 125]);
  assert.match(rec.exitReason, /cannot mount the disk/);
  assert.ok(rec.initMessages.some((m) => /cannot mount/.test(m)));
  // QEMU dies after the start window without an exit marker
  const b = await runC({ env: envOf({ FAKE_DIE: 'nomarker', FAKE_READY_MS: 700 }) });
  await waitTask(b.task.id);
  await until(() => !containers.isLive(b.id), 5000, 'the end');
  assert.deepEqual([store.get(b.id).status, store.get(b.id).exitCode], ['error', 125]);
  assert.match(store.get(b.id).exitReason, /without an exit status/);
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

test('4 concurrent starts all run, each with its own private control endpoints (V3)', async () => {
  const cs = await Promise.all([0, 1, 2, 3].map(() => runC({})));
  const rs = await Promise.all(cs.map((c) => waitTask(c.task.id)));
  for (const r of rs) assert.equal(r.status, 'done', r.error);
  const eps = cs.map((c) => JSON.stringify(store.get(c.id).runtime.console));
  assert.equal(new Set(eps).size, 4);
  if (platform.IS_WIN) for (const c of cs) assert.ok(!/"127\.0\.0\.1"/.test(JSON.stringify(store.get(c.id).runtime.console)), 'never 127.0.0.1');
  const s = containers.summaries().filter((x) => cs.some((c) => c.id === x.id));
  assert.deepEqual(s.map((x) => x.status), ['running', 'running', 'running', 'running']);
  await Promise.all(cs.map((c) => stopC(c.id)));
  for (const c of cs) await containers.removeRoute({ id: c.id });
});

test('volume race: two concurrent runs on one volume - one gets VOLUME_IN_USE (V1); the lock goes with the exit', async () => {
  const body = { volumes: ['shared-data:/data'] };
  const [a, b] = await Promise.all([runC(body), runC(body)]);
  const [ra, rb] = await Promise.all([waitTask(a.task.id), waitTask(b.task.id)]);
  const ok = [ra, rb].filter((r) => r.status === 'done');
  const bad = [ra, rb].filter((r) => r.status === 'error');
  assert.equal(ok.length, 1, JSON.stringify([ra.error, rb.error]));
  assert.equal(bad.length, 1);
  assert.match(bad[0].error, /in use by container/);
  const winner = ok[0] === ra ? a : b;
  const lock = volumes.readLock(CFG.volumesDir, 'shared-data');
  assert.equal(lock.containerId, winner.id);
  assert.equal(lock.managerPid, process.pid);
  // an attached volume cannot be removed
  await assert.rejects(containers.removeVolume({ name: 'shared-data' }), (e) => e.code === 'VOLUME_IN_USE' && /stop it first/.test(e.message));
  const listed = (await containers.listVolumes()).volumes.find((v) => v.name === 'shared-data');
  assert.equal(listed.attached, true);
  assert.deepEqual(listed.usedBy.map((u) => u.running).sort(), [false, true]);
  await stopC(winner.id);
  assert.equal(volumes.readLock(CFG.volumesDir, 'shared-data'), null, 'released at the exit');
  // stopped users do not block it (they get a new, empty volume next time)
  assert.deepEqual((await containers.removeVolume({ name: 'shared-data' })).removed, 'shared-data');
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

test('restart: logs of the previous boot are kept as *.prev.log; autoRemove removes the record at the exit', async () => {
  const a = await runC({ env: envOf({ FAKE_EXIT_AFTER_MS: 20, FAKE_STDOUT: 'boot-one' }) });
  await waitTask(a.task.id);
  await until(() => !containers.isLive(a.id), 5000);
  store.get(a.id).env = envOf({ FAKE_EXIT_AFTER_MS: 20, FAKE_STDOUT: 'boot-two' });
  const v = await containers.validateStart({ id: a.id });
  const s = tasks.start({ kind: 'ctr-start', ctr: a.id, locks: ['ctr:' + a.id] }, (t) => containers.opStart(t, v));
  const r = await waitTask(s.id);
  assert.equal(r.status, 'done', r.error);
  assert.match((await containers.getLogs({ id: a.id, stream: 'stdout' })).text, /boot-two/);
  assert.match((await containers.getLogs({ id: a.id, stream: 'stdout', prev: true })).text, /boot-one/);
  await containers.removeRoute({ id: a.id });
  const b = await runC({ autoRemove: true, env: envOf({ FAKE_EXIT_AFTER_MS: 20 }) });
  const rb = await waitTask(b.task.id);
  assert.equal(rb.result.exitCode, 0);
  await until(() => !store.get(b.id), 5000, 'the removal');
  assert.ok(!fs.existsSync(path.join(CFG.microvmsDir, b.id)));
});

test('adoption after a manager restart: a running container is watched again and stops; one that exited meanwhile shows its code', async () => {
  const a = await runC({});
  const b = await runC({ env: envOf({ FAKE_TERM_CODE: 42 }) });
  await Promise.all([waitTask(a.task.id), waitTask(b.task.id)]);
  const pa = store.get(a.id).runtime.pid, pb = store.get(b.id).runtime.pid;
  // "the manager stops": watchers go, the VMs keep running
  containers.shutdown();
  assert.equal(containers.isLive(a.id), false);
  // b ends while nobody watches
  await run.sendConsole(store.get(b.id).runtime.console, '__DEVBOX_STOP 5\n');
  await until(() => !platform.pidAlive(pb), 5000, 'b to end');
  platform.listQemuPids = async () => new Set([pa]);
  try {
    const out = await containers.adoptAll();
    assert.equal(out.adopted, 1);
    assert.equal(out.exited, 1);
  } finally { platform.listQemuPids = orig.listQemuPids; }
  assert.equal(containers.isLive(a.id), true);
  await until(() => store.get(a.id).status === 'running', 3000, 'the replayed READY');
  const rb = store.get(b.id);
  assert.deepEqual([rb.status, rb.exitCode, rb.runtime], ['exited', 42, null]);
  const s = await stopC(a.id);
  assert.equal(s.result.how, 'graceful');
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

test('ports: EXPOSE published when none are given; the run waits for the app to answer; a port in use is refused up front (V7)', async () => {
  prepHook = async () => {};
  const guest = await platform.freeLocalPort('127.0.0.1');
  prepHook.runtime = { exposedPorts: [guest + '/tcp'] };
  try {
    const c = await containers.runRoute({ image: 'fake', env: envOf({ FAKE_LISTEN: 1 }) });
    const r = await waitTask(c.task.id);
    assert.equal(r.status, 'done', r.error);
    const rec = store.get(c.container.id);
    assert.equal(rec.ports.length, 1);
    assert.deepEqual([rec.ports[0].guest, rec.ports[0].auto, rec.ports[0].lan], [guest, true, false]);
    assert.ok(r.result.urls[0].url.startsWith('http://127.0.0.1:' + rec.ports[0].host));
    assert.ok(rec.timings.firstResponseMs > 0, 'the app answered');
    // a record's ports are reserved for everyone else, running or not
    await assert.rejects(runC({ ports: [rec.ports[0].host + ':80'] }), (e) => e.code === 'PORT_CONFLICT');
    await stopC(c.container.id);
    await containers.removeRoute({ id: c.container.id });
  } finally { prepHook = null; }
  // another program holds 127.0.0.1:P: a LAN (0.0.0.0) forward must not
  // be printed as working (bug V7)
  const squat = net.createServer();
  await new Promise((r) => squat.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(runC({ ports: ['lan:' + squat.address().port + ':80'] }), (e) => e.code === 'PORT_CONFLICT' && /in use/.test(e.message));
  } finally { squat.close(); }
});

test('live shared folder: registered with the 9P server, passed as the fw_cfg share list, unregistered at the exit', async () => {
  await shares.ensureServer({ port: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-share-'));
  const recFile = path.join(CFG.root, 'fake-record.json');
  try {
    const c = await runC({ volumes: [dir + ':/app:ro'], user: '101', env: envOf({ FAKE_RECORD: recFile }) });
    const r = await waitTask(c.task.id);
    assert.equal(r.status, 'done', r.error);
    const rec = store.get(c.id);
    assert.equal(rec.shares.length, 1);
    assert.equal(rec.shares[0].guestPath, '/app');
    assert.ok(rec.shares[0].secret && rec.shares[0].id);
    const seen = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const file = seen.fw['opt/devbox/shares'];
    assert.ok(file, 'the share list is a fw_cfg file');
    assert.ok(!seen.args.join(' ').includes(rec.shares[0].secret), 'the secret is never on the command line');
    assert.match(seen.specText, new RegExp("devbox_share '" + rec.shares[0].id + "' '/app' ro"));
    assert.ok(!seen.specText.includes(rec.shares[0].secret), 'nor in the spec');
    assert.ok(shares.registered(c.id).length === 1);
    // the API never shows the secret
    const pub = JSON.stringify(await containers.getContainer({ id: c.id, reveal: true })) + JSON.stringify(containers.summaries()) + JSON.stringify(await containers.listContainers({}));
    assert.ok(!pub.includes(rec.shares[0].secret));
    await stopC(c.id);
    assert.deepEqual(shares.registered(c.id), []);
    await containers.removeRoute({ id: c.id });
  } finally { rm(dir); }
});

test('kill passes one signal on; settings apply at the next start (pendingRestart); names stay unique', async () => {
  const a = await runC({ name: 'kill-me', ports: [] });
  await waitTask(a.task.id);
  await assert.rejects(containers.kill({ id: a.id, signal: 'NOPE' }), (e) => e.status === 400);
  assert.deepEqual(await containers.kill({ id: 'kill-me', signal: 'SIGHUP' }), { id: a.id, signal: 'HUP', sent: true });
  await until(() => /__DEVBOX_SIGNAL=HUP/.test(consoleOf(a.id)), 5000, 'the guest to get HUP');
  const before = r0Ports(a.id);
  const r = await containers.updateSettings({ id: a.id, mem: 512, note: 'n1', ports: ['19999:80'] });
  assert.equal(r.pendingRestart, true);
  assert.equal(r.container.mem, 512);
  // it runs: QEMU keeps its current ports until the next start - the URLs
  // stay those, the edit waits in pendingPorts, and both stay reserved (correct-8)
  assert.deepEqual(r.container.ports, before);
  assert.deepEqual(r.container.pendingPorts.map((p) => p.host), [19999]);
  assert.deepEqual(containers.summaries().find((x) => x.id === a.id).pendingPorts.map((p) => p.host), [19999]);
  const b = await runC({ name: 'other', ports: [] });
  await waitTask(b.task.id);
  await assert.rejects(containers.updateSettings({ id: b.id, name: 'kill-me' }), (e) => e.code === 'NAME_IN_USE');
  await assert.rejects(containers.updateSettings({ id: b.id, ports: ['19999:80'] }), (e) => e.code === 'PORT_CONFLICT');
  await assert.rejects(containers.kill({ id: 'nosuch', signal: 'HUP' }), (e) => e.code === 'NO_SUCH_CONTAINER');
  await stopC(a.id);
  await stopC(b.id);
  await assert.rejects(containers.kill({ id: a.id, signal: 'HUP' }), (e) => e.code === 'NOT_RUNNING');
  // the next start publishes the edited ports
  const v = await containers.validateStart({ id: a.id });
  const s = tasks.start({ kind: 'ctr-start', ctr: a.id, locks: ['ctr:' + a.id] }, (t) => containers.opStart(t, v));
  await waitTask(s.id);
  assert.deepEqual(store.get(a.id).ports.map((p) => p.host), [19999]);
  assert.equal(store.get(a.id).pendingPorts, undefined);
  await stopC(a.id);
  await containers.removeRoute({ id: a.id });
  await containers.removeRoute({ id: b.id });
});

function r0Ports(id) { return JSON.parse(JSON.stringify(store.get(id).ports)); }

test('engines: request rules pick Docker-in-VM up front (auto), 409 for microvm; fallback hands the ports to the new VM', async () => {
  const deploy = require('../lib/deploy');
  const origV = deploy.validateQuickDeploy, origOp = deploy.opQuickDeploy;
  const seen = [];
  deploy.validateQuickDeploy = async (b) => { seen.push({ body: b, reserved: Array.from(require('../lib/ports').reservedPorts().keys()) }); return Object.assign({}, b, { name: 'vm-from-' + String(b.image).replace(/[^a-z]/g, ''), claimed: [] }); };
  deploy.opQuickDeploy = async () => ({ ok: true });
  try {
    const auto = await containers.runRoute({ image: 'nginx:alpine', privileged: true, ports: ['18181:80,lan'], env: { A: '1' } });
    assert.equal(auto.engine, 'docker-vm');
    assert.match(auto.reason, /privileged/);
    assert.equal(auto.task.kind, 'quickdeploy');
    assert.deepEqual(seen[0].body.ports, [{ host: 18181, guest: 80, lan: true }]);
    assert.deepEqual(seen[0].body.env, ['A=1']);
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', privileged: true, engine: 'microvm' }), (e) => e.code === 'NOT_COMPATIBLE' && e.fallback.engine === 'docker-vm');
    const dv = await containers.runRoute({ image: 'nginx:alpine', engine: 'docker-vm', volumes: ['data:/data'] });
    assert.equal(dv.engine, 'docker-vm');
    assert.deepEqual(seen[1].body.volumes, ['data:/data'], 'named volumes stay Docker named volumes');
    await assert.rejects(containers.runRoute({ image: 'nginx:alpine', engine: 'docker-vm', volumes: [CFG.root + ':/x'] }), /host folders are shared with microVM containers only/);
    // "Run with Docker-in-VM instead": the stopped container's ports go to the VM
    const c = await runC({ ports: ['18182:80'], env: envOf({ FAKE_EXIT_AFTER_MS: 10 }) });
    await waitTask(c.task.id);
    await until(() => !containers.isLive(c.id), 5000);
    const fb = await containers.fallbackRoute({ id: c.id });
    assert.equal(fb.engine, 'docker-vm');
    const last = seen[seen.length - 1];
    assert.deepEqual(last.body.ports, [{ host: 18182, guest: 80, lan: false }]);
    assert.ok(!last.reserved.includes(18182), 'its own ports do not count against the VM taking them over');
    assert.deepEqual(store.get(c.id).ports, []);
    assert.equal(store.get(c.id).fallback.vm, fb.vm);
    await containers.removeRoute({ id: c.id });
  } finally {
    deploy.validateQuickDeploy = origV;
    deploy.opQuickDeploy = origOp;
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('HTTP: run/stop/logs routes, 400/404/409 mapping, env values redacted, SSE log stream with byte offsets', async () => {
  const { createServer } = require('../lib/http');
  const token = config.ensureToken();
  const server = createServer({ token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const H = { 'Content-Type': 'application/json', 'X-DevBox-Token': token };
  try {
    const bad = await request(port, { method: 'POST', path: '/api/container/run', headers: H, body: { image: 'Bad Ref!' } });
    assert.deepEqual([bad.status, bad.json.code], [400, 'BAD_REFERENCE']);
    const hf = await request(port, { method: 'POST', path: '/api/container/run', headers: H, body: { image: 'fake', volumes: ['C:\\no\\such\\dir:/x'] } });
    assert.equal(hf.status, 400, hf.text);
    const tty = await request(port, { method: 'POST', path: '/api/container/run', headers: H, body: { image: 'fake', tty: true } });
    assert.equal(tty.status, 400);
    const run1 = await request(port, { method: 'POST', path: '/api/container/run', headers: H, body: { image: 'fake', name: 'web1', ports: [], env: ['SECRET_TOKEN=hunter2', 'FAKE_STDOUT=line-one'] } });
    assert.equal(run1.status, 202, run1.text);
    assert.equal(run1.json.engine, 'microvm');
    assert.equal(run1.json.container.name, 'web1');
    const dup = await request(port, { method: 'POST', path: '/api/container/run', headers: H, body: { image: 'fake', name: 'web1' } });
    assert.deepEqual([dup.status, dup.json.code], [409, 'NAME_IN_USE']);
    await tasks.wait(run1.json.task.id);
    const list = await request(port, { path: '/api/containers', headers: H });
    assert.ok(!list.text.includes('hunter2') && list.text.includes('SECRET_TOKEN=***'));
    const one = await request(port, { path: '/api/container?id=web1&reveal=1', headers: H });
    assert.ok(one.text.includes('hunter2'), 'reveal shows the values');
    const none = await request(port, { path: '/api/container?id=nosuch', headers: H });
    assert.deepEqual([none.status, none.json.code], [404, 'NO_SUCH_CONTAINER']);
    const busy = await request(port, { method: 'POST', path: '/api/container/remove', headers: H, body: { id: 'web1' } });
    assert.deepEqual([busy.status, busy.json.code], [409, 'RUNNING']);
    const logs = await request(port, { path: '/api/container/logs?id=web1&stream=stdout', headers: H });
    assert.match(logs.json.text, /line-one/);
    // SSE: chunks carry the byte offset; a reconnect with since=n gets only the rest
    const sse = await new Promise((resolve, reject) => {
      const http = require('http');
      const req = http.get({ host: '127.0.0.1', port, path: '/api/container/logs/stream?id=web1&stream=stdout&token=' + token }, (res) => {
        let buf = '';
        res.on('data', (d) => { buf += d; if (/"n":\d+/.test(buf)) { req.destroy(); resolve({ status: res.statusCode, buf }); } });
      });
      req.on('error', (e) => { if (!/aborted|ECONNRESET|socket hang up/.test(String(e.message))) reject(e); });
    });
    assert.equal(sse.status, 200);
    const ev = JSON.parse(/data: (.*)\n/.exec(sse.buf)[1]);
    assert.equal(ev.n, Buffer.byteLength('line-one\n'));
    assert.equal(ev.t, 'line-one\n');
    const stop = await request(port, { method: 'POST', path: '/api/container/stop', headers: H, body: { id: 'web1' } });
    assert.equal(stop.status, 202);
    const sdone = await tasks.wait(stop.json.task.id);
    assert.equal(sdone.result.how, 'graceful');
    const rm1 = await request(port, { method: 'POST', path: '/api/container/remove', headers: H, body: { id: 'web1' } });
    assert.equal(rm1.status, 200, rm1.text);
    const vols = await request(port, { path: '/api/volumes', headers: H });
    assert.equal(vols.status, 200);
    const imgs = await request(port, { path: '/api/images', headers: H });
    assert.equal(imgs.status, 200, imgs.text);
    assert.ok(Array.isArray(imgs.json.images));
  } finally { await new Promise((r) => server.close(r)); }
});

// ------------------------------------------------ review fixes (sec-*, correct-*)
test('the host enforces the log cap: a stream far past it stops the container, whatever the guest did (sec-4)', async () => {
  const orig = CFG.containerLogCapMB;
  CFG.containerLogCapMB = 1;
  try {
    const c = await runC({ env: envOf({ FAKE_STDOUT_BYTES: 3 * 1048576 }) });
    await waitTask(c.task.id);
    await until(() => !containers.isLive(c.id), 15000, 'the manager to stop it');
    const rec = store.get(c.id);
    assert.match(rec.exitReason, /stdout log passed the limit of 1 MB/);
    assert.equal(rec.exitCode, 137);
    assert.equal(rec.fallback, null, 'a stop the manager made says nothing about the image');
    await containers.removeRoute({ id: c.id });
  } finally { CFG.containerLogCapMB = orig; }
});

test('the runtime is saved the moment QEMU is spawned, before the start window ends; the initrd counts as in use (spec 7.2, correct-5, correct-6)', async () => {
  const prev = run.launch;
  const seen = [];
  run.launch = (o) => prev(Object.assign({}, o, {
    earlyExitMs: 1500,
    onSpawn: (r) => {
      o.onSpawn(r);
      if (r) setTimeout(() => { const x = store.get(o.id); seen.push({ pid: r.pid, rt: x && x.runtime, status: x && x.status, initrds: containers._internal.liveInitrds() }); }, 300);
    },
  }));
  try {
    const c = await runC({});
    await waitTask(c.task.id);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rt && seen[0].rt.pid, seen[0].pid, 'recorded while launch() was still in its start window');
    assert.ok(seen[0].rt.monitor && seen[0].rt.console, 'with its control endpoints');
    assert.equal(seen[0].status, 'booting');
    assert.ok(seen[0].initrds.some((f) => /aaaaaaaaaaaa-0000000000000000\.initrd$/.test(f)), 'not GC-able while it boots');
    await stopC(c.id);
    await containers.removeRoute({ id: c.id });
  } finally { run.launch = prev; }
});

test('adoption: qemu.pid must name the pid (spec-4); --rm is honoured for an exit nobody watched (correct-12); a lost VM needs its command line (correct-13)', async () => {
  const a = await runC({});
  const b = await runC({ autoRemove: true, env: envOf({ FAKE_TERM_CODE: 5 }) });
  await Promise.all([waitTask(a.task.id), waitTask(b.task.id)]);
  const pa = store.get(a.id).runtime.pid, pb = store.get(b.id).runtime.pid;
  // a stray process with a qemu.pid in a record-less run folder
  const stray = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const lostId = 'fedcba987654';
  fs.mkdirSync(path.join(CFG.microvmsDir, lostId), { recursive: true });
  fs.writeFileSync(path.join(CFG.microvmsDir, lostId, 'qemu.pid'), String(stray.pid));
  const origCmd = platform.processCommandLine;
  let cmdName = 'qemu-system-x86_64 -name devbox-ctr-someoneelse';
  platform.processCommandLine = async (pid) => (pid === stray.pid ? cmdName : null);
  containers.shutdown();
  await run.sendConsole(store.get(b.id).runtime.console, '__DEVBOX_STOP 5\n');
  await until(() => !platform.pidAlive(pb), 5000, 'b to end');
  fs.rmSync(path.join(CFG.microvmsDir, a.id, 'qemu.pid'), { force: true });
  platform.listQemuPids = async () => new Set([pa, stray.pid]);
  try {
    let out = await containers.adoptAll();
    assert.equal(out.adopted, 0, 'no qemu.pid naming the pid: not adopted');
    assert.equal(store.get(a.id).status, 'exited');
    assert.equal(store.get(b.id), null, 'the --rm container that ended meanwhile is gone');
    assert.equal(out.lost, 0, 'a pid whose command line is another QEMU\'s is not listed');
    assert.equal(containers.stateWarning(), null);
    cmdName = 'qemu-system-x86_64 -name devbox-ctr-' + lostId + ' -nodefaults';
    out = await containers.adoptAll();
    assert.equal(out.lost, 1);
    assert.match(containers.stateWarning(), /without supervision/);
    // stopping it proves the command line again, then ends it; the note goes
    const s = await stopC(lostId);
    assert.match(s.result.how, /^forced/);
    assert.equal(platform.pidAlive(stray.pid), false);
    assert.equal(containers.stateWarning(), null, 'computed from the records: gone with the VM');
    await containers.removeRoute({ id: lostId });
  } finally {
    platform.listQemuPids = orig.listQemuPids;
    platform.processCommandLine = origCmd;
    try { stray.kill(); } catch (e) { /* gone */ }
    for (const c of spawned) if (c.pid === pa) { try { c.kill(); } catch (e) { /* gone */ } }
  }
  await containers.removeRoute({ id: a.id });
});

test('a stop the user asked for never earns a Docker-in-VM suggestion (correct-16)', async () => {
  const c = await runC({ env: envOf({ FAKE_STDERR: 'cgroup mount: operation not supported' }) });
  await waitTask(c.task.id);
  const s = await stopC(c.id);
  assert.equal(s.result.exitCode, 143);
  assert.equal(store.get(c.id).fallback, null);
  await containers.removeRoute({ id: c.id });
});

test('a forced stop that cannot end QEMU fails honestly and leaves the record as it is (correct-7)', async () => {
  const c = await runC({ env: envOf({ FAKE_TERM: 'ignore', FAKE_STUCK: 'all' }) });
  await waitTask(c.task.id);
  const origFS = run.forceStop;
  run.forceStop = async () => 'failed';
  try {
    const a = await containers.validateStop({ id: c.id, force: true });
    const s = tasks.start({ kind: 'ctr-stop', title: 'stop', ctr: a.id, locks: ['ctr-stop:' + a.id] }, (t) => containers.opStop(t, a));
    const done = await tasks.wait(s.id);
    assert.equal(done.status, 'error');
    assert.match(done.error, /did not stop - end it in Task Manager/);
    const rec = store.get(c.id);
    assert.deepEqual([rec.status, rec.stopRequest, containers.isLive(c.id)], ['running', null, true]);
  } finally { run.forceStop = origFS; }
  const s2 = await stopC(c.id, { force: true });
  assert.equal(s2.result.how, 'forced (quit)');
  await containers.removeRoute({ id: c.id });
});

test('a start does not boot QEMU while "Update QEMU" holds the qemu lock, even if it began before (correct-18)', async () => {
  let releaseQ;
  const held = new Promise((r) => { releaseQ = r; });
  let q = null;
  prepHook = async () => {
    assert.ok(containers.liveContainers().length >= 1, 'a preparing container counts as live for the QEMU update check');
    q = tasks.start({ kind: 'install-qemu', title: 'Update QEMU (test)', locks: ['qemu'] }, () => held);
  };
  try {
    const n = spawned.length;
    const c = await runC({});
    const r = await waitTask(c.task.id);
    assert.equal(r.status, 'error');
    assert.match(r.error, /QEMU|qemu/);
    assert.equal(spawned.length, n, 'no QEMU was spawned');
    await containers.removeRoute({ id: c.id });
  } finally { prepHook = null; releaseQ(); if (q) await tasks.wait(q.id); }
});

test('a record that names one volume twice is refused at start, before any disk is attached (correct-2)', async () => {
  const c = await runC({ volumes: ['twice:/a'], env: envOf({ FAKE_EXIT_AFTER_MS: 10 }) });
  await waitTask(c.task.id);
  await until(() => !containers.isLive(c.id), 5000);
  store.get(c.id).volumes.push({ name: 'TWICE', target: '/b', readonly: false, nocopy: false });
  const v = await containers.validateStart({ id: c.id });
  const s = tasks.start({ kind: 'ctr-start', ctr: c.id, locks: ['ctr:' + c.id] }, (t) => containers.opStart(t, v));
  const r = await waitTask(s.id);
  assert.equal(r.status, 'error');
  assert.match(r.error, /listed twice/);
  assert.equal(volumes.readLock(CFG.volumesDir, 'twice'), null, 'the lock taken for the first entry was given back');
  await containers.removeRoute({ id: c.id });
  volumes.removeVolume(CFG.volumesDir, 'twice');
});

test('SHARE_FAILED names the path the user chose, not the internal mount point (correct-15)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-c15-'));
  const origReg = shares.registerFor;
  shares.registerFor = async (kind, id, list) => ({ port: 5640, file: null, args: [], warnings: list.map((s) => 'shared folder ' + s.hostPath + ' -> ' + s.guestPath + ' is not available: gone') });
  try {
    const c = await runC({ volumes: [dir + ':/site'] });
    const r = await waitTask(c.task.id);
    assert.equal(r.status, 'error');
    assert.match(r.error, / -> \/site is not available/);
    assert.ok(!/\.devbox\/shares/.test(r.error), r.error);
    await containers.removeRoute({ id: c.id });
  } finally { shares.registerFor = origReg; rm(dir); }
});

test('a Docker-in-VM fallback that fails gives the container its ports back (correct-11)', async () => {
  const deploy = require('../lib/deploy');
  const origV = deploy.validateQuickDeploy, origOp = deploy.opQuickDeploy;
  deploy.validateQuickDeploy = async (b) => Object.assign({}, b, { name: 'vm-fails', claimed: [] });
  deploy.opQuickDeploy = async () => { throw new Error('the pull inside the VM failed'); };
  try {
    const c = await runC({ ports: ['18183:80'], env: envOf({ FAKE_EXIT_AFTER_MS: 10 }) });
    await waitTask(c.task.id);
    await until(() => !containers.isLive(c.id), 5000);
    const fb = await containers.fallbackRoute({ id: c.id });
    const done = await tasks.wait(fb.task.id);
    assert.equal(done.status, 'error');
    await until(() => (store.get(c.id).ports || []).length === 1, 3000, 'the ports to come back');
    assert.deepEqual(store.get(c.id).ports.map((p) => p.host), [18183]);
    assert.ok(!/replaced by the Docker VM/.test(store.get(c.id).note || ''));
    await containers.removeRoute({ id: c.id });
  } finally { deploy.validateQuickDeploy = origV; deploy.opQuickDeploy = origOp; }
});
});
