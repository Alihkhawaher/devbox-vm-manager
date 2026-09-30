'use strict';
/*
 * Minimal qcow2 (version 3) writer: a sparse image of `virtualSize` bytes
 * whose only allocated clusters are the ones holding non-zero data from
 * `writes`. Everything else reads as zeros (no backing file). Used to create
 * pre-formatted ext4 volumes without qemu-img and without a temporary raw
 * file, so creating a 1 TiB volume costs the same few MB as a 1 GiB one.
 *
 * File layout (64 KiB clusters, every cluster refcount 1):
 *   cluster 0            header (104 bytes + end-of-extensions marker)
 *   next RT              refcount table (u64 offsets of refcount blocks)
 *   next RB              refcount blocks (u16 refcounts, 32768 per block)
 *   next L1C             L1 table (one u64 per 512 MiB of virtual disk)
 *   next L2N             L2 tables (only for 512 MiB regions with data)
 *   next D               data clusters, in virtual-offset order
 * L1/L2 entries carry QCOW_OFLAG_COPIED (bit 63), as qemu-img expects for
 * clusters with refcount 1.
 *
 *   writeQcow2(file, virtualSize, writes) -> {clusters, dataClusters, fileBytes}
 *       writes: [{offset, data: Buffer}] (any alignment; overlaps: later wins)
 *   readQcow2Header(buf) -> header fields (tests/diagnostics)
 *   readQcow2At(file, offset, length) -> Buffer (guest view; tests)
 */
const fs = require('fs');

const CLUSTER_BITS = 16;
const C = 1 << CLUSTER_BITS;          // 65536
const L2_ENTRIES = C / 8;             // 8192 -> one L2 table maps 512 MiB
const REFS_PER_BLOCK = C / 2;         // refcount_order 4 (16-bit)
const COPIED = 1n << 63n;
const HEADER_LEN = 104;

