'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packCopyIn, CopyInError, LIST_PATH } = require('../lib/microvm/copyin');
const { listCpio, checkInitramfs } = require('../lib/oci/cpio');

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-copyin-')); });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeTree(root) {
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho x\n');
  fs.writeFileSync(path.join(root, 'bin.elf'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'beta\n');
  fs.writeFileSync(path.join(root, 'sub', 'deeper', 'big.bin'), Buffer.alloc(300000, 7));
  fs.writeFileSync(path.join(root, 'ü-名前.txt'), 'unicode\n');
}

test('packCopyIn: contents at the target, parents first, list file last, modes by content on Windows', async () => {
  const src = path.join(tmp, 'site');
  makeTree(src);
  const out = path.join(tmp, 'ci1.cpio');
  const r = await packCopyIn([{ hostDir: src, target: '/srv/app' }], out, { platform: 'win32' });
  assert.strictEqual(r.files, 6);
  assert.strictEqual(r.dirs, 3);
  assert.strictEqual(r.bytes, 6 + 17 + 6 + 5 + 300000 + 8);
  assert.deepStrictEqual(r.targets, ['/srv/app']);
  const l = await listCpio(out, { keepData: 1 << 20 });
  assert.deepStrictEqual(checkInitramfs(l.entries).errors.filter((e) => !/parent/.test(e)), []);
  const names = l.entries.map((e) => e.name);
  assert.ok(!names.includes('srv/app') && !names.includes('srv'), 'the target itself is made by init, not the archive');
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('srv/app/sub') < idx('srv/app/sub/b.txt') && idx('srv/app/sub/deeper') < idx('srv/app/sub/deeper/big.bin'));
  assert.strictEqual(names[names.length - 1], LIST_PATH);
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  assert.strictEqual(by['srv/app/a.txt'].perm, 0o644);
  assert.strictEqual(by['srv/app/run.sh'].perm, 0o755, '#! scripts are executable');
  assert.strictEqual(by['srv/app/bin.elf'].perm, 0o755, 'ELF binaries are executable');
  assert.strictEqual(by['srv/app/sub'].perm, 0o755);
  assert.strictEqual(by['srv/app/empty'].type, 'dir');
  assert.strictEqual(by['srv/app/ü-名前.txt'].data.toString(), 'unicode\n');
  assert.strictEqual(by['srv/app/sub/deeper/big.bin'].size, 300000);
  assert.ok(l.entries.every((e) => e.uid === 0 && e.gid === 0));
  const list = by[LIST_PATH].data.toString().trim().split('\n');
  assert.strictEqual(list.length, 9);
  assert.ok(list.includes('srv/app/ü-名前.txt') && list.includes('srv/app/empty'));
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('ci1.cpio') && f.endsWith('.part')), [], 'no temp file left');
});

test('packCopyIn: several folders, later files win, limits and errors', async () => {
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'x'), 'from-a');
  fs.writeFileSync(path.join(b, 'y'), 'from-b');
  const out = path.join(tmp, 'ci2.cpio');
  const r = await packCopyIn([{ hostDir: a, target: '/one' }, { hostDir: b, target: '/two/' }], out);
  assert.deepStrictEqual(r.targets, ['/one', '/two']);
  const l = await listCpio(out, { keepData: 64 });
  assert.deepStrictEqual(l.entries.map((e) => e.name), ['one/x', 'two/y', LIST_PATH]);
  await assert.rejects(packCopyIn([{ hostDir: path.join(tmp, 'nope'), target: '/x' }], out), CopyInError);
  await assert.rejects(packCopyIn([{ hostDir: path.join(a, 'x'), target: '/x' }], out), /not a folder/);
  await assert.rejects(packCopyIn([{ hostDir: a, target: '/x' }, { hostDir: b, target: '/x' }], out), /two folders/);
  const big = path.join(tmp, 'big');
  fs.mkdirSync(big);
  fs.writeFileSync(path.join(big, 'f'), Buffer.alloc(2048));
  await assert.rejects(packCopyIn([{ hostDir: big, target: '/x' }], out, { maxBytes: 1024 }), /limit/);
  // an empty folder gives an archive with just the list
  const empty = path.join(tmp, 'emptydir');
  fs.mkdirSync(empty);
  const e = await packCopyIn([{ hostDir: empty, target: '/e' }], out);
  assert.strictEqual(e.entries, 0);
});

test('packCopyIn: relative symlinks kept, absolute ones skipped (when the host can make symlinks)', async (t) => {
  const d = path.join(tmp, 'links');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'target.txt'), 't');
  try {
    fs.symlinkSync('target.txt', path.join(d, 'rel'), 'file');
    fs.symlinkSync(path.join(d, 'target.txt'), path.join(d, 'abs'), 'file');
  } catch (e) {
    t.skip('cannot create symlinks here (' + e.code + ')');
    return;
  }
  const out = path.join(tmp, 'ci3.cpio');
  const r = await packCopyIn([{ hostDir: d, target: '/l' }], out);
  assert.strictEqual(r.symlinks, 1);
  assert.ok(r.skipped.some((s) => /abs$/.test(s.path) && /absolute/.test(s.reason)));
  const l = await listCpio(out, { keepData: 64 });
  const rel = l.entries.find((e) => e.name === 'l/rel');
  assert.strictEqual(rel.type, 'symlink');
  assert.strictEqual(rel.data.toString(), 'target.txt');
});
