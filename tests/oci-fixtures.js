'use strict';
/*
 * Test helpers for the OCI tests (not a test file itself): a small tar
 * WRITER (ustar, GNU longname/longlink, PAX, base-256 numbers) to build
 * synthetic image layers, plus temp dirs and listen() on an OS-assigned port
 * (port 0 - unit tests never use fixed ports).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const BLOCK = 512;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function writeOctal(buf, off, len, value) {
  const s = Math.floor(value).toString(8);
  if (s.length > len - 1) {
    // GNU base-256 for values that do not fit.
    buf[off] = 0x80;
    let v = Math.floor(value);
    for (let i = off + len - 1; i > off; i--) { buf[i] = v % 256; v = Math.floor(v / 256); }
    return;
  }
  buf.write(s.padStart(len - 1, '0') + '\0', off, len, 'latin1');
}

function writeStr(buf, off, len, s) {
  const b = Buffer.from(s, 'utf8');
  if (b.length > len) throw new Error(`field too long: ${s}`);
  b.copy(buf, off);
}

const TYPEFLAG = { file: '0', hardlink: '1', symlink: '2', char: '3', block: '4', dir: '5', fifo: '6' };

/**
 * One 512-byte header. h: {name, mode, uid, gid, size, mtime, typeflag,
 * linkname, uname, gname, devmajor, devminor, prefix, format: 'ustar'|'gnu'|'v7',
 * badChecksum, base256: [fields]}
 */
function tarHeader(h) {
  const b = Buffer.alloc(BLOCK);
  writeStr(b, 0, 100, h.name || '');
  const num = (off, len, v, field) => {
    if (h.base256 && h.base256.includes(field)) {
      b[off] = 0x80;
      let x = Math.floor(v);
      for (let i = off + len - 1; i > off; i--) { b[i] = x % 256; x = Math.floor(x / 256); }
    } else writeOctal(b, off, len, v);
  };
  num(100, 8, h.mode == null ? 0o644 : h.mode, 'mode');
  num(108, 8, h.uid || 0, 'uid');
  num(116, 8, h.gid || 0, 'gid');
  num(124, 12, h.size || 0, 'size');
  num(136, 12, h.mtime == null ? 1700000000 : h.mtime, 'mtime');
  b.write(h.typeflag || '0', 156, 1, 'latin1');
  writeStr(b, 157, 100, h.linkname || '');
  const format = h.format || 'ustar';
  if (format === 'ustar') { b.write('ustar\0', 257, 6, 'latin1'); b.write('00', 263, 2, 'latin1'); }
  else if (format === 'gnu') { b.write('ustar ', 257, 6, 'latin1'); b.write(' \0', 263, 2, 'latin1'); }
  if (format !== 'v7') {
    writeStr(b, 265, 32, h.uname || 'root');
    writeStr(b, 297, 32, h.gname || 'root');
    num(329, 8, h.devmajor || 0, 'devmajor');
    num(337, 8, h.devminor || 0, 'devminor');
    if (format === 'ustar' && h.prefix) writeStr(b, 345, 155, h.prefix);
  }
  b.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  if (h.badChecksum) sum += 1;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return b;
}

function padBlock(buf) {
  const p = (BLOCK - (buf.length % BLOCK)) % BLOCK;
  return p ? Buffer.concat([buf, Buffer.alloc(p)]) : buf;
}

/** PAX records {key: value} -> "%d key=value\n" data. */
function paxData(records) {
  const parts = [];
  for (const [k, v] of Object.entries(records)) {
    const val = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    const body = Buffer.concat([Buffer.from(` ${k}=`, 'utf8'), val, Buffer.from('\n')]);
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    parts.push(Buffer.concat([Buffer.from(String(len), 'latin1'), body]));
  }
  return Buffer.concat(parts);
}

/**
 * Build a tar archive.
 * entries: [{path, type ('file'), data, mode, uid, gid, mtime, linkpath,
 *   devmajor, devminor, long: 'gnu'|'pax'|'prefix' (how to store a long
 *   path/linkpath), pax: {extra records}, globalPax: {records} (emits a 'g'
 *   header first), sizeField (override header size), extraData (bytes
 *   stored after the header regardless of type), base256: [fields],
 *   format, badChecksum}]
 * opts: {noEnd: true to omit the two zero blocks, trailingGarbage: Buffer}
 */
