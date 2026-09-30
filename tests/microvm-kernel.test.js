'use strict';
/*
 * The microVM kernel: module/config helpers, kernel asset preparation, the
 * "microVM kernel" prerequisite (kernelStatus) and ensureKernel - offline
 * from verified cached packages, and the download path against a local
 * signed mirror (a test RSA key; no network).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const kmod = require('../lib/microvm/kmod');
const kernel = require('../lib/microvm/kernel');
const { testKeys, fakeKernelApks, signedIndex } = require('./microvm-fixtures');

const REAL_ROOT = path.join(__dirname, '..', 'data', 'kernel');
const REAL_DIR = kernel.findKernelDir(REAL_ROOT);

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-kernel-' + tag + '-'));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* busy */ } };
const quietT = () => { const lines = []; return { lines, log: (m) => lines.push(m), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARN ' + m) }; };

test('parseKconfig / kconfigState', () => {
  const cfg = kmod.parseKconfig('CONFIG_A=y\nCONFIG_B=m\n# CONFIG_C is not set\nCONFIG_D="x y"\r\nCONFIG_E=16\n');
  assert.strictEqual(kmod.kconfigState(cfg, 'A'), 'y');
  assert.strictEqual(kmod.kconfigState(cfg, 'CONFIG_B'), 'm');
  assert.strictEqual(kmod.kconfigState(cfg, 'C'), 'n');
  assert.strictEqual(kmod.kconfigState(cfg, 'MISSING'), 'n');
  assert.strictEqual(cfg.get('CONFIG_D'), 'x y');
  assert.strictEqual(kmod.kconfigState(cfg, 'E'), '16');
});

const DEP = [
  'kernel/fs/ext4/ext4.ko.gz: kernel/fs/jbd2/jbd2.ko.gz kernel/fs/mbcache.ko.gz kernel/lib/crc/crc16.ko.gz',
  'kernel/fs/jbd2/jbd2.ko.gz:',
  'kernel/fs/mbcache.ko.gz:',
  'kernel/lib/crc/crc16.ko.gz:',
  'kernel/drivers/net/virtio_net.ko.gz: kernel/drivers/net/net_failover.ko.gz kernel/net/core/failover.ko.gz',
  'kernel/drivers/net/net_failover.ko.gz: kernel/net/core/failover.ko.gz',
  'kernel/net/core/failover.ko.gz:',
  'kernel/drivers/char/hw_random/virtio-rng.ko.gz: kernel/drivers/char/hw_random/rng-core.ko.gz',
  'kernel/drivers/char/hw_random/rng-core.ko.gz:',
].join('\n');

test('resolveModules: dependencies first, each once, builtin and missing reported', () => {
  const dep = kmod.parseModulesDep(DEP);
  const builtin = kmod.parseModulesBuiltin('kernel/drivers/virtio/virtio_pci.ko\nkernel/drivers/char/virtio_console.ko\n');
  const r = kmod.resolveModules(['ext4', 'virtio-net', 'virtio_rng', 'virtio_pci', 'nope', 'failover'], dep, builtin);
  const names = r.order.map(kmod.moduleNameOf);
  assert.deepStrictEqual(names, ['jbd2', 'mbcache', 'crc16', 'ext4', 'failover', 'net_failover', 'virtio_net', 'rng_core', 'virtio_rng']);
  assert.deepStrictEqual(r.builtin, ['virtio_pci']);
  assert.deepStrictEqual(r.missing, ['nope']);
});

test('resolveModules: a dependency cycle is an error', () => {
  const dep = kmod.parseModulesDep('a.ko: b.ko\nb.ko: a.ko\n');
  assert.throws(() => kmod.resolveModules(['a'], dep, new Set()), /cycle/);
});

test('decompressModule: .ko, .ko.gz; .ko.zst depends on zlib.zstdDecompressSync; others throw', () => {
  const raw = Buffer.from('\x7fELF module');
  assert.ok(kmod.decompressModule('x/a.ko', raw).data.equals(raw));
  const gzd = kmod.decompressModule('x/a.ko.gz', zlib.gzipSync(raw));
  assert.strictEqual(gzd.name, 'a.ko');
  assert.ok(gzd.data.equals(raw));
  if (typeof zlib.zstdDecompressSync !== 'function') {
    assert.throws(() => kmod.decompressModule('x/a.ko.zst', Buffer.alloc(8)), /zstd/);
  }
  assert.throws(() => kmod.decompressModule('x/a.ko.xz', Buffer.alloc(8)), /unsupported/);
});

test('modulesFor merges features in order without duplicates; FEATURES has the shared-folder modules', () => {
  const m = { features: { net: ['failover', 'net_failover', 'virtio_net'], rng: ['rng_core', 'virtio_rng'], x: ['failover'] } };
  assert.deepStrictEqual(kernel.modulesFor(m, ['net', 'x', 'rng']), ['failover', 'net_failover', 'virtio_net', 'rng_core', 'virtio_rng']);
  assert.throws(() => kernel.modulesFor(m, ['nope']), /unknown kernel feature/);
  assert.deepStrictEqual(kernel.FEATURES.ninep, ['9pnet_fd', '9p']);
  assert.ok(kernel.FEATURES.fwcfg.includes('qemu_fw_cfg'));
  assert.deepStrictEqual(kernel.missingFeatures({ features: { net: [] } }).includes('ninep'), true);
});

// A synthetic bzImage: setup header fields the extractor reads + a gzip
// payload holding an ELF64 with a PT_NOTE carrying the Xen PVH entry note.
function fakeElf(withPvh) {
  const elf = Buffer.alloc(0x200);
  elf.writeUInt32BE(0x7f454c46, 0); elf[4] = 2; elf[5] = 1;
  elf.writeBigUInt64LE(0x40n, 0x20); // e_phoff
  elf.writeUInt16LE(56, 0x36); elf.writeUInt16LE(1, 0x38);
  const ph = 0x40;
  elf.writeUInt32LE(4, ph); // PT_NOTE
  elf.writeBigUInt64LE(0x100n, ph + 8);
  elf.writeBigUInt64LE(20n, ph + 32);
  elf.writeUInt32LE(4, 0x100); elf.writeUInt32LE(4, 0x104); elf.writeUInt32LE(withPvh ? 18 : 5, 0x108);
  elf.write('Xen\0', 0x10c, 'ascii');
  return elf;
}
function fakeBzImage(payload) {
  const setupSects = 3;
  const pm = (setupSects + 1) * 512;
  const bz = Buffer.alloc(pm + 64 + payload.length + 4);
  bz[0x1f1] = setupSects;
  bz.writeUInt32LE(0x53726448, 0x202); // HdrS
  bz.writeUInt16LE(0x20f, 0x206);
  bz.writeUInt32LE(64, 0x248);
  bz.writeUInt32LE(payload.length + 4, 0x24c);
  payload.copy(bz, pm + 64);
  return bz;
}

test('extractVmlinux + hasPvhNote on a synthetic bzImage', () => {
  const elf = fakeElf(true);
  const out = kernel.extractVmlinux(fakeBzImage(zlib.gzipSync(elf)));
  assert.ok(out.equals(elf));
  assert.strictEqual(kernel.hasPvhNote(out), true);
  assert.strictEqual(kernel.hasPvhNote(fakeElf(false)), false);
  assert.throws(() => kernel.extractVmlinux(fakeBzImage(Buffer.from('(\xb5/\xfdzstd', 'latin1'))), /not gzip/);
  assert.throws(() => kernel.extractVmlinux(Buffer.alloc(1024)), /not a bzImage/);
});

test('real assets (read only): manifest, built-in drivers, module files, PVH note', { skip: !REAL_DIR && 'kernel assets not prepared' }, () => {
  const m = kernel.loadManifest(REAL_DIR);
  assert.match(m.kver, /-virt$/);
  assert.deepStrictEqual(m.features.ext4, ['crc16', 'mbcache', 'jbd2', 'ext4']);
  assert.deepStrictEqual(m.features.net, ['failover', 'net_failover', 'virtio_net', 'af_packet']);
  for (const [name, mod] of Object.entries(m.modules)) {
    const b = fs.readFileSync(path.join(REAL_DIR, mod.file));
    assert.strictEqual(b.readUInt32BE(0), 0x7f454c46, name + ' is an ELF .ko');
    assert.strictEqual(b.length, mod.size);
  }
  const cfg = kmod.parseKconfig(fs.readFileSync(path.join(REAL_DIR, 'config-virt'), 'utf8'));
  for (const s of kernel.BUILTIN_EXPECTED) assert.strictEqual(kmod.kconfigState(cfg, s), 'y', s);
  for (const s of ['VIRTIO_NET', 'VIRTIO_BLK', 'EXT4_FS', 'OVERLAY_FS', 'PACKET', 'VSOCKETS', '9P_FS', 'NET_9P', 'NET_9P_FD', 'FW_CFG_SYSFS']) assert.strictEqual(kmod.kconfigState(cfg, s), 'm', s);
  assert.strictEqual(kmod.kconfigState(cfg, 'MODULE_COMPRESS_GZIP'), 'y');
  const vmlinux = kernel.extractVmlinux(fs.readFileSync(path.join(REAL_DIR, 'vmlinuz-virt')));
  assert.strictEqual(kernel.hasPvhNote(vmlinux), true);
  const s = kernel.kernelStatus({ root: REAL_ROOT, fresh: true });
  assert.strictEqual(s.ok, true, s.error);
  assert.strictEqual(s.kver, m.kver);
});

// ---------------------------------------------------------------------------
// ensureKernel / kernelStatus on synthetic, signed packages
// ---------------------------------------------------------------------------
test('ensureKernel offline: verified cached packages -> <kver>/ (atomic), status ok, idempotent', async () => {
  const root = tmpRoot('offline');
  try {
    const k = testKeys();
    const pk = fakeKernelApks(k);
    assert.strictEqual(kernel.kernelStatus({ root }).installed, false);
    fs.writeFileSync(path.join(root, 'linux-virt-9.9.9-r0.apk'), pk.kernel.buf);
    fs.writeFileSync(path.join(root, 'busybox-static-1.99.0-r1.apk'), pk.busybox.buf);
    // leftovers of an interrupted run are cleaned up
    fs.mkdirSync(path.join(root, 'k.tmp-deadbeef'));
    const t = quietT();
    const r = await kernel.ensureKernel(t, { root, keys: k.keys, skipHostFacts: true, mirror: 'http://127.0.0.1:1/' });
    assert.strictEqual(r.source, 'cached');
    assert.strictEqual(r.kver, pk.kver);
    assert.strictEqual(r.bytesDownloaded, 0);
    assert.ok(t.lines.some((l) => /no download needed/.test(l)), t.lines.join('\n'));
    assert.ok(!fs.existsSync(path.join(root, 'k.tmp-deadbeef')));
    const dir = path.join(root, pk.kver);
    const m = kernel.loadManifest(dir);
    assert.deepStrictEqual(Object.keys(m.features).sort(), Object.keys(kernel.FEATURES).sort());
    // dependencies before the modules that need them (modules.dep order)
    assert.deepStrictEqual(m.features.ninep, ['9pnet', '9pnet_fd', 'netfs', '9p']);
    assert.strictEqual(m.sources.kernel.signedBy, k.name);
    const s = kernel.kernelStatus({ root, fresh: true });
    assert.deepStrictEqual([s.ok, s.installed, s.needsUpdate, s.kver], [true, true, false, pk.kver]);
    // a second run changes nothing
    const again = await kernel.ensureKernel(quietT(), { root, keys: k.keys, skipHostFacts: true });
    assert.strictEqual(again.source, 'installed');
    // a damaged vmlinuz is noticed (and the cache is per manifest mtime: fresh)
    fs.appendFileSync(path.join(dir, 'vmlinuz-virt'), 'x');
    const bad = kernel.kernelStatus({ root, fresh: true });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /vmlinuz-virt does not match/);
    // ...and repaired by the next ensureKernel (prepared again, swapped in)
    const fixed = await kernel.ensureKernel(quietT(), { root, keys: k.keys, skipHostFacts: true });
    assert.strictEqual(fixed.source, 'cached');
    assert.strictEqual(kernel.kernelStatus({ root, fresh: true }).ok, true);
    assert.deepStrictEqual(fs.readdirSync(root).filter((f) => /\.(tmp|old)-/.test(f)), [], 'no temp dirs left');
  } finally { rm(root); }
});

test('kernelStatus: a manifest without the shared-folder modules is usable but needsUpdate', () => {
  const root = tmpRoot('outdated');
  try {
    const dir = path.join(root, '1.2.3-0-virt');
    fs.mkdirSync(dir, { recursive: true });
    const crypto = require('crypto');
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    fs.writeFileSync(path.join(dir, 'vmlinuz-virt'), 'k');
    fs.writeFileSync(path.join(dir, 'busybox.static'), 'b');
    const features = Object.assign({}, ...Object.keys(kernel.FEATURES).filter((f) => f !== 'ninep').map((f) => ({ [f]: [] })));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kver: '1.2.3-0-virt', features, modules: {}, sha256: { 'vmlinuz-virt': sha('k'), 'busybox.static': sha('b') } }));
    const s = kernel.kernelStatus({ root, fresh: true });
    assert.deepStrictEqual([s.ok, s.needsUpdate, s.missingFeatures], [true, true, ['ninep']]);
    // .tmp-/.old- directories are never picked
    fs.mkdirSync(path.join(root, '9.0.0-0-virt.old-abcdef'));
    fs.writeFileSync(path.join(root, '9.0.0-0-virt.old-abcdef', 'manifest.json'), '{}');
    assert.strictEqual(path.basename(kernel.findKernelDir(root)), '1.2.3-0-virt');
  } finally { rm(root); }
});

