'use strict';
/*
 * Linux initramfs cpio ("newc", magic 070701): a streaming writer, a streaming
 * reader, an initramfs sanity checker, and flattenToCpio(), which turns an
 * OCI image into ONE initramfs archive of its root filesystem without Docker:
 *
 *   const { flattenToCpio } = require('./cpio');
 *   const r = await flattenToCpio('nginx:alpine', 'out/nginx.cpio.gz', { root: 'data/images' });
 *   // r.runtime = entrypoint/cmd/env/user/workdir/ports; boot with -initrd
 *
 * Format (what init/initramfs.c accepts): each entry is a 110-byte ASCII
 * header "070701" + 13 eight-digit hex fields (ino, mode, uid, gid, nlink,
 * mtime, filesize, devmajor, devminor, rdevmajor, rdevminor, namesize,
 * check), the NUL-terminated name, padding to 4 bytes, the data, padding to
 * 4 bytes. "TRAILER!!!" ends an archive; zero bytes between archives are
 * skipped, so several archives (each optionally gzip'd) can be concatenated
 * and a later one's entries replace earlier ones at the same path - that is
 * how a per-run init archive goes on top of a cached image archive.
 * ALIGNMENT: a raw archive is only recognised at a file offset that is a
 * multiple of 4 (init/initramfs.c checks `this_header & 3`); after a gzip
 * member of odd length the kernel panics with "invalid magic at start of
 * compressed archive". Everything written here is zero-padded to 512 bytes,
 * and readInitrd() enforces the same rule when reading.
 *
 * Kernel rules this module respects:
 *  - parents must come before children (the unpacker never creates them);
 *  - regular files sharing (ino, mode) with nlink >= 2 are hard links; the
 *    kernel links every later header to the first one and writes whatever
 *    data a header carries into the shared inode, so data may sit on any one
 *    of them - we put it on the LAST (gen_init_cpio / GNU cpio convention);
 *    the link table is reset at each TRAILER!!!, so inode numbers only have
 *    to be unique within one archive;
 *  - names are at most PATH_MAX-1 (4095) bytes, files at most 4 GiB - 1,
 *    mtimes are 32-bit; xattrs cannot be carried at all.
 *
 * This is the ONLY newc writer in the app (bug F: the kernel prototype had a
 * second, buffer-based one). It serves both uses:
 *  - streaming: new CpioWriter(writable) - image root filesystems (hundreds
 *    of MB, file data streamed straight from the layer blobs), copy-in;
 *  - in memory: new CpioWriter() or new CpioWriter(null, {autoParents: true})
 *    - small archives such as the microVM init archive; toBuffer() returns
 *    the bytes after finish(). autoParents adds every missing parent
 *    directory (0755, root) before an entry, because the kernel's unpacker
 *    never creates one itself. dir()/file()/symlink()/device() are
 *    shorthands for add().
 *
 * Temporary files are unique per writer (<file>.<pid>.<random>.part) and a
 * finished archive that another writer already renamed into place is used as
 * it is ("exists = success"): the output is deterministic for one image, so
 * both copies are identical (bug V4a - three concurrent first runs of one
 * image collided on a fixed "<archive>.part").
 *
 * Cache files (ensureRootfsCpio): rootfs/<config hex>-v<FORMAT_VERSION>.cpio
 * plus its .json sidecar. The archive is TRANSIENT - the microVM engine
 * deletes it once the image's initrd (which holds a full copy) exists - while
 * the sidecar (runtime config, sizes, flatten warnings) is KEPT; see
 * rootfsPaths() / readRootfsMeta().
 *
 * Exports: CpioWriter, CpioError, readCpio, readInitrd, openCpioStream, listCpio,
 * listCpioBuffer, checkInitramfs, flattenToCpio, ensureRootfsCpio,
 * rootfsPaths, readRootfsMeta, addRuntimeBasics, cpioName, partName, S_IF,
 * FORMAT_VERSION.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const registry = require('./registry');
const layers = require('./layers');

const S_IF = {
  fifo: 0o010000, char: 0o020000, dir: 0o040000, block: 0o060000,
  file: 0o100000, symlink: 0o120000, socket: 0o140000,
};
const S_IFMT = 0o170000;
const TYPE_OF = new Map(Object.entries(S_IF).map(([k, v]) => [v, k]));
const MAX_NAME = 4095;
const MAX_U32 = 0xffffffff;
const HEADER_LEN = 110;
const TRAILER = 'TRAILER!!!';
const ZERO = Buffer.alloc(512);
const FLUSH_AT = 256 * 1024;
// Bump when the produced archive for the same image would differ.
const FORMAT_VERSION = 1;

class CpioError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'CpioError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const pad4 = (n) => (4 - (n % 4)) % 4;
const hex8 = (n) => n.toString(16).padStart(8, '0');

// A temporary file name no other writer uses (see the header: bug V4a).
function partName(file) {
  return file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
}

// The sink of an in-memory writer: collects what a Writable would receive.
class MemorySink {
  constructor() { this.chunks = []; this.length = 0; this.destroyed = false; this.writableEnded = false; }
  write(buf) { this.chunks.push(Buffer.from(buf)); this.length += buf.length; return true; }
  toBuffer() { return Buffer.concat(this.chunks, this.length); }
}

/** Archive name for a path: no leading "/" or "./", root is ".". Throws on "..". */
function cpioName(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new CpioError('CPIO_NAME', `path with "..": ${p}`);
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : '.';
}

