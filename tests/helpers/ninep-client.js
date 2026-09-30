'use strict';
/*
 * tests/helpers/ninep-client.js - a minimal 9P2000.L client over TCP, for tests and
 * diagnostics of lib/ninep/server.js (not a test file). One connection, any number of concurrent
 * requests (tags are allocated automatically or given explicitly), and an
 * Rlerror reply rejects with an Error carrying .errno (Linux number) and
 * .code ("ENOENT", ...).
 *
 *   const c = await NinepClient.connect({ port });
 *   await c.version(512 * 1024);
 *   await c.attach(0, 'share:secret');
 *   const qids = await c.walk(0, 1, ['dir', 'file.txt']);
 */
const net = require('net');
const { EventEmitter } = require('events');
const P = require('../../lib/ninep/proto');

const { T, Reader, Writer, NOFID, NOTAG } = P;

class NinepError extends Error {
  constructor(errno, reqType) {
    const code = P.ERRNO_NAME[errno] || ('E' + errno);
    super(code + ' (' + errno + ') from ' + (P.TYPE_NAME[reqType] || reqType));
    this.name = 'NinepError';
    this.errno = errno;
    this.code = code;
  }
}

class NinepClient extends EventEmitter {
  static connect(opts) {
    const o = Object.assign({ host: '127.0.0.1', timeoutMs: 10000 }, opts || {});
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: o.host, port: o.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, o.timeoutMs);
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        resolve(new NinepClient(sock));
      });
    });
  }

  constructor(sock) {
    super();
    this.sock = sock;
    this.msize = 8192;
    this.pending = new Map();
    this.nextTag = 0;
    this.nextFidNo = 1;
    this.closed = false;
    this.chunks = [];
    this.total = 0;
    sock.setNoDelay(true);
    sock.on('data', (d) => this.onData(d));
    const gone = (e) => this.onClose(e);
    sock.on('error', gone);
    sock.on('close', () => gone());
    this.closedPromise = new Promise((r) => sock.once('close', r));
  }

  get iounit() { return this.msize - P.IOHDRSZ; }
  newFid() { return this.nextFidNo++; }

  onData(d) {
    this.chunks.push(d);
    this.total += d.length;
    while (this.total >= 4) {
      if (this.chunks[0].length < 4) this.merge();
      const size = this.chunks[0].readUInt32LE(0);
      if (size < P.HDR) { this.sock.destroy(); return; }
      if (this.total < size) break;
      if (this.chunks[0].length < size) this.merge(); // one copy per frame, only once it is complete
      const head = this.chunks[0];
      const frame = head.subarray(0, size);
      if (head.length === size) this.chunks.shift(); else this.chunks[0] = head.subarray(size);
      this.total -= size;
      const type = frame[4];
      const tag = frame.readUInt16LE(5);
      const p = this.pending.get(tag);
      this.emit('frame', { type, tag, frame });
      if (!p) continue;
      this.pending.delete(tag);
      if (type === T.Rlerror) p.reject(new NinepError(frame.readUInt32LE(7), p.type));
      else if (type !== p.type + 1) p.reject(new Error('unexpected reply ' + (P.TYPE_NAME[type] || type) + ' to ' + (P.TYPE_NAME[p.type] || p.type)));
      else p.resolve(new Reader(frame, P.HDR));
    }
  }

  merge() {
    const b = Buffer.concat(this.chunks, this.total);
    this.chunks = [b];
  }

  onClose(e) {
    if (this.closed) return;
    this.closed = true;
    const err = Object.assign(new Error('connection closed' + (e ? ': ' + e.message : '')), { code: 'ECONNRESET' });
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.emit('close');
  }

  allocTag() {
    for (let i = 0; i < 0xffff; i++) {
      const t = this.nextTag;
      this.nextTag = (this.nextTag + 1) % 0xffff;
      if (!this.pending.has(t)) return t;
    }
    throw new Error('no free tags');
  }

  // Send one request; fill(w) writes the body. Resolves with a Reader positioned at the reply body.
  rpc(type, fill, opts) {
    if (this.closed) return Promise.reject(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }));
    const tag = opts && opts.tag !== undefined ? opts.tag : this.allocTag();
    const w = new Writer(type, tag, 64);
    if (fill) fill(w);
    const frame = w.finish();
    const pr = new Promise((resolve, reject) => this.pending.set(tag, { resolve, reject, type }));
    pr.tag = tag;
    this.sock.write(frame);
    return pr;
  }

  rawSend(buf) { this.sock.write(buf); }

  close() {
    if (!this.closed) this.sock.end();
    return this.closedPromise;
  }

  destroy() { this.sock.destroy(); return this.closedPromise; }

  // ---- messages ----
  async version(msize, version) {
    const r = await this.rpc(T.Tversion, (w) => w.u32(msize || 65536).str(version || P.VERSION), { tag: NOTAG });
    const res = { msize: r.u32(), version: r.str() };
    if (res.version === P.VERSION) this.msize = res.msize;
    return res;
  }

  async auth(afid, uname, aname, nuname) {
    const r = await this.rpc(T.Tauth, (w) => w.u32(afid).str(uname || '').str(aname || '').u32(nuname || 0));
    return r.qid();
  }

  async attach(fid, aname, o) {
    o = o || {};
    const r = await this.rpc(T.Tattach, (w) => w.u32(fid).u32(o.afid === undefined ? NOFID : o.afid)
      .str(o.uname || 'root').str(aname).u32(o.nuname || 0));
    return r.qid();
  }

  flush(oldtag) { return this.rpc(T.Tflush, (w) => w.u16(oldtag)).then(() => undefined); }

  async walk(fid, newfid, names) {
    const r = await this.rpc(T.Twalk, (w) => { w.u32(fid).u32(newfid).u16(names.length); for (const n of names) w.str(n); });
    const n = r.u16();
    const qids = [];
    for (let i = 0; i < n; i++) qids.push(r.qid());
    return qids;
  }

  async lopen(fid, flags) {
    const r = await this.rpc(T.Tlopen, (w) => w.u32(fid).u32(flags || 0));
    return { qid: r.qid(), iounit: r.u32() };
  }

  async lcreate(fid, name, flags, mode, gid) {
    const r = await this.rpc(T.Tlcreate, (w) => w.u32(fid).str(name).u32(flags === undefined ? P.L.O_RDWR : flags)
      .u32(mode === undefined ? 0o644 : mode).u32(gid || 0));
    return { qid: r.qid(), iounit: r.u32() };
  }

  async read(fid, offset, count, opts) {
    const r = await this.rpc(T.Tread, (w) => w.u32(fid).u64(BigInt(offset)).u32(count), opts);
    const n = r.u32();
    return Buffer.from(r.bytes(n));
  }

  async write(fid, offset, data, opts) {
    const r = await this.rpc(T.Twrite, (w) => w.u32(fid).u64(BigInt(offset)).u32(data.length).bytes(data), opts);
    return r.u32();
  }

  clunk(fid) { return this.rpc(T.Tclunk, (w) => w.u32(fid)).then(() => undefined); }
  remove(fid) { return this.rpc(T.Tremove, (w) => w.u32(fid)).then(() => undefined); }

  async getattr(fid, mask) {
    const r = await this.rpc(T.Tgetattr, (w) => w.u32(fid).u64(BigInt(mask === undefined ? P.GETATTR.ALL : mask)));
    const a = { valid: r.u64(), qid: r.qid(), mode: r.u32(), uid: r.u32(), gid: r.u32() };
    a.nlink = Number(r.u64());
    a.rdev = Number(r.u64());
    a.size = Number(r.u64());
    a.blksize = Number(r.u64());
    a.blocks = Number(r.u64());
    const t = () => ({ sec: Number(r.u64()), nsec: Number(r.u64()) });
    a.atime = t(); a.mtime = t(); a.ctime = t(); a.btime = t();
    a.gen = r.u64();
    a.dataVersion = r.u64();
    return a;
  }

  // attrs: {mode, uid, gid, size, atime: 'now' | [sec, nsec], mtime: same, ctime: true}
  setattr(fid, attrs) {
    const S = P.SETATTR;
    let valid = 0;
    const a = attrs || {};
    if (a.mode !== undefined) valid |= S.MODE;
    if (a.uid !== undefined) valid |= S.UID;
    if (a.gid !== undefined) valid |= S.GID;
    if (a.size !== undefined) valid |= S.SIZE;
    if (a.ctime) valid |= S.CTIME;
    let at = [0, 0];
    let mt = [0, 0];
    if (a.atime !== undefined) { valid |= S.ATIME; if (a.atime !== 'now') { valid |= S.ATIME_SET; at = a.atime; } }
    if (a.mtime !== undefined) { valid |= S.MTIME; if (a.mtime !== 'now') { valid |= S.MTIME_SET; mt = a.mtime; } }
    if (a.valid !== undefined) valid = a.valid;
    return this.rpc(T.Tsetattr, (w) => w.u32(fid).u32(valid).u32(a.mode || 0).u32(a.uid || 0).u32(a.gid || 0)
      .u64(BigInt(a.size || 0)).u64(BigInt(at[0])).u64(BigInt(at[1])).u64(BigInt(mt[0])).u64(BigInt(mt[1]))).then(() => undefined);
  }

  async readdir(fid, offset, count) {
    const r = await this.rpc(T.Treaddir, (w) => w.u32(fid).u64(BigInt(offset)).u32(count));
    const n = r.u32();
    const end = r.off + n;
    const out = [];
    while (r.off < end) out.push({ qid: r.qid(), offset: r.u64(), type: r.u8(), name: r.str() });
    return out;
  }

  async readdirAll(fid, count) {
    const all = [];
    let off = 0n;
    for (;;) {
      const page = await this.readdir(fid, off, count || 8192);
      if (!page.length) break;
      all.push(...page);
      off = page[page.length - 1].offset;
    }
    return all;
  }

  async mkdir(dfid, name, mode, gid) {
    const r = await this.rpc(T.Tmkdir, (w) => w.u32(dfid).str(name).u32(mode === undefined ? 0o755 : mode).u32(gid || 0));
    return r.qid();
  }

  unlinkat(dfid, name, flags) { return this.rpc(T.Tunlinkat, (w) => w.u32(dfid).str(name).u32(flags || 0)).then(() => undefined); }
  renameat(odfid, oname, ndfid, nname) { return this.rpc(T.Trenameat, (w) => w.u32(odfid).str(oname).u32(ndfid).str(nname)).then(() => undefined); }
  rename(fid, dfid, name) { return this.rpc(T.Trename, (w) => w.u32(fid).u32(dfid).str(name)).then(() => undefined); }

  async statfs(fid) {
    const r = await this.rpc(T.Tstatfs, (w) => w.u32(fid));
    return { type: r.u32(), bsize: r.u32(), blocks: r.u64(), bfree: r.u64(), bavail: r.u64(), files: r.u64(), ffree: r.u64(), fsid: r.u64(), namelen: r.u32() };
  }

  fsync(fid, datasync) { return this.rpc(T.Tfsync, (w) => w.u32(fid).u32(datasync || 0)).then(() => undefined); }

  async symlink(dfid, name, target, gid) {
    const r = await this.rpc(T.Tsymlink, (w) => w.u32(dfid).str(name).str(target).u32(gid || 0));
    return r.qid();
  }

  async readlink(fid) { const r = await this.rpc(T.Treadlink, (w) => w.u32(fid)); return r.str(); }
  link(dfid, fid, name) { return this.rpc(T.Tlink, (w) => w.u32(dfid).u32(fid).str(name)).then(() => undefined); }

  async mknod(dfid, name, mode, major, minor, gid) {
    const r = await this.rpc(T.Tmknod, (w) => w.u32(dfid).str(name).u32(mode).u32(major || 0).u32(minor || 0).u32(gid || 0));
    return r.qid();
  }

  async lock(fid, o) {
    o = o || {};
    const r = await this.rpc(T.Tlock, (w) => w.u32(fid).u8(o.type === undefined ? P.LOCK_TYPE.WRLCK : o.type).u32(o.flags || 0)
      .u64(BigInt(o.start || 0)).u64(BigInt(o.length || 0)).u32(o.procId || 1).str(o.clientId || 'test'));
    return r.u8();
  }

  async getlock(fid, o) {
    o = o || {};
    const r = await this.rpc(T.Tgetlock, (w) => w.u32(fid).u8(o.type === undefined ? P.LOCK_TYPE.WRLCK : o.type)
      .u64(BigInt(o.start || 0)).u64(BigInt(o.length || 0)).u32(o.procId || 1).str(o.clientId || 'test'));
    return { type: r.u8(), start: r.u64(), length: r.u64(), procId: r.u32(), clientId: r.str() };
  }

  async xattrwalk(fid, newfid, name) { const r = await this.rpc(T.Txattrwalk, (w) => w.u32(fid).u32(newfid).str(name)); return r.u64(); }
  xattrcreate(fid, name, size, flags) { return this.rpc(T.Txattrcreate, (w) => w.u32(fid).str(name).u64(BigInt(size || 0)).u32(flags || 0)).then(() => undefined); }

  // ---- conveniences ----
  // Write all of data starting at offset, `depth` requests in flight at once.
  async writeAll(fid, data, offset, depth) {
    const chunk = this.iounit;
    const base = offset || 0;
    let next = 0;
    const worker = async () => {
      while (next < data.length) {
        const at = next;
        next += chunk;
        const piece = data.subarray(at, Math.min(at + chunk, data.length));
        const n = await this.write(fid, base + at, piece);
        if (n !== piece.length) throw new Error('short write ' + n + '/' + piece.length);
      }
    };
    await Promise.all(Array.from({ length: depth || 1 }, worker));
    return data.length;
  }

  // Read the whole file (size known or read until a short/empty read).
  async readAll(fid, size, depth) {
    const chunk = this.iounit;
    if (size === undefined) {
      const parts = [];
      let off = 0;
      for (;;) {
        const b = await this.read(fid, off, chunk);
        if (!b.length) break;
        parts.push(b);
        off += b.length;
      }
      return Buffer.concat(parts);
    }
    const out = Buffer.alloc(size);
    let next = 0;
    const worker = async () => {
      while (next < size) {
        const at = next;
        next += chunk;
        const b = await this.read(fid, at, Math.min(chunk, size - at));
        b.copy(out, at);
        if (b.length < Math.min(chunk, size - at)) throw new Error('short read at ' + at);
      }
    };
    await Promise.all(Array.from({ length: depth || 1 }, worker));
    return out;
  }
}

module.exports = { NinepClient, NinepError, proto: P };
