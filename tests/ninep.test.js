'use strict';
/*
 * lib/ninep/server.js + tests/helpers/ninep-client.js: every 9P2000.L message, readdir paging,
 * a 50 MB integrity round trip, renames, concurrent tags and flush, framing
 * abuse, auth failures, read-only shares, jail escapes and resource limits.
 *
 * Servers listen on 127.0.0.1 on OS-assigned ports (port 0).
 */
const test = require('node:test');
const { before, after } = require('node:test'); // named hook exports exist since Node 18.8
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { createServer, validateName, OUTSIDE_LINK, generateSecret, mountCommand } = require('../lib/ninep/server');
const { NinepClient } = require('./helpers/ninep-client');
const P = require('../lib/ninep/proto');

const { L, QT, DT, T, ERRNO } = P;
const IS_WIN = process.platform === 'win32';
const TMP = path.join(os.tmpdir(), 'devbox-ninep-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const servers = [];
const clients = [];

// port 0: the OS picks a free port (unit tests never use fixed ports)
async function startServer(opts) {
  const s = await createServer(Object.assign({ port: 0 }, opts || {}));
  servers.push(s);
  return s;
}

async function errCode(p, code) {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, 'expected ' + code + ', got ' + e.code + ': ' + e.message);
    return true;
  });
}

function populate(root, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(root, ...rel.split('/'));
    if (rel.endsWith('/')) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

let srv;
let seq = 0;

// A fresh share (own root dir) on `server`, plus a versioned+attached client (fid 0 = root).
async function setup(o) {
  o = o || {};
  const server = o.server || srv;
  const id = 's' + (++seq);
  const root = path.join(TMP, id);
  fs.mkdirSync(root, { recursive: true });
  populate(root, o.files);
  const secret = 'sec-' + crypto.randomBytes(12).toString('hex');
  server.addShare({ id, root, secret, readOnly: !!o.readOnly, uid: o.uid, gid: o.gid, syncMetadata: o.syncMetadata });
  const c = await NinepClient.connect({ port: server.port });
  clients.push(c);
  await c.version(o.msize || 512 * 1024);
  await c.attach(0, id + ':' + secret);
  c.nextFidNo = 100;
  return {
    id, root, secret, c, server, aname: id + ':' + secret,
    p: (...a) => path.join(root, ...a),
    async walk(names) { const fid = c.newFid(); const q = await c.walk(0, fid, names); assert.equal(q.length, names.length, 'walk ' + names.join('/')); return fid; },
    async open(names, flags) { const fid = await this.walk(names); await c.lopen(fid, flags || 0); return fid; },
    async done() { await c.destroy(); server.removeShare(id); },
  };
}

before(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  srv = await startServer({});
});

after(async () => {
  for (const c of clients) await c.destroy();
  for (const s of servers) await s.close(); // also the ones a failed test left behind
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ------------------------------------------------------------------------

test('validateName: jail rules for single path components', () => {
  for (const ok of ['a', 'file.txt', '.hidden', 'x y', 'naïve-日本', 'a'.repeat(255), 'con-file', 'console', 'CONx.txt', '...a']) {
    assert.equal(validateName(ok), 0, ok);
  }
  for (const bad of ['', '.', '..', 'a/b', 'a\0b']) assert.notEqual(validateName(bad), 0, JSON.stringify(bad));
  assert.equal(validateName('a'.repeat(256)), ERRNO.ENAMETOOLONG);
  if (IS_WIN) {
    for (const bad of ['a\\b', 'a:b', 'file.txt:secret', 'CON', 'con', 'PRN.txt', 'aux.tar.gz', 'NUL', 'nul .txt', 'COM1', 'com9.log', 'LPT1', 'lpt9.x',
      'COM\u00b9', 'trail.', 'trail ', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'tab\tname', 'CONIN$']) {
      assert.notEqual(validateName(bad), 0, JSON.stringify(bad));
    }
  }
});

test('helpers: secrets and mount command', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Za-z0-9_-]{32}$/);
  const cmd = mountCommand({ port: 19501, share: { id: 'proj', secret: s }, mountPoint: '/mnt/proj' });
  assert.equal(cmd, 'mount -t 9p -o trans=tcp,port=19501,version=9p2000.L,aname=proj:' + s + ',msize=524288,cache=mmap 10.0.2.2 /mnt/proj');
});

test('createServer refuses non-loopback hosts and validates shares', async () => {
  await assert.rejects(createServer({ host: '0.0.0.0', port: 0 }), /loopback/);
  const root = path.join(TMP, 'val');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'f'), 'x');
  const good = { id: 'v1', root, secret: 'x'.repeat(16) };
  assert.throws(() => srv.addShare(Object.assign({}, good, { id: 'bad id!' })), /share id/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { secret: 'short' })), /secret/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { secret: 'has:colon-1234567890' })), /secret/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { secret: 'has,comma-1234567890' })), /secret/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { root: 'relative/dir' })), /absolute/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { root: path.join(root, 'f') })), /not a directory/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { root: path.join(root, 'missing') })), /ENOENT/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { uid: -1 })), /uid/);
  srv.addShare(good);
  assert.throws(() => srv.addShare(Object.assign({}, good, { secret: 'y'.repeat(16) })), /already exists/);
  assert.throws(() => srv.addShare(Object.assign({}, good, { id: 'v2' })), /unique/);
  assert.equal(srv.removeShare('v1'), true);
  assert.equal(srv.removeShare('v1'), false);
});

test('Tversion: msize negotiation, unknown versions, messages before Tversion', async () => {
  const s = await setup();
  const c = await NinepClient.connect({ port: srv.port });
  await errCode(c.rpc(T.Tstatfs, (w) => w.u32(0)), 'EPROTO');
  assert.deepEqual(await c.version(4 * 1024 * 1024), { msize: 1024 * 1024, version: '9P2000.L' });
  assert.equal((await c.version(65536, '9P2000.u')).version, 'unknown');
  assert.equal((await c.version(1024)).version, 'unknown');
  await errCode(c.attach(0, s.aname), 'EPROTO'); // not versioned any more
  assert.deepEqual(await c.version(65536), { msize: 65536, version: '9P2000.L' });
  await c.attach(0, s.aname);
  // a second Tversion resets the session: fids are gone
  await c.version(65536);
  await errCode(c.getattr(0), 'EBADF');
  await c.attach(0, s.aname);
  await c.getattr(0);
  await c.destroy();
  await s.done();
});

test('Tattach: id:secret and secret-only succeed; wrong secrets, unknown ids and auth fids fail', async () => {
  const a = await setup();
  const b = await setup();
  const c = await NinepClient.connect({ port: srv.port });
  await c.version(65536);
  await c.attach(1, a.aname);
  await c.attach(2, a.secret); // secret only
  await c.attach(3, b.aname); // two shares on one connection
  await errCode(c.attach(1, a.aname), 'EINVAL'); // fid in use
  await errCode(c.attach(4, a.aname, { afid: 9 }), 'EINVAL');
  await errCode(c.auth(9, 'root', a.aname, 0), 'EOPNOTSUPP');
  await errCode(c.attach(5, a.id + ':' + b.secret), 'EACCES'); // right secret, wrong share
  assert.equal(c.closed, false);
  // attaching fid 3 through share b sees b's root, not a's
  fs.writeFileSync(b.p('only-in-b.txt'), 'b');
  assert.equal((await c.walk(3, 6, ['only-in-b.txt'])).length, 1);
  await errCode(c.walk(1, 7, ['only-in-b.txt']), 'ENOENT');
  await c.destroy();

  // three failures close the connection
  const d = await NinepClient.connect({ port: srv.port });
  await d.version(65536);
  const before = srv.stats().counters.authFailures;
  await errCode(d.attach(1, a.id + ':wrong-secret-000000000'), 'EACCES');
  await errCode(d.attach(1, 'nosuchshare:' + a.secret), 'EACCES');
  await errCode(d.attach(1, 'x'.repeat(1000)), 'EACCES');
  await d.closedPromise;
  assert.equal(d.closed, true);
  assert.equal(srv.stats().counters.authFailures - before, 3);
  await a.done();
  await b.done();
});

test('pre-auth timeout closes connections that never attach; idle attached ones stay', async () => {
  const s2 = await startServer({ preAuthTimeoutMs: 150 });
  const root = path.join(TMP, 'preauth');
  fs.mkdirSync(root, { recursive: true });
  s2.addShare({ id: 'p', root, secret: 'preauth-secret-123456' });
  const idle = await NinepClient.connect({ port: s2.port });
  const t0 = Date.now();
  await idle.closedPromise;
  assert.ok(Date.now() - t0 < 2000);
  const ok = await NinepClient.connect({ port: s2.port });
  await ok.version(65536);
  await ok.attach(0, 'p:preauth-secret-123456');
  await sleep(400);
  assert.equal(ok.closed, false);
  await ok.getattr(0);
  await ok.destroy();
  await s2.close();
});

test('Twalk: clone, multi-element, partial walks, errors and ".." clamped at the share root', async () => {
  const s = await setup({ files: { 'a/b/c.txt': 'c', 'top.txt': 't' } });
  const { c } = s;
  const rootQid = (await c.getattr(0)).qid;
  // clone
  await c.walk(0, 1, []);
  assert.deepEqual((await c.getattr(1)).qid, rootQid);
  // multi-element
  const q = await c.walk(0, 2, ['a', 'b', 'c.txt']);
  assert.equal(q.length, 3);
  assert.equal(q[0].type, QT.DIR);
  assert.equal(q[2].type, QT.FILE);
  assert.equal((await c.getattr(2)).size, 1);
  // partial: returns the qids that worked, newfid not created
  const part = await c.walk(0, 3, ['a', 'missing', 'x']);
  assert.equal(part.length, 1);
  await errCode(c.getattr(3), 'EBADF');
  // first element missing -> error
  await errCode(c.walk(0, 3, ['nope']), 'ENOENT');
  // cannot walk through a file
  assert.equal((await c.walk(0, 3, ['top.txt', 'x'])).length, 1);
  await errCode(c.walk(2, 3, ['x']), 'ENOTDIR');
  // limits and fid rules
  await errCode(c.walk(0, 3, Array(17).fill('a')), 'EINVAL');
  await errCode(c.walk(0, 2, ['a']), 'EINVAL'); // newfid in use
  await errCode(c.walk(99, 3, ['a']), 'EBADF');
  // ".." never leaves the share
  const up = await c.walk(0, 4, ['..', '..', '..']);
  assert.deepEqual(up[2], rootQid);
  const updown = await c.walk(0, 5, ['a', 'b', '..', '..', '..', 'top.txt']);
  assert.equal(updown.length, 6);
  assert.equal((await c.getattr(5)).size, 1);
  // newfid == fid moves the fid
  await c.walk(0, 6, ['a']);
  await c.walk(6, 6, ['b']);
  assert.equal((await c.getattr(6)).qid.path, q[1].path);
  await s.done();
});

