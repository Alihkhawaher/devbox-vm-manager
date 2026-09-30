'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');
const cpio = require('../lib/oci/cpio');
const fx = require('./oci-fixtures');

const { CpioWriter, readCpio, listCpio, checkInitramfs, flattenToCpio, ensureRootfsCpio } = cpio;

let tmp;
test.before(() => { tmp = fx.tmpDir('cpio'); });
test.after(() => fx.rmrf(tmp));

/** Collect everything written to a PassThrough into one Buffer. */
function sinkBuffer() {
  const s = new PassThrough();
  const parts = [];
  s.on('data', (c) => parts.push(c));
  return { stream: s, buffer: () => Buffer.concat(parts) };
}

async function* chunked(buf, size) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }

async function readAllCpio(buf, chunk) {
  const out = [];
  for await (const e of readCpio(chunked(buf, chunk || 999))) {
    const parts = [];
    for await (const c of e.body()) parts.push(Buffer.from(c));
    const copy = Object.assign({}, e, { data: Buffer.concat(parts) });
    delete copy.body;
    out.push(copy);
  }
  return out;
}

test('writer/reader round trip: every type, padding for all name/data lengths, streamed data', async () => {
  const s = sinkBuffer();
  const w = new CpioWriter(s.stream);
  await w.add({ path: '.', type: 'dir', mode: 0o755 });
  await w.add({ path: '/d', type: 'dir', mode: 0o700, uid: 1000, gid: 1001, mtime: 1700000000 });
  const expect = {};
  for (let n = 1; n <= 9; n++) {
    const name = 'd/' + 'n'.repeat(n);
    const data = Buffer.alloc(n - 1, 0x30 + n);
    await w.add({ path: name, type: 'file', mode: 0o644, size: data.length }, data);
    expect[name] = data;
  }
  async function* gen() { yield Buffer.alloc(100000, 1); yield Buffer.alloc(1, 2); }
  await w.add({ path: 'd/streamed', type: 'file', mode: 0o4755, size: 100001 }, gen());
  await w.add({ path: 'd/link', type: 'symlink', linkpath: '../target/üñí' });
  await w.add({ path: 'd/console', type: 'char', mode: 0o600, rdevmajor: 5, rdevminor: 1 });
  await w.add({ path: 'd/sda', type: 'block', mode: 0o660, rdevmajor: 8, rdevminor: 0 });
  await w.add({ path: 'd/fifo', type: 'fifo', mode: 0o644 });
  await w.add({ path: 'd/h1', type: 'file', mode: 0o755, ino: 777, nlink: 2, size: 0 }, null);
  await w.add({ path: 'd/h2', type: 'file', mode: 0o755, ino: 777, nlink: 2, size: 4 }, Buffer.from('HARD'));
  const total = await w.finish();
  const buf = s.buffer();
  assert.equal(total, buf.length);
  assert.equal(buf.length % 512, 0, 'padded to 512');
  const es = await readAllCpio(buf, 97);
  const by = Object.fromEntries(es.map((e) => [e.name, e]));
  assert.equal(es[0].name, '.');
  assert.equal(by.d.type, 'dir');
  assert.equal(by.d.perm, 0o700);
  assert.equal(by.d.uid, 1000);
  assert.equal(by.d.gid, 1001);
  assert.equal(by.d.mtime, 1700000000);
  for (const [name, data] of Object.entries(expect)) assert.ok(by[name].data.equals(data), name);
  assert.equal(by['d/streamed'].size, 100001);
  assert.equal(by['d/streamed'].perm, 0o4755);
  assert.equal(by['d/streamed'].data[100000], 2);
  assert.equal(by['d/link'].type, 'symlink');
  assert.equal(by['d/link'].data.toString(), '../target/üñí');
  assert.equal(by['d/console'].type, 'char');
  assert.equal(by['d/console'].rdevmajor, 5);
  assert.equal(by['d/console'].rdevminor, 1);
  assert.equal(by['d/sda'].type, 'block');
  assert.equal(by['d/fifo'].type, 'fifo');
  assert.equal(by['d/h1'].ino, by['d/h2'].ino);
  assert.equal(by['d/h2'].data.toString(), 'HARD');
  for (const e of es) assert.equal(e.offset % 4, 0, `${e.name} header is 4-byte aligned`);
  const auto = es.filter((e) => e.name !== 'd/h1' && e.name !== 'd/h2').map((e) => e.ino);
  assert.equal(new Set(auto).size, auto.length, 'automatic inode numbers are unique');
  assert.ok(!auto.includes(777));
  const chk = checkInitramfs(es);
  assert.deepEqual(chk.errors, []);
  assert.equal(chk.stats.hardlinkGroups, 1);
});