function u32(v, what, name) {
  const n = Math.floor(Number(v) || 0);
  if (n < 0 || n > MAX_U32) throw new CpioError('CPIO_RANGE', `${name}: ${what} ${v} does not fit the 32-bit newc field`);
  return n;
}

/** Wait for a writable stream to accept `buf` (honours backpressure). */
function writeTo(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed || out.writableEnded) { reject(new CpioError('CPIO_CLOSED', 'output stream is closed')); return; }
    if (out.write(buf)) { resolve(); return; }
    const cleanup = () => { out.off('drain', onDrain); out.off('error', onError); out.off('close', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new CpioError('CPIO_CLOSED', 'output stream closed while writing')); };
    out.on('drain', onDrain);
    out.on('error', onError);
    out.on('close', onClose);
  });
}

// ---------------------------------------------------------------- writer

/**
 * newc writer onto a Writable (streaming) or into memory (no `out`). Small
 * pieces are batched; file data given as an AsyncIterable is streamed
 * straight through.
 *   const w = new CpioWriter(fs.createWriteStream('x.cpio'));
 *   await w.add({ path: 'etc', type: 'dir', mode: 0o755 });
 *   await w.add({ path: 'etc/hi', type: 'file', mode: 0o644, size: 3 }, Buffer.from('hi\n'));
 *   await w.finish();          // writes TRAILER!!! (does NOT end the stream)
 *
 *   const m = new CpioWriter(null, { autoParents: true, mtime: 0 });
 *   await m.file('.devbox/init', script, 0o755);   // ".devbox" is added first
 *   await m.finish(); const buf = m.toBuffer();
 * entry: {path, type: 'file'|'dir'|'symlink'|'char'|'block'|'fifo'|'socket',
 *   mode (permission bits; type bits are added), uid, gid, mtime (s), size
 *   (files: bytes that `data` will yield; symlinks: ignored), nlink, ino
 *   (auto when omitted), linkpath (symlinks), rdevmajor/rdevminor (devices)}
 * data: null | Buffer | string | AsyncIterable<Buffer> (files), ignored otherwise.
 * opts: {inoStart (1), autoParents (false), mtime (default for entries
 *   without one; 0 keeps archives reproducible)}
 */
class CpioWriter {
  constructor(out, opts) {
    opts = opts || {};
    this.memory = !out;
    this.out = out || new MemorySink();
    this.bytes = 0; // archive bytes produced (before any compression)
    this.entries = 0;
    this.dataBytes = 0;
    this._ino = opts.inoStart || 1;
    this._pending = [];
    this._pendingLen = 0;
    this._finished = false;
    this._autoParents = !!opts.autoParents;
    this._mtime = opts.mtime;
    this._dirs = new Set(['.']);
  }

  /** The archive bytes of an in-memory writer (after finish()). */
  toBuffer() {
    if (!this.memory) throw new CpioError('CPIO_TYPE', 'toBuffer() is only for in-memory writers (new CpioWriter() without a stream)');
    return this.out.toBuffer();
  }

