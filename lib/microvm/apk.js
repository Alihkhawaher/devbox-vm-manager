'use strict';
/*
 * Alpine package (.apk v2) support for the microVM kernel setup: read and
 * VERIFY the signed APKINDEX, download a package, verify it end to end, and
 * extract files from it. Node standard library only.
 *
 * An .apk v2 file is three gzip members back to back:
 *   1. signature  (tar segment: .SIGN.RSA.<key> or .SIGN.RSA256.<key>)
 *   2. control    (tar segment with .PKGINFO)
 *   3. data       (the package's files, a normal tar)
 * APKINDEX.tar.gz is two: a signature member, then the index member.
 *
 * Chain of trust (bug C - the prototype trusted HTTPS alone):
 *   - the APKINDEX signature: RSA over the raw bytes of everything after the
 *     signature member, checked against Alpine's public keys BUNDLED with the
 *     app (lib/microvm/keys, taken from alpine:latest /etc/apk/keys). An
 *     unknown key or a bad signature stops the setup. The index is the root
 *     of trust: it names the size (S:) and control checksum (C:) of every
 *     package;
 *   - a package: size == S:, sha1(control member) == C: (Q1 + base64),
 *     sha256(data member) == .PKGINFO datahash, pkgname/pkgver == P:/V:, and
 *     the package's own control signature against the same bundled keys.
 *   A package can also be verified WITHOUT the index (cached packages, no
 *   network): its control signature proves Alpine made the control member,
 *   and the control member's datahash covers the data member.
 *
 * Transfers go through lib/download.js (timeouts, a .part per writer, a
 * verify hook that runs BEFORE the rename), never an own HTTP client.
 *
 * Exports:
 *   loadKeys(dir?) -> Map keyName -> PEM
 *   splitGzipMembers(buf) -> [{start, end, data}]
 *   readSignature(member) -> {keyName, algo, sig} | null
 *   verifyIndexBuffer(buf, keys?) -> {keyName, algo}           (throws)
 *   parseApkIndex(text) -> Map name -> {P,V,S,C,...}
 *   readApkIndex(buf, keys?) -> {index: Map, keyName}           (verified)
 *   fetchApkIndex(repoUrl, {dir, t, keys, allowHttp}) -> Promise<{index, keyName, file}>
 *   readApk(buf) -> {members, control, pkginfo, controlMember, dataMember, data()}
 *   verifyApk(buf, indexEntry?, {keys, requireSignature}) -> {ok, ...}   (throws)
 *   downloadApk(repoUrl, entry, destDir, {t, keys, allowHttp}) -> Promise<{path, entry, verified, cached}>
 *   apkFileName(entry) -> "name-version.apk"
 *   compareApkVersions(a, b) -> <0 | 0 | >0
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { parseTar } = require('./tar');
const { download } = require('../download');

const KEYS_DIR = path.join(__dirname, 'keys');

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
let keyCache = null;
function loadKeys(dir) {
  if (!dir && keyCache) return keyCache;
  const d = dir || KEYS_DIR;
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(d); } catch (e) { /* no keys: every check fails closed */ }
  for (const f of names) {
    if (!/\.rsa\.pub$/.test(f)) continue;
    try { out.set(f, fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { /* unreadable: skipped */ }
  }
  if (!dir) keyCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// gzip members
// ---------------------------------------------------------------------------
function gzipHeaderLength(buf, off) {
  if (buf[off] !== 0x1f || buf[off + 1] !== 0x8b || buf[off + 2] !== 8) {
    throw new Error('not a gzip member at offset ' + off);
  }
  const flg = buf[off + 3];
  let p = off + 10;
  if (flg & 4) { const xlen = buf.readUInt16LE(p); p += 2 + xlen; }
  if (flg & 8) { while (buf[p] !== 0) p++; p++; }
  if (flg & 16) { while (buf[p] !== 0) p++; p++; }
  if (flg & 2) p += 2;
  return p - off;
}

// Split a buffer of concatenated gzip members. Each member is inflated on
// its own, which also yields where its compressed bytes end.
function splitGzipMembers(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const hl = gzipHeaderLength(buf, off);
    const r = zlib.inflateRawSync(buf.subarray(off + hl), { info: true });
    const consumed = r.engine.bytesWritten;
    const end = off + hl + consumed + 8; // + CRC32 + ISIZE trailer
    if (end > buf.length) throw new Error('truncated gzip member at ' + off);
    const isize = buf.readUInt32LE(end - 4);
    if ((r.buffer.length >>> 0) !== isize) throw new Error('gzip ISIZE mismatch in member at ' + off);
    out.push({ start: off, end, data: r.buffer });
    off = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// signatures
// ---------------------------------------------------------------------------
// The signature entry of a (decompressed) signature member, or null when the
// member holds none. ".SIGN.RSA.<key>" is RSA-SHA1, ".SIGN.RSA256.<key>"
// RSA-SHA256 (abuild-sign).
function readSignature(member) {
  const entries = parseTar(member.data, { stopAtZero: false });
  const e = entries.find((x) => x.type === 'file' && /^\.SIGN\.RSA(256)?\./.test(x.name));
  if (!e) return null;
  const m = /^\.SIGN\.RSA(256)?\.(.+)$/.exec(e.name);
  return { keyName: m[2], algo: m[1] ? 'sha256' : 'sha1', sig: Buffer.from(e.data) };
}

function checkSignature(sigInfo, signed, keys, what) {
  if (!sigInfo) throw new Error(what + ' is not signed');
  if (!/^[A-Za-z0-9@._+-]+\.rsa\.pub$/.test(sigInfo.keyName)) throw new Error(what + ' names an invalid signing key "' + sigInfo.keyName.slice(0, 80) + '"');
  const pem = (keys || loadKeys()).get(sigInfo.keyName);
  if (!pem) throw new Error(what + ' is signed with an unknown key (' + sigInfo.keyName + ') - it is not one of the Alpine keys this app ships');
  let ok = false;
  try { ok = crypto.verify(sigInfo.algo, signed, pem, sigInfo.sig); } catch (e) { ok = false; }
  if (!ok) throw new Error(what + ': the signature does not match (' + sigInfo.keyName + ') - the file was changed or damaged');
  return { keyName: sigInfo.keyName, algo: sigInfo.algo };
}

// APKINDEX.tar.gz: member 0 signs the raw bytes of every member after it.
function verifyIndexBuffer(buf, keys) {
  const members = splitGzipMembers(buf);
  if (members.length < 2) throw new Error('APKINDEX has no signature member (' + members.length + ' gzip member)');
  const sig = readSignature(members[0]);
  return checkSignature(sig, buf.subarray(members[1].start), keys, 'APKINDEX');
}

// ---------------------------------------------------------------------------
// APKINDEX
// ---------------------------------------------------------------------------
function parseApkIndex(text) {
  const map = new Map();
  for (const block of String(text).split(/\n\n+/)) {
    const rec = {};
    for (const line of block.split('\n')) {
      const m = /^([A-Za-z]):(.*)$/.exec(line);
      if (m) rec[m[1]] = m[2];
    }
    if (rec.P) map.set(rec.P, rec);
  }
  return map;
}

// A downloaded APKINDEX.tar.gz -> the VERIFIED index.
function readApkIndex(buf, keys) {
  const v = verifyIndexBuffer(buf, keys);
  const members = splitGzipMembers(buf);
  const all = Buffer.concat(members.slice(1).map((m) => m.data));
  const entries = parseTar(all, { stopAtZero: false });
  const idx = entries.find((e) => e.name === 'APKINDEX');
  if (!idx) throw new Error('the APKINDEX archive has no APKINDEX file');
  return { index: parseApkIndex(idx.data.toString('utf8')), keyName: v.keyName };
}

// Download + verify the index of one repository (e.g.
// https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64). The file lands in
// opts.dir as APKINDEX.tar.gz only when its signature verified.
// opts: {dir (required), t, keys, allowHttp (tests)}
async function fetchApkIndex(repoUrl, opts) {
  opts = opts || {};
  if (!opts.dir) throw new TypeError('fetchApkIndex: opts.dir is required');
  fs.mkdirSync(opts.dir, { recursive: true });
  const url = repoUrl.replace(/\/+$/, '') + '/APKINDEX.tar.gz';
  const file = path.join(opts.dir, 'APKINDEX.tar.gz');
  await download(url, file, {
    t: opts.t, label: 'APKINDEX', allowHttp: opts.allowHttp, maxBytes: 64 * 1024 * 1024,
    verify: async (part) => { verifyIndexBuffer(fs.readFileSync(part), opts.keys); },
  });
  const r = readApkIndex(fs.readFileSync(file), opts.keys);
  return { index: r.index, keyName: r.keyName, file };
}

const apkFileName = (entry) => entry.P + '-' + entry.V + '.apk';

// Alpine versions ("6.18.54-r0", "1.37.0-r30", "2.2_rc1-r3"): numeric parts,
// then suffixes, then the -rN revision. Enough to pick the newest cached
// package of one name; the index itself only ever holds one version.
function compareApkVersions(a, b) {
  const split = (v) => {
    const m = /^(.*?)(?:-r(\d+))?$/.exec(String(v));
    return { nums: m[1].split(/[._]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : x)), rev: parseInt(m[2] || '0', 10) };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const p = x.nums[i], q = y.nums[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === 'number' && typeof q === 'number') { if (p !== q) return p - q; continue; }
    const c = String(p).localeCompare(String(q));
    if (c) return c;
  }
  return x.rev - y.rev;
}

// ---------------------------------------------------------------------------
// reading / verifying a package
// ---------------------------------------------------------------------------
function parsePkgInfo(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([a-z_]+) = (.*)$/.exec(line);
    if (!m) continue;
    if (out[m[1]] === undefined) out[m[1]] = m[2];
    else out[m[1]] = [].concat(out[m[1]], m[2]);
  }
  return out;
}

function readApk(buf) {
  const members = splitGzipMembers(buf);
  if (members.length < 2) throw new Error('an .apk needs at least control and data members, found ' + members.length);
  const dataM = members[members.length - 1];
  const ctrlM = members[members.length - 2];
  const control = parseTar(ctrlM.data, { stopAtZero: false });
  const pk = control.find((e) => e.name === '.PKGINFO');
  if (!pk) throw new Error('.PKGINFO missing');
  const pkginfo = parsePkgInfo(pk.data.toString('utf8'));
  return {
    members,
    control,
    pkginfo,
    controlMember: ctrlM,
    dataMember: dataM,
    signatureMember: members.length >= 3 ? members[0] : null,
    data: () => parseTar(dataM.data),
  };
}

// entry: the APKINDEX record (optional: without it only the package's own
// signature and datahash chain is checked). opts: {keys, requireSignature
// (default true)}. Throws on any mismatch.
function verifyApk(buf, entry, opts) {
  opts = opts || {};
  if (entry && entry.S && buf.length !== parseInt(entry.S, 10)) {
    throw new Error('size mismatch: ' + buf.length + ' bytes, APKINDEX says ' + entry.S);
  }
  const apk = readApk(buf);
  const ctrlBytes = buf.subarray(apk.controlMember.start, apk.controlMember.end);
  const q1 = 'Q1' + crypto.createHash('sha1').update(ctrlBytes).digest('base64');
  if (entry && entry.C && entry.C !== q1) {
    throw new Error('control checksum mismatch: ' + q1 + ' vs APKINDEX ' + entry.C);
  }
  const dataBytes = buf.subarray(apk.dataMember.start, apk.dataMember.end);
  const dh = crypto.createHash('sha256').update(dataBytes).digest('hex');
  if (!apk.pkginfo.datahash) throw new Error('.PKGINFO has no datahash - the package contents cannot be verified');
  if (apk.pkginfo.datahash !== dh) {
    throw new Error('data hash mismatch: ' + dh + ' vs .PKGINFO ' + apk.pkginfo.datahash);
  }
  if (entry && entry.P && apk.pkginfo.pkgname !== entry.P) throw new Error('package name mismatch');
  if (entry && entry.V && apk.pkginfo.pkgver !== entry.V) throw new Error('package version mismatch');
  let signature = null;
  if (opts.requireSignature !== false || apk.signatureMember) {
    const sig = apk.signatureMember ? readSignature(apk.signatureMember) : null;
    signature = checkSignature(sig, ctrlBytes, opts.keys, (apk.pkginfo.pkgname || 'package') + ' ' + (apk.pkginfo.pkgver || ''));
  }
  return {
    ok: true,
    size: buf.length,
    controlSha1: q1,
    dataSha256: dh,
    signed: !!signature,
    signature,
    pkginfo: apk.pkginfo,
    apk,
  };
}

// Download (or reuse a verified cached copy of) the package an APKINDEX
// entry names. Nothing unverified ever appears at the final path.
// opts: {t, keys, allowHttp (tests)}
async function downloadApk(repoUrl, entry, destDir, opts) {
  opts = opts || {};
  if (!entry || !entry.P || !entry.V) throw new Error('downloadApk: an APKINDEX entry is required');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, apkFileName(entry));
  if (fs.existsSync(dest)) {
    try { verifyApk(fs.readFileSync(dest), entry, { keys: opts.keys }); return { path: dest, entry, verified: true, cached: true, bytes: 0 }; }
    catch (e) { /* stale or damaged: download again */ }
  }
  const url = repoUrl.replace(/\/+$/, '') + '/' + apkFileName(entry);
  const r = await download(url, dest, {
    t: opts.t, label: apkFileName(entry), allowHttp: opts.allowHttp,
    maxBytes: entry.S ? parseInt(entry.S, 10) + 1 : 512 * 1024 * 1024,
    verify: async (part) => { verifyApk(fs.readFileSync(part), entry, { keys: opts.keys }); },
  });
  return { path: dest, entry, verified: true, cached: false, bytes: r.bytes };
}

module.exports = {
  KEYS_DIR,
  loadKeys,
  splitGzipMembers,
  gzipHeaderLength,
  readSignature,
  verifyIndexBuffer,
  parseApkIndex,
  readApkIndex,
  fetchApkIndex,
  parsePkgInfo,
  readApk,
  verifyApk,
  downloadApk,
  apkFileName,
  compareApkVersions,
};
