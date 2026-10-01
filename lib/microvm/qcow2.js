'use strict';
/*
 * Minimal qcow2 (version 3) writer and reader, Node stdlib only.
 *
 * 1. Sparse images written in one go: a disk of `virtualSize` bytes whose
 *    only allocated clusters are the ones holding data. Everything else reads
 *    as zeros (no backing file). Used for pre-formatted ext4 volumes
 *    (mkext4.createQcow2) and for the read-only IMAGE DISKS of disk-root
 *    microVMs (mkext4.buildImageExt4), so creating a 1 TiB volume costs the
 *    same few MB as a 1 GiB one, without qemu-img and without a raw temp file.
 * 2. Overlays: an empty qcow2 whose reads fall through to a BACKING file (the
 *    shared image disk) until the guest writes - the per-container writable
 *    layer of a disk-root microVM (rootdisk.createRootOverlay).
 *
 * File layout of a written image (64 KiB clusters, every cluster refcount 1):
 *   cluster 0            header (104 bytes + end-of-extensions marker)
 *   next RT              refcount table (u64 offsets of refcount blocks)
 *   next RB              refcount blocks (u16 refcounts, 32768 per block)
 *   next L1C             L1 table (one u64 per 512 MiB of virtual disk)
 *   next L2N             L2 tables (only for 512 MiB regions with data)
 *   next D               data clusters, in virtual-offset order
 * L1/L2 entries carry QCOW_OFLAG_COPIED (bit 63), as qemu-img expects for
 * clusters with refcount 1. Because the data clusters follow in guest order,
 * host cluster = dataStart + rank(guest cluster): planQcow2() computes the
 * whole map from the list of guest clusters BEFORE a byte of data exists, so
 * a large image is streamed front to back (PositionalWriter) and never held
 * in memory.
 *
 *   writeQcow2(file, virtualSize, writes) -> {clusters, dataClusters, fileBytes}
 *       writes: [{offset, data: Buffer}] (any alignment; overlaps: later wins)
 *   planQcow2(virtualSize, clusters) -> {meta, dataStart, rank, hostOffset(g),
 *       fileBytes, total, l1Size, l2Tables}  (clusters: sorted guest indexes)
 *   PositionalWriter(fd)          coalescing positional writer (see the class)
 *   createOverlay(file, backingRel, virtualSize, {backingFormat})
 *   readBacking(file) -> {name, format} | null
 *   readQcow2Header(buf) -> header fields (incl. backingOffset/backingSize)
 *   openQcow2Reader(file) -> {header, read(offset, length), close()} (guest
 *       view by file descriptor: big images, tests, diagnostics)
 *   readQcow2At(file, offset, length) -> Buffer (guest view; small files)
 */
const fs = require('fs');
const crypto = require('crypto');

const CLUSTER_BITS = 16;
const C = 1 << CLUSTER_BITS;          // 65536
const L2_ENTRIES = C / 8;             // 8192 -> one L2 table maps 512 MiB
const REFS_PER_BLOCK = C / 2;         // refcount_order 4 (16-bit)
const COPIED = 1n << 63n;
const HEADER_LEN = 104;
const MAGIC = 0x514649fb;             // "QFI\xfb"
const EXT_BACKING_FORMAT = 0xE2792ACA;

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
  const l2Tables = [];
  for (const ci of dataIdx) { const t = Math.floor(ci / L2_ENTRIES); if (l2Tables[l2Tables.length - 1] !== t) l2Tables.push(t); }
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

function header(virtualSize, o) {
  const h = Buffer.alloc(C);
  h.writeUInt32BE(MAGIC, 0);
  h.writeUInt32BE(3, 4);                       // version
  h.writeUInt32BE(CLUSTER_BITS, 20);
  h.writeBigUInt64BE(BigInt(virtualSize), 24);
  h.writeUInt32BE(0, 32);                      // no encryption
  h.writeUInt32BE(o.l1Size, 36);
  h.writeBigUInt64BE(BigInt(o.l1Offset), 40);
  h.writeBigUInt64BE(BigInt(o.refcountTableOffset), 48);
  h.writeUInt32BE(o.refcountTableClusters, 56);
  h.writeUInt32BE(4, 96);                      // refcount_order: 16-bit
  h.writeUInt32BE(HEADER_LEN, 100);
  // header extension area: end marker (type 0, length 0) = 8 zero bytes
  return h;
}