// A local "mirror": <branch>/main/x86_64/APKINDEX.tar.gz + the packages
function mirror(files) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const f = files[req.url];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': f.length });
    res.end(f);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, url: 'http://127.0.0.1:' + srv.address().port + '/' })));
}

test('ensureKernel download path: signed index -> current versions -> verified packages (local mirror, no network)', async () => {
  const root = tmpRoot('download');
  const k = testKeys();
  const pk = fakeKernelApks(k);
  const repo = '/v3.23/main/x86_64/';
  const m = await mirror({
    [repo + 'APKINDEX.tar.gz']: signedIndex([pk.kernel.entry, pk.busybox.entry, { P: 'other', V: '1-r0', S: '1', C: 'Q1x' }], k),
    [repo + 'linux-virt-9.9.9-r0.apk']: pk.kernel.buf,
    [repo + 'busybox-static-1.99.0-r1.apk']: pk.busybox.buf,
  });
  try {
    const t = quietT();
    const r = await kernel.ensureKernel(t, { root, keys: k.keys, skipHostFacts: true, mirror: m.url, allowHttp: true });
    assert.strictEqual(r.source, 'download');
    assert.strictEqual(r.bytesDownloaded, pk.kernel.buf.length + pk.busybox.buf.length);
    assert.ok(t.lines.some((l) => l === 'Package index verified (signed with ' + k.name + ').'), t.lines.join('\n'));
    assert.ok(fs.existsSync(path.join(root, 'linux-virt-9.9.9-r0.apk')));
    assert.strictEqual(kernel.kernelStatus({ root, fresh: true }).ok, true);
    assert.deepStrictEqual(fs.readdirSync(root).filter((f) => /\.part$/.test(f)), []);
    // update: the index is read again, the verified cached packages are reused
    m.hits.length = 0;
    const u = await kernel.ensureKernel(quietT(), { root, keys: k.keys, skipHostFacts: true, mirror: m.url, allowHttp: true, update: true });
    assert.strictEqual(u.bytesDownloaded, 0);
    assert.deepStrictEqual(m.hits, [repo + 'APKINDEX.tar.gz']);
  } finally { m.srv.close(); rm(root); }
});

