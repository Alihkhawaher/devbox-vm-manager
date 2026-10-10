'use strict';
/*
 * lib/ws.js: the pure framing helpers (all three length forms, the masking
 * rule, the RFC 6455 handshake example, the close frame layout) and one real
 * echo server driven by a hand-written client over `net`: handshake, masked
 * binary frame -> unmasked echo, fragmented message -> one 'message', masked
 * close -> close reply and the socket ends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const ws = require('../lib/ws');

// A client frame as a browser would send it: masked with a 4-byte key.
function clientFrame(payload, opcode, fin) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin === false ? 0 : 0x80) | (opcode == null ? 2 : opcode);
  const body = Buffer.from(data);
  for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

test('encodeFrame/decodeFrames: round trip for the three length forms', () => {
  for (const len of [0, 5, 125, 126, 300, 65535, 65536, 100000]) {
    const payload = Buffer.alloc(len, 0xab);
    const server = ws.encodeFrame(payload, { opcode: 2 });
    assert.equal(server.length, len + (len < 126 ? 2 : len < 65536 ? 4 : 10), 'header size for ' + len);
    assert.equal(server[0], 0x82);
    assert.equal(server[1] & 0x80, 0, 'server frames are unmasked');
    const r = ws.decodeFrames(clientFrame(payload, 2));
    assert.equal(r.error, undefined);
    assert.equal(r.frames.length, 1);
    assert.deepEqual(r.frames[0], { fin: true, opcode: 2, payload });
    assert.equal(r.rest.length, 0);
  }
});

test('decodeFrames: several frames, a partial tail, text and binary', () => {
  const a = clientFrame('hello', 1);
  const b = clientFrame(Buffer.from([1, 2, 3]), 2);
  const c = clientFrame('x'.repeat(200), 2);
  const r = ws.decodeFrames(Buffer.concat([a, b, c.subarray(0, 50)]));
  assert.equal(r.frames.length, 2);
  assert.equal(r.frames[0].opcode, 1);
  assert.equal(r.frames[0].payload.toString(), 'hello');
  assert.deepEqual([...r.frames[1].payload], [1, 2, 3]);
  assert.equal(r.rest.length, 50);
  const r2 = ws.decodeFrames(Buffer.concat([r.rest, c.subarray(50)]));
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].payload.length, 200);
});

test('decodeFrames: an unmasked client frame is a protocol error', () => {
  const r = ws.decodeFrames(ws.encodeFrame('hi', { opcode: 1 }));
  assert.equal(r.error, 'unmasked frame');
});

test('decodeFrames: refuses a frame above 16 MB without buffering it', () => {
  const head = Buffer.alloc(14);
  head[0] = 0x82; head[1] = 0x80 | 127;
  head.writeBigUInt64BE(BigInt(ws.MAX_FRAME + 1), 2);
  assert.equal(ws.decodeFrames(head).error, 'frame too large');
});

test('acceptKey: RFC 6455 section 1.3 example', () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('closeFrame: opcode 8, 2-byte code, UTF-8 reason', () => {
  const f = ws.closeFrame(1002, 'bad');
  assert.deepEqual([...f], [0x88, 5, 0x03, 0xea, 0x62, 0x61, 0x64]);
  assert.deepEqual([...ws.closeFrame(1000)], [0x88, 2, 0x03, 0xe8]);
});

// ---- end-to-end against a real http server ----------------------------------

function startEcho() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const events = [];
    srv.on('upgrade', (req, socket, head) => {
      const conn = ws.accept(req, socket, head, { protocols: ['binary'] });
      if (!conn) return;
      conn.on('message', (data, isBinary) => { events.push(['message', data.length, isBinary]); conn.send(data); });
      conn.on('close', (code, reason) => events.push(['close', code, reason]));
      conn.on('error', (e) => events.push(['error', e.message]));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, events }));
  });
}

function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /vnc HTTP/1.1\r\nHost: 127.0.0.1\r\n' + headers + '\r\n');
    });
    sock.on('error', reject);
    const chunks = [];
    let state = { data: Buffer.alloc(0), ended: false, waiters: [] };
    sock.on('data', (c) => { chunks.push(c); state.data = Buffer.concat(chunks); state.waiters.forEach((w) => w()); });
    sock.on('end', () => { state.ended = true; state.waiters.forEach((w) => w()); });
    sock.on('close', () => { state.closed = true; state.waiters.forEach((w) => w()); });
    // Resolves once pred(state) holds.
    state.until = (pred) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting')), 3000);
      const check = () => { if (pred(state)) { clearTimeout(t); res(); } };
      state.waiters.push(check); check();
    });
    resolve({ sock, state });
  });
}

const HANDSHAKE = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary, base64\r\n';

test('end to end: handshake, masked binary echo, fragmentation, close', async () => {
  const { srv, port, events } = await startEcho();
  try {
    const { sock, state } = await connect(port, HANDSHAKE);
    await state.until((s) => s.data.includes('\r\n\r\n'));
    const headEnd = state.data.indexOf('\r\n\r\n') + 4;
    const response = state.data.subarray(0, headEnd).toString();
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.match(response, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
    assert.match(response, /Sec-WebSocket-Protocol: binary\r\n/);
    let consumed = headEnd;

    // A masked binary frame comes back as an unmasked binary frame.
    const msg = Buffer.from([0x52, 0x46, 0x42, 0x20, 0x00, 0x03]);
    sock.write(clientFrame(msg, 2));
    const expected = ws.encodeFrame(msg, { opcode: 2 });
    await state.until((s) => s.data.length >= consumed + expected.length);
    assert.deepEqual(state.data.subarray(consumed, consumed + expected.length), expected);
    consumed += expected.length;

    // Two fragments (binary fin=false, continuation fin=true) -> one message.
    sock.write(clientFrame('abc', 2, false));
    sock.write(clientFrame('def', 0, true));
    const expected2 = ws.encodeFrame('abcdef', { opcode: 2 });
    await state.until((s) => s.data.length >= consumed + expected2.length);
    assert.deepEqual(state.data.subarray(consumed, consumed + expected2.length), expected2);
    consumed += expected2.length;
    assert.deepEqual(events.filter((e) => e[0] === 'message'), [['message', 6, true], ['message', 6, true]]);

    // A ping is answered with a pong carrying the same payload.
    sock.write(clientFrame('p1', 9));
    const pong = ws.encodeFrame('p1', { opcode: 10 });
    await state.until((s) => s.data.length >= consumed + pong.length);
    assert.deepEqual(state.data.subarray(consumed, consumed + pong.length), pong);
    consumed += pong.length;

    // Masked close -> close reply with our code, then the socket ends.
    const closeBody = Buffer.alloc(2 + 3); closeBody.writeUInt16BE(1000, 0); closeBody.write('bye', 2);
    sock.write(clientFrame(closeBody, 8));
    await state.until((s) => s.ended);
    assert.deepEqual([...state.data.subarray(consumed)], [...ws.closeFrame(1000)]);
    assert.deepEqual(events[events.length - 1], ['close', 1000, 'bye']);
    sock.end();
    await state.until((s) => s.closed);
  } finally {
    srv.close();
  }
});

test('end to end: a bad upgrade request gets 400 and no connection', async () => {
  const { srv, port, events } = await startEcho();
  try {
    const { sock, state } = await connect(port, 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\n');
    await state.until((s) => s.closed);
    assert.match(state.data.toString(), /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.equal(events.length, 0);
    sock.destroy();
  } finally {
    srv.close();
  }
});

test('end to end: an unmasked client frame closes with 1002', async () => {
  const { srv, port, events } = await startEcho();
  try {
    const { sock, state } = await connect(port, HANDSHAKE);
    await state.until((s) => s.data.includes('\r\n\r\n'));
    const headEnd = state.data.indexOf('\r\n\r\n') + 4;
    sock.write(ws.encodeFrame('oops', { opcode: 2 }));
    await state.until((s) => s.closed);
    assert.deepEqual([...state.data.subarray(headEnd)], [...ws.closeFrame(1002, 'unmasked frame')]);
    assert.deepEqual(events, [['close', 1002, 'unmasked frame']]);
  } finally {
    srv.close();
  }
});