test('Twalk rejects names the host cannot address safely (ADS, device names, separators, bad UTF-8)', async () => {
  const s = await setup({ files: { 'data.txt': 'data', 'sub/x': 'x' } });
  const { c } = s;
  const bad = ['sub/x', '', '.', 'a\0'];
  if (IS_WIN) bad.push('sub\\x', 'data.txt:hidden', 'data.txt::$DATA', 'CON', 'nul', 'NUL.txt', 'com1', 'LPT9.log', 'data.txt.', 'data.txt ', 'C:', 'AUX');
  for (const n of bad) await errCode(c.walk(0, 50, [n]), 'ENOENT');
  await errCode(c.walk(0, 50, ['a'.repeat(256)]), 'ENAMETOOLONG');
  // invalid UTF-8 on the wire
  const w = new P.Writer(T.Twalk, 77, 64);
  w.u32(0).u32(51).u16(1).u16(2).bytes(Buffer.from([0xc3, 0x28]));
  const got = new Promise((resolve) => c.on('frame', (f) => { if (f.tag === 77) resolve(f); }));
  c.rawSend(w.finish());
  const f = await got;
  assert.equal(f.type, T.Rlerror);
  assert.equal(f.frame.readUInt32LE(7), ERRNO.ENOENT);
  await s.done();
});

test('files: Tlcreate/Twrite/Tread/Tgetattr/Tclunk and live two-way visibility', async () => {
  const s = await setup({ files: { 'host.txt': 'from host' } });
  const { c } = s;
  // guest creates and writes; host sees it immediately
  const f = await s.walk([]);
  const cr = await c.lcreate(f, 'guest.txt', L.O_RDWR | L.O_CREAT, 0o644);
  assert.equal(cr.qid.type, QT.FILE);
  assert.equal(await c.write(f, 0, Buffer.from('hello')), 5);
  assert.equal(fs.readFileSync(s.p('guest.txt'), 'utf8'), 'hello');
  assert.equal(await c.write(f, 5, Buffer.from(' world')), 6);
  assert.equal(fs.readFileSync(s.p('guest.txt'), 'utf8'), 'hello world');
  assert.equal((await c.read(f, 6, 100)).toString(), 'world');
  assert.equal((await c.getattr(f)).size, 11);
  await c.clunk(f);
  await errCode(c.getattr(f), 'EBADF');
  // host changes a file; the guest sees the new content and size right away
  const h = await s.open(['host.txt'], L.O_RDONLY);
  assert.equal((await c.read(h, 0, 100)).toString(), 'from host');
  fs.writeFileSync(s.p('host.txt'), 'changed on the host!');
  assert.equal((await c.read(h, 0, 100)).toString(), 'changed on the host!');
  assert.equal((await c.getattr(h)).size, 20);
  fs.appendFileSync(s.p('host.txt'), '+');
  const h2 = await s.walk(['host.txt']);
  assert.equal((await c.getattr(h2)).size, 21);
  // open rules
  await errCode(c.lopen(h, L.O_RDONLY), 'EINVAL'); // already open
  await errCode(c.write(h, 0, Buffer.from('x')), 'EBADF'); // opened read-only
  const unopened = await s.walk(['host.txt']);
  await errCode(c.read(unopened, 0, 10), 'EBADF');
  const d = await s.walk([]);
  await errCode(c.lopen(d, L.O_WRONLY), 'EISDIR');
  await c.lopen(d, L.O_RDONLY | L.O_DIRECTORY);
  await errCode(c.read(d, 0, 10), 'EISDIR');
  await errCode(c.lopen(h2, L.O_RDONLY | L.O_DIRECTORY), 'ENOTDIR');
  // O_TRUNC and O_APPEND
  const t = await s.open(['host.txt'], L.O_WRONLY | L.O_TRUNC);
  assert.equal(fs.statSync(s.p('host.txt')).size, 0);
  await c.write(t, 0, Buffer.from('abc'));
  const a = await s.open(['host.txt'], L.O_WRONLY | L.O_APPEND);
  await c.write(a, 0, Buffer.from('XYZ')); // offset ignored in append mode
  assert.equal(fs.readFileSync(s.p('host.txt'), 'utf8'), 'abcXYZ');
  // Tlcreate rules
  const e = await s.walk([]);
  await errCode(c.lcreate(e, 'host.txt', L.O_RDWR | L.O_CREAT | L.O_EXCL), 'EEXIST');
  await c.lcreate(e, 'host.txt', L.O_RDWR | L.O_CREAT); // no O_EXCL: opens the existing file, no truncation
  assert.equal((await c.read(e, 0, 100)).toString(), 'abcXYZ');
  await errCode(c.lcreate(e, 'more.txt', L.O_RDWR | L.O_CREAT), 'EINVAL'); // fid already open
  await errCode(c.lcreate(h2, 'x.txt', L.O_RDWR | L.O_CREAT), 'ENOTDIR');
  const bad = await s.walk([]);
  for (const n of ['a/b', '..', '.', '']) await errCode(c.lcreate(bad, n, L.O_RDWR | L.O_CREAT), 'EINVAL');
  if (IS_WIN) for (const n of ['x:ads', 'NUL', 'com1.txt', 'dot.', 'sp ', 'q?']) await errCode(c.lcreate(bad, n, L.O_RDWR | L.O_CREAT), 'EINVAL');
  // read past EOF and zero-length reads
  assert.equal((await c.read(e, 1000, 10)).length, 0);
  assert.equal((await c.read(e, 0, 0)).length, 0);
  await s.done();
});

test('big file: 50 MB written and read back through 9P with matching sha256', async () => {
  const s = await setup({ msize: 1024 * 1024 });
  const { c } = s;
  const data = crypto.randomBytes(50 * 1024 * 1024);
  const want = sha(data);
  const f = await s.walk([]);
  await c.lcreate(f, 'big.bin', L.O_WRONLY | L.O_CREAT | L.O_TRUNC, 0o644);
  let t0 = Date.now();
  await c.writeAll(f, data, 0, 4);
  const wms = Date.now() - t0;
  await c.fsync(f);
  await c.clunk(f);
  assert.equal(fs.statSync(s.p('big.bin')).size, data.length);
  assert.equal(sha(fs.readFileSync(s.p('big.bin'))), want);
  const r = await s.open(['big.bin'], L.O_RDONLY);
  assert.equal((await c.getattr(r)).size, data.length);
  t0 = Date.now();
  const back = await c.readAll(r, data.length, 4);
  const rms = Date.now() - t0;
  assert.equal(sha(back), want);
  // sequential single-request reads too (what a simple reader does)
  const seqBack = await c.readAll(r);
  assert.equal(sha(seqBack), want);
  console.log('# 50 MB write ' + wms + ' ms (' + (50000 / wms).toFixed(0) + ' MB/s), read ' + rms + ' ms (' + (50000 / rms).toFixed(0) + ' MB/s)');
  await c.clunk(r);
  fs.rmSync(s.p('big.bin'));
  await s.done();
});

test('Treaddir: paging with tiny counts, stable offsets while the directory changes, rewind', async () => {
  const files = {};
  for (let i = 0; i < 300; i++) files['f' + String(i).padStart(4, '0') + '.txt'] = 'x';
  files['sub1/'] = null;
  files['sub2/inner.txt'] = 'i';
  const s = await setup({ files });
  const { c } = s;
  // names the guest could not address are hidden
  if (IS_WIN) { fs.writeFileSync(s.p('nul.txt'), 'dev'); fs.writeFileSync(s.p('trail.'), 'x'); }
  await errCode(c.readdir(0, 0, 4096), 'EBADF'); // not opened
  const d = await s.open([], L.O_RDONLY | L.O_DIRECTORY);
  const seen = [];
  let off = 0n;
  let pages = 0;
  let prevOff = 0n;
  for (;;) {
    const page = await c.readdir(d, off, 200); // ~5 entries per page
    if (!page.length) break;
    pages++;
    for (const e of page) {
      assert.ok(e.offset > prevOff, 'offsets increase');
      prevOff = e.offset;
      seen.push(e);
    }
    off = page[page.length - 1].offset;
    if (pages === 10) { // mutate mid-listing: must not duplicate or skip existing entries
      fs.writeFileSync(s.p('zz-new.txt'), 'n');
      fs.rmSync(s.p('f0299.txt'));
    }
  }
  assert.ok(pages >= 40, pages + " pages");
  const names = seen.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.equal(names[0], '.');
  assert.equal(names[1], '..');
  for (let i = 0; i < 299; i++) assert.ok(names.includes('f' + String(i).padStart(4, '0') + '.txt'));
  assert.ok(!names.includes('zz-new.txt'), 'snapshot taken at offset 0');
  assert.ok(!names.includes('nul.txt') && !names.includes('trail.'));
  const byName = Object.fromEntries(seen.map((e) => [e.name, e]));
  assert.equal(byName.sub1.type, DT.DIR);
  assert.equal(byName['f0001.txt'].type, DT.REG);
  assert.equal(byName['.'].qid.path, (await c.getattr(0)).qid.path);
  assert.equal(byName['..'].qid.path, (await c.getattr(0)).qid.path); // ".." of the share root is the root
  const wq = await c.walk(0, 60, ['sub2']);
  assert.equal(byName.sub2.qid.path, wq[0].path, 'readdir qid == walk qid');
  // offset 0 rewinds and re-reads
  const again = (await c.readdirAll(d, 65536)).map((e) => e.name);
  assert.ok(again.includes('zz-new.txt'));
  assert.ok(!again.includes('f0299.txt'));
  // resuming from any cookie gives the same tail
  const all = await c.readdirAll(d, 65536);
  const mid = all[100].offset;
  const tail = [];
  for (let o = mid; ;) { const pg = await c.readdir(d, o, 1000); if (!pg.length) break; tail.push(...pg.map((e) => e.name)); o = pg[pg.length - 1].offset; }
  assert.deepEqual(tail, all.slice(101).map((e) => e.name));
  // past the end
  assert.equal((await c.readdir(d, 1000000n, 4096)).length, 0);
  // readdir of a subdirectory: ".." is the parent
  const sd = await s.open(['sub2'], L.O_RDONLY);
  const sub = await c.readdirAll(sd);
  assert.deepEqual(sub.map((e) => e.name).sort(), ['.', '..', 'inner.txt']);
  assert.equal(sub.find((e) => e.name === '..').qid.path, (await c.getattr(0)).qid.path);
  // too small for one entry -> empty page (EOF), not an error
  assert.equal((await c.readdir(d, 0n, 10)).length, 0);
  await s.done();
});

