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
 *   buildImageExt4(tree, file, opts) -> Promise<stats>
 *                                   a COMPLETE file system - the flattened
 *                                   image of a disk-root microVM - written
 *                                   straight into a sparse qcow2 (see "IMAGE
 *                                   DISKS" below)
 *
 * IMAGE DISKS (disk-root microVMs, rootdisk.js). Instead of an empty file
 * system, buildImageExt4 lays out every directory, regular file, fast and
 * slow symlink, hardlink, FIFO and device node of a flattened OCI root
 * (lib/oci/layers buildTree), with modes, 32-bit uid/gid, mtimes past 2038
 * (epoch bits), multi-block linear directories and extent trees for files of
 * any size. WHY on the host and not by booting a builder VM that unpacks
 * the image (measured in the disk-root spike): as fast as today's initrd
 * build (nginx 1.0 s vs 1.0 s, a 606 MB image 4.9-5.8 s vs 5.1-6.0 s),
 * 2.4-48x faster than a guest-side unpack under WHPX and ~40x under TCG,
 * no boot, no temp file, no qemu-img - and it works without acceleration.
 * PLAN, THEN STREAM: buildTree already knows every path, inode, size and
 * link, so inode numbers (parents first), directory blocks, the block of
 * every file and the qcow2 cluster map are computed before a byte of file
 * data is read; layers.emitTree then reads each layer blob once and every
 * file goes to its final place. Data blocks are allocated in the order
 * emitTree delivers them, so the qcow2 is written front to back. The inode
 * table and the directory blocks are generated group by group / directory
 * by directory while writing (a million inodes would otherwise be 256 MB).
 * The output is a pure function of the tree and opts.key/opts.now (UUID and
 * hash seed derive from the disk key, every superblock time is opts.now):
 * two builders in two processes write identical files, so "exists =
 * success" holds. Entries ext4 cannot hold (a name over 255 bytes, a
 * symlink target over 4095 bytes, the 65,001st link of one file) are
 * skipped with a warning - the cpio path cannot carry them either.
 * xattrs are not written (parity with the RAM root: the FILE_CAPS warning).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { writeQcow2, planQcow2, PositionalWriter } = require('./qcow2');

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

// ============================================================== image disks
// Bump when buildImageExt4 would write a different file for the same tree
// (it is part of the image disk key: rootdisk.imageDiskKey). A container's
// overlay is a block-level copy-on-write of its disk, and a disk that went
// missing is rebuilt under the SAME name (run.prepareRootByDigest): the
// bytes must not change without a bump, or every surviving overlay over it
// would read a different file system. tests/microvm-mkext4-image.test.js
// pins the sha256 of a fixed build per format ("golden").
//   1  first release
//   2  "/" is always 0755 root:root (cr-2)
const IMAGE_EXT4_FORMAT = 2;
const EXT_MAX = 32768;                  // blocks per initialized extent
// whole entries per leaf block: (4096 - 12) / 12 = 340.33, and a fraction
// here made a leaf of 341 entries overflow its block (cr-4)
const LEAF_MAX = Math.floor((BS - 12) / 12); // 340
const MAX_LINKS = 65000;                // EXT4_LINK_MAX
const MAX_NAME = 255;
const MAX_SYMLINK = BS - 1;
const FIRST_INO = 11;
const MAX_FACT_TEXT = 256 * 1024;
const U32 = 0x100000000;
const ZERO_BLOCK = Buffer.alloc(BS);
const S_IF = { fifo: 0o010000, char: 0o020000, dir: 0o040000, block: 0o060000, file: 0o100000, symlink: 0o120000, socket: 0o140000 };
const FT = { file: 1, dir: 2, char: 3, block: 4, fifo: 5, socket: 6, symlink: 7 };
const S6_PATHS = new Set(['package/admin/s6-overlay', 'etc/s6-overlay']);

// 16 MiB journal for anything but a tiny disk (only its superblock is written)
function imageJournalBlocks(blocks) {
  if (blocks < 2048) return 0;
  if (blocks < 32768) return 1024;
  return 4096;
}

