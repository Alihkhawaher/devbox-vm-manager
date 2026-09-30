'use strict';
/*
 * OCI layer reading and flattening (Node standard library only).
 *
 *   const layers = require('./layers');
 *   for await (const e of layers.readTar(stream)) { ... e.body() ... }
 *   const tree = await layers.buildTree([{ path, diffId }, ...]);   // pass 1
 *   await layers.emitTree(tree, async (entry, data) => { ... });    // pass 2
 *
 * readTar(): a streaming tar reader over any byte stream (usually a gunzip
 * of a cached layer blob). Understands ustar (with the 155-byte prefix),
 * old GNU, GNU longname/longlink ('L'/'K'), PAX extended ('x') and global
 * ('g') headers (path, linkpath, size, mtime, uid, gid, uname, gname,
 * SCHILY.xattr.*), GNU base-256 numbers and header checksums. Like Go's
 * archive/tar, link/symlink/device/dir/fifo entries carry no data whatever
 * their size field says. Entry data is
 * never buffered: entry.body() yields the bytes as they arrive, and data the
 * caller does not read is skipped.
 *
 * buildTree() (pass 1) reads only headers and turns N layers into one logical
 * tree, bottom layer first, with the same result an overlay2 Docker host
 * shows inside a container:
 *  - whiteouts (.wh.<name>) delete <name> and everything under it from LOWER
 *    layers only; an entry of the same layer at that path survives, whatever
 *    order the tar lists them in;
 *  - an opaque marker (.wh..wh..opq) in dir D hides every lower child of D
 *    but keeps D and D's children from the same layer;
 *  - a directory over a directory merges (the upper metadata wins); any
 *    other type replaces what was there (a file over a directory drops the
 *    whole subtree; a directory over a symlink replaces the symlink, which is
 *    what overlayfs shows when the upper layer has a real directory there);
 *  - symlinks in an entry's PARENT path are followed inside the rootfs
 *    (absolute targets restart at the image root, ".." stops there, 40 hops
 *    max), as containerd's fs.RootPath does: "lib/x" lands in "usr/lib/x"
 *    when lib -> usr/lib; the entry's own name is never followed;
 *  - an entry whose parent is missing or not a directory gets synthesized
 *    0755 root-owned parents (like `UnpackLayer`'s MkdirAll);
 *  - hardlinks share one inode object with their target, so removing or
 *    overwriting the original path leaves the surviving links intact with
 *    the original content; a link to a symlink becomes a symlink copy;
 *    dangling links are dropped with a warning;
 *  - device nodes are skipped (counted; add /dev nodes with addExtra), FIFOs
 *    are kept, other aufs metadata (.wh..wh.plnk etc.) is ignored, and paths
 *    with ".." are refused;
 *  - when a layer's diffId is given, the uncompressed stream's sha256 is
 *    verified against it.
 * Only metadata is held in memory (a few hundred bytes per path).
 *
 * emitTree() (pass 2) calls sink(entry, data) for every path in an order a
 * cpio/initramfs writer can use: the root as ".", then every directory, symlink, FIFO, device
 * and extra entry in sorted depth-first order (parents before children), then
 * regular files in the order their bytes appear in the layer blobs, reading
 * each blob once, sequentially. A hardlink group is emitted consecutively,
 * data carried by its LAST path (the GNU cpio / kernel initramfs convention),
 * earlier paths with size 0; all share ino and nlink.
 *
 * LIMITS (bug D). An image is untrusted input and the whole tree lives in
 * the manager's memory, so buildTree() refuses (LayerError LIMIT) an image
 * with more than maxEntries tar entries in all layers together (default
 * 1,000,000 - about 300 MB of tree metadata; the largest common images have
 * well under 200,000), more than maxBytes of uncompressed layer data
 * (default 8 GiB - a decompression bomb costs CPU for every byte even when
 * the data is skipped), or a path deeper than maxDepth components (default
 * 256; PATH_MAX-sized paths of one-letter names would otherwise pass).
 * The tar reader itself (sec-2) refuses a path or link target longer than
 * 4096 bytes (PAX and GNU long names too), a PAX header over 1 MiB and more
 * than 4096 PAX keys per entry; of global PAX headers it keeps only the
 * keys it uses (at most 64). buildTree also caps the path characters kept
 * for the whole image (maxMetaBytes, default 256 MB): per-entry caps times
 * a million entries would still be gigabytes.
 * Entries under /.devbox - the engine's own folder in the guest (init, the
 * run spec) - are dropped with a warning (sec-7).
 *
 * Errors are LayerError with .code: TAR_FORMAT, TAR_CHECKSUM, TAR_TRUNCATED,
 * DIFFID_MISMATCH, ZSTD_UNSUPPORTED, LAYER_CHANGED, BAD_EXTRA, LIMIT.
 *
 * Exports: readTar, ByteReader, parseTarHeader, parsePax, openLayerStream,
 * sniffCompression, normalizePath, buildTree, emitTree, RootfsTree, LayerError.
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream');

const BLOCK = 512;
const EMPTY = Buffer.alloc(0);
// One PAX header (Go's archive/tar allows 1 MiB too): the tar reader keeps
// what it says in memory, so a hostile layer must not make that big (sec-2).
const PAX_LIMIT = 1024 * 1024;
// A path or link target longer than this is refused (LIMIT) - PAX and GNU
// long names included. The same bound as the cpio writer's (PATH_MAX): a
// longer name could never reach the guest anyway, and without it 40 entries
// of 4 MiB names held 160 MB of strings from a 167 KB layer (sec-2).
const MAX_NAME = 4096;
// A GNU 'L'/'K' long-name record: the name plus its NUL, with some slack.
const LONGNAME_LIMIT = MAX_NAME + BLOCK;
// Global PAX ('g') headers apply to every later entry, so only the keys the
// reader uses are kept, and only so many of them.
const GLOBAL_PAX_KEYS = new Set(['path', 'linkpath', 'size', 'uid', 'gid', 'mtime', 'uname', 'gname']);
const GLOBAL_PAX_MAX = 64;
// Per-entry PAX records ('x', possibly several in a row) - far more than any
// real archive has (a handful of keys plus xattrs).
const PAX_KEYS_MAX = 4096;
// buildTree() caps (see LIMITS above); each can be overridden per call.
// maxMetaBytes: path and link-target characters kept for the whole image
// while it is flattened (1M entries with 60-character paths are 60 MB).
const LIMITS = { maxEntries: 1000000, maxBytes: 8 * 1024 * 1024 * 1024, maxDepth: 256, maxMetaBytes: 256 * 1024 * 1024 };
// The engine's own folder in the guest: init, busybox, the run spec. Image
// entries there are dropped - an image shipping /.devbox/spec.sh must not
// replace the spec the manager renders (sec-7).
const RESERVED_TOP = '.devbox';

class LayerError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'LayerError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- byte reader

/**
 * Pull-style reader over an async iterable of Buffers (a Readable works).
 * read(n) returns exactly n bytes, or fewer only at end of stream.
 */