test('Tmkdir, Tunlinkat, Tremove: Linux semantics', async () => {
  const s = await setup({ files: { 'f.txt': 'f', 'full/x': 'x', 'empty/': null } });
  const { c } = s;
  const q = await c.mkdir(0, 'newdir', 0o755);
  assert.equal(q.type, QT.DIR);
  assert.ok(fs.statSync(s.p('newdir')).isDirectory());
  await errCode(c.mkdir(0, 'newdir'), 'EEXIST');
  await errCode(c.mkdir(0, '..'), 'EINVAL');
  const file = await s.walk(['f.txt']);
  await errCode(c.mkdir(file, 'x'), 'ENOTDIR');
  await errCode(c.unlinkat(0, 'newdir', 0), 'EISDIR');
  await errCode(c.unlinkat(0, 'f.txt', P.AT_REMOVEDIR), 'ENOTDIR');
  await errCode(c.unlinkat(0, 'full', P.AT_REMOVEDIR), 'ENOTEMPTY');
  await errCode(c.unlinkat(0, 'missing', 0), 'ENOENT');
  await c.unlinkat(0, 'newdir', P.AT_REMOVEDIR);
  assert.ok(!fs.existsSync(s.p('newdir')));
  // unlinking an open file: the name goes, the open fid keeps working (POSIX)
  const open = await s.open(['f.txt'], L.O_RDONLY);
  await c.unlinkat(0, 'f.txt', 0);
  assert.ok(!fs.existsSync(s.p('f.txt')));
  assert.equal((await c.read(open, 0, 10)).toString(), 'f');
  assert.equal((await c.getattr(open)).size, 1);
  // the unopened fid of the unlinked file must not alias a new file with the same name
  fs.writeFileSync(s.p('f.txt'), 'a different file');
  await errCode(c.getattr(file), 'ENOENT');
  // Tremove: removes and clunks, even on failure
  const e = await s.walk(['empty']);
  await c.remove(e);
  assert.ok(!fs.existsSync(s.p('empty')));
  await errCode(c.getattr(e), 'EBADF');
  const full = await s.walk(['full']);
  await errCode(c.remove(full), 'ENOTEMPTY');
  await errCode(c.getattr(full), 'EBADF');
  const r = await s.walk([]);
  await errCode(c.remove(r), 'EBUSY');
  await errCode(c.getattr(r), 'EBADF');
  const x = await s.walk(['full', 'x']);
  await c.remove(x);
  assert.deepEqual(fs.readdirSync(s.p('full')), []);
  await s.done();
});

test('Trenameat/Trename: across directories, POSIX replacement rules, open and read-only targets', async () => {
  const s = await setup({ files: { 'a/f.txt': 'F', 'b/': null, 'src.txt': 'SRC', 'dst.txt': 'DST', 'ro.txt': 'RO', 'open.txt': 'OPEN',
    'd1/': null, 'd2/': null, 'd3/x': 'x', 'plain.txt': 'p', 'deep/in/most.txt': 'm' } });
  const { c } = s;
  const a = await s.walk(['a']);
  const b = await s.walk(['b']);
  // across directories
  await c.renameat(a, 'f.txt', b, 'g.txt');
  assert.ok(!fs.existsSync(s.p('a', 'f.txt')));
  assert.equal(fs.readFileSync(s.p('b', 'g.txt'), 'utf8'), 'F');
  // Trename (fid-based) moves the object and the fid follows it
  const g = await s.walk(['b', 'g.txt']);
  await c.rename(g, a, 'back.txt');
  assert.equal(fs.readFileSync(s.p('a', 'back.txt'), 'utf8'), 'F');
  assert.equal((await c.getattr(g)).size, 1);
  // replace an existing file
  await c.renameat(0, 'src.txt', 0, 'dst.txt');
  assert.equal(fs.readFileSync(s.p('dst.txt'), 'utf8'), 'SRC');
  // replace a file that is open (by us and by a host process) and a read-only one
  const o = await s.open(['open.txt'], L.O_RDONLY);
  const hostFd = fs.openSync(s.p('open.txt'), 'r');
  fs.writeFileSync(s.p('n1.txt'), 'NEW1');
  await c.renameat(0, 'n1.txt', 0, 'open.txt');
  assert.equal(fs.readFileSync(s.p('open.txt'), 'utf8'), 'NEW1');
  assert.equal((await c.read(o, 0, 10)).toString(), 'OPEN', 'old open file still readable');
  fs.closeSync(hostFd);
  fs.chmodSync(s.p('ro.txt'), 0o444);
  fs.writeFileSync(s.p('n2.txt'), 'NEW2');
  await c.renameat(0, 'n2.txt', 0, 'ro.txt');
  assert.equal(fs.readFileSync(s.p('ro.txt'), 'utf8'), 'NEW2');
  assert.deepEqual(fs.readdirSync(s.root).filter((n) => n.startsWith('.9p-')), [], 'no leftovers');
  // directories
  await c.renameat(0, 'd1', 0, 'd2'); // over an empty dir
  assert.ok(!fs.existsSync(s.p('d1')) && fs.existsSync(s.p('d2')));
  await errCode(c.renameat(0, 'd2', 0, 'd3'), 'ENOTEMPTY');
  await errCode(c.renameat(0, 'd2', 0, 'plain.txt'), 'ENOTDIR');
  await errCode(c.renameat(0, 'plain.txt', 0, 'd3'), 'EISDIR');
  const d3 = await s.walk(['d3']);
  await errCode(c.renameat(0, 'd3', d3, 'inside'), 'EINVAL');
  await errCode(c.renameat(0, 'missing', 0, 'x'), 'ENOENT');
  await errCode(c.renameat(0, 'plain.txt', 0, 'bad/name'), 'EINVAL');
  await c.renameat(0, 'plain.txt', 0, 'plain.txt'); // no-op
  const pf = await s.walk(['plain.txt']);
  await errCode(c.renameat(pf, 'x', 0, 'y'), 'ENOTDIR');
  await errCode(c.rename(0, 0, 'x'), 'EBUSY');
  if (IS_WIN) {
    await c.renameat(0, 'plain.txt', 0, 'PLAIN.txt'); // case-only rename works on a case-insensitive host
    assert.ok(fs.readdirSync(s.root).includes('PLAIN.txt'));
  }
  // fids below a renamed directory follow it
  const deepFile = await s.open(['deep', 'in', 'most.txt'], L.O_RDONLY);
  const deepDir = await s.walk(['deep']);
  const unopened = await s.walk(['deep', 'in', 'most.txt']);
  const deepW = await s.open(['deep', 'in', 'most.txt'], L.O_RDWR);
  await c.renameat(0, 'deep', 0, 'moved'); // Windows: our open handles below it are swapped transparently
  assert.ok(fs.existsSync(s.p('moved', 'in', 'most.txt')));
  assert.equal((await c.getattr(unopened)).size, 1);
  assert.equal((await c.read(deepFile, 0, 10)).toString(), 'm');
  await c.write(deepW, 1, Buffer.from('ore'));
  assert.equal(fs.readFileSync(s.p('moved', 'in', 'most.txt'), 'utf8'), 'more');
  assert.equal((await c.getattr(deepW)).size, 4);
  // a file held open by another Windows program still blocks a directory rename
  if (IS_WIN) {
    const hostFd = fs.openSync(s.p('moved', 'in', 'most.txt'), 'r');
    await errCode(c.renameat(0, 'moved', 0, 'moved2'), 'EPERM');
    fs.closeSync(hostFd);
    assert.equal((await c.read(deepFile, 0, 10)).toString(), 'more', 'handles restored after the failed rename');
    await c.renameat(0, 'moved', 0, 'moved2');
    await c.renameat(0, 'moved2', 0, 'moved');
  }
  assert.equal((await c.walk(deepDir, 200, ['in', 'most.txt'])).length, 2);
  await c.lcreate(deepDir, 'created-after-move.txt', L.O_RDWR | L.O_CREAT);
  assert.ok(fs.existsSync(s.p('moved', 'created-after-move.txt')));
  await s.done();
});