function extHeader(buf, off, entries, max, depth) {
  buf.writeUInt16LE(0xF30A, off);
  buf.writeUInt16LE(entries, off + 2);
  buf.writeUInt16LE(max, off + 4);
  buf.writeUInt16LE(depth, off + 6);
  buf.writeUInt32LE(0, off + 8);
}
function extEntry(buf, off, lblk, len, pblk) {
  buf.writeUInt32LE(lblk, off);
  buf.writeUInt16LE(len, off + 4);
  buf.writeUInt16LE(Math.floor(pblk / U32), off + 6);
  buf.writeUInt32LE(pblk % U32, off + 8);
}
function idxEntry(buf, off, lblk, leaf) {
  buf.writeUInt32LE(lblk, off);
  buf.writeUInt32LE(leaf % U32, off + 4);
  buf.writeUInt16LE(Math.floor(leaf / U32), off + 8);
  buf.writeUInt16LE(0, off + 10);
}
// extents of a contiguous run [start, start+n), at most extMax blocks each
function runExtents(start, n, extMax) {
  const out = [];
  for (let l = 0; l < n; l += extMax) out.push({ lblk: l, len: Math.min(extMax, n - l), pblk: start + l });
  return out;
}
const leafBlocksFor = (nExt) => (nExt <= 4 ? 0 : Math.ceil(nExt / LEAF_MAX));

// i_block (60 bytes) + leaf blocks for a list of extents: up to 4 extents in
// the inode, else one index level with up to 4 leaves placed at leafStart
function extentTree(exts, leafStart) {
  const ib = Buffer.alloc(60);
  const leaves = [];
  if (exts.length <= 4) {
    extHeader(ib, 0, exts.length, 4, 0);
    exts.forEach((e, i) => extEntry(ib, 12 + i * 12, e.lblk, e.len, e.pblk));
    return { iblock: ib, leaves };
  }
  const n = leafBlocksFor(exts.length);
  if (n > 4) throw Object.assign(new Error('file too large for a depth-1 extent tree'), { code: 'IMAGE_TOO_LARGE' });
  extHeader(ib, 0, n, 4, 1);
  for (let k = 0; k < n; k++) {
    const part = exts.slice(k * LEAF_MAX, (k + 1) * LEAF_MAX);
    const b = Buffer.alloc(BS);
    extHeader(b, 0, part.length, LEAF_MAX, 0);
    part.forEach((e, i) => extEntry(b, 12 + i * 12, e.lblk, e.len, e.pblk));
    idxEntry(ib, 12 + k * 12, part[0].lblk, leafStart + k);
    leaves.push({ block: leafStart + k, data: b });
  }
  return { iblock: ib, leaves };
}

// ext4 times: a signed 32-bit seconds field plus 2 epoch bits in *_extra
// (dates up to 2446). Negative times are clamped to 0.
function timeParts(t) {
  let s = Math.floor(Number(t) || 0);
  if (s < 0) s = 0;
  if (s > 3 * U32 - 1) s = 3 * U32 - 1;
  const lo = s % U32;
  const signed = lo >= 0x80000000 ? lo - U32 : lo;
  const epoch = Math.round((s - signed) / U32) & 3;
  return { lo, extra: epoch };
}

function imageInode(o) {
  const b = Buffer.alloc(ISIZE);
  b.writeUInt16LE(o.mode, 0x0);
  b.writeUInt16LE(o.uid & 0xffff, 0x2);
  b.writeUInt32LE(o.size % U32, 0x4);
  const t = timeParts(o.mtime);
  b.writeUInt32LE(t.lo, 0x8);                    // atime
  b.writeUInt32LE(t.lo, 0xC);                    // ctime
  b.writeUInt32LE(t.lo, 0x10);                   // mtime
  b.writeUInt16LE(o.gid & 0xffff, 0x18);
  b.writeUInt16LE(o.links, 0x1A);
  b.writeUInt32LE(o.sectors % U32, 0x1C);        // i_blocks_lo (512-byte units)
  b.writeUInt32LE(o.flags || 0, 0x20);
  if (o.iblock) o.iblock.copy(b, 0x28);
  b.writeUInt32LE(Math.floor(o.size / U32), 0x6C);
  b.writeUInt16LE(Math.floor(o.sectors / U32) & 0xffff, 0x74); // i_blocks_high
  b.writeUInt16LE(Math.floor(o.uid / 0x10000) & 0xffff, 0x78);
  b.writeUInt16LE(Math.floor(o.gid / 0x10000) & 0xffff, 0x7A);
  b.writeUInt16LE(32, 0x80);                     // i_extra_isize
  b.writeUInt32LE(t.extra, 0x84);                // ctime_extra
  b.writeUInt32LE(t.extra, 0x88);                // mtime_extra
  b.writeUInt32LE(t.extra, 0x8C);                // atime_extra
  b.writeUInt32LE(t.lo, 0x90);                   // crtime
  b.writeUInt32LE(t.extra, 0x94);
  return b;
}

