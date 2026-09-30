'use strict';
/*
 * Follow a file another process is appending to (QEMU writes console.log,
 * stdout.log and stderr.log itself; on Windows it opens them with read
 * sharing). Polling, not fs.watch: change notifications for a file held
 * open by another process are unreliable on Windows, and a 20 ms poll of
 * three files costs nothing measurable.
 *
 *   const t = new FileTail(file, (buf) => ..., {intervalMs: 20})
 *   t.start()        begin polling (the file may not exist yet)
 *   t.readNow()      read everything available right now (sync)
 *   t.stop()         final read, close
 *   t.bytes          bytes delivered so far
 *
 * LineSplitter turns chunks into complete lines (the last partial line is
 * kept until its newline arrives or flush()).
 */
const fs = require('fs');

class FileTail {
  constructor(file, onData, opts) {
    opts = opts || {};
    this.file = file;
    this.onData = onData;
    this.intervalMs = opts.intervalMs || 20;
    this.maxChunk = opts.maxChunk || 1 << 20;
    this.fd = null;
    this.pos = opts.fromByte || 0;
    this.bytes = 0;
    this.timer = null;
    this.buf = Buffer.alloc(Math.min(this.maxChunk, 1 << 16));
  }

  _open() {
    if (this.fd !== null) return true;
    try { this.fd = fs.openSync(this.file, 'r'); return true; } catch (e) { return false; }
  }

  readNow() {
    if (!this._open()) return 0;
    let total = 0;
    for (;;) {
      let n;
      try { n = fs.readSync(this.fd, this.buf, 0, this.buf.length, this.pos); } catch (e) { break; }
      if (n <= 0) break;
      this.pos += n;
      total += n;
      this.bytes += n;
      // copy: the read buffer is reused
      try { this.onData(Buffer.from(this.buf.subarray(0, n))); } catch (e) { /* a consumer error must not stop the tail */ }
      if (n < this.buf.length) break;
    }
    return total;
  }

  start() {
    if (this.timer) return this;
    const tick = () => {
      this.readNow();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    tick();
    return this;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.readNow();
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* closed */ } }
    this.fd = null;
  }
}

class LineSplitter {
  constructor(onLine, opts) {
    this.onLine = onLine;
    this.rest = '';
    this.maxLine = (opts && opts.maxLine) || 64 * 1024; // guest output is untrusted: bound it
  }

  push(buf) {
    this.rest += buf.toString('utf8');
    let i;
    while ((i = this.rest.indexOf('\n')) >= 0) {
      this.onLine(this.rest.slice(0, i).replace(/\r$/, ''));
      this.rest = this.rest.slice(i + 1);
    }
    if (this.rest.length > this.maxLine) { this.onLine(this.rest.slice(0, this.maxLine)); this.rest = ''; }
  }

  flush() {
    if (this.rest) this.onLine(this.rest.replace(/\r$/, ''));
    this.rest = '';
  }
}

module.exports = { FileTail, LineSplitter };