  // shorthands (all resolve when the entry was written)
  dir(p, mode, extra) { return this.add(Object.assign({ path: p, type: 'dir', mode }, extra || {})); }
  file(p, data, mode, extra) {
    const buf = data == null ? Buffer.alloc(0) : (Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    return this.add(Object.assign({ path: p, type: 'file', mode, size: buf.length }, extra || {}), buf);
  }
  symlink(p, target, extra) { return this.add(Object.assign({ path: p, type: 'symlink', linkpath: target }, extra || {})); }
  device(p, kind, major, minor, mode) {
    return this.add({ path: p, type: kind, mode: mode === undefined ? 0o600 : mode, rdevmajor: major, rdevminor: minor });
  }

  // autoParents: every ancestor of `name` that this archive has not created
  // yet, as a 0755 root-owned directory (the kernel never creates parents).
  async _parents(name) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!this._dirs.has(d)) await this.add({ path: d, type: 'dir', mode: 0o755 });
    }
  }

  _queue(buf) {
    this._pending.push(buf);
    this._pendingLen += buf.length;
    this.bytes += buf.length;
  }

  async _flush() {
    if (!this._pendingLen) return;
    const buf = this._pending.length === 1 ? this._pending[0] : Buffer.concat(this._pending, this._pendingLen);
    this._pending = [];
    this._pendingLen = 0;
    await writeTo(this.out, buf);
  }

  _header(name, f) {
    const nameBuf = Buffer.from(name + '\0', 'utf8');
    if (nameBuf.length - 1 > MAX_NAME) throw new CpioError('CPIO_NAME', `name longer than ${MAX_NAME} bytes: ${name.slice(0, 80)}...`);
    const h = '070701' + hex8(f.ino) + hex8(f.mode) + hex8(f.uid) + hex8(f.gid) + hex8(f.nlink) + hex8(f.mtime) +
      hex8(f.size) + hex8(0) + hex8(0) + hex8(f.rdevmajor) + hex8(f.rdevminor) + hex8(nameBuf.length) + hex8(0);
    this._queue(Buffer.from(h, 'latin1'));
    this._queue(nameBuf);
    const p = pad4(HEADER_LEN + nameBuf.length);
    if (p) this._queue(ZERO.subarray(0, p));
  }

  /** Append one entry. Resolves when its bytes were handed to the stream. */
  async add(entry, data) {
    if (this._finished) throw new CpioError('CPIO_CLOSED', 'archive already finished');
    const name = cpioName(entry.path);
    const type = entry.type || 'file';
    if (!S_IF[type]) throw new CpioError('CPIO_TYPE', `${name}: unsupported entry type ${type}`);
    if (this._autoParents && name !== '.') await this._parents(name);
    if (type === 'dir') this._dirs.add(name);
    if (entry.mtime === undefined && this._mtime !== undefined) entry = Object.assign({}, entry, { mtime: this._mtime });
    const perm = (entry.mode == null ? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644) : entry.mode) & 0o7777;
    let body = null;
    let size = 0;
    if (type === 'symlink') {
      if (!entry.linkpath) throw new CpioError('CPIO_TYPE', `${name}: symlink without a target`);
      body = Buffer.from(String(entry.linkpath), 'utf8');
      size = body.length;
    } else if (type === 'file') {
      if (data == null) {
        size = entry.size || 0;
        if (size) throw new CpioError('CPIO_SIZE', `${name}: size ${size} but no data`);
      } else if (Buffer.isBuffer(data) || typeof data === 'string') {
        body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        size = body.length;
        if (entry.size != null && entry.size !== size) throw new CpioError('CPIO_SIZE', `${name}: size ${entry.size} but ${size} bytes of data`);
      } else {
        size = entry.size;
        if (size == null) throw new CpioError('CPIO_SIZE', `${name}: streamed data needs entry.size`);
      }
    }
    const f = {
      ino: u32(entry.ino != null ? entry.ino : this._ino++, 'ino', name),
      mode: S_IF[type] | perm,
      uid: u32(entry.uid, 'uid', name),
      gid: u32(entry.gid, 'gid', name),
      nlink: u32(entry.nlink != null ? entry.nlink : (type === 'dir' ? 2 : 1), 'nlink', name),
      mtime: Math.min(MAX_U32, Math.max(0, Math.floor(Number(entry.mtime) || 0))),
      size: u32(size, 'file size', name),
      rdevmajor: type === 'char' || type === 'block' ? u32(entry.rdevmajor, 'rdevmajor', name) : 0,
      rdevminor: type === 'char' || type === 'block' ? u32(entry.rdevminor, 'rdevminor', name) : 0,
    };
    if (entry.ino != null && entry.ino >= this._ino) this._ino = entry.ino + 1;
    this._header(name, f);
    this.entries++;
    if (body) {
      if (body.length) this._queue(body);
    } else if (type === 'file' && data != null && size > 0) {
      // Streamed data: flush the batch, then pass chunks straight through.
      await this._flush();
      let got = 0;
      for await (const c of data) {
        const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        got += chunk.length;
        if (got > size) throw new CpioError('CPIO_SIZE', `${name}: data is longer than the declared ${size} bytes`);
        this.bytes += chunk.length;
        await writeTo(this.out, chunk);
      }
      if (got !== size) throw new CpioError('CPIO_SIZE', `${name}: got ${got} of the declared ${size} bytes`);
    } else if (type === 'file' && data != null && typeof data[Symbol.asyncIterator] === 'function') {
      for await (const c of data) if (c && c.length) throw new CpioError('CPIO_SIZE', `${name}: data for an empty entry`);
    }
    this.dataBytes += size;
    const p = pad4(size);
    if (p) this._queue(ZERO.subarray(0, p));
    if (this._pendingLen >= FLUSH_AT) await this._flush();
  }

  /**
   * Write the trailer and flush. opts.padTo (512): pad the archive with zeros
   * to a multiple of this (0 = no padding). Does not end the stream.
   * Resolves the archive length in bytes.
   */
  async finish(opts) {
    opts = opts || {};
    if (this._finished) return this.bytes;
    this._header(TRAILER, { ino: 0, mode: 0, uid: 0, gid: 0, nlink: 1, mtime: 0, size: 0, rdevmajor: 0, rdevminor: 0 });
    const padTo = opts.padTo == null ? 512 : opts.padTo;
    if (padTo > 0) {
      let p = (padTo - (this.bytes % padTo)) % padTo;
      while (p > 0) { const n = Math.min(p, ZERO.length); this._queue(ZERO.subarray(0, n)); p -= n; }
    }
    this._finished = true;
    await this._flush();
    return this.bytes;
  }
}

// ---------------------------------------------------------------- reader

async function openCpioStream(file) {
  // Same sniffing as layer blobs: gzip, zstd or raw.
  return layers.openLayerStream(file);
}

/**
 * Stream the entries of one or more concatenated newc archives.
 * @param {AsyncIterable<Buffer>|ByteReader} source  uncompressed archive bytes
 * @param {{untilTrailer?: boolean, state?: object}} [opts]  untilTrailer: stop
 *   right after the first TRAILER!!!; state.archives is kept up to date
 * @yields {{name, archive, ino, mode, type, perm, uid, gid, nlink, mtime, size,
 *   devmajor, devminor, rdevmajor, rdevminor, magic, offset, body(): AsyncIterable<Buffer>}}
 * TRAILER!!! entries are not yielded; `archive` counts them (0-based).
 * Unread data is skipped. Throws CpioError CPIO_FORMAT on garbage.
 */