test('ensureKernel download path: a tampered package or a forged index never lands (bug C)', async () => {
  const k = testKeys();
  const pk = fakeKernelApks(k);
  const repo = '/v3.23/main/x86_64/';
  const evil = Buffer.from(pk.kernel.buf);
  evil[evil.length - 40] ^= 1; // same size, different data member
  const m = await mirror({
    [repo + 'APKINDEX.tar.gz']: signedIndex([pk.kernel.entry, pk.busybox.entry], k),
    [repo + 'linux-virt-9.9.9-r0.apk']: evil,
    [repo + 'busybox-static-1.99.0-r1.apk']: pk.busybox.buf,
  });
  const root = tmpRoot('tamper');
  try {
    await assert.rejects(kernel.ensureKernel(quietT(), { root, keys: k.keys, skipHostFacts: true, mirror: m.url, allowHttp: true }), /mismatch/);
    assert.ok(!fs.existsSync(path.join(root, 'linux-virt-9.9.9-r0.apk')), 'nothing unverified at the final path');
    assert.strictEqual(kernel.findKernelDir(root), null);
  } finally { rm(root); }
  // an index signed by a key the app does not ship
  const other = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = { name: k.name, key: other.privateKey };
  const m2 = await mirror({ [repo + 'APKINDEX.tar.gz']: signedIndex([pk.kernel.entry, pk.busybox.entry], forged) });
  const root2 = tmpRoot('forged');
  try {
    await assert.rejects(kernel.ensureKernel(quietT(), { root: root2, keys: k.keys, skipHostFacts: true, mirror: m2.url, allowHttp: true }), /signature does not match/);
    assert.ok(!fs.existsSync(path.join(root2, '.index', 'APKINDEX.tar.gz')), 'the forged index was not kept');
  } finally { m.srv.close(); m2.srv.close(); rm(root2); }
});