test('writer rejects bad sizes, unsafe or overlong names, out-of-range fields', async () => {
  const w = () => new CpioWriter(new PassThrough());
  async function* two() { yield Buffer.from('ab'); }
  await assert.rejects(w().add({ path: 'f', type: 'file', size: 3 }, two()), (e) => e.code === 'CPIO_SIZE');
  await assert.rejects(w().add({ path: 'f', type: 'file', size: 1 }, two()), (e) => e.code === 'CPIO_SIZE');
  await assert.rejects(w().add({ path: 'f', type: 'file', size: 5 }, Buffer.from('ab')), (e) => e.code === 'CPIO_SIZE');
  await assert.rejects(w().add({ path: 'f', type: 'file', size: 5 }, null), (e) => e.code === 'CPIO_SIZE');
  await assert.rejects(w().add({ path: 'a/../../b', type: 'dir' }), (e) => e.code === 'CPIO_NAME');
  await assert.rejects(w().add({ path: 'x'.repeat(4096), type: 'dir' }), (e) => e.code === 'CPIO_NAME');
  await assert.rejects(w().add({ path: 'big', type: 'file', size: 2 ** 32 }, two()), (e) => e.code === 'CPIO_RANGE');
  await assert.rejects(w().add({ path: 'u', type: 'dir', uid: -1 }), (e) => e.code === 'CPIO_RANGE');
  await assert.rejects(w().add({ path: 's', type: 'symlink' }), (e) => e.code === 'CPIO_TYPE');
  await assert.rejects(w().add({ path: 's', type: 'socketish' }), (e) => e.code === 'CPIO_TYPE');
  const ok = w();
  await ok.add({ path: 'x'.repeat(4095), type: 'dir' });
  await ok.add({ path: 'future', type: 'dir', mtime: 2 ** 40 }); // clamped, not an error
});

test('concatenated archives (raw and gzip members) read back in order; later wins', async () => {
  const mk = async (entries) => {
    const s = sinkBuffer();
    const w = new CpioWriter(s.stream);
    for (const [p, d] of entries) await w.add({ path: p, type: d == null ? 'dir' : 'file', mode: 0o644 }, d == null ? null : Buffer.from(d));
    await w.finish();
    return s.buffer();
  };
  const a = await mk([['etc', null], ['etc/x', 'from-image'], ['etc/y', 'y']]);
  const b = await mk([['etc', null], ['etc/x', 'from-init'], ['init', '#!']]);
  const raw = await readAllCpio(Buffer.concat([a, b]));
  assert.deepEqual(raw.map((e) => `${e.archive}:${e.name}`), ['0:etc', '0:etc/x', '0:etc/y', '1:etc', '1:etc/x', '1:init']);
  const f = path.join(tmp, 'concat.cpio.gz');
  fs.writeFileSync(f, Buffer.concat([zlib.gzipSync(a), zlib.gzipSync(b)]));
  const listed = await listCpio(f);
  assert.equal(listed.archives, 2);
  assert.equal(listed.bytes, a.length + b.length);
  const last = {};
  for (const e of listed.entries) last[e.name] = e.data.toString();
  assert.equal(last['etc/x'], 'from-init');
  assert.equal(last['etc/y'], 'y');
  assert.deepEqual(checkInitramfs(listed.entries).errors, []);
  await assert.rejects(readAllCpio(Buffer.from('this is not a cpio archive at all, not even close........................................................')), (e) => e.code === 'CPIO_FORMAT');
});

test('checkInitramfs flags child-before-parent and broken hard-link groups', () => {
  const E = (name, type, extra) => Object.assign({ name, archive: 0, type, mode: 0, ino: 1, nlink: 1, size: 0 }, extra);
  const r = checkInitramfs([
    E('a/b', 'file'),
    E('a', 'dir'),
    E('h1', 'file', { ino: 9, mode: 0o100644, nlink: 3, size: 2 }),
    E('h2', 'file', { ino: 9, mode: 0o100644, nlink: 3, size: 2 }),
    E('../x', 'file'),
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /before its parent/.test(e)));
  assert.ok(r.errors.some((e) => /2 members but nlink 3/.test(e)));
  assert.ok(r.errors.some((e) => /carries data on 2 members/.test(e)));
  assert.ok(r.errors.some((e) => /unsafe name/.test(e)));
});

// ---------------------------------------------------------------- image -> cpio

