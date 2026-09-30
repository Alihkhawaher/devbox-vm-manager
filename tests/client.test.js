'use strict';
/*
 * lib/client.js against a small fake manager on an ephemeral port: finding
 * the manager for a data root (run/manager.json + rootId, the port hint),
 * token and content-type headers, API errors with status/code/body, task
 * polling (done, still running at the deadline, forgotten task, transient
 * network errors). Starting a real headless manager is covered by
 * tests/mcp-server.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { rm } = require('./helpers');
const { rootId, pingProof } = require('../lib/config');
const client = require('../lib/client');

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-client-')); }

// A fake manager: /api/ping answers for `forRoot` - with the proof of the
// token in <forRoot>/manager-token when asked with a nonce (like lib/http.js;
// opts.proof overrides it: a function (nonce, port) or null for none);
// everything else is up to `routes`.
async function fakeManager(forRoot, routes, opts) {
  opts = opts || {};
  const seen = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body });
      const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.url.split('?')[0] === '/api/ping') {
        const out = { ok: true, app: 'devbox-vm-manager', version: '2.0.0', rootId: rootId(forRoot) };
        const nonce = new URL(req.url, 'http://x').searchParams.get('nonce');
        const token = client.readToken(forRoot);
        if (nonce && opts.proof !== null) out.proof = opts.proof ? opts.proof(nonce, port) : (token ? pingProof(token, nonce, port) : undefined);
        return reply(200, out);
      }
      const r = routes && routes[req.method + ' ' + req.url.split('?')[0]];
      if (r) return r(req, reply, body);
      reply(404, { ok: false, error: 'no such API route', code: 'NOT_FOUND' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  return {
    port: server.address().port,
    seen: seen,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }),
  };
}

function writeManagerFile(root, info) {
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'run', 'manager.json'), typeof info === 'string' ? info : JSON.stringify(info));
}

test('readManagerInfo / readToken accept only well-formed files', () => {
  const root = tempRoot();
  try {
    assert.equal(client.readManagerInfo(root), null);
    writeManagerFile(root, '{broken');
    assert.equal(client.readManagerInfo(root), null);
    writeManagerFile(root, { pid: 1, port: 70000 });
    assert.equal(client.readManagerInfo(root), null);
    writeManagerFile(root, { pid: 1, port: 8777, url: 'x' });
    assert.equal(client.readManagerInfo(root).port, 8777);
    fs.writeFileSync(path.join(root, 'manager-token'), 'not a token\n');
    assert.equal(client.readToken(root), null);
    fs.writeFileSync(path.join(root, 'manager-token'), 'ab'.repeat(24) + '\n');
    assert.equal(client.readToken(root), 'ab'.repeat(24));
  } finally { rm(root); }
});

test('findManager: manager.json + a ping from THIS data root; the port hint when the file is missing', async () => {
  const root = tempRoot();
  const other = tempRoot();
  const mine = await fakeManager(root);
  const foreign = await fakeManager(other);
  try {
    assert.equal(await client.findManager(root), null, 'no manager.json');
    writeManagerFile(root, { pid: 4242, port: mine.port });
    const m = await client.findManager(root);
    assert.deepEqual(m, { port: mine.port, url: 'http://127.0.0.1:' + mine.port + '/', pid: 4242, version: '2.0.0' });
    // a manager for another data folder on the recorded port is not ours
    writeManagerFile(root, { pid: 4242, port: foreign.port });
    assert.equal(await client.findManager(root), null);
    // stale file, but the hinted port serves this folder
    const byHint = await client.findManager(root, { port: mine.port });
    assert.equal(byHint.port, mine.port);
    assert.equal(byHint.pid, null);
    fs.rmSync(path.join(root, 'run', 'manager.json'));
    assert.equal((await client.findManager(root, { port: mine.port })).port, mine.port);
    assert.equal(await client.findManager(root, { port: foreign.port }), null);
  } finally { await mine.close(); await foreign.close(); rm(root); rm(other); }
});

test('findManager trusts only a manager that proves it knows the token (security-8): no proof, a wrong one or a relayed one is refused', async () => {
  const root = tempRoot();
  const token = 'ab'.repeat(24);
  fs.writeFileSync(path.join(root, 'manager-token'), token + '\n');
  const real = await fakeManager(root);
  const silent = await fakeManager(root, null, { proof: null });                                 // no proof at all
  const wrong = await fakeManager(root, null, { proof: (n, p) => pingProof('ef'.repeat(24), n, p) }); // another token
  // a relay: passes the nonce to the REAL manager and returns its proof - which is for the real port
  const relay = await fakeManager(root, null, { proof: (n) => pingProof(token, n, real.port) });
  try {
    for (const fake of [silent, wrong, relay]) {
      writeManagerFile(root, { pid: 1, port: fake.port });
      assert.equal(await client.findManager(root), null, 'port ' + fake.port);
      assert.equal(await client.findManager(root, { port: fake.port }), null);
      const p = await client.ping(fake.port, 2000, token);
      assert.equal(p.verified, false);
      assert.equal(fake.seen.some((s) => s.headers['x-devbox-token']), false, 'the token was never sent');
    }
    writeManagerFile(root, { pid: 1, port: real.port });
    assert.equal((await client.findManager(root)).port, real.port);
    assert.equal((await client.ping(real.port, 2000, token)).verified, true);
    // the proof is bound to the nonce: each ping sends a fresh one
    const nonces = real.seen.filter((s) => /nonce=/.test(s.url)).map((s) => s.url);
    assert.equal(new Set(nonces).size, nonces.length);
  } finally { for (const f of [real, silent, wrong, relay]) await f.close(); rm(root); }
});

test('connect: uses a running manager (no start); refuses when none runs and start is false', async () => {
  const root = tempRoot();
  const token = 'cd'.repeat(24);
  const mine = await fakeManager(root, {
    'GET /api/state': (req, reply) => reply(req.headers['x-devbox-token'] === token ? 200 : 401, req.headers['x-devbox-token'] === token ? { ok: true, vms: [] } : { ok: false, error: 'missing or wrong access token', code: 'UNAUTHORIZED' }),
  });
  try {
    await assert.rejects(client.connect({ root: root, start: false }), /not running for/);
    writeManagerFile(root, { pid: 1, port: mine.port });
    fs.writeFileSync(path.join(root, 'manager-token'), token + '\n');
    const c = await client.connect({ root: root, start: false });
    assert.equal(c.port, mine.port);
    assert.equal(c.url, 'http://127.0.0.1:' + mine.port + '/');
    assert.equal(c.started, false);
    assert.deepEqual(await c.get('/api/state'), { ok: true, vms: [] });
    // the token is read per call: a rotated token file is picked up
    fs.writeFileSync(path.join(root, 'manager-token'), 'ef'.repeat(24) + '\n');
    await assert.rejects(c.get('/api/state'), (e) => e.status === 401 && e.code === 'UNAUTHORIZED');
  } finally { await mine.close(); rm(root); }
});

test('client calls: token + JSON headers, API errors carry status, code and body', async () => {
  const root = tempRoot();
  const mine = await fakeManager(root, {
    'POST /api/vm/start': (req, reply, body) => reply(202, { ok: true, task: { id: 'T1', echo: JSON.parse(body) } }),
    'POST /api/vm/stop': (req, reply) => reply(409, { ok: false, error: 'busy: "Start a" on a is still running', code: 'BUSY', holder: { id: 'T1' } }),
    'GET /api/weird': (req, reply) => reply(200, { ok: false, error: 'refused', code: 'NOPE' }),
    'GET /api/html': (req, reply) => reply(500, '<html>oops</html>'),
  });
  try {
    const c = client.createClient({ root: root, port: mine.port, token: 'ab'.repeat(24) });
    const r = await c.post('/api/vm/start', { name: 'a', note: 'ünï' });
    assert.deepEqual(r.task.echo, { name: 'a', note: 'ünï' });
    const last = mine.seen[mine.seen.length - 1];
    assert.equal(last.headers['x-devbox-token'], 'ab'.repeat(24));
    assert.equal(last.headers['content-type'], 'application/json');
    assert.equal(last.headers.host, '127.0.0.1:' + mine.port, 'the Host the manager allows');
    await assert.rejects(c.post('/api/vm/stop', { name: 'a' }), (e) => e.status === 409 && e.code === 'BUSY' && e.body.holder.id === 'T1' && /busy/.test(e.message));
    await assert.rejects(c.get('/api/weird'), (e) => e.status === 200 && e.code === 'NOPE' && e.message === 'refused');
    await assert.rejects(c.get('/api/html'), (e) => e.status === 500 && /HTTP 500 from GET \/api\/html: <html>oops/.test(e.message));
    const dead = client.createClient({ root: root, port: 1, token: 'x' });
    await assert.rejects(dead.get('/api/state'), (e) => !e.status);
  } finally { await mine.close(); rm(root); }
});

test('waitForTask: done, still running at the deadline, forgotten task, transient errors', async () => {
  const seq = (list) => {
    let i = 0;
    return { get: async () => { const x = list[Math.min(i++, list.length - 1)]; if (x instanceof Error) throw x; return { ok: true, task: x }; } };
  };
  const done = await client.waitForTask(seq([{ id: 'a', status: 'running' }, { id: 'a', status: 'running' }, { id: 'a', status: 'done', result: 1 }]), 'a', { pollMs: 1, timeoutMs: 5000 });
  assert.equal(done.status, 'done');
  const slow = await client.waitForTask(seq([{ id: 'b', status: 'running', step: 'booting' }]), 'b', { pollMs: 5, timeoutMs: 40 });
  assert.equal(slow.status, 'running');
  assert.equal(slow.step, 'booting');
  const seen = [];
  await client.waitForTask(seq([{ id: 'c', status: 'error', error: 'x' }]), 'c', { onUpdate: (t) => seen.push(t.status) });
  assert.deepEqual(seen, ['error']);
  const gone = new Error('no task'); gone.status = 404;
  await assert.rejects(client.waitForTask(seq([gone]), 'd', { pollMs: 1 }), (e) => e.code === 'TASK_GONE');
  const blip = new Error('socket hang up'); blip.code = 'ECONNRESET';
  const ok = await client.waitForTask(seq([blip, blip, { id: 'e', status: 'done' }]), 'e', { pollMs: 1 });
  assert.equal(ok.status, 'done');
  await assert.rejects(client.waitForTask(seq([blip]), 'f', { pollMs: 1, timeoutMs: 60000 }), /socket hang up/, 'gives up after repeated failures');
  const zero = await client.waitForTask(seq([{ id: 'g', status: 'running' }]), 'g', { timeoutMs: 0 });
  assert.equal(zero.status, 'running', 'timeoutMs 0 = look once');
});

test('consoleTail returns the last lines of the headless manager output', () => {
  const root = tempRoot();
  try {
    assert.equal(client.consoleTail(root), '');
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(client.consoleLogFile(root), 'a\nb\n\nc\r\nd\n');
    assert.equal(client.consoleTail(root, 2), 'c\nd');
    // the tail ends up in MCP errors: never with the access token (security-4)
    const tok = '0123456789abcdef'.repeat(3);
    fs.appendFileSync(client.consoleLogFile(root), '  Open: http://127.0.0.1:8777/#token=' + tok + '\n');
    const tail = client.consoleTail(root, 1);
    assert.equal(tail.indexOf(tok), -1, tail);
    assert.match(tail, /#token=<hidden/);
  } finally { rm(root); }
});