test('Tsetattr: truncate, timestamps, mode (read-only attribute), chown accepted', async () => {
  const s = await setup({ files: { 'f.txt': '0123456789', 'dir/': null } });
  const { c } = s;
  const f = await s.walk(['f.txt']);
  await c.setattr(f, { size: 4 });
  assert.equal(fs.readFileSync(s.p('f.txt'), 'utf8'), '0123');
  await c.setattr(f, { size: 8 });
  assert.equal(fs.statSync(s.p('f.txt')).size, 8);
  await c.setattr(f, { mtime: [1700000000, 123456700], atime: [1600000000, 5000] });
  const st = fs.statSync(s.p('f.txt'), { bigint: true });
  assert.ok(Math.abs(Number(st.mtimeNs - 1700000000123456700n)) < 2000, 'mtime ' + st.mtimeNs);
  assert.ok(Math.abs(Number(st.atimeNs - 1600000000000005000n)) < 2000, 'atime ' + st.atimeNs);
  const ga = await c.getattr(f);
  assert.equal(ga.mtime.sec, 1700000000);
  assert.ok(Math.abs(ga.mtime.nsec - 123456700) < 2000);
  await c.setattr(f, { atime: 'now', mtime: 'now' });
  assert.ok(Math.abs(fs.statSync(s.p('f.txt')).mtimeMs - Date.now()) < 5000);
  await c.setattr(f, { uid: 1234, gid: 5678 }); // accepted, ignored
  assert.equal((await c.getattr(f)).uid, 0);
  await c.setattr(f, { ctime: true }); // ctime alone: no-op
  // chmod: the write bit maps to the read-only attribute on Windows
  await c.setattr(f, { mode: 0o444 });
  assert.equal(fs.statSync(s.p('f.txt')).mode & 0o200, 0);
  assert.equal((await c.getattr(f)).mode & 0o777, 0o444);
  await errCode(s.open(['f.txt'], L.O_WRONLY), IS_WIN ? 'EPERM' : 'EACCES');
  await c.setattr(f, { mode: 0o644 });
  assert.notEqual(fs.statSync(s.p('f.txt')).mode & 0o200, 0);
  // truncate through an open fid
  const o = await s.open(['f.txt'], L.O_RDWR);
  await c.setattr(o, { size: 2 });
  assert.equal(fs.readFileSync(s.p('f.txt'), 'utf8'), '01');
  const d = await s.walk(['dir']);
  await errCode(c.setattr(d, { size: 0 }), 'EISDIR');
  await c.setattr(d, { mtime: [1650000000, 0] });
  assert.equal(Math.floor(fs.statSync(s.p('dir')).mtimeMs / 1000), 1650000000);
  await errCode(c.setattr(f, { mtime: [1, 1000000000] }), 'EINVAL');
  await s.done();
});

test('Tgetattr: modes, ownership, sizes, qid identity', { skip: !IS_WIN && 'Windows mode synthesis' }, async () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);
  const s = await setup({ uid: 1000, gid: 1001, files: { 'dir/': null, 'plain.txt': 'x', 'run.sh': 'echo', 'tool': '#!/bin/sh\necho hi\n', 'notes': 'just text', 'app': elf, '.bashrc': '#!/bin/sh' } });
  const { c } = s;
  const mode = async (names) => (await c.getattr(await s.walk(names))).mode;
  assert.equal(await mode([]), 0o40755);
  assert.equal(await mode(['dir']), 0o40755);
  assert.equal(await mode(['plain.txt']), 0o100644);
  assert.equal(await mode(['run.sh']), 0o100755);
  assert.equal(await mode(['tool']), 0o100755);
  assert.equal(await mode(['app']), 0o100755);
  assert.equal(await mode(['notes']), 0o100644);
  assert.equal(await mode(['.bashrc']), 0o100644);
  fs.writeFileSync(s.p('notes'), '#!/usr/bin/env python3\n'); // cache keyed by mtime+size
  assert.equal(await mode(['notes']), 0o100755);
  const a = await c.getattr(await s.walk(['plain.txt']));
  assert.equal(a.uid, 1000);
  assert.equal(a.gid, 1001);
  assert.equal(a.nlink, 1);
  assert.equal(a.size, 1);
  assert.equal(a.blksize, 4096);
  assert.equal(a.valid & BigInt(P.GETATTR.BASIC), BigInt(P.GETATTR.BASIC));
  const st = fs.statSync(s.p('plain.txt'), { bigint: true });
  assert.equal(a.qid.path, st.ino, 'qid.path is the NTFS file id');
  assert.equal(BigInt(a.mtime.sec) * 1000000000n + BigInt(a.mtime.nsec), st.mtimeNs);
  // the qid version changes when the file changes
  const v1 = a.qid.version;
  await sleep(20);
  fs.writeFileSync(s.p('plain.txt'), 'changed');
  assert.notEqual((await c.getattr(await s.walk(['plain.txt']))).qid.version, v1);
  await s.done();
});

test('Tstatfs, Tfsync, Tlock, Tgetlock, xattrs, Tmknod, unknown and legacy messages', async () => {
  const s = await setup({ files: { 'f.txt': 'f' } });
  const { c } = s;
  const sf = await c.statfs(0);
  assert.equal(sf.type, P.V9FS_MAGIC);
  assert.ok(sf.bsize > 0);
  assert.ok(sf.blocks > 0n);
  assert.ok(sf.bavail <= sf.blocks);
  assert.equal(sf.namelen, 255);
  const o = await s.open(['f.txt'], L.O_RDWR);
  await c.fsync(o);
  await c.fsync(o, 1);
  const d = await s.open([], L.O_RDONLY);
  await c.fsync(d);
  const ro = await s.open(['f.txt'], L.O_RDONLY);
  await c.fsync(ro);
  assert.equal(await c.lock(o, { type: P.LOCK_TYPE.WRLCK }), P.LOCK_STATUS.SUCCESS);
  assert.equal(await c.lock(o, { type: P.LOCK_TYPE.UNLCK }), P.LOCK_STATUS.SUCCESS);
  const gl = await c.getlock(o, { type: P.LOCK_TYPE.WRLCK, start: 5, length: 10, procId: 42, clientId: 'guest' });
  assert.deepEqual(gl, { type: P.LOCK_TYPE.UNLCK, start: 5n, length: 10n, procId: 42, clientId: 'guest' });
  await errCode(c.xattrwalk(0, 300, ''), 'EOPNOTSUPP');
  await errCode(c.xattrwalk(0, 300, 'user.x'), 'EOPNOTSUPP');
  await errCode(c.xattrcreate(o, 'user.x', 3, 0), 'EOPNOTSUPP');
  await errCode(c.mknod(0, 'fifo', 0o10644, 0, 0), 'EPERM');
  assert.ok(!fs.existsSync(s.p('fifo')));
  await errCode(c.rpc(200, (w) => w.u32(0)), 'EOPNOTSUPP');
  await errCode(c.rpc(T.Topen, (w) => w.u32(0).u8(0)), 'EOPNOTSUPP'); // 9P2000 (non-.L) messages
  await errCode(c.rpc(T.Tstat, (w) => w.u32(0)), 'EOPNOTSUPP');
  await errCode(c.rpc(T.Tlerror, (w) => w.u32(0)), 'EOPNOTSUPP');
  await errCode(c.lock(999), 'EBADF');
  await s.done();
});

test('symlinks: guest-created links stay inside the share; readlink; never followed by the server', async () => {
  const s = await setup({ files: { 'sub/file.txt': 'in', 'top.txt': 'top' } });
  const { c } = s;
  let q;
  try {
    q = await c.symlink(0, 'rel', 'sub/file.txt');
  } catch (e) {
    assert.equal(e.code, 'EPERM'); // Windows without Developer Mode / symlink privilege
    await s.done();
    return;
  }
  assert.equal(q.type, QT.SYMLINK);
  assert.ok(fs.lstatSync(s.p('rel')).isSymbolicLink());
  const l = await s.walk(['rel']);
  assert.equal(await c.readlink(l), 'sub/file.txt');
  assert.equal((await c.getattr(l)).mode & 0o170000, 0o120000);
  await errCode(c.lopen(l, L.O_RDONLY), 'ELOOP');
  await errCode(c.readlink(await s.walk(['top.txt'])), 'EINVAL');
  // directory link: walking through it is refused, the guest resolves links itself
  await c.symlink(0, 'dlink', 'sub');
  assert.equal((await c.walk(0, 400, ['dlink', 'file.txt'])).length, 1);
  await errCode(c.getattr(400), 'EBADF');
  const sub = await s.walk(['sub']);
  await c.symlink(sub, 'up', '../top.txt');
  assert.equal(await c.readlink(await s.walk(['sub', 'up'])), '../top.txt');
  // targets that leave the share, are absolute or use host syntax are refused
  for (const t of ['..', '../x', 'sub/../../x', '/etc/passwd', '/']) await errCode(c.symlink(0, 'bad', t), 'EPERM');
  if (IS_WIN) for (const t of ['C:\\Windows', 'a\\b', 'x:y', 'sub/NUL']) await errCode(c.symlink(0, 'bad', t), 'EPERM');
  assert.ok(!fs.existsSync(s.p('bad')));
  await errCode(c.symlink(0, 'rel', 'top.txt'), 'EEXIST');
  // moving a relative link where its target would leave the share is refused
  await errCode(c.renameat(sub, 'up', 0, 'up-moved'), 'EPERM');
  await c.renameat(sub, 'up', sub, 'up2'); // same directory: fine
  // creating through a symlink name never follows it
  const dir = await s.walk([]);
  await errCode(c.lcreate(dir, 'rel', L.O_RDWR | L.O_CREAT), 'EEXIST');
  // unlink removes the link, not the target
  await c.unlinkat(0, 'dlink', 0);
  assert.ok(fs.existsSync(s.p('sub', 'file.txt')));
  await s.done();
});

test('Tlink: hard links inside the share', async () => {
  const s = await setup({ files: { 'f.txt': 'f', 'd/': null } });
  const { c } = s;
  const f = await s.walk(['f.txt']);
  const d = await s.walk(['d']);
  await c.link(d, f, 'hard.txt');
  assert.equal(fs.readFileSync(s.p('d', 'hard.txt'), 'utf8'), 'f');
  assert.equal((await c.getattr(f)).nlink, 2);
  assert.equal((await c.getattr(await s.walk(['d', 'hard.txt']))).qid.path, (await c.getattr(f)).qid.path);
  await errCode(c.link(d, f, 'hard.txt'), 'EEXIST');
  await errCode(c.link(0, d, 'dirlink'), 'EPERM');
  await errCode(c.link(f, f, 'x'), 'ENOTDIR');
  // renaming one hard link onto another of the same file is a POSIX no-op
  await c.renameat(0, 'f.txt', d, 'hard.txt');
  assert.ok(fs.existsSync(s.p('f.txt')) && fs.existsSync(s.p('d', 'hard.txt')));
  await s.done();
});