async function* readCpio(source, opts) {
  const untilTrailer = !!(opts && opts.untilTrailer);
  const r = source instanceof layers.ByteReader ? source : new layers.ByteReader(source);
  let archive = 0;
  let remaining = 0;
  let padding = 0;
  for (;;) {
    if (remaining) await r.skip(remaining);
    remaining = 0;
    if (padding) await r.skip(padding);
    padding = 0;
    const offset = r.position;
    let head = await r.read(4);
    if (head.length === 0) return;
    if (head.length < 4) throw new CpioError('CPIO_FORMAT', `truncated archive at offset ${offset}`);
    if (head[0] === 0 && head[1] === 0 && head[2] === 0 && head[3] === 0) continue; // padding between archives
    const rest = await r.read(HEADER_LEN - 4);
    if (rest.length < HEADER_LEN - 4) throw new CpioError('CPIO_FORMAT', `truncated header at offset ${offset}`);
    head = Buffer.concat([head, rest]);
    const magic = head.toString('latin1', 0, 6);
    if (magic !== '070701' && magic !== '070702') {
      throw new CpioError('CPIO_FORMAT', `bad magic ${JSON.stringify(magic)} at offset ${offset} (not a newc archive)`);
    }
    const f = [];
    for (let i = 0; i < 13; i++) {
      const s = head.toString('latin1', 6 + i * 8, 14 + i * 8);
      if (!/^[0-9a-fA-F]{8}$/.test(s)) throw new CpioError('CPIO_FORMAT', `bad header field at offset ${offset}`);
      f.push(parseInt(s, 16));
    }
    const [ino, mode, uid, gid, nlink, mtime, size, devmajor, devminor, rdevmajor, rdevminor, namesize] = f;
    if (namesize < 1 || namesize > 4096) throw new CpioError('CPIO_FORMAT', `bad name size ${namesize} at offset ${offset}`);
    const nameBuf = await r.read(namesize);
    if (nameBuf.length < namesize) throw new CpioError('CPIO_FORMAT', `truncated name at offset ${offset}`);
    if (nameBuf[namesize - 1] !== 0) throw new CpioError('CPIO_FORMAT', `name not NUL-terminated at offset ${offset}`);
    const name = nameBuf.toString('utf8', 0, namesize - 1);
    const np = pad4(HEADER_LEN + namesize);
    if (np) await r.skip(np);
    remaining = size;
    padding = pad4(size);
    if (name === TRAILER) {
      archive++;
      if (opts && opts.state) opts.state.archives = archive;
      if (untilTrailer) return;
      continue;
    }
    let used = false;
    yield {
      name, archive, ino, mode, type: TYPE_OF.get(mode & S_IFMT) || 'unknown', perm: mode & 0o7777,
      uid, gid, nlink, mtime, size, devmajor, devminor, rdevmajor, rdevminor, magic, offset,
      body() {
        if (used) throw new Error('cpio entry body() can only be read once');
        used = true;
        return (async function* bodyGen() {
          for await (const c of r.chunks(remaining)) { remaining -= c.length; yield c; }
        })();
      },
    };
  }
}

/** Length of a gzip member header (RFC 1952) that starts at buf[0]. */
function gzipHeaderLength(buf, pos, file) {
  const bad = (why) => new CpioError('CPIO_FORMAT', `gzip member at offset ${pos} of ${file}: ${why}`);
  if (buf.length < 10) throw bad('truncated header');
  if (buf[2] !== 8) throw bad(`compression method ${buf[2]} is not deflate`);
  const flg = buf[3];
  let n = 10;
  if (flg & 4) { if (buf.length < n + 2) throw bad('truncated FEXTRA'); n += 2 + buf.readUInt16LE(n); }
  for (const bit of [8, 16]) {
    if (flg & bit) {
      const z = buf.indexOf(0, n);
      if (z < 0) throw bad('header name/comment longer than 64 KiB');
      n = z + 1;
    }
  }
  if (flg & 2) n += 2;
  if (n > buf.length) throw bad('truncated header');
  return n;
}

const MAGICS = [
  ['zstd', [0x28, 0xb5, 0x2f, 0xfd]], ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a]], ['bzip2', [0x42, 0x5a, 0x68]],
  ['lzma', [0x5d, 0x00, 0x00]], ['lz4', [0x02, 0x21, 0x4c, 0x18]], ['lzo', [0x89, 0x4c, 0x5a, 0x4f]],
];

/**
 * Walk an initrd file the way the kernel's unpack_to_rootfs() does: raw newc
 * archives (which must start at a 4-byte-aligned file offset), zero padding
 * (skipped), and gzip members, in any order. Yields readCpio() entries plus
 * {segment, segmentOffset, compression: 'none'|'gzip'} and `archive` counted
 * across the whole file. Every entry's body() must be consumed or skipped
 * before the next one. The returned generator's `.info` is filled as it goes:
 * {segments: [{offset, length, compression, bytes}], archives, bytes}.
 * Throws CPIO_FORMAT where the kernel would stop ("invalid magic at start of
 * compressed archive"), CPIO_COMPRESSION for compressors Node cannot undo.
 */
