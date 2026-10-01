'use strict';
/*
 * Test helper (not a test file): a small ext4 READER over a qcow2 image
 * (lib/microvm/qcow2 openQcow2Reader), to check what mkext4.buildImageExt4
 * wrote the way the guest kernel will read it: superblock, 32-byte group
 * descriptors, 256-byte inodes (32-bit uid/gid, 64-bit size, epoch bits),
 * extent trees of any depth, linear directories, fast and slow symlinks and
 * device numbers. Read-only, no journal replay, no htree (the writer makes
 * linear directories only).
 *
 *   const fsx = openExt4(file);
 *   fsx.sb                       superblock fields
 *   fsx.inode(ino)               {ino, mode, type, perm, uid, gid, size, links, flags, mtime, iblock, sectors}
 *   fsx.extents(inode)           [{lblk, len, pblk}] (leaves), fsx.depth(inode)
 *   fsx.read(inode)              Buffer (the file's bytes; holes read as zeros)
 *   fsx.readdir(ino)             [{name, ino, ft}] (with . and ..)
 *   fsx.readlink(inode)          target
 *   fsx.lookup('etc/passwd')     ino | null (no symlinks followed)
 *   fsx.walk()                   Map path -> inode (root excluded), depth first
 *   fsx.bitmapCount(kind, g)     set bits in a group's block|inode bitmap
 *   fsx.close()
 */
const qcow2 = require('../../lib/microvm/qcow2');

const TYPES = { 0o010000: 'fifo', 0o020000: 'char', 0o040000: 'dir', 0o060000: 'block', 0o100000: 'file', 0o120000: 'symlink', 0o140000: 'socket' };