function syntheticImage(dir) {
  const l1 = fx.writeLayer(path.join(dir, 'l1'), [
    { path: 'bin', type: 'dir' }, { path: 'bin/busybox', data: Buffer.alloc(5000, 0xbb), mode: 0o755 },
    { path: 'bin/sh', type: 'hardlink', linkpath: 'bin/busybox' }, { path: 'bin/ls', type: 'hardlink', linkpath: 'bin/busybox' },
    { path: 'etc', type: 'dir' }, { path: 'etc/passwd', data: 'root:x:0:0:root:/root:/bin/sh\n' },
    { path: 'etc/old', data: 'old' }, { path: 'lib', type: 'symlink', linkpath: 'usr/lib' },
    { path: 'usr/lib', type: 'dir' }, { path: 'usr/lib/libc.so', data: Buffer.alloc(3000, 0xcc) },
    { path: 'root', type: 'dir', mode: 0o700 },
  ]);
  const l2 = fx.writeLayer(path.join(dir, 'l2'), [
    { path: 'etc/.wh.old', data: '' }, { path: 'app', type: 'dir', uid: 101, gid: 101 },
    { path: 'app/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755, uid: 101, gid: 101 },
    { path: 'lib/extra.so', data: 'via-symlink' },
  ]);
  const layers = [l1, l2].map((l) => ({ digest: l.digest, size: l.size, path: l.path, diffId: l.diffId, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }));
  return {
    reference: 'example.test/synthetic:1',
    manifestDigest: 'sha256:' + fx.sha256(Buffer.from('synthetic-manifest')),
    configDigest: 'sha256:' + fx.sha256(Buffer.from('synthetic-config')),
    platform: { os: 'linux', architecture: 'amd64' },
    config: { os: 'linux', architecture: 'amd64', config: { Entrypoint: ['/app/run.sh'], Cmd: ['--x'], Env: ['PATH=/bin'], User: '101', WorkingDir: '/app', ExposedPorts: { '80/tcp': {} } }, rootfs: { type: 'layers', diff_ids: [l1.diffId, l2.diffId] } },
    layers,
    totalCompressed: l1.size + l2.size,
    downloadedBytes: 0,
    timings: {},
  };
}

test('flattenToCpio: synthetic image -> valid initramfs (raw and gzip), basics added, runtime config', async () => {
  const img = syntheticImage(path.join(tmp, 'img'));
  const rawOut = path.join(tmp, 'out', 'synthetic.cpio');
  const gzOut = path.join(tmp, 'out', 'synthetic.cpio.gz');
  const r = await flattenToCpio(img.reference, rawOut, { image: img });
  const g = await flattenToCpio(img.reference, gzOut, { image: img, gzipLevel: 9 });
  assert.equal(r.compress, 'none');
  assert.equal(g.compress, 'gzip');
  assert.equal(fs.statSync(rawOut).size, r.cpioBytes);
  assert.equal(r.outputBytes, r.cpioBytes);
  assert.equal(fs.statSync(gzOut).size, g.outputBytes);
  assert.ok(zlib.gunzipSync(fs.readFileSync(gzOut)).equals(fs.readFileSync(rawOut)), 'gzip output is the same archive');
  assert.ok(!fs.existsSync(rawOut + '.part'));
  assert.deepEqual(r.runtime.argv, ['/app/run.sh', '--x']);
  assert.equal(r.runtime.user, '101');
  assert.deepEqual(r.runtime.exposedPorts, ['80/tcp']);
  assert.deepEqual(r.added.sort(), ['dev', 'dev/console', 'dev/null', 'proc', 'run', 'sys', 'tmp']);

  const listed = await listCpio(rawOut);
  const chk = checkInitramfs(listed.entries);
  assert.deepEqual(chk.errors, []);
  assert.equal(listed.entries.length, r.entries);
  const by = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
  assert.equal(listed.entries[0].name, '.');
  assert.equal(by['.'].perm, 0o755);
  assert.equal(by['dev/console'].type, 'char');
  assert.equal(by.tmp.perm, 0o1777);
  assert.equal(by.root.perm, 0o700);
  assert.equal(by['etc/old'], undefined);
  assert.equal(by['usr/lib/extra.so'].data.toString(), 'via-symlink');
  assert.equal(by.lib.type, 'symlink');
  assert.equal(by['app/run.sh'].uid, 101);
  const bb = ['bin/busybox', 'bin/sh', 'bin/ls'].map((p) => by[p]);
  assert.equal(new Set(bb.map((e) => e.ino)).size, 1);
  assert.ok(bb.every((e) => e.nlink === 3));
  assert.equal(bb.filter((e) => e.size === 5000).length, 1);
  assert.equal(r.rootfs.hardlinkPaths, 2);
  assert.equal(r.rootfs.bytes, 5000 + 3000 + 30 + 18 + 11);
});

test('flattenToCpio: a Writable output is not ended, so an init archive can follow', async () => {
  const img = syntheticImage(path.join(tmp, 'img2'));
  const file = path.join(tmp, 'combined.initrd');
  const ws = fs.createWriteStream(file);
  const r = await flattenToCpio(img.reference, ws, { image: img, compress: 'gzip' });
  assert.equal(ws.writableEnded, false);
  assert.equal(r.outputBytes % 512, 0, 'gzip member zero-padded so a raw archive can follow');
  const w = new CpioWriter(ws);
  await w.add({ path: '.devbox', type: 'dir' });
  await w.add({ path: '.devbox/init', type: 'file', mode: 0o755 }, Buffer.from('#!/bin/sh\n'));
  await w.finish();
  await new Promise((res) => { ws.on('close', res); ws.end(); });
  // gzip member + zeros, then a raw archive: what the kernel accepts.
  const listed = await listCpio(file);
  assert.deepEqual(listed.segments.map((s) => s.compression), ['gzip', 'none']);
  assert.equal(listed.segments[1].offset, r.outputBytes);
  assert.equal(listed.archives, 2);
  const last = listed.entries[listed.entries.length - 1];
  assert.equal(last.name, '.devbox/init');
  assert.equal(last.archive, 1);
  assert.deepEqual(checkInitramfs(listed.entries).errors, []);
});

test('readInitrd walks raw/gzip/zero segments like the kernel and enforces 4-byte alignment', async () => {
  const mk = async (name, n) => {
    const s = sinkBuffer();
    const w = new CpioWriter(s.stream);
    for (let i = 0; i < n; i++) await w.add({ path: `${name}${i}`, type: 'file', mode: 0o644 }, Buffer.from(`${name}-${i}`));
    await w.finish({ padTo: 4 });
    return s.buffer();
  };
  const [a, b, c, d] = [await mk('a', 2), await mk('b', 3), await mk('c', 1), await mk('d', 2)];
  const pad = (buf, to) => Buffer.concat([buf, Buffer.alloc((to - (buf.length % to)) % to)]);
  const good = Buffer.concat([a, pad(zlib.gzipSync(b), 4), c, Buffer.alloc(64), zlib.gzipSync(Buffer.concat([d, d]))]);
  const f1 = path.join(tmp, 'mixed.initrd');
  fs.writeFileSync(f1, good);
  const l1 = await listCpio(f1);
  assert.deepEqual(l1.segments.map((s) => s.compression), ['none', 'gzip', 'none', 'gzip']);
  assert.equal(l1.archives, 5);
  assert.deepEqual(l1.entries.map((e) => `${e.archive}:${e.name}`), ['0:a0', '0:a1', '1:b0', '1:b1', '1:b2', '2:c0', '3:d0', '3:d1', '4:d0', '4:d1']);
  assert.equal(l1.bytes, a.length + b.length + c.length + 2 * d.length);
  // A gzip member whose length is not a multiple of 4, then a raw archive: the kernel panics.
  let gz = null;
  for (let level = 1; level <= 9 && !gz; level++) { const g = zlib.gzipSync(b, { level }); if (g.length % 4) gz = g; }
  for (let extra = 1; !gz; extra++) { const g = zlib.gzipSync(Buffer.concat([b, Buffer.alloc(extra)])); if (g.length % 4) gz = g; }
  const f2 = path.join(tmp, 'unaligned.initrd');
  fs.writeFileSync(f2, Buffer.concat([gz, c]));
  await assert.rejects(listCpio(f2), (e) => e.code === 'CPIO_FORMAT' && /unaligned offset/.test(e.message));
  const f3 = path.join(tmp, 'zstd.initrd');
  fs.writeFileSync(f3, Buffer.concat([a, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4])]));
  await assert.rejects(listCpio(f3), (e) => e.code === 'CPIO_COMPRESSION' && /zstd/.test(e.message));
});