test('jail: host symlinks/junctions to outside the share cannot be followed, read or written through', async () => {
  const s = await setup({ files: { 'inside/in.txt': 'in' } });
  const { c } = s;
  const outside = path.join(TMP, 'outside-' + s.id);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  const kind = IS_WIN ? 'junction' : 'dir';
  fs.symlinkSync(outside, s.p('escape'), kind);
  fs.symlinkSync(s.p('inside'), s.p('good'), kind);
  let fileLink = false;
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), s.p('filelink'), 'file'); fileLink = true; } catch (e) { /* needs privilege */ }
  const esc = await s.walk(['escape']);
  assert.equal((await c.getattr(esc)).qid.type, QT.SYMLINK);
  assert.equal(await c.readlink(esc), OUTSIDE_LINK, 'host path not leaked');
  assert.equal(await c.readlink(await s.walk(['good'])), 'inside');
  assert.equal((await c.walk(0, 500, ['escape', 'secret.txt'])).length, 1);
  await errCode(c.getattr(500), 'EBADF');
  await errCode(c.walk(esc, 501, ['secret.txt']), 'ENOTDIR');
  await errCode(c.lopen(esc, L.O_RDONLY), 'ELOOP');
  await errCode(c.lcreate(esc, 'planted.txt', L.O_RDWR | L.O_CREAT), 'ENOTDIR');
  await errCode(c.mkdir(esc, 'planted'), 'ENOTDIR');
  await errCode(c.renameat(0, 'inside', esc, 'moved'), 'ENOTDIR');
  await errCode(c.unlinkat(esc, 'secret.txt', 0), 'ENOTDIR');
  await errCode(c.setattr(esc, { size: 0 }), 'EINVAL');
  if (fileLink) {
    const fl = await s.walk(['filelink']);
    await errCode(c.lopen(fl, L.O_RDONLY), 'ELOOP');
    await errCode(c.lopen(fl, L.O_WRONLY | L.O_TRUNC), 'ELOOP');
    await errCode(c.lcreate(await s.walk([]), 'filelink', L.O_WRONLY | L.O_CREAT), 'EEXIST');
    assert.equal(await c.readlink(fl), OUTSIDE_LINK);
    await errCode(c.link(0, fl, 'hl'), 'EPERM');
  }
  const d = await s.open([], L.O_RDONLY);
  const ents = Object.fromEntries((await c.readdirAll(d)).map((e) => [e.name, e]));
  assert.equal(ents.escape.type, DT.LNK);
  assert.equal(ents.good.type, DT.LNK);
  // unlinking the junction removes only the link
  await c.unlinkat(0, 'escape', 0);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'TOP SECRET');
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
  await s.done();
});

test('jail: a directory swapped for a link after the walk is refused (realpath check)', async () => {
  const s = await setup({ files: { 'work/data.txt': 'mine' } });
  const { c } = s;
  const outside = path.join(TMP, 'outside2-' + s.id);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'data.txt'), 'NOT YOURS');
  const dirFid = await s.walk(['work']);
  const fileFid = await s.walk(['work', 'data.txt']);
  // warm up: open, read and create in the directory first, so no cached answer may survive the swap
  const warm = await s.open(['work', 'data.txt'], L.O_RDONLY);
  assert.equal((await c.read(warm, 0, 10)).toString(), 'mine');
  await c.clunk(warm);
  const warmDir = await s.walk(['work']);
  await c.lcreate(warmDir, 'warm.txt', L.O_RDWR | L.O_CREAT);
  await c.clunk(warmDir);
  // the host (or a tool like pnpm) replaces "work" with a junction to outside
  fs.renameSync(s.p('work'), s.p('work-old'));
  fs.symlinkSync(outside, s.p('work'), IS_WIN ? 'junction' : 'dir');
  await errCode(c.lopen(fileFid, L.O_RDONLY), 'EACCES');
  assert.equal((await c.walk(0, 800, ['work', 'data.txt'])).length, 1, 'a fresh walk stops at the link');
  await errCode(c.lcreate(dirFid, 'planted.txt', L.O_RDWR | L.O_CREAT), 'EACCES');
  await errCode(c.mkdir(dirFid, 'planted'), 'EACCES');
  await errCode(c.unlinkat(dirFid, 'data.txt', 0), 'EACCES');
  await errCode(c.renameat(dirFid, 'data.txt', 0, 'stolen.txt'), 'EACCES');
  await errCode(c.setattr(fileFid, { size: 0 }), 'EACCES');
  await errCode(c.lopen(dirFid, L.O_RDONLY), 'ELOOP'); // the name itself is now a link
  assert.deepEqual(fs.readdirSync(outside), ['data.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'data.txt'), 'utf8'), 'NOT YOURS');
  await s.done();
});

test('jail: overlapping shares - a fid moved out of its share by another share is stale', async () => {
  const outer = await setup({ files: { 'inner/x/f.txt': 'f', 'other/': null } });
  const innerSecret = 'inner-secret-' + crypto.randomBytes(6).toString('hex');
  srv.addShare({ id: 'inner-' + outer.id, root: outer.p('inner'), secret: innerSecret });
  const ic = await NinepClient.connect({ port: srv.port });
  await ic.version(65536);
  await ic.attach(0, 'inner-' + outer.id + ':' + innerSecret);
  await ic.walk(0, 1, ['x']);
  await ic.walk(0, 2, ['x', 'f.txt']);
  const innerDir = outer.c.newFid();
  await outer.c.walk(0, innerDir, ['inner']);
  await outer.c.renameat(innerDir, 'x', 0, 'x-out');
  await errCode(ic.getattr(1), 'ENOENT');
  await errCode(ic.getattr(2), 'ENOENT');
  await errCode(ic.walk(1, 3, ['..']), 'ENOENT');
  await errCode(ic.walk(1, 3, ['f.txt']), 'ENOENT');
  await errCode(ic.lopen(2, L.O_RDONLY), 'ENOENT');
  await ic.destroy();
  srv.removeShare('inner-' + outer.id);
  await outer.done();
});

test('jail: Windows 8.3 short names cannot alias a long name', { skip: !IS_WIN && 'Windows only' }, async () => {
  const s = await setup({ files: { 'averylongdirectoryname/f.txt': 'f' } });
  if (!fs.existsSync(s.p('AVERYL~1'))) { await s.done(); return; } // 8.3 names disabled on this volume
  await errCode(s.c.walk(0, 600, ['AVERYL~1']), 'ENOENT');
  await errCode(s.c.walk(0, 600, ['averyl~1', 'f.txt']), 'ENOENT');
  assert.equal((await s.c.walk(0, 600, ['averylongdirectoryname', 'f.txt'])).length, 2);
  await errCode(s.c.renameat(0, 'AVERYL~1', 0, 'x'), 'ENOENT');
  await errCode(s.c.mkdir(0, 'AVERYL~1'), 'EEXIST');
  await s.done();
});

test('read-only share: every mutating operation fails with EROFS and nothing changes', async () => {
  const s = await setup({ readOnly: true, files: { 'f.txt': 'orig', 'd/x': 'x' } });
  const { c } = s;
  const before = JSON.stringify(fs.readdirSync(s.root, { recursive: true }).sort());
  const f = await s.walk(['f.txt']);
  const d = await s.walk(['d']);
  for (const flags of [L.O_WRONLY, L.O_RDWR, L.O_RDONLY | L.O_TRUNC, L.O_WRONLY | L.O_APPEND]) await errCode(c.lopen(await s.walk(['f.txt']), flags), 'EROFS');
  await errCode(c.lcreate(await s.walk([]), 'new.txt', L.O_RDWR | L.O_CREAT), 'EROFS');
  await errCode(c.mkdir(0, 'nd'), 'EROFS');
  await errCode(c.unlinkat(0, 'f.txt', 0), 'EROFS');
  await errCode(c.unlinkat(0, 'd', P.AT_REMOVEDIR), 'EROFS');
  await errCode(c.renameat(0, 'f.txt', d, 'g.txt'), 'EROFS');
  await errCode(c.rename(f, d, 'g.txt'), 'EROFS');
  await errCode(c.setattr(f, { size: 0 }), 'EROFS');
  await errCode(c.setattr(f, { mode: 0o444 }), 'EROFS');
  await errCode(c.setattr(f, { mtime: [1, 0] }), 'EROFS');
  await errCode(c.setattr(f, { uid: 5 }), 'EROFS');
  await errCode(c.symlink(0, 'l', 'f.txt'), 'EROFS');
  await errCode(c.link(0, f, 'h'), 'EROFS');
  await errCode(c.mknod(0, 'n', 0o10644), 'EROFS');
  const rm = await s.walk(['f.txt']);
  await errCode(c.remove(rm), 'EROFS');
  await errCode(c.getattr(rm), 'EBADF'); // clunked anyway
  // reads work, no write bits are reported
  const r = await s.open(['f.txt'], L.O_RDONLY);
  assert.equal((await c.read(r, 0, 10)).toString(), 'orig');
  await errCode(c.write(r, 0, Buffer.from('x')), 'EROFS');
  await c.fsync(r);
  if (IS_WIN) {
    assert.equal((await c.getattr(f)).mode, 0o100444);
    assert.equal((await c.getattr(0)).mode, 0o40555);
  } else {
    assert.equal((await c.getattr(f)).mode & 0o222, 0);
  }
  const dd = await s.open(['d'], L.O_RDONLY);
  assert.deepEqual((await c.readdirAll(dd)).map((e) => e.name).sort(), ['.', '..', 'x']);
  await c.setattr(f, { ctime: true }); // not a mutation
  assert.equal(JSON.stringify(fs.readdirSync(s.root, { recursive: true }).sort()), before);
  assert.equal(fs.readFileSync(s.p('f.txt'), 'utf8'), 'orig');
  await s.done();
});

test('concurrent tags: 200 pipelined reads are matched to the right replies', async () => {
  const data = crypto.randomBytes(1024 * 1024);
  const s = await setup({ files: { 'rand.bin': data } });
  const { c } = s;
  const f = await s.open(['rand.bin'], L.O_RDONLY);
  const offs = Array.from({ length: 200 }, () => Math.floor(Math.random() * (data.length - 4096)));
  const got = await Promise.all(offs.map((o) => c.read(f, o, 4096)));
  got.forEach((b, i) => assert.ok(b.equals(data.subarray(offs[i], offs[i] + 4096)), 'read ' + i));
  // mixed operations in flight at once
  const ops = [];
  for (let i = 0; i < 50; i++) {
    ops.push(c.getattr(f));
    ops.push(c.walk(0, 1000 + i, ['rand.bin']));
    ops.push(c.statfs(0));
  }
  await Promise.all(ops);
  await s.done();
});

