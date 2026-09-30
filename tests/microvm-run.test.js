'use strict';
/*
 * The microVM engine's building blocks (lib/microvm/run.js) without QEMU: a
 * node child stands in for a VM by writing the files QEMU would write, fake
 * console/monitor servers receive stop requests, a local image cache and a
 * fake kernel feed prepareImage. Covers bug V9 (QEMU's informational lines
 * are not errors), V10 (flatten warnings reach the task log), V3 (fresh
 * private endpoints per start, retry on a bind race) and B (no fixed paths).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { useTempRoot, resetConfig, rm } = require('./helpers');
const { CFG } = require('../lib/config');
const platform = require('../lib/platform');
const run = require('../lib/microvm/run');
const images = require('../lib/oci/images');
const ociCpio = require('../lib/oci/cpio');
const { tarBuffer, putLocalImage } = require('./oci-mkimage');

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-run-')); });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const quietT = () => { const lines = []; return { lines, log: (m) => lines.push(m), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARN ' + m) }; };

function fakeRun(name, script) {
  const runDir = path.join(tmp, name);
  fs.mkdirSync(runDir, { recursive: true });
  const logs = { console: path.join(runDir, 'console.log'), stdout: path.join(runDir, 'stdout.log'), stderr: path.join(runDir, 'stderr.log'), qemu: path.join(runDir, 'qemu.log') };
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(logs)], { stdio: 'ignore', windowsHide: true });
  const rt = { pid: child.pid, startedAt: new Date().toISOString(), logs, console: null, monitor: null };
  return { rt, child, runDir };
}

const VM_SCRIPT = `
const fs = require('fs');
const L = JSON.parse(process.argv[1]);
const w = (f, s) => fs.appendFileSync(f, s);
fs.writeFileSync(L.qemu, 'qemu-system-x86_64: info: Windows Hypervisor Platform accelerator is operational\\n');
const steps = [
  [30, () => w(L.console, '[ 0.1] kernel noise\\n__DEVBOX_INIT uptime=0.21\\n')],
  [60, () => w(L.console, '__DEVBOX_READY\\n')],
  [80, () => { w(L.stdout, 'hello '); w(L.stderr, 'oops\\n'); }],
  [100, () => w(L.stdout, 'world\\n')],
  [130, () => w(L.console, '__DEVBOX_EXIT=7\\n[ 0.9] reboot: Power down\\n')],
  [400, () => process.exit(0)],
];
for (const [ms, f] of steps) setTimeout(f, ms);
`;

test('watch: markers, output streams and the exit status from the files QEMU writes', async () => {
  const { rt } = fakeRun('vm1', VM_SCRIPT);
  const out = [], err = [], markers = [];
  const h = run.watch(rt, { pollMs: 20, onStdout: (b) => out.push(b), onStderr: (b) => err.push(b), onMarker: (m) => markers.push(m) });
  const r = await h.exited;
  assert.strictEqual(r.exitCode, 7);
  assert.strictEqual(r.clean, true);
  assert.deepStrictEqual(markers, ['INIT', 'READY', 'EXIT']);
  assert.strictEqual(Buffer.concat(out).toString(), 'hello world\n');
  assert.strictEqual(Buffer.concat(err).toString(), 'oops\n');
  assert.strictEqual(h.markers.INIT, true);
  assert.ok(h.marks.INIT <= h.marks.READY && h.marks.READY <= h.marks.EXIT);
  assert.strictEqual(r.qemu.code, null, 'WHPX\'s "accelerator is operational" is not an error (bug V9)');
  assert.strictEqual(run.readExit(path.dirname(rt.logs.console)).exitCode, 7);
});

test('watch: no exit marker -> 125 with the reason; a custom liveness check is used', async () => {
  const { rt } = fakeRun('vm2', `
    const fs = require('fs'); const L = JSON.parse(process.argv[1]);
    fs.writeFileSync(L.qemu, 'qemu-system-x86_64: info: Windows Hypervisor Platform accelerator is operational\\n');
    fs.writeFileSync(L.console, 'Kernel panic - not syncing: VFS\\n');
    setTimeout(() => process.exit(1), 50);`);
  let asked = 0;
  const h = run.watch(rt, { pollMs: 20, isAlive: async () => { asked++; return platform.pidAlive(rt.pid); } });
  const r = await h.exited;
  assert.ok(asked > 0);
  assert.strictEqual(r.exitCode, 125);
  assert.strictEqual(r.clean, false);
  assert.match(r.reason, /kernel panic/);
  // a forged, over-long marker line is capped, not trusted as a path or command
  const { rt: rt3 } = fakeRun('vm3', `
    const fs = require('fs'); const L = JSON.parse(process.argv[1]);
    fs.writeFileSync(L.console, '__DEVBOX_EXIT=' + 'x'.repeat(10000) + '\\n__DEVBOX_EXIT=3\\n');
    setTimeout(() => process.exit(0), 50);`);
  const r3 = await run.watch(rt3, { pollMs: 20 }).exited;
  assert.strictEqual(r3.exitCode, 3);
});

test('qemuLogErrors: informational lines dropped, whole lines, known failures named (bug V9)', () => {
  const e = run.qemuLogErrors('qemu-system-x86_64: info: Windows Hypervisor Platform accelerator is operational\r\n');
  assert.deepStrictEqual([e.code, e.message, e.lines], [null, null, []]);
  assert.strictEqual(run.qemuLogErrors('qemu-system-x86_64: -chardev socket,id=mon0,host=127.1.2.3,port=5,server=on,wait=off: Failed to find an available port: Address already in use\nWindows Hypervisor Platform accelerator is operational\n').code, 'CONTROL_PORT');
  assert.strictEqual(run.qemuLogErrors("qemu-system-x86_64: -netdev user,id=n0,hostfwd=tcp:127.0.0.1:8080-:80: Could not set up host forwarding rule 'tcp:127.0.0.1:8080-:80'\n").code, 'PORT_IN_USE');
  assert.strictEqual(run.qemuLogErrors('qemu-system-x86_64: -initrd x.initrd: could not load initial ram disk\nqemu: could not open x: No such file or directory\n').code, 'FILE');
  assert.strictEqual(run.qemuLogErrors('WHPX: Unexpected VP exit code 4\n').code, 'ACCEL');
  const o = run.qemuLogErrors('something odd\nlast words\n');
  assert.deepStrictEqual([o.code, o.message], ['OTHER', 'last words']);
});

test('requestStop: "__DEVBOX_STOP <timeout>" (or KILL) on the console; ACPI through HMP; null when nothing answers', async () => {
  const got = [];
  const con = net.createServer((s) => s.on('data', (d) => got.push(d.toString())));
  await new Promise((r) => con.listen(0, '127.0.0.1', r));
  // a fake HMP monitor: banner prompt, then one reply per command
  const cmds = [];
  const mon = net.createServer((s) => {
    s.write('QEMU 10.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
    s.on('data', (d) => { cmds.push(d.toString().trim()); s.write(d.toString().trim() + '\r\n(qemu) '); });
  });
  await new Promise((r) => mon.listen(0, '127.0.0.1', r));
  try {
    const rt = { console: { host: '127.0.0.1', port: con.address().port }, monitor: { host: '127.0.0.1', port: mon.address().port } };
    assert.strictEqual(await run.requestStop(rt, { timeoutS: 7 }), 'console');
    assert.strictEqual(await run.requestStop(rt, { force: true }), 'console');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(got.join(''), '__DEVBOX_STOP 7\n__DEVBOX_KILL KILL\n');
    // console unreachable: the ACPI power button through the monitor
    const acpi = await run.requestStop({ console: { host: '127.0.0.1', port: 1 }, monitor: rt.monitor });
    assert.strictEqual(acpi, 'acpi');
    assert.deepStrictEqual(cmds, ['system_powerdown']);
  } finally { con.close(); mon.close(); }
  assert.strictEqual(await run.requestStop({ console: { host: '127.0.0.1', port: 1 }, monitor: null }), null);
});

test('forceStop: a pid that is not QEMU is never killed', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.strictEqual(await run.forceStop({ pid: 999999999, monitor: null }), 'already-gone');
    const r = await run.forceStop({ pid: child.pid, monitor: null });
    assert.strictEqual(r, 'failed');
    assert.strictEqual(platform.pidAlive(child.pid), true, 'node is not QEMU: left alone');
  } finally { child.kill(); }
});

test('urlsFor, imageBaseName, rotateLogs', () => {
  const u = run.urlsFor([
    { proto: 'tcp', hostPort: 8080, guestPort: 80, lan: false },
    { proto: 'tcp', hostPort: 8443, guestPort: 443, lan: true },
    { proto: 'udp', hostPort: 53, guestPort: 53, lan: false },
  ]);
  assert.strictEqual(u.length, 2, 'only tcp gets URLs');
  assert.deepStrictEqual(u[0], { url: 'http://127.0.0.1:8080/', hostPort: 8080, containerPort: 80, lan: false });
  assert.strictEqual(u[1].url, 'http://127.0.0.1:8443/');
  assert.ok(Array.isArray(u[1].lanUrls));
  assert.strictEqual(run.imageBaseName('nginxinc/nginx-unprivileged:alpine'), 'nginx-unprivileged');
  assert.strictEqual(run.imageBaseName('ghcr.io/o/app@sha256:' + 'a'.repeat(64)), 'app');
  const d = path.join(tmp, 'rot');
  fs.mkdirSync(d);
  for (const n of ['stdout', 'stderr', 'console']) fs.writeFileSync(path.join(d, n + '.log'), n + '-1');
  fs.writeFileSync(path.join(d, 'stdout.prev.log'), 'older');
  run.rotateLogs(d);
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['console.prev.log', 'stderr.prev.log', 'stdout.prev.log']);
  assert.strictEqual(fs.readFileSync(path.join(d, 'stdout.prev.log'), 'utf8'), 'stdout-1', 'one generation kept');
});

test('run.js holds no fixed data or QEMU paths (bug B)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'microvm', 'run.js'), 'utf8');
  assert.ok(!/[A-Z]:\/(Developments|Program Files)/i.test(src), 'no hard-coded Windows paths');
  assert.ok(!/process\.env\./.test(src), 'no environment lookups');
  assert.ok(!/1940\d|1949\d/.test(src), 'no fixed control-port range');
});

// ---------------------------------------------------------------------------
// prepareImage against a local image cache and a fake kernel (CFG temp root)
// ---------------------------------------------------------------------------
function fakeKernel() {
  const dir = path.join(CFG.kernelDir, '1.0.0-0-virt');
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'busybox.static'), 'BB');
  fs.writeFileSync(path.join(dir, 'vmlinuz-virt'), 'K');
  fs.writeFileSync(path.join(dir, 'modules', 'virtio_net.ko'), 'KO');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kver: '1.0.0-0-virt', modules: { virtio_net: { file: 'modules/virtio_net.ko' } }, features: { net: ['virtio_net'] }, sha256: { 'busybox.static': 'x' } }));
  return dir;
}

test('prepareImage: flatten warnings reach the task log once (bug V10); the rootfs archive is transient; index updated', async () => {
  const root = useTempRoot('prep');
  try {
    const t0 = quietT();
    await assert.rejects(run.prepareImage('vwarn', { pull: 'never', t: t0 }), (e) => e.code === 'NO_KERNEL' && e.status === 409);
    fakeKernel();
    fs.mkdirSync(CFG.imagesDir, { recursive: true });
    fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), '{}');
    // a dangling hard link: flattening skips it with a warning
    putLocalImage(CFG.imagesDir, 'vwarn', { layers: [{ tar: tarBuffer([{ path: 'app', type: 'file', data: 'x' }, { path: 'lost', type: 'hardlink', linkpath: 'nowhere' }]) }], config: { Cmd: ['/app'] } });
    const t = quietT();
    const p = await run.prepareImage('vwarn', { pull: 'never', t });
    assert.ok(p.warnings.some((w) => /hardlink lost -> nowhere/.test(w)), JSON.stringify(p.warnings));
    assert.ok(t.lines.some((l) => /^WARN image: .*hardlink lost -> nowhere/.test(l)), t.lines.join('\n'));
    assert.deepStrictEqual(p.runtime.argv, ['/app']);
    assert.ok(fs.existsSync(p.initrd) && p.initrdBytes === fs.statSync(p.initrd).size);
    assert.strictEqual(path.dirname(p.initrd), path.join(CFG.imagesDir, 'initrd'), 'under the data root (bug B)');
    const rp = ociCpio.rootfsPaths(CFG.imagesDir, p.configDigest);
    assert.ok(!fs.existsSync(rp.archive), 'the rootfs archive is deleted once the initrd holds it');
    assert.ok(fs.existsSync(rp.meta), 'its sidecar stays');
    const idx = images.readIndex().images[p.configDigest];
    assert.deepStrictEqual(idx.references, ['docker.io/library/vwarn:latest']);
    assert.ok(idx.lastUsed && idx.initrd.key === p.initrdKey && idx.warnings === 1);
    // warm: the cached initrd, no second flatten, warnings not logged again
    const t2 = quietT();
    const q = await run.prepareImage('vwarn', { pull: 'never', t: t2 });
    assert.deepStrictEqual([q.cached.initrd, q.initrd], [true, p.initrd]);
    assert.ok(!t2.lines.some((l) => /^WARN/.test(l)), t2.lines.join('\n'));
    assert.ok(!fs.existsSync(rp.archive));
    // concurrent runs of the same image build once (image lock)
    fs.rmSync(p.initrd);
    const rs = await Promise.all([0, 1, 2].map(() => run.prepareImage('vwarn', { pull: 'never' })));
    assert.strictEqual(rs.filter((r) => !r.cached.initrd).length, 1, 'one build, two cache hits');
    // an aborted signal stops before any work
    const ac = new AbortController(); ac.abort();
    await assert.rejects(run.prepareImage('vwarn', { pull: 'never', signal: ac.signal }), (e) => e.code === 'ABORTED');
  } finally { resetConfig(); rm(root); }
});

// ---------------------------------------------------------------------------
// launch with a stand-in for QEMU
// ---------------------------------------------------------------------------
test('launch: fresh private endpoints per attempt, retry on a control-port race, PORT_CONFLICT for a taken published port (bug V3)', async () => {
  const root = useTempRoot('launch');
  const orig = platform.findTool;
  platform.findTool = (n) => (n === 'qemu' ? path.join(root, 'fake-qemu') : orig(n));
  try {
    const kdir = fakeKernel();
    const prep = { kernelDir: kdir, manifest: JSON.parse(fs.readFileSync(path.join(kdir, 'manifest.json'), 'utf8')), initrd: path.join(root, 'x.initrd') };
    fs.writeFileSync(prep.initrd, Buffer.alloc(1024));
    const plan = require('../lib/microvm/plan');
    const spec = plan.buildSpec({ cmd: ['/app'] }, {});
    const seen = [];
    // attempts 1-2: QEMU "fails to bind" a control socket; attempt 3 runs
    const fakeSpawn = (qemu, args, qemuLog) => {
      seen.push(args);
      const fail = seen.length < 3;
      const script = fail
        ? "require('fs').writeFileSync(process.argv[1], 'qemu-system-x86_64: -chardev socket,id=con0: Failed to find an available port: Address already in use\\n'); process.exit(1)"
        : "require('fs').writeFileSync(process.argv[1], 'Windows Hypervisor Platform accelerator is operational\\n'); setTimeout(() => {}, 3000)";
      return spawn(process.execPath, ['-e', script, qemuLog], { stdio: 'ignore', windowsHide: true });
    };
    const t = quietT();
    const runDir = path.join(CFG.microvmsDir, 'abcdef012345');
    const rt = await run.launch({ id: 'abcdef012345', runDir, prep, host: { machines: ['microvm', 'q35'] }, spec, accel: 'tcg', t, spawnFn: fakeSpawn, earlyExitMs: 600 });
    try {
      assert.strictEqual(seen.length, 3);
      assert.ok(t.lines.filter((l) => /control port was busy/.test(l)).length === 2, t.lines.join('\n'));
      const chardevs = seen.map((a) => a[a.indexOf('-chardev') + 1]);
      assert.strictEqual(new Set(chardevs).size, 3, 'new endpoints for every attempt');
      if (platform.IS_WIN) assert.ok(chardevs.every((c) => /host=127\.\d+\.\d+\.\d+,port=\d+/.test(c) && !/host=127\.0\.0\.1,/.test(c)), 'a private loopback, never 127.0.0.1');
      assert.deepStrictEqual([rt.accel, rt.machine, rt.pid > 0], ['tcg', 'microvm', true]);
      assert.ok(seen[2].includes(path.join(runDir, 'qemu.pid')), '-pidfile in the run directory');
      assert.ok(rt.console && rt.monitor);
    } finally { try { rt.child.kill(); } catch (e) { /* gone */ } }
    // a published port another program holds: PORT_CONFLICT, no retry
    const busy = (qemu, args, qemuLog) => spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], \"qemu-system-x86_64: -netdev user,id=n0,hostfwd=tcp:127.0.0.1:8080-:80: Could not set up host forwarding rule 'tcp:127.0.0.1:8080-:80'\\n\"); process.exit(1)", qemuLog], { stdio: 'ignore', windowsHide: true });
    await assert.rejects(run.launch({ id: 'abcdef012346', runDir: path.join(CFG.microvmsDir, 'abcdef012346'), prep, spec, accel: 'tcg', spawnFn: busy, ports: [{ hostPort: 8080, guestPort: 80 }] }),
      (e) => e.code === 'PORT_CONFLICT' && e.status === 409);
  } finally {
    platform.findTool = orig;
    resetConfig();
    rm(root);
  }
});
