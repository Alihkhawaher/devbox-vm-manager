'use strict';
/*
 * Real microVM boots: QEMU + the prepared kernel assets (read only) + a tiny
 * root filesystem, through the same pieces the engine uses (plan.js,
 * qemu-args.js, the init archive from lib/oci/cpio, vmrun.startVm) and the
 * app's private control endpoints (vm.runtimeEndpoints). Opt-in (~1 min):
 *   DEVBOX_BOOT_TESTS=1 node --test tests/microvm-boot.test.js
 * Optional: DEVBOX_KERNEL_DIR (default: the newest kernel under data/kernel),
 * DEVBOX_MACHINE (microvm|q35), DEVBOX_ACCEL (whpx|tcg|kvm; default: detected).
 * Ports: OS-assigned only. No downloads.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const platform = require('../lib/platform');
const kernel = require('../lib/microvm/kernel');
const plan = require('../lib/microvm/plan');
const mkext4 = require('../lib/microvm/mkext4');
const { startVm } = require('../lib/microvm/vmrun');
const { CpioWriter } = require('../lib/oci/cpio');

const KDIR = process.env.DEVBOX_KERNEL_DIR || kernel.findKernelDir(path.join(__dirname, '..', 'data', 'kernel'));
const QEMU = platform.findTool('qemu');
const MACHINE = process.env.DEVBOX_MACHINE || 'microvm';
const skip = process.env.DEVBOX_BOOT_TESTS !== '1' ? 'set DEVBOX_BOOT_TESTS=1 to boot VMs'
  : !QEMU ? 'QEMU not found' : !(KDIR && fs.existsSync(path.join(KDIR, 'manifest.json'))) ? 'no kernel assets' : false;

const APPLETS = ['sh', 'id', 'cat', 'ls', 'grep', 'sleep', 'wget', 'nc', 'printf', 'mkdir', 'wc', 'hostname', 'env', 'true'];
async function tinyRootfs() {
  const w = new CpioWriter(null, { autoParents: true, mtime: 0 });
  for (const a of APPLETS) await w.symlink('bin/' + a, '/.devbox/busybox');
  await w.dir('home', 0o755);
  await w.dir('home/app', 0o755, { uid: 1000, gid: 1000 });
  await w.dir('tmp', 0o1777);
  await w.file('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000:app:/home/app:/bin/sh\n', 0o644);
  await w.file('etc/group', 'root:x:0:\napp:x:1000:\n', 0o644);
  await w.file('home/app/seed.txt', 'from-image\n', 0o644, { uid: 1000, gid: 1000 });
  await w.finish();
  return w.toBuffer();
}

let ctx;
test.before(async () => {
  if (skip) return;
  const accel = process.env.DEVBOX_ACCEL || (await platform.detectAccel(QEMU)).recommended || 'tcg';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-boot-'));
  const manifest = kernel.loadManifest(KDIR);
  const rootfs = path.join(work, 'tiny.cpio');
  fs.writeFileSync(rootfs, await tinyRootfs());
  const ir = await plan.ensureImageInitrd({ configDigest: 'sha256:' + 'b007'.repeat(16), rootfsCpio: rootfs, kernelDir: KDIR, manifest, cacheDir: path.join(work, 'cache') });
  const host = await plan.hostDefaults({ kernelDir: KDIR, manifest, qemu: QEMU, accel, cacheFile: path.join(work, 'host.json') });
  ctx = { work, manifest, initrd: ir.file, host, accel, n: 0 };
});
test.after(() => { if (ctx) fs.rmSync(ctx.work, { recursive: true, force: true }); });

async function boot(run, o) {
  o = o || {};
  const runDir = path.join(ctx.work, 'run' + (++ctx.n));
  const ep = await require('../lib/vm').runtimeEndpoints('boot-test-' + ctx.n);
  const spec = plan.buildSpec({ env: ['PATH=/bin'] }, run);
  const p = plan.planRun({
    kernelDir: KDIR, manifest: ctx.manifest, initrd: ctx.initrd, runDir, spec, machine: MACHINE, accel: ctx.accel,
    cpuModel: ctx.host.cpuModel, tscKhz: ctx.host.tscKhz, console: ep.serial, monitor: ep.monitor, ports: o.ports, volumes: o.volumes,
  });
  const ref = {};
  const h = await startVm({ qemu: QEMU, args: p.args, console: ep.serial, timeoutMs: 90000, onMarker: o.onMarker && ((m) => o.onMarker(m, ref.h)) });
  ref.h = h;
  if (o.during) await o.during(h);
  const r = await h.done;
  const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return Object.assign(r, { stdout: rd(p.logs.stdout), stderr: rd(p.logs.stderr), consoleLog: rd(p.logs.console) });
}

test('exit code, argv/env quoting, stdout vs stderr, user, workdir, hostname', { skip }, async () => {
  const r = await boot({
    entrypoint: ['sh', '-c', 'printf "%s|" "$@"; echo; echo "X=$X"; id -u; id -g; echo "$PWD"; hostname; echo oops >&2; exit 7', 'argv0'],
    cmd: ["it's", 'a b', '$HOME'], env: { X: 'q"uo`te' }, user: 'app', workdir: '/home/app/w', hostname: 'bt', net: false,
  });
  assert.strictEqual(r.exitCode, 7, r.consoleLog);
  assert.strictEqual(plan.parseConsole(r.consoleLog).exitCode, 7, 'the logfile carries the exit marker too');
  assert.strictEqual(r.stdout, "it's|a b|$HOME|\nX=q\"uo`te\n1000\n1000\n/home/app/w\nbt\n");
  assert.strictEqual(r.stderr, 'oops\n');
  assert.strictEqual(r.qemuCode, 0);
});

test('command not found -> 127; unknown user -> 126 before anything runs', { skip }, async () => {
  assert.strictEqual((await boot({ cmd: ['/no/such'], net: false })).exitCode, 127);
  const r = await boot({ cmd: ['true'], user: 'ghost', net: false });
  assert.strictEqual(r.exitCode, 126);
  assert.match(r.consoleLog, /unable to find user ghost/);
});

test('graceful stop over the console: trap runs; ignored TERM -> SIGKILL after the timeout', { skip }, async () => {
  const stopOnReady = (m, h) => { if (m === 'READY') setTimeout(() => h.stop(), 500); };
  const a = await boot({ cmd: ['sh', '-c', 'trap "echo bye; exit 3" TERM; while true; do sleep 0.1; done'], net: false }, { onMarker: stopOnReady });
  assert.strictEqual(a.exitCode, 3);
  assert.strictEqual(a.stdout, 'bye\n');
  const b = await boot({ cmd: ['sh', '-c', 'trap "" TERM; while true; do sleep 0.1; done'], net: false, stopTimeout: 1 }, { onMarker: stopOnReady });
  assert.strictEqual(b.exitCode, 137);
});

test('network: guest reaches the host, host reaches the guest through hostfwd', { skip }, async () => {
  const srv = http.createServer((q, s) => s.end('host-says-hi'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const hostPort = await platform.freeLocalPort('127.0.0.1');
  let fwd = null;
  try {
    const r = await boot({ cmd: ['sh', '-c', 'wget -qO- http://10.0.2.2:' + srv.address().port + '/; echo; printf "HTTP/1.0 200 OK\\r\\n\\r\\nguest-says-hi" | nc -l -p 8080 >/dev/null'] }, {
      ports: [{ hostPort, guestPort: 8080 }],
      during: async () => {
        for (let i = 0; i < 400 && !fwd; i++) {
          fwd = await new Promise((res) => {
            http.get('http://127.0.0.1:' + hostPort + '/', (s) => { let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => res(b)); }).on('error', () => res(null));
          });
          if (!fwd) await new Promise((s) => setTimeout(s, 50));
        }
      },
    });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout.trim(), 'host-says-hi');
    assert.strictEqual(fwd, 'guest-says-hi');
  } finally { srv.close(); }
});

test('volume: persists across boots, no lost+found, copy-up of image content and owner', { skip }, async () => {
  const vol = path.join(ctx.work, 'home.qcow2');
  mkext4.createQcow2(vol, 256 * 1024 * 1024, { label: 'home' });
  const run = (cmd) => boot({ cmd: ['sh', '-c', cmd], user: 'app', net: false, volumes: [{ target: '/home/app' }] }, { volumes: [{ file: vol }] });
  const a = await run('ls -A /home/app; cat /home/app/seed.txt; echo persisted > /home/app/new.txt; id -u');
  assert.strictEqual(a.exitCode, 0, a.consoleLog);
  assert.strictEqual(a.stdout, 'seed.txt\nfrom-image\n1000\n');
  const b = await run('ls -A /home/app | wc -l; cat /home/app/new.txt');
  assert.strictEqual(b.stdout.replace(/[ \t]+/g, ''), '2\npersisted\n');
});
