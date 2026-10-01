'use strict';
/*
 * lib/vm.js: the pure helpers (QEMU arguments, accel detection, hostname and
 * time-zone handling, qemu-img parsing, network scopes), the guest scripts
 * run in a real POSIX sh against a scratch folder, and - when QEMU is
 * installed - the disk operations with the real qemu-img (relative backing
 * files, snapshots, resize, compact, reset, freeze) and one real VM
 * lifecycle: start without waiting, live port forwards with the user's
 * local/LAN choice, the serial console socket, a bounded stop, and a force
 * stop that cancels a boot that is still waiting.
 *
 * Everything runs in a temporary data root; every QEMU started here is
 * stopped (and killed if a test fails half way).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { CFG } = require('../lib/config');
const platform = require('../lib/platform');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const ports = require('../lib/ports');
const vm = require('../lib/vm');
const monitor = require('../lib/monitor');
const sessions = require('../lib/sessions');
const { run, sleep } = require('../lib/util');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const QI = platform.findTool('qemu-img');
const QEMU = platform.findTool('qemu');
let SH = null;
for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) { if (fs.existsSync(c)) { SH = c; break; } }
const MB = 1024 * 1024;

function fakeT() {
  const lines = [];
  return { id: 'test', lines: lines, log: (m) => lines.push(String(m)), step: (m) => lines.push(String(m)), warn: (m) => lines.push('WARNING: ' + m) };
}
function setup(label) {
  const root = useTempRoot(label);
  tasks._reset();
  ports._resetClaims();
  st.loadState();
  return root;
}
function teardown(root) {
  for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
  tasks._reset();
  resetConfig();
  rm(root);
}
async function qemuImg(args) {
  const r = await run(QI, args);
  assert.equal(r.code, 0, 'qemu-img ' + args.join(' ') + ': ' + r.stderr);
  return r;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('qemuArgs: q35 by default (or QEMU\'s default machine), -cpu max for KVM/HVF, the host-flag model for WHPX', () => {
  const base = { name: 'w', disk: '/d/w.qcow2', mem: 1024, cpus: 2, netdev: 'user,id=n0', mac: 'm', monitor: { path: '/r/w.mon' }, serial: { path: '/r/w.ser' } };
  const q = vm.qemuArgs(Object.assign({ accel: 'whpx' }, base));
  assert.deepEqual(q.slice(0, 8), ['-name', 'w', '-m', '1024', '-smp', '2', '-machine', 'q35']);
  assert.equal(q.indexOf('-cpu'), -1, 'no known model (probe failed): QEMU\'s default');
  assert.ok(q.join(' ').includes('-accel whpx,kernel-irqchip=off -accel tcg,tb-size=256'));
  assert.ok(!q.includes('-no-reboot') && !q.includes('-nographic'));
  assert.ok(q.join(' ').includes('-display none'));
  // item J: under WHPX the model with the host's SSSE3/SSE4.x/POPCNT flags
  const model = 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt';
  const w = vm.qemuArgs(Object.assign({ accel: 'whpx', cpuModel: model }, base));
  assert.equal(w[w.indexOf('-cpu') + 1], model);
  assert.deepEqual(vm.cpuArgs('whpx', model), ['-cpu', model]);
  assert.deepEqual(vm.cpuArgs('tcg', model), [], 'the WHPX model is only for WHPX');
  const k = vm.qemuArgs(Object.assign({ accel: 'kvm', machine: null }, base)).join(' ');
  assert.ok(!k.includes('-machine'));
  assert.ok(k.includes('-accel kvm -accel tcg,tb-size=256 -cpu max'));
  assert.deepEqual(vm.cpuArgs('hvf'), ['-cpu', 'max']);
  assert.deepEqual(vm.cpuArgs('tcg'), []); // tcg gets it from accelArgs
  // extra arguments (the shared-folder fw_cfg list) go last
  const x = vm.qemuArgs(Object.assign({ accel: 'tcg', extraArgs: ['-fw_cfg', 'name=opt/devbox/shares,file=/r/w.shares'] }, base));
  assert.deepEqual(x.slice(-2), ['-fw_cfg', 'name=opt/devbox/shares,file=/r/w.shares']);
});

// The light profile caps the translation cache of a VM that runs under TCG
// itself (QEMU's 1 GiB default is committed up front on Windows); a VM with
// a hardware accelerator keeps its 256 MB fallback cache either way.
test('accelArgs: TCG VMs get config.json vmTcgTbSizeMB (light profile: 256), 0 = QEMU\'s default; new VMs get defaultMem', () => {
  const root = useTempRoot('vmtcg');
  try {
    assert.equal(CFG.vmTcgTbSizeMB, 0);
    assert.deepEqual(vm.accelArgs('tcg'), ['-accel', 'tcg', '-cpu', 'max']);
    assert.deepEqual(vm.accelArgs(undefined), ['-accel', 'tcg', '-cpu', 'max']);
    assert.equal(CFG.defaultMem, 1024);
    assert.equal(st.newVmRecord({ port: 2223 }).mem, 1024);
    fs.writeFileSync(CFG.configFile, JSON.stringify({ lightProfile: true }));
    require('../lib/config').configure({ data: root });
    assert.deepEqual(vm.accelArgs('tcg'), ['-accel', 'tcg,tb-size=256', '-cpu', 'max']);
    assert.deepEqual(vm.accelArgs('whpx'), ['-accel', 'whpx,kernel-irqchip=off', '-accel', 'tcg,tb-size=256'], 'the fallback cache is unchanged');
    assert.deepEqual(vm.accelArgs('kvm'), ['-accel', 'kvm', '-accel', 'tcg,tb-size=256']);
    assert.equal(CFG.defaultMem, 512);
    assert.equal(st.newVmRecord({ port: 2223 }).mem, 512, 'a VM created without a memory size');
    const q = vm.qemuArgs({ name: 'w', disk: '/d/w.qcow2', mem: 512, cpus: 1, accel: 'tcg', netdev: 'user,id=n0', mac: 'm', monitor: { path: '/r/w.mon' }, serial: { path: '/r/w.ser' } });
    assert.ok(q.join(' ').includes('-accel tcg,tb-size=256 -cpu max'));
    // an explicit value wins; the setting applies without a restart
    require('../lib/config').updateEngineSettings({ vmTcgTbSizeMB: 0 });
    assert.deepEqual(vm.accelArgs('tcg'), ['-accel', 'tcg', '-cpu', 'max']);
    require('../lib/config').updateEngineSettings({ vmTcgTbSizeMB: 512, vmDefaultMemMB: 768 });
    assert.deepEqual(vm.accelArgs('tcg'), ['-accel', 'tcg,tb-size=512', '-cpu', 'max']);
    assert.equal(st.newVmRecord({ port: 2223 }).mem, 768);
  } finally { resetConfig(); rm(root); }
});

test('whpxCpuModel: from the host facts file when present (no PowerShell probe)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  // the model is cached per manager process: forget it around this test
  const { useTempRoot, resetConfig, rm } = require('./helpers');
  const root = useTempRoot('cpumodel');
  vm._internal.resetCpuModel();
  try {
    fs.mkdirSync(path.dirname(CFG.hostFactsFile), { recursive: true });
    fs.writeFileSync(CFG.hostFactsFile, JSON.stringify({ version: 2, features: { ssse3: true, sse41: true, sse42: true, avx2: false, rdrand: true } }));
    assert.equal(await vm.whpxCpuModel(), 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+rdrand');
  } finally {
    vm._internal.resetCpuModel();
    resetConfig();
    rm(root);
  }
});

test('effectiveAccel: what QEMU really runs with, from its own output', () => {
  assert.equal(vm.effectiveAccel('whpx', 'Windows Hypervisor Platform accelerator is operational\n'), 'whpx');
  assert.equal(vm.effectiveAccel('whpx', ''), 'tcg');
  assert.equal(vm.effectiveAccel('kvm', 'Could not access KVM kernel module: No such file or directory\nqemu-system-x86_64: failed to initialize kvm: No such file or directory\nqemu-system-x86_64: falling back to tcg\n'), 'tcg');
  assert.equal(vm.effectiveAccel('kvm', ''), 'kvm');
  assert.equal(vm.effectiveAccel('tcg', 'anything'), 'tcg');
  assert.equal(vm.effectiveAccel(null, ''), 'tcg');
});

test('guestHostname / validTimezone / snapshotNameError', () => {
  assert.equal(vm.guestHostname('web'), 'web');
  assert.equal(vm.guestHostname('my_app.v2'), 'my-app-v2');
  assert.equal(vm.guestHostname('a__b..c'), 'a-b-c');
  assert.equal(vm.guestHostname('_x_'), 'x');
  assert.equal(vm.guestHostname('...'), 'devbox');
  assert.equal(vm.guestHostname('a'.repeat(80)).length, 63);
  assert.equal(vm.guestHostname('a'.repeat(62) + '_b'), 'a'.repeat(62)); // no trailing "-"
  assert.equal(vm.validTimezone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(vm.validTimezone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(vm.validTimezone('Etc/GMT+4'), 'Etc/GMT+4');
  assert.equal(vm.validTimezone('UTC'), 'UTC');
  for (const bad of ['../etc/passwd', 'Asia/../x', 'a b', '', null, 'x;rm -rf /', '/abs']) assert.equal(vm.validTimezone(bad), null, String(bad));
  assert.equal(vm.snapshotNameError('before-upgrade'), null);
  assert.equal(vm.snapshotNameError('v1.2_ok'), null);
  for (const bad of ['', undefined, 'a b', '-x', '../x', 'x'.repeat(64), 5]) assert.ok(vm.snapshotNameError(bad), String(bad));
});

test('parseQemuImgInfo: sizes, backing file and snapshots (QEMU 10.2 output)', () => {
  const i = vm.parseQemuImgInfo(JSON.stringify({
    'backing-filename-format': 'qcow2', 'virtual-size': 67108864, filename: 'C:/x/sandboxes/web.qcow2', format: 'qcow2', 'actual-size': 459264,
    snapshots: [{ icount: 0, 'vm-clock-nsec': 0, name: 'before-upgrade', 'date-sec': 1790755303, 'date-nsec': 202227000, 'vm-clock-sec': 0, id: '1', 'vm-state-size': 0 }],
    'full-backing-filename': 'C:/x/sandboxes/../base.qcow2', 'backing-filename': '../base.qcow2', 'dirty-flag': false,
  }));
  assert.equal(i.virtualSize, 67108864);
  assert.equal(i.backing, '../base.qcow2');
  assert.equal(i.backingFormat, 'qcow2');
  assert.equal(i.snapshots.length, 1);
  assert.equal(i.snapshots[0].name, 'before-upgrade');
  assert.equal(i.snapshots[0].date, new Date(1790755303000).toISOString());
  const plain = vm.parseQemuImgInfo({ 'virtual-size': 1, format: 'qcow2' });
  assert.equal(plain.backing, null);
  assert.deepEqual(plain.snapshots, []);
  assert.throws(() => vm.parseQemuImgInfo('not json'));
});

test('scopeOf: loopback = this PC only, anything else = reachable from the network', () => {
  assert.equal(vm.scopeOf('127.0.0.1'), 'local');
  assert.equal(vm.scopeOf('127.0.0.2'), 'local');
  assert.equal(vm.scopeOf('::1'), 'local');
  assert.equal(vm.scopeOf('0.0.0.0'), 'lan');
  assert.equal(vm.scopeOf('::'), 'lan');
  assert.equal(vm.scopeOf('192.168.1.20'), 'lan');
  assert.equal(vm.scopeOf(null), null);
});

// ---------------------------------------------------------------------------
// guest scripts in a real sh
// ---------------------------------------------------------------------------
test('retryFs: a file another process briefly holds (EPERM/EBUSY on Windows) is retried, other errors are not', async () => {
  let n = 0;
  const v = await vm.retryFs('deleting x', () => {
    n++;
    if (n < 3) throw Object.assign(new Error('EPERM, Permission denied'), { code: n === 1 ? 'EPERM' : 'EBUSY' });
    return 'ok';
  });
  assert.equal(v, 'ok');
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(vm.retryFs('deleting y', () => { n++; throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); }), /nope/);
  assert.equal(n, 1, 'no retry for other errors');
  // no read in flight: returns at once
  const t0 = Date.now();
  await vm.infoIdle('no-such-vm');
  assert.ok(Date.now() - t0 < 100);
});

test('the guest scripts are valid sh', { skip: !SH && 'no POSIX sh here' }, () => {
  for (const s of [vm.personalizeScript('web', 'Europe/Berlin'), vm.growFsScript()]) {
    execFileSync(SH, ['-n'], { input: s, windowsHide: true });
  }
});

test('personalizeScript: renames the guest in /etc/hostname and /etc/hosts, copies the time zone', { skip: !SH && 'no POSIX sh here' }, () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-guest-')).replace(/\\/g, '/');
  try {
    fs.mkdirSync(dir + '/etc', { recursive: true });
    fs.mkdirSync(dir + '/usr/share/zoneinfo/Europe', { recursive: true });
    fs.writeFileSync(dir + '/usr/share/zoneinfo/Europe/Berlin', 'TZif-berlin');
    fs.writeFileSync(dir + '/etc/hostname', 'devbox\n');
    fs.writeFileSync(dir + '/etc/hosts', '127.0.0.1\tlocalhost\n127.0.1.1 devbox devbox.localdomain devbox\n# devboxes are fun\n');
    const out = execFileSync(SH, ['-s'], { input: vm.personalizeScript('web-1', 'Europe/Berlin', { root: dir }), encoding: 'utf8', windowsHide: true });
    assert.match(out, /hostname: web-1/);
    assert.match(out, /time zone: Europe\/Berlin/);
    assert.equal(fs.readFileSync(dir + '/etc/hostname', 'utf8').trim(), 'web-1');
    const hosts = fs.readFileSync(dir + '/etc/hosts', 'utf8');
    assert.match(hosts, /^127\.0\.1\.1 web-1 web-1\.localdomain web-1$/m, hosts);
    assert.match(hosts, /devboxes are fun/); // only whole names are replaced
    assert.equal(fs.readFileSync(dir + '/etc/localtime', 'utf8'), 'TZif-berlin');
    assert.equal(fs.readFileSync(dir + '/etc/timezone', 'utf8').trim(), 'Europe/Berlin');
    // a second run (template frozen from web-1) renames again; a missing zone is reported
    const out2 = execFileSync(SH, ['-s'], { input: vm.personalizeScript('api', 'Mars/Olympus', { root: dir }), encoding: 'utf8', windowsHide: true });
    assert.match(out2, /not installed/);
    assert.match(fs.readFileSync(dir + '/etc/hosts', 'utf8'), /^127\.0\.1\.1 api api\.localdomain api$/m);
    // no hosts line for the name at all -> one is added
    fs.writeFileSync(dir + '/etc/hosts', '127.0.0.1 localhost\n');
    execFileSync(SH, ['-s'], { input: vm.personalizeScript('db', '', { root: dir }), windowsHide: true });
    assert.match(fs.readFileSync(dir + '/etc/hosts', 'utf8'), /^127\.0\.1\.1\tdb$/m);
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// network overview (listeners stubbed)
// ---------------------------------------------------------------------------
test('validators: a VM still being created answers 409 BUSY naming the create task, not 404', async () => {
  const root = useTempRoot('lookup');
  tasks._reset();
  st.loadState();
  let release;
  const gate = new Promise((r) => { release = r; });
  try {
    // the create task holds vm:newbox before the record exists
    const holder = tasks.start({ kind: 'create', title: 'Create newbox', vm: 'newbox', locks: ['vm:newbox'] }, () => gate);
    for (const fn of [vm.validateDelete, vm.validateStop, vm.validateStart, vm.forgetVm]) {
      await assert.rejects(fn({ name: 'newbox' }), (e) => e.status === 409 && e.code === 'BUSY' && e.holder && e.holder.id === holder.id, fn.name);
    }
    release();
    await tasks.wait(holder.id);
    // nothing holds it and there is no record: a plain 404
    await assert.rejects(vm.validateDelete({ name: 'newbox' }), (e) => e.status === 404 && /no VM called "newbox"/.test(e.message));
    await assert.rejects(vm.validateDelete({ name: '../x' }), (e) => e.status === 400);
  } finally {
    release();
    tasks._reset();
    resetConfig();
    rm(root);
  }
});

test('status polls: a pid verified as QEMU once is not listed again while it lives; a gone pid is re-checked (tasklist can take seconds)', async () => {
  const root = setup('vm-alive');
  const saved = platform.listQemuPids;
  let listings = 0;
  // this test process stands in for a QEMU adopted from an earlier manager
  platform.listQemuPids = async () => { listings++; return new Set([process.pid]); };
  try {
    st.state.vms.adopted = st.newVmRecord({ port: 2300, runtime: { pid: process.pid, monitor: null, serial: null } });
    assert.equal(await vm.isRunning('adopted'), true);
    const after = listings;
    assert.ok(after >= 1, 'an unverified pid is listed once');
    await sleep(1100); // past the 1 s listing cache
    for (let i = 0; i < 5; i++) assert.equal(await vm.isRunning('adopted'), true);
    const list = await vm.listVms();
    assert.equal(list.find((x) => x.name === 'adopted').pid, process.pid);
    assert.equal(listings, after, 'no further process listing for a verified, living pid');
    // a recorded pid that is not running: never "running"
    st.state.vms.gone = st.newVmRecord({ port: 2301, runtime: { pid: 2147483646, monitor: null, serial: null } });
    assert.equal(await vm.isRunning('gone'), false);
  } finally {
    platform.listQemuPids = saved;
    teardown(root);
  }
});

test('own QEMU child: gone as soon as the OS says so, even before its exit event (a clean power-off is not "could not be stopped")', async () => {
  const root = setup('vm-exit-race');
  const { spawn } = require('child_process');
  const saved = platform.listQemuPids;
  let listings = 0;
  platform.listQemuPids = async () => { listings++; return new Set(); };
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  try {
    // the record as spawnQemu makes it - but its 'exit' event is NOT wired,
    // which is exactly the moment between the process ending and the event
    const rec = { child: child, pid: child.pid, exited: false, code: null };
    vm._internal.children.set('race', rec);
    st.state.vms.race = st.newVmRecord({ port: 2310, runtime: { pid: child.pid, monitor: null, serial: null } });
    assert.equal(await vm.isRunning('race'), true, 'alive while it runs');
    for (let i = 0; i < 100 && platform.pidAlive(child.pid); i++) await sleep(50);
    assert.equal(platform.pidAlive(child.pid), false);
    assert.equal(rec.exited, false, 'the exit event has not been seen');
    assert.equal(await vm.isRunning('race'), false, 'gone once the OS says so');
    const t = fakeT();
    const r = await vm.opStop(t, { name: 'race' });
    assert.equal(r.how, 'not-running');
    assert.equal(listings, 0, 'no process listing was needed for our own child');
  } finally {
    platform.listQemuPids = saved;
    vm._internal.children.delete('race');
    teardown(root);
  }
});

test('status: a slow sshd banner does not flip a running VM to "booting"; two failed probes in a row do (TCG / busy PC)', { timeout: 60000 }, async () => {
  const root = setup('vm-probe');
  const saved = platform.listQemuPids;
  platform.listQemuPids = async () => new Set([process.pid]);
  // a fake sshd: banner after `delay` ms, or no banner at all
  let delay = 0, silent = false;
  const srv = require('net').createServer((s) => {
    s.on('error', () => {});
    if (silent) return s.destroy();
    setTimeout(() => { try { s.write('SSH-2.0-OpenSSH_fake\r\n'); } catch (e) {} }, delay);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const status = async () => (await vm.listVms()).find((x) => x.name === 'slow').status;
  try {
    st.state.vms.slow = st.newVmRecord({ port: srv.address().port, runtime: { pid: process.pid, monitor: null, serial: null } });
    assert.equal(await status(), 'running');
    await sleep(5200); // past the 5 s freshness
    delay = 2500;      // slower than a poll waits, well within the probe timeout
    let t0 = Date.now();
    assert.equal(await status(), 'running', 'answered from the last result');
    assert.ok(Date.now() - t0 < 1800, 'the poll did not wait for the slow banner (' + (Date.now() - t0) + ' ms)');
    await sleep(2000); // the probe finishes in the background: still running
    assert.equal(await status(), 'running');
    await sleep(5200);
    silent = true;
    t0 = Date.now();
    assert.equal(await status(), 'running', 'one failed probe is not enough');
    await sleep(5200);
    assert.equal(await status(), 'booting', 'the second failure in a row counts');
  } finally {
    platform.listQemuPids = saved;
    srv.close();
    teardown(root);
  }
});

test('networkOverview: rows per forward with the chosen exposure, the real scope, owner pid and conflicts', async () => {
  const root = setup('vm-net');
  const saved = platform.listListeners;
  try {
    st.state.vms.web = st.newVmRecord({ port: 2223, ports: [{ host: 8080, guest: 80, lan: true, owner: 'nginx', container: 80 }, { host: 9000, guest: 9000 }] });
    st.state.vms.web.runtime = { pid: 4242, startedAt: null, accel: 'tcg', monitor: null, serial: null };
    st.state.vms.db = st.newVmRecord({ port: 2224, ports: [{ host: 9000, guest: 5432 }] });
    platform.listListeners = async () => [
      { port: 2223, address: '127.0.0.1', pid: 4242 },
      { port: 8080, address: '127.0.0.1', pid: 4242 }, // chosen LAN, still bound locally (not restarted yet)
      { port: 9000, address: '0.0.0.0', pid: 777 },    // another program
    ];
    const r = await vm.networkOverview();
    assert.equal(r.listenersAvailable, true);
    const row = (vmName, host) => r.rows.find((x) => x.vm === vmName && x.host === host);
    assert.equal(r.rows[0].kind, 'ssh'); // sorted by host port
    assert.deepEqual([row('web', 2223).byVm, row('web', 2223).scope, row('web', 2223).exposure, row('web', 2223).mismatch], [true, 'local', 'local', false]);
    assert.deepEqual([row('web', 8080).exposure, row('web', 8080).scope, row('web', 8080).mismatch, row('web', 8080).owner], ['lan', 'local', true, 'nginx']);
    assert.equal(row('web', 9000).byVm, false);
    assert.equal(row('web', 9000).conflict, true); // two VMs claim 9000, and another program holds it
    assert.equal(row('db', 2224).listening, false);
    assert.ok(r.rows.some((x) => x.kind === 'manager'));
    platform.listListeners = async () => null;
    assert.equal((await vm.networkOverview()).listenersAvailable, false);
  } finally { platform.listListeners = saved; teardown(root); }
});

// ---------------------------------------------------------------------------
// disks with the real qemu-img
// ---------------------------------------------------------------------------
test('create: thin clone with a RELATIVE backing file - the data folder can move; start refuses without its template', { skip: !QI && 'qemu-img not installed' }, async () => {
  const root = setup('vm-create');
  let copy = null;
  try {
    await qemuImg(['create', '-f', 'qcow2', CFG.base, '64M']);
    const a = await vm.validateCreate({ name: 'web', mem: 512, cpus: 1, ports: 'lan:18080:80' });
    const r = await vm.opCreate(fakeT(), a);
    assert.equal(r.name, 'web');
    assert.deepEqual(st.state.vms.web.ports, [{ host: 18080, guest: 80, lan: true }]);
    const info = await vm.diskInfo(st.diskPath('web'));
    assert.equal(info.backing, '../devbox-base.qcow2');
    await assert.rejects(vm.validateCreate({ name: 'web' }), (e) => e.status === 409);
    // copy the whole data folder elsewhere: the clone still finds its template
    copy = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-moved-'));
    fs.cpSync(root, copy, { recursive: true });
    const moved = await vm.diskInfo(path.join(copy, 'sandboxes', 'web.qcow2').replace(/\\/g, '/'));
    assert.ok(moved.backingFull && fs.existsSync(moved.backingFull), 'backing resolves inside the copy: ' + moved.backingFull);
    assert.ok(path.resolve(moved.backingFull).startsWith(path.resolve(copy)));
    // template gone -> a clear error before QEMU is even started
    fs.renameSync(CFG.base, CFG.base + '.away');
    if (QEMU) {
      await assert.rejects(vm.validateStart({ name: 'web' }), (e) => e.status === 409 && e.code === 'TEMPLATE_MISSING' && /template "devbox-base" is missing/.test(e.message));
      await assert.rejects(vm.opStart(fakeT(), { name: 'web', waitS: 0 }), /template "devbox-base" is missing/);
    }
    await assert.rejects(vm.validateCompact({ name: 'web' }), (e) => e.status === 409 && e.code === 'TEMPLATE_MISSING');
  } finally { if (copy) rm(copy); teardown(root); }
});

test('snapshots: create / duplicate refused / list / revert / delete; compact refuses while snapshots exist', { skip: !QI && 'qemu-img not installed' }, async () => {
  const root = setup('vm-snap');
  try {
    await qemuImg(['create', '-f', 'qcow2', CFG.base, '64M']);
    await vm.opCreate(fakeT(), await vm.validateCreate({ name: 'web' }));
    await assert.rejects(vm.validateSnapshot({ name: 'web', action: 'boom' }), (e) => e.status === 400);
    await assert.rejects(vm.validateSnapshot({ name: 'web', action: 'create', snapshot: 'a b' }), (e) => e.status === 400);
    await assert.rejects(vm.validateSnapshot({ name: 'web', action: 'revert', snapshot: 'nope' }), (e) => e.status === 404);
    const c = await vm.opSnapshot(fakeT(), await vm.validateSnapshot({ name: 'web', action: 'create', snapshot: 'clean' }));
    assert.deepEqual(c.snapshots.map((s) => s.name), ['clean']);
    await assert.rejects(vm.validateSnapshot({ name: 'web', action: 'create', snapshot: 'clean' }), (e) => e.status === 409 && e.code === 'EXISTS');
    const l = await vm.opSnapshot(fakeT(), await vm.validateSnapshot({ name: 'web' }));
    assert.equal(l.action, 'list');
    assert.equal(l.snapshots.length, 1);
    await assert.rejects(vm.validateCompact({ name: 'web' }), (e) => e.status === 409 && e.code === 'HAS_SNAPSHOTS');
    await vm.opSnapshot(fakeT(), await vm.validateSnapshot({ name: 'web', action: 'revert', snapshot: 'clean' }));
    const d = await vm.opSnapshot(fakeT(), await vm.validateSnapshot({ name: 'web', action: 'delete', snapshot: 'clean' }));
    assert.deepEqual(d.snapshots, []);
    // the status poll picks the snapshot list and virtual size up in the background
    await vm.opSnapshot(fakeT(), await vm.validateSnapshot({ name: 'web', action: 'create', snapshot: 's2' }));
    let row = null;
    for (let i = 0; i < 20; i++) {
      row = (await vm.listVms()).find((x) => x.name === 'web');
      if (row.snapshots.length && row.virtualSizeBytes) break;
      await sleep(150);
    }
    assert.deepEqual(row.snapshots.map((s) => s.name), ['s2']);
    assert.equal(row.virtualSizeBytes, 64 * MB);
  } finally { teardown(root); }
});

test('resize (grow only), compact (rewrite keeps the relative template), reset to template (keeps settings)', { skip: !QI && 'qemu-img not installed' }, async () => {
  const root = setup('vm-disk');
  try {
    await qemuImg(['create', '-f', 'qcow2', CFG.base, '64M']);
    await vm.opCreate(fakeT(), await vm.validateCreate({ name: 'web', mem: 768, ports: [{ host: 18081, guest: 80 }] }));
    await assert.rejects(vm.validateResize({ name: 'web' }), (e) => e.status === 400);
    await vm.opResize(fakeT(), await vm.validateResize({ name: 'web', sizeGB: 2 }));
    assert.equal(st.state.vms.web.pendingFsResize, true);
    assert.equal((await vm.diskInfo(st.diskPath('web'))).virtualSize, 2 * 1024 * MB);
    await assert.rejects(vm.validateResize({ name: 'web', sizeGB: 2 }), (e) => e.status === 400 && /only grow/.test(e.message));

    // put some data into the overlay, then zero it again: compaction drops it
    const qio = path.join(path.dirname(QI), 'qemu-io' + (process.platform === 'win32' ? '.exe' : ''));
    const hasIo = fs.existsSync(qio);
    if (hasIo) {
      await run(qio, ['-f', 'qcow2', '-c', 'write -P 0xab 0 4M', st.diskPath('web')]);
      await run(qio, ['-f', 'qcow2', '-c', 'write -P 0 0 4M', st.diskPath('web')]);
    }
    const a = await vm.validateCompact({ name: 'web' });
    assert.equal(a.mode, 'rewrite');
    const c = await vm.opCompact(fakeT(), a);
    if (hasIo) assert.ok(c.bytesAfter < c.bytesBefore, 'compacted ' + c.bytesBefore + ' -> ' + c.bytesAfter);
    const after = await vm.diskInfo(st.diskPath('web'));
    assert.equal(after.backing, '../devbox-base.qcow2');
    assert.equal(after.virtualSize, 2 * 1024 * MB);
    assert.ok(!fs.existsSync(st.diskPath('web') + '.compact'));

    // reset: a fresh overlay of the template, same size, settings kept
    if (hasIo) await run(qio, ['-f', 'qcow2', '-c', 'write -P 0xcd 0 4M', st.diskPath('web')]);
    st.state.vms.web.personalized = true;
    const ra = await vm.validateReset({ name: 'web' });
    const rr = await vm.opReset(fakeT(), ra);
    assert.equal(rr.reset, true);
    const w = st.state.vms.web;
    assert.equal(w.personalized, false);
    assert.equal(w.mem, 768);
    assert.deepEqual(w.ports.map((p) => p.host), [18081]);
    assert.equal(w.pendingFsResize, true); // enlarged disk kept its size
    const ri = await vm.diskInfo(st.diskPath('web'));
    assert.equal(ri.backing, '../devbox-base.qcow2');
    assert.equal(ri.virtualSize, 2 * 1024 * MB);
    assert.ok(ri.actualSize < 1 * MB, 'fresh overlay is tiny: ' + ri.actualSize);

    // standalone disks and unknown templates cannot be reset
    w.template = '';
    await assert.rejects(vm.validateReset({ name: 'web' }), (e) => e.status === 409 && e.code === 'NO_TEMPLATE');
  } finally { teardown(root); }
});

test('freeze: flattened standalone template; "devbox-base" and existing names refused, case-insensitively', { skip: !QI && 'qemu-img not installed' }, async () => {
  const root = setup('vm-freeze');
  try {
    await qemuImg(['create', '-f', 'qcow2', CFG.base, '64M']);
    await vm.opCreate(fakeT(), await vm.validateCreate({ name: 'web' }));
    await assert.rejects(vm.validateFreeze({ name: 'web', as: 'DEVBOX-BASE' }), (e) => e.status === 400);
    const a = await vm.validateFreeze({ name: 'web', as: 'web-tpl' });
    const r = await vm.opFreeze(fakeT(), a);
    assert.equal(r.template, 'web-tpl');
    const ti = await vm.diskInfo(vm.templateFile('web-tpl'));
    assert.equal(ti.backing, null, 'a template is standalone');
    await assert.rejects(vm.validateFreeze({ name: 'web', as: 'WEB-TPL' }), (e) => e.status === 409);
    const list = vm.listTemplates();
    assert.deepEqual(list.map((x) => [x.name, x.usedBy]), [['devbox-base', 1], ['web-tpl', 0]]);
    // a VM made from the new template is a clone of IT (relative path into vm-bases)
    await vm.opCreate(fakeT(), await vm.validateCreate({ name: 'api', template: 'web-tpl' }));
    assert.equal((await vm.diskInfo(st.diskPath('api'))).backing, '../vm-bases/web-tpl.qcow2');
  } finally { teardown(root); }
});

// ---------------------------------------------------------------------------
// identity, adoption, stop, settings and port changes (stubbed processes)
// ---------------------------------------------------------------------------
function sleeper() {
  const { spawn } = require('child_process');
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
}

test('adoptRunning: keeps only pids the VM\'s own monitor confirms, never touches a start that ran meanwhile, adopts by SSH port only after a v1 upgrade', async () => {
  const root = setup('vm-adopt');
  const saved = { list: platform.listQemuPids, listen: platform.listListeners, info: monitor.infoName };
  const kids = [sleeper(), sleeper(), sleeper()];
  try {
    const [good, mute, legacy] = kids.map((k) => k.pid);
    const ep = (port) => ({ host: '127.9.9.9', port: port });
    st.state.vms.good = st.newVmRecord({ port: 2320, template: '', runtime: { pid: good, monitor: ep(2), serial: null } });
    st.state.vms.mute = st.newVmRecord({ port: 2321, template: '', runtime: { pid: mute, monitor: ep(3), serial: null } });
    st.state.vms.stale = st.newVmRecord({ port: 2322, template: '', runtime: { pid: process.pid, monitor: ep(1), serial: null } });
    st.state.vms.twin = st.newVmRecord({ port: 2323, template: '', runtime: { pid: good, monitor: ep(2), serial: null } });
    st.state.vms.fresh = st.newVmRecord({ port: 2324, template: '' });
    st.state.vms.old = st.newVmRecord({ port: 2330, template: '' });
    monitor.infoName = async (e) => ({ 1: 'someone-else', 2: 'good', 3: null })[e.port];
    platform.listListeners = async () => [{ port: 2330, address: '0.0.0.0', pid: legacy }];
    // tasklist is slow; a start spawns "fresh"'s QEMU while it runs (correctness-1)
    platform.listQemuPids = async () => {
      await sleep(200);
      st.state.vms.fresh.runtime = { pid: 999999, startedAt: null, accel: 'tcg', monitor: null, serial: null };
      return new Set([good, mute, legacy, process.pid, 999999]);
    };
    await vm.adoptRunning();
    assert.equal(st.state.vms.good.runtime.pid, good, 'its monitor answered "good"');
    assert.equal(vm._internal.identity.get(good), 'good');
    assert.equal(st.state.vms.twin.runtime, null, 'the same pid for a second record: not taken over');
    assert.equal(st.state.vms.stale.runtime, null, 'the monitor says another VM: the pid was reused');
    assert.equal(st.state.vms.mute.runtime, null, 'no answer: cannot be confirmed');
    assert.equal(st.state.vms.fresh.runtime.pid, 999999, 'a runtime set during the listing is left alone');
    assert.equal(st.state.vms.old.runtime, null, 'no SSH-port adoption for a v2 registry');
    // right after an upgrade from a v1 registry: adopted by its SSH port, flagged legacy
    st._meta.migratedFrom = 1;
    platform.listQemuPids = async () => new Set([good, legacy, 999999]);
    await vm.adoptRunning();
    assert.equal(st.state.vms.old.runtime.pid, legacy);
    assert.equal(st.state.vms.old.runtime.legacy, true);
    assert.match(vm.legacyWarning(), /"old" was started by the old version 1 .* restart it now/);
    assert.equal((await vm.listVms()).find((x) => x.name === 'old').legacy, true);
  } finally {
    platform.listQemuPids = saved.list; platform.listListeners = saved.listen; monitor.infoName = saved.info;
    st._meta.migratedFrom = null;
    for (const k of kids) { try { k.kill(); } catch (e) {} }
    vm._internal.identity.clear();
    teardown(root);
  }
});

test('opStop never kills a QEMU pid it cannot confirm is this VM (SEC-8); a pid that is another VM\'s just clears the record', async () => {
  const root = setup('vm-nokill');
  const saved = { list: platform.listQemuPids, info: monitor.infoName, quit: monitor.quit };
  const kid = sleeper();
  try {
    platform.listQemuPids = async () => new Set([kid.pid]);
    monitor.quit = async () => ({ ok: false, text: '', error: 'the QEMU monitor did not answer' });
    monitor.infoName = async () => null;
    st.state.vms.x = st.newVmRecord({ port: 2340, template: '', runtime: { pid: kid.pid, monitor: { host: '127.9.9.9', port: 4 }, serial: null } });
    await assert.rejects(vm.opStop(fakeT(), { name: 'x', force: true }), /cannot be confirmed to be "x" - not killing it/);
    assert.equal(platform.pidAlive(kid.pid), true, 'left alone');
    monitor.infoName = async () => 'y';
    const r = await vm.opStop(fakeT(), { name: 'x', force: true });
    assert.equal(r.how, 'not-running');
    assert.equal(st.state.vms.x.runtime, null);
    assert.equal(platform.pidAlive(kid.pid), true, 'another VM\'s QEMU is never killed');
  } finally {
    platform.listQemuPids = saved.list; monitor.infoName = saved.info; monitor.quit = saved.quit;
    try { kid.kill(); } catch (e) {}
    teardown(root);
  }
});

test('stop: an ssh exit 255 counts as "powered off" only when the connection dropped, not when ssh could not log in', () => {
  assert.equal(vm.sshDropped({ code: 255, noStderr: true, stderr: 'ssh could not connect...' }), true);
  assert.equal(vm.sshDropped({ code: 255, stderr: 'Connection to 127.0.0.1 closed by remote host.' }), true);
  assert.equal(vm.sshDropped({ code: 255, stderr: 'client_loop: send disconnect: Broken pipe' }), true);
  assert.equal(vm.sshDropped({ code: 255, stderr: 'root@127.0.0.1: Permission denied (publickey).' }), false);
  assert.equal(vm.sshDropped({ code: 255, stderr: 'Host key verification failed.' }), false);
  assert.equal(vm.sshDropped({ code: 255, stderr: 'WARNING: UNPROTECTED PRIVATE KEY FILE!' }), false);
  assert.equal(vm.sshDropped({ code: 255, noStderr: true, timedOut: true }), false);
  assert.equal(vm.sshDropped({ code: 1, stderr: '' }), false);
});

test('settings: note, autostart and temporary save while a task holds the VM; mem/cpus/accel/sshLan wait for it (MNT-4)', async () => {
  const root = setup('vm-settings-busy');
  let release;
  const gate = new Promise((r) => { release = r; });
  try {
    st.state.vms.n = st.newVmRecord({ port: 2350, template: '' });
    const holder = tasks.start({ kind: 'start', title: 'Start n', vm: 'n', locks: ['vm:n'] }, () => gate);
    const r = await vm.updateSettings({ name: 'n', note: 'hello', autostart: true, ephemeral: true });
    assert.equal(r.vm.note, 'hello');
    assert.equal(st.state.vms.n.autostart, true);
    assert.equal(st.state.vms.n.ephemeral, true);
    for (const k of [{ mem: 2048 }, { cpus: 1 }, { accel: 'tcg' }, { sshLan: true }]) {
      await assert.rejects(vm.updateSettings(Object.assign({ name: 'n' }, k)), (e) => e.status === 409 && e.code === 'BUSY', JSON.stringify(k));
    }
    release();
    await tasks.wait(holder.id);
    assert.equal((await vm.updateSettings({ name: 'n', mem: 2048 })).vm.mem, 2048);
  } finally { release(); teardown(root); }
});

test('port changes: add/remove work on the CURRENT list; two VMs cannot both take one host port; base catches a stale editor', async () => {
  const root = setup('vm-ports-ops');
  try {
    st.state.vms.a = st.newVmRecord({ port: 2360, template: '', ports: [{ host: 9000, guest: 9000, container: 80, owner: 'web', lan: false }] });
    st.state.vms.b = st.newVmRecord({ port: 2361, template: '' });
    // two changes at once on different VMs, same host port: exactly one wins
    const both = await Promise.allSettled([
      vm.setPorts({ name: 'a', add: [{ host: 38741, guest: 8000 }] }),
      vm.setPorts({ name: 'b', add: [{ host: 38741, guest: 8000 }] }),
    ]);
    assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    const lost = both.find((x) => x.status === 'rejected').reason;
    assert.equal(lost.status, 409);
    assert.match(lost.message, /38741 is already used by/);
    const owners = ['a', 'b'].filter((n) => st.state.vms[n].ports.some((p) => p.host === 38741));
    assert.equal(owners.length, 1, 'one host port, one VM');
    const w = owners[0];
    // add keeps what is there; the same host+guest again only switches exposure (metadata kept)
    await vm.setPorts({ name: 'a', add: [{ host: 9001, guest: 81 }] });
    await vm.setPorts({ name: 'a', add: [{ host: 9000, guest: 9000, lan: true }] });
    const a = st.state.vms.a.ports;
    assert.deepEqual(a.find((p) => p.host === 9000), { host: 9000, guest: 9000, container: 80, owner: 'web', lan: true });
    assert.ok(a.some((p) => p.host === 9001));
    // a different forward on the same host port is refused, not replaced
    await assert.rejects(vm.setPorts({ name: 'a', add: [{ host: 9001, guest: 99 }] }), (e) => e.status === 409 && /already forwards to guest port 81/.test(e.message));
    await vm.setPorts({ name: 'a', remove: [9001] });
    assert.ok(!st.state.vms.a.ports.some((p) => p.host === 9001));
    // the GUI editor sends the list it loaded as base: a change made meanwhile is a 409, not lost
    const loaded = st.state.vms.a.ports.map((p) => ({ host: p.host, guest: p.guest, lan: p.lan }));
    await vm.setPorts({ name: 'a', add: [{ host: 9002, guest: 82 }] }); // e.g. Claude's forward_port
    await assert.rejects(vm.setPorts({ name: 'a', ports: loaded, base: loaded }), (e) => e.status === 409 && e.code === 'CHANGED');
    assert.ok(st.state.vms.a.ports.some((p) => p.host === 9002), 'the forward added meanwhile is still there');
    await assert.rejects(vm.setPorts({ name: 'a', ports: [], add: [] }), (e) => e.status === 400);
    await assert.rejects(vm.setPorts({ name: w, remove: ['x'] }), (e) => e.status === 400);
    assert.equal(ports.reservedPorts({ exceptVm: 'zz' }).get(38741), 'a port forward of VM "' + w + '"', 'no claim is left behind');
  } finally { teardown(root); }
});

test('port changes on a running VM: a host port someone holds is refused (nothing saved, live changes undone) instead of breaking the next start', async () => {
  const root = setup('vm-ports-held');
  const saved = { add: monitor.addForwardLive, remove: monitor.removeForwardLive, free: platform.isPortFree };
  try {
    const held = 38803;
    // free when checked, taken a moment later (another program grabbed it
    // between the check and QEMU's hostfwd_add)
    let checks = 0;
    platform.isPortFree = async (p) => p !== held || checks++ === 0;
    const calls = [];
    monitor.addForwardLive = async (v, m) => { calls.push('add ' + m.host); return m.host === held ? { ok: false, why: 'Could not set up host forwarding rule' } : { ok: true, why: null }; };
    monitor.removeForwardLive = async (v, m) => { calls.push('remove ' + m.host); return { ok: true, why: null }; };
    st.state.vms.r = st.newVmRecord({ port: 2370, template: '', ports: [{ host: 38801, guest: 80, lan: false }],
      runtime: { pid: process.pid, startedAt: null, accel: 'tcg', monitor: { host: '127.9.9.9', port: 6 }, serial: null } });
    vm._internal.children.set('r', { child: {}, pid: process.pid, exited: false }); // "our" running QEMU
    await assert.rejects(vm.setPorts({ name: 'r', ports: [{ host: 38802, guest: 81 }, { host: held, guest: 82 }] }),
      (e) => e.status === 409 && /could not be opened: another program on this PC is using it/.test(e.message));
    assert.deepEqual(st.state.vms.r.ports, [{ host: 38801, guest: 80, lan: false }], 'nothing saved');
    assert.equal(st.state.vms.r.pendingRestart, false);
    assert.deepEqual(calls, ['remove 38801', 'add 38802', 'add ' + held, 'remove 38802', 'add 38801'], 'live changes undone');
  } finally {
    monitor.addForwardLive = saved.add; monitor.removeForwardLive = saved.remove; platform.isPortFree = saved.free;
    vm._internal.children.delete('r');
    teardown(root);
  }
});

test('socketPaths: readable names in run/, short hashed names for long VM names, a checked private folder for a long data path', () => {
  const root = setup('vm-sock');
  try {
    const p = vm.socketPaths('web');
    assert.equal(p.monitor, CFG.runDir + '/web.mon');
    assert.equal(p.serial, CFG.runDir + '/web.ser');
    const long = 'x'.repeat(63);
    const q = vm.socketPaths(long);
    assert.ok(Buffer.byteLength(q.monitor) < 100 && Buffer.byteLength(q.serial) < 100, q.monitor);
    assert.notEqual(q.monitor, q.serial);
    if (process.platform !== 'win32') {
      // a data path too long for any socket name in run/
      CFG.runDir = root + '/' + 'r'.repeat(100);
      const t = vm.socketPaths('web');
      assert.ok(Buffer.byteLength(t.monitor) < 100, t.monitor);
      assert.ok(vm.dirIsPrivate(path.dirname(t.monitor)), 'a 0700 folder of this user');
      // a folder another user (or anything) made open is never used
      fs.chmodSync(path.dirname(t.monitor), 0o777);
      const u = vm.socketPaths('web2');
      assert.notEqual(path.dirname(u.monitor), path.dirname(t.monitor));
      assert.ok(vm.dirIsPrivate(path.dirname(u.monitor)));
      fs.chmodSync(path.dirname(t.monitor), 0o700);
    }
  } finally { teardown(root); }
});

test('create: its own forwards are claimed, so the automatic SSH port never lands on one of them (BUG-20)', { skip: !QI && 'qemu-img not installed' }, async () => {
  const root = setup('vm-create-claims');
  try {
    await qemuImg(['create', '-f', 'qcow2', CFG.base, '16M']);
    const a = await vm.validateCreate({ name: 'c1', ports: CFG.firstSshPort + ':80' });
    assert.equal(ports.reservedPorts().get(CFG.firstSshPort), 'a change being made to VM "c1"');
    const r = await vm.opCreate(fakeT(), a);
    assert.notEqual(r.port, CFG.firstSshPort);
    assert.deepEqual(st.state.vms.c1.ports.map((p) => p.host), [CFG.firstSshPort]);
    assert.equal(ports.reservedPorts().get(CFG.firstSshPort), 'a port forward of VM "c1"', 'the claim became the record');
    // a second create cannot take the first one's forward meanwhile
    await assert.rejects(vm.validateCreate({ name: 'c2', ports: CFG.firstSshPort + ':80' }), (e) => e.status === 409);
  } finally { teardown(root); }
});

// ---------------------------------------------------------------------------
// a real VM (no guest OS: a blank disk) - start, live ports, serial, stop
// ---------------------------------------------------------------------------
test('real QEMU: start, private monitor/serial sockets, live forwards with the LAN choice, serial console, bounded stop, force stop cancels a boot', { skip: !(QEMU && QI) && 'QEMU not installed', timeout: 120000 }, async () => {
  const root = setup('vm-qemu');
  const pids = [];
  try {
    const sshPort = await platform.freeLocalPort('127.0.0.1');
    fs.mkdirSync(CFG.sandboxDir, { recursive: true });
    await qemuImg(['create', '-f', 'qcow2', st.diskPath('box'), '16M']);
    st.state.vms.box = st.newVmRecord({ port: sshPort, mem: 128, cpus: 1, accel: 'tcg', template: '' });
    st.saveState();

    const a = await vm.validateStart({ name: 'box', waitS: 0 });
    const r = await vm.opStart(fakeT(), a);
    const rt = st.state.vms.box.runtime;
    assert.ok(rt && rt.pid, 'runtime recorded');
    pids.push(rt.pid);
    assert.equal(r.accel, 'tcg');
    if (process.platform === 'win32') {
      // a private random 127.x.y.z: out of the guests' reach (they see
      // 127.0.0.1 as 10.0.2.2) and not guessable by a web page (SEC-4)
      assert.match(rt.monitor.host, /^127\.\d+\.\d+\.\d+$/);
      assert.notEqual(rt.monitor.host, '127.0.0.1', 'monitor out of the guests\' reach');
      assert.notEqual(rt.monitor.host, '127.0.0.2', 'not a fixed, predictable address');
      assert.equal(rt.serial.host, rt.monitor.host);
    } else assert.ok(rt.monitor.path && rt.serial.path);
    assert.equal(await vm.isRunning('box'), true);
    assert.equal((await monitor.monitorCmd(rt.monitor, 'info name', { check: false })).text, 'box');
    await assert.rejects(vm.validateStart({ name: 'box' }), (e) => e.status === 409);

    // live forwards: one for this PC only, one for the LAN
    const p1 = await platform.freeLocalPort('127.0.0.1');
    const p2 = await platform.freeLocalPort('127.0.0.1');
    const set = await vm.setPorts({ name: 'box', ports: [{ host: p1, guest: 80 }, { host: p2, guest: 3000, lan: true }] });
    assert.equal(set.applied, 'live', JSON.stringify(set.warnings));
    const fw = (await monitor.listForwards(rt.monitor)).forwards;
    assert.ok(fw.some((f) => f.host === sshPort && f.address === '127.0.0.1'), 'SSH is this-PC-only');
    assert.ok(fw.some((f) => f.host === p1 && f.address === '127.0.0.1'));
    assert.ok(fw.some((f) => f.host === p2 && f.address === '0.0.0.0'));
    const unset = await vm.setPorts({ name: 'box', ports: [{ host: p1, guest: 80 }] });
    assert.equal(unset.applied, 'live');
    assert.ok(!(await monitor.listForwards(rt.monitor)).forwards.some((f) => f.host === p2));

    // serial console: one interactive session; a second one replaces it
    const s1 = await sessions.open({ name: 'box', kind: 'serial' });
    assert.equal(s1.kind, 'serial');
    assert.equal(sessions.writeInput(s1.id, '\r'), true);
    const s2 = await sessions.open({ name: 'box', kind: 'serial' });
    assert.equal(sessions.writeInput(s1.id, 'x'), false, 'the first serial session was closed');
    assert.equal(sessions.writeInput(s2.id, '\r'), true);

    // a bounded clean stop: no SSH (no guest OS) -> ACPI -> wait -> quit
    const t = fakeT();
    const stop = await vm.opStop(t, await vm.validateStop({ name: 'box', timeoutS: 5 }));
    assert.equal(stop.stopped, true);
    assert.equal(st.state.vms.box.runtime, null);
    assert.equal(platform.pidAlive(rt.pid), false);
    assert.ok(t.lines.some((l) => /ACPI/.test(l)), t.lines.join('\n'));
    assert.equal(sessions.writeInput(s2.id, 'x'), false, 'sessions close when the VM stops');

    // force stop while a start still waits for SSH: the start gives up at once
    const task = tasks.start({ kind: 'start', title: 'Start box', vm: 'box', locks: ['vm:box'] }, (tt) => vm.opStart(tt, { name: 'box', waitS: 120 }));
    for (let i = 0; i < 40 && !(st.state.vms.box.runtime && st.state.vms.box.runtime.pid); i++) await sleep(250);
    if (st.state.vms.box.runtime) pids.push(st.state.vms.box.runtime.pid);
    const t0 = Date.now();
    const fa = await vm.validateStop({ name: 'box', force: true });
    const ended = await tasks.wait(task.id);
    assert.equal(ended.status, 'error');
    assert.match(ended.error, /cancelled/);
    assert.ok(Date.now() - t0 < 10000, 'the boot wait was cancelled quickly');
    const fs2 = await vm.opStop(fakeT(), fa);
    assert.equal(fs2.stopped, true);
    assert.equal(st.state.vms.box.runtime, null);

    // a manager restart: the QEMU is no longer our child. Adoption keeps it
    // only because its OWN monitor says it is "box"; a second record that
    // claims the same pid is cleared, never adopted (SEC-8, BUG-6)
    await vm.opStart(fakeT(), await vm.validateStart({ name: 'box', waitS: 0 }));
    const rt2 = st.state.vms.box.runtime;
    pids.push(rt2.pid);
    vm._internal.children.delete('box');
    vm._internal.identity.clear();
    st.state.vms.other = st.newVmRecord({ port: sshPort + 1, template: '', runtime: { pid: rt2.pid, startedAt: null, accel: 'tcg', monitor: rt2.monitor, serial: null } });
    await vm.adoptRunning();
    assert.equal(st.state.vms.box.runtime && st.state.vms.box.runtime.pid, rt2.pid, 'confirmed by "info name" and adopted');
    assert.equal(st.state.vms.other.runtime, null, 'a pid another record holds is never taken over');
    assert.equal(await vm.confirmIdentity('box', st.state.vms.box), true);
    delete st.state.vms.other;

    // a force stop cuts a normal stop short while it waits for the power-off
    // (the blank guest ignores ACPI, so it would wait the full 60 s)
    const slow = tasks.start({ kind: 'stop', title: 'Stop box', vm: 'box', locks: ['vm:box'] }, (tt) => vm.opStop(tt, { name: 'box', timeoutS: 60 }));
    await sleep(2500);
    const t1 = Date.now();
    const fb = await vm.validateStop({ name: 'box', force: true });
    const slowEnd = await tasks.wait(slow.id);
    assert.equal(slowEnd.status, 'done', slowEnd.error || '');
    assert.ok(Date.now() - t1 < 15000, 'the waiting stop gave way in ' + (Date.now() - t1) + ' ms');
    assert.equal(platform.pidAlive(rt2.pid), false);
    assert.equal((await vm.opStop(fakeT(), fb)).how, 'not-running');
  } finally {
    for (const pid of pids) { if (platform.pidAlive(pid)) { platform.killPid(pid); } }
    await sleep(300);
    teardown(root);
  }
});