// directory entries [{name (Buffer), ino, ft}] ("." and ".." first) -> blocks
const recLen = (nameLen) => (8 + nameLen + 3) & ~3;
function dirBlockCount(entries) {
  let n = 0, pos = BS;
  for (const e of entries) {
    const need = recLen(e.name.length);
    if (pos + need > BS) { n++; pos = 0; }
    pos += need;
  }
  return n;
}
function dirBlocks(entries) {
  const blocks = [];
  let cur = null, pos = 0, last = 0;
  const close = () => { if (cur) { cur.writeUInt16LE(BS - last, last + 4); blocks.push(cur); } };
  for (const e of entries) {
    const need = recLen(e.name.length);
    if (!cur || pos + need > BS) { close(); cur = Buffer.alloc(BS); pos = 0; }
    cur.writeUInt32LE(e.ino, pos);
    cur.writeUInt16LE(need, pos + 4);
    cur.writeUInt8(e.name.length, pos + 6);
    cur.writeUInt8(e.ft, pos + 7);
    e.name.copy(cur, pos + 8);
    last = pos;
    pos += need;
  }
  close();
  return blocks;
}

// 16 bytes derived from the disk key: the same key gives the same file system
function keyBytes(key, what) {
  return crypto.createHash('sha256').update('devbox-ext4:' + what + ':' + key).digest().subarray(0, 16);
}

function abortError() { return Object.assign(new Error('stopped before the app started'), { code: 'ABORTED' }); }

