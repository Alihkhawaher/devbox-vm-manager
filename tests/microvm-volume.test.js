'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mkext4 = require('../lib/microvm/mkext4');
const qcow2 = require('../lib/microvm/qcow2');

// the qemu-img the manager itself would use (platform.findTool), if any
const QEMU_IMG = require('../lib/platform').findTool('qemu-img');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));

// Bytes of the file system as the guest would read them, from the layout.
function rawOf(layout, len) {
  const b = Buffer.alloc(len);
  for (const w of layout.writes) if (w.offset < len) w.data.copy(b, w.offset, 0, Math.min(w.data.length, len - w.offset));
  return b;
}

test('layoutExt4: superblock and group descriptors are consistent', () => {
  const size = 1024 ** 3; // 8 groups
  const L = mkext4.layoutExt4(size, { label: 'data', uuid: '00112233445566778899aabbccddeeff', now: 1790000000 });
  const img = rawOf(L, L.metaBytes);
  const sb = mkext4.parseSuperblock(img.subarray(0, 4096));
  assert.strictEqual(sb.magic, 0xEF53);
  assert.strictEqual(sb.blocks, 262144);
  assert.strictEqual(sb.logBlockSize, 2);
  assert.strictEqual(sb.inodes, L.inodes);
  assert.strictEqual(sb.inodesPerGroup * L.groups, sb.inodes);
  assert.strictEqual(sb.label, 'data');
  assert.strictEqual(sb.uuid, '00112233445546778899aabbccddeeff'); // version 4 / variant bits forced
  assert.strictEqual(sb.journalInode, 8);
  assert.strictEqual(sb.state, 1);
  assert.ok(sb.incompat & 0x40, 'extents');
  assert.ok(!(sb.roCompat & 0x400), 'no metadata_csum');
  // descriptors: free blocks sum to the superblock count; bitmaps + tables sit in the metadata region
  let free = 0, freeIno = 0;
  for (let g = 0; g < L.groups; g++) {
    const d = 4096 + g * 32;
    const bb = img.readUInt32LE(d), ib = img.readUInt32LE(d + 4), it = img.readUInt32LE(d + 8);
    assert.ok(bb < L.info.metaEnd && ib < L.info.metaEnd && it < L.info.metaEnd);
    free += img.readUInt16LE(d + 0xC);
    freeIno += img.readUInt16LE(d + 0xE);
  }
  assert.strictEqual(free, sb.freeBlocks);
  assert.strictEqual(freeIno, sb.freeInodes);
  assert.strictEqual(sb.blocks - sb.freeBlocks, L.info.metaEnd, 'used blocks = metadata blocks');
  // block bitmap of group 0 marks exactly the metadata blocks
  const bb0 = img.subarray(L.info.bbStart * 4096, L.info.bbStart * 4096 + 4096);
  const bit = (b, i) => (b[i >> 3] >> (i & 7)) & 1;
  assert.strictEqual(bit(bb0, L.info.metaEnd - 1), 1);
  assert.strictEqual(bit(bb0, L.info.metaEnd), 0);
  // root directory: ".", "..", "lost+found"
  const root = img.subarray(L.info.rootBlk * 4096, L.info.rootBlk * 4096 + 4096);
  assert.strictEqual(root.readUInt32LE(0), 2);
  assert.strictEqual(root.toString('ascii', 32, 42), 'lost+found');
  // journal superblock
  assert.strictEqual(img.readUInt32BE(L.info.jStart * 4096), 0xC03B3998);
});

test('layoutExt4: limits and journal sizing', () => {
  assert.throws(() => mkext4.layoutExt4(8 * 1024 * 1024), /too small/);
  assert.strictEqual(mkext4.defaultJournalBlocks(16384), 1024);
  assert.strictEqual(mkext4.defaultJournalBlocks(2621440), 16384);
  const small = mkext4.layoutExt4(64 * 1024 * 1024);
  assert.strictEqual(small.groups, 1);
});

test('writeQcow2: sparse image whose guest view equals the raw layout', () => {
  const dir = tmp();
  const L = mkext4.layoutExt4(3 * 1024 ** 3 + 4096 * 5, { now: 1 });
  const f = path.join(dir, 'v.qcow2');
  const r = qcow2.writeQcow2(f, L.sizeBytes, L.writes);
  const h = qcow2.readQcow2Header(fs.readFileSync(f));
  assert.strictEqual(h.version, 3);
  assert.strictEqual(h.clusterBits, 16);
  assert.strictEqual(h.size, L.sizeBytes);
  assert.strictEqual(h.refcountOrder, 4);
  assert.strictEqual(fs.statSync(f).size, r.fileBytes);
  assert.ok(r.fileBytes < 2 * 1024 * 1024, 'only metadata clusters are allocated');
  const len = L.metaBytes;
  assert.ok(qcow2.readQcow2At(f, 0, len).equals(rawOf(L, len)));
  assert.ok(qcow2.readQcow2At(f, L.sizeBytes - 65536, 65536).equals(Buffer.alloc(65536)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeQcow2: overlapping and unaligned writes, bounds', () => {
  const dir = tmp();
  const f = path.join(dir, 'x.qcow2');
  const writes = [
    { offset: 65530, data: Buffer.from('ABCDEFGHIJ') },   // spans two clusters
    { offset: 65532, data: Buffer.from('xy') },           // later write wins
    { offset: 700 * 1024 * 1024, data: Buffer.from('far') }, // second L2 table
    { offset: 4096, data: Buffer.alloc(100) },             // zeros: no cluster
  ];
  const r = qcow2.writeQcow2(f, 1024 ** 3, writes);
  assert.strictEqual(r.dataClusters, 3);
  assert.strictEqual(r.l2Tables, 2);
  assert.strictEqual(qcow2.readQcow2At(f, 65530, 10).toString(), 'ABxyEFGHIJ');
  assert.strictEqual(qcow2.readQcow2At(f, 700 * 1024 * 1024, 3).toString(), 'far');
  assert.throws(() => qcow2.writeQcow2(f, 1024 ** 3, [{ offset: 1024 ** 3 - 1, data: Buffer.from('xx') }]), /outside/);
  assert.throws(() => qcow2.writeQcow2(f, 1000, []), /multiple of 512/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createQcow2 refuses to overwrite; qemu-img agrees with what it wrote', { skip: !QEMU_IMG && 'qemu-img not found' }, () => {
  const dir = tmp();
  const f = path.join(dir, 'vol.qcow2');
  const L = mkext4.createQcow2(f, 2 * 1024 ** 3, { label: 'v' });
  assert.throws(() => mkext4.createQcow2(f, 1024 ** 3), /already exists/);
  const info = JSON.parse(execFileSync(QEMU_IMG, ['info', '--output=json', f]).toString());
  assert.strictEqual(info['virtual-size'], L.sizeBytes);
  assert.strictEqual(info.format, 'qcow2');
  const check = execFileSync(QEMU_IMG, ['check', '--output=json', f]).toString();
  const c = JSON.parse(check);
  assert.strictEqual(c['check-errors'], 0);
  assert.ok(!c.corruptions && !c.leaks, check);
  // byte-identical to a raw image of the same layout
  const raw = path.join(dir, 'vol.raw');
  mkext4.writeRaw(raw, L);
  const cmp = execFileSync(QEMU_IMG, ['compare', '-q', '-f', 'raw', '-F', 'qcow2', raw, f], { stdio: 'pipe' });
  assert.strictEqual(cmp.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
