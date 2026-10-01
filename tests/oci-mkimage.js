'use strict';
/*
 * Test helper (not a test file): build small local OCI images (no network)
 * in an image cache root, to test flattening edge cases end to end.
 *
 *   tarBuffer(entries)       -> Buffer (ustar + PAX for long names)
 *   putLocalImage(root, name, {layers: [{tar, mediaType?, raw?} |
 *                 {digest, size, mediaType, diffId}], config})
 *                 -> records docker.io/library/<name>:latest in refs.json
 *   layerB(), layerC()       whiteouts, opaque dir, hardlinks surviving the
 *                            removal of their first path, symlink chains (as
 *                            parents and as files), long names, file<->dir
 *                            swaps
 *   buildAll(root)           the edge-case images on top of busybox's cached
 *                            layer (BUSYBOX_LAYER must be in the cache)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function header(name, o) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(o.mode & 0o7777, 8), 100, 'latin1');
  h.write(octal(o.uid || 0, 8), 108, 'latin1');
  h.write(octal(o.gid || 0, 8), 116, 'latin1');
  h.write(octal(o.size || 0, 12), 124, 'latin1');
  h.write(octal(o.mtime || 1700000000, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(o.typeflag, 156, 'latin1');
  if (o.linkname) h.write(o.linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148, 'latin1');
  return h;
}

function paxRecord(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return String(len) + body;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

// entries: {path, type: 'file'|'dir'|'symlink'|'hardlink', data, mode, linkpath, uid, gid, mtime}
function tarBuffer(entries) {
  const parts = [];
  for (const e of entries) {
    const tf = { file: '0', dir: '5', symlink: '2', hardlink: '1' }[e.type];
    const data = e.type === 'file' ? Buffer.from(e.data || '') : Buffer.alloc(0);
    const name = e.type === 'dir' && !e.path.endsWith('/') ? e.path + '/' : e.path;
    const link = e.linkpath || '';
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(link) > 100) {
      let pax = '';
      if (Buffer.byteLength(name) > 100) pax += paxRecord('path', name);
      if (Buffer.byteLength(link) > 100) pax += paxRecord('linkpath', link);
      const pb = Buffer.from(pax, 'utf8');
      parts.push(header('PaxHeaders/x', { mode: 0o644, size: pb.length, typeflag: 'x' }), pb, pad(pb.length));
    }
    parts.push(header(name, { mode: e.mode != null ? e.mode : (e.type === 'dir' ? 0o755 : e.type === 'symlink' ? 0o777 : 0o644), size: data.length, typeflag: tf, linkname: link, uid: e.uid, gid: e.gid, mtime: e.mtime }));
    if (data.length) parts.push(data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function putBlob(root, buf) {
  const hex = sha(buf);
  const dir = path.join(root, 'blobs', 'sha256');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, hex);
  if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
  return { digest: 'sha256:' + hex, size: buf.length };
}

// layers: [{tar: Buffer, mediaType?, raw?: Buffer (stored as-is)} | {digest, size, mediaType, diffId}]
function putLocalImage(root, name, spec) {
  const descs = [];
  const diffIds = [];
  for (const l of spec.layers) {
    if (l.digest) { descs.push({ mediaType: l.mediaType, digest: l.digest, size: l.size }); diffIds.push(l.diffId); continue; }
    const blob = l.raw || zlib.gzipSync(l.tar);
    const d = putBlob(root, blob);
    descs.push({ mediaType: l.mediaType || 'application/vnd.oci.image.layer.v1.tar+gzip', digest: d.digest, size: d.size });
    diffIds.push('sha256:' + sha(l.tar || blob));
  }
  const config = { architecture: 'amd64', os: 'linux', config: spec.config || {}, rootfs: { type: 'layers', diff_ids: diffIds } };
  const cd = putBlob(root, Buffer.from(JSON.stringify(config)));
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: cd.digest, size: cd.size }, layers: descs };
  const md = putBlob(root, Buffer.from(JSON.stringify(manifest)));
  const refsFile = path.join(root, 'refs.json');
  const refs = JSON.parse(fs.readFileSync(refsFile, 'utf8'));
  refs['docker.io/library/' + name + ':latest'] = { manifestDigest: md.digest, platformDigest: md.digest, configDigest: cd.digest, platform: { architecture: 'amd64', os: 'linux' }, pulledAt: new Date().toISOString() };
  fs.writeFileSync(refsFile, JSON.stringify(refs, null, 2));
  return { manifest: md.digest, config: cd.digest, diffIds };
}

const BUSYBOX_LAYER = {
  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
  digest: 'sha256:37bb94b0940bd40749eced2b83080d1b9912f281ac499a7247e4ce7c385792cc',
  size: 2226163,
  diffId: 'sha256:6cd030ace585499136a675899c23aeddcf4ae8065a8d35f016a132bfdc3b4aed',
};
const BB_CONFIG = { Cmd: ['sh'], Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'] };

const LONG_DIR = 'long/' + 'd'.repeat(60) + '/' + 'e'.repeat(60);
const LONG_FILE = LONG_DIR + '/' + 'f'.repeat(70) + '.txt';

function layerB() {
  const e = [
    { path: 'etc', type: 'dir' },
    { path: 'etc/secret', type: 'file', data: 's1\n' },
    { path: 'etc/again', type: 'file', data: 'again-B\n' },
    { path: 'd', type: 'dir' }, { path: 'd/a', type: 'file', data: 'a\n' }, { path: 'd/b', type: 'file', data: 'b\n' },
    { path: 'opq', type: 'dir' }, { path: 'opq/old', type: 'file', data: 'old\n' }, { path: 'opq/sub', type: 'dir' }, { path: 'opq/sub/deep', type: 'file', data: 'deep\n' },
    { path: 'hl', type: 'dir' }, { path: 'hl/orig', type: 'file', data: 'hardcontent\n' },
    { path: 'hl/link', type: 'hardlink', linkpath: 'hl/orig' }, { path: 'hl/link2', type: 'hardlink', linkpath: 'hl/orig' },
    { path: 'wdir', type: 'dir' }, { path: 'wdir/x', type: 'file', data: 'x\n' },
    { path: 'fd', type: 'dir' }, { path: 'fd/child', type: 'file', data: 'child\n' },
    { path: 'df', type: 'file', data: 'was-a-file\n' },
    { path: 's', type: 'dir' }, { path: 's/t', type: 'file', data: 'target\n' },
    { path: 'realdir', type: 'dir' },
    { path: 'qreal', type: 'dir' },
    { path: 'long', type: 'dir' }, { path: 'long/' + 'd'.repeat(60), type: 'dir' }, { path: LONG_DIR, type: 'dir' },
    { path: LONG_FILE, type: 'file', data: 'long-ok\n' },
    { path: 'longlink', type: 'symlink', linkpath: '/' + LONG_FILE },
    { path: 'sp ace', type: 'dir' }, { path: 'sp ace/ü-ñ.txt', type: 'file', data: 'utf8-ok\n' },
    { path: 'suid', type: 'file', data: '#!/bin/sh\necho suid\n', mode: 0o4755 },
    { path: 'sticky', type: 'dir', mode: 0o1777 },
  ];
  // 20-link symlink chain ending at s/t (fine for the kernel's 40 limit),
  // and a 45-link one (beyond it)
  for (let i = 0; i < 20; i++) e.push({ path: 's/c' + i, type: 'symlink', linkpath: i === 19 ? 't' : 'c' + (i + 1) });
  for (let i = 0; i < 45; i++) e.push({ path: 's/l' + i, type: 'symlink', linkpath: i === 44 ? 't' : 'l' + (i + 1) });
  // parent-path chains for layer C entries: p0 -> ... -> p9 -> realdir (10
  // hops) and q0 -> ... -> q44 -> qreal (45 hops, over the 40 hop limit)
  for (let i = 0; i < 10; i++) e.push({ path: 'p' + i, type: 'symlink', linkpath: i === 9 ? 'realdir' : 'p' + (i + 1) });
  for (let i = 0; i < 45; i++) e.push({ path: 'q' + i, type: 'symlink', linkpath: i === 44 ? '/qreal' : 'q' + (i + 1) });
  return e;
}

function layerC() {
  return [
    { path: 'etc', type: 'dir' },
    { path: 'etc/.wh.secret', type: 'file' },
    { path: 'etc/again', type: 'file', data: 'again-C\n' },
    { path: 'etc/.wh.again', type: 'file' },
    { path: 'd', type: 'dir' }, { path: 'd/.wh.a', type: 'file' },
    { path: 'opq', type: 'dir' }, { path: 'opq/.wh..wh..opq', type: 'file' }, { path: 'opq/new', type: 'file', data: 'new\n' },
    { path: 'hl', type: 'dir' }, { path: 'hl/.wh.orig', type: 'file' },
    { path: '.wh.wdir', type: 'file' },
    { path: 'bin', type: 'dir' }, { path: 'bin/.wh.[', type: 'file' },
    { path: '.wh.nonexistent', type: 'file' },
    { path: 'hl2', type: 'hardlink', linkpath: 'bin/sh' },
    { path: 'fd', type: 'file', data: 'now-a-file\n' },
    { path: 'df', type: 'dir' }, { path: 'df/in', type: 'file', data: 'in\n' },
    { path: 'p0/viachain', type: 'file', data: 'chain\n' },
    { path: 'q0/x', type: 'file', data: 'x45\n' },
  ];
}

function buildAll(root) {
  const out = {};
  out.vwhiteout = putLocalImage(root, 'vwhiteout', { layers: [BUSYBOX_LAYER, { tar: tarBuffer(layerB()) }, { tar: tarBuffer(layerC()) }], config: BB_CONFIG });
  out.vzstdmt = putLocalImage(root, 'vzstdmt', { layers: [BUSYBOX_LAYER, { tar: tarBuffer([{ path: 'z', type: 'file', data: 'z\n' }]), mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd' }], config: BB_CONFIG });
  // a blob whose bytes start with the zstd frame magic, declared as gzip
  const fakeZstd = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), crypto.randomBytes(60)]);
  out.vzstdmagic = putLocalImage(root, 'vzstdmagic', { layers: [BUSYBOX_LAYER, { raw: fakeZstd, tar: null }], config: BB_CONFIG });
  out.vnoentry = putLocalImage(root, 'vnoentry', { layers: [BUSYBOX_LAYER], config: { Env: BB_CONFIG.Env } });
  out.vmissing = putLocalImage(root, 'vmissing', { layers: [BUSYBOX_LAYER], config: { Entrypoint: ['/nonexistent-binary'], Env: BB_CONFIG.Env } });
  return out;
}

module.exports = { tarBuffer, putLocalImage, buildAll, layerB, layerC, BUSYBOX_LAYER, LONG_FILE };