// The metadata of an image whose data clusters are `clusters` (sorted guest
// cluster indexes, no duplicates). -> {meta (header + refcounts + L1 + L2 as
// one Buffer, written at file offset 0), dataStart (host cluster of the first
// data cluster), rank (guest cluster -> k), hostOffset(guestByte), fileBytes,
// total, l1Size, l2Tables}
function planQcow2(virtualSize, clusters) {
  if (!(virtualSize > 0) || virtualSize % 512) throw new Error('virtual size must be a positive multiple of 512');
  for (let i = 1; i < clusters.length; i++) if (!(clusters[i] > clusters[i - 1])) throw new Error('planQcow2: clusters must be sorted and unique');
  if (clusters.length && (clusters[clusters.length - 1] + 1) * C > Math.ceil(virtualSize / C) * C) throw new Error('planQcow2: a cluster lies outside the virtual disk');
  const p = planLayout(virtualSize, clusters);
  const rtStart = 1, rbStart = rtStart + p.rt, l1Start = rbStart + p.rb, l2Start = l1Start + p.l1Clusters;
  const dataStart = l2Start + p.l2Tables.length;
  const at = (cl) => BigInt(cl) * BigInt(C);
  const head = header(virtualSize, { l1Size: p.l1Size, l1Offset: l1Start * C, refcountTableOffset: rtStart * C, refcountTableClusters: p.rt });
  const rtab = Buffer.alloc(p.rt * C);
  for (let i = 0; i < p.rb; i++) rtab.writeBigUInt64BE(at(rbStart + i), i * 8);
  const rblocks = Buffer.alloc(p.rb * C);
  for (let i = 0; i < p.total; i++) rblocks.writeUInt16BE(1, i * 2);
  const l1 = Buffer.alloc(p.l1Clusters * C);
  const l2 = Buffer.alloc(p.l2Tables.length * C);
  const l2Slot = new Map(p.l2Tables.map((t, i) => [t, i]));
  p.l2Tables.forEach((t, i) => l1.writeBigUInt64BE(at(l2Start + i) | COPIED, t * 8));
  const rank = new Map();
  clusters.forEach((ci, k) => {
    rank.set(ci, k);
    l2.writeBigUInt64BE(at(dataStart + k) | COPIED, l2Slot.get(Math.floor(ci / L2_ENTRIES)) * C + (ci % L2_ENTRIES) * 8);
  });
  const hostOffset = (guest) => {
    const k = rank.get(Math.floor(guest / C));
    if (k === undefined) throw new Error('qcow2 plan: guest offset ' + guest + ' is in a cluster that was not planned');
    return (dataStart + k) * C + (guest % C);
  };
  return {
    meta: Buffer.concat([head, rtab, rblocks, l1, l2]), dataStart, rank, hostOffset,
    fileBytes: p.total * C, total: p.total, l1Size: p.l1Size, l2Tables: p.l2Tables.length,
  };
}