test('ensureRootfsCpio caches by config digest (image ID) and refuses extras', async () => {
  const img = syntheticImage(path.join(tmp, 'img3'));
  const root = path.join(tmp, 'cache');
  const a = await ensureRootfsCpio(img.reference, { root, image: img });
  const b = await ensureRootfsCpio(img.reference, { root, image: img });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(a.path, b.path);
  assert.equal(path.basename(a.path), img.configDigest.slice(7) + '-v1.cpio');
  assert.equal(b.meta.cpioBytes, fs.statSync(a.path).size);
  // another manifest (e.g. recompressed layers) with the same config shares it
  const other = Object.assign({}, img, { manifestDigest: 'sha256:' + fx.sha256(Buffer.from('other-manifest')) });
  const o = await ensureRootfsCpio(img.reference, { root, image: other });
  assert.equal(o.cached, true);
  assert.equal(o.path, a.path);
  const c = await ensureRootfsCpio(img.reference, { root, image: img, compress: 'gzip' });
  assert.ok(c.path.endsWith('.cpio.gz'));
  await assert.rejects(ensureRootfsCpio(img.reference, { root, image: img, extras: [{ path: 'x', type: 'dir' }] }), TypeError);
});

test('ensureRootfsCpio adopts an archive cached under the manifest digest (first layout)', async () => {
  const img = syntheticImage(path.join(tmp, 'img5'));
  const root = path.join(tmp, 'cache-legacy');
  const dir = path.join(root, 'rootfs');
  const legacy = path.join(dir, img.manifestDigest.slice(7) + '-v1.cpio');
  const r = await flattenToCpio(img.reference, legacy, { image: img });
  fs.writeFileSync(legacy + '.json', JSON.stringify(r));
  const bytes = fs.readFileSync(legacy);
  const a = await ensureRootfsCpio(img.reference, { root, image: img });
  assert.equal(a.cached, true);
  assert.equal(a.migrated, legacy);
  assert.equal(path.basename(a.path), img.configDigest.slice(7) + '-v1.cpio');
  assert.ok(fs.readFileSync(a.path).equals(bytes));
  assert.ok(!fs.existsSync(legacy) && !fs.existsSync(legacy + '.json'));
  // a legacy archive of a DIFFERENT config is not adopted
  const img2 = syntheticImage(path.join(tmp, 'img6'));
  const root2 = path.join(tmp, 'cache-legacy2');
  const legacy2 = path.join(root2, 'rootfs', img2.manifestDigest.slice(7) + '-v1.cpio');
  const r2 = await flattenToCpio(img2.reference, legacy2, { image: img2 });
  fs.writeFileSync(legacy2 + '.json', JSON.stringify(Object.assign(r2, { configDigest: 'sha256:' + '0'.repeat(64) })));
  const b = await ensureRootfsCpio(img2.reference, { root: root2, image: img2 });
  assert.equal(b.cached, false);
  assert.ok(fs.existsSync(legacy2));
});