// Build an image disk. tree: a layers.buildTree result (extras such as
// /dev, /proc and /.devbox already added by the caller). file: the target
// .qcow2 (written to a unique .part and renamed; a target that appears
// meanwhile - another builder - is kept: "exists = success").
// opts: {sizeBytes (virtual; default max(minGB GiB, 2 x need + 256 MiB)),
//        minGB (8), key (hex: UUID + hash seed; default random), now
//        (seconds: every superblock time; default 0), label, signal
//        (AbortSignal, checked between files), inodeRatio (16384),
//        maxExtentBlocks (tests: smaller extents to force deep trees),
//        journalBlocks}
// -> {ms, planMs, writeMs, inodes, dirs, files, dataBytes, sizeBytes,
//     blocks, groups, ipg, usedBlocks, metaBlocks, journalBlocks, fileBytes,
//     clusters, writes, warnings, facts: {passwd, group, s6}, uuid}
async function buildImageExt4(tree, file, opts) {
  opts = opts || {};
  const layers = require('../oci/layers');
  const t0 = Date.now();
  const extMax = Math.max(1, Math.min(EXT_MAX, opts.maxExtentBlocks || EXT_MAX));
  const now = Math.max(0, Math.floor(Number(opts.now) || 0));
  const signal = opts.signal;
  if (signal && signal.aborted) throw abortError();
  const warnings = [];
  const warn = (m) => { if (warnings.length < 200) warnings.push(m); if (typeof tree.warn === 'function') tree.warn(m); };

  // ---- 1. inodes and directory contents (names sorted, parents first)
  const inodes = [null, null];                 // index = ino; 1 = bad blocks
  let nextIno = FIRST_INO;
  const fileIno = new Map();                   // tree inode object -> ino (hardlinks share)
  const pathIno = new Map();                   // path -> ino: where emitTree's data lands
  const unlinked = [];                         // [path, tree inode]: file paths without a dirent
  const dirs = [];                             // {ino, entries}
  let s6 = false;
  const mk = (rec) => { const ino = nextIno++; inodes[ino] = rec; return ino; };
  // every file under a skipped directory: its data may still be the data of
  // a hardlink that IS in the tree (emitTree sends it on the group's last path)
  const skipSubtree = (node, prefix) => {
    for (const [name, c] of node.children) {
      const p = prefix + '/' + name;
      if (c.type === 'file') unlinked.push([p, c.inode]);
      else if (c.type === 'dir') skipSubtree(c, p);
    }
  };
  const walkDir = (node, ino, parentIno, prefix) => {
    const entries = [{ name: Buffer.from('.'), ino, ft: FT.dir }, { name: Buffer.from('..'), ino: parentIno, ft: FT.dir }];
    const later = [];
    let subdirs = 0;
    for (const name of [...node.children.keys()].sort()) {
      const c = node.children.get(name);
      const p = prefix ? prefix + '/' + name : name;
      const nb = Buffer.from(name, 'utf8');
      if (S6_PATHS.has(p)) s6 = true;
      if (nb.length > MAX_NAME || !nb.length || nb.includes(0) || nb.includes(0x2f)) {
        warn('skipped ' + p.slice(0, 120) + ': a name longer than ' + MAX_NAME + ' bytes cannot be stored in ext4');
        if (c.type === 'file') unlinked.push([p, c.inode]);
        else if (c.type === 'dir') skipSubtree(c, p);
        continue;
      }
      let cino, ft;
      if (c.type === 'dir') {
        cino = mk({ kind: 'dir', mode: c.mode, uid: c.uid, gid: c.gid, mtime: c.mtime, links: 2 });
        ft = FT.dir;
        subdirs++;
        later.push([c, cino, p]);
      } else if (c.type === 'file') {
        const io = c.inode;
        if (fileIno.has(io)) {
          cino = fileIno.get(io);
          if (inodes[cino].links >= MAX_LINKS) {
            warn('skipped ' + p.slice(0, 120) + ': more than ' + MAX_LINKS + ' hard links to one file');
            unlinked.push([p, io]);
            continue;
          }
          inodes[cino].links++;
        } else {
          cino = mk({ kind: 'file', mode: io.mode, uid: io.uid, gid: io.gid, mtime: io.mtime, size: io.size, links: 1, src: io });
          fileIno.set(io, cino);
        }
        pathIno.set(p, cino);
        ft = FT.file;
      } else if (c.type === 'symlink') {
        const target = Buffer.from(String(c.linkpath || ''), 'utf8');
        if (!target.length || target.length > MAX_SYMLINK) {
          warn('skipped symlink ' + p.slice(0, 120) + ': ' + (target.length ? 'a target longer than ' + MAX_SYMLINK + ' bytes' : 'an empty target') + ' cannot be stored in ext4');
          continue;
        }
        cino = mk({ kind: 'symlink', uid: c.uid, gid: c.gid, mtime: c.mtime, target, links: 1 });
        ft = FT.symlink;
      } else if (c.type === 'fifo' || c.type === 'socket') {
        cino = mk({ kind: c.type, mode: c.mode, uid: c.uid, gid: c.gid, mtime: c.mtime, links: 1 });
        ft = FT[c.type];
      } else if (c.type === 'char' || c.type === 'block') {
        cino = mk({ kind: c.type, mode: c.mode, uid: c.uid, gid: c.gid, mtime: c.mtime, links: 1, major: c.rdevmajor || 0, minor: c.rdevminor || 0 });
        ft = FT[c.type];
      } else continue;
      entries.push({ name: nb, ino: cino, ft });
    }
    // dir_nlink: past EXT4_LINK_MAX a directory's link count is 1
    const links = 2 + subdirs;
    inodes[ino].links = links > MAX_LINKS ? 1 : links;
    dirs.push({ ino, entries });
    for (const [c, cino, p] of later) walkDir(c, cino, ino, p);
  };
  const r = tree.root;
  // "/" is 0755 root:root whatever a layer's "./" entry said (a tarball made
  // from a mktemp -d folder is 0700, one made by a build user is owned by
  // it): Docker presents its own 0755 root:root directory as /, and the RAM
  // root's init runs "chmod 755 /" - with the image's mode, every non-root
  // USER got EACCES on everything (cr-2). The image's mtime is kept.
  inodes[2] = { kind: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: r.mtime, links: 2 };
  walkDir(r, 2, 2, '');
  for (const [p, io] of unlinked) if (fileIno.has(io)) pathIno.set(p, fileIno.get(io));
  const lastIno = nextIno - 1;

  // ---- 2. sizes -> geometry
  let dataBlocks = 0;
  const dirBlockN = new Map();
  for (const d of dirs) { const n = dirBlockCount(d.entries); dirBlockN.set(d.ino, n); dataBlocks += n + leafBlocksFor(Math.ceil(n / extMax)); }
  for (let i = FIRST_INO; i <= lastIno; i++) {
    const n = inodes[i];
    if (n.kind === 'symlink' && n.target.length >= 60) dataBlocks += 1;
    if (n.kind === 'file' && n.size) {
      const nb = Math.ceil(n.size / BS);
      const nExt = Math.ceil(nb / extMax);
      if (nExt > 4 * LEAF_MAX) {
        throw Object.assign(new Error('a file of the image is ' + Math.round(n.size / 1073741824) + ' GB: larger than an image disk can map'), { code: 'IMAGE_TOO_LARGE' });
      }
      dataBlocks += nb + leafBlocksFor(nExt);
    }
  }
  const needBytes = dataBlocks * BS;
  const minBytes = (opts.minGB === undefined ? 8 : opts.minGB) * 1073741824;
  const sizeBytes = opts.sizeBytes || Math.max(minBytes, 2 * needBytes + 256 * 1048576);
  let blocks = Math.floor(sizeBytes / BS);
  if (blocks > BPG && blocks % BPG && blocks % BPG < 1024) blocks -= blocks % BPG;
  if (blocks < 4096) throw new Error('image disk too small (minimum 16 MiB)');
  const groups = Math.ceil(blocks / BPG);
  const ratio = opts.inodeRatio || 16384;
  let ipg = Math.max(IPB, Math.min(BPG, Math.ceil(Math.floor((BPG * BS) / ratio) / IPB) * IPB));
  if (groups === 1) ipg = Math.max(IPB * 4, Math.min(ipg, Math.ceil(Math.floor(blocks * BS / ratio) / IPB) * IPB));
  // inodes for the image and as many again for what the container creates
  const wantInodes = 2 * lastIno + 1024;
  while (ipg * groups < wantInodes && ipg < BPG) ipg = Math.min(BPG, ipg * 2);
  if (ipg * groups < lastIno + 16) throw Object.assign(new Error('too many files (' + lastIno + ') for an image disk of ' + Math.round(blocks * BS / 1073741824) + ' GiB'), { code: 'IMAGE_TOO_LARGE' });
  const itb = ipg / IPB;
  const gdtBlocks = Math.ceil((groups * 32) / BS);
  const jBlocks = opts.journalBlocks !== undefined ? opts.journalBlocks : imageJournalBlocks(blocks);
  let p = 1 + gdtBlocks;
  const bbStart = p; p += groups;
  const ibStart = p; p += groups;
  const itStart = p; p += groups * itb;
  const jStart = p; p += jBlocks;
  const metaEnd = p;

  // ---- 3. block allocation: directories, slow symlinks, then file data in
  //         the order emitTree delivers it (extras, then by layer and tar
  //         ordinal), so the file is written front to back
  let next = metaEnd;
  const ext = new Map(); // ino -> {iblock, leaves, sectors, start}
  for (const d of dirs) {
    const n = dirBlockN.get(d.ino);
    const start = next; next += n;
    const t = extentTree(runExtents(start, n, extMax), next);
    next += t.leaves.length;
    inodes[d.ino].size = n * BS;
    ext.set(d.ino, { iblock: t.iblock, leaves: t.leaves, sectors: (n + t.leaves.length) * (BS / 512), start });
  }
  for (let i = FIRST_INO; i <= lastIno; i++) {
    const n = inodes[i];
    if (n.kind !== 'symlink' || n.target.length < 60) continue;
    const start = next++;
    ext.set(i, { iblock: extentTree(runExtents(start, 1, extMax), next).iblock, leaves: [], sectors: BS / 512, start });
  }
  const fileOrder = [];
  for (let i = FIRST_INO; i <= lastIno; i++) if (inodes[i].kind === 'file' && inodes[i].size) fileOrder.push(i);
  const order = (i) => { const s = inodes[i].src; return s.extra ? [-1, 0] : [s.layer, s.ordinal]; };
  fileOrder.sort((a, b) => { const ka = order(a), kb = order(b); return ka[0] - kb[0] || ka[1] - kb[1] || a - b; });
  for (const i of fileOrder) {
    const n = inodes[i];
    const nb = Math.ceil(n.size / BS);
    const start = next; next += nb;
    const t = extentTree(runExtents(start, nb, extMax), next);
    next += t.leaves.length;
    ext.set(i, { iblock: t.iblock, leaves: t.leaves, sectors: (nb + t.leaves.length) * (BS / 512), start });
  }
  const allocEnd = next;
  if (allocEnd > blocks * 0.9) throw new Error('image disk too small: ' + allocEnd + ' of ' + blocks + ' blocks used');

  // ---- 4. metadata writes ({block, n, data} or {block, n, gen})
  const writes = [];
  const inodeOf = (i) => {
    const n = inodes[i];
    const x = ext.get(i);
    let mode, size = 0, flags = 0, iblock = null, sectors = 0;
    if (n.kind === 'dir') { mode = S_IF.dir | (n.mode & 0o7777); size = n.size; flags = EXTENTS_FL; iblock = x.iblock; sectors = x.sectors; }
    else if (n.kind === 'file') {
      mode = S_IF.file | (n.mode & 0o7777); size = n.size; flags = EXTENTS_FL;
      if (x) { iblock = x.iblock; sectors = x.sectors; } else { iblock = Buffer.alloc(60); extHeader(iblock, 0, 0, 4, 0); }
    } else if (n.kind === 'symlink') {
      mode = S_IF.symlink | 0o777; size = n.target.length;
      // fast symlink: the target lives in i_block (< 60 bytes, no blocks)
      if (size < 60) { iblock = Buffer.alloc(60); n.target.copy(iblock); }
      else { flags = EXTENTS_FL; iblock = x.iblock; sectors = x.sectors; }
    } else if (n.kind === 'char' || n.kind === 'block') {
      mode = S_IF[n.kind] | (n.mode & 0o7777);
      iblock = Buffer.alloc(60);
      if (n.major < 256 && n.minor < 256) iblock.writeUInt32LE((n.major << 8) | n.minor, 0);
      else iblock.writeUInt32LE(((n.minor & 0xff) | (n.major << 8) | ((n.minor & ~0xff) << 12)) >>> 0, 4);
    } else mode = S_IF[n.kind] | (n.mode & 0o7777);
    return imageInode({ mode, uid: n.uid || 0, gid: n.gid || 0, size, mtime: n.mtime, links: n.links, sectors, flags, iblock });
  };
  let jIblock = null;
  if (jBlocks) jIblock = extentTree(runExtents(jStart, jBlocks, EXT_MAX), 0).iblock;
  // inode table, group by group: at most ipg x 256 bytes (2 MiB) at a time
  for (let g = 0; g * ipg < lastIno; g++) {
    const first = g * ipg + 1, last = Math.min(lastIno, (g + 1) * ipg);
    const nBlocks = Math.ceil(((last - first + 1) * ISIZE) / BS);
    writes.push({
      block: itStart + g * itb, n: nBlocks,
      gen: () => {
        const b = Buffer.alloc(nBlocks * BS);
        for (let i = Math.max(first, 2); i <= last; i++) {
          if (i === 8 && jIblock) {
            imageInode({ mode: 0o100600, uid: 0, gid: 0, size: jBlocks * BS, mtime: now, links: 1, sectors: jBlocks * (BS / 512), flags: EXTENTS_FL, iblock: jIblock })
              .copy(b, (i - first) * ISIZE);
            continue;
          }
          if (inodes[i]) inodeOf(i).copy(b, (i - first) * ISIZE); // 3..10 stay zero (reserved)
        }
        return b;
      },
    });
  }
  // bitmaps and group descriptors
  const gdt = Buffer.alloc(gdtBlocks * BS);
  let freeBlocksTotal = 0, freeInodesTotal = 0;
  const dirsPerGroup = new Array(groups).fill(0);
  for (let i = 2; i <= lastIno; i++) if (inodes[i] && inodes[i].kind === 'dir') dirsPerGroup[Math.floor((i - 1) / ipg)]++;
  for (let g = 0; g < groups; g++) {
    const gStart = g * BPG, gBlocks = Math.min(BPG, blocks - gStart);
    const usedHere = Math.max(0, Math.min(allocEnd, gStart + gBlocks) - gStart);
    if (usedHere || gBlocks < BPG) {
      const bb = Buffer.alloc(BS);
      setBits(bb, 0, usedHere);
      if (gBlocks < BPG) setBits(bb, gBlocks, BPG); // past the end of the FS
      writes.push({ block: bbStart + g, n: 1, data: bb });
    }
    freeBlocksTotal += gBlocks - usedHere;
    const iUsed = Math.max(0, Math.min(lastIno, (g + 1) * ipg) - g * ipg);
    if (iUsed || ipg < BS * 8) {
      const ib = Buffer.alloc(BS);
      setBits(ib, 0, iUsed);
      if (ipg < BS * 8) setBits(ib, ipg, BS * 8);
      writes.push({ block: ibStart + g, n: 1, data: ib });
    }
    freeInodesTotal += ipg - iUsed;
    const d = g * 32;
    gdt.writeUInt32LE(bbStart + g, d + 0x0);
    gdt.writeUInt32LE(ibStart + g, d + 0x4);
    gdt.writeUInt32LE(itStart + g * itb, d + 0x8);
    gdt.writeUInt16LE(gBlocks - usedHere, d + 0xC);
    gdt.writeUInt16LE(ipg - iUsed, d + 0xE);
    gdt.writeUInt16LE(dirsPerGroup[g], d + 0x10);
  }
  writes.push({ block: 1, n: gdtBlocks, data: gdt });
  const seed = opts.key ? String(opts.key) : crypto.randomBytes(16).toString('hex');
  const uuid = Buffer.from(keyBytes(seed, 'uuid'));
  uuid[6] = (uuid[6] & 0x0f) | 0x40; uuid[8] = (uuid[8] & 0x3f) | 0x80; // v4 shape
  if (jBlocks) {
    const js = Buffer.alloc(BS);
    js.writeUInt32BE(0xC03B3998, 0x0); js.writeUInt32BE(4, 0x4); js.writeUInt32BE(0, 0x8);
    js.writeUInt32BE(BS, 0xC); js.writeUInt32BE(jBlocks, 0x10); js.writeUInt32BE(1, 0x14);
    js.writeUInt32BE(1, 0x18); js.writeUInt32BE(0, 0x1C); uuid.copy(js, 0x30); js.writeUInt32BE(1, 0x40); uuid.copy(js, 0x100);
    writes.push({ block: jStart, n: 1, data: js });
  }
  const sb = Buffer.alloc(1024);
  sb.writeUInt32LE(groups * ipg, 0x0);
  sb.writeUInt32LE(blocks, 0x4);
  sb.writeUInt32LE(0, 0x8);                         // reserved blocks: none
  sb.writeUInt32LE(freeBlocksTotal, 0xC);
  sb.writeUInt32LE(freeInodesTotal, 0x10);
  sb.writeUInt32LE(0, 0x14);
  sb.writeUInt32LE(2, 0x18); sb.writeUInt32LE(2, 0x1C);
  sb.writeUInt32LE(BPG, 0x20); sb.writeUInt32LE(BPG, 0x24); sb.writeUInt32LE(ipg, 0x28);
  sb.writeUInt32LE(0, 0x2C); sb.writeUInt32LE(now, 0x30);
  sb.writeUInt16LE(0, 0x34); sb.writeUInt16LE(0xFFFF, 0x36);
  sb.writeUInt16LE(0xEF53, 0x38); sb.writeUInt16LE(1, 0x3A); sb.writeUInt16LE(1, 0x3C);
  sb.writeUInt32LE(now, 0x40); sb.writeUInt32LE(0, 0x48); sb.writeUInt32LE(1, 0x4C);
  sb.writeUInt32LE(FIRST_INO, 0x54); sb.writeUInt16LE(ISIZE, 0x58);
  sb.writeUInt32LE(COMPAT.EXT_ATTR | COMPAT.DIR_INDEX | COMPAT.SPARSE_SUPER2 | (jBlocks ? COMPAT.HAS_JOURNAL : 0), 0x5C);
  sb.writeUInt32LE(INCOMPAT.FILETYPE | INCOMPAT.EXTENTS | INCOMPAT.FLEX_BG, 0x60);
  sb.writeUInt32LE(RO_COMPAT.LARGE_FILE | RO_COMPAT.DIR_NLINK | RO_COMPAT.EXTRA_ISIZE, 0x64);
  uuid.copy(sb, 0x68);
  Buffer.from(String(opts.label || 'devbox-image').slice(0, 16), 'utf8').copy(sb, 0x78, 0, 16);
  sb.writeUInt32LE(jBlocks ? 8 : 0, 0xE0);
  keyBytes(seed, 'hash').copy(sb, 0xEC);            // s_hash_seed
  sb.writeUInt8(1, 0xFC); sb.writeUInt8(jBlocks ? 1 : 0, 0xFD);
  sb.writeUInt32LE(0x0C, 0x100); sb.writeUInt32LE(now, 0x108);
  if (jIblock) {
    for (let i = 0; i < 15; i++) sb.writeUInt32LE(jIblock.readUInt32LE(i * 4), 0x10C + i * 4);
    sb.writeUInt32LE(0, 0x10C + 60); sb.writeUInt32LE(jBlocks * BS, 0x10C + 64);
  }
  sb.writeUInt16LE(32, 0x15C); sb.writeUInt16LE(32, 0x15E); sb.writeUInt32LE(0x1, 0x160);
  sb.writeUInt8(4, 0x174);
  const b0 = Buffer.alloc(BS);
  sb.copy(b0, 1024);
  writes.push({ block: 0, n: 1, data: b0 });
  for (const d of dirs) {
    const x = ext.get(d.ino);
    const n = dirBlockN.get(d.ino);
    writes.push({ block: x.start, n, gen: () => Buffer.concat(dirBlocks(d.entries)) });
    for (const lf of x.leaves) writes.push({ block: lf.block, n: 1, data: lf.data });
  }
  for (let i = FIRST_INO; i <= lastIno; i++) {
    const n = inodes[i];
    if (n.kind === 'symlink' && n.target.length >= 60) { const b = Buffer.alloc(BS); n.target.copy(b); writes.push({ block: ext.get(i).start, n: 1, data: b }); }
    if (n.kind === 'file') { const x = ext.get(i); if (x) for (const lf of x.leaves) writes.push({ block: lf.block, n: 1, data: lf.data }); }
  }
  writes.sort((a, b) => a.block - b.block);

  // ---- 5. qcow2 cluster map: every cluster a metadata write or a file touches
  const C = 65536;
  const cset = new Set();
  const touch = (blk, n) => { if (!n) return; const a = Math.floor(blk * BS / C), z = Math.floor(((blk + n) * BS - 1) / C); for (let c = a; c <= z; c++) cset.add(c); };
  for (const w of writes) touch(w.block, w.n);
  for (const i of fileOrder) touch(ext.get(i).start, Math.ceil(inodes[i].size / BS));
  const clusters = [...cset].sort((a, b) => a - b);
  const q = planQcow2(blocks * BS, clusters);
  const tPlan = Date.now();

  // ---- 6. facts captured while streaming (the inode, not the path: data of
  //         a hardlink group arrives on its last path)
  const factIno = {};
  for (const k of ['passwd', 'group']) {
    const ino = pathIno.get('etc/' + k);
    if (ino && inodes[ino].kind === 'file' && inodes[ino].size > 0 && inodes[ino].size <= MAX_FACT_TEXT) factIno[ino] = k;
  }
  const facts = { passwd: null, group: null, s6 };

  // ---- 7. write: qcow2 metadata, ext4 metadata + directories, file data
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(part, 'w');
  const w = new PositionalWriter(fd);
  let dataBytes = 0, ok = false;
  const putAt = (guest, data) => {
    let g = guest, off = 0;
    while (off < data.length) {
      const n = Math.min(C - (g % C), data.length - off);
      w.write(q.hostOffset(g), data.subarray(off, off + n));
      g += n; off += n;
    }
  };
  try {
    w.write(0, q.meta);
    for (const x of writes) putAt(x.block * BS, x.data || x.gen());
    await layers.emitTree(tree, async (entry, data) => {
      if (signal && signal.aborted) throw abortError();
      if (entry.type !== 'file' || !entry.size || data == null) return;
      const ino = pathIno.get(entry.path);
      if (!ino) {
        // a path that was skipped and shares no inode with a kept one
        if (!Buffer.isBuffer(data)) for await (const c of data) { void c; }
        return;
      }
      const n = inodes[ino];
      const fact = factIno[ino];
      const parts = fact ? [] : null;
      let g = ext.get(ino).start * BS, got = 0;
      const put = (chunk) => {
        if (got + chunk.length > n.size) throw new Error(entry.path + ': more data than its size ' + n.size);
        putAt(g, chunk);
        if (parts) parts.push(Buffer.from(chunk));
        g += chunk.length; got += chunk.length;
      };
      if (Buffer.isBuffer(data)) put(data);
      else for await (const c of data) put(Buffer.isBuffer(c) ? c : Buffer.from(c));
      if (got !== n.size) throw new Error(entry.path + ': got ' + got + ' of ' + n.size + ' bytes');
      dataBytes += got;
      if (parts) facts[fact] = Buffer.concat(parts).toString('utf8');
      // the rest of the file's last block is its own (zeros): written, so the
      // next file continues the same buffered run (no seek per file)
      const tail = (BS - (n.size % BS)) % BS;
      if (tail) putAt(g, ZERO_BLOCK.subarray(0, tail));
    }, { includeRoot: false });
    w.flush();
    fs.ftruncateSync(fd, q.fileBytes);
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(part, { force: true });
  }
  try {
    if (fs.existsSync(file)) fs.rmSync(part, { force: true }); // another builder's identical file
    else fs.renameSync(part, file);
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (!fs.existsSync(file)) throw e;
  }
  return {
    ms: Date.now() - t0, planMs: tPlan - t0, writeMs: Date.now() - tPlan,
    inodes: lastIno, dirs: dirs.length, files: fileOrder.length, dataBytes, sizeBytes: blocks * BS, blocks, groups, ipg,
    usedBlocks: allocEnd, metaBlocks: metaEnd, journalBlocks: jBlocks, fileBytes: q.fileBytes, clusters: clusters.length,
    writes: w.writes, warnings, facts, uuid: uuid.toString('hex'),
  };
}

module.exports = {
  layoutExt4, writeRaw, createQcow2, createQcow2WithQemuImg, parseSuperblock, defaultJournalBlocks, BS, BPG,
  buildImageExt4, timeParts, dirBlocks, dirBlockCount, IMAGE_EXT4_FORMAT,
};