function openExt4(file) {
  const q = qcow2.openQcow2Reader(file);
  const s = q.read(1024, 1024);
  const sb = {
    inodes: s.readUInt32LE(0x0), blocks: s.readUInt32LE(0x4), freeBlocks: s.readUInt32LE(0xC), freeInodes: s.readUInt32LE(0x10),
    firstDataBlock: s.readUInt32LE(0x14), blockSize: 1024 << s.readUInt32LE(0x18), blocksPerGroup: s.readUInt32LE(0x20),
    inodesPerGroup: s.readUInt32LE(0x28), wtime: s.readUInt32LE(0x30), magic: s.readUInt16LE(0x38), state: s.readUInt16LE(0x3A),
    firstIno: s.readUInt32LE(0x54), inodeSize: s.readUInt16LE(0x58), compat: s.readUInt32LE(0x5C), incompat: s.readUInt32LE(0x60),
    roCompat: s.readUInt32LE(0x64), uuid: s.subarray(0x68, 0x78).toString('hex'), label: s.subarray(0x78, 0x88).toString('utf8').replace(/\0+$/, ''),
    journalInode: s.readUInt32LE(0xE0), hashSeed: s.subarray(0xEC, 0xFC).toString('hex'), mkfsTime: s.readUInt32LE(0x108),
    reserved: s.readUInt32LE(0x8),
  };
  if (sb.magic !== 0xEF53) { q.close(); throw new Error('not an ext4 file system'); }
  const bs = sb.blockSize;
  const groups = Math.ceil(sb.blocks / sb.blocksPerGroup);
  const gdtRaw = q.read((sb.firstDataBlock + 1) * bs, groups * 32);
  const gd = [];
  for (let g = 0; g < groups; g++) {
    const o = g * 32;
    gd.push({ blockBitmap: gdtRaw.readUInt32LE(o), inodeBitmap: gdtRaw.readUInt32LE(o + 4), inodeTable: gdtRaw.readUInt32LE(o + 8),
      freeBlocks: gdtRaw.readUInt16LE(o + 0xC), freeInodes: gdtRaw.readUInt16LE(o + 0xE), usedDirs: gdtRaw.readUInt16LE(o + 0x10) });
  }
  const block = (n) => q.read(n * bs, bs);

  function time(lo, extra) {
    const signed = lo >= 0x80000000 ? lo - 0x100000000 : lo;
    return signed + (extra & 3) * 0x100000000;
  }

  function inode(ino) {
    const g = Math.floor((ino - 1) / sb.inodesPerGroup), idx = (ino - 1) % sb.inodesPerGroup;
    const b = q.read(gd[g].inodeTable * bs + idx * sb.inodeSize, sb.inodeSize);
    const mode = b.readUInt16LE(0);
    return {
      ino, mode, type: TYPES[mode & 0o170000] || null, perm: mode & 0o7777,
      uid: b.readUInt16LE(0x2) + b.readUInt16LE(0x78) * 0x10000, gid: b.readUInt16LE(0x18) + b.readUInt16LE(0x7A) * 0x10000,
      size: b.readUInt32LE(0x4) + b.readUInt32LE(0x6C) * 0x100000000, links: b.readUInt16LE(0x1A),
      sectors: b.readUInt32LE(0x1C) + b.readUInt16LE(0x74) * 0x100000000, flags: b.readUInt32LE(0x20),
      mtime: time(b.readUInt32LE(0x10), b.readUInt32LE(0x88)), iblock: Buffer.from(b.subarray(0x28, 0x28 + 60)),
    };
  }

  function parseNode(buf, off) {
    const magic = buf.readUInt16LE(off);
    if (magic !== 0xF30A) throw new Error('bad extent header magic ' + magic.toString(16));
    const entries = buf.readUInt16LE(off + 2), depth = buf.readUInt16LE(off + 6);
    const out = [];
    for (let i = 0; i < entries; i++) {
      const e = off + 12 + i * 12;
      if (depth === 0) out.push({ lblk: buf.readUInt32LE(e), len: buf.readUInt16LE(e + 4), pblk: buf.readUInt16LE(e + 6) * 0x100000000 + buf.readUInt32LE(e + 8) });
      else out.push({ lblk: buf.readUInt32LE(e), leaf: buf.readUInt16LE(e + 8) * 0x100000000 + buf.readUInt32LE(e + 4) });
    }
    return { depth, out };
  }
  function extentsOfNode(buf, off) {
    const n = parseNode(buf, off);
    if (n.depth === 0) return n.out;
    let all = [];
    for (const x of n.out) all = all.concat(extentsOfNode(block(x.leaf), 0));
    return all;
  }
  const extents = (ind) => extentsOfNode(ind.iblock, 0);
  const depth = (ind) => parseNode(ind.iblock, 0).depth;

  function read(ind) {
    const out = Buffer.alloc(ind.size);
    for (const e of extents(ind)) {
      const from = e.lblk * bs;
      if (from >= ind.size) continue;
      const n = Math.min(e.len * bs, ind.size - from);
      q.read(e.pblk * bs, n).copy(out, from);
    }
    return out;
  }

  function readdir(ino) {
    const ind = inode(ino);
    if (ind.type !== 'dir') throw new Error('inode ' + ino + ' is not a directory');
    const data = read(ind);
    const out = [];
    for (let blk = 0; blk < data.length; blk += bs) {
      let pos = 0;
      while (pos < bs) {
        const o = blk + pos;
        const eino = data.readUInt32LE(o), rec = data.readUInt16LE(o + 4), nl = data.readUInt8(o + 6), ft = data.readUInt8(o + 7);
        if (rec < 8) throw new Error('bad directory record length ' + rec + ' in inode ' + ino);
        if (eino) out.push({ name: data.toString('utf8', o + 8, o + 8 + nl), ino: eino, ft });
        pos += rec;
      }
      if (pos !== bs) throw new Error('directory block of inode ' + ino + ' does not end at the block end');
    }
    return out;
  }

  function readlink(ind) {
    if (ind.size < 60 && !(ind.flags & 0x80000)) return ind.iblock.toString('utf8', 0, ind.size);
    return read(ind).toString('utf8');
  }

  function lookup(p) {
    let ino = 2;
    for (const seg of String(p).split('/').filter(Boolean)) {
      const e = readdir(ino).find((x) => x.name === seg);
      if (!e) return null;
      ino = e.ino;
    }
    return ino;
  }

  function walk() {
    const out = new Map();
    const rec = (ino, prefix) => {
      for (const e of readdir(ino)) {
        if (e.name === '.' || e.name === '..') continue;
        const p = prefix ? prefix + '/' + e.name : e.name;
        const ind = inode(e.ino);
        ind.ft = e.ft;
        out.set(p, ind);
        if (ind.type === 'dir') rec(e.ino, p);
      }
    };
    rec(2, '');
    return out;
  }

  function bitmapCount(kind, g) {
    const b = block(kind === 'inode' ? gd[g].inodeBitmap : gd[g].blockBitmap);
    let n = 0;
    for (let i = 0; i < b.length; i++) { let x = b[i]; while (x) { n += x & 1; x >>= 1; } }
    return n;
  }

  // device numbers as the kernel decodes them (old or new encoding)
  function rdev(ind) {
    const old = ind.iblock.readUInt32LE(0);
    if (old) return { major: (old >> 8) & 0xff, minor: old & 0xff };
    const nw = ind.iblock.readUInt32LE(4);
    return { major: (nw & 0xfff00) >> 8, minor: (nw & 0xff) | ((nw >> 12) & 0xfff00) };
  }

  return { sb, gd, groups, inode, extents, depth, read, readdir, readlink, lookup, walk, bitmapCount, rdev, block, close: () => q.close() };
}

module.exports = { openExt4 };