function writeQcow2(file, virtualSize, writes) {
  if (!(virtualSize > 0) || virtualSize % 512) throw new Error('virtual size must be a positive multiple of 512');
  for (const w of writes) {
    if (w.offset < 0 || w.offset + w.data.length > virtualSize) throw new Error('write outside the virtual disk at ' + w.offset);
  }
  const clusters = gatherClusters(writes);
  const dataIdx = [...clusters.keys()].sort((a, b) => a - b);
  const q = planQcow2(virtualSize, dataIdx);
  const part = file + '.part';
  const fd = fs.openSync(part, 'w');
  try {
    let pos = 0;
    const put = (b) => { fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; };
    put(q.meta);
    for (const ci of dataIdx) put(clusters.get(ci));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(part, file);
  return { clusters: q.total, dataClusters: dataIdx.length, fileBytes: q.fileBytes, l1Size: q.l1Size, l2Tables: q.l2Tables };
}

// Buffered positional writer: coalesces EXACTLY contiguous writes into
// 4 MiB runs. A gap is never filled with zeros here: it may hold metadata
// written earlier (an extent leaf block sits right after its file's data -
// the spike's edge-case image found that a zero-filled gap wiped it).
// Bytes never written below EOF read as zeros (the OS fills them).
class PositionalWriter {
  constructor(fd, bufBytes) {
    this.fd = fd;
    this.buf = Buffer.alloc(bufBytes || (4 << 20));
    this.start = -1;
    this.len = 0;
    this.bytes = 0;
    this.writes = 0;
  }
  write(pos, data) {
    if (this.start >= 0) {
      if (pos === this.start + this.len && this.len + data.length <= this.buf.length) {
        data.copy(this.buf, this.len);
        this.len += data.length;
        return;
      }
      this.flush();
    }
    if (data.length >= this.buf.length) {
      fs.writeSync(this.fd, data, 0, data.length, pos);
      this.bytes += data.length;
      this.writes++;
      return;
    }
    this.start = pos;
    this.len = data.length;
    data.copy(this.buf, 0);
  }
  flush() {
    if (this.start >= 0 && this.len) {
      fs.writeSync(this.fd, this.buf, 0, this.len, this.start);
      this.bytes += this.len;
      this.writes++;
    }
    this.start = -1;
    this.len = 0;
  }
}

// ------------------------------------------------------------------ overlays
// A qcow2 v3 with a backing file and nothing allocated: header, refcount
// table, one refcount block, L1 (256 KB for an 8 GiB disk). Every read falls
// through to the backing file until the guest writes there. backingRel is
// RELATIVE to the overlay's folder (QEMU resolves it so), which keeps the
// data folder movable; the backing format is recorded in a header
// extension, so QEMU never probes it. Written to a unique .part and renamed;
// refuses to overwrite an existing file (a container's writable layer).
function createOverlay(file, backingRel, virtualSize, opts) {
  opts = opts || {};
  if (!(virtualSize > 0) || virtualSize % 512) throw new Error('virtual size must be a positive multiple of 512');
  if (fs.existsSync(file)) {
    const e = new Error('the overlay already exists: ' + file);
    e.code = 'EEXIST';
    throw e;
  }
  const l1Size = Math.max(1, Math.ceil(virtualSize / (C * L2_ENTRIES)));
  const l1Clusters = Math.ceil((l1Size * 8) / C);
  const total = 3 + l1Clusters; // header, refcount table, refcount block, L1
  const h = header(virtualSize, { l1Size, l1Offset: 3 * C, refcountTableOffset: C, refcountTableClusters: 1 });
  let o = HEADER_LEN;
  const fmt = Buffer.from(String(opts.backingFormat || 'qcow2'), 'utf8');
  h.writeUInt32BE(EXT_BACKING_FORMAT, o);
  h.writeUInt32BE(fmt.length, o + 4);
  fmt.copy(h, o + 8);
  o += 8 + Math.ceil(fmt.length / 8) * 8;
  o += 8; // end of extensions (zeros)
  const name = Buffer.from(String(backingRel), 'utf8');
  if (!name.length || name.length > 1023 || o + name.length > C) throw new Error('backing file name is empty or too long');
  name.copy(h, o);
  h.writeBigUInt64BE(BigInt(o), 8);   // backing_file_offset
  h.writeUInt32BE(name.length, 16);   // backing_file_size
  const rt = Buffer.alloc(C);
  rt.writeBigUInt64BE(BigInt(2 * C), 0);
  const rb = Buffer.alloc(C);
  for (let i = 0; i < total; i++) rb.writeUInt16BE(1, i * 2);
  const l1 = Buffer.alloc(l1Clusters * C);
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  try {
    fs.writeFileSync(part, Buffer.concat([h, rt, rb, l1]), { flag: 'wx' });
    if (fs.existsSync(file)) {
      const e = new Error('the overlay already exists: ' + file);
      e.code = 'EEXIST';
      throw e;
    }
    fs.renameSync(part, file);
  } finally { fs.rmSync(part, { force: true }); }
  return { file, fileBytes: total * C, backing: String(backingRel), virtualSize };
}

function readQcow2Header(buf) {
  if (buf.length < 72 || buf.readUInt32BE(0) !== MAGIC) throw new Error('not a qcow2 image');
  const version = buf.readUInt32BE(4);
  return {
    version, backingOffset: Number(buf.readBigUInt64BE(8)), backingSize: buf.readUInt32BE(16),
    clusterBits: buf.readUInt32BE(20), size: Number(buf.readBigUInt64BE(24)),
    l1Size: buf.readUInt32BE(36), l1Offset: Number(buf.readBigUInt64BE(40)), refcountTableOffset: Number(buf.readBigUInt64BE(48)),
    refcountTableClusters: buf.readUInt32BE(56),
    incompatible: version >= 3 && buf.length >= 80 ? Number(buf.readBigUInt64BE(72)) : 0,
    refcountOrder: version >= 3 && buf.length >= 100 ? buf.readUInt32BE(96) : 4,
    headerLength: version >= 3 && buf.length >= 104 ? buf.readUInt32BE(100) : 72,
  };
}

// The backing file an image names: {name (as stored - relative or absolute),
// format (header extension, or null)} | null (no backing file, not a qcow2,
// unreadable). Reads the first cluster only. The overlay header is written by
// QEMU and the manager, never by the guest, so it may be trusted for GC.
function readBacking(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(C);
    const n = fs.readSync(fd, b, 0, C, 0);
    const buf = b.subarray(0, n);
    const h = readQcow2Header(buf);
    if (!h.backingOffset || !h.backingSize) return null;
    if (h.backingSize > 1023 || h.backingOffset + h.backingSize > buf.length) return null;
    const name = buf.toString('utf8', h.backingOffset, h.backingOffset + h.backingSize);
    let format = null;
    if (h.version >= 3) {
      let o = h.headerLength;
      for (let i = 0; i < 64 && o + 8 <= buf.length; i++) {
        const type = buf.readUInt32BE(o), len = buf.readUInt32BE(o + 4);
        if (type === 0) break;
        if (o + 8 + len > buf.length) break;
        if (type === EXT_BACKING_FORMAT) format = buf.toString('utf8', o + 8, o + 8 + len);
        o += 8 + Math.ceil(len / 8) * 8;
      }
    }
    return { name, format };
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
  }
}