function buildTar(entries, opts) {
  opts = opts || {};
  const out = [];
  for (const e of entries) {
    const type = e.type || 'file';
    const data = e.data == null ? Buffer.alloc(0) : (Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'));
    let name = e.path + (type === 'dir' && !e.path.endsWith('/') ? '/' : '');
    let linkname = e.linkpath || '';
    let prefix = '';
    const pax = Object.assign({}, e.pax || {});
    if (e.globalPax) {
      const g = paxData(e.globalPax);
      out.push(tarHeader({ name: 'pax_global_header', typeflag: 'g', size: g.length }), padBlock(g));
    }
    const nameLen = Buffer.byteLength(name);
    const linkLen = Buffer.byteLength(linkname);
    const long = e.long || 'gnu';
    if (nameLen > 100 || e.long === 'pax-always') {
      if (long === 'prefix') {
        const cut = name.lastIndexOf('/', nameLen - 2 > 155 ? 155 : nameLen - 2);
        prefix = name.slice(0, cut);
        name = name.slice(cut + 1);
        if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) throw new Error('cannot split ' + e.path);
      } else if (long === 'pax' || long === 'pax-always') {
        pax.path = name;
        name = name.replace(/[^\x20-\x7e]/g, '_').slice(0, 99);
      } else {
        const L = Buffer.from(name + '\0', 'utf8');
        out.push(tarHeader({ name: '././@LongLink', typeflag: 'L', size: L.length, format: 'gnu' }), padBlock(L));
        name = name.replace(/[^\x20-\x7e]/g, '_').slice(0, 100);
      }
    }
    if (linkLen > 100) {
      if (long === 'pax' || long === 'pax-always') {
        pax.linkpath = linkname;
        linkname = linkname.slice(0, 99);
      } else {
        const K = Buffer.from(linkname + '\0', 'utf8');
        out.push(tarHeader({ name: '././@LongLink', typeflag: 'K', size: K.length, format: 'gnu' }), padBlock(K));
        linkname = linkname.slice(0, 100);
      }
    }
    if (Object.keys(pax).length) {
      const x = paxData(pax);
      out.push(tarHeader({ name: 'PaxHeaders/x', typeflag: 'x', size: x.length }), padBlock(x));
    }
    const size = e.sizeField != null ? e.sizeField : (type === 'file' ? data.length : 0);
    out.push(tarHeader({
      name, prefix, linkname, typeflag: e.typeflag || TYPEFLAG[type], size,
      mode: e.mode == null ? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644) : e.mode,
      uid: e.uid, gid: e.gid, mtime: e.mtime, devmajor: e.devmajor, devminor: e.devminor,
      format: e.format || (long === 'gnu' && (nameLen > 100 || linkLen > 100) ? 'gnu' : 'ustar'),
      badChecksum: e.badChecksum, base256: e.base256,
    }));
    if (type === 'file' && data.length) out.push(padBlock(data));
    if (e.extraData) out.push(padBlock(e.extraData));
  }
  if (!opts.noEnd) out.push(Buffer.alloc(BLOCK * 2));
  if (opts.trailingGarbage) out.push(opts.trailingGarbage);
  return Buffer.concat(out);
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oci-${tag || 'test'}-`));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * Write a layer blob. Returns {path, diffId, digest, size, tar, blob}.
 * opts.compress: 'gzip' (default) | 'none'.
 */
function writeLayer(dir, entries, opts) {
  opts = opts || {};
  const tar = Buffer.isBuffer(entries) ? entries : buildTar(entries, opts);
  const blob = opts.compress === 'none' ? tar : zlib.gzipSync(tar, { level: 1 });
  const digest = 'sha256:' + sha256(blob);
  const file = path.join(dir, digest.slice(7) + (opts.compress === 'none' ? '.tar' : '.tar.gz'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, blob);
  return { path: file, diffId: 'sha256:' + sha256(tar), digest, size: blob.length, tar, blob };
}

/** Collect every entry of an async iterable of tar entries, reading bodies. */
async function collectTar(iter) {
  const out = [];
  for await (const e of iter) {
    const parts = [];
    for await (const c of e.body()) parts.push(Buffer.from(c));
    const copy = Object.assign({}, e, { data: Buffer.concat(parts) });
    delete copy.body;
    out.push(copy);
  }
  return out;
}

/**
 * Listen on 127.0.0.1 on a port the OS picks; resolves the port. (The
 * prototype probed a fixed range; the from/to arguments are ignored and kept
 * only so the call sites read as before.)
 */
function listenInRange(server) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(0, '127.0.0.1');
  });
}

/** Find an executable (absolute path) or null. */
function findTool(candidates) {
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* next */ } }
  return null;
}

module.exports = {
  tarHeader, paxData, buildTar, padBlock, writeLayer, collectTar, tmpDir, rmrf, sha256, listenInRange, findTool, BLOCK,
};
