'use strict';
/*
 * The Alpine package side of the microVM kernel setup: the small tar reader,
 * .apk v2 verification (size, control sha1, datahash) and - bug C - the RSA
 * signatures of packages and of the APKINDEX against the bundled keys.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTar, safeRelPath } = require('../lib/microvm/tar');
const apk = require('../lib/microvm/apk');
const { tar, gz, testKeys, signedApk, signedIndex } = require('./microvm-fixtures');

const CACHED = path.join(__dirname, '..', 'data', 'kernel');

test('parseTar: files, dirs, symlinks, pax path override, long names', () => {
  const long = 'a/' + 'x'.repeat(150) + '/file.txt';
  const buf = tar([
    { name: 'dir/', type: '5', mode: 0o755 },
    { name: './dir/hello.txt', data: 'hello', mode: 0o600, uid: 1000 },
    { name: 'dir/link', type: '2', linkname: 'hello.txt' },
    { name: 'short', data: 'long one', pax: { path: long, 'APK-TOOLS.checksum.SHA1': 'abc' } },
  ]);
  const e = parseTar(buf);
  assert.deepStrictEqual(e.map((x) => [x.name, x.type]), [['dir', 'dir'], ['dir/hello.txt', 'file'], ['dir/link', 'symlink'], [long, 'file']]);
  assert.strictEqual(e[1].data.toString(), 'hello');
  assert.strictEqual(e[1].mode, 0o600);
  assert.strictEqual(e[1].uid, 1000);
  assert.strictEqual(e[2].linkname, 'hello.txt');
  assert.strictEqual(e[3].pax['APK-TOOLS.checksum.SHA1'], 'abc');
});

test('parseTar: concatenated segments without end blocks (apk style)', () => {
  const a = tar([{ name: '.SIGN.RSA.x', data: 'sig' }], { noEnd: true });
  const b = tar([{ name: '.PKGINFO', data: 'pkgname = x\n' }], { noEnd: true });
  const all = Buffer.concat([a, b, Buffer.alloc(512), tar([{ name: 'data', data: 'd' }])]);
  assert.deepStrictEqual(parseTar(all, { stopAtZero: false }).map((x) => x.name), ['.SIGN.RSA.x', '.PKGINFO', 'data']);
  assert.deepStrictEqual(parseTar(all).map((x) => x.name), ['.SIGN.RSA.x', '.PKGINFO', 'data']); // single zero block tolerated
});

test('parseTar: bad checksum and truncation are errors', () => {
  const buf = tar([{ name: 'f', data: 'x'.repeat(600) }]);
  const bad = Buffer.from(buf); bad[0] ^= 1;
  assert.throws(() => parseTar(bad), /checksum/);
  assert.throws(() => parseTar(buf.subarray(0, 700)), /truncated/);
});

test('safeRelPath', () => {
  assert.strictEqual(safeRelPath('/usr/./bin//x'), 'usr/bin/x');
  assert.strictEqual(safeRelPath('a/../b'), 'b');
  assert.strictEqual(safeRelPath('../etc/passwd'), null);
});

const pkg = (o) => signedApk(Object.assign({ name: 'busybox-static', version: '1.0-r0', keys: testKeys(),
  files: [{ name: 'bin/', type: '5' }, { name: 'bin/busybox.static', data: 'ELF...', mode: 0o755 }] }, o || {}));

test('splitGzipMembers finds member boundaries', () => {
  const { buf } = pkg();
  const m = apk.splitGzipMembers(buf);
  assert.strictEqual(m.length, 3);
  assert.strictEqual(m[0].start, 0);
  assert.strictEqual(m[2].end, buf.length);
  assert.strictEqual(m[1].start, m[0].end);
});

test('verifyApk: size, control sha1 (C:), data sha256 (datahash), and the Alpine-style signature', () => {
  const k = testKeys();
  const { buf, entry } = pkg();
  const v = apk.verifyApk(buf, entry, { keys: k.keys });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.signed, true);
  assert.deepStrictEqual(v.signature, { keyName: k.name, algo: 'sha1' });
  assert.deepStrictEqual(v.pkginfo.depend, ['a', 'b']);
  assert.strictEqual(v.apk.data().find((e) => e.name === 'bin/busybox.static').data.toString(), 'ELF...');
  assert.throws(() => apk.verifyApk(buf, Object.assign({}, entry, { S: '1' }), { keys: k.keys }), /size mismatch/);
  assert.throws(() => apk.verifyApk(buf, Object.assign({}, entry, { C: 'Q1AAAA' }), { keys: k.keys }), /control checksum/);
  const bad = pkg({ badHash: true });
  assert.throws(() => apk.verifyApk(bad.buf, bad.entry, { keys: k.keys }), /data hash mismatch/);
  const nohash = pkg({ noHash: true });
  assert.throws(() => apk.verifyApk(nohash.buf, nohash.entry, { keys: k.keys }), /no datahash/);
  // RSA-SHA256 signatures (.SIGN.RSA256.) verify as well
  const s256 = pkg({ sha256: true });
  assert.strictEqual(apk.verifyApk(s256.buf, s256.entry, { keys: k.keys }).signature.algo, 'sha256');
});

test('verifyApk: unsigned, unknown key, forged signature and a changed control member are refused (bug C)', () => {
  const k = testKeys();
  const unsigned = pkg({ unsigned: true });
  assert.throws(() => apk.verifyApk(unsigned.buf, unsigned.entry, { keys: k.keys }), /not signed/);
  assert.strictEqual(apk.verifyApk(unsigned.buf, unsigned.entry, { keys: k.keys, requireSignature: false }).signed, false);
  const { buf, entry } = pkg();
  // the bundled Alpine keys do not know the test key
  assert.throws(() => apk.verifyApk(buf, entry), /unknown key/);
  // a signature by another key under the same name
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => apk.verifyApk(buf, entry, { keys: new Map([[k.name, other]]) }), /signature does not match/);
});

test('APKINDEX: signed index verifies and parses; a tampered or unknown-key index is refused (bug C)', () => {
  const k = testKeys();
  const a = pkg();
  const buf = signedIndex([a.entry, { P: 'linux-virt', V: '6.18.54-r0', S: '42100309', C: 'Q1abc=' }], k);
  const r = apk.readApkIndex(buf, k.keys);
  assert.strictEqual(r.keyName, k.name);
  assert.strictEqual(r.index.get('linux-virt').S, '42100309');
  assert.strictEqual(r.index.get('busybox-static').C, a.entry.C);
  const tampered = Buffer.from(buf);
  tampered[tampered.length - 30] ^= 1;
  assert.throws(() => apk.readApkIndex(tampered, k.keys));
  assert.throws(() => apk.verifyIndexBuffer(buf), /unknown key/, 'the bundled keys do not know the test key');
  // an index without a signature member
  const bare = gz(tar([{ name: 'APKINDEX', data: 'P:x\nV:1\n' }]));
  assert.throws(() => apk.verifyIndexBuffer(bare, k.keys), /no signature member/);
});

test('parseApkIndex, apkFileName, compareApkVersions', () => {
  const idx = apk.parseApkIndex('C:Q1abc=\nP:linux-virt\nV:6.18.54-r0\nS:42100309\n\nP:busybox-static\nV:1.37.0-r30\nS:640317\n');
  assert.strictEqual(idx.get('linux-virt').S, '42100309');
  assert.strictEqual(idx.get('busybox-static').V, '1.37.0-r30');
  assert.strictEqual(apk.apkFileName(idx.get('linux-virt')), 'linux-virt-6.18.54-r0.apk');
  assert.ok(apk.compareApkVersions('6.18.54-r0', '6.18.9-r3') > 0);
  assert.ok(apk.compareApkVersions('1.37.0-r30', '1.37.0-r4') > 0);
  assert.strictEqual(apk.compareApkVersions('1.0-r1', '1.0-r1'), 0);
});

test('the bundled Alpine keys: three x86_64 RSA public keys that load', () => {
  const keys = apk.loadKeys();
  assert.deepStrictEqual(Array.from(keys.keys()).sort(), [
    'alpine-devel@lists.alpinelinux.org-4a6a0840.rsa.pub',
    'alpine-devel@lists.alpinelinux.org-5261cecb.rsa.pub',
    'alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub',
  ]);
  for (const pem of keys.values()) assert.strictEqual(crypto.createPublicKey(pem).asymmetricKeyType, 'rsa');
});

// The packages the kernel setup downloaded earlier (data/kernel), read only
test('real cached packages verify by their Alpine signature and datahash alone (no index, no network)', { skip: !fs.existsSync(CACHED) && 'no cached kernel packages' }, () => {
  const files = fs.readdirSync(CACHED).filter((f) => /^(linux-virt|busybox-static)-.*\.apk$/.test(f));
  if (!files.length) return;
  for (const f of files) {
    const v = apk.verifyApk(fs.readFileSync(path.join(CACHED, f)), null);
    assert.strictEqual(v.signed, true, f);
    assert.match(v.signature.keyName, /^alpine-devel@lists\.alpinelinux\.org-[0-9a-f]{8}\.rsa\.pub$/);
  }
});
