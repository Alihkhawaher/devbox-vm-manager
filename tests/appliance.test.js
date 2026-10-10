'use strict';
/*
 * Appliance VMs (lib/appliance.js): the pure pieces - image format detection,
 * the QEMU arguments for the kind, the record - and the validator's refusals.
 * Nothing here runs QEMU or downloads anything; the real import and boot are
 * exercised by hand against a real image (see README "Appliance VMs").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const appliance = require('../lib/appliance');
const vm = require('../lib/vm');
const { useTempRoot, resetConfig, rm } = require('./helpers');

function withRoot(fn) {
  const root = useTempRoot('appl');
  tasks._reset();
  st.loadState();
  return Promise.resolve().then(() => fn(root)).finally(() => { tasks._reset(); resetConfig(); rm(root); });
}

test('detectFormat: qcow2, ISO 9660 / UDF, raw', () => {
  assert.equal(appliance.detectFormat(Buffer.from('QFI\xfb\x00\x00\x00\x03', 'latin1')), 'qcow2');
  const iso = Buffer.alloc(0x8010);
  iso.write('CD001', 0x8001, 'latin1');
  assert.equal(appliance.detectFormat(iso), 'iso');
  const udf = Buffer.alloc(0x8010);
  udf.write('BEA01', 0x8001, 'latin1');
  assert.equal(appliance.detectFormat(udf), 'iso');
  assert.equal(appliance.detectFormat(Buffer.alloc(512)), 'raw');
  assert.equal(appliance.detectFormat(Buffer.from('EB58904D')), 'raw');   // a FAT boot sector = a raw disk
});

test('qemuArgs: virtio disk + UEFI + VNC on the private endpoint + tablet + sound; SATA and CD-ROM variants', () => {
  const rec = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'uefi', bus: 'virtio', sound: true, source: 'x.img' } });
  const o = { disk: 'D:/d/k.qcow2', media: null, firmware: { code: 'C:/q/share/code.fd', vars: 'C:/q/share/vars.fd' }, vars: 'D:/d/k-vars.fd', display: { host: '127.9.8.7', port: 5923 }, sound: 'dsound' };
  const a = appliance.qemuArgs(rec, o);
  const drives = a.drives.join(' '), extra = a.extra.join(' ');
  assert.match(drives, /file=D:\/d\/k\.qcow2,if=none,id=hd0,format=qcow2/);
  assert.match(drives, /virtio-blk-pci,drive=hd0,bootindex=1/);
  assert.doesNotMatch(drives, /cdrom/);
  assert.match(extra, /if=pflash,format=raw,readonly=on,file=C:\/q\/share\/code\.fd/);
  assert.match(extra, /if=pflash,format=raw,file=D:\/d\/k-vars\.fd/);
  assert.match(extra, /-vnc 127\.9\.8\.7:23,lossy=on/, 'VNC display number = port - 5900');
  assert.match(extra, /-device virtio-vga/, 'virtio-vga by default');
  assert.match(extra, /usb-tablet/);
  assert.match(extra, /-audiodev dsound,id=snd0 -device intel-hda -device hda-output,audiodev=snd0/);
  // BIOS, SATA, an ISO attached, no sound
  const rec2 = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'bios', bus: 'sata', vga: 'std', sound: false, media: 'iso', source: 'x.iso' } });
  const b = appliance.qemuArgs(rec2, Object.assign({}, o, { media: 'D:/d/k-media.iso' }));
  const d2 = b.drives.join(' '), e2 = b.extra.join(' ');
  assert.match(e2, /-device VGA,vgamem_mb=32/);
  assert.doesNotMatch(e2, /virtio-vga/);
  // installation media: the image as a second disk that boots first, the VM's own disk second
  const rec3 = st.newVmRecord({ kind: 'appliance', appliance: { media: 'image', source: 'x.img.gz' } });
  const c3 = appliance.qemuArgs(rec3, Object.assign({}, o, { mediaDisk: 'D:/d/k-media.qcow2' })).drives.join(' ');
  assert.match(c3, /file=D:\/d\/k-media\.qcow2,if=none,id=hd1,format=qcow2 -device virtio-blk-pci,drive=hd1,bootindex=0/);
  assert.match(c3, /virtio-blk-pci,drive=hd0,bootindex=1/);
  const c4 = appliance.qemuArgs(st.newVmRecord({ kind: 'appliance', appliance: { media: 'image', bus: 'sata' } }), Object.assign({}, o, { mediaDisk: 'D:/d/k-media.qcow2' })).drives.join(' ');
  assert.match(c4, /ide-hd,drive=hd1,bus=ahci\.2,bootindex=0/);
  assert.match(d2, /ich9-ahci,id=ahci/);
  assert.match(d2, /ide-hd,drive=hd0,bus=ahci\.0,bootindex=1/);
  assert.match(d2, /media=cdrom,format=raw,readonly=on/);
  assert.match(d2, /ide-cd,drive=cd0,bus=ahci\.1,bootindex=0/, 'the installer boots first');
  assert.doesNotMatch(e2, /pflash/);
  assert.doesNotMatch(e2, /audiodev/);
  // the full command line: the appliance's drives replace the virtio qcow2 drive and -display none stays (no local window)
  const args = vm.qemuArgs({ name: 'k', disk: 'D:/d/k.qcow2', drives: a.drives, mem: 1024, cpus: 2, accel: 'tcg', netdev: 'user,id=n0', mac: '52:54:00:00:00:01',
    monitor: { host: '127.9.8.7', port: 1 }, serial: { host: '127.9.8.7', port: 2 }, extraArgs: a.extra });
  const line = args.join(' ');
  assert.match(line, /-display none/);
  assert.doesNotMatch(line, /if=virtio,format=qcow2/);
  assert.match(line, /-vnc 127\.9\.8\.7:23/);
});

test('netdevFor: no SSH forward for an appliance, the user forwards stay', () => {
  const a = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2250, ports: [{ host: 18080, guest: 8080, lan: false }] });
  assert.equal(vm.netdevFor(a), 'user,id=n0,hostfwd=tcp:127.0.0.1:18080-:8080');
  const n = st.newVmRecord({ port: 2250 });
  assert.match(vm.netdevFor(n), /hostfwd=tcp:127\.0\.0\.1:2250-:22/);
});

test('the record: kind, the appliance block with defaults, template "" (standalone disk); an Alpine record has neither', () => {
  const a = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'bios', source: 'https://x/y.img.gz', sourceSha256: 'A'.repeat(64) }, template: '' });
  assert.equal(a.kind, 'appliance');
  assert.deepEqual(a.appliance, { firmware: 'bios', bus: 'virtio', vga: 'virtio', sound: true, source: 'https://x/y.img.gz', sourceSha256: 'a'.repeat(64), media: 'disk' });
  assert.equal(a.template, '');
  const n = st.newVmRecord({});
  assert.equal(n.kind, 'alpine');
  assert.equal(n.appliance, null);
  // a bad appliance block never produces a bad record
  const b = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'coreboot', bus: 'ide', media: 'floppy' } });
  assert.deepEqual(b.appliance, { firmware: 'uefi', bus: 'virtio', vga: 'virtio', sound: true, source: '', sourceSha256: null, media: 'disk' });
  assert.equal(st.newVmRecord({ kind: 'appliance', appliance: { media: 'image' } }).appliance.media, 'image');
  // the display endpoint survives the runtime cleaning
  const r = st.newVmRecord({ runtime: { pid: 5, monitor: { host: '127.1.2.3', port: 4 }, serial: { host: '127.1.2.3', port: 5 }, display: { host: '127.1.2.3', port: 5901 } } });
  assert.deepEqual(r.runtime.display, { host: '127.1.2.3', port: 5901 });
  assert.equal(st.newVmRecord({ runtime: { pid: 5, monitor: { host: '127.1.2.3', port: 4 } } }).runtime.display, undefined);
});

test('validateCreate refuses: a bad name, no source, http://, a missing file, a bad firmware/bus/sha256, a taken name', () => withRoot(async (root) => {
  const img = path.join(root, 'tiny.img');
  fs.writeFileSync(img, Buffer.alloc(4096));
  await assert.rejects(appliance.validateCreate({ name: '-x', source: img }), /bad VM name/);
  await assert.rejects(appliance.validateCreate({ name: 'k' }), /source must be/);
  await assert.rejects(appliance.validateCreate({ name: 'k', source: 'http://example.com/a.img' }), /source must be|https/);
  await assert.rejects(appliance.validateCreate({ name: 'k', source: path.join(root, 'nope.img') }), /no such file/);
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img, firmware: 'coreboot' }), /firmware must be/);
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img, bus: 'ide' }), /bus must be/);
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img, sha256: 'abc' }), /sha256 must be 64 hex/);
  st.state.vms.k = st.newVmRecord({ port: 2222 });
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img }), /already exists/);
  // a valid request with no QEMU in this scratch root: a 409 naming the fix, not a failed task
  await assert.rejects(appliance.validateCreate({ name: 'k2', source: img }), (e) => e.code === 'PREREQ_MISSING' && /QEMU is not installed/.test(e.message));
}));

test('installation media live in sandboxes/install-media/, so the disk scan never adopts them as a VM (the phantom "<vm>-media" of 2026-10-10)', () => withRoot(async () => {
  const path_ = require('path');
  const { CFG } = require('../lib/config');
  for (const p of [st.mediaPath('k'), st.mediaDiskPath('k')]) {
    assert.equal(path_.posix.dirname(p), st.mediaDir());
    assert.notEqual(path_.posix.dirname(p), CFG.sandboxDir);
  }
  fs.mkdirSync(st.mediaDir(), { recursive: true });
  fs.writeFileSync(st.mediaDiskPath('k'), 'not a real disk');
  fs.writeFileSync(st.diskPath('k'), 'not a real disk');
  st.state.vms.k = st.newVmRecord({ kind: 'appliance', appliance: { media: 'image' }, port: 2250 });
  assert.deepEqual(st.listDisks(), ['k'], 'only the VM\'s own disk counts');
  assert.deepEqual(st.syncDisks(), [], 'no record is made up for the media');
}));

test('SOURCE_RE and baseName: Windows paths, POSIX paths, UNC, https; never http', () => {
  for (const s of ['C:\\x\\a.img', 'D:/x/a.img.gz', '/srv/a.iso', '\\\\nas\\share\\a.qcow2', 'https://h/p/a.img.gz?x=1']) assert.ok(appliance.SOURCE_RE.test(s), s);
  for (const s of ['http://h/a.img', 'a.img', 'ftp://h/a.img', '']) assert.ok(!appliance.SOURCE_RE.test(s), s);
  assert.equal(appliance.baseName('https://h/p/LibreELEC-Generic.x86_64-12.2.1.img.gz?x=1'), 'LibreELEC-Generic.x86_64-12.2.1.img.gz');
  assert.equal(appliance.baseName('C:\\x\\a.img'), 'a.img');
});
