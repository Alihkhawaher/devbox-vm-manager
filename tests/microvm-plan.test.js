'use strict';
/*
 * microVM run planning (lib/microvm/plan.js): Docker's ENTRYPOINT/CMD and
 * env rules, the content-keyed initrd cache (bug V4b), the QEMU plan with
 * caller-supplied private endpoints (bug V3), and host facts keyed by the
 * QEMU version and the DETECTED accelerator (bug A).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plan = require('../lib/microvm/plan');
const platform = require('../lib/platform');
const { CFG } = require('../lib/config');
const { CpioWriter, listCpioBuffer } = require('../lib/oci/cpio');

const CFG_A = 'sha256:' + 'a'.repeat(64);
const CFG_B = 'sha256:' + 'b'.repeat(64);
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'mvm-' + tag + '-'));

test('resolveArgv follows Docker ENTRYPOINT/CMD rules', () => {
  const rt = { entrypoint: ['/docker-entrypoint.sh'], cmd: ['nginx', '-g', 'daemon off;'] };
  assert.deepStrictEqual(plan.resolveArgv(rt), ['/docker-entrypoint.sh', 'nginx', '-g', 'daemon off;']);
  assert.deepStrictEqual(plan.resolveArgv(rt, { cmd: ['nginx', '-t'] }), ['/docker-entrypoint.sh', 'nginx', '-t']);
  // --entrypoint drops the image CMD
  assert.deepStrictEqual(plan.resolveArgv(rt, { entrypoint: 'sh' }), ['sh']);
  assert.deepStrictEqual(plan.resolveArgv(rt, { entrypoint: ['sh', '-c'], cmd: ['echo hi'] }), ['sh', '-c', 'echo hi']);
  assert.deepStrictEqual(plan.resolveArgv({ cmd: ['/hello'] }), ['/hello']);
  // --entrypoint "" clears it; CMD then is the command
  assert.deepStrictEqual(plan.resolveArgv(rt, { entrypoint: '', cmd: ['ls'] }), ['ls']);
  assert.throws(() => plan.resolveArgv({}, {}), /no command specified/);
  assert.throws(() => plan.resolveArgv(rt, { entrypoint: '' }), /no command specified/);
});

test('mergeEnv: later values replace earlier ones in place', () => {
  assert.deepStrictEqual(plan.mergeEnv(['PATH=/bin', 'A=1'], { A: '2', B: 'x=y' }), ['PATH=/bin', 'A=2', 'B=x=y']);
  assert.deepStrictEqual(plan.mergeEnv(null, ['K=']), ['K=']);
  assert.throws(() => plan.mergeEnv(['NOVALUE']), /K=V/);
  assert.throws(() => plan.mergeEnv(['=x']), /K=V/);
});

test('buildSpec: image defaults, run overrides, volume serials', () => {
  const rt = { cmd: ['app'], env: ['PATH=/usr/bin'], workingDir: '/srv', user: '101', stopSignal: 'SIGQUIT' };
  const s = plan.buildSpec(rt, { env: { X: '1' }, volumes: [{ target: '/data' }, { target: '/cfg', readonly: true, serial: 'cfg' }], hostname: 'web' });
  assert.deepStrictEqual(s.argv, ['app']);
  assert.deepStrictEqual(s.env, ['PATH=/usr/bin', 'X=1']);
  assert.strictEqual(s.workdir, '/srv');
  assert.strictEqual(s.user, '101');
  assert.strictEqual(s.stopSignal, 'SIGQUIT');
  assert.strictEqual(s.stopTimeout, 10);
  assert.deepStrictEqual(s.volumes, [{ serial: 'vol0', target: '/data', readonly: false, nocopy: false }, { serial: 'cfg', target: '/cfg', readonly: true, nocopy: false }]);
  const s2 = plan.buildSpec(rt, { user: '', workdir: '/', net: false, stopTimeout: 0 });
  assert.strictEqual(s2.user, '');
  assert.strictEqual(s2.net, false);
  assert.strictEqual(s2.stopTimeout, 0);
});

function fakeKernel(dir, extraModule) {
  fs.writeFileSync(path.join(dir, 'busybox.static'), 'BB');
  fs.writeFileSync(path.join(dir, 'vmlinuz-virt'), 'K');
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  const modules = {};
  for (const m of ['virtio_net', 'qemu_fw_cfg', 'virtio_blk'].concat(extraModule ? [extraModule] : [])) {
    fs.writeFileSync(path.join(dir, 'modules', m + '.ko'), 'KO');
    modules[m] = { file: 'modules/' + m + '.ko' };
  }
  return { kver: 'test', modules, features: { net: ['virtio_net'], rng: [], blk: ['virtio_blk'], ext4: [], fwcfg: ['qemu_fw_cfg'] }, sha256: { 'busybox.static': 'x' } };
}

async function rootfsFile(dir, name, size) {
  const w = new CpioWriter();
  await w.file('etc/os-release', 'x');
  await w.finish({ padTo: 0 });
  const img = w.toBuffer();
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.concat([img, Buffer.alloc(size - img.length)])); // not a 512 multiple on purpose
  return f;
}

test('ensureImageInitrd: rootfs + padded base archive, cached by CONTENT key (bug V4b)', async () => {
  const dir = tmp('initrd');
  try {
    const manifest = fakeKernel(dir);
    const cacheDir = path.join(dir, 'cache');
    const rootfs = await rootfsFile(dir, 'img.cpio', 700);
    let built = 0;
    const getRootfs = async () => { built++; return rootfs; };
    const a = await plan.ensureImageInitrd({ configDigest: CFG_A, rootfsCpio: getRootfs, kernelDir: dir, manifest, cacheDir });
    assert.strictEqual(a.cached, false);
    assert.strictEqual(built, 1);
    assert.match(path.basename(a.file), /^a{12}-[0-9a-f]{16}\.initrd$/);
    assert.strictEqual(a.bytes, fs.statSync(a.file).size);
    const buf = fs.readFileSync(a.file);
    assert.ok(buf.subarray(0, 700).equals(fs.readFileSync(rootfs)));
    assert.ok(buf.subarray(700, 1024).equals(Buffer.alloc(324)), 'zero padding to 512');
    const base = (await listCpioBuffer(buf.subarray(1024))).map((e) => e.name);
    assert.ok(base.includes('.devbox/init') && base.includes('.devbox/modules/virtio_net.ko') && !base.includes('.devbox/spec.sh'));
    // the rootfs archive changing (mtime, path, even deleted) does NOT change
    // the key: the prototype keyed on its mtime, so a concurrent re-flatten
    // made a second initrd and the prune deleted one a run was booting
    fs.utimesSync(rootfs, new Date(), new Date(Date.now() + 60000));
    const b = await plan.ensureImageInitrd({ configDigest: CFG_A, rootfsCpio: getRootfs, kernelDir: dir, manifest, cacheDir });
    assert.deepStrictEqual([b.cached, b.file, built], [true, a.file, 1], 'a hit never needs the rootfs archive');
    assert.strictEqual(plan.initrdKey({ configDigest: CFG_A, manifest }), a.key);
    // what the key covers: the image, the kernel's modules, busybox
    assert.notStrictEqual(plan.initrdKey({ configDigest: CFG_B, manifest }), a.key);
    assert.notStrictEqual(plan.initrdKey({ configDigest: CFG_A, manifest: fakeKernel(dir, 'overlay') }), a.key);
    assert.notStrictEqual(plan.initrdKey({ configDigest: CFG_A, manifest: Object.assign({}, manifest, { sha256: { 'busybox.static': 'y' } }) }), a.key);
    assert.throws(() => plan.initrdKey({ configDigest: 'latest', manifest }), /config digest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ensureImageInitrd: three concurrent builds of one image give one file, no temp files (bug V4b)', async () => {
  const dir = tmp('initrd-race');
  try {
    const manifest = fakeKernel(dir);
    const cacheDir = path.join(dir, 'cache');
    const rootfs = await rootfsFile(dir, 'img.cpio', 4096);
    const rs = await Promise.all([0, 1, 2].map(() => plan.ensureImageInitrd({ configDigest: CFG_B, rootfsCpio: rootfs, kernelDir: dir, manifest, cacheDir })));
    assert.strictEqual(new Set(rs.map((r) => r.file)).size, 1);
    assert.deepStrictEqual(fs.readdirSync(cacheDir), [path.basename(rs[0].file)]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('planRun: spec via fw_cfg, console + HMP monitor on the caller\'s private endpoints, logs, volumes, ports', () => {
  const dir = tmp('plan');
  try {
    const manifest = fakeKernel(dir);
    const spec = plan.buildSpec({ cmd: ['/bin/app'] }, { volumes: [{ target: '/data' }] });
    const p = plan.planRun({
      kernelDir: dir, manifest, initrd: path.join(dir, 'x.initrd'), runDir: path.join(dir, 'run'), spec,
      machine: 'microvm', accel: 'whpx', tscKhz: 2298666, cpuModel: 'qemu64,+ssse3',
      console: { host: '127.44.55.66', port: 40010 }, monitor: { host: '127.44.55.66', port: 40011 },
      ports: [{ hostPort: 18092, guestPort: 80 }], volumes: [{ file: path.join(dir, 'v.qcow2') }], memMB: 512, cpus: 2,
      pidFile: path.join(dir, 'run', 'qemu.pid'),
    });
    const a = p.args;
    const vals = (flag) => a.map((x, i) => (x === flag ? a[i + 1] : null)).filter((x) => x !== null);
    assert.ok(fs.readFileSync(p.specFile, 'utf8').includes("devbox_volume 'vol0' '/data' rw"));
    assert.ok(p.specText.includes("DEVBOX_MODULES='virtio_net virtio_blk'"));
    assert.deepStrictEqual(vals('-fw_cfg'), ['name=opt/devbox/spec,file=' + p.specFile]);
    assert.ok(vals('-chardev')[0].startsWith('socket,id=con0,host=127.44.55.66,port=40010,server=on,wait=off,logfile='));
    assert.ok(vals('-chardev').includes('socket,id=mon0,host=127.44.55.66,port=40011,server=on,wait=off'));
    assert.deepStrictEqual(vals('-mon'), ['chardev=mon0,mode=readline']);
    assert.ok(!a.includes('-qmp'));
    assert.ok(vals('-chardev').some((c) => c === 'file,id=vp0,path=' + p.logs.stdout));
    assert.ok(vals('-append')[0].includes('tsc_early_khz=2298666'));
    assert.deepStrictEqual(vals('-cpu'), ['qemu64,+ssse3']);
    assert.deepStrictEqual(vals('-m'), ['512']);
    assert.deepStrictEqual(vals('-smp'), ['2']);
    assert.deepStrictEqual(vals('-pidfile'), [path.join(dir, 'run', 'qemu.pid')]);
    assert.ok(vals('-netdev')[0].includes('hostfwd=tcp:127.0.0.1:18092-:80'));
    assert.ok(vals('-device').includes('virtio-blk-device,drive=vol0,serial=vol0'));
    assert.throws(() => plan.planRun({ kernelDir: dir, manifest, initrd: 'x', runDir: path.join(dir, 'r2'), spec, machine: 'microvm', accel: 'whpx', volumes: [{ file: 'v' }] }), /tscKhz/);
    assert.throws(() => plan.planRun({ kernelDir: dir, manifest, initrd: 'x', runDir: path.join(dir, 'r3'), spec, machine: 'q35', accel: 'whpx' }), /differ in length/);
    // no console endpoint: the console is only logged (the calibration boot uses one)
    const q = plan.planRun({ kernelDir: dir, manifest, initrd: 'x', runDir: path.join(dir, 'r4'), spec: plan.buildSpec({ cmd: ['x'] }), machine: 'q35', accel: 'tcg' });
    assert.ok(q.args[q.args.indexOf('-chardev') + 1].startsWith('null,id=con0,logfile='));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('planRun: copy-in archive as a read-only raw disk, its size added to RAM; extra fw_cfg names checked', () => {
  const dir = tmp('copyin');
  try {
    const manifest = fakeKernel(dir);
    const spec = plan.buildSpec({ cmd: ['/bin/app'] }, { copyIn: { targets: ['/app', '/etc/x/'] } });
    assert.deepStrictEqual(spec.copyIn, { targets: ['/app', '/etc/x/'], owner: 'user' });
    const base = {
      kernelDir: dir, manifest, initrd: path.join(dir, 'x.initrd'), runDir: path.join(dir, 'run'), spec,
      machine: 'q35', accel: 'tcg', console: { path: path.join(dir, 'con.sock') },
    };
    const ci = path.join(dir, 'ci.cpio');
    const p = plan.planRun(Object.assign({}, base, {
      extraDrives: [{ id: 'copyin', file: ci, format: 'raw', serial: 'devbox-copyin' }], fwcfg: [{ name: 'opt/devbox/extra', file: ci }], extraMemMB: 100,
    }));
    const vals = (flag) => p.args.map((x, i) => (x === flag ? p.args[i + 1] : null)).filter((x) => x !== null);
    assert.deepStrictEqual(vals('-fw_cfg'), ['name=opt/devbox/spec,file=' + p.specFile, 'name=opt/devbox/extra,file=' + ci]);
    assert.deepStrictEqual(vals('-drive'), ['file=' + ci + ',if=none,id=copyin,format=raw,readonly=on,cache=writeback,discard=unmap']);
    assert.ok(vals('-device').includes('virtio-blk-pci,drive=copyin,serial=devbox-copyin'));
    assert.ok(vals('-chardev')[0].startsWith('socket,id=con0,path=' + path.join(dir, 'con.sock').replace(/,/g, ',,') + ',server=on'));
    assert.strictEqual(p.memMB, 356, '256 default + 100 MB of copied-in files');
    assert.ok(p.specText.includes('DEVBOX_COPYIN=1'));
    assert.ok(p.specText.includes("devbox_copyin_target '/app' || return 1"));
    assert.ok(p.specText.includes("devbox_copyin_target '/etc/x' || return 1"));
    assert.ok(/DEVBOX_MODULES='[^']*virtio_blk/.test(p.specText), 'virtio_blk requested for the copy-in disk');
    assert.throws(() => plan.planRun(Object.assign({}, base, { fwcfg: [{ name: 'etc/evil', file: 'x' }] })), /bad fw_cfg name/);
    assert.throws(() => plan.planRun(Object.assign({}, base, { spec: plan.buildSpec({ cmd: ['x'] }, { copyIn: { targets: ['/.devbox/x'] } }) })), /copy-in target/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recommendedMemMB and the planRun memory guard', () => {
  const MB = 1048576;
  assert.strictEqual(plan.recommendedMemMB(5 * MB), 192);           // small image: app headroom dominates
  assert.strictEqual(plan.recommendedMemMB(53.6 * MB, 0), 208);     // measured: boots at 208, not 192
  assert.ok(plan.recommendedMemMB(68.5 * MB, 0) >= 224);            // measured: boots at 224, not 208
  const dir = tmp('mem');
  try {
    const manifest = fakeKernel(dir);
    const initrd = path.join(dir, 'big.initrd');
    fs.writeFileSync(initrd, Buffer.alloc(60 * MB));
    const base = { kernelDir: dir, manifest, initrd, runDir: path.join(dir, 'run'), spec: plan.buildSpec({ cmd: ['x'] }, { net: false }), machine: 'q35', accel: 'tcg' };
    assert.throws(() => plan.planRun(Object.assign({}, base, { memMB: 160 })), (e) => e.code === 'MEMORY_TOO_SMALL' && /too small/.test(e.message));
    const p = plan.planRun(base); // default: enough for the image plus headroom
    const m = +p.args[p.args.indexOf('-m') + 1];
    assert.ok(m >= plan.recommendedMemMB(60 * MB), String(m));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkQemuPath: 260+ characters are refused on Windows only', () => {
  const long = 'C:\\' + 'x'.repeat(300);
  assert.throws(() => plan.checkQemuPath(long, 'win32'), (e) => e.code === 'PATH_TOO_LONG' && /--data/.test(e.message));
  assert.strictEqual(plan.checkQemuPath('/' + 'x'.repeat(300), 'linux'), '/' + 'x'.repeat(300));
});

test('parseConsole: exit code is the last marker; panics are flagged; forged junk is ignored', () => {
  const log = '[ 0.1] boot\n__DEVBOX_INIT uptime=0.52\n__DEVBOX_READY\nnoise __DEVBOX_EXIT=137\n[ 1.2] reboot: Power down\n';
  const r = plan.parseConsole(log);
  assert.strictEqual(r.exitCode, 137);
  assert.strictEqual(r.markers.INIT, true);
  assert.strictEqual(r.markers.READY, true);
  assert.strictEqual(r.kernelPanic, false);
  assert.strictEqual(plan.parseConsole('Kernel panic - not syncing: Attempted to kill init!').kernelPanic, true);
  assert.strictEqual(plan.parseConsole('').exitCode, null);
  assert.strictEqual(plan.parseConsole('__DEVBOX_EXIT=abc').exitCode, null, 'only a number is an exit code');
});

// bug A: the prototype forced "whpx" on every Windows PC and cached a TSC
// frequency measured under a silent TCG fallback, labelled whpx
test('host facts: keyed by QEMU version + DETECTED accelerator; KVM needs no calibration (bug A)', async () => {
  const dir = tmp('host');
  const cacheFile = path.join(dir, 'host.json');
  const orig = platform.detectAccel;
  const calls = [];
  const calibrate = async (o) => { calls.push(o.accel); return 2298672; };
  try {
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q 10.2', accel: 'whpx', tscKhz: 2300000 }, 'Q 10.2', 'whpx'), true);
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q 10.2', accel: 'whpx', tscKhz: null }, 'Q 10.2', 'whpx'), false, 'WHPX needs a TSC frequency');
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q 10.1', accel: 'whpx', tscKhz: 1 }, 'Q 10.2', 'whpx'), false, 'another QEMU');
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q 10.2', accel: 'whpx', tscKhz: 1 }, 'Q 10.2', 'tcg'), false, 'another accelerator');
    assert.strictEqual(plan.hostFactsValid({ version: 1, accel: 'whpx', tscKhz: 1 }, null, 'whpx'), false, 'the prototype format is never trusted');
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q', accel: 'tcg', tscKhz: null }, 'Q', 'tcg'), false, 'TCG facts from before the TSC was measured for TCG');
    assert.strictEqual(plan.hostFactsValid({ version: 2, qemuVersion: 'Q', accel: 'tcg', tscKhz: null, tscTried: true }, 'Q', 'tcg'), true, 'a failed TCG measurement is not repeated');
    // the accelerator comes from platform.detectAccel, even on Windows
    platform.detectAccel = async () => ({ available: ['kvm', 'tcg'], recommended: 'kvm' });
    const fakeQemu = process.execPath; // answers --version; has no machine list
    const k = await plan.hostDefaults({ kernelDir: dir, manifest: {}, qemu: fakeQemu, cacheFile, calibrate });
    assert.strictEqual(k.accel, 'kvm');
    assert.strictEqual(k.tscKhz, null, 'no calibration boot under KVM (kvmclock)');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(k.version, plan.HOST_FACTS_VERSION);
    assert.strictEqual(k.qemuVersion, plan.qemuVersionOf(fakeQemu));
    const again = await plan.hostDefaults({ kernelDir: dir, manifest: {}, qemu: fakeQemu, cacheFile, calibrate });
    assert.strictEqual(again.createdAt, k.createdAt, 'cached');
  } finally {
    platform.detectAccel = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Found in the integration E2E: microvm under TCG on a busy host hung for
// good in calibrate_delay (18/24 boots with 8 in parallel) because the PIT
// was its only TSC reference; with tsc_early_khz 0/24. And a TCG run used to
// overwrite the WHPX facts in host.json, so the next WHPX start re-calibrated.
test('host facts under TCG: a TSC frequency (reused from the hardware facts, else measured), kept apart from the WHPX facts', async () => {
  const dir = tmp('host-tcg');
  const orig = platform.detectAccel;
  const origCfg = CFG.hostFactsFile;
  const calls = [];
  const calibrate = async (o) => { calls.push(o.accel); return o.accel === 'tcg' ? 2298600 : 2298672; };
  const fakeQemu = process.execPath;
  try {
    CFG.hostFactsFile = path.join(dir, 'host.json');
    assert.strictEqual(plan.hostFactsFileFor('tcg', 'whpx'), path.join(dir, 'host-tcg.json'));
    assert.strictEqual(plan.hostFactsFileFor('whpx', 'whpx'), path.join(dir, 'host.json'));
    assert.strictEqual(plan.hostFactsFileFor('tcg', 'tcg'), path.join(dir, 'host.json'), 'TCG is the primary accelerator without hardware acceleration');
    // a PC with WHPX: the WHPX facts are measured once; a TCG run reuses their TSC
    platform.detectAccel = async () => ({ available: ['whpx', 'tcg'], recommended: 'whpx' });
    const hw = { version: plan.HOST_FACTS_VERSION, qemuVersion: plan.qemuVersionOf(fakeQemu), accel: 'whpx', cpuModel: 'qemu64,+ssse3', tscKhz: 2298672, features: { ssse3: true }, machines: [] };
    fs.writeFileSync(CFG.hostFactsFile, JSON.stringify(hw));
    const t = await plan.hostDefaults({ kernelDir: dir, manifest: {}, qemu: fakeQemu, accel: 'tcg', calibrate });
    assert.strictEqual(t.accel, 'tcg');
    assert.strictEqual(t.tscKhz, 2298672, 'the host TSC rate (a TCG guest TSC runs at it)');
    assert.match(t.tscSource, /measured under whpx/);
    assert.deepStrictEqual(calls, [], 'no boot needed');
    assert.strictEqual(plan.readHostFacts(CFG.hostFactsFile).accel, 'whpx', 'the WHPX facts are untouched');
    assert.strictEqual(plan.readHostFacts(path.join(dir, 'host-tcg.json')).tscKhz, 2298672);
    // a PC without hardware acceleration: one q35 boot under TCG measures it
    fs.rmSync(CFG.hostFactsFile, { force: true });
    platform.detectAccel = async () => ({ available: ['tcg'], recommended: 'tcg' });
    const [a, b] = await Promise.all([
      plan.hostDefaults({ kernelDir: dir, manifest: {}, qemu: fakeQemu, calibrate }),
      plan.hostDefaults({ kernelDir: dir, manifest: {}, qemu: fakeQemu, calibrate }),
    ]);
    assert.deepStrictEqual(calls, ['tcg'], 'two concurrent starts share one calibration boot');
    assert.strictEqual(a.tscKhz, 2298600);
    assert.strictEqual(b.tscKhz, 2298600);
    assert.strictEqual(a.tscTried, true);
    // the TCG command line then carries tsc_early_khz on microvm
    const qa = require('../lib/microvm/qemu-args');
    assert.ok(qa.kernelAppend({ tscKhz: a.tscKhz }).includes('tsc_early_khz=2298600'));
  } finally {
    platform.detectAccel = orig;
    CFG.hostFactsFile = origCfg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