function readInitrd(file) {
  const info = { segments: [], archives: 0, bytes: 0 };
  const gen = (async function* walk() {
    const size = (await fs.promises.stat(file)).size;
    const fh = await fs.promises.open(file, 'r');
    const probe = Buffer.alloc(64 * 1024);
    let pos = 0;
    try {
      while (pos < size) {
        const { bytesRead } = await fh.read(probe, 0, probe.length, pos);
        if (!bytesRead) break;
        let i = 0;
        while (i < bytesRead && probe[i] === 0) i++;
        if (i === bytesRead) { pos += i; continue; }
        if (i > 0 && bytesRead - i < 8 && pos + bytesRead < size) { pos += i; continue; } // re-probe the header
        pos += i;
        const at = probe.subarray(i, bytesRead);
        const magic = at.toString('latin1', 0, 6);
        const segment = info.segments.length;
        if (magic === '070701' || magic === '070702') {
          if (pos % 4) {
            throw new CpioError('CPIO_FORMAT', `raw archive at unaligned offset ${pos} of ${file}: the kernel only accepts a header at a multiple of 4 ` +
              '("invalid magic at start of compressed archive"); pad the previous compressed member with zeros');
          }
          const rs = fs.createReadStream(file, { start: pos, highWaterMark: 1 << 20 });
          const reader = new layers.ByteReader(rs);
          try {
            for await (const e of readCpio(reader, { untilTrailer: true })) {
              yield Object.assign(e, { archive: info.archives, segment, segmentOffset: pos, compression: 'none' });
            }
          } finally { await reader.close(); rs.destroy(); }
          const len = reader.position;
          info.segments.push({ offset: pos, length: len, compression: 'none', bytes: len });
          info.archives++;
          info.bytes += len;
          pos += len;
        } else if (at[0] === 0x1f && at[1] === 0x8b) {
          // One gzip member at a time, as the kernel does: parse the header,
          // inflate the raw deflate stream (it stops at its own end), then
          // check the 8-byte trailer. Node's Gunzip would instead treat any
          // non-zero byte after a member (e.g. a raw archive) as a new member.
          const hdrLen = gzipHeaderLength(at, pos, file);
          const rs = fs.createReadStream(file, { start: pos + hdrLen, highWaterMark: 1 << 20 });
          const inf = zlib.createInflateRaw({ chunkSize: 256 * 1024 });
          rs.on('error', (err) => inf.destroy(err));
          rs.pipe(inf);
          const counter = { bytes: 0 };
          const reader = new layers.ByteReader((async function* count() {
            for await (const c of inf) { counter.bytes += c.length; yield c; }
          })());
          const base = info.archives;
          const state = { archives: 0 };
          try {
            for await (const e of readCpio(reader, { state })) {
              yield Object.assign(e, { archive: base + e.archive, segment, segmentOffset: pos, compression: 'gzip' });
            }
            await reader.drain();
          } finally { await reader.close(); rs.unpipe(inf); rs.destroy(); }
          // bytesWritten = compressed bytes the inflater consumed: exactly
          // the deflate stream, whatever follows it.
          const deflated = inf.bytesWritten;
          const trailer = Buffer.alloc(8);
          const { bytesRead: tr } = await fh.read(trailer, 0, 8, pos + hdrLen + deflated);
          if (!deflated || tr < 8) throw new CpioError('CPIO_FORMAT', `truncated gzip member at offset ${pos} of ${file}`);
          if (trailer.readUInt32LE(4) !== counter.bytes % 0x100000000) {
            throw new CpioError('CPIO_FORMAT', `gzip member at offset ${pos} of ${file}: size ${counter.bytes} does not match its trailer`);
          }
          const len = hdrLen + deflated + 8;
          info.segments.push({ offset: pos, length: len, compression: 'gzip', bytes: counter.bytes });
          info.archives = base + state.archives;
          info.bytes += counter.bytes;
          pos += len;
        } else {
          const known = MAGICS.find(([, m]) => m.every((b, k) => at[k] === b));
          if (known) throw new CpioError('CPIO_COMPRESSION', `${known[0]}-compressed segment at offset ${pos} of ${file}: only gzip can be read here`);
          throw new CpioError('CPIO_FORMAT', `invalid magic at offset ${pos} of ${file} (the kernel stops unpacking here)`);
        }
      }
    } finally {
      await fh.close();
    }
  })();
  gen.info = info;
  return gen;
}

/**
 * Read a whole initrd file (raw and/or gzip segments, see readInitrd) into a
 * list of entries without their data: each gets sha256 (hex of its data)
 * and, when size <= opts.keepData (4096), `data` (Buffer).
 * Returns {entries, archives, segments, bytes (uncompressed archive bytes up
 * to each TRAILER!!!, excluding zero padding between archives)}.
 */
async function listCpio(file, opts) {
  opts = opts || {};
  const keep = opts.keepData == null ? 4096 : opts.keepData;
  const it = readInitrd(file);
  const entries = [];
  for await (const e of it) {
    const h = crypto.createHash('sha256');
    const parts = [];
    for await (const c of e.body()) {
      h.update(c);
      if (e.size <= keep) parts.push(Buffer.from(c));
    }
    const out = Object.assign({}, e, { sha256: h.digest('hex') });
    delete out.body;
    if (e.size <= keep) out.data = Buffer.concat(parts);
    entries.push(out);
  }
  return { entries, archives: it.info.archives, segments: it.info.segments, bytes: it.info.bytes };
}

/**
 * Check a list of entries (from listCpio) the way the kernel will use it:
 * parents before children, hard-link groups complete with data on at most
 * one member, no ".."/absolute names, no names over 4095 bytes. Duplicate
 * names are allowed across archives (the later one wins) but reported
 * within one archive. Returns {ok, errors: [], warnings: [], stats}.
 */
