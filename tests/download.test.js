'use strict';
/*
 * lib/download.js against a local HTTP server (allowHttp is the tests-only
 * switch; the manager itself only follows https://): a good download lands
 * atomically, while a dropped connection, a stall, a short body, a checksum
 * mismatch and HTTP errors all reject and leave NOTHING behind - neither the
 * file nor its .part (BUG-3, OPS-2, SEC-10). Plus the sha512 sidecar parser,
 * fetchText timeouts, sha512File and headInfo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dl = require('../lib/download');

const BODY = crypto.randomBytes(300 * 1024);
const SHA = crypto.createHash('sha512').update(BODY).digest('hex');

function server(handler) {
  const s = http.createServer(handler);
  const sockets = new Set();
  s.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({
    url: (p) => 'http://127.0.0.1:' + s.address().port + p,
    close: () => new Promise((r) => { for (const c of sockets) c.destroy(); s.close(r); }),
  })));
}

function routes(req, res) {
  const u = req.url;
  if (u === '/ok.bin') { res.writeHead(200, { 'Content-Length': BODY.length }); return res.end(BODY); }
  if (u === '/redirect') { res.writeHead(302, { Location: '/ok.bin' }); return res.end(); }
  if (u === '/missing') { res.writeHead(404); return res.end('no'); }
  if (u === '/short') {
    // promises 300 KB, sends 10 KB, then drops the connection
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.write(BODY.subarray(0, 10240));
    return setTimeout(() => req.socket.destroy(), 50);
  }
  if (u === '/stall') {
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.write(BODY.subarray(0, 1024));
    return; // and then nothing, ever
  }
  if (u === '/ok.bin.sha512') { res.writeHead(200); return res.end(SHA + '  ok.bin\n'); }
  if (u === '/qemu-w64-setup-20260811.sha512') { res.writeHead(200); return res.end(SHA.toUpperCase() + '  qemu-w64-setup-20260811.exe\n'); }
  if (u === '/slow-text') { res.writeHead(200); res.write('partial'); return; }
  res.writeHead(500); res.end();
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-dl-')); }
function leftovers(dir) { return fs.readdirSync(dir); }

test('download: complete file with length + sha512 check, written atomically, progress logged', async () => {
  const s = await server(routes);
  const dir = tmpDir();
  try {
    const lines = [];
    const dest = path.join(dir, 'a.bin');
    const r = await dl.download(s.url('/redirect'), dest, { allowHttp: true, sha512: SHA, label: 'test file', t: { log: (m) => lines.push(m) } });
    assert.equal(r.bytes, BODY.length);
    assert.equal(r.sha512, SHA);
    assert.ok(fs.readFileSync(dest).equals(BODY));
    assert.deepEqual(leftovers(dir), ['a.bin']);
    assert.ok(lines.some((l) => /sha512 verified/.test(l)), lines.join('\n'));
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download: a dropped connection, a stall, a checksum mismatch and HTTP errors leave nothing behind', async () => {
  const s = await server(routes);
  const dir = tmpDir();
  try {
    const dest = path.join(dir, 'b.bin');
    await assert.rejects(dl.download(s.url('/short'), dest, { allowHttp: true }), /dropped|closed early|incomplete/);
    await assert.rejects(dl.download(s.url('/stall'), dest, { allowHttp: true, idleTimeoutMs: 300 }), /stalled/);
    await assert.rejects(dl.download(s.url('/ok.bin'), dest, { allowHttp: true, sha512: 'ab'.repeat(64) }), /checksum mismatch/);
    await assert.rejects(dl.download(s.url('/missing'), dest, { allowHttp: true }), /HTTP 404/);
    await new Promise((r) => setTimeout(r, 300)); // the .part cleanup runs after the stream closes
    assert.deepEqual(leftovers(dir), []);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// (redirect targets go through the same check as the first URL)
test('download: a redirect to a mirror that does not answer is retried from the start, so the next redirect can pick another mirror', async () => {
  let hits = 0;
  const s = await server((req, res) => {
    if (req.url === '/mirror') {
      hits++;
      // the first answer sends us to a port nobody listens on; the second to the file
      res.writeHead(302, { Location: hits === 1 ? 'http://127.0.0.1:1/down.bin' : '/ok.bin' });
      return res.end();
    }
    routes(req, res);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-dl-mirror-'));
  const dest = path.join(dir, 'ok.bin');
  const said = [];
  try {
    const r = await dl.download(s.url('/mirror'), dest, { allowHttp: true, sha512: SHA, label: 'image', t: { log: (m) => said.push(m) } });
    assert.equal(r.bytes, BODY.length);
    assert.equal(hits, 2, 'asked the download site again');
    assert.ok(said.some((m) => /mirror 127\.0\.0\.1:1 did not answer .*asking 127\.0\.0\.1:\d+ for another \(1\/3\)/.test(m)), said.join('\n'));
    // the plain message of a refused connection names the code, never a bare "AggregateError"
    const { errMsg } = require('../lib/util');
    const agg = new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })], 'AggregateError');
    assert.equal(errMsg(agg), 'connect ECONNREFUSED 127.0.0.1:1');
    assert.equal(errMsg(Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' })), 'getaddrinfo failed (ENOTFOUND)');
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download / fetchText refuse plain http (the manager only follows https)', async () => {
  const s = await server(routes);
  const dir = tmpDir();
  try {
    await assert.rejects(dl.download(s.url('/ok.bin'), path.join(dir, 'c.bin')), /non-HTTPS/);
    await assert.rejects(dl.fetchText(s.url('/ok.bin.sha512')), /non-HTTPS/);
    await assert.rejects(dl.fetchText('https://127.0.0.1:1/x', { timeoutMs: 3000 }));
    assert.deepEqual(leftovers(dir), []);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchText: body, HTTP errors, timeout', async () => {
  const s = await server(routes);
  try {
    assert.match(await dl.fetchText(s.url('/ok.bin.sha512'), { allowHttp: true }), /ok\.bin/);
    await assert.rejects(dl.fetchText(s.url('/missing'), { allowHttp: true }), /HTTP 404/);
    await assert.rejects(dl.fetchText(s.url('/slow-text'), { allowHttp: true, timeoutMs: 300 }), /timed out/);
  } finally { await s.close(); }
});

test('fetchSha512: Alpine "<file>.sha512" and QEMU "<name>.sha512" sidecars; null when absent', async () => {
  const s = await server(routes);
  try {
    assert.equal(await dl.fetchSha512(s.url('/ok.bin'), { allowHttp: true }), SHA);
    assert.equal(await dl.fetchSha512(s.url('/qemu-w64-setup-20260811.exe'), {
      allowHttp: true, sidecarUrl: s.url('/qemu-w64-setup-20260811.sha512'), fileName: 'qemu-w64-setup-20260811.exe',
    }), SHA);
    assert.equal(await dl.fetchSha512(s.url('/missing'), { allowHttp: true }), null);
  } finally { await s.close(); }
});

test('parseSha512Sidecar: bare hash, sha512sum lines, binary-mode "*file", picks the right file', () => {
  const h1 = 'a'.repeat(128), h2 = 'B'.repeat(128);
  assert.equal(dl.parseSha512Sidecar(h1 + '\n', 'x.qcow2'), h1);
  assert.equal(dl.parseSha512Sidecar(h1 + '  x.qcow2\n', 'x.qcow2'), h1);
  assert.equal(dl.parseSha512Sidecar(h1 + ' *x.qcow2\n' + h2 + '  y.qcow2\n', 'y.qcow2'), h2.toLowerCase());
  assert.equal(dl.parseSha512Sidecar(h1 + '  other.exe\n', 'x.exe'), null);
  assert.equal(dl.parseSha512Sidecar('<html>not found</html>', 'x'), null);
  assert.equal(dl.parseSha512Sidecar('', 'x'), null);
});

test('sha512File and headInfo', async () => {
  const s = await server(routes);
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'f.bin');
    fs.writeFileSync(f, BODY);
    assert.equal(await dl.sha512File(f), SHA);
    await assert.rejects(dl.sha512File(path.join(dir, 'nope')));
    const h = await dl.headInfo(s.url('/redirect'), { allowHttp: true });
    assert.equal(h.status, 200);
    assert.equal(h.length, BODY.length);
    assert.equal((await dl.headInfo(s.url('/missing'), { allowHttp: true })).status, 404);
    const bad = await dl.headInfo('https://127.0.0.1:1/x', { timeoutMs: 3000 });
    assert.equal(bad.status, null);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
