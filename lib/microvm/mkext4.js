'use strict';
/*
 * Host-side "mkfs.ext4" for devbox volumes (Node stdlib only).
 *
 * Why: the guest busybox has no mkfs.ext2/mke2fs, QEMU on Windows has no
 * 9p/virtio-fs, and no other package may be downloaded. So the host lays
 * out an empty ext4 file system itself and the guest just mounts it.
 *
 * Layout (4 KiB blocks, everything but the data at the start of the disk, so
 * the written part is a few MB whatever the volume size):
 *   block 0            boot area + superblock (byte 1024)
 *   1 .. G             group descriptor table (32-byte descriptors)
 *   next N             block bitmaps of all N groups       (flex_bg)
 *   next N             inode bitmaps of all N groups
 *   next N*itb         inode tables of all N groups
 *   next J             journal (inode 8, one extent; only its superblock
 *                      block is written - the rest may be anything)
 *   next 1             root directory block
 *   next 1             lost+found directory block
 * Features: has_journal ext_attr dir_index sparse_super2 (no backup
 * superblocks: nothing is written past the metadata region) | filetype
 * extents flex_bg | large_file dir_nlink extra_isize. No metadata_csum and
 * no uninit_bg: the kernel trusts the bitmaps, and the never-written inode
 * tables read as zeros (a fresh sparse/qcow2 disk).
 *
 *   layoutExt4(sizeBytes, opts) -> {sizeBytes, blocks, groups, writes:[{offset, data}],
 *                                   metaBytes, uuid, info}
 *     opts: {label, uuid (16-byte Buffer/hex), inodeRatio (16384),
 *            journalBlocks (auto), now (seconds), reservedPercent (0)}
 *   writeRaw(file, layout)       -> writes a raw image (sparse where the FS allows)
 *   createQcow2(file, sizeBytes, opts) -> layout (+ .qcow2 stats); sync,
 *     writes the qcow2 directly (qcow2.js), refuses to overwrite unless
 *     opts.overwrite
 *   createQcow2WithQemuImg(qemuImg, file, sizeBytes, opts) -> Promise<layout>
 *     (old route: raw metadata file -> qemu-img convert -> resize)
 *   parseSuperblock(buf)         -> a few superblock fields (tests/diagnostics)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { writeQcow2 } = require('./qcow2');

const BS = 4096;
const BPG = 8 * BS;       // blocks per group (one bitmap block)
const ISIZE = 256;
const IPB = BS / ISIZE;   // inodes per block

const COMPAT = { HAS_JOURNAL: 0x4, EXT_ATTR: 0x8, DIR_INDEX: 0x20, SPARSE_SUPER2: 0x200 };
const INCOMPAT = { FILETYPE: 0x2, EXTENTS: 0x40, FLEX_BG: 0x200 };
const RO_COMPAT = { LARGE_FILE: 0x2, DIR_NLINK: 0x20, EXTRA_ISIZE: 0x40 };
const EXTENTS_FL = 0x80000;

// mke2fs's default journal size, in blocks (ext2fs_default_journal_size)
function defaultJournalBlocks(blocks) {
  if (blocks < 2048) return 0;
  if (blocks < 32768) return 1024;
  if (blocks < 256 * 1024) return 4096;
  if (blocks < 512 * 1024) return 8192;
  if (blocks < 4096 * 1024) return 16384;
  return 32768;
}

function setBit(buf, i) { buf[i >> 3] |= 1 << (i & 7); }
// set bits [from, to): whole bytes with fill(), bit by bit at the edges
function setBits(buf, from, to) {
  let i = from;
  for (; i < to && (i & 7); i++) setBit(buf, i);
  const bytesEnd = (to >> 3) << 3;
  if (i < bytesEnd) { buf.fill(0xff, i >> 3, bytesEnd >> 3); i = bytesEnd; }
  for (; i < to; i++) setBit(buf, i);
}

// extent tree in i_block: header + one leaf extent (len <= 32768)
function extentIBlock(startBlock, len) {
  if (len > 32768) throw new Error('single extent too long');
  const b = Buffer.alloc(60);
  b.writeUInt16LE(0xF30A, 0); // eh_magic
  b.writeUInt16LE(1, 2);      // eh_entries
  b.writeUInt16LE(4, 4);      // eh_max
  b.writeUInt16LE(0, 6);      // eh_depth
  b.writeUInt32LE(0, 8);      // eh_generation
  b.writeUInt32LE(0, 12);     // ee_block
  b.writeUInt16LE(len, 16);   // ee_len
  b.writeUInt16LE(Math.floor(startBlock / 0x100000000), 18); // ee_start_hi
  b.writeUInt32LE(startBlock % 0x100000000, 20);             // ee_start_lo
  return b;
}

function inode(o) {
  const b = Buffer.alloc(ISIZE);
  b.writeUInt16LE(o.mode, 0x0);
  b.writeUInt16LE(o.uid & 0xffff, 0x2);
  b.writeUInt32LE(o.size % 0x100000000, 0x4);
  b.writeUInt32LE(o.now, 0x8);   // atime
  b.writeUInt32LE(o.now, 0xC);   // ctime
  b.writeUInt32LE(o.now, 0x10);  // mtime
  b.writeUInt16LE(o.gid & 0xffff, 0x18);
  b.writeUInt16LE(o.links, 0x1A);
  b.writeUInt32LE(o.sectors, 0x1C); // i_blocks_lo (512-byte units)
  b.writeUInt32LE(EXTENTS_FL, 0x20);
  o.iblock.copy(b, 0x28);
  b.writeUInt32LE(Math.floor(o.size / 0x100000000), 0x6C); // i_size_high
  b.writeUInt16LE(32, 0x80);     // i_extra_isize
  b.writeUInt32LE(o.now, 0x90);  // i_crtime
  return b;
}

function dirent(ino, name, type, recLen) {
  const nb = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(recLen);
  b.writeUInt32LE(ino, 0);
  b.writeUInt16LE(recLen, 4);
  b.writeUInt8(nb.length, 6);
  b.writeUInt8(type, 7); // 2 = directory
  nb.copy(b, 8);
  return b;
}

function layoutExt4(sizeBytes, opts) {
  opts = opts || {};
  const now = opts.now !== undefined ? opts.now : Math.floor(Date.now() / 1000);
  let blocks = Math.floor(sizeBytes / BS);
  // drop a tiny last group (mke2fs does the same)
  if (blocks > BPG && blocks % BPG && blocks % BPG < 1024) blocks -= blocks % BPG;
  if (blocks < 4096) throw new Error('volume too small (minimum 16 MiB)');
  const groups = Math.ceil(blocks / BPG);
  const ratio = opts.inodeRatio || 16384;
  let ipg = Math.floor((BPG * BS) / ratio);
  ipg = Math.max(IPB, Math.min(BPG, Math.ceil(ipg / IPB) * IPB));
  // small file systems: at most as many inodes as blocks in the group
  if (groups === 1) ipg = Math.max(IPB * 4, Math.min(ipg, Math.ceil(Math.floor(blocks * BS / ratio) / IPB) * IPB));
  const itb = ipg / IPB; // inode table blocks per group
  const gdtBlocks = Math.ceil((groups * 32) / BS);
  const jBlocks = opts.journalBlocks !== undefined ? opts.journalBlocks : defaultJournalBlocks(blocks);

  let p = 1 + gdtBlocks;
  const bbStart = p; p += groups;
  const ibStart = p; p += groups;
  const itStart = p; p += groups * itb;
  const jStart = p; p += jBlocks;
  const rootBlk = p++;
  const lpfBlk = p++;
  const metaEnd = p; // blocks [0, metaEnd) are used
  if (metaEnd > blocks * 0.5) throw new Error('volume too small for its metadata');

  const uuid = opts.uuid ? Buffer.from(opts.uuid, typeof opts.uuid === 'string' ? 'hex' : undefined) : crypto.randomBytes(16);
  if (uuid.length !== 16) throw new Error('uuid must be 16 bytes');
  uuid[6] = (uuid[6] & 0x0f) | 0x40; uuid[8] = (uuid[8] & 0x3f) | 0x80; // v4

  const writes = [];
  const put = (block, data) => writes.push({ offset: block * BS, data });

  // ---- group descriptors + bitmaps
  const gdt = Buffer.alloc(gdtBlocks * BS);
  let freeBlocksTotal = 0;
  const ibPad = Buffer.alloc(BS);
  setBits(ibPad, ipg, BS * 8);
  const ibPadUsed = ipg < BS * 8;
  for (let g = 0; g < groups; g++) {
    const gStart = g * BPG;
    const gBlocks = Math.min(BPG, blocks - gStart);
    const bb = Buffer.alloc(BS);
    const usedHere = Math.max(0, Math.min(metaEnd, gStart + gBlocks) - gStart);
    setBits(bb, 0, usedHere);
    setBits(bb, gBlocks, BPG); // past the end of the FS
    const free = gBlocks - usedHere;
    freeBlocksTotal += free;
    if (bb.some((x) => x)) put(bbStart + g, bb);
    // inode bitmap: padding past ipg set; the same buffer serves every
    // group but the first (inodes 1..11 are in use there)
    let ib = ibPad;
    if (g === 0) { ib = Buffer.from(ibPad); setBits(ib, 0, 11); }
    if (g === 0 || ibPadUsed) put(ibStart + g, ib);
    const d = g * 32;
    gdt.writeUInt32LE(bbStart + g, d + 0x0);
    gdt.writeUInt32LE(ibStart + g, d + 0x4);
    gdt.writeUInt32LE(itStart + g * itb, d + 0x8);
    gdt.writeUInt16LE(free, d + 0xC);
    gdt.writeUInt16LE(g === 0 ? ipg - 11 : ipg, d + 0xE);
    gdt.writeUInt16LE(g === 0 ? 2 : 0, d + 0x10); // used dirs: / and lost+found
  }
  put(1, gdt);

  // ---- inodes 2 (root), 8 (journal), 11 (lost+found) in group 0's table
  const itab = Buffer.alloc(11 * ISIZE);
  inode({ mode: 0o040755, uid: 0, gid: 0, size: BS, links: 3, sectors: BS / 512, iblock: extentIBlock(rootBlk, 1), now }).copy(itab, (2 - 1) * ISIZE);
  let jIblock = null;
  if (jBlocks) {
    jIblock = extentIBlock(jStart, jBlocks);
    inode({ mode: 0o100600, uid: 0, gid: 0, size: jBlocks * BS, links: 1, sectors: jBlocks * (BS / 512), iblock: jIblock, now }).copy(itab, (8 - 1) * ISIZE);
  }
  inode({ mode: 0o040700, uid: 0, gid: 0, size: BS, links: 2, sectors: BS / 512, iblock: extentIBlock(lpfBlk, 1), now }).copy(itab, (11 - 1) * ISIZE);
  put(itStart, itab);

  // ---- directories
  put(rootBlk, Buffer.concat([dirent(2, '.', 2, 12), dirent(2, '..', 2, 12), dirent(11, 'lost+found', 2, BS - 24)]));
  put(lpfBlk, Buffer.concat([dirent(11, '.', 2, 12), dirent(2, '..', 2, BS - 12)]));

  // ---- journal superblock (big endian)
  if (jBlocks) {
    const js = Buffer.alloc(BS);
    js.writeUInt32BE(0xC03B3998, 0x0); // h_magic
    js.writeUInt32BE(4, 0x4);          // h_blocktype: superblock v2
    js.writeUInt32BE(0, 0x8);          // h_sequence
    js.writeUInt32BE(BS, 0xC);         // s_blocksize
    js.writeUInt32BE(jBlocks, 0x10);   // s_maxlen
    js.writeUInt32BE(1, 0x14);         // s_first
    js.writeUInt32BE(1, 0x18);         // s_sequence
    js.writeUInt32BE(0, 0x1C);         // s_start: 0 = clean, nothing to replay
    uuid.copy(js, 0x30);               // s_uuid
    js.writeUInt32BE(1, 0x40);         // s_nr_users
    uuid.copy(js, 0x100);              // s_users[0]
    put(jStart, js);
  }

  // ---- superblock
  const inodes = groups * ipg;
  const freeInodes = inodes - 11;
  const reserved = Math.floor(blocks * (opts.reservedPercent || 0) / 100);
  const sb = Buffer.alloc(1024);
  sb.writeUInt32LE(inodes, 0x0);
  sb.writeUInt32LE(blocks, 0x4);
  sb.writeUInt32LE(reserved, 0x8);
  sb.writeUInt32LE(freeBlocksTotal, 0xC);
  sb.writeUInt32LE(freeInodes, 0x10);
  sb.writeUInt32LE(0, 0x14);        // s_first_data_block
  sb.writeUInt32LE(2, 0x18);        // log block size: 1024 << 2
  sb.writeUInt32LE(2, 0x1C);        // log cluster size
  sb.writeUInt32LE(BPG, 0x20);
  sb.writeUInt32LE(BPG, 0x24);      // clusters per group
  sb.writeUInt32LE(ipg, 0x28);
  sb.writeUInt32LE(0, 0x2C);        // mtime
  sb.writeUInt32LE(now, 0x30);      // wtime
  sb.writeUInt16LE(0, 0x34);        // mnt count
  sb.writeUInt16LE(0xFFFF, 0x36);   // max mnt count: -1 (no forced fsck)
  sb.writeUInt16LE(0xEF53, 0x38);   // magic
  sb.writeUInt16LE(1, 0x3A);        // state: clean
  sb.writeUInt16LE(1, 0x3C);        // errors: continue
  sb.writeUInt32LE(now, 0x40);      // lastcheck
  sb.writeUInt32LE(0, 0x48);        // creator os: Linux
  sb.writeUInt32LE(1, 0x4C);        // rev level: dynamic
  sb.writeUInt32LE(11, 0x54);       // first ino
  sb.writeUInt16LE(ISIZE, 0x58);
  sb.writeUInt32LE(COMPAT.EXT_ATTR | COMPAT.DIR_INDEX | COMPAT.SPARSE_SUPER2 | (jBlocks ? COMPAT.HAS_JOURNAL : 0), 0x5C);
  sb.writeUInt32LE(INCOMPAT.FILETYPE | INCOMPAT.EXTENTS | INCOMPAT.FLEX_BG, 0x60);
  sb.writeUInt32LE(RO_COMPAT.LARGE_FILE | RO_COMPAT.DIR_NLINK | RO_COMPAT.EXTRA_ISIZE, 0x64);
  uuid.copy(sb, 0x68);
  Buffer.from(String(opts.label || '').slice(0, 16), 'utf8').copy(sb, 0x78, 0, 16);
  sb.writeUInt32LE(jBlocks ? 8 : 0, 0xE0);            // journal inode
  crypto.randomBytes(16).copy(sb, 0xEC);              // s_hash_seed
  sb.writeUInt8(1, 0xFC);                             // def hash: half_md4
  sb.writeUInt8(jBlocks ? 1 : 0, 0xFD);               // jnl backup type: blocks
  sb.writeUInt32LE(0x0C, 0x100);                      // default mount: user_xattr,acl
  sb.writeUInt32LE(now, 0x108);                       // mkfs time
  if (jIblock) {
    for (let i = 0; i < 15; i++) sb.writeUInt32LE(jIblock.readUInt32LE(i * 4), 0x10C + i * 4);
    sb.writeUInt32LE(0, 0x10C + 15 * 4);              // i_size_high
    sb.writeUInt32LE(jBlocks * BS, 0x10C + 16 * 4);   // i_size
  }
  sb.writeUInt16LE(32, 0x15C);                        // min extra isize
  sb.writeUInt16LE(32, 0x15E);                        // want extra isize
  sb.writeUInt32LE(0x1, 0x160);                       // signed dir hash (x86)
  sb.writeUInt8(4, 0x174);                            // log groups per flex
  sb.writeUInt32LE(0, 0x24C);                         // backup bgs: none
  sb.writeUInt32LE(0, 0x250);
  const b0 = Buffer.alloc(BS);
  sb.copy(b0, 1024);
  put(0, b0);

  writes.sort((a, b) => a.offset - b.offset);
  return {
    sizeBytes: blocks * BS, blocks, groups, inodesPerGroup: ipg, inodes, journalBlocks: jBlocks,
    metaBytes: metaEnd * BS, uuid: uuid.toString('hex'), writes,
    info: { gdtBlocks, bbStart, ibStart, itStart, jStart, rootBlk, lpfBlk, metaEnd, freeBlocks: freeBlocksTotal, freeInodes },
  };
}

// Raw image: write only the non-zero blocks, then extend to full size.
function writeRaw(file, layout, opts) {
  opts = opts || {};
  const fd = fs.openSync(file, 'w');
  try {
    for (const w of layout.writes) fs.writeSync(fd, w.data, 0, w.data.length, w.offset);
    fs.ftruncateSync(fd, opts.truncateTo !== undefined ? opts.truncateTo : layout.sizeBytes);
  } finally { fs.closeSync(fd); }
}

// qcow2 volume written directly (qcow2.js): only the clusters holding
// metadata are allocated, so the cost does not grow with the volume size
// (no qemu-img, no temporary raw file). Returns the layout plus
// {qcow2: {fileBytes, dataClusters, ...}}.
function createQcow2(file, sizeBytes, opts) {
  if (fs.existsSync(file) && !(opts && opts.overwrite)) throw new Error('volume image already exists: ' + file);
  const layout = layoutExt4(sizeBytes, opts);
  layout.qcow2 = writeQcow2(file, layout.sizeBytes, layout.writes);
  return layout;
}

// The old route, kept for comparison: raw metadata region -> qemu-img
// convert -> resize. Cost grows with the size (inode tables are written as
// zeros first): 10 GiB took ~6 s, and the temp file is ~2% of the volume.
function createQcow2WithQemuImg(qemuImg, file, sizeBytes, opts) {
  const layout = layoutExt4(sizeBytes, opts);
  const tmp = file + '.meta.raw';
  const part = file + '.part';
  const run = (args) => new Promise((resolve, reject) => {
    execFile(qemuImg, args, { windowsHide: true, timeout: 600000 }, (err, stdout, stderr) => {
      if (err) { err.message += '\n' + stderr; reject(err); } else resolve(stdout);
    });
  });
  return (async () => {
    try {
      writeRaw(tmp, layout, { truncateTo: layout.metaBytes });
      await run(['convert', '-q', '-f', 'raw', '-O', 'qcow2', tmp, part]);
      await run(['resize', '-q', '-f', 'qcow2', part, String(layout.sizeBytes)]);
      fs.renameSync(part, file);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(part, { force: true });
    }
    return layout;
  })();
}

function parseSuperblock(buf) {
  const sb = buf.length >= 2048 ? buf.subarray(1024, 2048) : buf;
  return {
    magic: sb.readUInt16LE(0x38), inodes: sb.readUInt32LE(0x0), blocks: sb.readUInt32LE(0x4),
    freeBlocks: sb.readUInt32LE(0xC), freeInodes: sb.readUInt32LE(0x10), logBlockSize: sb.readUInt32LE(0x18),
    blocksPerGroup: sb.readUInt32LE(0x20), inodesPerGroup: sb.readUInt32LE(0x28), state: sb.readUInt16LE(0x3A),
    compat: sb.readUInt32LE(0x5C), incompat: sb.readUInt32LE(0x60), roCompat: sb.readUInt32LE(0x64),
    uuid: sb.subarray(0x68, 0x78).toString('hex'), label: sb.subarray(0x78, 0x88).toString('utf8').replace(/\0+$/, ''),
    journalInode: sb.readUInt32LE(0xE0),
  };
}

module.exports = { layoutExt4, writeRaw, createQcow2, createQcow2WithQemuImg, parseSuperblock, defaultJournalBlocks, BS, BPG };
