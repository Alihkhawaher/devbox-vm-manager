'use strict';
/*
 * Minimal RFC 6455 WebSocket SERVER - enough to relay a VM's VNC display to
 * the browser. noVNC in the page opens a WebSocket to the manager; QEMU
 * listens with plain VNC on a private TCP endpoint (like the monitor socket,
 * see monitor.js); the manager pipes bytes between the two. Nothing here
 * knows about VNC: the module only frames and unframes.
 *
 * What is implemented: the opening handshake (accept()), unmasked server
 * frames, masked client frames (RFC 6455 section 5.1: a client frame that is
 * not masked is a protocol error), all three payload-length forms, fragment
 * reassembly, ping/pong and the close handshake. Not implemented on purpose:
 * extensions (permessage-deflate is never offered back, so it is never on),
 * UTF-8 validation of text frames, client mode.
 *
 * Safety: client payloads above MAX_FRAME (16 MB) are refused with close
 * 1009 and the socket destroyed, so a hostile page cannot make the manager
 * buffer unbounded data. Any protocol error ends with close 1002 and
 * destroy. No socket event handler can throw (every one is wrapped; failures
 * surface as the 'error' event), so a bad frame can never crash the manager.
 *
 * The framing helpers are pure (no I/O) and unit-tested in tests/ws.test.js:
 *   encodeFrame(payload, {opcode, fin}) -> Buffer   (server frame, unmasked)
 *   decodeFrames(buf) -> {frames: [{fin, opcode, payload}], rest} | {error}
 *   acceptKey(secWebSocketKey) -> Sec-WebSocket-Accept value
 *   closeFrame(code, reason) -> Buffer
 * accept(req, socket, head, opts) serves the http server's 'upgrade' event
 * and returns a small connection object (send/close/ping/on/socket), or null
 * after answering 400 to a request that is not a valid WebSocket upgrade.
 * `send` returns socket.write's boolean: false means the kernel buffer is
 * full and the caller should pause its source until socket's 'drain'.
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;
const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

// Server-to-client frame: never masked. opcode defaults to binary.
function encodeFrame(payload, opts) {
  const o = opts || {};
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const opcode = o.opcode == null ? OP.BINARY : o.opcode;
  const fin = o.fin === undefined ? true : !!o.fin;
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([head, data]);
}

// Parses every complete client frame in `buffer`; `rest` is the unread tail.
// Client frames must be masked; payloads are returned unmasked.
function decodeFrames(buffer) {
  const frames = [];
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  for (;;) {
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (rsv) return { error: 'reserved bits set' };
    if (!masked) return { error: 'unmasked frame' };
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) return { error: 'frame too large' };
      len = Number(big);
      off = 10;
    }
    if (len > MAX_FRAME) return { error: 'frame too large' };
    if (opcode >= OP.CLOSE && (!fin || len > 125)) return { error: 'bad control frame' };
    if (buf.length < off + 4 + len) break;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin, opcode, payload });
    buf = buf.subarray(off + 4 + len);
  }
  return { frames, rest: buf };
}

function closeFrame(code, reason) {
  const text = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code == null ? 1000 : code, 0);
  text.copy(body, 2);
  return encodeFrame(body, { opcode: OP.CLOSE });
}

// Tiny listener registry: on(event, fn); emit never lets a listener throw out.
function makeEmitter() {
  const listeners = {};
  const emitter = {
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return emitter; },
    emit(event, ...args) {
      for (const fn of listeners[event] || []) {
        try { fn(...args); } catch (e) { if (event !== 'error') emitter.emit('error', e); }
      }
    },
  };
  return emitter;
}

function lower(v) { return String(v || '').toLowerCase(); }

/*
 * Handles one http 'upgrade' event. opts.protocols: subprotocols we are
 * willing to echo (noVNC offers 'binary'); the first one the client offered
 * that we list is echoed, otherwise the header is omitted (RFC 6455 4.2.2).
 */
