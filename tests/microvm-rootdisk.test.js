'use strict';
/*
 * Disk-root microVMs on the host side (lib/microvm/rootdisk.js, run.js,
 * lib/oci/images.js): the image disk key and its inputs, the per-container
 * overlay (relative backing name, backing format, refuses to overwrite,
 * qemu-img agrees), the Windows path check of the joined backing path, the
 * image disk cache (hit, miss, stale sidecar, one build for concurrent
 * starts, facts in the sidecar), the boot archive's module sets, who
 * references a disk (overlay headers, records, an unreadable overlay), the
 * disk GC (referenced, young, dangling, .part ages, a disk a QEMU holds
 * open), prepareImage/prepareRootByDigest end to end against a local image
 * and a fake kernel, and the image cache rules (rmi keeps a referenced
 * disk, prune removes a dangling one, olderThanDays). No QEMU, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CFG } = require('../lib/config');
const rootdisk = require('../lib/microvm/rootdisk');
const qcow2 = require('../lib/microvm/qcow2');
const plan = require('../lib/microvm/plan');
const run = require('../lib/microvm/run');
const images = require('../lib/oci/images');
const registry = require('../lib/oci/registry');
const { tarBuffer, putLocalImage } = require('./oci-mkimage');
const { openExt4 } = require('./helpers/ext4read');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const QEMU_IMG = require('../lib/platform').findTool('qemu-img');
const CD = 'sha256:' + 'c'.repeat(64);
const quietT = () => { const lines = []; return { lines, log: (m) => lines.push(m), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARN ' + m) }; };

function fakeKernel(o) {
  o = o || {};
  const dir = path.join(CFG.kernelDir, '1.0.0-0-virt');
  const mods = ['virtio_net', 'virtio_blk', 'crc16', 'ext4', 'qemu_fw_cfg', '9p', 'virtio_rng', 'button'];
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'busybox.static'), 'BB');
  fs.writeFileSync(path.join(dir, 'vmlinuz-virt'), 'K');
  for (const m of mods) fs.writeFileSync(path.join(dir, 'modules', m + '.ko'), 'KO-' + m);
  const features = { net: ['virtio_net'], blk: ['virtio_blk'], ext4: ['crc16', 'ext4'], fwcfg: ['qemu_fw_cfg'], ninep: ['9p'], rng: ['virtio_rng'], acpibutton: ['button'] };
  if (o.noExt4) delete features.ext4;
  const manifest = { kver: '1.0.0-0-virt', modules: Object.fromEntries(mods.map((m) => [m, { file: 'modules/' + m + '.ko' }])), features, sha256: { 'busybox.static': 'x' } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

function localImage(name, extra) {
  fs.mkdirSync(CFG.imagesDir, { recursive: true });
  if (!fs.existsSync(path.join(CFG.imagesDir, 'refs.json'))) fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), '{}');
  return putLocalImage(CFG.imagesDir, name, {
    layers: [{ tar: tarBuffer([
      { path: 'etc', type: 'dir' },
      { path: 'etc/passwd', type: 'file', data: 'root:x:0:0:root:/root:/bin/sh\nweb:x:101:101::/srv:/bin/sh\n' },
      { path: 'app', type: 'file', data: 'app-' + name, mode: 0o755 },
      { path: 'lost', type: 'hardlink', linkpath: 'nowhere' }, // a flatten warning
    ].concat(extra || [])) }],
    config: { Cmd: ['/app'], User: 'web' },
  });
}

function age(f, ms) { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); }

test('imageDiskKey: stable, 16 hex, changes with the image and the minimum size; paths under images/disks', () => {
  const root = useTempRoot('rd-key');
  try {
    const k = rootdisk.imageDiskKey({ configDigest: CD, minGB: 8 });
    assert.match(k, /^[a-f0-9]{16}$/);
    assert.equal(rootdisk.imageDiskKey({ configDigest: CD, minGB: 8 }), k);
    assert.notEqual(rootdisk.imageDiskKey({ configDigest: 'sha256:' + 'd'.repeat(64), minGB: 8 }), k);
    assert.notEqual(rootdisk.imageDiskKey({ configDigest: CD, minGB: 9 }), k);
    assert.equal(rootdisk.imageDiskKey({ configDigest: CD }), k, 'default 8 GiB (config.json microvmImageDiskGB unset)');
    const p = rootdisk.imageDiskPaths(CD, k);
    assert.equal(p.file, path.join(CFG.imagesDir, 'disks', 'cccccccccccc-' + k + '.qcow2'));
    assert.equal(p.meta, p.file + '.json');
    assert.throws(() => rootdisk.imageDiskKey({ configDigest: 'nope' }), /bad image config digest/);
    assert.equal(rootdisk.DISK_MIN_MEM_MB, 96);
  } finally { resetConfig(); rm(root); }
});

test('createRootOverlay: an empty qcow2 naming its disk RELATIVELY (forward slashes, format qcow2); never overwritten; qemu-img agrees', async () => {
  const root = useTempRoot('rd-ov');
  try {
    const disk = path.join(CFG.imagesDir, 'disks', 'cccccccccccc-0123456789abcdef.qcow2');
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    const tree = new (require('../lib/oci/layers').RootfsTree)();
    tree.addExtra({ path: 'hello', type: 'file', data: 'hi\n' });
    const st = await require('../lib/microvm/mkext4').buildImageExt4(tree, disk, { key: 'k', minGB: 1 });
    const runDir = path.join(CFG.microvmsDir, 'abcdefabcdef');
    const ov = rootdisk.createRootOverlay(runDir, disk, st.sizeBytes);
    assert.equal(ov.file, path.join(runDir, 'root.qcow2'));
    assert.equal(ov.backing, '../../images/disks/cccccccccccc-0123456789abcdef.qcow2');
    assert.deepEqual(qcow2.readBacking(ov.file), { name: ov.backing, format: 'qcow2' });
    assert.equal(rootdisk.overlayBacking(runDir), path.resolve(disk));
    const h = qcow2.readQcow2Header(fs.readFileSync(ov.file));
    assert.equal(h.size, st.sizeBytes);
    assert.ok(fs.statSync(ov.file).size <= 4 * 65536, 'nothing allocated');
    assert.throws(() => rootdisk.createRootOverlay(runDir, disk, st.sizeBytes), (e) => e.code === 'EEXIST');
    assert.equal(qcow2.readBacking(disk), null, 'the image disk has no backing file');
    assert.equal(rootdisk.overlayBacking(path.join(CFG.microvmsDir, 'nonexistent')), null);
    if (QEMU_IMG) {
      const { runSync } = require('../lib/util');
      const info = JSON.parse(runSync(QEMU_IMG, ['info', '--output=json', ov.file]));
      assert.equal(info['backing-filename'], ov.backing);
      assert.equal(info['backing-filename-format'], 'qcow2');
      assert.equal(info['virtual-size'], st.sizeBytes);
      const check = runSync(QEMU_IMG, ['check', disk]);
      assert.match(check, /No errors were found/);
      assert.match(runSync(QEMU_IMG, ['check', ov.file]), /No errors were found/);
    }
  } finally { resetConfig(); rm(root); }
});

test('checkQemuPathRaw: QEMU joins the overlay folder and the relative backing name without normalising ".."', () => {
  const dir = 'C:\\' + 'd'.repeat(150);
  const joined = dir + '\\microvms\\abcdefabcdef/../../images/disks/' + 'c'.repeat(12) + '-' + '0'.repeat(16) + '.qcow2';
  assert.ok(require('path').win32.resolve(joined).length <= plan.WIN_MAX_PATH, 'the resolved path would pass');
  assert.throws(() => plan.checkQemuPathRaw(joined + 'x'.repeat(260 - joined.length), 'win32'), (e) => e.code === 'PATH_TOO_LONG');
  assert.equal(plan.checkQemuPathRaw(joined, 'win32'), joined);
  assert.equal(plan.checkQemuPathRaw('x'.repeat(400), 'linux'), 'x'.repeat(400));
});

test('ensureDiskInitrd: only the modules the run needs (fw_cfg first, then blk + ext4 + the spec\'s), keyed by them; an old kernel is KERNEL_UPDATE', async () => {
  const root = useTempRoot('rd-initrd');
  try {
    const k = fakeKernel();
    const spec = plan.buildSpec({ cmd: ['/app'] }, { net: false, rng: false, rootfs: 'disk' });
    const a = await rootdisk.ensureDiskInitrd({ kernelDir: k.dir, manifest: k.manifest, spec });
    assert.deepEqual(a.modules, ['qemu_fw_cfg', 'virtio_blk', 'crc16', 'ext4']);
    assert.match(path.basename(a.file), /^disk-[a-f0-9]{16}\.initrd$/);
    assert.equal(a.cached, false);
    const entries = await require('../lib/oci/cpio').listCpioBuffer(fs.readFileSync(a.file));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('.devbox/init') && names.includes('.devbox/busybox'));
    assert.deepEqual(names.filter((n) => n.startsWith('.devbox/modules/')).sort(), ['.devbox/modules/crc16.ko', '.devbox/modules/ext4.ko', '.devbox/modules/qemu_fw_cfg.ko', '.devbox/modules/virtio_blk.ko']);
    assert.ok(!names.includes('.devbox/spec.sh'), 'the spec comes through fw_cfg');
    const again = await rootdisk.ensureDiskInitrd({ kernelDir: k.dir, manifest: k.manifest, spec });
    assert.deepEqual([again.cached, again.file], [true, a.file]);
    const withShares = plan.buildSpec({ cmd: ['/app'] }, { rootfs: 'disk', shares: [{ id: 's1', target: '/w' }], acpiButton: true });
    const b = await rootdisk.ensureDiskInitrd({ kernelDir: k.dir, manifest: k.manifest, spec: withShares });
    assert.notEqual(b.key, a.key);
    assert.deepEqual(b.modules, ['qemu_fw_cfg', 'virtio_net', 'virtio_blk', 'crc16', 'ext4', 'button', 'virtio_rng', '9p']);
    const old = fakeKernel({ noExt4: true });
    assert.throws(() => rootdisk.diskInitrdModules(spec, old.manifest), (e) => e.code === 'KERNEL_UPDATE' && e.status === 409);
  } finally { resetConfig(); rm(root); }
});

test('ensureImageDisk + prepareImage(rootfs disk): built once (concurrent starts too), facts and runtime in the sidecar, index entry, warnings once; a stale sidecar rebuilds', async () => {
  const root = useTempRoot('rd-build');
  try {
    fakeKernel();
    const im = localImage('vdisk');
    const t = quietT();
    const p = await run.prepareImage('vdisk', { pull: 'never', t, rootfs: 'disk' });
    assert.equal(p.rootfs, 'disk');
    assert.equal(p.cached.disk, false);
    assert.equal(p.initrd, null);
    assert.equal(path.dirname(p.disk), path.join(CFG.imagesDir, 'disks'));
    assert.match(path.basename(p.disk), new RegExp('^' + im.config.slice(7, 19) + '-[a-f0-9]{16}\\.qcow2$'));
    assert.equal(p.virtualBytes, 8 * 1073741824);
    assert.match(p.facts.passwd, /^web:x:101:101/m);
    assert.equal(p.runtime.user, 'web');
    assert.ok(p.warnings.some((w) => /hardlink lost -> nowhere/.test(w)));
    assert.ok(t.lines.some((l) => /^STEP Building the disk of vdisk:latest \(1 layer, 1 MB\)/.test(l)), t.lines.join('\n'));
    assert.ok(t.lines.some((l) => /^WARN image: .*hardlink lost/.test(l)));
    const meta = rootdisk.readDiskMeta(im.config);
    assert.ok(meta && meta.key === p.diskKey && meta.facts.passwd && meta.timings.ms >= 0);
    const idx = images.readIndex().images[im.config];
    assert.deepEqual([idx.disk.file, idx.disk.key, idx.disk.virtualBytes], [path.basename(p.disk), p.diskKey, p.virtualBytes]);
    assert.ok(!fs.existsSync(require('../lib/oci/cpio').rootfsPaths(CFG.imagesDir, im.config).meta), 'no RAM-root files for a disk root');
    // the guest's view: the image plus the runtime basics and /.devbox
    const x = openExt4(p.disk);
    try {
      const names = [...x.walk().keys()].sort();
      for (const n of ['.devbox', 'app', 'dev', 'dev/console', 'dev/null', 'etc/passwd', 'proc', 'run', 'sys', 'tmp']) assert.ok(names.includes(n), n);
      assert.equal(x.read(x.inode(x.lookup('app'))).toString(), 'app-vdisk');
      assert.equal(x.inode(x.lookup('tmp')).perm, 0o1777);
    } finally { x.close(); }
    // warm: cached, warnings not logged again
    const t2 = quietT();
    const q = await run.prepareImage('vdisk', { pull: 'never', t: t2, rootfs: 'disk' });
    assert.deepEqual([q.cached.disk, q.disk], [true, p.disk]);
    assert.ok(!t2.lines.some((l) => /^WARN/.test(l)));
    // concurrent first starts build once (the image lock)
    fs.rmSync(p.disk);
    fs.rmSync(p.disk + '.json');
    const rs = await Promise.all([0, 1, 2].map(() => run.prepareImage('vdisk', { pull: 'never', rootfs: 'disk' })));
    assert.equal(rs.filter((r) => !r.cached.disk).length, 1, 'one build, two cache hits');
    // a sidecar of another key (or format) is not this disk's
    const sc = JSON.parse(fs.readFileSync(p.disk + '.json', 'utf8'));
    fs.writeFileSync(p.disk + '.json', JSON.stringify(Object.assign(sc, { key: '0000000000000000' })));
    const s = await run.prepareImage('vdisk', { pull: 'never', rootfs: 'disk' });
    assert.equal(s.cached.disk, false);
    assert.equal(rootdisk.readDiskMeta(im.config).key, s.diskKey);
    assert.deepEqual(fs.readdirSync(path.join(CFG.imagesDir, 'disks')).filter((f) => /\.part$/.test(f)), []);
  } finally { resetConfig(); rm(root); }
});

test('prepareRootByDigest: the overlay\'s own disk; else the current one; rebuilt from cached blobs; IMAGE_GONE without them - never a pull', async () => {
  const root = useTempRoot('rd-bydigest');
  try {
    fakeKernel();
    const im = localImage('vbound');
    const p = await run.prepareImage('vbound', { pull: 'never', rootfs: 'disk' });
    // a container's overlay names an OLDER disk of the image (another key):
    // that one is booted while it exists
    const older = path.join(CFG.imagesDir, 'disks', im.config.slice(7, 19) + '-' + 'f'.repeat(16) + '.qcow2');
    fs.copyFileSync(p.disk, older);
    fs.writeFileSync(older + '.json', JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(p.disk + '.json', 'utf8')), { key: 'f'.repeat(16) })));
    const a = await run.prepareRootByDigest(im.config, { disk: older });
    assert.equal(a.disk, older);
    assert.equal(a.rootfs, 'disk');
    assert.equal(images.readIndex().images[im.config].disk.key, p.diskKey, 'an older disk never replaces the current one in the index');
    const b = await run.prepareRootByDigest(im.config, {});
    assert.deepEqual([b.disk, b.cached.disk], [p.disk, true]);
    // the disk is gone, the blobs are cached: rebuilt (byte-identical), no pull
    const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = sha(p.disk);
    fs.rmSync(p.disk); fs.rmSync(p.disk + '.json');
    const origPull = registry.pullImage;
    registry.pullImage = async () => { throw new Error('no pull for a bound container'); };
    try {
      const c = await run.prepareRootByDigest(im.config, { t: quietT() });
      assert.deepEqual([c.disk, c.cached.disk], [p.disk, false]);
      assert.equal(sha(p.disk), before, 'deterministic: the overlay of a container still matches');
      // and without the layer blob: IMAGE_GONE (409, start it fresh)
      fs.rmSync(p.disk); fs.rmSync(p.disk + '.json');
      const layer = JSON.parse(fs.readFileSync(registry.blobPath(CFG.imagesDir, im.manifest), 'utf8')).layers[0].digest;
      fs.rmSync(registry.blobPath(CFG.imagesDir, layer));
      await assert.rejects(run.prepareRootByDigest(im.config, {}), (e) => e.code === 'IMAGE_GONE' && e.status === 409 && /start it fresh/.test(e.message));
    } finally { registry.pullImage = origPull; }
  } finally { resetConfig(); rm(root); }
});

test('diskReferences / pruneImageDisks: overlay headers, records and live runs keep a disk; an unreadable overlay is conservative; young, indexed and open disks stay; dangling ones and dead .part files go', async () => {
  const root = useTempRoot('rd-gc');
  const origRm = fs.rmSync;
  try {
    const dir = path.join(CFG.imagesDir, 'disks');
    fs.mkdirSync(dir, { recursive: true });
    const OLD = 20 * 60 * 1000;
    const mk = (cfgHex, key, o) => {
      o = o || {};
      const f = path.join(dir, cfgHex.slice(0, 12) + '-' + key + '.qcow2');
      fs.writeFileSync(f, Buffer.alloc(4096));
      if (!o.noMeta) fs.writeFileSync(f + '.json', JSON.stringify({ version: 1, configDigest: 'sha256:' + cfgHex, key }));
      age(f, o.age === undefined ? OLD : o.age);
      return f;
    };
    const h = (c) => c.repeat(64);
    const byOverlay = mk(h('1'), '1'.repeat(16));
    const byRecord = mk(h('2'), '2'.repeat(16));
    const live = mk(h('3'), '3'.repeat(16));
    const young = mk(h('4'), '4'.repeat(16), { age: 1000 });
    const indexed = mk(h('5'), '5'.repeat(16));
    const dangling = mk(h('6'), '6'.repeat(16));
    const noMetaYoung = mk(h('7'), '7'.repeat(16), { noMeta: true, age: 60 * 1000 });
    const busy = mk(h('8'), '8'.repeat(16));
    const byBadOverlay = mk(h('9'), '9'.repeat(16));
    const part = path.join(dir, 'x.qcow2.123.abcd.part');
    fs.writeFileSync(part, 'p'); age(part, 2 * 3600 * 1000);
    const freshPart = path.join(dir, 'y.qcow2.123.abcd.part');
    fs.writeFileSync(freshPart, 'p');
    // an overlay naming byOverlay; an overlay whose header is garbage, of a
    // record bound to image 9
    rootdisk.createRootOverlay(path.join(CFG.microvmsDir, 'aaaaaaaaaaaa'), byOverlay, 1073741824);
    fs.mkdirSync(path.join(CFG.microvmsDir, 'bbbbbbbbbbbb'), { recursive: true });
    fs.writeFileSync(path.join(CFG.microvmsDir, 'bbbbbbbbbbbb', 'root.qcow2'), 'garbage');
    const records = [
      { id: 'cccccccccccc', name: 'rec', rootDisk: { configDigest: 'sha256:' + h('2'), disk: 'images/disks/' + path.basename(byRecord) } },
      { id: 'bbbbbbbbbbbb', name: 'bad', rootDisk: { configDigest: 'sha256:' + h('9'), disk: 'images/disks/elsewhere.qcow2' } },
    ];
    images.updateIndex('sha256:' + h('5'), { disk: { file: path.basename(indexed), key: '5'.repeat(16) } });
    const refs = rootdisk.diskReferences({ records, inUse: [live] });
    assert.match(rootdisk.referenceOf(refs, byOverlay), /writable layer of container "aaaaaaaaaaaa"/);
    assert.match(rootdisk.referenceOf(refs, byRecord), /container "rec" was created from it/);
    assert.match(rootdisk.referenceOf(refs, live), /running container/);
    assert.match(rootdisk.referenceOf(refs, byBadOverlay), /writable layer of container "bad"/, 'unreadable header: every disk of its image');
    assert.equal(rootdisk.referenceOf(refs, dangling), null);
    // Windows refuses to delete a file a QEMU holds open: skipped
    fs.rmSync = function (p, o) { if (path.resolve(String(p)) === path.resolve(busy)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return origRm.call(fs, p, o); };
    const r = await rootdisk.pruneImageDisks({ records, inUse: () => [live] });
    fs.rmSync = origRm;
    const gone = (f) => !fs.existsSync(f);
    assert.ok(gone(dangling) && gone(dangling + '.json'), 'dangling: removed with its sidecar');
    assert.ok(gone(part), 'a dead writer\'s .part');
    for (const f of [byOverlay, byRecord, live, young, indexed, noMetaYoung, busy, byBadOverlay, freshPart]) assert.ok(fs.existsSync(f), path.basename(f));
    const why = (f) => (r.kept.find((k) => k.file === f) || {}).why;
    assert.match(why(busy), /open in a running QEMU/);
    assert.match(why(young), /younger than 10 min/);
    assert.match(why(noMetaYoung), /being built/);
    assert.deepEqual(r.removed.map((f) => path.basename(f)).sort(), [path.basename(dangling), path.basename(part)].sort());
    // the dangling cleanup after a container is removed: no age limit, but a
    // disk without its sidecar may be a build finishing - kept
    fs.rmSync(path.join(CFG.microvmsDir, 'aaaaaaaaaaaa'), { recursive: true });
    const r2 = await rootdisk.pruneImageDisks({ records, inUse: [], minAgeMs: 0 });
    assert.ok(gone(byOverlay) && gone(young) && gone(live) && gone(busy));
    assert.ok(fs.existsSync(byRecord) && fs.existsSync(indexed) && fs.existsSync(noMetaYoung) && fs.existsSync(byBadOverlay));
    assert.ok(r2.removed.length >= 4);
    // disk-root boot archives
    const idir = path.join(CFG.imagesDir, 'initrd');
    fs.mkdirSync(idir, { recursive: true });
    const di = (k, a) => { const f = path.join(idir, 'disk-' + k + '.initrd'); fs.writeFileSync(f, 'x'); age(f, a); return f; };
    const oldI = di('a'.repeat(16), OLD), usedI = di('b'.repeat(16), OLD), youngI = di('c'.repeat(16), 1000);
    const ramI = path.join(idir, 'cccccccccccc-' + 'd'.repeat(16) + '.initrd');
    fs.writeFileSync(ramI, 'x'); age(ramI, OLD);
    const ri = rootdisk.pruneDiskInitrds({ inUse: [usedI] });
    assert.deepEqual(ri.removed, [oldI]);
    assert.ok(fs.existsSync(usedI) && fs.existsSync(youngI) && fs.existsSync(ramI), 'RAM-root initrds are not its business');
    // and the RAM-root GC leaves disk-*.initrd alone
    const di2 = di('e'.repeat(16), OLD);
    images.pruneInitrds({ keep: [], inUse: [], minAgeMs: 0 });
    assert.ok(fs.existsSync(di2));
  } finally { fs.rmSync = origRm; resetConfig(); rm(root); }
});

test('images: a forced rmi keeps the disk a stopped container still boots; prune removes it once that container is gone; usage and the listing show disks; olderThanDays', async () => {
  const root = useTempRoot('rd-images');
  try {
    fakeKernel();
    const a = localImage('vkeep');
    const b = localImage('vold');
    const pa = await run.prepareImage('vkeep', { pull: 'never', rootfs: 'disk' });
    const pb = await run.prepareImage('vold', { pull: 'never', rootfs: 'disk' });
    const runDir = path.join(CFG.microvmsDir, 'aaaaaaaaaaaa');
    rootdisk.createRootOverlay(runDir, pa.disk, pa.virtualBytes);
    const rec = { id: 'aaaaaaaaaaaa', name: 'web', configDigest: a.config, rootDisk: { configDigest: a.config, disk: 'images/disks/' + path.basename(pa.disk) } };
    const u = images.usage();
    assert.ok(u.disks > 0 && u.total === u.blobs + u.rootfs + u.initrd + u.disks);
    const list = await images.listImages({ records: [rec] });
    const A = list.images.find((x) => x.configDigest === a.config);
    assert.ok(A.diskBytes > 0 && A.disk.file === path.basename(pa.disk) && A.unpackedBytes > 0);
    assert.equal(A.compat.engine, 'microvm');
    await assert.rejects(images.removeImage({ image: 'vkeep' }, { records: [rec] }), (e) => e.code === 'IMAGE_IN_USE');
    const r = await images.removeImage({ image: 'vkeep', force: true }, { records: [rec] });
    assert.ok(r.removed);
    assert.ok(fs.existsSync(pa.disk) && fs.existsSync(pa.disk + '.json'), 'kept: the container still boots it');
    assert.ok(r.kept.some((k) => k.file === path.basename(pa.disk) && /writable layer of container "web"/.test(k.why)));
    assert.equal(images.readIndex().images[a.config], undefined, 'dangling: no index entry');
    // the container can still start: bound by digest, the disk is there
    const again = await run.prepareRootByDigest(a.config, { disk: pa.disk });
    assert.equal(again.disk, pa.disk);
    assert.equal(images.readIndex().images[a.config], undefined, 'a restart does not index a dangling disk again');
    // the container goes: the next prune removes the disk
    fs.rmSync(runDir, { recursive: true });
    await images.pruneImages({ records: [], minAgeMs: 0, olderThanDays: 3650 });
    assert.ok(!fs.existsSync(pa.disk), 'the dangling disk went');
    assert.ok(fs.existsSync(pb.disk), 'olderThanDays: an image used today stays');
    const r2 = await images.pruneImages({ records: [], minAgeMs: 0 });
    assert.ok(r2.images.length === 1 && !fs.existsSync(pb.disk), 'unused images go with their disks');
    void b;
  } finally { resetConfig(); rm(root); }
});

// cr-1: a container that is starting holds the image lock while its image
// disk is built; a forced rmi or a prune queued behind that lock must see
// the disk as in use the moment it gets the lock, though no overlay and no
// record names it yet. Driven through the engine's own API (removeImageRoute,
// opPrune) with a Live that claims its disk the way startFlow does.
test('a forced rmi or a prune waiting for the image lock never deletes the disk a starting container just claimed (cr-1)', async () => {
  const root = useTempRoot('rd-race');
  const containers = require('../lib/microvm/containers');
  const store = require('../lib/microvm/store');
  const origEnsure = rootdisk.ensureImageDisk;
  const OLD = 20 * 60 * 1000;
  try {
    containers.load();
    fakeKernel();
    const im = localImage('vrace');
    const p0 = await run.prepareImage('vrace', { pull: 'never', rootfs: 'disk' });
    age(p0.disk, OLD);
    // a start of container B, paused inside the image lock (gate)
    const startB = (id) => {
      const L = new containers._internal.Live(id);
      containers._internal.lives.set(id, L);
      let entered, release;
      const inLock = new Promise((r) => { entered = r; });
      const gate = new Promise((r) => { release = r; });
      rootdisk.ensureImageDisk = async (img, o) => { const d = await origEnsure(img, o); entered(); await gate; return d; };
      const done = run.prepareImage('vrace', { pull: 'never', rootfs: 'disk', onRoot: (r) => { if (r.disk) L.disk = r.disk; } });
      return { L, inLock, release, done };
    };
    const tick = () => new Promise((r) => setTimeout(r, 30));
    // 1. forced rmi asked while B is inside the lock
    const b = startB('bbbbbbbbbbbb');
    await b.inLock;
    const rmi = containers.removeImageRoute({ image: 'vrace', force: true });
    await tick();
    b.release();
    const prep = await b.done;
    const r = await rmi;
    rootdisk.ensureImageDisk = origEnsure;
    assert.ok(r.removed, 'the image itself goes (forced)');
    assert.ok(fs.existsSync(prep.disk) && fs.existsSync(prep.disk + '.json'), 'the disk B claimed stays');
    assert.ok(r.kept.some((k) => k.file === path.basename(prep.disk) && /in use by a running container/.test(k.why)), JSON.stringify(r.kept));
    // B creates its overlay now: the disk is there
    const ov = rootdisk.createRootOverlay(path.join(CFG.microvmsDir, b.L.id), prep.disk, prep.virtualBytes);
    assert.equal(rootdisk.overlayBacking(path.join(CFG.microvmsDir, b.L.id)), path.resolve(prep.disk));
    void ov;
    containers._internal.lives.delete(b.L.id);
    rm(path.join(CFG.microvmsDir, b.L.id));
    // 2. a prune asked before container C existed: C is created (its record
    //    names the image) while the prune waits for the lock C's start holds
    localImage('vrace');
    const p1 = await run.prepareImage('vrace', { pull: 'never', rootfs: 'disk' });
    age(p1.disk, OLD);
    images.updateIndex(im.config, { lastUsed: new Date(Date.now() - 30 * 86400000).toISOString() });
    const c = startB('cccccccccccc');
    await c.inLock;
    const t = { log() {}, step() {}, warn() {} };
    const prune = containers.opPrune(t, { all: true });
    await tick();
    store.put({ id: 'cccccccccccc', name: 'c', image: 'vrace', reference: 'docker.io/library/vrace:latest', configDigest: im.config, status: 'preparing' });
    c.release();
    await c.done;
    const pr = await prune;
    rootdisk.ensureImageDisk = origEnsure;
    assert.deepEqual(pr.images, [], 'the image C uses is not pruned');
    assert.ok(fs.existsSync(p1.disk), 'nor its disk');
    assert.ok(images.readIndex().images[im.config], 'nor its index entry');
    containers._internal.lives.delete('cccccccccccc');
    store.remove('cccccccccccc');
    // 3. a disk that is gone after all: the overlay is refused with the
    //    reason, never created naming a missing file
    fs.rmSync(p1.disk); fs.rmSync(p1.disk + '.json');
    assert.throws(() => rootdisk.createRootOverlay(path.join(CFG.microvmsDir, 'dddddddddddd'), p1.disk, p1.virtualBytes),
      (e) => e.code === 'ROOT_DISK_MISSING' && e.status === 409 && /start it again/.test(e.message));
    assert.ok(!fs.existsSync(path.join(CFG.microvmsDir, 'dddddddddddd', 'root.qcow2')));
  } finally { rootdisk.ensureImageDisk = origEnsure; containers.shutdown(); resetConfig(); rm(root); }
});

// cr-10: GOLDEN. A container's overlay is a block-level copy-on-write of its
// image disk, and a disk that went missing is rebuilt IN PLACE under the
// same name (run.prepareRootByDigest): the bytes of a build must not change
// unless the disk key changes with them. This pins the sha256 of one fixed
// image built through the whole pipeline (layers.buildTree, the runtime
// basics, the /.devbox mount point, the ext4 writer, the qcow2 writer) for
// each combination of the formats in the key.
//
// IF THIS FAILS after a change to any of those: the change alters what is
// written for the same image. Bump mkext4.IMAGE_EXT4_FORMAT (or
// oci/cpio.FORMAT_VERSION / rootdisk.DISK_FORMAT if the change is theirs)
// so existing disks are rebuilt under a NEW name, then add the new sha256
// below under the new key. Never edit a recorded hash.
const GOLDEN_DISKS = {
  'disk1-ext4.2-rootfs.1': 'd8483921139d765349903c44408dc11b5a96e1606c754422a3aed42dfe6f9fe2',
};
test('golden: one fixed image always builds the same image disk for the same disk-key formats (cr-10)', async () => {
  const root = useTempRoot('rd-golden');
  try {
    const cpio = require('../lib/oci/cpio');
    const mkext4 = require('../lib/microvm/mkext4');
    fs.mkdirSync(CFG.imagesDir, { recursive: true });
    fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), '{}');
    const im = putLocalImage(CFG.imagesDir, 'golden', {
      layers: [
        { tar: tarBuffer([
          { path: './', type: 'dir', mode: 0o700, uid: 1000, gid: 1000 },
          { path: 'etc', type: 'dir' },
          { path: 'etc/passwd', type: 'file', data: 'root:x:0:0:root:/root:/bin/sh\nweb:x:101:101::/srv:/bin/sh\n' },
          { path: 'etc/group', type: 'file', data: 'root:x:0:\nweb:x:101:\n' },
          { path: 'srv', type: 'dir', mode: 0o750, uid: 101, gid: 101 },
          { path: 'srv/index.html', type: 'file', data: '<h1>golden</h1>\n', uid: 101, gid: 101, mtime: 1234567890 },
          { path: 'srv/big.bin', type: 'file', data: Buffer.alloc(300000, 7) },
          { path: 'srv/old', type: 'file', data: 'gone in layer 2\n' },
          { path: 'bin', type: 'dir' },
          { path: 'bin/app', type: 'file', data: '#!/bin/sh\necho hi\n', mode: 0o4755 },
          { path: 'bin/sh', type: 'symlink', linkpath: 'app' },
          { path: 'bin/again', type: 'hardlink', linkpath: 'bin/app' },
          { path: 'long', type: 'symlink', linkpath: '/' + 'l'.repeat(80) },
        ]) },
        { tar: tarBuffer([
          { path: 'srv', type: 'dir', mode: 0o750, uid: 101, gid: 101 },
          { path: 'srv/.wh.old', type: 'file' },
          { path: 'srv/new', type: 'file', data: 'layer 2\n' },
        ]) },
      ],
      config: { Cmd: ['/bin/app'], User: 'web' },
    });
    const img = run.cachedImageByConfig(im.config);
    assert.ok(img, 'the image is in the cache');
    const d = await rootdisk.ensureImageDisk(img, {});
    // what the guest sees (so a recorded hash is of a correct build)
    const x = openExt4(d.file);
    try {
      const names = [...x.walk().keys()];
      for (const n of ['.devbox', 'bin/again', 'bin/sh', 'dev/null', 'long', 'proc', 'srv/new', 'srv/index.html', 'tmp']) assert.ok(names.includes(n), n);
      assert.ok(!names.includes('srv/old'), 'the whiteout applied');
      assert.deepEqual([x.inode(2).perm, x.inode(2).uid], [0o755, 0]);
      assert.equal(x.inode(x.lookup('bin/app')).links, 2);
    } finally { x.close(); }
    const got = require('crypto').createHash('sha256').update(fs.readFileSync(d.file)).digest('hex');
    const key = 'disk' + rootdisk.DISK_FORMAT + '-ext4.' + mkext4.IMAGE_EXT4_FORMAT + '-rootfs.' + cpio.FORMAT_VERSION;
    assert.ok(key in GOLDEN_DISKS, 'no golden sha256 for the formats ' + key + ' yet: build the test image, check it (tests/helpers/ext4read.js), and record ' + got + ' under that key');
    assert.equal(got, GOLDEN_DISKS[key], 'the image disk of a fixed image changed for the SAME disk-key formats (' + key + '): bump mkext4.IMAGE_EXT4_FORMAT (see the comment above GOLDEN_DISKS) - overlays of existing disks would read a different file system');
  } finally { resetConfig(); rm(root); }
});

// cr-8: the disk-root boot archive is shared and usually old; a start that
// found it cached a moment ago must not lose it to a prune
test('pruneDiskInitrds reads who uses an archive at each deletion; a cache hit makes the archive young again (cr-8)', async () => {
  const root = useTempRoot('rd-initrd-race');
  try {
    const k = fakeKernel();
    const spec = plan.buildSpec({ cmd: ['/app'] }, { net: false, rng: false, rootfs: 'disk' });
    const a = await rootdisk.ensureDiskInitrd({ kernelDir: k.dir, manifest: k.manifest, spec });
    age(a.file, 20 * 60 * 1000);
    const again = await rootdisk.ensureDiskInitrd({ kernelDir: k.dir, manifest: k.manifest, spec });
    assert.equal(again.cached, true);
    assert.ok(Date.now() - fs.statSync(a.file).mtimeMs < 60000, 'a cache hit refreshes the mtime');
    const r1 = rootdisk.pruneDiskInitrds({});
    assert.ok(fs.existsSync(a.file) && /younger than/.test(r1.kept[0].why));
    // old again, claimed by a live container only after the prune began:
    // the function is read at the deletion
    age(a.file, 20 * 60 * 1000);
    const live = [];
    let reads = 0;
    const r2 = rootdisk.pruneDiskInitrds({ inUse: () => { reads++; if (reads === 1) live.push(a.file); return live; } });
    assert.ok(fs.existsSync(a.file), JSON.stringify(r2));
    assert.match(r2.kept[0].why, /in use/);
    const r3 = rootdisk.pruneDiskInitrds({ inUse: () => [] });
    assert.deepEqual(r3.removed, [a.file]);
  } finally { resetConfig(); rm(root); }
});

// cov-6: a disk without its sidecar is deleted under the locks of every image
// its 12-hex prefix may belong to
test('pruneImageDisks: a disk without a sidecar waits for the locks of the images its name prefix matches (cov-6)', async () => {
  const root = useTempRoot('rd-nometa-lock');
  try {
    const hex = 'e'.repeat(64);
    const cd = 'sha256:' + hex;
    images.updateIndex(cd, { references: ['docker.io/library/x:latest'] });
    images.updateIndex('sha256:' + 'e'.repeat(12) + 'f'.repeat(52), { references: ['docker.io/library/y:latest'] });
    images.updateIndex('sha256:' + 'a'.repeat(64), { references: ['docker.io/library/z:latest'] });
    assert.deepEqual(rootdisk.imagesWithPrefix('e'.repeat(12)), [cd, 'sha256:' + 'e'.repeat(12) + 'f'.repeat(52)].sort());
    const dir = path.join(CFG.imagesDir, 'disks');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, hex.slice(0, 12) + '-' + '0'.repeat(16) + '.qcow2');
    fs.writeFileSync(f, Buffer.alloc(4096));
    age(f, 20 * 60 * 1000);
    let release;
    const held = images.withImageLock(cd, () => new Promise((r) => { release = r; }));
    const pr = rootdisk.pruneImageDisks({ records: [], inUse: [] });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(f), 'not deleted while a build of a matching image holds its lock');
    release();
    await held;
    const r = await pr;
    assert.deepEqual(r.removed, [f]);
  } finally { resetConfig(); rm(root); }
});

// cr-9: QEMU resolves ".." of a relative backing name on the PHYSICAL path
// on Linux/macOS; a symlinked microvms/ (here a junction, which Windows
// treats the same way for this check) gets an absolute name instead
test('backingName: relative while it finds the disk physically; absolute when a linked microvms/ would make ".." miss (cr-9)', () => {
  const root = useTempRoot('rd-backing');
  try {
    const disk = path.join(CFG.imagesDir, 'disks', 'cccccccccccc-0123456789abcdef.qcow2');
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    fs.writeFileSync(disk, Buffer.alloc(4096));
    const runDir = path.join(CFG.microvmsDir, 'abcdefabcdef');
    fs.mkdirSync(runDir, { recursive: true });
    assert.deepEqual(rootdisk.backingName(runDir, disk, 'linux'), { name: '../../images/disks/cccccccccccc-0123456789abcdef.qcow2', absolute: false });
    // microvms/ moved elsewhere and linked back
    const elsewhere = path.join(root, 'other-disk', 'microvms');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.renameSync(CFG.microvmsDir, elsewhere);
    fs.symlinkSync(elsewhere, CFG.microvmsDir, 'junction');
    const b = rootdisk.backingName(runDir, disk, 'linux');
    assert.deepEqual(b, { name: path.resolve(disk), absolute: true });
    assert.equal(rootdisk.backingName(runDir, disk, 'win32').absolute, false, 'Windows collapses ".." textually');
    const ov = rootdisk.createRootOverlay(runDir, disk, 1073741824, { platform: 'linux' });
    assert.equal(ov.absolute, true);
    assert.deepEqual(qcow2.readBacking(ov.file), { name: path.resolve(disk), format: 'qcow2' });
    assert.equal(rootdisk.overlayBacking(runDir), path.resolve(disk), 'the GC sees the disk as it lists it');
    assert.match(rootdisk.referenceOf(rootdisk.diskReferences({ records: [] }), disk), /writable layer/);
    try { fs.unlinkSync(CFG.microvmsDir); } catch (e) { fs.rmdirSync(CFG.microvmsDir); } // the link only
  } finally { resetConfig(); rm(root); }
});

// cr-11: the disk root's size cap before the download
test('prepareImage (disk): an image whose download alone passes microvmImageMaxGB is refused before any layer is fetched (cr-11)', async () => {
  const root = useTempRoot('rd-toolarge');
  const origPull = registry.pullImage;
  const prev = CFG.microvmImageMaxGB;
  try {
    fakeKernel();
    CFG.microvmImageMaxGB = 1;
    let fetched = false;
    const fake = (total) => async (parsed, opts) => {
      await opts.beforeLayers({ layers: [{ digest: 'sha256:' + '1'.repeat(64), size: total }], configDigest: 'sha256:' + '2'.repeat(64), manifestDigest: 'sha256:' + '3'.repeat(64), config: {}, totalCompressed: total, missingBytes: total });
      fetched = true;
      throw Object.assign(new Error('stop here'), { code: 'TEST_STOP' });
    };
    registry.pullImage = fake(2 * 1073741824);
    await assert.rejects(run.prepareImage('vbig', { rootfs: 'disk' }), (e) => e.code === 'IMAGE_TOO_LARGE' && e.status === 409 && /microvmImageMaxGB/.test(e.message));
    assert.equal(fetched, false);
    // probably too large: a warning, the download goes on
    const t = quietT();
    registry.pullImage = fake(512 * 1048576);
    await assert.rejects(run.prepareImage('vbig', { rootfs: 'disk', t }), (e) => e.code === 'TEST_STOP');
    assert.ok(t.lines.some((l) => /^WARN .*probably unpacks to more than the 1 GB limit/.test(l)), t.lines.join('\n'));
  } finally { registry.pullImage = origPull; CFG.microvmImageMaxGB = prev; resetConfig(); rm(root); }
});

test('auto-prune (light profile): off at 0 days; a tick starts an image-prune task for images unused that long', async () => {
  const root = useTempRoot('rd-autoprune');
  const containers = require('../lib/microvm/containers');
  const tasks = require('../lib/tasks');
  const prev = CFG.imagePruneDays;
  try {
    containers.load();
    CFG.imagePruneDays = 0;
    assert.equal(containers._internal.autoPruneTick(), null);
    CFG.imagePruneDays = 7;
    fakeKernel();
    localImage('vrecent');
    await run.prepareImage('vrecent', { pull: 'never', rootfs: 'disk' });
    const t = containers._internal.autoPruneTick();
    assert.ok(t && t.kind === 'image-prune' && /7 days/.test(t.title), JSON.stringify(t));
    const done = await tasks.wait(t.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(done.result.images, [], 'an image used today stays');
    assert.ok(rootdisk.readDiskMeta(images.resolveConfigDigest('vrecent')), 'with its disk');
  } finally { CFG.imagePruneDays = prev; containers.shutdown(); resetConfig(); rm(root); }
});