// Guest-visible bytes of an image without compression or encryption, read
// through a file descriptor (unallocated clusters read as zeros; a backing
// file is NOT consulted: an overlay reads as its own allocated clusters).
// -> {header, read(offset, length) -> Buffer, close()}
function openQcow2Reader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hb = Buffer.alloc(C);
    fs.readSync(fd, hb, 0, C, 0);
    const h = readQcow2Header(hb);
    const cs = 2 ** h.clusterBits, per = cs / 8;
    const l1 = Buffer.alloc(h.l1Size * 8);
    if (h.l1Size) fs.readSync(fd, l1, 0, l1.length, h.l1Offset);
    const l2Cache = new Map();
    const l2Of = (off) => {
      let t = l2Cache.get(off);
      if (!t) {
        t = Buffer.alloc(cs);
        fs.readSync(fd, t, 0, cs, off);
        if (l2Cache.size > 256) l2Cache.clear();
        l2Cache.set(off, t);
      }
      return t;
    };
    const read = (offset, length) => {
      const out = Buffer.alloc(length);
      for (let pos = 0; pos < length;) {
        const off = offset + pos, ci = Math.floor(off / cs), co = off % cs;
        const n = Math.min(cs - co, length - pos);
        const li = Math.floor(ci / per);
        const l1e = li < h.l1Size ? l1.readBigUInt64BE(li * 8) & ~COPIED & ((1n << 56n) - 1n) : 0n;
        if (l1e) {
          const l2e = l2Of(Number(l1e)).readBigUInt64BE((ci % per) * 8) & ~COPIED & ~1n & ((1n << 56n) - 1n);
          if (l2e) fs.readSync(fd, out, pos, n, Number(l2e) + co);
        }
        pos += n;
      }
      return out;
    };
    return { header: h, read, close: () => { try { fs.closeSync(fd); } catch (e) { /* closed */ } } };
  } catch (e) {
    try { fs.closeSync(fd); } catch (x) { /* closed */ }
    throw e;
  }
}

// Guest-visible bytes of an image written by writeQcow2 (no compression,
// no backing file; unallocated reads as zeros).
function readQcow2At(file, offset, length) {
  const r = openQcow2Reader(file);
  try { return r.read(offset, length); } finally { r.close(); }
}

module.exports = {
  writeQcow2, planQcow2, PositionalWriter, createOverlay, readBacking, readQcow2Header, openQcow2Reader, readQcow2At,
  CLUSTER_SIZE: C,
};