function accept(req, socket, head, opts) {
  const o = opts || {};
  const h = req.headers || {};
  const key = h['sec-websocket-key'];
  const upgradeOk = lower(h.upgrade) === 'websocket' &&
    lower(h.connection).split(/\s*,\s*/).includes('upgrade');
  if (!upgradeOk || String(h['sec-websocket-version'] || '').trim() !== '13' || !key) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) { /* gone */ }
    socket.destroy();
    return null;
  }
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key)];
  const offered = String(h['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const protocol = offered.find((p) => (o.protocols || []).includes(p));
  if (protocol) lines.push('Sec-WebSocket-Protocol: ' + protocol);
  socket.setNoDelay(true);
  socket.write(lines.join('\r\n') + '\r\n\r\n');

  const em = makeEmitter();
  let pending = Buffer.alloc(0);     // unparsed bytes
  let fragments = [];                // fragments of the message being reassembled
  let fragOpcode = 0;
  let fragBytes = 0;
  let closed = false;                // close frame sent or received
  let closeTimer = null;

  const ws = {
    socket,
    protocol: protocol || null,
    on: em.on,
    send(data) {
      if (closed || socket.destroyed) return false;
      return socket.write(encodeFrame(data, { opcode: Buffer.isBuffer(data) ? OP.BINARY : OP.TEXT }));
    },
    ping(data) {
      if (closed || socket.destroyed) return false;
      return socket.write(encodeFrame(data || Buffer.alloc(0), { opcode: OP.PING }));
    },
    // Sends a close frame; the socket ends after the peer's close or 1 s.
    close(code, reason) {
      if (closed) return;
      closed = true;
      try { socket.write(closeFrame(code, reason)); } catch (e) { /* ending anyway */ }
      closeTimer = setTimeout(() => socket.destroy(), 1000);
      closeTimer.unref();
    },
  };

  function fail(code, reason) {
    if (!closed) { closed = true; try { socket.write(closeFrame(code, reason)); } catch (e) { /* ignore */ } }
    socket.destroy();
    em.emit('close', code, reason);
  }

  function handleFrame(f) {
    switch (f.opcode) {
      case OP.CONT:
      case OP.TEXT:
      case OP.BINARY: {
        if (f.opcode === OP.CONT ? fragments.length === 0 : fragments.length > 0) return fail(1002, 'bad fragmentation');
        if (f.opcode !== OP.CONT) fragOpcode = f.opcode;
        fragments.push(f.payload);
        fragBytes += f.payload.length;
        if (fragBytes > MAX_FRAME) return fail(1009, 'message too large');
        if (!f.fin) return;
        const msg = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        fragments = []; fragBytes = 0;
        return em.emit('message', msg, fragOpcode === OP.BINARY);
      }
      case OP.PING:
        if (!closed) socket.write(encodeFrame(f.payload, { opcode: OP.PONG }));
        return;
      case OP.PONG:
        return em.emit('pong', f.payload);
      case OP.CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (!closed) { closed = true; try { socket.write(closeFrame(code === 1005 ? 1000 : code)); } catch (e) { /* ignore */ } }
        if (closeTimer) clearTimeout(closeTimer);
        socket.end();
        return em.emit('close', code, reason);
      }
      default:
        return fail(1002, 'unknown opcode');
    }
  }

  socket.on('data', (chunk) => {
    try {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const r = decodeFrames(pending);
      if (r.error) return fail(r.error === 'frame too large' ? 1009 : 1002, r.error);
      pending = r.rest;
      for (const f of r.frames) { handleFrame(f); if (socket.destroyed) break; }
    } catch (e) { em.emit('error', e); socket.destroy(); }
  });
  socket.on('error', (e) => em.emit('error', e));
  socket.on('close', () => {
    if (closeTimer) clearTimeout(closeTimer);
    if (!closed) { closed = true; em.emit('close', 1006, 'connection lost'); }
  });
  if (head && head.length) socket.emit('data', head);
  return ws;
}

module.exports = { encodeFrame, decodeFrames, acceptKey, closeFrame, accept, OP, MAX_FRAME };
