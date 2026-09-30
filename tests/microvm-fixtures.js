'use strict';
/*
 * Test helpers for the microVM tests (not a test file itself):
 *   tar(entries, {noEnd}) / gz(buf)      in-memory tar + gzip (ustar + PAX)
 *   testKeys()                           a throwaway RSA key pair named like an
 *                                        Alpine key: {name, pem (public), key (private),
 *                                        keys: Map name -> pem (for apk.js opts.keys)}
 *   signedApk({name, version, files, keys, badHash, unsigned, sha256})
 *                                        an .apk v2 (signature, control, data members)
 *                                        -> {buf, entry (its APKINDEX record)}
 *   signedIndex(entries, keys, {sha256}) APKINDEX.tar.gz signed like abuild-sign
 *   fakeKernelApks(keys)                 synthetic linux-virt + busybox-static packages
 *                                        that prepareKernelAssets accepts (every
 *                                        FEATURES module, the built-in config)
 *   kernelEntries(kernelBuf, busyboxBuf) their APKINDEX entries
 * The keys are generated per process (2048-bit RSA, ~100 ms).
 */
const zlib = require('zlib');
const crypto = require('crypto');

function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function header(name, opts) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(opts.mode || 0o644, 8), 100, 'ascii');
  h.write(octal(opts.uid || 0, 8), 108, 'ascii');
  h.write(octal(opts.gid || 0, 8), 116, 'ascii');
  h.write(octal(opts.size || 0, 12), 124, 'ascii');
  h.write(octal(opts.mtime || 0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(opts.type || '0', 156, 'ascii');
  if (opts.linkname) h.write(opts.linkname, 157, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

const pad512 = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxRecord(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return len + body;
}

// entries: [{name, data?, type?, mode?, linkname?, pax?: {k: v}}]
function tar(entries, opts) {
  const parts = [];
  for (const e of entries) {
    if (e.pax) {
      const pax = Buffer.from(Object.entries(e.pax).map(([k, v]) => paxRecord(k, v)).join(''));
      parts.push(header('PaxHeader/' + e.name.slice(0, 80), { type: 'x', size: pax.length }), pad512(pax));
    }
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    parts.push(header(e.name, Object.assign({}, e, { size: data.length })));
    if (data.length) parts.push(pad512(data));
  }
  if (!(opts && opts.noEnd)) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const gz = (b) => zlib.gzipSync(b);

let keyCache = null;
function testKeys() {
  if (keyCache) return keyCache;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = 'devbox-test@example.invalid-00c0ffee.rsa.pub';
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  keyCache = { name, pem, key: privateKey, keys: new Map([[name, pem]]) };
  return keyCache;
}

// A signature member over `signed` (raw bytes), abuild-sign style.
function signatureMember(signed, keys, sha256) {
  const algo = sha256 ? 'sha256' : 'sha1';
  const sig = crypto.sign(algo, signed, keys.key);
  return gz(tar([{ name: '.SIGN.RSA' + (sha256 ? '256' : '') + '.' + keys.name, data: sig }], { noEnd: true }));
}

// files: [{name, data?, type?, mode?}] of the data tar
function signedApk(o) {
  const dataGz = gz(tar(o.files || [{ name: 'x', data: 'x' }]));
  const datahash = crypto.createHash('sha256').update(dataGz).digest('hex');
  const pkginfo = 'pkgname = ' + o.name + '\npkgver = ' + o.version + '\n' + (o.noHash ? '' : 'datahash = ' + (o.badHash ? '00' : datahash) + '\n') + 'depend = a\ndepend = b\n';
  const ctrlGz = gz(tar([{ name: '.PKGINFO', data: pkginfo }], { noEnd: true }));
  const parts = o.unsigned ? [ctrlGz, dataGz] : [signatureMember(ctrlGz, o.keys, o.sha256), ctrlGz, dataGz];
  const buf = Buffer.concat(parts);
  const entry = { P: o.name, V: o.version, S: String(buf.length), C: 'Q1' + crypto.createHash('sha1').update(ctrlGz).digest('base64') };
  return { buf, entry };
}

// APKINDEX.tar.gz: signature member + one gzip member with APKINDEX
function signedIndex(entries, keys, o) {
  o = o || {};
  const text = entries.map((e) => Object.entries(e).map(([k, v]) => k + ':' + v).join('\n')).join('\n\n') + '\n\n';
  const idx = gz(tar([{ name: 'DESCRIPTION', data: 'v3.23 test' }, { name: 'APKINDEX', data: text }]));
  return Buffer.concat([signatureMember(idx, keys, o.sha256), idx]);
}

const KVER = '9.9.9-0-virt';

// Synthetic linux-virt + busybox-static packages: every module FEATURES
// names, a modules.dep with a few real-looking dependencies, a config with
// the drivers kernel.js expects built in.
function fakeKernelApks(keys) {
  const kernel = require('../lib/microvm/kernel');
  const names = new Set();
  for (const list of Object.values(kernel.FEATURES)) for (const n of list) names.add(n);
  // dependencies as in the real kernel: 9p needs netfs + 9pnet, 9pnet_fd needs 9pnet
  const deps = { '9p': ['netfs', '9pnet'], '9pnet_fd': ['9pnet'], ext4: ['jbd2', 'mbcache', 'crc16'], virtio_net: ['net_failover', 'failover'] };
  for (const d of Object.values(deps)) for (const n of d) names.add(n);
  const rel = (n) => 'kernel/x/' + n + '.ko.gz';
  const depLines = Array.from(names).map((n) => rel(n) + ':' + (deps[n] || []).map((d) => ' ' + rel(d)).join(''));
  const files = [
    { name: 'boot/', type: '5' },
    { name: 'boot/vmlinuz-virt', data: Buffer.from('MZ fake bzImage ' + 'k'.repeat(4000)) },
    { name: 'boot/config-' + KVER, data: kernel.BUILTIN_EXPECTED.map((s) => 'CONFIG_' + s + '=y').join('\n') + '\n' },
    { name: 'lib/', type: '5' }, { name: 'lib/modules/', type: '5' }, { name: 'lib/modules/' + KVER + '/', type: '5' },
    { name: 'lib/modules/' + KVER + '/modules.dep', data: depLines.join('\n') + '\n' },
    { name: 'lib/modules/' + KVER + '/modules.builtin', data: 'kernel/drivers/virtio/virtio_pci.ko\n' },
  ];
  for (const n of names) files.push({ name: 'lib/modules/' + KVER + '/' + rel(n), data: zlib.gzipSync(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(' module ' + n)])) });
  const k = signedApk({ name: 'linux-virt', version: '9.9.9-r0', files, keys });
  const b = signedApk({ name: 'busybox-static', version: '1.99.0-r1', files: [{ name: 'bin/', type: '5' }, { name: 'bin/busybox.static', data: '\x7fELF busybox', mode: 0o755 }], keys });
  return { kernel: k, busybox: b, kver: KVER, modules: Array.from(names) };
}

module.exports = { tar, gz, header, pad512, testKeys, signedApk, signedIndex, fakeKernelApks, KVER };
