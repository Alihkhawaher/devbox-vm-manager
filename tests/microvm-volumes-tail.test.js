'use strict';
/*
 * Named volumes (host-formatted ext4 in a sparse qcow2) and the file tail
 * the engine follows QEMU's logs with.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const volumes = require('../lib/microvm/volumes');
const { FileTail, LineSplitter } = require('../lib/microvm/tail');
const { readQcow2At } = require('../lib/microvm/qcow2');
const { parseSuperblock } = require('../lib/microvm/mkext4');

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-vols-')); });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('volumes: create an ext4 qcow2 once, list, reuse, remove; names checked', () => {
  const dir = path.join(tmp, 'vols');
  const a = volumes.ensureVolume(dir, 'Data', { sizeBytes: 64 * 1048576 });
  assert.strictEqual(a.created, true);
  assert.strictEqual(path.basename(a.file), 'data.qcow2', 'lower-cased: NTFS is case-insensitive');
  const sb = parseSuperblock(readQcow2At(a.file, 1024, 1024));
  assert.strictEqual(sb.magic, 0xef53);
  const b = volumes.ensureVolume(dir, 'data', { sizeBytes: 999 * 1048576 });
  assert.strictEqual(b.created, false);
  assert.strictEqual(b.sizeBytes, 64 * 1048576, 'an existing volume keeps its size');
  const list = volumes.listVolumes(dir);
  assert.deepStrictEqual(list.map((v) => [v.name, v.virtualBytes]), [['data', 64 * 1048576]]);
  assert.ok(list[0].fileBytes < 4 * 1048576, 'sparse');
  volumes.removeVolume(dir, 'DATA');
  assert.deepStrictEqual(volumes.listVolumes(dir), []);
  for (const bad of ['', '../x', 'a/b', 'con', 'NUL.txt', '-x', 'x'.repeat(65)]) assert.throws(() => volumes.volumeFile(dir, bad), /volume name/, bad);
  assert.throws(() => volumes.ensureVolume(dir, 'tiny', { sizeBytes: 1048576 }), /at least/);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.part')));
});

test('FileTail follows a growing file (created late); LineSplitter keeps partial lines', async () => {
  const f = path.join(tmp, 'grow.log');
  const got = [];
  const t = new FileTail(f, (b) => got.push(b.toString()), { intervalMs: 5 }).start();
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(f, 'one\ntw');
  await new Promise((r) => setTimeout(r, 40));
  fs.appendFileSync(f, 'o\n' + 'x'.repeat(200000));
  await new Promise((r) => setTimeout(r, 40));
  t.stop();
  assert.strictEqual(got.join(''), 'one\ntwo\n' + 'x'.repeat(200000));
  assert.strictEqual(t.bytes, 8 + 200000);
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l), { maxLine: 10 });
  s.push(Buffer.from('a\r\nb'));
  s.push(Buffer.from('c\n0123456789ABC'));
  s.flush();
  assert.deepStrictEqual(lines, ['a', 'bc', '0123456789'], 'an over-long line is cut (guest output is untrusted)');
});