class ByteReader {
  constructor(source) {
    this._it = source[Symbol.asyncIterator]();
    this._buf = EMPTY;
    this._off = 0;
    this._eof = false;
    this.position = 0;
  }

  async _more() {
    if (this._eof) return false;
    const r = await this._it.next();
    if (r.done) { this._eof = true; return false; }
    this._buf = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
    this._off = 0;
    return true;
  }

  async read(n) {
    const avail = this._buf.length - this._off;
    if (avail >= n) {
      const b = this._buf.subarray(this._off, this._off + n);
      this._off += n;
      this.position += n;
      return b;
    }
    const parts = [];
    let got = 0;
    while (got < n) {
      if (this._buf.length - this._off === 0 && !(await this._more())) break;
      const take = Math.min(n - got, this._buf.length - this._off);
      parts.push(this._buf.subarray(this._off, this._off + take));
      this._off += take;
      got += take;
    }
    this.position += got;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
  }

  /** Yield exactly n bytes as chunks; throws TAR_TRUNCATED if the stream ends first. */
  async *chunks(n) {
    let left = n;
    while (left > 0) {
      if (this._buf.length - this._off === 0 && !(await this._more())) {
        throw new LayerError('TAR_TRUNCATED', `stream ended ${left} bytes early (offset ${this.position})`);
      }
      const take = Math.min(left, this._buf.length - this._off);
      const b = this._buf.subarray(this._off, this._off + take);
      this._off += take;
      this.position += take;
      left -= take;
      yield b;
    }
  }

  async skip(n) {
    let left = n;
    while (left > 0) {
      if (this._buf.length - this._off === 0 && !(await this._more())) {
        throw new LayerError('TAR_TRUNCATED', `stream ended ${left} bytes early (offset ${this.position})`);
      }
      const take = Math.min(left, this._buf.length - this._off);
      this._off += take;
      this.position += take;
      left -= take;
    }
  }

  /** Consume the rest of the stream. Resolves the number of bytes skipped. */
  async drain() {
    let n = this._buf.length - this._off;
    this._off = this._buf.length;
    while (await this._more()) { n += this._buf.length; this._off = this._buf.length; }
    this.position += n;
    return n;
  }

  async close() {
    if (this._it.return) { try { await this._it.return(); } catch (e) { /* ignore */ } }
  }
}

// ---------------------------------------------------------------- tar headers

function cstr(buf, off, len) {
  let end = off;
  const max = off + len;
  while (end < max && buf[end] !== 0) end++;
  return buf.toString('utf8', off, end);
}

function parseNumeric(buf, off, len) {
  const first = buf[off];
  if (first & 0x80) {
    // GNU base-256: big-endian two's complement; 0x80 = positive, 0xff = negative.
    if (first === 0xff) return -1;
    let v = first & 0x7f;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i];
    return v;
  }
  let i = off;
  const end = off + len;
  while (i < end && (buf[i] === 0x20 || buf[i] === 0)) { if (buf[i] === 0 && i === off) return 0; i++; }
  let v = 0;
  let any = false;
  for (; i < end; i++) {
    const c = buf[i];
    if (c < 0x30 || c > 0x37) break;
    v = v * 8 + (c - 0x30);
    any = true;
  }
  return any ? v : 0;
}