function isZero(b) {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

// Split writes into 64 KiB guest clusters (merged; all-zero clusters dropped).
function gatherClusters(writes) {
  const clusters = new Map();
  for (const w of writes) {
    let off = w.offset, pos = 0;
    while (pos < w.data.length) {
      const ci = Math.floor(off / C), co = off % C;
      const n = Math.min(C - co, w.data.length - pos);
      let buf = clusters.get(ci);
      if (!buf) { buf = Buffer.alloc(C); clusters.set(ci, buf); }
      w.data.copy(buf, co, pos, pos + n);
      off += n; pos += n;
    }
  }
  for (const [ci, b] of clusters) if (isZero(b)) clusters.delete(ci);
  return clusters;
}

function planLayout(virtualSize, dataIdx) {
  const l1Size = Math.max(1, Math.ceil(virtualSize / (C * L2_ENTRIES)));
  const l1Clusters = Math.ceil((l1Size * 8) / C);
  const l2Tables = [...new Set(dataIdx.map((ci) => Math.floor(ci / L2_ENTRIES)))].sort((a, b) => a - b);
  // the refcount structures cover themselves: iterate to a fixed point
  let rb = 1, rt = 1;
  for (;;) {
    const total = 1 + rt + rb + l1Clusters + l2Tables.length + dataIdx.length;
    const needRb = Math.ceil(total / REFS_PER_BLOCK);
    const needRt = Math.ceil((needRb * 8) / C);
    if (needRb === rb && needRt === rt) return { l1Size, l1Clusters, l2Tables, rb, rt, total };
    rb = needRb; rt = needRt;
  }
}

function writeQcow2(file, virtualSize, writes) {
  if (!(virtualSize > 0) || virtualSize % 512) throw new Error('virtual size must be a positive multiple of 512');
  for (const w of writes) {
    if (w.offset < 0 || w.offset + w.data.length > virtualSize) throw new Error('write outside the virtual disk at ' + w.offset);
  }
  const clusters = gatherClusters(writes);
  const dataIdx = [...clusters.keys()].sort((a, b) => a - b);
  const p = planLayout(virtualSize, dataIdx);
  const rtStart = 1, rbStart = rtStart + p.rt, l1Start = rbStart + p.rb, l2Start = l1Start + p.l1Clusters;
  const dataStart = l2Start + p.l2Tables.length;
  const at = (cl) => BigInt(cl) * BigInt(C);

  const header = Buffer.alloc(C);
  header.writeUInt32BE(0x514649fb, 0);             // "QFI\xfb"
  header.writeUInt32BE(3, 4);                      // version
  header.writeUInt32BE(CLUSTER_BITS, 20);
  header.writeBigUInt64BE(BigInt(virtualSize), 24);
  header.writeUInt32BE(0, 32);                     // no encryption
  header.writeUInt32BE(p.l1Size, 36);
  header.writeBigUInt64BE(at(l1Start), 40);
  header.writeBigUInt64BE(at(rtStart), 48);
  header.writeUInt32BE(p.rt, 56);
  header.writeUInt32BE(4, 96);                     // refcount_order: 16-bit
  header.writeUInt32BE(HEADER_LEN, 100);
  // header extension area: end marker (type 0, length 0) = 8 zero bytes

  const rtab = Buffer.alloc(p.rt * C);
  for (let i = 0; i < p.rb; i++) rtab.writeBigUInt64BE(at(rbStart + i), i * 8);
  const rblocks = Buffer.alloc(p.rb * C);
  for (let i = 0; i < p.total; i++) rblocks.writeUInt16BE(1, i * 2);

  const l1 = Buffer.alloc(p.l1Clusters * C);
  const l2 = Buffer.alloc(p.l2Tables.length * C);
  const l2Slot = new Map(p.l2Tables.map((t, i) => [t, i]));
  p.l2Tables.forEach((t, i) => l1.writeBigUInt64BE(at(l2Start + i) | COPIED, t * 8));
  dataIdx.forEach((ci, k) => {
    const slot = l2Slot.get(Math.floor(ci / L2_ENTRIES));
    l2.writeBigUInt64BE(at(dataStart + k) | COPIED, slot * C + (ci % L2_ENTRIES) * 8);
  });

  const part = file + '.part';
  const fd = fs.openSync(part, 'w');
  try {
    let pos = 0;
    const put = (b) => { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; };
    put(header); put(rtab); put(rblocks); put(l1); put(l2);
    for (const ci of dataIdx) put(clusters.get(ci));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(part, file);
  return { clusters: p.total, dataClusters: dataIdx.length, fileBytes: p.total * C, l1Size: p.l1Size, l2Tables: p.l2Tables.length };
}

function readQcow2Header(buf) {
  if (buf.readUInt32BE(0) !== 0x514649fb) throw new Error('not a qcow2 image');
  return {
    version: buf.readUInt32BE(4), clusterBits: buf.readUInt32BE(20), size: Number(buf.readBigUInt64BE(24)),
    l1Size: buf.readUInt32BE(36), l1Offset: Number(buf.readBigUInt64BE(40)), refcountTableOffset: Number(buf.readBigUInt64BE(48)),
    refcountTableClusters: buf.readUInt32BE(56), incompatible: Number(buf.readBigUInt64BE(72)),
    refcountOrder: buf.readUInt32BE(96), headerLength: buf.readUInt32BE(100),
  };
}

// Guest-visible bytes of an image written by writeQcow2 (no compression,
// no backing file; unallocated reads as zeros).
function readQcow2At(file, offset, length) {
  const img = fs.readFileSync(file);
  const h = readQcow2Header(img);
  const cs = 1 << h.clusterBits, per = cs / 8;
  const out = Buffer.alloc(length);
  for (let pos = 0; pos < length;) {
    const off = offset + pos, ci = Math.floor(off / cs), co = off % cs;
    const n = Math.min(cs - co, length - pos);
    const l1e = img.readBigUInt64BE(h.l1Offset + Math.floor(ci / per) * 8) & ~COPIED;
    if (l1e) {
      const l2e = img.readBigUInt64BE(Number(l1e) + (ci % per) * 8) & ~COPIED & ~1n;
      if (l2e) img.copy(out, pos, Number(l2e) + co, Number(l2e) + co + n);
    }
    pos += n;
  }
  return out;
}

module.exports = { writeQcow2, readQcow2Header, readQcow2At, CLUSTER_SIZE: C };
