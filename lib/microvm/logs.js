'use strict';
/*
 * Container logs (microVM spec section 7.5): the files QEMU writes in the
 * run directory, read by the API.
 *
 *   logFile(runDir, stream, prev)  stdout | stderr | console | qemu
 *                                  (prev: the previous boot's copy, kept by
 *                                  run.rotateLogs; qemu has none)
 *   readLog(runDir, q)             GET /api/container/logs: only the last
 *                                  256 KB is read, then the last `tail`
 *                                  lines (default 300, max 5000)
 *   follow(req, res, o)            GET /api/container/logs/stream: SSE in
 *                                  the terminal-session format - {t, n}
 *                                  chunks where n is the BYTE offset after
 *                                  the chunk (reconnect with ?since=n),
 *                                  {reset: true, n: 0} when the file was
 *                                  replaced by a new boot, a comment ping
 *                                  every 15 s, and {exit: code, n} at the
 *                                  end. The file is polled only while a
 *                                  client is connected.
 *
 * Everything in these files was written by the guest: it is untrusted text.
 * It is never parsed here and the GUI shows it with textContent.
 */
const fs = require('fs');
const path = require('path');
const { tailFile, clampInt, badRequest } = require('../util');
const { FileTail } = require('./tail');

const STREAMS = ['stdout', 'stderr', 'console', 'qemu'];
const MAX_READ = 256 * 1024;

function checkStream(stream, def) {
  const s = stream === undefined || stream === null || stream === '' ? def : String(stream);
  if (!STREAMS.includes(s)) throw badRequest('stream must be one of ' + STREAMS.join(', '));
  return s;
}

function logFile(runDir, stream, prev) {
  const s = checkStream(stream, 'stdout');
  if (prev && s === 'qemu') throw badRequest('the QEMU log of the previous boot is not kept');
  return path.join(runDir, s + (prev ? '.prev' : '') + '.log');
}

// q: {stream, tail, prev} -> {stream, prev, text, size, truncated}
function readLog(runDir, q) {
  q = q || {};
  const stream = checkStream(q.stream, 'stdout');
  // exact: the app's output byte for byte (MCP run_image returns it as the
  // one-shot result); the serial console's CRLFs are still normalised.
  // Guest text is untrusted and only ever shown as text.
  const exact = stream === 'stdout' || stream === 'stderr';
  const r = tailFile(logFile(runDir, stream, q.prev), { maxBytes: MAX_READ, lines: clampInt(q.tail, 1, 5000, 300), exact: exact });
  return { stream, prev: !!q.prev, text: r.text, size: r.size, truncated: !!r.truncated, exists: r.exists };
}

function sizes(runDir) {
  const out = {};
  for (const s of STREAMS) {
    try { out[s] = fs.statSync(path.join(runDir, s + '.log')).size; } catch (e) { out[s] = 0; }
  }
  return out;
}

// Length of `buf` without an incomplete UTF-8 sequence at its end.
function utf8Complete(buf) {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
  if (i < 0) return buf.length;
  const b = buf[i];
  const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? i : buf.length;
}

function sse(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); return true; } catch (e) { return false; } }

// o: {runDir, stream, since, isLive() -> bool, exitCode() -> code|null,
//     pollMs (250)}
function follow(req, res, o) {
  const file = logFile(o.runDir, o.stream, false);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  let since = parseInt(o.since, 10);
  if (!(since >= 0)) since = 0;
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { size = 0; }
  if (since > size) {
    // the file is shorter than what the client has: a new boot replaced it
    sse(res, { reset: true, n: 0 });
    since = 0;
  }
  let offset = since;       // bytes delivered as text so far
  let pending = Buffer.alloc(0);
  let batch = '';
  let batchTimer = null;
  let closed = false;
  const flush = () => {
    clearTimeout(batchTimer);
    batchTimer = null;
    if (batch) { sse(res, { t: batch, n: offset }); batch = ''; }
  };
  const tail = new FileTail(file, (buf) => {
    const all = pending.length ? Buffer.concat([pending, buf]) : buf;
    const cut = utf8Complete(all);
    pending = all.subarray(cut);
    if (!cut) return;
    batch += all.subarray(0, cut).toString('utf8');
    offset += cut;
    if (batch.length >= 16384) flush();
    else if (!batchTimer) batchTimer = setTimeout(flush, 40);
  }, { intervalMs: o.pollMs || 250, fromByte: since });
  tail.start();
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 15000);
  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearInterval(liveTimer);
    tail.stop();
    flush();
    sse(res, { exit: o.exitCode ? o.exitCode() : null, n: offset });
    try { res.end(); } catch (e) { /* gone */ }
  };
  // the end of the container ends the stream (after a last read)
  const liveTimer = setInterval(() => { if (!o.isLive || !o.isLive()) end(); }, 1000);
  if (o.isLive && !o.isLive()) setTimeout(end, 50);
  const gone = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearInterval(liveTimer);
    clearTimeout(batchTimer);
    tail.stop();
  };
  req.on('close', gone);
  res.on('error', gone);
}

module.exports = { STREAMS, logFile, readLog, sizes, follow, utf8Complete, checkStream };