function isZeroBlock(buf) {
  for (let i = 0; i < BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Parse one 512-byte tar header. Returns null for an all-zero block. Throws
 * TAR_CHECKSUM when the checksum does not match (unsigned or signed sum).
 */
function parseTarHeader(buf, offset) {
  if (isZeroBlock(buf)) return null;
  const stored = parseNumeric(buf, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const c = i >= 148 && i < 156 ? 0x20 : buf[i];
    unsigned += c;
    signed += c > 127 ? c - 256 : c;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new LayerError('TAR_CHECKSUM', `bad tar header checksum at offset ${offset || 0} (not a tar stream, or corrupt)`);
  }
  const magic = buf.toString('latin1', 257, 263);
  const version = buf.toString('latin1', 263, 265);
  const posix = magic === 'ustar\0';
  const gnu = magic === 'ustar ' && version === ' \0';
  let name = cstr(buf, 0, 100);
  const prefix = posix ? cstr(buf, 345, 155) : '';
  if (prefix) name = prefix + '/' + name;
  const tf = buf[156];
  return {
    name,
    mode: parseNumeric(buf, 100, 8),
    uid: parseNumeric(buf, 108, 8),
    gid: parseNumeric(buf, 116, 8),
    size: parseNumeric(buf, 124, 12),
    mtime: parseNumeric(buf, 136, 12),
    typeflag: tf === 0 ? '0' : String.fromCharCode(tf),
    linkname: cstr(buf, 157, 100),
    uname: posix || gnu ? cstr(buf, 265, 32) : '',
    gname: posix || gnu ? cstr(buf, 297, 32) : '',
    devmajor: posix || gnu ? parseNumeric(buf, 329, 8) : 0,
    devminor: posix || gnu ? parseNumeric(buf, 337, 8) : 0,
    format: posix ? 'ustar' : gnu ? 'gnu' : 'v7',
  };
}

/** Parse PAX extended header records ("%d key=value\n"). Values are UTF-8. */
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    let sp = i;
    while (sp < buf.length && buf[sp] !== 0x20) sp++;
    const len = parseInt(buf.toString('latin1', i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) {
      if (buf.subarray(i).every((b) => b === 0)) break; // trailing NUL padding
      throw new LayerError('TAR_FORMAT', 'malformed PAX header record');
    }
    const rec = buf.subarray(sp + 1, i + len - 1); // drop the trailing \n
    const eq = rec.indexOf(0x3d);
    if (eq > 0) {
      const key = rec.toString('utf8', 0, eq);
      out[key] = key.startsWith('SCHILY.xattr.') || key.startsWith('LIBARCHIVE.xattr.')
        ? rec.subarray(eq + 1) : rec.toString('utf8', eq + 1);
    }
    i += len;
  }
  return out;
}

const TYPES = {
  '0': 'file', '7': 'file', '1': 'hardlink', '2': 'symlink', '3': 'char', '4': 'block', '5': 'dir', '6': 'fifo', 'D': 'dir',
};
// Types that never carry data, whatever their size field says (Go's
// archive/tar, which wrote and reads nearly every image layer, treats them so).
const HEADER_ONLY = new Set(['1', '2', '3', '4', '5', '6']);

async function readFull(reader, n, what, limit) {
  const max = limit || PAX_LIMIT;
  if (n > max) throw new LayerError('LIMIT', `${what} header of ${n} bytes is too large (at most ${max})`);
  const b = await reader.read(n);
  if (b.length < n) throw new LayerError('TAR_TRUNCATED', `stream ended inside a ${what} header`);
  return Buffer.from(b);
}

// UTF-8 bytes of s beyond MAX_NAME? (length alone decides for short names:
// one UTF-16 unit is at most 3 UTF-8 bytes)
const nameTooLong = (s) => typeof s === 'string' && s.length > MAX_NAME / 3 && Buffer.byteLength(s) > MAX_NAME;

function keepGlobal(dst, src) {
  for (const k of Object.keys(src)) {
    if (!GLOBAL_PAX_KEYS.has(k) && !/^(SCHILY|LIBARCHIVE)\.xattr\./.test(k) && !/^GNU\.sparse\./.test(k)) continue;
    dst[k] = src[k];
  }
  if (Object.keys(dst).length > GLOBAL_PAX_MAX) throw new LayerError('LIMIT', `global PAX headers set more than ${GLOBAL_PAX_MAX} keys`);
  return dst;
}

const pad512 = (n) => (BLOCK - (n % BLOCK)) % BLOCK;

/**
 * Stream the entries of a tar archive.
 * @param {AsyncIterable<Buffer>|ByteReader} source  decompressed tar bytes
 * @yields {{path: string, type: 'file'|'dir'|'symlink'|'hardlink'|'char'|'block'|'fifo'|'unknown',
 *   typeflag, mode, uid, gid, uname, gname, size, mtime, linkpath, devmajor, devminor,
 *   xattrs: Object<string,Buffer>|null, sparse: boolean, ordinal: number, offset: number,
 *   body(): AsyncIterable<Buffer>}}
 * `path` is the raw name from the archive (see normalizePath). `ordinal`
 * counts real entries (not PAX/GNU meta headers) from 0 and is stable, so a
 * second read of the same stream can find an entry again. body() may be
 * called at most once and must be consumed before asking for the next entry;
 * unread data is skipped automatically. The generator stops at the end-of-
 * archive marker WITHOUT reading what follows (callers that hash the stream
 * call reader.drain()).
 */
async function* readTar(source) {
  const r = source instanceof ByteReader ? source : new ByteReader(source);
  const globalPax = {};
  let pax = null;
  let longName = null;
  let longLink = null;
  let ordinal = 0;
  let remaining = 0; // unread bytes of the current entry's data
  let padding = 0;
  for (;;) {
    if (remaining > 0) await r.skip(remaining);
    remaining = 0;
    if (padding) await r.skip(padding);
    padding = 0;
    const offset = r.position;
    const block = await r.read(BLOCK);
    if (block.length === 0) return; // EOF without end marker: tolerated
    if (block.length < BLOCK) throw new LayerError('TAR_TRUNCATED', `stream ended inside a tar header at offset ${offset}`);
    const h = parseTarHeader(block, offset);
    if (!h) return; // end-of-archive marker
    if (h.size < 0) throw new LayerError('TAR_FORMAT', `negative size at offset ${offset}`);
    const tf = h.typeflag;
    if (tf === 'x' || tf === 'g' || tf === 'L' || tf === 'K' || tf === 'V' || tf === 'M' || tf === 'N') {
      const isPax = tf === 'x' || tf === 'g';
      const data = tf === 'V' || tf === 'M' || tf === 'N' ? null : await readFull(r, h.size, isPax ? 'PAX' : 'GNU long name', isPax ? PAX_LIMIT : LONGNAME_LIMIT);
      if (data === null) await r.skip(h.size);
      padding = pad512(h.size);
      if (tf === 'x') {
        pax = Object.assign(pax || {}, parsePax(data));
        if (Object.keys(pax).length > PAX_KEYS_MAX) throw new LayerError('LIMIT', `PAX headers at offset ${offset} set more than ${PAX_KEYS_MAX} keys`);
      } else if (tf === 'g') keepGlobal(globalPax, parsePax(data));
      else if (tf === 'L') longName = cstr(data, 0, data.length);
      else if (tf === 'K') longLink = cstr(data, 0, data.length);
      continue;
    }
    const p = pax ? Object.assign({}, globalPax, pax) : globalPax;
    pax = null;
    let name = longName != null ? longName : h.name;
    let linkpath = longLink != null ? longLink : h.linkname;
    longName = null;
    longLink = null;
    if (typeof p.path === 'string') name = p.path;
    if (typeof p.linkpath === 'string') linkpath = p.linkpath;
    if (nameTooLong(name)) throw new LayerError('LIMIT', `a path at offset ${offset} is longer than ${MAX_NAME} bytes (${String(name).slice(0, 60)}...)`);
    if (nameTooLong(linkpath)) throw new LayerError('LIMIT', `a link target at offset ${offset} is longer than ${MAX_NAME} bytes (${String(name).slice(0, 60)})`);
    const num = (v, dflt) => {
      if (v == null) return dflt;
      const x = Number(v);
      return Number.isFinite(x) ? x : dflt;
    };
    const dataSize = HEADER_ONLY.has(tf) ? 0 : num(p.size, h.size);
    let type = TYPES[tf] || 'unknown';
    if ((tf === '0' || tf === '7') && name.endsWith('/') && h.format === 'v7') type = 'dir';
    const sparse = tf === 'S' || p['GNU.sparse.major'] != null || p['GNU.sparse.map'] != null || p['GNU.sparse.size'] != null;
    let xattrs = null;
    for (const k of Object.keys(p)) {
      const m = /^(?:SCHILY|LIBARCHIVE)\.xattr\.(.+)$/.exec(k);
      if (m) { xattrs = xattrs || {}; xattrs[m[1]] = Buffer.isBuffer(p[k]) ? p[k] : Buffer.from(String(p[k])); }
    }
    remaining = dataSize;
    padding = pad512(dataSize);
    let used = false;
    const entry = {
      path: name,
      type,
      typeflag: tf,
      mode: h.mode & 0o7777,
      uid: num(p.uid, h.uid),
      gid: num(p.gid, h.gid),
      uname: p.uname != null ? String(p.uname) : h.uname,
      gname: p.gname != null ? String(p.gname) : h.gname,
      size: type === 'file' ? dataSize : 0,
      mtime: Math.max(0, Math.floor(num(p.mtime, h.mtime))),
      linkpath,
      devmajor: h.devmajor,
      devminor: h.devminor,
      xattrs,
      sparse,
      ordinal: ordinal++,
      offset,
      body() {
        if (used) throw new Error('tar entry body() can only be read once');
        used = true;
        return (async function* bodyGen() {
          for await (const c of r.chunks(remaining)) {
            remaining -= c.length;
            yield c;
          }
        })();
      },
    };
    yield entry;
  }
}

// ---------------------------------------------------------------- layer streams

/** 'gzip' | 'zstd' | 'tar' from the first bytes of a file. */
async function sniffCompression(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    if (bytesRead >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
    if (bytesRead >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
    return 'tar';
  } finally {
    await fh.close();
  }
}

/**
 * Open a cached layer blob as a stream of uncompressed tar bytes. The
 * compression is sniffed from the content (media types lie sometimes).
 */
async function openLayerStream(file) {
  const kind = await sniffCompression(file);
  const src = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  if (kind === 'tar') return src;
  let dec;
  if (kind === 'gzip') dec = zlib.createGunzip({ chunkSize: 256 * 1024 });
  else {
    if (typeof zlib.createZstdDecompress !== 'function') {
      src.destroy();
      throw new LayerError('ZSTD_UNSUPPORTED', `layer ${file} is zstd-compressed; this needs Node >= 23.8 / 22.15 (this is ${process.versions.node})`);
    }
    dec = zlib.createZstdDecompress();
  }
  pipeline(src, dec, () => { /* errors surface on dec */ });
  return dec;
}

async function* hashing(source, hash, counter, tree) {
  for await (const c of source) {
    hash.update(c);
    counter.bytes += c.length;
    if (tree) {
      // shared by the layers indexed in parallel: the cap is for the image
      tree.bytesSeen += c.length;
      if (tree.bytesSeen > tree.limits.maxBytes) {
        throw new LayerError('LIMIT', 'the image unpacks to more than ' + Math.round(tree.limits.maxBytes / 1073741824) + ' GiB - too large to run as a microVM');
      }
    }
    yield c;
  }
}

// ---------------------------------------------------------------- paths

/** "./a//b/" -> "a/b", "/" -> "", anything with ".." -> null. */
function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- tree

let inodeSeq = 0;

function dirNode(meta, synthetic) {
  return {
    type: 'dir',
    mode: meta ? meta.mode : 0o755,
    uid: meta ? meta.uid : 0,
    gid: meta ? meta.gid : 0,
    mtime: meta ? meta.mtime : 0,
    children: new Map(),
    synthetic: !!synthetic,
  };
}

/**
 * The flattened filesystem. Nodes: {type, mode, uid, gid, mtime, children
 * (dir), inode (file), linkpath (symlink), rdevmajor/rdevminor (devices)}.
 * inode: {id, layer, ordinal, size, mode, uid, gid, mtime} for layer files, or
 * {id, extra: {data|source}, size, ...} for extra files.
 */
class RootfsTree {
  constructor(limits) {
    this.root = dirNode(null, true);
    this.layers = [];
    this.warnings = [];
    this.limits = Object.assign({}, LIMITS, limits || {});
    this.bytesSeen = 0;
    this.metaBytes = 0; // path + link-target characters kept (maxMetaBytes)
    this.reservedDropped = 0; // image entries under /.devbox (sec-7)
    this.stats = {
      layers: 0, entries: 0, whiteouts: 0, opaque: 0, devicesSkipped: 0, xattrEntries: 0,
      hardlinksResolved: 0, hardlinksDangling: 0, synthesizedDirs: 0, rejected: 0, replacedNonDirParents: 0,
      uncompressedBytes: 0,
    };
  }

  warn(msg) {
    if (this.warnings.length < 200) this.warnings.push(msg);
  }

  /**
   * Node at path, or null. Symlinks in the parent components are followed
   * (scoped to this rootfs); the last component is not.
   */
  lookup(p) {
    const norm = normalizePath(p);
    if (norm === null) return null;
    if (norm === '') return this.root;
    const parts = norm.split('/');
    const parent = this._resolveDir(parts, parts.length - 1, false);
    return parent ? parent.children.get(parts[parts.length - 1]) || null : null;
  }

  /**
   * Walk the first `count` segments as directories from the root, following
   * symlinks the way containerd's fs.RootPath does when it applies a layer:
   * absolute targets restart at this rootfs' root, ".." never climbs above
   * it, at most 40 links are followed. A missing component (or the missing
   * target of a dangling link) is created as a 0755 root-owned directory
   * when `create`; a component that is a file is replaced by one (Docker
   * would fail the pull there; this is counted and warned about).
   * Returns the directory node, or null (not found, or a symlink loop).
   */
  _resolveDir(segs, count, create) {
    const pending = segs.slice(0, count);
    const stack = []; // physical path so far: directory nodes below the root
    let cur = this.root;
    let hops = 0;
    while (pending.length) {
      const seg = pending.shift();
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        stack.pop();
        cur = stack.length ? stack[stack.length - 1] : this.root;
        continue;
      }
      let child = cur.children.get(seg);
      if (child && child.type === 'symlink') {
        if (++hops > 40) {
          this.warn(`too many levels of symbolic links resolving ${segs.slice(0, count).join('/')}`);
          return null;
        }
        if (child.linkpath.startsWith('/')) { stack.length = 0; cur = this.root; }
        pending.unshift(...child.linkpath.split('/'));
        continue;
      }
      if (!child || child.type !== 'dir') {
        if (!create) return null;
        if (child) {
          this.stats.replacedNonDirParents++;
          this.warn(`${seg} (a ${child.type}) is the parent of a later entry; replaced by a directory`);
        }
        child = dirNode(null, true);
        this.stats.synthesizedDirs++;
        cur.children.set(seg, child);
      }
      stack.push(child);
      cur = child;
    }
    return cur;
  }

  _parentFor(parts, create) {
    return this._resolveDir(parts, parts.length - 1, create);
  }

  /** Put a node at a normalized non-empty path with overlay semantics. */
  put(norm, node) {
    const parts = norm.split('/');
    const parent = this._parentFor(parts, true);
    if (!parent) { this.stats.rejected++; return null; }
    const name = parts[parts.length - 1];
    const existing = parent.children.get(name);
    if (existing && existing.type === 'dir' && node.type === 'dir') {
      existing.mode = node.mode;
      existing.uid = node.uid;
      existing.gid = node.gid;
      existing.mtime = node.mtime;
      existing.synthetic = false;
      return existing;
    }
    parent.children.set(name, node);
    return node;
  }

  remove(norm) {
    const parts = norm.split('/');
    const parent = this._parentFor(parts, false);
    if (!parent) return false;
    return parent.children.delete(parts[parts.length - 1]);
  }

  /**
   * Add or replace an entry after the layers (e.g. /dev nodes or the init
   * binary). entry: {path, type: 'dir'|'file'|'symlink'|'char'|'block'|'fifo',
   * mode, uid (0), gid (0), mtime (now), linkpath, rdevmajor, rdevminor,
   * data (Buffer|string) or source (host file path) for files}.
   */
  addExtra(entry) {
    const norm = normalizePath(entry.path || '');
    if (!norm) throw new LayerError('BAD_EXTRA', `extra entry has an invalid path: ${entry.path}`);
    const base = {
      mode: entry.mode != null ? entry.mode & 0o7777 : (entry.type === 'dir' ? 0o755 : entry.type === 'symlink' ? 0o777 : 0o644),
      uid: entry.uid || 0,
      gid: entry.gid || 0,
      mtime: entry.mtime != null ? entry.mtime : Math.floor(Date.now() / 1000),
    };
    let node;
    switch (entry.type) {
      case 'dir':
        node = Object.assign(dirNode(base), {});
        break;
      case 'symlink':
        if (!entry.linkpath) throw new LayerError('BAD_EXTRA', `symlink ${entry.path} needs linkpath`);
        node = Object.assign({ type: 'symlink', linkpath: entry.linkpath }, base);
        break;
      case 'char': case 'block':
        node = Object.assign({ type: entry.type, rdevmajor: entry.rdevmajor || 0, rdevminor: entry.rdevminor || 0 }, base);
        break;
      case 'fifo':
        node = Object.assign({ type: 'fifo' }, base);
        break;
      case 'file': {
        let size;
        let extra;
        if (entry.data != null) {
          const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
          size = data.length;
          extra = { data };
        } else if (entry.source) {
          size = fs.statSync(entry.source).size;
          extra = { source: entry.source };
        } else throw new LayerError('BAD_EXTRA', `file ${entry.path} needs data or source`);
        node = Object.assign({ type: 'file', inode: Object.assign({ id: ++inodeSeq, extra, size }, base) }, base);
        break;
      }
      default:
        throw new LayerError('BAD_EXTRA', `extra entry ${entry.path}: unknown type ${entry.type}`);
    }
    if (node.type !== 'dir') this.remove(norm);
    return this.put(norm, node);
  }

  /** Apply one layer's already-parsed entry list (see buildTree). */
  applyLayer(layerIndex, entries) {
    this.stats.layers++;
    // 1. Whiteouts, against lower layers only (nothing of this layer is in the tree yet).
    for (const e of entries) {
      if (!e.whiteout) continue;
      if (e.whiteout === 'opaque') {
        // The marked directory itself is not followed if it is a symlink: the
        // same layer then replaces that symlink with a directory, which has
        // no lower children to hide.
        const dir = e.norm === '' ? this.root : this.lookup(e.norm);
        if (dir && dir.type === 'dir') dir.children = new Map();
        this.stats.opaque++;
      } else {
        this.remove(e.norm);
        this.stats.whiteouts++;
      }
    }
    // 2. Additions in archive order (a later duplicate wins).
    for (const e of entries) {
      if (e.whiteout) continue;
      const meta = { mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime };
      if (e.norm === '') {
        if (e.type === 'dir') Object.assign(this.root, meta, { synthetic: false });
        continue;
      }
      switch (e.type) {
        case 'dir':
          this.put(e.norm, dirNode(meta));
          break;
        case 'file':
          this.put(e.norm, Object.assign({
            type: 'file',
            inode: Object.assign({ id: ++inodeSeq, layer: layerIndex, ordinal: e.ordinal, size: e.size }, meta),
          }, meta));
          break;
        case 'symlink':
          this.put(e.norm, Object.assign({ type: 'symlink', linkpath: e.linkpath }, meta));
          break;
        case 'fifo':
          this.put(e.norm, Object.assign({ type: 'fifo' }, meta));
          break;
        case 'hardlink': {
          const target = normalizePath(e.linkpath);
          const t = target ? this.lookup(target) : null;
          if (target === e.norm) break;
          if (t && t.type === 'file') {
            this.put(e.norm, Object.assign({}, t, { inode: t.inode }));
            this.stats.hardlinksResolved++;
          } else if (t && t.type === 'symlink') {
            this.put(e.norm, Object.assign({}, t));
            this.stats.hardlinksResolved++;
          } else {
            this.stats.hardlinksDangling++;
            this.warn(`layer ${layerIndex}: hardlink ${e.norm} -> ${e.linkpath}: target ${t ? 'is a ' + t.type : 'missing'}, skipped`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Depth-first, sorted walk. Yields [path, node] with parents before children. */
  *walk() {
    const frame = (prefix, dir) => ({ prefix, dir, names: [...dir.children.keys()].sort(), i: 0 });
    const stack = [frame('', this.root)];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.names.length) { stack.pop(); continue; }
      const name = top.names[top.i++];
      const node = top.dir.children.get(name);
      const p = top.prefix ? top.prefix + '/' + name : name;
      yield [p, node];
      if (node.type === 'dir') stack.push(frame(p, node));
    }
  }

  /** Summary counts over the final tree. */
  summary() {
    const s = { dirs: 0, files: 0, symlinks: 0, hardlinkPaths: 0, fifos: 0, devices: 0, bytes: 0, inodes: 0, extras: 0 };
    const seen = new Set();
    for (const [, n] of this.walk()) {
      if (n.type === 'dir') s.dirs++;
      else if (n.type === 'symlink') s.symlinks++;
      else if (n.type === 'fifo') s.fifos++;
      else if (n.type === 'char' || n.type === 'block') s.devices++;
      else if (n.type === 'file') {
        s.files++;
        if (seen.has(n.inode)) s.hardlinkPaths++;
        else { seen.add(n.inode); s.bytes += n.inode.size; s.inodes++; if (n.inode.extra) s.extras++; }
      }
    }
    return s;
  }
}

/**
 * Index one layer (headers only). Resolves the entry list for applyLayer.
 * Verifies the diffId when given.
 */
async function indexLayer(layer, layerIndex, tree) {
  const file = typeof layer === 'string' ? layer : layer.path;
  const diffId = typeof layer === 'string' ? null : layer.diffId;
  const stream = await openLayerStream(file);
  const hash = crypto.createHash('sha256');
  const counter = { bytes: 0 };
  const reader = new ByteReader(hashing(stream, hash, counter, tree));
  const list = [];
  try {
    for await (const e of readTar(reader)) {
      if (++tree.stats.entries > tree.limits.maxEntries) {
        throw new LayerError('LIMIT', 'the image has more than ' + tree.limits.maxEntries + ' files - too many to flatten safely');
      }
      const norm = normalizePath(e.path);
      if (norm === null) {
        tree.stats.rejected++;
        tree.warn(`layer ${layerIndex}: refused path with "..": ${e.path}`);
        continue;
      }
      if (norm && norm.split('/').length > tree.limits.maxDepth) {
        throw new LayerError('LIMIT', `layer ${layerIndex}: a path is nested more than ${tree.limits.maxDepth} directories deep (${norm.slice(0, 80)}...)`);
      }
      // what the index keeps for the whole image (the tree holds the names
      // later): bounded, whatever the per-entry caps allow in sum (sec-2)
      tree.metaBytes += norm.length + (typeof e.linkpath === 'string' ? e.linkpath.length : 0);
      if (tree.metaBytes > tree.limits.maxMetaBytes) {
        throw new LayerError('LIMIT', 'the image\'s file names add up to more than ' + Math.round(tree.limits.maxMetaBytes / 1048576) + ' MB - too many to flatten safely');
      }
      // the engine's own folder: never taken from the image (sec-7)
      if (norm === RESERVED_TOP || norm.startsWith(RESERVED_TOP + '/')) {
        if (++tree.reservedDropped === 1) tree.warn(`layer ${layerIndex}: /${RESERVED_TOP} is reserved for the microVM engine - the image's files there were ignored`);
        continue;
      }
      const slash = norm.lastIndexOf('/');
      const base = norm.slice(slash + 1);
      const dir = slash >= 0 ? norm.slice(0, slash) : '';
      if (base.startsWith('.wh.')) {
        if (base === '.wh..wh..opq') list.push({ whiteout: 'opaque', norm: dir });
        else if (base.startsWith('.wh..wh.')) { /* aufs metadata: ignore */ } else {
          const target = (dir ? dir + '/' : '') + base.slice(4);
          list.push({ whiteout: 'file', norm: target });
        }
        continue;
      }
      if (norm.split('/').some((s) => s.startsWith('.wh..wh.'))) continue; // inside aufs .wh..wh.plnk etc.
      if (e.sparse) {
        // Old GNU sparse headers are followed by extension blocks that the size
        // field does not count, so the stream cannot even be skipped safely.
        throw new LayerError('TAR_FORMAT', `layer ${layerIndex}: ${norm} is a GNU sparse file, which is not supported`);
      }
      if (e.type === 'char' || e.type === 'block') {
        tree.stats.devicesSkipped++;
        continue;
      }
      if (e.type === 'unknown') {
        tree.warn(`layer ${layerIndex}: ${norm}: unsupported tar type '${e.typeflag}', skipped`);
        continue;
      }
      if (e.xattrs) {
        tree.stats.xattrEntries++;
        if (e.xattrs['security.capability']) tree.warn(`layer ${layerIndex}: ${norm} has file capabilities (security.capability); a cpio initramfs cannot carry xattrs, so they are dropped`);
      }
      list.push({
        norm, type: e.type, mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime, size: e.size,
        linkpath: e.linkpath, ordinal: e.ordinal,
      });
    }
    await reader.drain();
  } finally {
    await reader.close();
    stream.destroy();
  }
  tree.stats.uncompressedBytes += counter.bytes;
  if (diffId) {
    const got = 'sha256:' + hash.digest('hex');
    if (got !== diffId) {
      throw new LayerError('DIFFID_MISMATCH', `layer ${layerIndex} (${file}): uncompressed digest ${got} does not match diff_id ${diffId}`);
    }
  }
  return list;
}

/**
 * Pass 1: build the flattened tree from layers (bottom first).
 * @param {Array<string|{path: string, diffId?: string}>} layers
 * @param {{concurrency?: number, limits?: {maxEntries?, maxBytes?, maxDepth?}}} [opts]
 *   layers are parsed in parallel (3), applied in order; limits: see LIMITS
 * @returns {Promise<RootfsTree>} tree.layers holds the layer list for emitTree
 */
async function buildTree(layers, opts) {
  opts = opts || {};
  const tree = new RootfsTree(opts.limits);
  tree.layers = layers.map((l) => (typeof l === 'string' ? { path: l } : l));
  const lists = new Array(layers.length);
  let next = 0;
  const limit = Math.max(1, Math.min(opts.concurrency || 3, layers.length));
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < layers.length) {
      const i = next++;
      lists[i] = await indexLayer(tree.layers[i], i, tree);
    }
  }));
  for (let i = 0; i < lists.length; i++) {
    tree.applyLayer(i, lists[i]);
    lists[i] = null;
  }
  return tree;
}

/**
 * Pass 2: call sink(entry, data) for every path of the tree.
 * entry: {path, type: 'dir'|'file'|'symlink'|'fifo'|'char'|'block', mode (permission bits),
 *   uid, gid, mtime, size, nlink, ino, linkpath?, rdevmajor?, rdevminor?}
 * data: null, a Buffer, or an AsyncIterable<Buffer> of exactly `size` bytes that
 * the sink must consume before returning.
 * opts: {includeRoot (true): first emit the root directory as path "." (the
 *   kernel then chowns/chmods "/" to it; without it an initramfs root on
 *   tmpfs stays mode 1777), inoStart (2)}
 * Resolves {entries, bytes}.
 */
async function emitTree(tree, sink, opts) {
  opts = opts || {};
  let ino = opts.inoStart || 2;
  let entries = 0;
  let bytes = 0;
  const groups = new Map(); // inode -> [paths]
  const inos = new Map(); // inode -> ino number
  const subdirs = (node) => { let n = 0; for (const c of node.children.values()) if (c.type === 'dir') n++; return n; };

  if (opts.includeRoot !== false) {
    const r = tree.root;
    await sink({ path: '.', type: 'dir', mode: r.mode, uid: r.uid, gid: r.gid, mtime: r.mtime, size: 0, nlink: 2 + subdirs(r), ino: ino++ }, null);
    entries++;
  }

  // Phase A: everything that has no layer data, parents first.
  for (const [p, node] of tree.walk()) {
    const base = { path: p, mode: node.mode, uid: node.uid, gid: node.gid, mtime: node.mtime };
    if (node.type === 'file') {
      if (!groups.has(node.inode)) { groups.set(node.inode, []); inos.set(node.inode, ino++); }
      groups.get(node.inode).push(p);
      continue;
    }
    if (node.type === 'dir') await sink(Object.assign(base, { type: 'dir', size: 0, nlink: 2 + subdirs(node), ino: ino++ }), null);
    else if (node.type === 'symlink') {
      const data = Buffer.from(node.linkpath, 'utf8');
      await sink(Object.assign(base, { type: 'symlink', mode: 0o777, size: data.length, nlink: 1, ino: ino++, linkpath: node.linkpath }), data);
    } else if (node.type === 'fifo') await sink(Object.assign(base, { type: 'fifo', size: 0, nlink: 1, ino: ino++ }), null);
    else if (node.type === 'char' || node.type === 'block') {
      await sink(Object.assign(base, { type: node.type, size: 0, nlink: 1, ino: ino++, rdevmajor: node.rdevmajor, rdevminor: node.rdevminor }), null);
    }
    entries++;
  }

  const emitGroup = async (inode, data) => {
    const paths = groups.get(inode);
    const n = paths.length;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      await sink({
        path: paths[i], type: 'file', mode: inode.mode, uid: inode.uid, gid: inode.gid, mtime: inode.mtime,
        size: last ? inode.size : 0, nlink: n, ino: inos.get(inode),
      }, last ? data : null);
      entries++;
    }
    bytes += inode.size;
  };

  // Extra files (not from layers).
  for (const inode of groups.keys()) {
    if (!inode.extra) continue;
    const data = inode.extra.data || fs.createReadStream(inode.extra.source, { highWaterMark: 1 << 20 });
    await emitGroup(inode, data);
  }

  // Phase B: layer files, one sequential read per layer.
  const byLayer = new Map();
  for (const inode of groups.keys()) {
    if (inode.extra) continue;
    if (!byLayer.has(inode.layer)) byLayer.set(inode.layer, new Map());
    byLayer.get(inode.layer).set(inode.ordinal, inode);
  }
  const layerIdx = [...byLayer.keys()].sort((a, b) => a - b);
  for (const li of layerIdx) {
    const want = byLayer.get(li);
    const layer = tree.layers[li];
    const stream = await openLayerStream(layer.path);
    const reader = new ByteReader(stream);
    try {
      for await (const e of readTar(reader)) {
        const inode = want.get(e.ordinal);
        if (!inode) continue;
        if (e.type !== 'file' || e.size !== inode.size) {
          throw new LayerError('LAYER_CHANGED', `layer ${li} changed between passes (entry ${e.ordinal} ${e.path})`);
        }
        await emitGroup(inode, e.body());
        want.delete(e.ordinal);
        if (want.size === 0) break;
      }
    } finally {
      await reader.close();
      stream.destroy();
    }
    if (want.size) throw new LayerError('LAYER_CHANGED', `layer ${li}: ${want.size} file(s) not found on the second pass`);
  }
  return { entries, bytes };
}

module.exports = {
  readTar,
  ByteReader,
  parseTarHeader,
  parsePax,
  parseNumeric,
  openLayerStream,
  sniffCompression,
  normalizePath,
  buildTree,
  emitTree,
  indexLayer,
  RootfsTree,
  LayerError,
  LIMITS,
};