test('independent readers (bsdtar, busybox cpio) accept the archive (optional cross-check)', async (t) => {
  const img = syntheticImage(path.join(tmp, 'img4'));
  const out = path.join(tmp, 'x.cpio');
  const r = await flattenToCpio(img.reference, out, { image: img });
  const bsdtar = fx.findTool(['C:/Windows/System32/tar.exe', '/usr/bin/bsdtar']);
  const bbcpio = fx.findTool(['/usr/bin/cpio', '/bin/cpio']);
  if (!bsdtar && !bbcpio) { t.skip('no bsdtar/cpio'); return; }
  if (bsdtar) {
    const names = execFileSync(bsdtar, ['-tf', out], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    assert.equal(names.length, r.entries, 'bsdtar sees every entry');
    assert.ok(names.includes('app/run.sh'));
    const content = execFileSync(bsdtar, ['-xOf', out, 'app/run.sh']);
    assert.equal(content.toString(), '#!/bin/sh\necho hi\n');
    const bb = execFileSync(bsdtar, ['-xOf', out, 'bin/sh']);
    assert.equal(bb.length, 5000, 'hard link resolved by libarchive');
    const verbose = execFileSync(bsdtar, ['-tvf', out], { encoding: 'utf8' });
    assert.match(verbose, /crw------- .* dev\/console/);
  }
  if (bbcpio) {
    const names = execFileSync(bbcpio, ['-t'], { input: fs.readFileSync(out), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
    // busybox `cpio -t` defers the data-less members of a hard-link group to
    // extraction time and never lists them (bin/sh and bin/ls here).
    assert.equal(names.length, r.entries - r.rootfs.hardlinkPaths, 'busybox cpio sees every other entry');
    assert.equal(['bin/busybox', 'bin/ls', 'bin/sh'].filter((n) => names.includes(n)).length, 1);
  }
});