test('ensureKernel is serialised: concurrent calls share one run', async () => {
  const root = tmpRoot('serial');
  try {
    const k = testKeys();
    const pk = fakeKernelApks(k);
    fs.writeFileSync(path.join(root, 'linux-virt-9.9.9-r0.apk'), pk.kernel.buf);
    fs.writeFileSync(path.join(root, 'busybox-static-1.99.0-r1.apk'), pk.busybox.buf);
    const o = { root, keys: k.keys, skipHostFacts: true };
    const [a, b] = await Promise.all([kernel.ensureKernel(quietT(), o), kernel.ensureKernel(quietT(), o)]);
    assert.strictEqual(a, b);
  } finally { rm(root); }
});

// The real Alpine packages downloaded earlier (data/kernel, read only):
// prepared again, offline, into a temp root - with the shared-folder modules
test('real cached packages: ensureKernel prepares them offline, 9p modules included', { skip: !(REAL_DIR && kernel.findCachedApks(REAL_ROOT).kernel) && 'no cached kernel packages' }, async () => {
  const root = tmpRoot('real');
  try {
    const c = kernel.findCachedApks(REAL_ROOT);
    fs.copyFileSync(c.kernel.path, path.join(root, path.basename(c.kernel.path)));
    fs.copyFileSync(c.busybox.path, path.join(root, path.basename(c.busybox.path)));
    const r = await kernel.ensureKernel(quietT(), { root, skipHostFacts: true });
    assert.strictEqual(r.source, 'cached');
    const m = kernel.loadManifest(r.dir);
    assert.deepStrictEqual(m.features.ninep, ['netfs', '9pnet', '9pnet_fd', '9p']);
    for (const n of ['netfs', '9pnet', '9pnet_fd', '9p', 'qemu_fw_cfg']) assert.ok(m.modules[n], n);
    assert.match(m.sources.kernel.signedBy, /^alpine-devel@lists\.alpinelinux\.org-/);
  } finally { rm(root); }
});
