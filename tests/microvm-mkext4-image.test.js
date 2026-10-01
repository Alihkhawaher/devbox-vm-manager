'use strict';
/*
 * The image-disk writer (lib/microvm/mkext4.js buildImageExt4): a complete
 * ext4 file system written straight into a sparse qcow2, read back with a
 * small independent ext4 reader (tests/helpers/ext4read.js) the way the
 * guest kernel reads it. Synthetic trees only (no network, no QEMU): every
 * entry type, modes, uid/gid above 65535, mtimes past 2038 and 2106 (epoch
 * bits), hardlinks sharing one inode, fast/slow symlinks, FIFOs and device
 * nodes, a 20,000-entry directory, depth-1 extent trees, whiteouts applied,
 * the skip-with-warning cases, deterministic output, the abort path, the
 * facts captured while streaming and a multi-group inode table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const layers = require('../lib/oci/layers');
const mkext4 = require('../lib/microvm/mkext4');
const qcow2 = require('../lib/microvm/qcow2');
const { tarBuffer } = require('./oci-mkimage');
const { openExt4 } = require('./helpers/ext4read');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-ext4img-' + label + '-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function layerFile(dir, name, entries) {
  const f = path.join(dir, name + '.tar.gz');
  fs.writeFileSync(f, zlib.gzipSync(tarBuffer(entries)));
  return f;
}

// Two layers with whiteouts, an opaque dir, hardlinks that survive the
// removal of their first path, a big file and symlinks; extras for what a
// tar helper cannot express (uid/gid, far mtimes, devices, FIFOs).
async function richTree(dir) {
  const big = crypto.randomBytes(1536 * 1024 + 123); // 385 blocks: >340 extents with 1-block extents
  const l1 = layerFile(dir, 'l1', [
    { path: 'etc', type: 'dir' },
    { path: 'etc/passwd', type: 'file', data: 'root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000::/home/app:/bin/sh\n' },
    { path: 'etc/group', type: 'file', data: 'root:x:0:\napp:x:1000:\n' },
    { path: 'd', type: 'dir' }, { path: 'd/a', type: 'file', data: 'a\n' }, { path: 'd/b', type: 'file', data: 'b\n' },
    { path: 'opq', type: 'dir' }, { path: 'opq/old', type: 'file', data: 'old\n' },
    { path: 'hl', type: 'dir' }, { path: 'hl/orig', type: 'file', data: 'hardcontent\n' },
    { path: 'hl/link', type: 'hardlink', linkpath: 'hl/orig' }, { path: 'hl/link2', type: 'hardlink', linkpath: 'hl/orig' },
    { path: 'big.bin', type: 'file', data: big },
    { path: 'empty', type: 'file', data: '' },
    { path: 'suid', type: 'file', data: '#!/bin/sh\n', mode: 0o4755 },
    { path: 'sticky', type: 'dir', mode: 0o1777 },
    { path: 'fast', type: 'symlink', linkpath: 'x'.repeat(59) },
    { path: 'slow60', type: 'symlink', linkpath: 'y'.repeat(60) },
    { path: 'slow70', type: 'symlink', linkpath: '/' + 'z'.repeat(69) },
    { path: 'package/admin/s6-overlay', type: 'dir' },
  ]);
  const l2 = layerFile(dir, 'l2', [
    { path: 'd', type: 'dir' }, { path: 'd/.wh.a', type: 'file' },
    { path: 'opq', type: 'dir' }, { path: 'opq/.wh..wh..opq', type: 'file' }, { path: 'opq/new', type: 'file', data: 'new\n' },
    { path: 'hl', type: 'dir' }, { path: 'hl/.wh.orig', type: 'file' },
  ]);
  const tree = await layers.buildTree([{ path: l1 }, { path: l2 }]);
  tree.addExtra({ path: 'owned', type: 'file', data: 'mine\n', mode: 0o640, uid: 100000, gid: 70000, mtime: 2240611200 }); // 2041
  tree.addExtra({ path: 'future', type: 'file', data: 'far\n', mode: 0o600, mtime: 4102444800 });                          // 2100
  tree.addExtra({ path: 'dev', type: 'dir', mode: 0o755, mtime: 0 });
  tree.addExtra({ path: 'dev/null', type: 'char', mode: 0o666, rdevmajor: 1, rdevminor: 3, mtime: 0 });
  tree.addExtra({ path: 'dev/big', type: 'block', mode: 0o660, rdevmajor: 259, rdevminor: 300, mtime: 0 });
  tree.addExtra({ path: 'pipe', type: 'fifo', mode: 0o644, mtime: 1700000000 });
  tree.addExtra({ path: '.devbox', type: 'dir', mode: 0o755, mtime: 0 });
  return { tree, big };
}

test('buildImageExt4: every entry type, owners, modes, times, links, data and whiteouts as the kernel reads them', async () => {
  const dir = tmp('rich');
  try {
    const { tree, big } = await richTree(dir);
    const file = path.join(dir, 'img.qcow2');
    const st = await mkext4.buildImageExt4(tree, file, { key: 'abc', now: 1700000000, minGB: 1, maxExtentBlocks: 1 });
    assert.equal(st.warnings.length, 0, st.warnings.join('\n'));
    assert.deepEqual(st.facts, {
      passwd: 'root:x:0:0:root:/root:/bin/sh\napp:x:1000:1000::/home/app:/bin/sh\n', group: 'root:x:0:\napp:x:1000:\n', s6: true,
    });
    const h = qcow2.readQcow2Header(fs.readFileSync(file).subarray(0, 65536));
    assert.equal(h.size, st.sizeBytes);
    assert.equal(fs.statSync(file).size, st.fileBytes);
    assert.ok(st.fileBytes < 8 * 1048576, 'sparse: ' + st.fileBytes);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), []);
    const x = openExt4(file);
    try {
      assert.equal(x.sb.magic, 0xEF53);
      assert.equal(x.sb.inodeSize, 256);
      assert.equal(x.sb.reserved, 0, 'no reserved blocks');
      assert.equal(x.sb.label, 'devbox-image');
      assert.equal(x.sb.wtime, 1700000000);
      assert.equal(x.sb.mkfsTime, 1700000000);
      const all = x.walk();
      const names = [...all.keys()].sort();
      assert.deepEqual(names, [
        '.devbox', 'big.bin', 'd', 'd/b', 'dev', 'dev/big', 'dev/null', 'empty', 'etc', 'etc/group', 'etc/passwd', 'fast', 'future',
        'hl', 'hl/link', 'hl/link2', 'opq', 'opq/new', 'owned', 'package', 'package/admin', 'package/admin/s6-overlay', 'pipe',
        'slow60', 'slow70', 'sticky', 'suid',
      ]);
      const g = (p) => all.get(p);
      // whiteouts / opaque dir / surviving hardlinks
      assert.equal(x.read(g('hl/link')).toString(), 'hardcontent\n');
      assert.equal(g('hl/link').ino, g('hl/link2').ino, 'hardlinks share one inode');
      assert.equal(g('hl/link').links, 2);
      assert.equal(x.read(g('opq/new')).toString(), 'new\n');
      // owners, modes, times
      assert.deepEqual([g('owned').uid, g('owned').gid, g('owned').perm, g('owned').mtime], [100000, 70000, 0o640, 2240611200]);
      assert.equal(g('future').mtime, 4102444800);
      assert.equal(g('suid').perm, 0o4755);
      assert.equal(g('sticky').perm, 0o1777);
      // data: a 1.5 MB file through a depth-1 extent tree (2 leaves)
      assert.equal(x.depth(g('big.bin')), 1);
      assert.equal(x.extents(g('big.bin')).length, 385);
      assert.equal(sha(x.read(g('big.bin'))), sha(big));
      assert.equal(g('big.bin').size, big.length);
      assert.equal(g('empty').size, 0);
      assert.equal(g('empty').sectors, 0);
      // symlinks: fast below 60 bytes, slow from 60
      assert.equal(x.readlink(g('fast')), 'x'.repeat(59));
      assert.equal(g('fast').sectors, 0, 'fast symlink: no block');
      assert.equal(x.readlink(g('slow60')), 'y'.repeat(60));
      assert.ok(g('slow60').sectors > 0, 'slow symlink: one block');
      assert.equal(x.readlink(g('slow70')), '/' + 'z'.repeat(69));
      // FIFO and devices (old and new device number encodings)
      assert.equal(g('pipe').type, 'fifo');
      assert.deepEqual([g('dev/null').type, x.rdev(g('dev/null'))], ['char', { major: 1, minor: 3 }]);
      assert.deepEqual([g('dev/big').type, x.rdev(g('dev/big'))], ['block', { major: 259, minor: 300 }]);
      // directory link counts: 2 + subdirectories; the file types in dirents
      assert.equal(x.inode(2).links, 2 + ['.devbox', 'd', 'dev', 'etc', 'hl', 'opq', 'package', 'sticky'].length);
      assert.equal(g('package').links, 3);
      assert.equal(g('d').ft, 2);
      assert.equal(g('fast').ft, 7);
      // the counters the kernel trusts
      let usedInodes = 0;
      for (let gi = 0; gi < x.groups; gi++) usedInodes += x.gd[gi].freeInodes;
      assert.equal(usedInodes, x.sb.freeInodes);
      assert.equal(x.sb.inodes - x.sb.freeInodes, st.inodes);
    } finally { x.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildImageExt4: a 20,000-entry directory (multi-block, depth-1 tree) and an inode table over several groups', async () => {
  const dir = tmp('wide');
  try {
    const tree = new layers.RootfsTree();
    tree.addExtra({ path: 'many', type: 'dir', mode: 0o755, mtime: 0 });
    for (let i = 0; i < 20000; i++) tree.addExtra({ path: 'many/f' + String(i).padStart(5, '0'), type: 'file', data: i % 1000 ? '' : 'n' + i, mtime: 0 });
    const file = path.join(dir, 'wide.qcow2');
    const st = await mkext4.buildImageExt4(tree, file, { key: 'k', minGB: 8, inodeRatio: 1 << 20, maxExtentBlocks: 4 });
    assert.ok(st.inodes > 2 * st.ipg, 'the inode table spans more than 2 groups: ' + st.inodes + ' inodes, ' + st.ipg + ' per group');
    const x = openExt4(file);
    try {
      const ino = x.lookup('many');
      const ents = x.readdir(ino);
      assert.equal(ents.length, 20002);
      assert.ok(x.inode(ino).size > 4096 * 4, 'multi-block directory');
      assert.equal(x.depth(x.inode(ino)), 1, 'more than 4 extents: an index level');
      const last = ents.find((e) => e.name === 'f19000');
      assert.equal(x.read(x.inode(last.ino)).toString(), 'n19000');
      assert.equal(x.inode(ents.find((e) => e.name === 'f19999').ino).size, 0);
      // used inodes per group match the bitmaps (bits past ipg are padding)
      let fromBitmaps = 0;
      for (let g = 0; g < x.groups; g++) {
        const used = x.bitmapCount('inode', g) - (32768 - x.sb.inodesPerGroup);
        assert.equal(used, x.sb.inodesPerGroup - x.gd[g].freeInodes, 'group ' + g);
        fromBitmaps += used;
      }
      assert.equal(fromBitmaps, st.inodes);
    } finally { x.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildImageExt4: entries ext4 cannot hold are skipped with a warning; hardlink data still lands', async () => {
  const dir = tmp('skip');
  try {
    const l1 = layerFile(dir, 'l1', [
      { path: 'a', type: 'dir' },
      { path: 'a/keep', type: 'file', data: 'kept-by-link\n' },
      { path: 'z' + 'n'.repeat(255), type: 'hardlink', linkpath: 'a/keep' }, // sorts last: carries the data
    ]);
    const tree = await layers.buildTree([{ path: l1 }]);
    tree.addExtra({ path: 'b'.repeat(256), type: 'file', data: 'long name\n' });
    tree.addExtra({ path: 'longlink', type: 'symlink', linkpath: 't'.repeat(4096) });
    tree.addExtra({ path: 'oklink', type: 'symlink', linkpath: 't'.repeat(4095) });
    const file = path.join(dir, 'skip.qcow2');
    const st = await mkext4.buildImageExt4(tree, file, { key: 'k', minGB: 1 });
    assert.equal(st.warnings.length, 3, st.warnings.join('\n'));
    assert.ok(st.warnings.some((w) => /longer than 255 bytes/.test(w)));
    assert.ok(st.warnings.some((w) => /symlink longlink: a target longer than 4095/.test(w)));
    assert.ok(tree.warnings.some((w) => /longer than 255 bytes/.test(w)), 'the tree carries the warning too (image sidecar)');
    const x = openExt4(file);
    try {
      assert.deepEqual([...x.walk().keys()].sort(), ['a', 'a/keep', 'oklink']);
      const keep = x.inode(x.lookup('a/keep'));
      assert.equal(x.read(keep).toString(), 'kept-by-link\n', 'the data rode on the skipped last path of its group');
      assert.equal(keep.links, 1);
      assert.equal(x.readlink(x.inode(x.lookup('oklink'))).length, 4095);
    } finally { x.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildImageExt4: deterministic for one key (two builds byte-identical), different for another; exists = success', async () => {
  const dir = tmp('det');
  try {
    const a = path.join(dir, 'a.qcow2'), b = path.join(dir, 'b.qcow2'), c = path.join(dir, 'c.qcow2');
    await mkext4.buildImageExt4((await richTree(dir)).tree, a, { key: 'same', now: 5, minGB: 1 });
    await mkext4.buildImageExt4((await richTree(dir)).tree, b, { key: 'same', now: 5, minGB: 1 });
    await mkext4.buildImageExt4((await richTree(dir)).tree, c, { key: 'other', now: 5, minGB: 1 });
    // the random big file differs per richTree call: compare the metadata
    // of trees built from the same layers instead
    const t1 = await layers.buildTree([{ path: path.join(dir, 'l1.tar.gz') }]);
    const t2 = await layers.buildTree([{ path: path.join(dir, 'l1.tar.gz') }]);
    const d1 = path.join(dir, 'd1.qcow2'), d2 = path.join(dir, 'd2.qcow2');
    await mkext4.buildImageExt4(t1, d1, { key: 'same', now: 5, minGB: 1 });
    await mkext4.buildImageExt4(t2, d2, { key: 'same', now: 5, minGB: 1 });
    assert.equal(sha(fs.readFileSync(d1)), sha(fs.readFileSync(d2)));
    const ua = openExt4(a), uc = openExt4(c);
    try {
      assert.notEqual(ua.sb.uuid, uc.sb.uuid);
      assert.notEqual(ua.sb.hashSeed, uc.sb.hashSeed);
      assert.equal(ua.sb.uuid, openExt4(b).sb.uuid);
    } finally { ua.close(); uc.close(); }
    // a second builder finding the file already there keeps it
    const before = fs.statSync(d1).mtimeMs;
    const t3 = await layers.buildTree([{ path: path.join(dir, 'l1.tar.gz') }]);
    await mkext4.buildImageExt4(t3, d1, { key: 'same', now: 5, minGB: 1 });
    assert.equal(fs.statSync(d1).mtimeMs, before);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.part$/.test(f)), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildImageExt4: an abort while streaming leaves no file and no .part', async () => {
  const dir = tmp('abort');
  try {
    const { tree } = await richTree(dir);
    const ac = new AbortController();
    const file = path.join(dir, 'x.qcow2');
    const orig = layers.emitTree;
    // abort after the first file: the writer checks between files
    let n = 0;
    layers.emitTree = (t, sink, o) => orig(t, async (e, d) => { if (e.type === 'file' && ++n === 2) ac.abort(); return sink(e, d); }, o);
    try {
      await assert.rejects(mkext4.buildImageExt4(tree, file, { key: 'k', minGB: 1, signal: ac.signal }), (e) => e.code === 'ABORTED');
    } finally { layers.emitTree = orig; }
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /qcow2/.test(f)), []);
    const pre = new AbortController(); pre.abort();
    await assert.rejects(mkext4.buildImageExt4(tree, file, { signal: pre.signal }), (e) => e.code === 'ABORTED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// cr-2: Docker (and the RAM root's "chmod 755 /") give the container a 0755
// root:root "/"; a layer's "./" entry made from a mktemp -d folder (0700) or
// by a build user must not lock a non-root USER out of everything
test('buildImageExt4: "/" is 0755 root:root whatever the layer\'s "./" entry says; its mtime is kept (cr-2)', async () => {
  const dir = tmp('rootmode');
  try {
    const l1 = layerFile(dir, 'l1', [
      { path: './', type: 'dir', mode: 0o700, uid: 1000, gid: 1000, mtime: 1600000000 },
      { path: 'app', type: 'file', data: 'x', mode: 0o755 },
    ]);
    const tree = await layers.buildTree([{ path: l1 }]);
    assert.equal(tree.root.mode & 0o7777, 0o700, 'the tree carries the layer\'s "./" metadata');
    const file = path.join(dir, 'r.qcow2');
    await mkext4.buildImageExt4(tree, file, { key: 'k', minGB: 1 });
    const x = openExt4(file);
    try {
      const r = x.inode(2);
      assert.deepEqual([r.type, r.perm, r.uid, r.gid, r.mtime], ['dir', 0o755, 0, 0, 1600000000]);
    } finally { x.close(); }
    assert.equal(mkext4.IMAGE_EXT4_FORMAT, 2, 'the layout changed: existing image disks are rebuilt under a new key');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// cr-4: a leaf block holds 340 whole extents; 1021-1360 extents need 4
// leaves of at most 340 (a fractional LEAF_MAX made one of 341 that
// overflowed its block), and more than 1360 is refused, not mis-written
test('buildImageExt4: 1021 and 1360 extents fill 4 leaves of at most 340; 1361 is IMAGE_TOO_LARGE (cr-4)', async () => {
  const dir = tmp('leaves');
  try {
    for (const n of [1021, 1360]) {
      const tree = new layers.RootfsTree();
      const data = crypto.randomBytes(n * 4096 - 100);
      tree.addExtra({ path: 'f', type: 'file', data, mtime: 0 });
      const file = path.join(dir, 'l' + n + '.qcow2');
      await mkext4.buildImageExt4(tree, file, { key: 'k', minGB: 1, maxExtentBlocks: 1 });
      const x = openExt4(file);
      try {
        const ino = x.inode(x.lookup('f'));
        assert.equal(x.depth(ino), 1);
        assert.equal(x.extents(ino).length, n);
        assert.equal(sha(x.read(ino)), sha(data));
        // the index level: 4 leaves, each with eh_max 340 and <= 340 entries
        const root = ino.iblock;
        assert.equal(root.readUInt16LE(2), 4);
        for (let k = 0; k < 4; k++) {
          const leaf = x.block(root.readUInt32LE(12 + k * 12 + 4));
          assert.equal(leaf.readUInt16LE(0), 0xF30A);
          assert.ok(leaf.readUInt16LE(2) <= 340, 'leaf ' + k + ': ' + leaf.readUInt16LE(2) + ' entries');
          assert.equal(leaf.readUInt16LE(4), 340, 'eh_max');
        }
      } finally { x.close(); }
    }
    const big = new layers.RootfsTree();
    big.addExtra({ path: 'f', type: 'file', data: Buffer.alloc(1361 * 4096), mtime: 0 });
    await assert.rejects(mkext4.buildImageExt4(big, path.join(dir, 'too.qcow2'), { key: 'k', minGB: 1, maxExtentBlocks: 1 }), (e) => e.code === 'IMAGE_TOO_LARGE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('timeParts: signed seconds plus epoch bits; dirBlockCount agrees with dirBlocks', () => {
  assert.deepEqual(mkext4.timeParts(0), { lo: 0, extra: 0 });
  assert.deepEqual(mkext4.timeParts(0x7fffffff), { lo: 0x7fffffff, extra: 0 });
  assert.deepEqual(mkext4.timeParts(0x80000000), { lo: 0x80000000, extra: 1 });
  assert.deepEqual(mkext4.timeParts(0x100000000 + 5), { lo: 5, extra: 1 });
  assert.deepEqual(mkext4.timeParts(-5), { lo: 0, extra: 0 });
  const ents = [{ name: Buffer.from('.'), ino: 2, ft: 2 }, { name: Buffer.from('..'), ino: 2, ft: 2 }];
  for (let i = 0; i < 600; i++) ents.push({ name: Buffer.from('entry-' + i), ino: 100 + i, ft: 1 });
  assert.equal(mkext4.dirBlockCount(ents), mkext4.dirBlocks(ents).length);
  assert.ok(mkext4.dirBlocks(ents).length > 1);
});