test('Tflush: flushing an unknown tag answers at once; flushing an in-flight request answers after its reply', async () => {
  const s2 = await startServer({ _testHooks: { beforeOp: (name) => (name === 'Tgetattr' ? sleep(300) : null) } });
  const s = await setup({ server: s2, files: { 'f.txt': 'x' } });
  const { c } = s;
  await c.flush(4242);
  const order = [];
  c.on('frame', (f) => order.push([P.TYPE_NAME[f.type], f.tag]));
  const slow = c.rpc(T.Tgetattr, (w) => w.u32(0).u64(1n)); // rpc() exposes the tag it used
  const tag = slow.tag;
  const fl = c.flush(tag);
  await Promise.all([slow, fl]);
  assert.deepEqual(order.map((o) => o[0]), ['Rgetattr', 'Rflush']);
  assert.equal(order[0][1], tag);
  await s.done();
  await s2.close();
});

test('per-request timeout answers ETIMEDOUT and the connection keeps working', async () => {
  const s2 = await startServer({ requestTimeoutMs: 200, _testHooks: { beforeOp: (name) => (name === 'Tstatfs' ? sleep(900) : null) } });
  const s = await setup({ server: s2 });
  const { c } = s;
  const t0 = Date.now();
  await errCode(c.statfs(0), 'ETIMEDOUT');
  assert.ok(Date.now() - t0 < 800);
  await c.getattr(0);
  assert.equal(s2.stats().counters.timeouts, 1);
  await sleep(800); // the late completion must not produce a stray reply
  await c.getattr(0);
  await s.done();
  await s2.close();
});

test('framing: split and coalesced frames, malformed bodies keep the connection, bad sizes close it', async () => {
  const s = await setup({ files: { 'f.txt': 'hello' } });
  const { c } = s;
  const frame = (tag, type, fill) => { const w = new P.Writer(type, tag, 32); fill(w); return w.finish(); };
  const replies = new Map();
  c.on('frame', (f) => replies.set(f.tag, f));
  const waitTag = async (tag) => { for (let i = 0; i < 200 && !replies.has(tag); i++) await sleep(5); return replies.get(tag); };
  // one byte at a time
  const one = frame(301, T.Tgetattr, (w) => w.u32(0).u64(BigInt(P.GETATTR.ALL)));
  for (const byte of one) { c.rawSend(Buffer.from([byte])); await sleep(1); }
  assert.equal((await waitTag(301)).type, T.Rgetattr);
  // three frames in one write
  c.rawSend(Buffer.concat([frame(302, T.Tstatfs, (w) => w.u32(0)), frame(303, T.Tgetattr, (w) => w.u32(0).u64(1n)), frame(304, T.Tclunk, (w) => w.u32(98765))]));
  assert.equal((await waitTag(302)).type, T.Rstatfs);
  assert.equal((await waitTag(303)).type, T.Rgetattr);
  assert.equal((await waitTag(304)).type, T.Rlerror);
  // truncated bodies -> Rlerror EINVAL, connection survives
  c.rawSend(frame(305, T.Twalk, (w) => w.u32(0).u32(9).u16(3).str('a')));
  c.rawSend(frame(306, T.Tread, (w) => w.u32(0)));
  c.rawSend(frame(307, T.Tattach, (w) => w.u32(1)));
  c.rawSend(frame(308, T.Twrite, (w) => w.u32(0).u64(0n).u32(100).bytes(Buffer.from('short'))));
  for (const t of [305, 306, 307, 308]) {
    const r = await waitTag(t);
    assert.equal(r.type, T.Rlerror, 'tag ' + t);
    assert.equal(r.frame.readUInt32LE(7), ERRNO.EINVAL, 'tag ' + t);
  }
  await c.getattr(0);
  assert.equal(c.closed, false);
  // a frame larger than msize closes the connection; another client is unaffected
  const other = await NinepClient.connect({ port: srv.port });
  await other.version(65536);
  await other.attach(0, s.aname);
  const big = Buffer.alloc(8);
  big.writeUInt32LE(512 * 1024 + 1, 0);
  c.rawSend(big);
  await c.closedPromise;
  assert.equal((await other.getattr(0)).qid.type, QT.DIR);
  // undersized frame
  const u = await NinepClient.connect({ port: srv.port });
  u.rawSend(Buffer.from([5, 0, 0, 0, 100]));
  await u.closedPromise;
  // oversized before Tversion (limit 8 KiB)
  const v = await NinepClient.connect({ port: srv.port });
  const pre = Buffer.alloc(4);
  pre.writeUInt32LE(9000, 0);
  v.rawSend(pre);
  await v.closedPromise;
  // before an attach succeeds frames are capped at 64 KiB even with a large msize
  const pa = await NinepClient.connect({ port: srv.port });
  await pa.version(1024 * 1024);
  const paBig = Buffer.alloc(8);
  paBig.writeUInt32LE(70000, 0);
  pa.rawSend(paBig);
  await pa.closedPromise;
  // tag reuse while in flight is a protocol violation
  const s2 = await startServer({ _testHooks: { beforeOp: (name) => (name === 'Tgetattr' ? sleep(200) : null) } });
  const x = await setup({ server: s2 });
  x.c.rawSend(frame(7, T.Tgetattr, (w) => w.u32(0).u64(1n)));
  x.c.rawSend(frame(7, T.Tgetattr, (w) => w.u32(0).u64(1n)));
  await x.c.closedPromise;
  await x.done();
  await s2.close();
  await other.destroy();
  await s.done();
});

test('fuzz: random frames never crash the server or disturb other connections', async () => {
  const s = await setup({ files: { 'a/b.txt': 'b', 'c.txt': 'c' } });
  const watcher = await NinepClient.connect({ port: srv.port });
  await watcher.version(65536);
  await watcher.attach(0, s.aname);
  const types = Object.values(T).filter((t) => t % 2 === 0);
  let rnd = 12345;
  const rand = (n) => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd % n; };
  for (let round = 0; round < 6; round++) {
    const c = await NinepClient.connect({ port: srv.port });
    c.on('error', () => {});
    await c.version(65536);
    await c.attach(0, s.aname);
    const frames = [];
    for (let i = 0; i < 400; i++) {
      const type = rand(10) === 0 ? rand(256) : types[rand(types.length)];
      if (type === T.Tversion || type === T.Tflush) continue;
      const body = Buffer.alloc(rand(48));
      for (let k = 0; k < body.length; k++) body[k] = rand(8) === 0 ? rand(256) : rand(4);
      const f = Buffer.alloc(7 + body.length);
      f.writeUInt32LE(f.length, 0);
      f[4] = type;
      f.writeUInt16LE(i, 5);
      body.copy(f, 7);
      frames.push(f);
    }
    c.rawSend(Buffer.concat(frames));
    await sleep(300);
    assert.equal((await watcher.getattr(0)).qid.type, QT.DIR);
    await c.destroy();
  }
  assert.equal(fs.readFileSync(s.p('c.txt'), 'utf8').length >= 0, true);
  await watcher.destroy();
  await s.done();
});

test('limits: fids, open files, connections per share and in total', async () => {
  const s2 = await startServer({ maxFidsPerConnection: 10, maxOpenFilesPerConnection: 3, maxConnectionsPerShare: 2, maxConnections: 4 });
  const s = await setup({ server: s2, files: { 'f.txt': 'f' } });
  const { c } = s;
  for (let i = 1; i <= 9; i++) await c.walk(0, i, ['f.txt']);
  await errCode(c.walk(0, 10, []), 'ENFILE');
  await errCode(c.walk(0, 9, []), 'EINVAL'); // newfid in use
  await c.clunk(9);
  await c.walk(0, 9, ['f.txt']);
  for (let i = 1; i <= 3; i++) await c.lopen(i, L.O_RDONLY);
  await errCode(c.lopen(4, L.O_RDONLY), 'EMFILE');
  await c.clunk(1);
  await c.lopen(4, L.O_RDONLY);
  assert.equal(s2.stats().openFiles, 3);
  // second connection to the same share is fine; a third one reclaims the
  // least recently active idle connection of that share (see the share-cap test)
  const c2 = await NinepClient.connect({ port: s2.port });
  await c2.version(65536);
  await c2.attach(0, s.aname);
  await c2.getattr(0); // c2 is now more recently active than c
  const c3 = await NinepClient.connect({ port: s2.port });
  await c3.version(65536);
  await c3.attach(0, s.aname);
  await c.closedPromise;
  assert.equal(c2.closed, false);
  assert.equal(s2.stats().openFiles, 0, 'the reclaimed connection released its open files');
  // total connection cap: the 5th connection is dropped at once
  const c4 = await NinepClient.connect({ port: s2.port });
  const c4b = await NinepClient.connect({ port: s2.port });
  const c5 = await NinepClient.connect({ port: s2.port });
  await c5.closedPromise;
  assert.ok(s2.stats().counters.rejected >= 1);
  for (const x of [c2, c3, c4, c4b]) await x.destroy();
  await s.done();
  await s2.close();
  // unauthenticated connections cannot hold every slot: the oldest waiting one is evicted
  const s3 = await startServer({ maxPreAuthConnections: 2, maxConnections: 8 });
  const w = await setup({ server: s3, files: { 'f.txt': 'f' } }); // attached: never evicted
  const idle1 = await NinepClient.connect({ port: s3.port });
  await sleep(50);
  const idle2 = await NinepClient.connect({ port: s3.port });
  await sleep(50);
  const idle3 = await NinepClient.connect({ port: s3.port });
  await idle1.closedPromise;
  assert.equal(idle2.closed, false);
  assert.equal(s3.stats().counters.evicted, 1);
  await idle3.version(65536);
  await idle3.attach(0, w.aname); // a newcomer can still get in
  await w.c.getattr(0);
  for (const x of [idle2, idle3]) await x.destroy();
  await w.done();
  await s3.close();
});

