'use strict';
/*
 * A small, buffer-based tar reader (ustar + PAX + GNU long names).
 *
 * It is written for two callers:
 *   - Alpine .apk packages, which are three gzip members whose tar streams
 *     are concatenated WITHOUT end-of-archive blocks between them, so a
 *     zero block must not stop the reader (option `stopAtZero: false`);
 *   - OCI image layers (plain tar after decompression).
 *
 * parseTar(buf, opts) returns an array of entries:
 *   { name, type, mode, uid, gid, mtime, size, linkname, data, pax }
 * where `type` is one of 'file' | 'dir' | 'symlink' | 'hardlink' | 'char' |
 * 'block' | 'fifo' | 'other', `data` is a Buffer view (no copy) for regular
 * files and null otherwise, and `pax` holds the per-entry PAX records (Alpine
 * stores 'APK-TOOLS.checksum.SHA1' there).
 *
 * Names are returned exactly as stored, minus a leading "./"; callers decide
 * what to do with absolute or ".." paths (safeRelPath() helps).
 *
 * Exports: parseTar, safeRelPath, parseOctal.
 */

const BLOCK = 512;

function cstr(buf, start, len) {
  const end = buf.indexOf(0, start);
  const stop = end === -1 || end > start + len ? start + len : end;
  return buf.toString('utf8', start, stop);
}

// Numeric tar field: octal text, or GNU base-256 when the top bit is set.
function parseOctal(buf, start, len) {
  if (buf[start] & 0x80) {
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i];
    // the first byte's low 7 bits are also part of the number
    v += (buf[start] & 0x7f) * Math.pow(256, len - 1);
    return v;
  }
  const s = cstr(buf, start, len).replace(/[\s\0]+/g, '');
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(buf, off) {
  for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

function checksumOk(buf, off) {
  const stored = parseOctal(buf, off + 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += (i >= 148 && i < 156) ? 32 : buf[off + i];
  }
  return sum === stored;
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.toString('ascii', i, sp), 10);
    if (!(len > 0)) break;
    const rec = data.toString('utf8', sp + 1, i + len - 1); // drop trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const TYPES = {
  '0': 'file', '\0': 'file', '7': 'file',
  '1': 'hardlink', '2': 'symlink', '3': 'char', '4': 'block',
  '5': 'dir', '6': 'fifo',
};

// opts: { stopAtZero (default true), filter(name, header) -> bool (skip data copy) }
function parseTar(buf, opts) {
  opts = opts || {};
  const stopAtZero = opts.stopAtZero !== false;
  const entries = [];
  let off = 0;
  let pendingPax = null; // per-entry 'x' records
  let globalPax = {};
  let longName = null, longLink = null;
  while (off + BLOCK <= buf.length) {
    if (isZeroBlock(buf, off)) {
      if (stopAtZero) {
        // two zero blocks mark the end; one is tolerated
        if (off + 2 * BLOCK <= buf.length && isZeroBlock(buf, off + BLOCK)) break;
      }
      off += BLOCK;
      continue;
    }
    if (!checksumOk(buf, off)) throw new Error('tar: bad header checksum at offset ' + off);
    const typeflag = String.fromCharCode(buf[off + 156]);
    let size = parseOctal(buf, off + 124, 12);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('tar: truncated entry at offset ' + off);
    const data = buf.subarray(dataStart, dataEnd);
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') { pendingPax = parsePax(data); off = next; continue; }
    if (typeflag === 'g') { globalPax = Object.assign({}, globalPax, parsePax(data)); off = next; continue; }
    if (typeflag === 'L') { longName = cstr(data, 0, data.length); off = next; continue; }
    if (typeflag === 'K') { longLink = cstr(data, 0, data.length); off = next; continue; }

    const pax = Object.assign({}, globalPax, pendingPax || {});
    let name = cstr(buf, off, 100);
    const magic = buf.toString('ascii', off + 257, off + 263);
    if (magic.startsWith('ustar')) {
      const prefix = cstr(buf, off + 345, 155);
      if (prefix && magic === 'ustar\0') name = prefix + '/' + name;
    }
    if (longName !== null) name = longName;
    if (pax.path) name = pax.path;
    let linkname = cstr(buf, off + 157, 100);
    if (longLink !== null) linkname = longLink;
    if (pax.linkpath) linkname = pax.linkpath;
    if (pax.size) size = parseInt(pax.size, 10);

    name = name.replace(/^\.\//, '');
    const type = TYPES[typeflag] || 'other';
    const e = {
      name,
      type: type === 'file' && name.endsWith('/') ? 'dir' : type,
      mode: parseOctal(buf, off + 100, 8) & 0o7777,
      uid: pax.uid ? parseInt(pax.uid, 10) : parseOctal(buf, off + 108, 8),
      gid: pax.gid ? parseInt(pax.gid, 10) : parseOctal(buf, off + 116, 8),
      mtime: pax.mtime ? Math.floor(parseFloat(pax.mtime)) : parseOctal(buf, off + 136, 12),
      size: type === 'file' ? size : 0,
      linkname,
      devmajor: parseOctal(buf, off + 329, 8),
      devminor: parseOctal(buf, off + 337, 8),
      data: type === 'file' ? buf.subarray(dataStart, dataStart + size) : null,
      pax,
    };
    if (e.type === 'dir') e.name = e.name.replace(/\/+$/, '');
    if (!opts.filter || opts.filter(e.name, e)) entries.push(e);
    pendingPax = null; longName = null; longLink = null;
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

// Normalise a tar path to a safe relative path (no leading '/', no '..'
// escaping the root). Returns null when the path escapes.
function safeRelPath(name) {
  const parts = [];
  for (const p of String(name).split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join('/');
}

module.exports = { parseTar, safeRelPath, parseOctal };
