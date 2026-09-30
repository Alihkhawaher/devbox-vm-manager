'use strict';
/*
 * OCI layer flattening edge cases on locally built layers,
 * the concurrent first build of one image (bug V4a),
 * and the flatten caps (bug D).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const layers = require('../lib/oci/layers');
const ociCpio = require('../lib/oci/cpio');
const registry = require('../lib/oci/registry');
const { tarBuffer, layerB, layerC, putLocalImage, LONG_FILE } = require('./oci-mkimage');

let TMP;
test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-edge-')); });
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function writeLayers(dir, tars) {
  fs.mkdirSync(dir, { recursive: true });
  return tars.map((t, i) => { const f = path.join(dir, 'l' + i + '.tar.gz'); fs.writeFileSync(f, zlib.gzipSync(t)); return { path: f }; });
}

// layer A: a stand-in for a base image (a busybox-like hardlinked /bin)
function layerA() {
  const e = [{ path: 'bin', type: 'dir' }, { path: 'bin/[', type: 'file', data: 'BUSYBOX-BINARY', mode: 0o755 }];
  for (const n of ['sh', 'ls', 'cat']) e.push({ path: 'bin/' + n, type: 'hardlink', linkpath: 'bin/[' });
  e.push({ path: 'etc', type: 'dir' }, { path: 'home', type: 'dir' }, { path: 'home/u', type: 'file', data: 'u' });
  return e;
}

test('whiteouts, opaque dirs, hardlinks and symlink chains flatten with OCI semantics', async () => {
  const ls = writeLayers(path.join(TMP, 'sem'), [tarBuffer(layerA()), tarBuffer(layerB()), tarBuffer(layerC())]);
  const t = await layers.buildTree(ls);
  const get = (p) => t.lookup(p);
  assert.strictEqual(get('etc/secret'), null, 'lower-layer file hidden by .wh.');
  assert.ok(get('etc/again'), 'a same-layer file survives its own whiteout (OCI: whiteouts only apply to lower layers)');
  assert.strictEqual(get('d/a'), null);
  assert.ok(get('d/b'));
  assert.deepStrictEqual([...get('opq').children.keys()], ['new'], 'opaque dir keeps only its own layer');
  assert.strictEqual(get('hl/orig'), null);
  assert.strictEqual(get('hl/link').inode, get('hl/link2').inode, 'surviving hardlinks share one inode');
  assert.strictEqual(get('hl/link').inode.size, 'hardcontent\n'.length);
  assert.strictEqual(get('wdir'), null, 'whole lower directory whited out');
  assert.strictEqual(get('bin/['), null);
  assert.strictEqual(get('bin/sh').inode, get('hl2').inode, 'upper-layer hardlink to a lower file');
  assert.strictEqual(get('fd').type, 'file');
  assert.strictEqual(get('df').type, 'dir');
  assert.ok(get('realdir/viachain'), 'entry placed through a 10-hop parent symlink chain');
  assert.ok(get(LONG_FILE), 'PAX long name');
  assert.strictEqual(get('suid').mode, 0o4755);
  // 45-hop parent chain: containerd (fs.RootPath, 255 links) would place
  // q0/x at qreal/x; this implementation drops it with a warning
  assert.strictEqual(get('qreal/x'), null);
  assert.ok(t.warnings.some((w) => /too many levels/.test(w)));
});

test('the flattened archive is a valid initramfs (parents first, complete hardlink groups)', async () => {
  const ls = writeLayers(path.join(TMP, 'cpio'), [tarBuffer(layerA()), tarBuffer(layerB()), tarBuffer(layerC())]);
  const t = await layers.buildTree(ls);
  const out = path.join(TMP, 'cpio', 'root.cpio');
  const ws = fs.createWriteStream(out);
  const w = new ociCpio.CpioWriter(ws);
  await layers.emitTree(t, (e, d) => w.add(e, d));
  await w.finish();
  await new Promise((r) => ws.end(r));
  const list = await ociCpio.listCpio(out);
  const chk = ociCpio.checkInitramfs(list.entries);
  assert.deepStrictEqual(chk.errors, []);
  const sh = list.entries.filter((e) => e.name.startsWith('bin/') || e.name === 'hl2');
  assert.ok(sh.every((e) => e.nlink === sh.length), 'bin/* + hl2 are one hardlink group');
  assert.strictEqual(sh.filter((e) => e.size > 0).length, 1, 'data carried once');
});

test('concurrent first builds of one image do not collide (bug V4a)', async () => {
  const root = path.join(TMP, 'race');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'refs.json'), '{}');
  const big = [];
  for (let i = 0; i < 400; i++) big.push({ path: 'f' + i, type: 'file', data: Buffer.alloc(20000, i) });
  putLocalImage(root, 'vrace', { layers: [{ tar: tarBuffer(big) }], config: { Cmd: ['true'] } });
  const img = await registry.pullImage('vrace', { root, pullPolicy: 'never' });
  const rs = await Promise.allSettled([0, 1, 2].map(() => ociCpio.ensureRootfsCpio('vrace', { root, image: img })));
  const failed = rs.filter((r) => r.status === 'rejected').map((r) => r.reason.code + ' ' + r.reason.message.slice(0, 80));
  assert.deepStrictEqual(failed, []);
  const p = ociCpio.rootfsPaths(root, img.configDigest);
  assert.ok(fs.existsSync(p.archive) && fs.existsSync(p.meta));
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'rootfs')).filter((f) => /\.(part|tmp)$/.test(f)), [], 'no temp files left');
  // the sidecar is readable without the (transient) archive
  fs.rmSync(p.archive);
  const meta = ociCpio.readRootfsMeta(root, img.configDigest);
  assert.strictEqual(meta.configDigest, img.configDigest);
  assert.deepStrictEqual(meta.runtime.argv, ['true']);
  assert.strictEqual(ociCpio.readRootfsMeta(root, 'sha256:' + '0'.repeat(64)), null);
});

test('flatten caps: entries, bytes and depth give LayerError LIMIT (bug D)', async () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ path: 'f' + i, type: 'file', data: 'x' });
  const ls = writeLayers(path.join(TMP, 'caps'), [tarBuffer(many)]);
  await assert.rejects(layers.buildTree(ls, { limits: { maxEntries: 20 } }), (e) => e.code === 'LIMIT' && /more than 20 files/.test(e.message));
  const fat = writeLayers(path.join(TMP, 'caps2'), [tarBuffer([{ path: 'big', type: 'file', data: Buffer.alloc(300000, 1) }])]);
  await assert.rejects(layers.buildTree(fat, { limits: { maxBytes: 100000 } }), (e) => e.code === 'LIMIT' && /unpacks to more than/.test(e.message));
  let deep = 'a';
  for (let i = 0; i < 12; i++) deep += '/a';
  const dl = writeLayers(path.join(TMP, 'caps3'), [tarBuffer([{ path: deep + '/f', type: 'file', data: 'x' }])]);
  await assert.rejects(layers.buildTree(dl, { limits: { maxDepth: 8 } }), (e) => e.code === 'LIMIT' && /nested more than 8/.test(e.message));
  // the defaults let ordinary images through
  const ok = await layers.buildTree(ls);
  assert.strictEqual(ok.summary().files, 50);
  assert.deepStrictEqual(layers.LIMITS, { maxEntries: 1000000, maxBytes: 8 * 1024 * 1024 * 1024, maxDepth: 256, maxMetaBytes: 256 * 1024 * 1024 });
});