test('removeShare drops its connections; addShare at runtime; stats', async () => {
  const base = srv.stats().openFiles;
  const s = await setup({ files: { 'f.txt': 'hello' } });
  const { c } = s;
  const f = await s.open(['f.txt'], L.O_RDONLY);
  await c.read(f, 0, 5);
  const st = srv.stats().shares.find((x) => x.id === s.id);
  assert.equal(st.connections, 1);
  assert.equal(st.openFiles, 1);
  assert.ok(st.fids >= 2);
  assert.equal(st.bytesRead, 5);
  assert.ok(st.ops > 0);
  srv.removeShare(s.id);
  await c.closedPromise;
  assert.equal(srv.stats().openFiles, base);
  const again = await NinepClient.connect({ port: srv.port });
  await again.version(65536);
  await errCode(again.attach(0, s.aname), 'EACCES');
  srv.addShare({ id: s.id, root: s.root, secret: s.secret });
  await again.attach(0, s.aname);
  assert.equal((await again.walk(0, 1, ['f.txt'])).length, 1);
  await again.destroy();
  srv.removeShare(s.id);
});

test('metadata fast path: async mode behaves the same, and the watchdog falls back to async', async () => {
  const s = await setup({ syncMetadata: false, files: { 'a/b.txt': 'b' } });
  const { c } = s;
  assert.equal(srv.stats().shares.find((x) => x.id === s.id).syncMetadata, false);
  const f = await s.walk(['a', 'b.txt']);
  assert.equal((await c.getattr(f)).size, 1);
  await c.lopen(f, L.O_RDWR);
  await c.write(f, 1, Buffer.from('cd'));
  assert.equal((await c.getattr(f)).size, 3);
  await errCode(c.walk(0, 700, ['nope']), 'ENOENT');
  await c.renameat(0, 'a', 0, 'z');
  assert.equal((await c.getattr(f)).size, 3);
  await s.done();
  // syncSlowMs 0: every synchronous call counts as slow; after 3 strikes the share goes async
  const logs = [];
  const s2 = await startServer({ syncSlowMs: 0, log: (lvl, m) => logs.push(m) });
  const x = await setup({ server: s2, files: { 'f.txt': 'f' } });
  for (let i = 0; i < 3; i++) await x.c.getattr(0);
  assert.equal(s2.stats().shares[0].syncMetadata, false);
  assert.ok(logs.some((m) => /using async calls/.test(m)));
  assert.equal(logs.filter((m) => /using async calls/.test(m)).length, 1);
  assert.equal((await x.c.getattr(await x.walk(['f.txt']))).size, 1);
  await x.done();
});

// ---------------------------------------------------------------- hardening --
// Regression tests for the hostile-guest review: memory must stay bounded and
// dead peers must be reclaimed, whatever an attached guest does.

// A raw attached connection: frames in, replies collected by tag.
async function rawAttached(server, aname, msize) {
  const sock = net.connect({ host: '127.0.0.1', port: server.port });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.on('error', () => {});
  const replies = new Map();
  const waiters = new Map();
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    while (acc.length >= 7 && acc.length >= acc.readUInt32LE(0)) {
      const f = acc.subarray(0, acc.readUInt32LE(0));
      acc = acc.subarray(f.length);
      const tag = f.readUInt16LE(5);
      const w = waiters.get(tag);
      if (w) { waiters.delete(tag); w(f); } else replies.set(tag, f);
    }
  });
  const closed = new Promise((r) => sock.once('close', r));
  const frame = (type, tag, fill) => { const w = new P.Writer(type, tag, 64); fill(w); return w.finish(); };
  const rpc = (type, tag, fill) => new Promise((res) => { waiters.set(tag, res); sock.write(frame(type, tag, fill)); });
  await rpc(T.Tversion, P.NOTAG, (w) => w.u32(msize || 1024 * 1024).str(P.VERSION));
  const a = await rpc(T.Tattach, 1, (w) => w.u32(0).u32(P.NOFID).str('root').str(aname).u32(0));
  assert.equal(a[4], T.Rattach);
  return { sock, rpc, frame, replies, closed };
}

test('backpressure: pipelined reads whose replies are never taken stop at the write high-water mark', async () => {
  const data = crypto.randomBytes(1024 * 1024);
  const s = await setup({ files: { 'big.bin': data } });
  const r = await rawAttached(srv, s.aname);
  await r.rpc(T.Twalk, 2, (w) => w.u32(0).u32(1).u16(1).str('big.bin'));
  assert.equal((await r.rpc(T.Tlopen, 3, (w) => w.u32(1).u32(L.O_RDONLY)))[4], T.Rlopen);
  const before = srv.stats().ops.Tread ? srv.stats().ops.Tread.count : 0;
  r.sock.pause(); // take no replies
  const N = 200; // 200 MiB of replies if nothing held the server back
  const frames = [];
  for (let i = 0; i < N; i++) frames.push(r.frame(T.Tread, 100 + i, (w) => w.u32(1).u64(0n).u32(1024 * 1024)));
  r.sock.write(Buffer.concat(frames));
  await sleep(1500);
  const st = srv.stats();
  const served = st.ops.Tread.count - before;
  assert.ok(served < 100, 'server stopped starting reads: served ' + served + ' of ' + N);
  // pinned = replies not taken + requests in flight <= maxRequestBytesPerConnection (16 MiB) + one reply
  assert.ok(st.unsentBytes + st.requestBytes <= 17 * 1024 * 1024 + 4096, 'unsent ' + st.unsentBytes + ' + in flight ' + st.requestBytes);
  // taking the replies lets every request complete, intact
  let got = 0;
  let bad = 0;
  const done = new Promise((resolve) => {
    const check = () => {
      for (let i = 0; i < N; i++) {
        const f = r.replies.get(100 + i);
        if (!f) continue;
        r.replies.delete(100 + i);
        const body = f.subarray(11); // count = msize - 11 bytes
        if (f[4] !== T.Rread || body.length !== 1024 * 1024 - 11 || !body.equals(data.subarray(0, body.length))) bad++;
        got++;
      }
      if (got === N) resolve();
    };
    r.sock.on('data', () => setImmediate(check));
  });
  r.sock.resume();
  await done;
  assert.equal(got, N);
  assert.equal(bad, 0);
  r.sock.destroy();
  await s.done();
});

test('stall: an attached connection that stops mid-frame is closed; an idle one stays open', async () => {
  const s2 = await startServer({ stallTimeoutMs: 300 });
  const s = await setup({ server: s2 });
  const idle = await NinepClient.connect({ port: s2.port }); // attached and idle: must survive
  await idle.version(65536);
  await idle.attach(0, s.aname);
  const r = await rawAttached(s2, s.aname, 512 * 1024);
  const t0 = Date.now();
  const hdr = Buffer.alloc(10);
  hdr.writeUInt32LE(100000, 0); // announces a 100000-byte Twrite, sends 10 bytes
  hdr[4] = T.Twrite;
  r.sock.write(hdr);
  await r.closed;
  assert.ok(Date.now() - t0 < 3000, 'closed after ' + (Date.now() - t0) + ' ms');
  assert.equal(s2.stats().counters.stalled, 1);
  // a partial 4-byte size header is a stall as well
  const r2 = await rawAttached(s2, s.aname, 512 * 1024);
  r2.sock.write(Buffer.from([0x40, 0x00]));
  await r2.closed;
  assert.equal(s2.stats().counters.stalled, 2);
  await sleep(700);
  assert.equal(idle.closed, false);
  await idle.getattr(0);
  await s.c.getattr(0);
  await idle.destroy();
  await s.done();
  await s2.close();
});

test('stall: a guest that never takes its replies is closed, other guests are unaffected', async () => {
  const s2 = await startServer({ stallTimeoutMs: 400 });
  const s = await setup({ server: s2, files: { 'big.bin': crypto.randomBytes(1024 * 1024) } });
  const r = await rawAttached(s2, s.aname);
  await r.rpc(T.Twalk, 2, (w) => w.u32(0).u32(1).u16(1).str('big.bin'));
  await r.rpc(T.Tlopen, 3, (w) => w.u32(1).u32(L.O_RDONLY));
  r.sock.pause();
  const frames = [];
  for (let i = 0; i < 64; i++) frames.push(r.frame(T.Tread, 100 + i, (w) => w.u32(1).u64(0n).u32(1024 * 1024)));
  r.sock.write(Buffer.concat(frames));
  const t0 = Date.now();
  while (s2.stats().counters.stalled < 1 && Date.now() - t0 < 8000) await sleep(50);
  assert.equal(s2.stats().counters.stalled, 1);
  assert.equal(s2.stats().connections, 1, 'only the healthy connection is left');
  assert.equal(s2.stats().unsentBytes, 0);
  r.sock.destroy();
  await s.c.getattr(0);
  await s.done();
  await s2.close();
});

test('timeouts run on a clock that a host sleep (wall-clock jump) cannot fast-forward', async () => {
  const s2 = await startServer({ requestTimeoutMs: 60000, _testHooks: { beforeOp: (name) => (name === 'Tstatfs' ? sleep(600) : null) } });
  const s = await setup({ server: s2 });
  const v0 = s2.vnow();
  s2.vwall -= 3600 * 1000; // as if the machine slept for an hour since the last sweep
  assert.ok(s2.vnow() - v0 <= 2 * s2.tickMs + 5, 'advanced ' + (s2.vnow() - v0));
  const p = s.c.statfs(0); // in flight across the "sleep"
  s2.vwall -= 3600 * 1000;
  await p; // not ETIMEDOUT
  assert.equal(s2.stats().counters.timeouts, 0);
  await s.done();
  await s2.close();
});

