'use strict';
/*
 * lib/shares.js - the manager-level shared-folder service: validation, share
 * records, the fw_cfg list a guest reads, the lifecycle hooks lib/vm.js
 * calls (registerFor at start, disconnect + unregister when QEMU is gone),
 * live add/remove on a running VM, the re-mount after a manager restart or a
 * guest reboot, and the API (/api/shares, /api/vm/shares, /api/fs/dirs) -
 * against the real 9P server on an OS-assigned port. The guest side (SSH) is
 * a stub that records the scripts: the real-guest runs are in the
 * integration notes (a VM from devbox-base).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTempRoot, resetConfig, rm, request } = require('./helpers');
const config = require('../lib/config');
const { CFG } = config;
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const util = require('../lib/util');
const ssh = require('../lib/ssh');
const vmMod = require('../lib/vm');
const shares = require('../lib/shares');
const { createServer } = require('../lib/http');
const { NinepClient } = require('./helpers/ninep-client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// is a equal to or inside b (Windows: any case)
const samePrefix = (a, b) => { const n = (p) => path.resolve(p).toLowerCase() + path.sep; return n(a).startsWith(n(b)); };

test.after(async () => { await shares.shutdown(); });

function folder(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-share-' + tag + '-'));
  fs.writeFileSync(path.join(d, 'hello.txt'), 'hi from the host\n');
  return d;
}

async function until(fn, ms, what) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  assert.fail('timed out waiting for ' + (what || 'a condition'));
}

// A fake guest: ssh.sshExec records every script and answers with the
// markers the real scripts print; util.probeSsh answers `up`; vm.isRunning
// answers `running`. restore() puts the real ones back.
function fakeGuest(opts) {
  opts = opts || {};
  const g = { calls: [], up: opts.up !== undefined ? opts.up : true, running: true, boot: '0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', failMount: false, installed: false };
  const orig = { exec: ssh.sshExec, probe: util.probeSsh, isRunning: vmMod.isRunning };
  ssh.sshExec = async (target, cmd, o) => {
    const input = String((o && o.input) || '');
    g.calls.push({ target, cmd, input });
    const lines = [];
    if (/devbox-shares/.test(input) && /base64 -d/.test(input)) { lines.push('DEVBOX-SHARES service ' + (g.installed ? 'present' : 'installed')); g.installed = true; }
    if (/boot_id/.test(input)) lines.push('DEVBOX-SHARES boot ' + g.boot);
    for (const m of input.matchAll(/10\.0\.2\.2 '([^']+)'; then/g)) lines.push('DEVBOX-SHARES ' + (g.failMount ? 'fail ' : 'ok ') + m[1]);
    for (const m of input.matchAll(/^unmnt '([^']+)'; if ismnt/gm)) lines.push('DEVBOX-SHARES gone ' + m[1]);
    return { code: g.failMount ? 1 : 0, ok: !g.failMount, stdout: lines.join('\n') + '\n', stderr: g.failMount ? 'mount: mounting 10.0.2.2 on /x failed: Permission denied\n' : '', timedOut: false };
  };
  util.probeSsh = async () => g.up;
  vmMod.isRunning = async () => g.running;
  g.restore = () => { ssh.sshExec = orig.exec; util.probeSsh = orig.probe; vmMod.isRunning = orig.isRunning; };
  return g;
}

// A VM record in the registry of the current temp root.
function addVm(name, o) {
  st.state.vms[name] = st.newVmRecord(Object.assign({ port: 2290 + Object.keys(st.state.vms).length }, o || {}));
  st.saveState();
  return st.state.vms[name];
}

// the registry is one shared object: leave it empty for the next test
function clearVms() { for (const k of Object.keys(st.state.vms)) delete st.state.vms[k]; }

async function idle(name) {
  await until(() => { const o = shares._owners.get(name); return !o || !o.job; }, 15000, 'the mount job of ' + name);
}

test('a VM or container without shares: no 9P server, no fw_cfg file, no QEMU arguments', async () => {
  const root = useTempRoot('noshare');
  try {
    const r = await shares.registerFor('vm', 'plain', []);
    assert.deepEqual(r, { port: null, file: null, args: [], warnings: [] });
    assert.equal(shares.port(), null, 'nothing was started');
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'plain.shares')), false);
    assert.equal(shares.disconnect('plain'), 0);
    assert.equal(shares.unregister('plain'), false);
    assert.deepEqual(shares.status('plain'), []);
  } finally { resetConfig(); rm(root); }
});

test('validateShare: real folders only, never the data folder or a system folder; guest path rules; limits', () => {
  const root = useTempRoot('validate');
  const src = folder('v');
  try {
    const ok = shares.validateShare({ hostPath: src, guestPath: '/home/dev/project' });
    assert.equal(ok.share.hostPath, fs.realpathSync.native(src));
    assert.deepEqual([ok.share.guestPath, ok.share.readOnly, ok.warnings], ['/home/dev/project', false, []]);
    assert.equal(shares.validateShare({ hostPath: src, guestPath: '/mnt/x', readOnly: true }).share.readOnly, true);
    if (process.platform === 'win32') {
      // separators and case are normalised to the folder's real path
      const odd = src.replace(/\\/g, '/').toUpperCase();
      assert.equal(shares.validateShare({ hostPath: odd, guestPath: '/mnt/x' }).share.hostPath, fs.realpathSync.native(src));
    }
    const bad = (input, re, opts) => assert.throws(() => shares.validateShare(input, opts), (e) => e.status === 400 && re.test(e.message), JSON.stringify(input));
    bad({ guestPath: '/mnt/x' }, /hostPath/);
    bad({ hostPath: 'relative/dir', guestPath: '/mnt/x' }, /absolute/);
    bad({ hostPath: path.join(src, 'missing'), guestPath: '/mnt/x' }, /does not exist/);
    bad({ hostPath: path.join(src, 'hello.txt'), guestPath: '/mnt/x' }, /not a folder/);
    fs.mkdirSync(path.join(CFG.root, 'sub'), { recursive: true });
    bad({ hostPath: CFG.root, guestPath: '/mnt/x' }, /data folder/);
    bad({ hostPath: path.join(CFG.root, 'sub'), guestPath: '/mnt/x' }, /data folder/);
    bad({ hostPath: path.dirname(CFG.root), guestPath: '/mnt/x' }, /data folder/, { dataRoot: CFG.root });
    if (process.platform === 'win32') bad({ hostPath: process.env.SystemRoot || 'C:\\Windows', guestPath: '/mnt/x' }, /system folders/);
    bad({ hostPath: src, guestPath: '/etc' }, /must not be under|system directory/);
    bad({ hostPath: src, guestPath: '/home/dev/my project' }, /letters, digits/);
    bad({ hostPath: src, guestPath: '/mnt/x', readOnly: 'yes' }, /readOnly/);
    const existing = [{ id: 'b-1', guestPath: '/mnt/x' }];
    bad({ hostPath: src, guestPath: '/mnt/x' }, /already uses/, { existing });
    // nested mount points: one share's mount point would be created on the other's host folder
    bad({ hostPath: src, guestPath: '/mnt/x/inner' }, /nested/, { existing });
    bad({ hostPath: src, guestPath: '/work' }, /nested/, { existing: [{ id: 'b-2', guestPath: '/work/app' }] });
    assert.equal(shares.validateShare({ hostPath: src, guestPath: '/mnt/xy' }, { existing }).share.guestPath, '/mnt/xy', 'a common prefix is not nesting');
    // replacing a share does not collide with itself
    assert.equal(shares.validateShare({ hostPath: src, guestPath: '/mnt/x' }, { existing, replaceId: 'b-1' }).share.guestPath, '/mnt/x');
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: 'b-' + i, guestPath: '/mnt/s' + i }));
    bad({ hostPath: src, guestPath: '/mnt/new' }, /at most 8/, { existing: eight });
    // a drive root holding the data folder is refused (it contains it)...
    const driveRoot = path.parse(src).root;
    if (path.parse(CFG.root).root.toLowerCase() === driveRoot.toLowerCase()) bad({ hostPath: driveRoot, guestPath: '/mnt/drive' }, /data folder/);
    // ...any other whole drive is allowed, with a warning; so is the profile
    if (process.platform === 'win32') {
      const w = shares.validateShare({ hostPath: driveRoot, guestPath: '/mnt/drive' }, { dataRoot: 'Q:/elsewhere/devbox-data' });
      assert.ok(w.warnings.some((x) => /whole drive/.test(x)), JSON.stringify(w.warnings));
      assert.ok(w.warnings.some((x) => /user profile/.test(x)), 'the drive holds the profile too');
    }
    const h = shares.validateShare({ hostPath: os.homedir(), guestPath: '/mnt/me' }, { dataRoot: path.join(path.parse(os.homedir()).root, 'no-such-devbox-root-x9') });
    assert.ok(h.warnings.some((x) => /whole user profile/.test(x)), JSON.stringify(h.warnings));
  } finally { resetConfig(); rm(root); rm(src); }
});

test('newShare / publicShare / shareUidGid / fwcfgFile', () => {
  const a = shares.newShare({ hostPath: 'C:/x', guestPath: '/mnt/x' }, 'box', []);
  assert.equal(a.id, 'box-1');
  assert.match(a.secret, /^[A-Za-z0-9_-]{32}$/);
  const b = shares.newShare({ hostPath: 'C:/y', guestPath: '/mnt/y', readOnly: true }, 'box', [a]);
  assert.equal(b.id, 'box-2');
  assert.notEqual(a.secret, b.secret);
  assert.deepEqual(shares.publicShare(b), { id: 'box-2', hostPath: 'C:/y', guestPath: '/mnt/y', readOnly: true });
  assert.ok(!JSON.stringify(shares.publicShare(b)).includes(b.secret), 'the API never sees a secret');
  // long VM names (up to 63 characters): ids stay within the server's 64,
  // and two names that only differ at the end still get different ids
  const long1 = 'x'.repeat(60) + 'aaa', long2 = 'x'.repeat(60) + 'bbb';
  const l1 = shares.newShare({ hostPath: 'x', guestPath: '/m' }, long1, []).id, l2 = shares.newShare({ hostPath: 'x', guestPath: '/m' }, long2, []).id;
  assert.ok(l1.length <= 64 && l2.length <= 64, l1);
  assert.notEqual(l1, l2);
  assert.match(l1, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.equal(shares.newShare({ hostPath: 'x', guestPath: '/m' }, 'y'.repeat(55), []).id, 'y'.repeat(55) + '-1');
  assert.deepEqual(shares.shareUidGid('1000:1000'), { uid: 1000, gid: 1000 });
  assert.deepEqual(shares.shareUidGid('101'), { uid: 101, gid: 101 });
  assert.deepEqual(shares.shareUidGid('nginx'), { uid: 0, gid: 0 });
  assert.deepEqual(shares.shareUidGid(''), { uid: 0, gid: 0 });
  assert.match(shares.fwcfgFile('vm', 'box').replace(/\\/g, '/'), /\/run\/box\.shares$/);
  assert.match(shares.fwcfgFile('container', '0123456789ab').replace(/\\/g, '/'), /\/run\/ctr-0123456789ab\.shares$/);
  assert.throws(() => shares.fwcfgFile('pod', 'x'), /owner kind/);
  assert.throws(() => shares.fwcfgFile('vm', '../x'), /owner id/);
  assert.match(shares.CAVEAT, /CHOKIDAR_USEPOLLING=1/);
});

test('lifecycle: register -> the guest list and a working 9P attach -> disconnect -> unregister', async () => {
  const root = useTempRoot('life');
  const src = folder('life');
  try {
    await shares.ensureServer({ port: 0 });
    const port = shares.port();
    assert.ok(port > 0);
    const cfg = JSON.parse(fs.readFileSync(CFG.configFile, 'utf8'));
    assert.equal(cfg.ninepPort, port, 'the port is remembered: running VMs\' mounts name it');
    const sh = shares.newShare(shares.validateShare({ hostPath: src, guestPath: '/home/dev/project' }).share, 'box', []);
    const r = await shares.registerFor('vm', 'box', [sh]);
    assert.equal(r.port, port);
    assert.deepEqual(r.args, ['-fw_cfg', 'name=opt/devbox/shares,file=' + r.file]);
    assert.equal(fs.readFileSync(r.file, 'utf8'), port + ' ' + sh.id + ':' + sh.secret + ' /home/dev/project rw\n');
    assert.ok(!r.args.join(' ').includes(sh.secret), 'the secret never goes on the QEMU command line');
    assert.deepEqual(fs.readdirSync(CFG.runDir).filter((f) => /\.tmp$/.test(f)), [], 'no temp file left behind');
    assert.deepEqual(shares.registered('box'), [sh.id]);
    // what a guest does: attach with <id>:<secret> and read the host's file
    const c = await NinepClient.connect({ port });
    await c.version(65536);
    await c.attach(0, sh.id + ':' + sh.secret);
    const stt = shares.status('box');
    assert.equal(stt.length, 1);
    assert.equal(stt[0].mounted, true);
    assert.ok(!JSON.stringify(stt).includes(sh.secret));
    // QEMU gone: its connections are closed, then the share is forgotten
    assert.equal(shares.disconnect('box'), 1);
    await c.closedPromise;
    assert.equal(shares.status('box')[0].mounted, false);
    assert.match(shares.status('box')[0].lastClose.reason, /disconnected/);
    assert.equal(shares.unregister('box'), true);
    assert.equal(fs.existsSync(r.file), false, 'the fw_cfg file (with the secret) is deleted');
    const d = await NinepClient.connect({ port });
    await d.version(65536);
    await assert.rejects(d.attach(0, sh.id + ':' + sh.secret), (e) => e.code === 'EACCES');
    await d.destroy();
    // a folder that vanished is reported, the others still register
    const gone = shares.newShare({ hostPath: path.join(src, 'nope'), guestPath: '/mnt/gone' }, 'box2', []);
    const ok = shares.newShare({ hostPath: src, guestPath: '/mnt/ok' }, 'box2', [gone]);
    const r2 = await shares.registerFor('vm', 'box2', [gone, ok]);
    assert.equal(r2.warnings.length, 1);
    assert.match(r2.warnings[0], /not available/);
    assert.equal(fs.readFileSync(r2.file, 'utf8').trim().split('\n').length, 1, 'only the available share is listed');
    // re-registering with fewer shares drops the rest; none = unregistered
    await shares.registerFor('vm', 'box2', []);
    assert.deepEqual(shares.registered('box2'), []);
    // a container gets its USER's ids on its shares, and never an SSH job
    const cs = shares.newShare({ hostPath: src, guestPath: '/app' }, '0123456789ab', []);
    const r3 = await shares.registerFor('container', '0123456789ab', [cs], shares.shareUidGid('101:102'));
    assert.match(r3.file.replace(/\\/g, '/'), /\/run\/ctr-0123456789ab\.shares$/);
    const cc = await NinepClient.connect({ port });
    await cc.version(65536);
    await cc.attach(0, cs.id + ':' + cs.secret);
    const ga = await cc.getattr(0);
    assert.deepEqual([ga.uid, ga.gid], [101, 102]);
    assert.equal(shares._owners.get('0123456789ab').job, null);
    await assert.rejects(shares.registerFor('vm', '0123456789ab', [shares.newShare({ hostPath: src, guestPath: '/x' }, 'vmx', [])]), /both called/);
    shares.unregister('0123456789ab');
    await cc.closedPromise;
  } finally { await shares.shutdown(); resetConfig(); rm(root); rm(src); }
});

test('the 9P port: config.json ninepPort is used; a busy port falls back to a free one and is saved', async () => {
  const root = useTempRoot('port');
  const net = require('net');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  try {
    CFG.ninepPort = busy;
    await shares.ensureServer();
    assert.notEqual(shares.port(), busy);
    assert.equal(JSON.parse(fs.readFileSync(CFG.configFile, 'utf8')).ninepPort, shares.port());
    assert.equal(CFG.ninepPort, shares.port());
    const again = shares.port();
    await shares.shutdown();
    await shares.ensureServer();
    assert.equal(shares.port(), again, 'the saved port is used again (running VMs\' mounts name it)');
  } finally { await shares.shutdown(); await new Promise((r) => blocker.close(r)); resetConfig(); rm(root); }
});

// The integration E2E found config.json {"ninepPort": 5640} written into the
// shared data root by every manager run, though 5640 was free: only a port
// that differs from the one asked for is worth saving.
test('the 9P port: a free wanted port is used as is and NOT written to config.json', async () => {
  const root = useTempRoot('port-free');
  const net = require('net');
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));
  try {
    CFG.ninepPort = free;
    await shares.ensureServer();
    assert.equal(shares.port(), free);
    assert.ok(!fs.existsSync(CFG.configFile), 'no config.json for the port that was asked for');
  } finally { await shares.shutdown(); resetConfig(); rm(root); }
});

test('HTTP: shares of a stopped VM - add/remove are saved (never a secret in a reply), listed with status "stopped"', async () => {
  const root = useTempRoot('api');
  const src = folder('api');
  tasks._reset();
  st.loadState();
  const token = config.ensureToken();
  const server = createServer({ token });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const H = { 'Content-Type': 'application/json', 'X-DevBox-Token': token };
  const post = (body) => request(port, { method: 'POST', path: '/api/vm/shares', headers: H, body });
  const get = (p) => request(port, { path: p, headers: H });
  const g = fakeGuest();
  g.running = false;
  try {
    addVm('box');
    for (const p of ['/api/shares?owner=box', '/api/fs/dirs']) assert.equal((await request(port, { path: p })).status, 401, p + ' needs the token');
    assert.equal((await request(port, { method: 'POST', path: '/api/vm/shares', headers: { 'Content-Type': 'application/json' }, body: {} })).status, 401);
    const a = await post({ name: 'box', action: 'add', hostPath: src, guestPath: '/home/dev/project' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.applied, 'next-start');
    assert.equal(a.json.mounted, false);
    assert.deepEqual(a.json.share, { id: 'box-1', hostPath: fs.realpathSync.native(src), guestPath: '/home/dev/project', readOnly: false });
    assert.match(a.json.caveat, /polling/);
    const secret = st.state.vms.box.shares[0].secret;
    assert.match(secret, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(!a.text.includes(secret), 'the reply never carries the secret');
    assert.ok(fs.readFileSync(CFG.stateFile, 'utf8').includes(secret), 'the secret is kept with the VM record');
    const ro = await post({ name: 'box', action: 'add', hostPath: src, guestPath: '/mnt/docs', readOnly: true });
    assert.equal(ro.status, 200, ro.text);
    assert.equal(ro.json.shares.length, 2);
    assert.equal(g.calls.length, 0, 'a stopped VM is never contacted');
    // bad input: 400 / 404 before any task, nothing saved
    const n = tasks.list().length;
    for (const [body, status, re] of [
      [{ name: 'box', action: 'add', hostPath: src, guestPath: '/home/dev/project' }, 400, /already uses/],
      [{ name: 'box', action: 'add', hostPath: src, guestPath: '/mnt/docs/sub' }, 400, /nested/],
      [{ name: 'box', action: 'add', hostPath: CFG.root, guestPath: '/mnt/data' }, 400, /data folder/],
      [{ name: 'box', action: 'add', hostPath: src, guestPath: '/etc/x' }, 400, /under/],
      [{ name: 'box', action: 'add', guestPath: '/mnt/y' }, 400, /hostPath/],
      [{ name: 'box', action: 'rename', guestPath: '/mnt/y' }, 400, /action/],
      [{ name: 'nobox', action: 'add', hostPath: src, guestPath: '/mnt/y' }, 404, /no VM/],
      [{ name: '../x', action: 'add', hostPath: src, guestPath: '/mnt/y' }, 400, /name/],
      [{ name: 'box', action: 'remove', guestPath: '/mnt/none' }, 404, /no shared folder/],
      [{ name: 'box', action: 'remove' }, 400, /guestPath/],
    ]) {
      const r = await post(body);
      assert.equal(r.status, status, JSON.stringify(body) + ': ' + r.text);
      assert.match(r.json.error, re);
    }
    assert.equal(tasks.list().length, n, 'no task was started for bad input');
    assert.equal(st.state.vms.box.shares.length, 2);
    // listed without secrets; status "stopped" while the VM is not running
    const l = await get('/api/shares?owner=box');
    assert.equal(l.status, 200, l.text);
    assert.equal(l.json.kind, 'vm');
    assert.equal(l.json.running, false);
    assert.deepEqual(l.json.shares.map((s) => [s.id, s.guestPath, s.readOnly, s.status]), [['box-1', '/home/dev/project', false, 'stopped'], ['box-2', '/mnt/docs', true, 'stopped']]);
    assert.ok(!l.text.includes(secret));
    const all = await get('/api/shares');
    assert.deepEqual(all.json.shares.map((s) => [s.owner, s.kind, s.id]), [['box', 'vm', 'box-1'], ['box', 'vm', 'box-2']]);
    assert.equal((await get('/api/shares?owner=nobody')).status, 404);
    assert.equal((await get('/api/shares?owner=' + encodeURIComponent('a b'))).status, 400);
    // /api/state shows a VM's shares without their secrets
    const s = await get('/api/state');
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.vms.find((v) => v.name === 'box').shares.map((x) => x.id), ['box-1', 'box-2']);
    assert.ok(!s.text.includes(secret));
    // remove by guest path (or id)
    const rm1 = await post({ name: 'box', action: 'remove', guestPath: '/mnt/docs' });
    assert.equal(rm1.status, 200, rm1.text);
    assert.equal(rm1.json.removed.id, 'box-2');
    assert.equal(rm1.json.applied, 'next-start');
    const rm2 = await post({ name: 'box', action: 'remove', id: 'box-1' });
    assert.equal(rm2.status, 200, rm2.text);
    assert.deepEqual(st.state.vms.box.shares, []);
    // a busy VM (a start or stop holds its lock): 409 BUSY, nothing changed
    const busy = tasks.start({ kind: 'start', title: 'Start box', vm: 'box', locks: ['vm:box'] }, () => sleep(300));
    const b = await post({ name: 'box', action: 'add', hostPath: src, guestPath: '/mnt/z' });
    assert.equal(b.status, 409, b.text);
    assert.equal(b.json.code, 'BUSY');
    await tasks.wait(busy.id);
    assert.deepEqual(st.state.vms.box.shares, []);
    // the tasks log names folders, never secrets
    assert.ok(!fs.readFileSync(CFG.tasksLog, 'utf8').includes(secret));
  } finally {
    g.restore();
    await new Promise((r) => server.close(r));
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src);
  }
});

test('running VM: a share added is registered and mounted over SSH at once, removed is unmounted and revoked', async () => {
  const root = useTempRoot('live');
  const src = folder('live');
  tasks._reset();
  st.loadState();
  const logFile = path.join(root, 'test-manager.log');
  util.setLogFile(logFile);
  const g = fakeGuest();
  try {
    const vm = addVm('run1');
    vm.runtime = { pid: 999999, startedAt: new Date().toISOString(), accel: 'tcg', monitor: null, serial: null };
    await shares.ensureServer({ port: 0 });
    const r = await shares.vmSharesAction({ name: 'run1', action: 'add', hostPath: src, guestPath: '/home/dev/project' });
    assert.equal(r.applied, 'live');
    assert.equal(r.mounted, true);
    assert.deepEqual(r.warnings, []);
    const sh = vm.shares[0];
    assert.equal(g.calls.length, 1);
    const call = g.calls[0];
    assert.deepEqual(call.target, { name: 'run1', port: vm.port });
    assert.equal(call.cmd, 'sh -s', 'the script (with the secret) goes on stdin, never on the ssh command line');
    assert.ok(call.input.includes('aname=' + sh.id + ':' + sh.secret));
    assert.ok(call.input.includes('port=' + shares.port() + ','));
    assert.match(call.input, /base64 -d/, 'the boot-time service is installed where it is missing');
    assert.match(call.input, /\nunmnt '\/home\/dev\/project'\n/, 'a new share replaces whatever was mounted at its path');
    assert.deepEqual(shares.registered('run1'), [sh.id]);
    assert.equal(shares._owners.get('run1').bootTag, 'boot-' + g.boot);
    // the guest can attach now
    const c = await NinepClient.connect({ port: shares.port() });
    await c.version(65536);
    await c.attach(0, sh.id + ':' + sh.secret, { uname: 'boot-' + g.boot });
    const l = shares.listShares({ owner: 'run1' });
    assert.equal(l.running, true);
    assert.deepEqual(l.shares.map((x) => [x.id, x.status, x.connections]), [[sh.id, 'mounted', 1]]);
    // QEMU still has the list it was started with (none): a reboot inside
    // the guest would not mount the new share, so the VM is watched
    assert.equal(shares._internal.isStale(shares._owners.get('run1')), true);
    assert.ok(shares._owners.get('run1').watch, 'a stale VM is watched for reboots');
    // mount failure: saved for the next start, the reason reported
    g.failMount = true;
    const f = await shares.vmSharesAction({ name: 'run1', action: 'add', hostPath: src, guestPath: '/mnt/fails' });
    assert.equal(f.applied, 'next-start');
    assert.equal(f.mounted, false);
    assert.match(f.warnings.join(' '), /Permission denied/);
    assert.match(shares.listShares({ owner: 'run1' }).problem, /could not mount \/mnt\/fails/);
    g.failMount = false;
    // remove: unmounted in the guest, then the server drops the share (the guest's connection with it)
    g.calls.length = 0;
    const rr = await shares.vmSharesAction({ name: 'run1', action: 'remove', guestPath: '/home/dev/project' });
    assert.equal(rr.applied, 'live');
    assert.equal(rr.unmounted, true);
    assert.match(g.calls[0].input, /unmnt '\/home\/dev\/project'; if ismnt/);
    assert.ok(!g.calls[0].input.includes(sh.secret));
    await c.closedPromise;
    const d = await NinepClient.connect({ port: shares.port() });
    await d.version(65536);
    await assert.rejects(d.attach(0, sh.id + ':' + sh.secret), (e) => e.code === 'EACCES');
    await d.destroy();
    assert.deepEqual(shares.registered('run1').length, 1, 'only /mnt/fails is left');
    // the VM does not answer on SSH yet: registered now, mounted once it does
    g.up = false;
    g.calls.length = 0;
    const p = await shares.vmSharesAction({ name: 'run1', action: 'add', hostPath: src, guestPath: '/mnt/later', readOnly: true });
    assert.equal(p.applied, 'live');
    assert.equal(p.pending, true);
    assert.equal(g.calls.length, 0);
    assert.equal(shares.listShares({ owner: 'run1' }).shares.find((x) => x.guestPath === '/mnt/later').status, 'pending');
    g.up = true;
    await until(() => g.calls.length > 0, 10000, 'the mount once SSH answers');
    await idle('run1');
    assert.match(g.calls[0].input, /if ismnt '\/mnt\/later' && alive '\/mnt\/later'; then/, 'live mounts are kept; the missing one is mounted');
    assert.match(g.calls[0].input, /,ro\$\{b:\+,uname=boot-\$b\}" 10\.0\.2\.2 '\/mnt\/later'/);
    // the VM goes away: QEMU exited -> disconnect + unregister (lib/vm.js clearRuntime)
    shares.disconnect('run1');
    shares.unregister('run1');
    assert.equal(shares._owners.has('run1'), false);
    // nothing with a secret reached the manager log or the tasks log
    const logs = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '') + fs.readFileSync(CFG.tasksLog, 'utf8');
    assert.match(logs, /mounted the shared folder/);
    for (const s of vm.shares.concat([sh])) assert.ok(!logs.includes(s.secret), 'a secret was logged');
  } finally {
    g.restore();
    util.setLogFile(null);
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src);
  }
});

test('start: after the start task, the service is installed and what the boot did not mount is mounted', async () => {
  const root = useTempRoot('start');
  const src = folder('start');
  tasks._reset();
  st.loadState();
  const g = fakeGuest();
  try {
    const vm = addVm('st1');
    vm.shares = [shares.newShare({ hostPath: fs.realpathSync.native(src), guestPath: '/work' }, 'st1', [])];
    await shares.ensureServer({ port: 0 });
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = tasks.start({ kind: 'start', title: 'Start st1', vm: 'st1', locks: ['vm:st1'] }, async () => {
      // what lib/vm.js opStart does: register, boot, wait for SSH, personalise
      const reg = await shares.registerFor('vm', 'st1', vm.shares);
      assert.equal(reg.args[0], '-fw_cfg');
      vm.runtime = { pid: 999998, startedAt: new Date().toISOString(), accel: 'tcg', monitor: null, serial: null };
      await gate;
    });
    await sleep(300);
    assert.equal(g.calls.length, 0, 'no SSH while the start task runs (it pins the guest\'s new host key)');
    release();
    await tasks.wait(t.id);
    await until(() => g.calls.length > 0, 10000, 'the post-start mount');
    await idle('st1');
    assert.match(g.calls[0].input, /base64 -d/);
    assert.match(g.calls[0].input, /if ismnt '\/work' && alive '\/work'; then/);
    assert.equal(shares._internal.isStale(shares._owners.get('st1')), false, 'the boot-time list is current');
    assert.equal(shares._owners.get('st1').watch, null, 'no reboot watch needed');
    // a start that fails before QEMU runs: vm.js unregisters, no SSH ever
    g.calls.length = 0;
    const vm2 = addVm('st2');
    vm2.shares = [shares.newShare({ hostPath: fs.realpathSync.native(src), guestPath: '/work' }, 'st2', [])];
    const t2 = tasks.start({ kind: 'start', title: 'Start st2', vm: 'st2', locks: ['vm:st2'] }, async () => {
      await shares.registerFor('vm', 'st2', vm2.shares);
      shares.unregister('st2');
      throw new Error('QEMU could not start');
    });
    await tasks.wait(t2.id);
    await sleep(200);
    assert.equal(g.calls.length, 0);
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'st2.shares')), false);
  } finally {
    g.restore();
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src);
  }
});

test('manager restart: running VMs\' shares are registered again and re-mounted; stale share lists are cleaned up', async () => {
  const root = useTempRoot('restore');
  const src = folder('restore');
  tasks._reset();
  st.loadState();
  const g = fakeGuest();
  try {
    await shares.ensureServer({ port: 0 });
    const p = shares.port();
    await shares.shutdown(); // "the previous manager" chose the port; its VMs keep running
    const real = fs.realpathSync.native(src);
    const up = addVm('up1');
    up.shares = [shares.newShare({ hostPath: real, guestPath: '/work' }, 'up1', [])];
    up.runtime = { pid: 999997, startedAt: new Date().toISOString(), accel: 'tcg', monitor: null, serial: null };
    const down = addVm('down1');
    down.shares = [shares.newShare({ hostPath: real, guestPath: '/work' }, 'down1', [])];
    const none = addVm('none1');
    none.runtime = { pid: 999996, startedAt: null, accel: 'tcg', monitor: null, serial: null };
    st.saveState();
    // the lists the previous run wrote: up1's matches what QEMU got; down1 stopped while no manager ran
    fs.mkdirSync(CFG.runDir, { recursive: true });
    fs.writeFileSync(path.join(CFG.runDir, 'up1.shares'), p + ' ' + up.shares[0].id + ':' + up.shares[0].secret + ' /work rw\n');
    fs.writeFileSync(path.join(CFG.runDir, 'down1.shares'), 'secret stuff\n');
    fs.writeFileSync(path.join(CFG.runDir, 'up1.shares.12345.tmp'), 'half written\n');
    fs.writeFileSync(path.join(CFG.runDir, 'ctr-0123456789ab.shares'), 'the engine\'s\n');
    const r = await shares.restoreRunning();
    assert.deepEqual(r, { restored: 1 });
    assert.equal(shares.port(), p, 'the same port as before');
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'down1.shares')), false, 'a stopped VM\'s list (secrets) is deleted');
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'up1.shares.12345.tmp')), false);
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'up1.shares')), true, 'a running VM keeps its list');
    assert.equal(fs.existsSync(path.join(CFG.runDir, 'ctr-0123456789ab.shares')), true, 'containers are the engine\'s');
    await until(() => g.calls.length > 0, 10000, 'the re-mount');
    await idle('up1');
    assert.equal(g.calls.length, 1, 'only up1 (none1 has no shares, down1 is not running)');
    assert.deepEqual(g.calls[0].target, { name: 'up1', port: up.port });
    assert.match(g.calls[0].input, /\nunmnt '\/work'\nif mkdir -p '\/work'/, 'every mount of the previous run is dead: detached and mounted again');
    assert.deepEqual(shares.registered('up1'), [up.shares[0].id]);
    assert.equal(shares._internal.isStale(shares._owners.get('up1')), false);
    assert.deepEqual(await shares.restoreRunning(), { restored: 0 }, 'already registered');
  } finally {
    g.restore();
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src);
  }
});

test('manager restart: a share added before restoreRunning got to the VM brings its other shares back too (correct-9)', async () => {
  const root = useTempRoot('add-before-restore');
  const src1 = folder('r9a'), src2 = folder('r9b');
  tasks._reset();
  st.loadState();
  const g = fakeGuest();
  try {
    await shares.ensureServer({ port: 0 });
    const p = shares.port();
    // started by the previous manager with one share; its mount died with it
    const vm = addVm('r9');
    vm.shares = [shares.newShare({ hostPath: fs.realpathSync.native(src1), guestPath: '/one' }, 'r9', [])];
    vm.runtime = { pid: 999993, startedAt: new Date().toISOString(), accel: 'tcg', monitor: null, serial: null };
    st.saveState();
    fs.mkdirSync(CFG.runDir, { recursive: true });
    fs.writeFileSync(path.join(CFG.runDir, 'r9.shares'), p + ' ' + vm.shares[0].id + ':' + vm.shares[0].secret + ' /one rw\n');
    assert.deepEqual(shares.registered('r9'), [], 'not restored yet');
    const r = await shares.vmSharesAction({ name: 'r9', action: 'add', hostPath: src2, guestPath: '/two' });
    assert.equal(r.applied, 'live');
    const ids = st.state.vms.r9.shares.map((s) => s.id).sort();
    assert.deepEqual(shares.registered('r9').sort(), ids, 'BOTH shares are registered, not only the new one');
    await until(() => g.calls.some((c) => /'\/one'/.test(c.input) && /'\/two'/.test(c.input)), 10000, 'one mount job for both');
    const job = g.calls.find((c) => /'\/one'/.test(c.input));
    assert.match(job.input, /unmnt '\/one'/, 'the dead mount of the old manager is replaced');
    await idle('r9');
    assert.deepEqual(await shares.restoreRunning(), { restored: 0 }, 'restoreRunning finds it registered and leaves it');
  } finally {
    g.restore();
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src1); rm(src2);
  }
});

test('reboot inside a VM whose boot-time list is stale: the shares the boot missed are mounted again', async () => {
  const root = useTempRoot('reboot');
  shares._internal.setWatchMs(200);
  const src = folder('reboot');
  tasks._reset();
  st.loadState();
  const g = fakeGuest();
  try {
    const vm = addVm('rb1');
    const real = fs.realpathSync.native(src);
    vm.shares = [shares.newShare({ hostPath: real, guestPath: '/boot-list' }, 'rb1', [])];
    await shares.ensureServer({ port: 0 });
    await shares.registerFor('vm', 'rb1', vm.shares); // no start task, VM not "running" yet: the job ends at once
    await idle('rb1');
    vm.runtime = { pid: 999995, startedAt: new Date().toISOString(), accel: 'tcg', monitor: null, serial: null };
    const first = vm.shares[0];
    // the boot-time service mounts the list with this boot's id
    const c1 = await NinepClient.connect({ port: shares.port() });
    await c1.version(65536);
    await c1.attach(0, first.id + ':' + first.secret, { uname: 'boot-' + g.boot });
    await until(() => shares._owners.get('rb1').bootTag === 'boot-' + g.boot, 2000, 'the boot tag');
    // a share added live is not in QEMU's list
    const r = await shares.vmSharesAction({ name: 'rb1', action: 'add', hostPath: real, guestPath: '/live' });
    assert.equal(r.mounted, true);
    assert.equal(shares._internal.isStale(shares._owners.get('rb1')), true);
    // the guest reboots: its service mounts the boot-time list with a NEW boot id
    g.calls.length = 0;
    g.boot = '1a2b3c4d-0000-4000-8000-00000000beef';
    const c2 = await NinepClient.connect({ port: shares.port() });
    await c2.version(65536);
    await c2.attach(0, first.id + ':' + first.secret, { uname: 'boot-' + g.boot });
    await c1.closedPromise; // the previous boot's mount is superseded
    await until(() => g.calls.length > 0, 10000, 'the resync after the reboot');
    await idle('rb1');
    assert.match(g.calls[0].input, /if ismnt '\/live' && alive '\/live'; then/);
    assert.match(g.calls[0].input, /if ismnt '\/boot-list' && alive '\/boot-list'; then/, 'what the boot mounted is kept');
    assert.equal(shares._owners.get('rb1').bootTag, 'boot-' + g.boot);
    // the same boot mounting again (another attach) changes nothing
    g.calls.length = 0;
    const c3 = await NinepClient.connect({ port: shares.port() });
    await c3.version(65536);
    await c3.attach(0, first.id + ':' + first.secret, { uname: 'boot-' + g.boot });
    await sleep(200);
    assert.equal(g.calls.length, 0);
    // a reboot seen only through SSH going away and coming back (the watch)
    const o = shares._owners.get('rb1');
    assert.ok(o.watch);
    g.up = false;
    await until(() => o.watch && o.watch.down > 0, 15000, 'the watch to see SSH down');
    g.up = true;
    await until(() => g.calls.length > 0, 15000, 'the resync after SSH came back');
    await idle('rb1');
    for (const x of [c2, c3]) await x.destroy();
  } finally {
    shares._internal.setWatchMs(5000);
    g.restore();
    await shares.shutdown();
    tasks._reset();
    clearVms();
    resetConfig();
    rm(root); rm(src);
  }
});

test('GET /api/fs/dirs: sub-folders only, from the profile by default, with drive roots and refusals', async () => {
  // its own data folder INSIDE the listed folder (the temp folder can hold
  // thousands of entries)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-dirs-'));
  config.configure({ data: path.join(base, 'droot') });
  try {
    for (const d of ['beta', 'Alpha', 'gamma10', 'gamma9', '.hidden', 'droot']) fs.mkdirSync(path.join(base, d));
    fs.writeFileSync(path.join(base, 'file.txt'), 'x');
    const r = await shares.listDirs({ path: base });
    assert.equal(r.path, path.resolve(base));
    assert.equal(r.parent, path.dirname(path.resolve(base)));
    assert.deepEqual(r.dirs.map((d) => d.name), ['.hidden', 'Alpha', 'beta', 'droot', 'gamma9', 'gamma10'], 'folders only, sorted naturally');
    assert.ok(r.dirs.every((d) => d.readable && d.path === path.join(r.path, d.name)));
    assert.equal(r.dirs[0].hidden, true);
    assert.equal(r.readable, true);
    assert.equal(r.sep, path.sep);
    if (process.platform === 'win32') {
      assert.ok(r.roots.includes('C:\\'), JSON.stringify(r.roots));
      assert.equal((await shares.listDirs({ path: 'C:' })).path, 'C:\\');
      assert.equal((await shares.listDirs({ path: 'C:\\' })).parent, null);
    } else assert.deepEqual(r.roots, ['/']);
    const h = await shares.listDirs({});
    assert.equal(h.path, path.resolve(os.homedir()), 'starts at the user profile');
    // the data folder (and what contains it) is marked as not shareable
    assert.match(r.dirs.find((d) => d.name === 'droot').refused, /inside the manager's data folder/);
    assert.equal(r.dirs.find((d) => d.name === 'beta').refused, undefined);
    const top = await shares.listDirs({ path: path.parse(base).root });
    const holder = top.dirs.find((d) => samePrefix(base, d.path));
    assert.match(holder.refused, /contains the manager's data folder/);
    const bad = async (q, status, re) => {
      await assert.rejects(shares.listDirs(q), (e) => e.status === status && re.test(e.message), JSON.stringify(q));
    };
    await bad({ path: 'relative/dir' }, 400, /absolute/);
    await bad({ path: path.join(base, 'missing') }, 404, /no folder/);
    await bad({ path: path.join(base, 'file.txt') }, 400, /not a folder/);
    await bad({ path: 'C:\\x\0y' }, 400, /folder path/);
    // over HTTP: token-protected
    const token = config.ensureToken();
    const server = createServer({ token });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    try {
      assert.equal((await request(port, { path: '/api/fs/dirs?path=' + encodeURIComponent(base) })).status, 401);
      const ok = await request(port, { path: '/api/fs/dirs?path=' + encodeURIComponent(base), headers: { 'X-DevBox-Token': token } });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.dirs.length, 6);
    } finally { await new Promise((res) => server.close(res)); }
  } finally { resetConfig(); rm(base); }
});

test('containers: a live add applies at the next start; a removal revokes access at once', async () => {
  const root = useTempRoot('ctr');
  const src = folder('ctr');
  try {
    await shares.ensureServer({ port: 0 });
    const a = shares.newShare({ hostPath: fs.realpathSync.native(src), guestPath: '/app' }, 'aaaabbbbcccc', []);
    await shares.registerFor('container', 'aaaabbbbcccc', [a]);
    const b = shares.newShare({ hostPath: fs.realpathSync.native(src), guestPath: '/data' }, 'aaaabbbbcccc', [a]);
    const r = await shares.add('container', 'aaaabbbbcccc', b);
    assert.equal(r.applied, 'next-start');
    assert.deepEqual(shares.registered('aaaabbbbcccc'), [a.id]);
    const c = await NinepClient.connect({ port: shares.port() });
    await c.version(65536);
    await c.attach(0, a.id + ':' + a.secret);
    const x = await shares.remove('container', 'aaaabbbbcccc', a);
    assert.equal(x.applied, 'live');
    await c.closedPromise;
    assert.deepEqual(shares.registered('aaaabbbbcccc'), []);
    shares.unregister('aaaabbbbcccc');
  } finally { await shares.shutdown(); resetConfig(); rm(root); rm(src); }
});
