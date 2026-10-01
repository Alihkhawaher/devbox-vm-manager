'use strict';
/*
 * lib/install.js: source discovery with fixtures shaped like the real mirror
 * listings of 2026-09 (Alpine renamed its images after 3.23.4 and in 3.24;
 * QEMU publishes "<name>.sha512" without ".exe"), the cloud-init seed (unique
 * instance-id, rc marker, tzdata; its shell snippets checked by a real sh),
 * the bake's QEMU arguments, the incremental log watcher, the seed server,
 * prerequisites, the validation rules (refuse a rebuild under clones), the
 * hint for a PC without hardware acceleration (nested virtualization in the
 * outer hypervisor) and the light profile's Alpine-download policy.
 * Nothing is downloaded; QEMU only runs in the tests marked "real QEMU".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { CFG } = require('../lib/config');
const platform = require('../lib/platform');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const install = require('../lib/install');
const { sleep } = require('../lib/util');
const { useTempRoot, resetConfig, rm } = require('./helpers');

let SH = null;
for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) { if (fs.existsSync(c)) { SH = c; break; } }

const a = (f) => '<a href="' + f + '">' + f + '</a> 2026-09-01 10:00  176M\n';
const INDEX = ['../', 'edge/', 'latest-stable/', 'v3.9/', 'v3.10/', 'v3.2/', 'v3.24/', 'v3.23/', 'v3.22/', 'MIRRORS.txt'].map(a).join('');
const V324 = [
  'alpine-3.24.2-x86_64-cloudinit-r0.qcow2', 'alpine-3.24.2-x86_64-cloudinit-r0.qcow2.sha512',
  'alpine-3.24.2-x86_64-cloudinit-metal-r0.qcow2', 'generic_alpine-3.24.1-x86_64-bios-cloudinit-r0.qcow2',
  'generic_alpine-3.24.1-x86_64-uefi-cloudinit-r0.qcow2', 'alpine-3.24.2-x86_64-tiny-r0.qcow2',
].map(a).join('');
const V323 = [
  'alpine-3.23.6-x86_64-bios-cloudinit-r0.qcow2', 'generic_alpine-3.23.5-x86_64-bios-cloudinit-r0.qcow2',
  'nocloud_alpine-3.23.3-x86_64-bios-cloudinit-r0.qcow2', 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2',
  'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2.asc', 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2.sha512',
  'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-metal-r0.qcow2', 'nocloud_alpine-3.23.4-x86_64-uefi-cloudinit-r0.qcow2',
  'oci_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2', 'nocloud_alpine-3.23.4-x86_64-bios-tiny-r0.qcow2',
].map(a).join('');
const V322 = ['nocloud_alpine-3.22.4-x86_64-bios-cloudinit-r0.qcow2', 'nocloud_alpine-3.22.10-x86_64-bios-cloudinit-r0.qcow2'].map(a).join('');

function fakeT() {
  const lines = [];
  return { id: 'test', lines: lines, log: (m) => lines.push(String(m)), step: (m) => lines.push(String(m)), warn: (m) => lines.push('WARNING: ' + m) };
}

test('parseAlpineBranches: every vX.Y from the index, newest first by NUMBER (v3.10 > v3.9)', () => {
  assert.deepEqual(install.parseAlpineBranches(INDEX), ['v3.24', 'v3.23', 'v3.22', 'v3.10', 'v3.9', 'v3.2']);
  assert.deepEqual(install.parseAlpineBranches(''), []);
});

test('parseAlpineCloudImages: x86_64 cloud-init images only, with flavour/boot/metal; other clouds and sidecars skipped', () => {
  const v323 = install.parseAlpineCloudImages(V323);
  const files = v323.map((i) => i.file);
  assert.ok(files.includes('nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2'));
  assert.ok(files.includes('alpine-3.23.6-x86_64-bios-cloudinit-r0.qcow2'));
  assert.ok(!files.some((f) => /^oci_|\.sha512$|\.asc$|tiny/.test(f)), files.join(' '));
  assert.equal(new Set(files).size, files.length, 'no duplicates (href + link text)');
  const n = v323.find((i) => i.file === 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2');
  assert.deepEqual([n.flavor, n.version, n.rev, n.boot, n.metal], ['nocloud', [3, 23, 4], 0, 'bios', false]);
  assert.equal(v323.find((i) => /metal/.test(i.file)).metal, true);
  const v324 = install.parseAlpineCloudImages(V324);
  const plain = v324.find((i) => i.file === 'alpine-3.24.2-x86_64-cloudinit-r0.qcow2');
  assert.deepEqual([plain.flavor, plain.boot], ['plain', 'any']);
});

test('chooseAlpineImage: newest nocloud_ BIOS image across branches (numeric versions); others only as an unverified fallback', () => {
  const all = [].concat(
    install.parseAlpineCloudImages(V324).map((i) => Object.assign(i, { branch: 'v3.24' })),
    install.parseAlpineCloudImages(V323).map((i) => Object.assign(i, { branch: 'v3.23' })),
    install.parseAlpineCloudImages(V322).map((i) => Object.assign(i, { branch: 'v3.22' })));
  const pick = install.chooseAlpineImage(all);
  assert.equal(pick.file, 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2');
  assert.equal(pick.verified, true);
  // 3.22.10 > 3.22.4 numerically
  assert.equal(install.chooseAlpineImage(install.parseAlpineCloudImages(V322)).file, 'nocloud_alpine-3.22.10-x86_64-bios-cloudinit-r0.qcow2');
  // a branch without nocloud_ images: the newest BIOS-capable one, flagged unverified (never metal/uefi)
  const only324 = install.chooseAlpineImage(install.parseAlpineCloudImages(V324));
  assert.equal(only324.file, 'alpine-3.24.2-x86_64-cloudinit-r0.qcow2');
  assert.equal(only324.verified, false);
  assert.equal(install.chooseAlpineImage([]), null);
});

test('pickQemuInstaller: newest build, year folder, sha512 sidecar without ".exe"', () => {
  const html = ['2025/', 'qemu-w64-setup-20251224.exe', 'qemu-w64-setup-20260805.exe', 'qemu-w64-setup-20260811.exe', 'qemu-w64-setup-20260729.exe'].map(a).join('');
  assert.deepEqual(install.pickQemuInstaller(html), {
    file: 'qemu-w64-setup-20260811.exe', date: '20260811',
    url: 'https://qemu.weilnetz.de/w64/2026/qemu-w64-setup-20260811.exe',
    sha512Url: 'https://qemu.weilnetz.de/w64/2026/qemu-w64-setup-20260811.sha512',
  });
  assert.equal(install.pickQemuInstaller('<html>nothing</html>'), null);
});

// ---------------------------------------------------------------------------
// the seed
// ---------------------------------------------------------------------------
function withKeyRoot(label, fn) {
  return async () => {
    const root = useTempRoot(label);
    tasks._reset();
    st.loadState();
    try {
      fs.mkdirSync(CFG.seedDir, { recursive: true });
      fs.writeFileSync(CFG.sshPub, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForTheUnitTestsOnly devbox-vm-manager\n');
      await fn(root);
    } finally {
      for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
      tasks._reset();
      resetConfig();
      rm(root);
    }
  };
}

// The `sh -c` strings of the runcmd list, YAML-unescaped (double-quoted
// scalars folded over several lines).
function runcmdScripts(userData) {
  const out = [];
  const lines = userData.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}- \[ sh, -c, "(.*)$/);
    if (!m) continue;
    let s = m[1];
    while (!/" \]$/.test(s)) s += ' ' + lines[++i].trim();
    out.push(s.replace(/" \]$/, '').replace(/\\(["\\])/g, '$1'));
  }
  return out;
}

test('buildSeed: unique instance-id, the SSH key, tzdata, and an END marker carrying the toolchain status', withKeyRoot('seed', async () => {
  const s1 = install.buildSeed('devbox-a1');
  const s2 = install.buildSeed();
  assert.match(s1.meta, /^instance-id: devbox-a1$/m);
  assert.match(s2.meta, /^instance-id: devbox-\d+/m);
  assert.match(s1.user, /^#cloud-config/);
  assert.ok(s1.user.includes('TestKeyForTheUnitTestsOnly'));
  assert.ok(s1.user.includes(' tzdata'));
  const scripts = runcmdScripts(s1.user);
  assert.equal(scripts.length, 10);
  assert.match(scripts[0], /=== BAKE START ===/);
  // live shared folders: the devbox-shares OpenRC service, byte for byte,
  // enabled in the default runlevel, plus qemu_fw_cfg on the boot module list
  const shareLine = scripts[7];
  const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d > \/etc\/init\.d\/devbox-shares/.exec(shareLine);
  assert.ok(b64, shareLine.slice(0, 200));
  assert.equal(Buffer.from(b64[1], 'base64').toString('utf8'), install.sharesServiceScript());
  assert.match(install.sharesServiceScript(), /^#!\/sbin\/openrc-run\n/);
  assert.ok(!/\r/.test(install.sharesServiceScript()), 'LF line endings');
  assert.match(shareLine, /rc-update add devbox-shares default/);
  assert.match(shareLine, /echo qemu_fw_cfg >> \/etc\/modules/);
  // boot time of every clone: the 10 s SYSLINUX menu wait becomes 1 s,
  // chronyd no longer blocks the boot, dhcpcd skips the ARP probe
  assert.match(scripts[4], /timeout=1\/' \/etc\/update-extlinux\.conf/);
  assert.match(scripts[4], /TIMEOUT 10\/' \/boot\/extlinux\.conf/);
  assert.match(scripts[4], /FAST_STARTUP=yes\/' \/etc\/conf\.d\/chronyd/);
  assert.match(scripts[4], /echo noarp >> \/etc\/dhcpcd\.conf/);
  assert.match(scripts[5], /no_timer_check/);
  assert.match(scripts[6], /apk update .* && apk add --no-cache .*tzdata/);
  assert.match(scripts[6], /echo \$rc > \/root\/\.devbox-bake-rc/);
  assert.match(scripts[9], /echo "=== BAKE END rc=\$rc ===" >> \/dev\/ttyS0/);
  if (SH) for (const s of scripts) execFileSync(SH, ['-n'], { input: s, windowsHide: true });
  if (SH) {
    // the boot tweaks, run for real against copies of the cloud image's files
    // (exactly as found in Alpine's nocloud 3.23 image), twice: idempotent
    const r = path.join(CFG.root, 'guest');
    fs.mkdirSync(path.join(r, 'etc', 'conf.d'), { recursive: true });
    fs.mkdirSync(path.join(r, 'boot'), { recursive: true });
    fs.writeFileSync(path.join(r, 'etc', 'update-extlinux.conf'), 'overwrite=1\ndefault_kernel_opts="console=ttyS0,115200n8 console=ttyAMA0,115200n8"\nhidden=1\ntimeout=10\n');
    fs.writeFileSync(path.join(r, 'boot', 'extlinux.conf'), 'PROMPT 0\nTIMEOUT 100\nLABEL virt\n  LINUX vmlinuz-virt\n  APPEND root=LABEL=/ modules=sd-mod,usb-storage,ext4 console=ttyS0,115200n8 console=ttyAMA0,115200n8\n');
    fs.writeFileSync(path.join(r, 'etc', 'conf.d', 'chronyd'), 'CFGFILE="/etc/chrony/chrony.conf"\nFAST_STARTUP=no\nARGS=""\n');
    fs.writeFileSync(path.join(r, 'etc', 'dhcpcd.conf'), 'duid\npersistent\n');
    const rs = r.replace(/\\/g, '/');
    for (let i = 0; i < 2; i++) {
      for (const s of [scripts[4], scripts[5]]) execFileSync(SH, ['-c', s.split(' /etc/').join(' ' + rs + '/etc/').split(' /boot/').join(' ' + rs + '/boot/')], { windowsHide: true });
    }
    const rd = (f) => fs.readFileSync(path.join(r, f), 'utf8');
    assert.match(rd('etc/update-extlinux.conf'), /^default_kernel_opts="console=ttyS0,115200n8 console=ttyAMA0,115200n8 no_timer_check"$/m);
    assert.match(rd('etc/update-extlinux.conf'), /^timeout=1$/m);
    assert.match(rd('boot/extlinux.conf'), /^ {2}APPEND root=LABEL=\/ .* console=ttyAMA0,115200n8 no_timer_check$/m);
    assert.match(rd('boot/extlinux.conf'), /^TIMEOUT 10$/m);
    assert.equal(rd('boot/extlinux.conf').split('no_timer_check').length, 2, 'added once');
    assert.match(rd('etc/conf.d/chronyd'), /^FAST_STARTUP=yes$/m);
    assert.equal(rd('etc/dhcpcd.conf').split('noarp').length, 2, 'noarp added once');
  }
  fs.writeFileSync(CFG.sshPub, "ssh-ed25519 AAAA it's-quoted\n");
  assert.throws(() => install.buildSeed('x'), /quotes/);
}));

test('parseBakeEnd: status from the marker; null without one', () => {
  assert.deepEqual(install.parseBakeEnd('...\n=== BAKE END rc=0 ===\n'), { rc: 0 });
  assert.deepEqual(install.parseBakeEnd('=== BAKE END rc=2 ==='), { rc: 2 });
  assert.deepEqual(install.parseBakeEnd('=== BAKE END ==='), { rc: null });
  assert.equal(install.parseBakeEnd('=== BAKE START ==='), null);
});

test('bakeArgs: SSH on 127.0.0.1:2222, seed URL on the free port, file serial log, private monitor, fallback accel', () => {
  const x = install.bakeArgs({
    disk: 'C:/d,1/downloads/bake-work.qcow2', accel: 'whpx', mem: 2048, cpus: 2, seedPort: 51234, sshPort: 2222,
    serialLog: 'C:/d/sandboxes/base-bake.log', monitor: { host: '127.0.0.2', port: 50001 }, pidFile: 'C:/d/run/bake.pid',
  }).join(' ');
  assert.ok(x.includes('-accel whpx,kernel-irqchip=off -accel tcg'));
  assert.ok(x.includes('file=C:/d,,1/downloads/bake-work.qcow2,if=virtio'));
  assert.ok(x.includes('hostfwd=tcp:127.0.0.1:2222-:22'));
  assert.ok(x.includes('-smbios type=1,serial=ds=nocloud-net;s=http://10.0.2.2:51234/'));
  assert.ok(x.includes('-display none -chardev file,id=ser0,path=C:/d/sandboxes/base-bake.log -serial chardev:ser0'));
  assert.ok(x.includes('-chardev socket,id=mon0,host=127.0.0.2,port=50001,server=on,wait=off -mon chardev=mon0,mode=readline'));
  assert.ok(x.includes('-pidfile C:/d/run/bake.pid'));
  assert.ok(x.includes('-no-reboot'));
  assert.ok(!x.includes('-nographic'));
  const t = install.bakeArgs({ disk: '/d/w.qcow2', accel: 'tcg', mem: 1024, cpus: 1, seedPort: 1, sshPort: 2222, serialLog: '/d/l', monitor: null });
  assert.ok(t.join(' ').includes('-accel tcg -cpu max'));
  assert.ok(t.join(' ').includes('-monitor none'));
});

test('startSeedServer: free port on 127.0.0.1 serving meta-data/user-data; stop frees it; a retry works (BUG-11)', withKeyRoot('seedsrv', async () => {
  const get = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  const port = await install.startSeedServer('devbox-test-1');
  assert.ok(port > 0 && port !== 8000);
  assert.match((await get(port, '/meta-data')).body, /instance-id: devbox-test-1/);
  assert.match((await get(port, '/user-data')).body, /^#cloud-config/);
  assert.equal((await get(port, '/nope')).status, 404);
  install.stopSeedServer();
  await sleep(50);
  await assert.rejects(get(port, '/meta-data'));
  const again = await install.startSeedServer('devbox-test-2');
  assert.match((await get(again, '/meta-data')).body, /devbox-test-2/);
  install.stopSeedServer();
}));

test('LogWatcher / waitForMarker: read only what was appended; find a marker split across two writes', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-log-'));
  try {
    const f = path.join(dir, 'bake.log');
    const w = new install.LogWatcher(f);
    assert.equal(w.poll(), ''); // no file yet
    fs.writeFileSync(f, 'booting...\n=== BAKE ST');
    assert.ok(!/=== BAKE START ===/.test(w.poll()));
    fs.appendFileSync(f, 'ART ===\n');
    assert.ok(/=== BAKE START ===/.test(w.poll()), 'marker across two chunks');
    assert.equal(w.lastLine, '=== BAKE START ===');
    assert.ok(w.offset > 0);
    setTimeout(() => fs.appendFileSync(f, 'apk...\n=== BAKE END rc=0 ===\n'), 150);
    assert.equal(await install.waitForMarker(f, /=== BAKE END rc=\d+ ===/, 5000, null, 50), true);
    assert.equal(await install.waitForMarker(f, 'never', 5000, () => false, 50), false);
    assert.equal(await install.waitForMarker(f, 'never', 120, null, 50), false);
  } finally { rm(dir); }
});

test('prereqs: every item has ok/required/label/detail/fix/action; accel is optional', withKeyRoot('prereqs', async () => {
  const p = install.prereqs();
  for (const k of ['qemu', 'ssh', 'scp', 'accel', 'sshkey', 'alpine', 'base']) {
    assert.ok(p[k], k);
    for (const f of ['ok', 'required', 'label', 'detail', 'fix', 'action']) assert.ok(f in p[k], k + '.' + f);
  }
  assert.equal(p.accel.required, false);
  assert.equal(p.base.ok, false);
  assert.equal(p.base.required, true);
  if (process.platform === 'win32') assert.ok(p.sevenzip);
  fs.writeFileSync(CFG.alpine, 'x');
  fs.writeFileSync(CFG.alpine + '.json', JSON.stringify({ file: 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2', sha512: 'x' }));
  assert.match(install.prereqs().alpine.detail, /nocloud_alpine-3\.23\.4/);
}));

const HAVE_TOOLS = !!(platform.findTool('qemu') && platform.findTool('qemu-img') && platform.findTool('ssh') && platform.findTool('ssh-keygen'));

test('validateBuildBase refuses to rebuild the base while VMs are clones of it (XTR-14)', { skip: !HAVE_TOOLS && 'QEMU/OpenSSH not installed' }, withKeyRoot('rebuild', async () => {
  assert.deepEqual(await install.validateBuildBase({}), { force: false }); // no base yet: fine
  fs.writeFileSync(CFG.base, 'x');
  assert.deepEqual(await install.validateBuildBase({}), { force: false }); // base, no clones: fine
  st.state.vms.web = st.newVmRecord({ port: 2223, template: 'devbox-base' });
  await assert.rejects(install.validateBuildBase({}), (e) => e.status === 409 && e.code === 'BASE_IN_USE' && /web/.test(e.message));
  st.state.vms.web.template = 'other-tpl';
  assert.deepEqual(await install.validateBuildBase({}), { force: false });
}));

test('validateSetup / validateInstallQemu: say exactly what is missing; QEMU auto-install is Windows-only', async () => {
  try {
    const r = await install.validateSetup({});
    assert.equal(typeof r.installQemu, 'boolean');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'PREREQ_MISSING');
  }
  if (process.platform !== 'win32') await assert.rejects(install.validateInstallQemu({}), (e) => e.status === 400);
});

test('real QEMU: the bake VM starts with its arguments (file serial log, monitor, pidfile, seed URL) and is stopped cleanly', { skip: !HAVE_TOOLS && 'QEMU/OpenSSH not installed', timeout: 60000 }, withKeyRoot('bakeboot', async () => {
  const qi = platform.findTool('qemu-img');
  const { run } = require('../lib/util');
  // a blank disk stands in for the Alpine image: QEMU runs, the guest never starts
  fs.mkdirSync(path.dirname(CFG.alpine), { recursive: true });
  assert.equal((await run(qi, ['create', '-f', 'qcow2', CFG.alpine, '16M'])).code, 0);
  fs.mkdirSync(CFG.downloadsDir, { recursive: true });
  const work = path.posix.join(CFG.downloadsDir, 'bake-work.qcow2');
  await install._internal.makeWorkDisk(qi, work, 32 * 1024 * 1024);
  const vmMod = require('../lib/vm');
  const wi = await vmMod.diskInfo(work);
  assert.equal(wi.backing, '../vm-alpine.qcow2', 'the bake boots a throwaway overlay of the pristine image');
  assert.equal(wi.virtualSize, 32 * 1024 * 1024);
  const port = await install.startSeedServer('devbox-bake-test');
  const t = fakeT();
  try {
    const r = await install._internal.bakeOnce(t, {
      qemu: platform.findTool('qemu'), accel: 'tcg', work: work, seedPort: port, mem: 128, cpus: 1, startCapMs: 3000, totalMs: 20000,
    });
    assert.equal(r.status, 'no-start', JSON.stringify(r) + '\n' + t.lines.join('\n'));
    assert.equal(install.bakeRunning(), true);
    assert.ok(fs.existsSync(install._internal.bakeSerialLog()), 'serial log file created by the chardev');
    assert.ok(fs.existsSync(install._internal.bakePidFile()), 'pidfile written');
    await install._internal.killBakeVm();
    assert.equal(install.bakeRunning(), false);
  } finally {
    install.shutdown();
    await sleep(300);
  }
}));

test('install.shutdown() is safe with nothing running', () => {
  install.shutdown();
  assert.equal(install.bakeRunning(), false);
});

test('real QEMU: a bake left by a closed manager is found through run/bake.json and ended through its OWN monitor; shutdown() leaves no stale pid files', { skip: !HAVE_TOOLS && 'QEMU/OpenSSH not installed', timeout: 60000 }, withKeyRoot('bakeorphan', async () => {
  const qi = platform.findTool('qemu-img');
  const { run } = require('../lib/util');
  fs.mkdirSync(path.dirname(CFG.alpine), { recursive: true });
  assert.equal((await run(qi, ['create', '-f', 'qcow2', CFG.alpine, '16M'])).code, 0);
  fs.mkdirSync(CFG.downloadsDir, { recursive: true });
  const work = path.posix.join(CFG.downloadsDir, 'bake-work.qcow2');
  await install._internal.makeWorkDisk(qi, work, 32 * 1024 * 1024);
  const port = await install.startSeedServer('devbox-bake-orphan');
  const t = fakeT();
  const opts = { qemu: platform.findTool('qemu'), accel: 'tcg', work: work, seedPort: port, mem: 128, cpus: 1, startCapMs: 2000, totalMs: 20000 };
  try {
    await install._internal.bakeOnce(t, opts);
    const j = JSON.parse(fs.readFileSync(install._internal.bakeInfoFile(), 'utf8'));
    assert.ok(j.pid > 0 && j.monitor, 'pid and monitor recorded');
    // as after a crash: the next bake finds it and ends it through its monitor
    await install._internal.killOrphanBake(t);
    for (let i = 0; i < 40 && platform.pidAlive(j.pid); i++) await sleep(250);
    assert.equal(platform.pidAlive(j.pid), false, t.lines.join('\n'));
    assert.ok(t.lines.some((l) => /left over from an earlier run/.test(l)), t.lines.join('\n'));
    assert.equal(fs.existsSync(install._internal.bakeInfoFile()), false);
    assert.equal(fs.existsSync(install._internal.bakePidFile()), false);
    // closing the manager mid-bake (SIGHUP -> shutdown): no pid file stays behind
    await install._internal.bakeOnce(t, opts);
    const j2 = JSON.parse(fs.readFileSync(install._internal.bakeInfoFile(), 'utf8'));
    install.shutdown();
    for (let i = 0; i < 40 && platform.pidAlive(j2.pid); i++) await sleep(250);
    assert.equal(fs.existsSync(install._internal.bakePidFile()), false);
    assert.equal(fs.existsSync(install._internal.bakeInfoFile()), false);
  } finally {
    install.shutdown();
    await sleep(300);
  }
}));

test('killOrphanBake: a pid from an earlier bake that now belongs to a VM or another QEMU is never killed (BUG-22, BUG-6)', withKeyRoot('orphan', async () => {
  const monitor = require('../lib/monitor');
  const { spawn } = require('child_process');
  const saved = { list: platform.listQemuPids, info: monitor.infoName, quit: monitor.quit };
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const t = fakeT();
  try {
    const info = install._internal.bakeInfoFile();
    fs.mkdirSync(path.dirname(info), { recursive: true });
    const leave = () => fs.writeFileSync(info, JSON.stringify({ pid: kid.pid, monitor: { host: '127.9.9.9', port: 7 } }));
    let quits = 0;
    platform.listQemuPids = async () => new Set([kid.pid]);
    monitor.quit = async () => { quits++; return { ok: true, text: '', error: null }; };
    // a VM of the registry has that pid now
    st.state.vms.web = st.newVmRecord({ port: 2400, template: '', runtime: { pid: kid.pid, monitor: null, serial: null } });
    leave();
    await install._internal.killOrphanBake(t);
    assert.equal(platform.pidAlive(kid.pid), true);
    assert.equal(fs.existsSync(info), false, 'the stale file is forgotten');
    delete st.state.vms.web;
    // some other QEMU (another data folder's VM, the Android emulator...)
    for (const answer of ['box', null]) {
      monitor.infoName = async () => answer;
      leave();
      await install._internal.killOrphanBake(t);
      assert.equal(platform.pidAlive(kid.pid), true, 'monitor answered ' + answer);
    }
    assert.equal(quits, 0);
    // really the bake: told to quit through its monitor, killed if it does not
    monitor.infoName = async () => 'devbox-bake';
    leave();
    await install._internal.killOrphanBake(t);
    assert.equal(quits, 1);
    for (let i = 0; i < 40 && platform.pidAlive(kid.pid); i++) await sleep(100);
    assert.equal(platform.pidAlive(kid.pid), false);
  } finally {
    platform.listQemuPids = saved.list; monitor.infoName = saved.info; monitor.quit = saved.quit;
    try { kid.kill(); } catch (e) {}
  }
}));

test('QEMU installer signature: pinned to its publisher; an expired certificate is fine only when it still chains to a trusted CA (SEC-10)', () => {
  const sig = (status, signer, chainOk) => ({ status: status, signer: signer, chainOk: chainOk !== false });
  const UNI = 'CN=Universität Mannheim, O=Universität Mannheim, S=Baden-Württemberg, C=DE';
  const ok = (s, allow) => install.checkInstallerSignature(s, !!allow).ok;
  assert.equal(ok(sig('UnknownError', UNI)), true, 'QEMU 10.2 as published: expired certificate of the university');
  assert.equal(ok(sig('Valid', 'CN=Stefan Weil, O=Stefan Weil, C=DE')), true, 'older builds');
  assert.equal(ok(sig('UnknownError', 'CN=Universit\u00c3\u00a4t Mannheim, O=x')), true, 'the umlaut mangled by a code page');
  assert.equal(ok(sig('UnknownError', UNI, false)), false, 'the publisher\'s NAME on a self-made certificate');
  assert.equal(ok(sig('NotSigned', '')), false);
  assert.equal(ok(sig('Valid', 'CN=Evil Corp, O=Evil')), false);
  assert.equal(ok(sig('Valid', 'CN=Evil, O=Stefan Weil')), false, 'the name must be the CN');
  assert.equal(ok(null), false, 'no way to check: refused');
  assert.equal(ok(sig('HashMismatch', UNI)), false);
  assert.match(install.checkInstallerSignature(sig('NotSigned', ''), false).why, /not signed/);
  // config.json "allowUnsignedQemu": true lets everything but a tampered file through
  assert.equal(ok(sig('NotSigned', ''), true), true);
  assert.equal(ok(null, true), true);
  assert.equal(ok(sig('HashMismatch', UNI), true), false);
  assert.deepEqual(install.parseAuthenticode('noise\r\nUnknownError|True|' + UNI + '\r\n'), { status: 'UnknownError', chainOk: true, signer: UNI });
  assert.deepEqual(install.parseAuthenticode('NotSigned|False|'), { status: 'NotSigned', chainOk: false, signer: '' });
  assert.equal(install.parseAuthenticode('garbage'), null);
});

test('real Windows: the installed QEMU\'s own signature passes the pinned check', { skip: (process.platform !== 'win32' || !fs.existsSync('C:/Program Files/qemu/qemu-uninstall.exe')) && 'needs QEMU installed from qemu.weilnetz.de on Windows' }, async () => {
  const s = await install.authenticode('C:/Program Files/qemu/qemu-uninstall.exe');
  assert.ok(s, 'PowerShell answered');
  assert.equal(install.checkInstallerSignature(s, false).ok, true, JSON.stringify(s));
});

// /api/setup is never POSTed in tests (it downloads). Its planning is checked
// here instead: what validateSetup refuses up front (a 409 with the fix, so
// no task starts), and that opSetup skips every step already done - with
// tool discovery and key creation stubbed, nothing is downloaded or spawned.
test('one-click setup: refuses early what it cannot do, skips what is done (no downloads)', async () => {
  const root = useTempRoot('setup');
  const ssh = require('../lib/ssh');
  const kernel = require('../lib/microvm/kernel');
  const orig = { findTool: platform.findTool, IS_WIN: platform.IS_WIN, ensureSshKey: ssh.ensureSshKey, ensureKernel: kernel.ensureKernel };
  let have = {};
  platform.findTool = (n) => (have[n] ? path.join(root, 'fake-' + n) : null);
  // the kernel step would fetch the Alpine index: already installed here
  const kernelCalls = [];
  kernel.ensureKernel = async (t, o) => { kernelCalls.push(o); return { source: 'installed', kver: 'test' }; };
  try {
    const refused = (re) => (e) => e.status === 409 && e.code === 'PREREQ_MISSING' && re.test(e.message);
    await assert.rejects(install.validateSetup({}), refused(/OpenSSH/));
    have = { ssh: 1, 'ssh-keygen': 1 };
    platform.IS_WIN = false;
    await assert.rejects(install.validateSetup({}), refused(/QEMU is not installed/), 'Linux/macOS: QEMU comes from the package manager');
    platform.IS_WIN = true;
    await assert.rejects(install.validateSetup({}), refused(/7-Zip/), 'Windows: unpacking QEMU needs 7-Zip');
    have['7z'] = 1;
    assert.deepEqual(await install.validateSetup({}), { installQemu: true });
    have.qemu = 1; have['qemu-img'] = 1;
    assert.deepEqual(await install.validateSetup({}), { installQemu: false });

    // everything already there: opSetup only reports
    fs.mkdirSync(path.dirname(CFG.base), { recursive: true });
    fs.writeFileSync(CFG.base, 'x');
    ssh.ensureSshKey = async () => false;
    const lines = [];
    const t = { id: 't1', log: (m) => lines.push(m), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARN ' + m) };
    const r = await install.opSetup(t, { installQemu: false });
    assert.equal(r.ready, true);
    assert.deepEqual(r.steps, [
      { step: 'ssh-key', done: 'already there' }, { step: 'qemu', done: 'already there' },
      { step: 'kernel', done: 'already there' },
      { step: 'alpine', done: 'not needed' }, { step: 'base', done: 'already there' },
    ]);
    assert.equal(lines.filter((l) => /^STEP Step \d\/5/.test(l)).length, 5, 'five numbered steps: ' + lines.join(' | '));
    assert.ok(lines.some((l) => /Docker images can run now/.test(l)));
    assert.ok(!fs.existsSync(CFG.alpine), 'the Alpine image was not downloaded');

    // "Set up for Docker images": QEMU + kernel only - no SSH key, no base
    ssh.ensureSshKey = async () => { throw new Error('the SSH key is not part of {only:"microvm"}'); };
    have = { qemu: 1, 'qemu-img': 1 }; // no OpenSSH on this PC: still fine
    assert.deepEqual(await install.validateSetup({ only: 'microvm' }), { installQemu: false, only: 'microvm' });
    await assert.rejects(install.validateSetup({ only: 'vm' }), (e) => e.status === 400);
    lines.length = 0;
    const m = await install.opSetup(t, { installQemu: false, only: 'microvm' });
    assert.equal(m.only, 'microvm');
    assert.deepEqual(m.steps, [{ step: 'qemu', done: 'already there' }, { step: 'kernel', done: 'already there' }]);
    assert.equal(lines.filter((l) => /^STEP Step \d\/2/.test(l)).length, 2, lines.join(' | '));

    // a kernel failure: fatal for {only:'microvm'}, a warning in a full setup
    kernel.ensureKernel = async () => { throw new Error('no network'); };
    await assert.rejects(install.opSetup(t, { installQemu: false, only: 'microvm' }), /no network/);
    have = { ssh: 1, 'ssh-keygen': 1, qemu: 1, 'qemu-img': 1 };
    ssh.ensureSshKey = async () => false;
    lines.length = 0;
    const full = await install.opSetup(t, { installQemu: false });
    assert.equal(full.ready, true);
    assert.match(full.steps.find((s) => s.step === 'kernel').done, /^failed: no network/);
    assert.ok(lines.some((l) => /^WARN the microVM kernel could not be set up/.test(l)), lines.join(' | '));
    assert.equal(kernelCalls.length, 2, 'the recording stub saw the full setup and the microvm-only one');
  } finally {
    platform.findTool = orig.findTool;
    platform.IS_WIN = orig.IS_WIN;
    ssh.ensureSshKey = orig.ensureSshKey;
    kernel.ensureKernel = orig.ensureKernel;
    resetConfig();
    rm(root);
  }
});

// ---------------------------------------------------------------------------
// no hardware acceleration: the hint (SPEC-diskroot section 11)
// ---------------------------------------------------------------------------
test('outerHypervisor: Win32_ComputerSystem / DMI strings -> the outer hypervisor', () => {
  const o = install.outerHypervisor;
  assert.equal(o('Microsoft Corporation', 'Virtual Machine'), 'hyper-v');
  assert.equal(o('Microsoft Corporation', 'Surface Laptop 5'), null, 'a Surface is a physical PC');
  assert.equal(o('VMware, Inc.', 'VMware7,1'), 'vmware');
  assert.equal(o('VMware, Inc.', 'VMware20,1'), 'vmware');
  assert.equal(o('innotek GmbH', 'VirtualBox'), 'virtualbox');
  assert.equal(o('Oracle Corporation', 'VirtualBox'), 'virtualbox');
  assert.equal(o('QEMU', 'Standard PC (Q35 + ICH9, 2009)'), 'kvm');
  assert.equal(o('Proxmox', 'x'), 'kvm');
  assert.equal(o('Red Hat', 'KVM'), 'kvm');
  assert.equal(o('Xen', 'HVM domU'), 'xen');
  assert.equal(o('Parallels Software International Inc.', 'Parallels Virtual Platform'), 'parallels');
  assert.equal(o('Amazon EC2', 'm5.large'), 'cloud');
  assert.equal(o('Google', 'Google Compute Engine'), 'cloud');
  assert.equal(o('Dell Inc.', 'XPS 15 9530'), null);
  assert.equal(o('LENOVO', '21CB'), null);
  assert.equal(o('', ''), null);
  assert.equal(o(null, undefined), null);
});

test('buildAccelHint: the outer hypervisor\'s own steps when known, every one when not; the Windows feature on this PC', () => {
  const win = (vendor) => install.buildAccelHint({ platform: 'win32', arch: 'x64', vendor: vendor, accelFix: 'turn on WHP' });
  // inside Hyper-V: only its steps, the verified command, the prerequisites
  const hv = win({ manufacturer: 'Microsoft Corporation', model: 'Virtual Machine' });
  assert.equal(hv.accel, 'tcg');
  assert.equal(hv.insideVm, true);
  assert.equal(hv.outer, 'hyper-v');
  assert.deepEqual(Object.keys(hv.steps), ['hyper-v']);
  assert.match(hv.steps['hyper-v'][0], /`Set-VMProcessor -VMName "<VM name>" -ExposeVirtualizationExtensions \$true`/);
  assert.match(hv.steps['hyper-v'][0], /switched off/);
  assert.match(hv.steps['hyper-v'][1], /VT-x and EPT.*8\.0.*AMD.*9\.3/);
  assert.match(hv.summary, /itself a virtual machine \(Hyper-V\)/);
  assert.match(hv.inner[0], /Windows Hypervisor Platform.*`Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform`/);
  assert.match(hv.fix, /Set-VMProcessor/);
  assert.doesNotMatch(hv.fix, /`/, 'fix is plain text for the Copy button');
  assert.doesNotMatch(hv.summary, /`/);
  assert.match(hv.readme, /README\.md, section "Running inside another VM"/);
  assert.match(hv.fix, /Running inside another VM/);
  // VMware: Workstation and ESXi report the same strings - both are shown
  const vw = win({ manufacturer: 'VMware, Inc.', model: 'VMware7,1' });
  assert.deepEqual(Object.keys(vw.steps), ['vmware', 'vmware-esxi']);
  assert.match(vw.steps.vmware[0], /Virtualize Intel VT-x\/EPT or AMD-V\/RVI/);
  assert.match(vw.steps['vmware-esxi'][0], /Expose hardware assisted virtualization to the guest OS/);
  assert.match(vw.steps.vmware[1], /Hyper-V or Virtualization-based security/);
  // VirtualBox, Proxmox / KVM
  assert.match(win({ manufacturer: 'innotek GmbH', model: 'VirtualBox' }).steps.virtualbox[0], /`VBoxManage modifyvm "<VM name>" --nested-hw-virt on`/);
  const kvm = win({ manufacturer: 'QEMU', model: 'Standard PC (i440FX + PIIX, 1996)' });
  assert.equal(kvm.steps.kvm.length, 3);
  assert.match(kvm.steps.kvm.join(' '), /kvm_intel\/parameters\/nested.*options kvm-intel nested=Y.*options kvm-amd nested=1.*qm set <vmid> --cpu host/);
  // a physical PC: the firmware switch and the Windows feature, no hypervisor steps
  const pc = win({ manufacturer: 'Dell Inc.', model: 'XPS 15' });
  assert.equal(pc.insideVm, false);
  assert.deepEqual(Object.keys(pc.steps), ['bare-metal']);
  assert.match(pc.summary, /Windows Hypervisor Platform/);
  assert.match(pc.fix, /^Turn on the optional Windows feature/);
  // not known yet (the background check is running): every hypervisor
  const unknown = win(null);
  assert.equal(unknown.insideVm, null);
  assert.deepEqual(Object.keys(unknown.steps), ['hyper-v', 'vmware', 'vmware-esxi', 'virtualbox', 'kvm', 'bare-metal']);
  assert.deepEqual(Object.keys(unknown.labels), Object.keys(unknown.steps));
  assert.match(unknown.summary, /If this PC is a virtual machine/);
  // Linux: this machine's fix is /dev/kvm, not the Windows feature
  const lx = install.buildAccelHint({ platform: 'linux', arch: 'x64', vendor: { manufacturer: 'QEMU', model: 'Standard PC' }, accelFix: 'For speed, make /dev/kvm usable: sudo usermod -aG kvm $USER, then log out and in again.' });
  assert.match(lx.inner[0], /^Then, on this machine: for speed, make \/dev\/kvm usable/);
  assert.doesNotMatch(lx.inner.join(' '), /Windows Hypervisor Platform/);
  // Apple Silicon: nothing to turn on
  const mac = install.buildAccelHint({ platform: 'darwin', arch: 'arm64', vendor: null });
  assert.deepEqual(mac.steps, {});
  assert.match(mac.summary, /Apple Silicon/);
  // every hint names the light profile as the stop-gap
  for (const h of [hv, vw, kvm, pc, unknown, lx, mac]) assert.match(h.summary, /light profile/);
});

test('the machine is asked once at manager start, beside the accelerator detection - the first TCG hint already names the outer hypervisor (cov-9)', () => {
  assert.equal(typeof install.prefetchVendor, 'function');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const detect = src.indexOf('platform.detectAccel(q)');
  const pre = src.indexOf('install.prefetchVendor()');
  assert.ok(detect > 0 && pre > detect && pre - detect < 600, 'called in the start-up block, next to the detection');
});

test('accelHint(): only when detection finished and found nothing but TCG', () => {
  const saved = platform.accelStatus;
  try {
    platform.accelStatus = () => ({ available: null, recommended: null, detecting: true });
    assert.equal(install.accelHint(), null);
    platform.accelStatus = () => ({ available: null, recommended: null, detecting: false });
    assert.equal(install.accelHint(), null, 'not checked yet (no QEMU)');
    platform.accelStatus = () => ({ available: ['whpx', 'tcg'], recommended: 'whpx', detecting: false });
    assert.equal(install.accelHint(), null);
    platform.accelStatus = () => ({ available: ['tcg'], recommended: 'tcg', detecting: false });
    const h = install.accelHint();
    assert.equal(h.accel, 'tcg');
    assert.ok(Object.keys(h.steps).length >= 1);
    // the prerequisites row says the same
    const p = install.prereqs();
    assert.equal(p.accel.ok, false);
    assert.equal(p.accel.detail, h.summary);
  } finally { platform.accelStatus = saved; }
});

// ---------------------------------------------------------------------------
// light profile: the pristine Alpine download after the base build
// ---------------------------------------------------------------------------
test('dropAlpineDownload: deleted after a base build only when keepAlpineDownload is off; Setup says why; a rebuild downloads it again', withKeyRoot('alpine-drop', async () => {
  const src = { url: 'https://x/nocloud.qcow2', file: 'nocloud_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2', sha512: 'abc' };
  fs.writeFileSync(CFG.alpine, Buffer.alloc(4096, 1));
  fs.writeFileSync(CFG.alpine + '.json', JSON.stringify(src));
  fs.writeFileSync(CFG.base, 'base');
  // the normal profile keeps it
  assert.equal(CFG.keepAlpineDownload, true);
  let t = fakeT();
  assert.equal(install.dropAlpineDownload(t), false);
  assert.ok(fs.existsSync(CFG.alpine));
  assert.deepEqual(t.lines, []);
  // the light profile drops it, records why, and logs what it freed
  CFG.keepAlpineDownload = false;
  t = fakeT();
  assert.equal(install.dropAlpineDownload(t), true);
  assert.equal(fs.existsSync(CFG.alpine), false);
  assert.match(t.lines.join('\n'), /Deleted the Alpine download \(4\.0 KB freed\).*downloads it again/);
  const side = JSON.parse(fs.readFileSync(CFG.alpine + '.json', 'utf8'));
  assert.equal(side.file, src.file, 'the record stays');
  assert.equal(side.deletedBytes, 4096);
  assert.ok(Date.parse(side.deletedAt));
  // Setup: not "missing", but "not kept"
  const p = install.prereqs();
  assert.equal(p.alpine.ok, true);
  assert.match(p.alpine.detail, /not kept after the base image was built.*rebuilding the base downloads it again/);
  // nothing left to drop: a no-op
  assert.equal(install.dropAlpineDownload(fakeT()), false);
  // without the base the download is simply missing (a rebuild needs it)
  fs.rmSync(CFG.base);
  assert.equal(install.prereqs().alpine.ok, false);
  assert.match(install.prereqs().alpine.detail, /not downloaded yet/);
}));

test('the bake drops the Alpine download only after a SUCCESSFUL build, and only once its overlay is gone', () => {
  const srcText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'install.js'), 'utf8');
  const fin = srcText.slice(srcText.indexOf('async function bakeBase('), srcText.indexOf('function dropAlpineDownload('));
  const finallyBlock = fin.slice(fin.lastIndexOf('} finally {'));
  assert.ok(finallyBlock.indexOf("fs.rmSync(work") !== -1 && finallyBlock.indexOf('dropAlpineDownload(t)') > finallyBlock.indexOf('fs.rmSync(work'),
    'the work overlay (backed by the Alpine image) is removed first');
  assert.match(finallyBlock, /if \(!ok\)[^\n]*\n\s*\/\/[^\n]*\n\s*else dropAlpineDownload\(t\)/, 'only when the base was written');
  // and a rebuild finds the file missing and downloads it again (no
  // "already there" shortcut that would skip the download)
  const ensure = srcText.slice(srcText.indexOf('async function ensureAlpineImage('), srcText.indexOf('// the bake'));
  assert.match(ensure, /if \(exists\(CFG\.alpine\)\)/);
  assert.match(ensure, /await download\(img\.url, CFG\.alpine/);
});
