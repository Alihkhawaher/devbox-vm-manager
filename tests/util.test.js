'use strict';
/*
 * lib/util.js: log tails that read only the end of a file (SEC-11), shell
 * quoting, validators, strict number parsing, atomic writes, log rotation,
 * bounded output capture and run().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const u = require('../lib/util');
const { rm } = require('./helpers');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-util-')); }

test('tailFile: last N lines, missing file, CRLF, partial first line dropped', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'a.log');
    assert.deepEqual(u.tailFile(f).exists, false);
    fs.writeFileSync(f, 'one\r\ntwo\r\nthree\r\n');
    const r = u.tailFile(f, { lines: 2 });
    assert.equal(r.text, 'two\nthree');
    assert.equal(r.lineCount, 2);
    assert.equal(r.truncated, true);
    assert.equal(u.tailFile(f, { lines: 10 }).truncated, false);
    // NaN / 0 / negative tails never return the whole file (SEC-11)
    assert.equal(u.tailFile(f, { lines: NaN }).lineCount, 3);
    assert.equal(u.tailFile(f, { lines: 0 }).lineCount, 1);
    assert.equal(u.tailFile(f, { lines: -5 }).lineCount, 1);
  } finally { rm(d); }
});

test('tailFile exact: a program\'s output byte for byte (final newline and CRs kept)', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'out.log');
    fs.writeFileSync(f, 'hi\n');
    assert.equal(u.tailFile(f, { exact: true }).text, 'hi\n');
    assert.equal(u.tailFile(f).text, 'hi', 'the default (task and VM logs) is unchanged');
    fs.writeFileSync(f, 'a\r\nb');
    assert.equal(u.tailFile(f, { exact: true }).text, 'a\r\nb');
    fs.writeFileSync(f, 'one\ntwo\nthree\n');
    assert.equal(u.tailFile(f, { exact: true, lines: 2 }).text, 'two\nthree\n');
    fs.writeFileSync(f, '');
    assert.equal(u.tailFile(f, { exact: true }).text, '');
    fs.writeFileSync(f, '\n');
    assert.equal(u.tailFile(f, { exact: true }).text, '\n');
  } finally { rm(d); }
});

test('tailFile: reads only the last maxBytes of a big file', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'big.log');
    const line = 'x'.repeat(99) + '\n';
    fs.writeFileSync(f, 'FIRST LINE\n' + line.repeat(40000) + 'LAST LINE\n'); // ~4 MB
    const r = u.tailFile(f, { lines: 5000, maxBytes: 64 * 1024 });
    assert.ok(r.text.length <= 64 * 1024);
    assert.ok(r.text.endsWith('LAST LINE'));
    assert.equal(r.text.indexOf('FIRST LINE'), -1);
    assert.ok(!/^x{1,98}\n/.test(r.text) || r.text.startsWith('x'.repeat(99)), 'no partial first line');
    assert.equal(r.truncated, true);
    assert.equal(r.size, fs.statSync(f).size);
  } finally { rm(d); }
});

test('shq: survives quotes, $(), backticks, newlines and empty values in a real POSIX shell', () => {
  const samples = ["it's", '$(rm -rf /)', '`id`', 'a b\nc', '', '"double"', "''", '\\'];
  for (const s of samples) assert.ok(u.shq(s).startsWith("'") && u.shq(s).endsWith("'"));
  assert.equal(u.shq("it's"), "'it'\\''s'");
  assert.equal(u.shq(null), "''");
  // round-trip through sh when one is available (Git Bash on Windows, /bin/sh elsewhere)
  let sh = null;
  for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) { if (fs.existsSync(c)) { sh = c; break; } }
  if (!sh) return;
  for (const s of samples) {
    const out = execFileSync(sh, ['-c', 'printf %s ' + u.shq(s)], { encoding: 'utf8', windowsHide: true });
    assert.equal(out, s);
  }
});

test('vmNameError / isVmName: plain names only, no dots-only, no Windows device names', () => {
  for (const ok of ['web', 'web-01', 'My_VM.2', 'a', 'x'.repeat(63)]) assert.equal(u.vmNameError(ok), null, ok);
  for (const bad of [undefined, null, '', ' ', '.', '..', '-x', '_x', 'a b', 'a/b', 'a\\b', 'x'.repeat(64),
    'con', 'CON', 'nul', 'com1', 'lpt9', 'aux.txt', 'name.', 42, {}]) {
    assert.notEqual(u.vmNameError(bad), null, JSON.stringify(bad));
    assert.equal(u.isVmName(bad), false);
  }
});

test('guest-side validators', () => {
  assert.equal(u.isContainerName('nginx'), true);
  assert.equal(u.isContainerName('a1b2c3d4e5f6'), true);
  for (const bad of ['.', '..', '-rm', 'a b', 'a;b', '', null]) assert.equal(u.isContainerName(bad), false, String(bad));
  for (const ok of ['nginx', 'nginx:alpine', 'ghcr.io/org/app:1.2', 'img@sha256:abc123', 'localhost:5000/x']) assert.equal(u.isImageRef(ok), true, ok);
  for (const bad of ['', '-x', 'a b', 'a;rm', '$(id)', ':latest']) assert.equal(u.isImageRef(bad), false, bad);
  assert.equal(u.isComposeProject('my-app_1'), true);
  for (const bad of ['..', 'App', '-a', '', 'a b']) assert.equal(u.isComposeProject(bad), false, bad);
});

test('safeName: sanitises derived names; missing values give ""', () => {
  assert.equal(u.safeName('my vm'), 'my_vm');
  assert.equal(u.safeName('a/b\\c:d'), 'a_b_c_d');
  assert.equal(u.safeName(undefined), '');
  assert.equal(u.safeName(null), '');
  assert.equal(u.safeName(42), '42');
});

test('toInt / clampInt / intInRange / toBool / toList never produce NaN', () => {
  assert.equal(u.toInt(5), 5);
  assert.equal(u.toInt(' 12 '), 12);
  for (const bad of ['12abc', 1.5, NaN, true, null, undefined, '', '1e3']) assert.equal(u.toInt(bad), null, String(bad));
  assert.equal(u.clampInt('abc', 1, 10, 3), 3);
  assert.equal(u.clampInt('99', 1, 10, 3), 10);
  assert.equal(u.clampInt(-4, 1, 10, 3), 1);
  assert.equal(u.intInRange(undefined, 1, 10, 7, 'x'), 7);
  assert.equal(u.intInRange('4', 1, 10, 7, 'x'), 4);
  assert.throws(() => u.intInRange('40', 1, 10, 7, 'Memory'), (e) => e.status === 400 && /Memory must be a whole number between 1 and 10/.test(e.message));
  assert.throws(() => u.intInRange('abc', 1, 10, 7, 'x'), (e) => e.status === 400);
  assert.equal(u.toBool(undefined, true), true);
  assert.equal(u.toBool('false', true), false);
  assert.equal(u.toBool(1, false), true);
  assert.throws(() => u.toBool('maybe', false), (e) => e.status === 400);
  assert.deepEqual(u.toList('A=1,2\nB=3\n\n'), ['A=1,2', 'B=3'], 'commas inside values are kept');
  assert.deepEqual(u.toList(['x', ' y ', '']), ['x', 'y']);
  assert.deepEqual(u.toList(undefined), []);
  assert.throws(() => u.toList(5), (e) => e.status === 400);
});

test('ApiError helpers carry status and code', () => {
  assert.equal(u.badRequest('x').status, 400);
  assert.equal(u.notFound('x').status, 404);
  assert.equal(u.conflict('x').status, 409);
  const ni = u.notImplemented('Snapshots');
  assert.equal(ni.status, 501);
  assert.equal(ni.code, 'NOT_IMPLEMENTED');
  assert.match(ni.message, /Snapshots is not implemented yet/);
});

test('atomicWriteFileSync: replaces the file, leaves no .tmp behind', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'vms.json');
    u.atomicWriteFileSync(f, 'one');
    u.atomicWriteFileSync(f, 'two');
    assert.equal(fs.readFileSync(f, 'utf8'), 'two');
    assert.equal(fs.existsSync(f + '.tmp'), false);
  } finally { rm(d); }
});

test('appendRotating: keeps the file under the cap by rotating to .1', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'logs', 'x.log');
    for (let i = 0; i < 50; i++) u.appendRotating(f, 'line ' + i + ' ' + 'y'.repeat(80) + '\n', 1000);
    assert.ok(fs.statSync(f).size <= 1000);
    assert.ok(fs.existsSync(f + '.1'));
    assert.ok(fs.statSync(f + '.1').size <= 1000);
    assert.match(fs.readFileSync(f, 'utf8'), /line 49 /);
  } finally { rm(d); }
});

test('OutputCapture keeps head and tail of huge output and says so', () => {
  const c = new u.OutputCapture(2000, 0.2);
  c.push('HEAD-' + 'a'.repeat(1000));
  for (let i = 0; i < 100; i++) c.push('b'.repeat(100));
  c.push('-TAIL');
  const t = c.text();
  assert.ok(t.startsWith('HEAD-'));
  assert.ok(t.endsWith('-TAIL'));
  assert.equal(c.truncated, true);
  assert.match(t, /bytes omitted/);
  const small = new u.OutputCapture(2000);
  small.push('hello');
  assert.equal(small.text(), 'hello');
  assert.equal(small.truncated, false);
});

test('run(): exit codes, missing program = 127, never rejects', async () => {
  const ok = await u.run(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, 'hi');
  const bad = await u.run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(bad.code, 3);
  const missing = await u.run(path.join(os.tmpdir(), 'no-such-program-xyz'), []);
  assert.equal(missing.code, 127);
  const none = await u.run(null, []);
  assert.equal(none.code, 127);
});

test('probeSsh / portListening: false for a closed port, true for a fake sshd', async () => {
  const net = require('net');
  const srv = net.createServer((s) => { s.on('error', () => {}); s.write('SSH-2.0-OpenSSH_9.9\r\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await u.probeSsh(port, 1500), true);
    assert.equal(await u.portListening(port, 1000), true);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(await u.probeSsh(port, 800), false);
  assert.equal(await u.portListening(port, 800), false);
});