test('directories count as open files; readdir snapshots are bounded and re-read transparently', async () => {
  const files = {};
  for (let i = 0; i < 40; i++) files['d/n' + String(i).padStart(2, '0')] = 'x';
  const s2 = await startServer({ maxDirEntriesCached: 50, maxOpenFilesPerConnection: 3 });
  const s = await setup({ server: s2, files });
  const { c } = s;
  const dirs = [];
  for (let i = 0; i < 3; i++) dirs.push(await s.open(['d'], L.O_RDONLY | L.O_DIRECTORY));
  await errCode(s.open(['d'], L.O_RDONLY | L.O_DIRECTORY), 'EMFILE');
  const firstPages = [];
  for (const d of dirs) firstPages.push(await c.readdir(d, 0n, 200));
  let st = s2.stats();
  assert.ok(st.dirEntriesCached <= 50, 'cached ' + st.dirEntriesCached);
  assert.equal(st.dirSnapshots, 1);
  assert.ok(st.counters.dirSnapshotsDropped >= 2);
  // every listing still completes correctly (the dropped ones are re-read)
  const expect = ['.', '..'].concat(Array.from({ length: 40 }, (_, i) => 'n' + String(i).padStart(2, '0')));
  for (let k = 0; k < dirs.length; k++) {
    const names = firstPages[k].map((e) => e.name);
    let off = firstPages[k][firstPages[k].length - 1].offset;
    for (;;) { const pg = await c.readdir(dirs[k], off, 200); if (!pg.length) break; names.push(...pg.map((e) => e.name)); off = pg[pg.length - 1].offset; }
    assert.deepEqual(names.sort(), expect.slice().sort());
  }
  for (const d of dirs) await c.clunk(d);
  st = s2.stats();
  assert.equal(st.dirSnapshots, 0);
  assert.equal(st.dirEntriesCached, 0);
  assert.equal(st.openFiles, 0);
  await s.done();
  await s2.close();
});

test('readdir: entries deleted after the snapshot are skipped and never end the listing early', async () => {
  const files = {};
  for (let i = 0; i < 30; i++) files['f' + String(i).padStart(2, '0')] = 'x';
  const s = await setup({ files });
  const { c } = s;
  const order = (await c.readdirAll(await s.open([], L.O_RDONLY))).map((e) => e.name); // the host's listing order
  const d = await s.open([], L.O_RDONLY);
  // 270 bytes: ".", ".." and 8 names, then pages of 10 names (27 bytes each)
  const p1 = await c.readdir(d, 0n, 270);
  assert.deepEqual(p1.map((e) => e.name), order.slice(0, 10));
  for (const n of order.slice(10, 20)) fs.rmSync(s.p(n)); // exactly the whole next page
  const rest = [];
  let off = p1[p1.length - 1].offset;
  for (;;) { const pg = await c.readdir(d, off, 270); if (!pg.length) break; rest.push(...pg.map((e) => e.name)); off = pg[pg.length - 1].offset; }
  assert.deepEqual(rest, order.slice(20));
  assert.equal(rest.length, 12);
  await s.done();
});

test('fid caps: per connection and per share', async () => {
  const s2 = await startServer({ maxFidsPerConnection: 10, maxFidsPerShare: 12 });
  const s = await setup({ server: s2, files: { 'f.txt': 'f' } });
  for (let i = 1; i <= 9; i++) await s.c.walk(0, i, []);
  await errCode(s.c.walk(0, 10, []), 'ENFILE'); // 10 per connection
  await s.c.walk(9, 9, []); // replacing an existing fid is not a new one
  const c2 = await NinepClient.connect({ port: s2.port });
  await c2.version(65536);
  await c2.attach(0, s.aname); // share total 11
  await c2.walk(0, 1, []); // 12
  await errCode(c2.walk(0, 2, []), 'ENFILE'); // 12 per share
  assert.equal(s2.stats().shares[0].fids, 12);
  await s.c.clunk(5);
  await c2.walk(0, 2, []);
  await c2.destroy();
  await sleep(50);
  assert.equal(s2.stats().shares[0].fids, 9);
  await s.done();
  await s2.close();
});

test('share connection cap: the least recently active idle connection is reclaimed (stale mounts after a guest reboot)', async () => {
  let hold = null;
  const s2 = await startServer({ maxConnectionsPerShare: 2, _testHooks: { beforeOp: (name) => (name === 'Tstatfs' && hold ? hold : null) } });
  const s = await setup({ server: s2, files: { 'f.txt': 'f' } }); // s.c: attached first
  const fh = await s.open(['f.txt'], L.O_RDONLY); // a stale mount still holding an open file
  const c2 = await NinepClient.connect({ port: s2.port });
  await c2.version(65536);
  await c2.attach(0, s.aname);
  await c2.getattr(0);
  const c3 = await NinepClient.connect({ port: s2.port });
  await c3.version(65536);
  await c3.attach(0, s.aname); // reclaims s.c (least recently active)
  await s.c.closedPromise;
  assert.equal(c2.closed, false);
  assert.equal(s2.stats().counters.reclaimed, 1);
  assert.equal(s2.stats().openFiles, 0);
  await c3.getattr(0);
  // busy connections are never reclaimed: with both in flight, a newcomer is refused
  let release;
  hold = new Promise((r) => { release = r; });
  const p2 = c2.statfs(0);
  const p3 = c3.statfs(0);
  await sleep(50);
  const c4 = await NinepClient.connect({ port: s2.port });
  await c4.version(65536);
  await errCode(c4.attach(0, s.aname), 'EUSERS');
  release();
  hold = null;
  await Promise.all([p2, p3]);
  assert.ok(fh > 0);
  for (const x of [c2, c3, c4]) await x.destroy();
  await s.done();
  await s2.close();
});

test('a mount from a new boot of the VM (uname=boot-<id>) closes the share\'s mounts from earlier boots', async () => {
  const s2 = await startServer({});
  const s = await setup({ server: s2, files: { 'f.txt': 'f' } }); // untagged (uname "root"): never superseded
  const mount = async (uname) => {
    const c = await NinepClient.connect({ port: s2.port });
    clients.push(c);
    await c.version(65536);
    await c.attach(0, s.aname, { uname });
    return c;
  };
  const old1 = await mount('boot-11111111-aaaa');
  const old2 = await mount('boot-11111111-aaaa'); // a second mount of the same boot
  await old1.walk(0, 1, ['f.txt']);
  await old1.lopen(1, L.O_RDONLY); // the old boot still "holds" a file
  await old1.attach(5, s.aname, { uname: 'boot-11111111-aaaa' }); // per-user attach on the same connection
  assert.equal(old1.closed, false);
  assert.equal(s2.stats().openFiles, 1);
  const fresh = await mount('boot-22222222-bbbb');
  await old1.closedPromise;
  await old2.closedPromise;
  assert.equal(fresh.closed, false);
  assert.equal(s.c.closed, false);
  const st = s2.stats({ connections: true });
  assert.equal(st.counters.superseded, 2);
  assert.equal(st.openFiles, 0);
  assert.ok(st.recentCloses.some((x) => /superseded/.test(x.reason)));
  assert.deepEqual(st.connectionList.map((c) => c.boot).sort(), ['boot-22222222-bbbb', null].sort());
  await fresh.getattr(0);
  await s.c.getattr(0);
  // a name that merely looks different is not a boot tag
  const odd = await mount('boot-x');
  assert.equal(fresh.closed, false);
  await odd.destroy();
  await fresh.destroy();
  await s.done();
  await s2.close();
});

test('disconnectShare drops a share\'s connections and keeps the share', async () => {
  const s = await setup({ files: { 'f.txt': 'f' } });
  await s.open(['f.txt'], L.O_RDONLY);
  const base = srv.stats().openFiles;
  assert.equal(srv.disconnectShare(s.id), 1);
  await s.c.closedPromise;
  assert.equal(srv.stats().openFiles, base - 1);
  assert.equal(srv.disconnectShare('no-such-share'), 0);
  const again = await NinepClient.connect({ port: srv.port });
  await again.version(65536);
  await again.attach(0, s.aname);
  assert.equal((await again.walk(0, 1, ['f.txt'])).length, 1);
  await again.destroy();
  await s.done();
});

test('onAttach tells the embedding manager which boot mounted which share (asynchronously; a throwing callback breaks nothing)', async () => {
  const seen = [];
  const s2 = await startServer({ onAttach: (info) => { seen.push(info); throw new Error('the callback\'s own problem'); } });
  const x = await setup({ server: s2 }); // attaches without a boot tag
  const b = await NinepClient.connect({ port: s2.port });
  await b.version(65536);
  await b.attach(0, x.aname, { uname: 'boot-0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6' });
  const bad = await NinepClient.connect({ port: s2.port });
  await bad.version(65536);
  await errCode(bad.attach(0, x.id + ':wrong-secret-0123456789'), 'EACCES');
  await sleep(50);
  assert.deepEqual(seen.map((i) => [i.share, i.boot, typeof i.connection]), [[x.id, null, 'number'], [x.id, 'boot-0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'number']],
    'one call per successful attach, none for a refused one');
  assert.equal((await b.getattr(0)).qid.type, QT.DIR, 'the attach itself worked');
  for (const c of [b, bad]) await c.destroy();
  await x.done();
  await s2.close();
});

test('qid ids for objects without an inode number are bounded and never reused', () => {
  const st = (i) => ({ isDirectory: () => false, isSymbolicLink: () => false, mtimeNs: 0n, size: 0n, ino: 0n, dev: 1n, i });
  const share = { dev: 2n };
  const n = 65536 + 100;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const q = srv.qidOf(st(i), share, '/nowhere/obj-' + i);
    assert.ok(!seen.has(q.path), 'id reused');
    seen.add(q.path);
  }
  assert.ok(srv.foreignIds.size <= 65536, 'map size ' + srv.foreignIds.size);
  assert.equal(srv.qidOf(st(0), share, '/nowhere/obj-' + (n - 1)).path, srv.qidOf(st(0), share, '/nowhere/obj-' + (n - 1)).path, 'stable while remembered');
});

test('jail (attack regression): a PARTIAL walk never creates the fid, so nothing outside can be read', async () => {
  const s = await setup({ files: { 'in/x.txt': 'x' } });
  fs.writeFileSync(path.join(TMP, 'outside-secret.txt'), 'SECRET');
  const { c } = s;
  for (const names of [['..', '..', 'outside-secret.txt'], ['in', '..', '..', 'outside-secret.txt'], ['..', s.id, '..', 'outside-secret.txt']]) {
    let q = [];
    try { q = await c.walk(0, 900, names); } catch (e) { q = []; }
    assert.ok(q.length < names.length, 'walk ' + names.join('/') + ' must stop short');
    await errCode(c.lopen(900, L.O_RDONLY), 'EBADF'); // newfid was not created
  }
  await s.done();
});