function checkInitramfs(entries) {
  const errors = [];
  const warnings = [];
  const dirs = new Set(['.']);
  const seen = new Map(); // `${archive}\0${name}` -> index
  const groups = new Map(); // `${archive}:${ino}:${mode}` -> [entries]
  const stats = { entries: entries.length, dirs: 0, files: 0, symlinks: 0, devices: 0, fifos: 0, hardlinkGroups: 0, bytes: 0 };
  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('/') || name.split('/').includes('..')) errors.push(`unsafe name ${name}`);
    if (Buffer.byteLength(name) > MAX_NAME) errors.push(`name too long: ${name.slice(0, 60)}...`);
    const key = `${e.archive}\0${name}`;
    if (seen.has(key)) warnings.push(`duplicate name in archive ${e.archive}: ${name}`);
    seen.set(key, true);
    const norm = name === '.' ? '.' : name.replace(/^\.\//, '');
    const slash = norm.lastIndexOf('/');
    const parent = slash < 0 ? '.' : norm.slice(0, slash);
    if (norm !== '.' && !dirs.has(parent)) errors.push(`${name} comes before its parent directory ${parent}`);
    if (e.type === 'dir') { dirs.add(norm); stats.dirs++; } else dirs.delete(norm);
    if (e.type === 'file') {
      stats.files++;
      stats.bytes += e.size;
      if (e.nlink >= 2) {
        const g = `${e.archive}:${e.ino}:${e.mode}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
    } else if (e.type === 'symlink') stats.symlinks++;
    else if (e.type === 'char' || e.type === 'block') stats.devices++;
    else if (e.type === 'fifo') stats.fifos++;
    else if (e.type === 'unknown') errors.push(`${name}: unknown file type in mode ${e.mode.toString(8)}`);
  }
  for (const [g, members] of groups) {
    stats.hardlinkGroups++;
    const nlink = members[0].nlink;
    if (members.length !== nlink) errors.push(`hard-link group ${g} (${members.map((m) => m.name).join(', ')}) has ${members.length} members but nlink ${nlink}`);
    const withData = members.filter((m) => m.size > 0);
    if (withData.length > 1) errors.push(`hard-link group ${g} carries data on ${withData.length} members`);
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

// ---------------------------------------------------------------- image -> cpio

const MOUNTPOINTS = [['dev', 0o755], ['proc', 0o555], ['sys', 0o555], ['tmp', 0o1777], ['run', 0o755]];
const DEV_NODES = [
  { path: 'dev/console', type: 'char', mode: 0o600, rdevmajor: 5, rdevminor: 1 },
  { path: 'dev/null', type: 'char', mode: 0o666, rdevmajor: 1, rdevminor: 3 },
];

/** Add what a container runtime would provide and an initramfs needs before init runs. */
function addRuntimeBasics(tree, opts) {
  const added = [];
  if (opts.mountpoints !== false) {
    for (const [p, mode] of MOUNTPOINTS) {
      if (!tree.lookup(p)) { tree.addExtra({ path: p, type: 'dir', mode, mtime: 0 }); added.push(p); }
    }
  }
  if (opts.devNodes !== false) {
    const dev = tree.lookup('dev');
    if (!dev || dev.type === 'dir') {
      for (const n of DEV_NODES) {
        if (!tree.lookup(n.path)) { tree.addExtra(Object.assign({ mtime: 0 }, n)); added.push(n.path); }
      }
    }
  }
  return added;
}

function progressFn(opts) {
  return (ev) => { if (opts.onProgress) { try { opts.onProgress(ev); } catch (e) { /* ignore */ } } };
}

/**
 * Pull (or load from cache) an image and write its flattened root filesystem
 * as one newc initramfs archive.
 * @param {string|object} imageRef  reference string or parseImageRef() result
 * @param {string|import('stream').Writable} out  file path (written as
 *   <out>.part, renamed at the end) or a Writable, which is NOT ended (so a
 *   caller can append more archives, e.g. the init one)
 * @param {object} opts
 *   root            image cache dir (required unless opts.image is given)
 *   image           a pullImage() result to use instead of pulling
 *   pullPolicy, platform, credentials, client, concurrency, insecureRegistries: see registry.pullImage
 *   compress        'gzip' | 'none' (default: 'gzip' when out ends with .gz, else 'none')
 *   gzipLevel       1..9 (6)
 *   padTo           512: zero-pad the output (raw archives and gzip members
 *                   alike) to a multiple of this, so whatever is appended
 *                   next starts 4-byte aligned, as the kernel requires
 *   mountpoints     true: add /dev /proc /sys /tmp(1777) /run when missing
 *   devNodes        true: add /dev/console (5,1) and /dev/null (1,3) when missing
 *   includeRoot     true: emit "." with the image's root metadata
 *   extras          [{path, type, mode, uid, gid, mtime, data|source, linkpath,
 *                   rdevmajor, rdevminor}] added last (see RootfsTree.addExtra)
 *   onProgress(ev)  ev.phase: 'pull' | 'blob' | 'index' | 'emit' | 'done'
 *   limits          buildTree caps {maxEntries, maxBytes, maxDepth, maxMetaBytes}
 *   beforeEmit({uncompressedBytes, entries})  async; after the layers are
 *                   indexed, before anything is written: throw to stop (the
 *                   engine's disk-space check on the exact unpacked size)
 * @returns {Promise<{reference, manifestDigest, configDigest, platform, runtime,
 *   layers, compressedBytes, downloadedBytes, uncompressedLayerBytes, rootfs,
 *   stats, warnings, added, cpioBytes, outputBytes, compress, path, timings}>}
 */
async function flattenToCpio(imageRef, out, opts) {
  opts = opts || {};
  const progress = progressFn(opts);
  const t0 = Date.now();
  let img = opts.image;
  if (!img) {
    if (!opts.root) throw new TypeError('flattenToCpio: opts.root (image cache directory) is required');
    progress({ phase: 'pull', ref: String(imageRef.canonical || imageRef) });
    img = await registry.pullImage(imageRef, {
      root: opts.root, pullPolicy: opts.pullPolicy, platform: opts.platform, credentials: opts.credentials,
      client: opts.client, concurrency: opts.concurrency, insecureRegistries: opts.insecureRegistries,
      onRateLimit: opts.onRateLimit, idleTimeoutMs: opts.idleTimeoutMs,
      onProgress: (ev) => progress(Object.assign({}, ev, { phase: ev.phase === 'blob' ? 'blob' : 'pull', pullPhase: ev.phase })),
    });
  }
  const t1 = Date.now();
  progress({ phase: 'index', layers: img.layers.length });
  const tree = await layers.buildTree(img.layers.map((l) => ({ path: l.path, diffId: l.diffId })), { concurrency: opts.concurrency, limits: opts.limits });
  // the exact unpacked size is known now, before a byte is written (sec-3:
  // a disk-space check on the compressed size misses a gzip bomb)
  if (opts.beforeEmit) await opts.beforeEmit({ uncompressedBytes: tree.stats.uncompressedBytes, entries: tree.stats.entries });
  const added = addRuntimeBasics(tree, opts);
  for (const x of opts.extras || []) { tree.addExtra(x); added.push(cpioName(x.path)); }
  const t2 = Date.now();

  const toFile = typeof out === 'string';
  const compress = opts.compress || (toFile && /\.gz$/i.test(out) ? 'gzip' : 'none');
  if (compress !== 'gzip' && compress !== 'none') throw new TypeError(`flattenToCpio: unknown compress "${compress}"`);
  const partFile = toFile ? partName(out) : null;
  let fileStream = null;
  let dest;
  if (toFile) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fileStream = fs.createWriteStream(partFile, { highWaterMark: 1 << 20 });
    dest = fileStream;
  } else dest = out;
  let outputBytes = 0;
  let gz = null;
  let sinkStream = dest;
  if (compress === 'gzip') {
    gz = zlib.createGzip({ level: opts.gzipLevel == null ? 6 : opts.gzipLevel, chunkSize: 256 * 1024 });
    gz.on('data', (c) => { outputBytes += c.length; });
    gz.pipe(dest, { end: false });
    sinkStream = gz;
  }
  const writer = new CpioWriter(sinkStream);
  let emitted;
  try {
    let n = 0;
    emitted = await layers.emitTree(tree, async (entry, data) => {
      await writer.add(entry, data);
      if ((++n & 1023) === 0) progress({ phase: 'emit', entries: n, bytes: writer.bytes });
    }, { includeRoot: opts.includeRoot });
    await writer.finish();
    if (gz) {
      await new Promise((resolve, reject) => {
        gz.once('error', reject);
        gz.once('end', resolve);
        gz.end();
      });
      gz.unpipe(dest);
      // The kernel reads a raw archive after a compressed member only at a
      // 4-byte-aligned offset of the whole initrd; zeros are skipped. Pad.
      const padTo = opts.padTo == null ? 512 : opts.padTo;
      const pad = padTo > 0 ? (padTo - (outputBytes % padTo)) % padTo : 0;
      if (pad) { await writeTo(dest, Buffer.alloc(pad)); outputBytes += pad; }
    } else outputBytes = writer.bytes;
    if (fileStream) {
      await new Promise((resolve, reject) => {
        fileStream.once('error', reject);
        fileStream.once('close', resolve);
        fileStream.end();
      });
      // "exists = success": a concurrent writer finished the same (byte for
      // byte identical) archive first - keep theirs, drop ours. Renaming over
      // it could fail on Windows while a reader has it open.
      if (fs.existsSync(out) && fs.statSync(out).size === outputBytes) fs.rmSync(partFile, { force: true });
      else fs.renameSync(partFile, out);
    }
  } catch (e) {
    if (gz) gz.destroy();
    if (fileStream) {
      fileStream.destroy();
      await new Promise((r) => (fileStream.closed ? r() : fileStream.once('close', r)));
      try { fs.rmSync(partFile, { force: true }); } catch (x) { /* ignore */ }
    }
    throw e;
  }
  const t3 = Date.now();
  const result = {
    reference: img.reference,
    manifestDigest: img.manifestDigest,
    configDigest: img.configDigest,
    platform: img.platform,
    runtime: registry.runtimeConfig(img.config),
    layers: img.layers.length,
    compressedBytes: img.totalCompressed,
    downloadedBytes: img.downloadedBytes || 0,
    uncompressedLayerBytes: tree.stats.uncompressedBytes,
    rootfs: tree.summary(),
    stats: tree.stats,
    warnings: tree.warnings.slice(),
    added,
    entries: emitted.entries,
    cpioBytes: writer.bytes,
    outputBytes,
    compress,
    path: toFile ? path.resolve(out) : null,
    timings: { pullMs: t1 - t0, indexMs: t2 - t1, emitMs: t3 - t2, totalMs: t3 - t0, pull: img.timings },
  };
  progress({ phase: 'done', path: result.path, cpioBytes: result.cpioBytes });
  return result;
}

// A cached archive + sidecar that is complete: the sidecar is written last,
// and its outputBytes must match the archive.
function readCachedArchive(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    if (fs.statSync(file).size === meta.outputBytes) return meta;
  } catch (e) { /* missing or partial */ }
  return null;
}

/**
 * Where the default (uncompressed, standard variant) rootfs archive of an
 * image lives: {archive, meta} under <root>/rootfs/. Pure.
 */
function rootfsPaths(root, configDigest) {
  const hex = String(configDigest || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new CpioError('CPIO_NAME', 'bad image config digest ' + configDigest);
  const archive = path.join(root, 'rootfs', hex + '-v' + FORMAT_VERSION + '.cpio');
  return { archive, meta: archive + '.json' };
}

/**
 * The sidecar of an image's rootfs archive (runtime config, sizes, flatten
 * warnings) WITHOUT requiring the archive itself: the engine deletes the
 * archive once the initrd holds a copy, but keeps this file. null when the
 * image was never flattened with this FORMAT_VERSION.
 */
function readRootfsMeta(root, configDigest) {
  try {
    const meta = JSON.parse(fs.readFileSync(rootfsPaths(root, configDigest).meta, 'utf8'));
    return meta && meta.configDigest === configDigest ? meta : null;
  } catch (e) { return null; }
}

/**
 * Cached image rootfs archive: <root>/rootfs/<config hex>-v<FORMAT_VERSION>
 * [-m?d?r?].cpio[.gz] plus a .json sidecar holding the flattenToCpio() result
 * (runtime config, sizes). Rebuilt only when missing.
 * The key is the image CONFIG digest (Docker's image ID): the root file
 * system is a function of the config's diff_ids (uncompressed layers), so two
 * manifests that differ only in layer compression share one archive.
 * Archives named by the manifest digest (the first layout) are adopted by a
 * rename when their sidecar's configDigest matches.
 * opts: as flattenToCpio (root required) plus compress ('none' default).
 * Resolves {path, cached, meta, migrated?}.
 */
async function ensureRootfsCpio(imageRef, opts) {
  opts = Object.assign({}, opts);
  if (!opts.root) throw new TypeError('ensureRootfsCpio: opts.root is required');
  if (opts.extras && opts.extras.length) throw new TypeError('ensureRootfsCpio: extras belong in a separate archive, not in the cached image archive');
  const img = opts.image || await registry.pullImage(imageRef, {
    root: opts.root, pullPolicy: opts.pullPolicy, platform: opts.platform, credentials: opts.credentials,
    client: opts.client, concurrency: opts.concurrency, insecureRegistries: opts.insecureRegistries, onProgress: opts.onProgress,
  });
  const compress = opts.compress || 'none';
  const variant = (opts.mountpoints === false || opts.devNodes === false || opts.includeRoot === false)
    ? `-m${opts.mountpoints === false ? 0 : 1}d${opts.devNodes === false ? 0 : 1}r${opts.includeRoot === false ? 0 : 1}` : '';
  const suffix = `-v${FORMAT_VERSION}${variant}.cpio${compress === 'gzip' ? '.gz' : ''}`;
  const dir = path.join(opts.root, 'rootfs');
  const base = path.join(dir, img.configDigest.split(':')[1] + suffix);
  const metaFile = base + '.json';
  let meta = readCachedArchive(base);
  if (meta) return { path: base, cached: true, meta };
  const legacy = path.join(dir, img.manifestDigest.split(':')[1] + suffix);
  const old = legacy !== base && readCachedArchive(legacy);
  if (old && old.configDigest === img.configDigest) {
    // archive first, sidecar last: a crash in between leaves a legacy
    // sidecar without archive (ignored) and an unmatched new archive (rebuilt)
    fs.renameSync(legacy, base);
    fs.renameSync(legacy + '.json', metaFile);
    return { path: base, cached: true, meta: old, migrated: legacy };
  }
  meta = await flattenToCpio(imageRef, base, Object.assign({}, opts, { image: img, compress }));
  meta.builtAt = new Date().toISOString();
  meta.formatVersion = FORMAT_VERSION;
  // unique temp name: concurrent builders in ONE process share the pid
  const tmp = partName(metaFile);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  try { fs.renameSync(tmp, metaFile); }
  catch (e) {
    // another builder's identical sidecar is being read right now (Windows)
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(metaFile)) throw e;
  }
  return { path: base, cached: false, meta };
}

/**
 * Parse a whole in-memory newc archive (one or more concatenated, raw only).
 * Resolves [{name, type, mode, perm, uid, gid, nlink, mtime, size, ino,
 * rdevmajor, rdevminor, archive, data: Buffer}]. For tests and small archives.
 */
async function listCpioBuffer(buf) {
  const out = [];
  const src = (async function* one() { yield buf; })();
  for await (const e of readCpio(src)) {
    const parts = [];
    for await (const c of e.body()) parts.push(Buffer.from(c));
    const x = Object.assign({}, e, { data: Buffer.concat(parts) });
    delete x.body;
    out.push(x);
  }
  return out;
}

module.exports = {
  CpioWriter,
  CpioError,
  readCpio,
  readInitrd,
  openCpioStream,
  listCpio,
  listCpioBuffer,
  checkInitramfs,
  flattenToCpio,
  ensureRootfsCpio,
  rootfsPaths,
  readRootfsMeta,
  addRuntimeBasics,
  cpioName,
  partName,
  S_IF,
  FORMAT_VERSION,
};
