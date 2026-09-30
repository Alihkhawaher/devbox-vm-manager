'use strict';
/*
 * 9P2000.L wire protocol pieces shared by the server and the test client:
 * message numbers, protocol constants, Linux errno values and a
 * bounds-checked reader / growable writer for message bodies.
 *
 * Frame layout (all integers little-endian):  size[4] type[1] tag[2] body...
 * where size counts the whole frame including itself. Strings are len[2]
 * followed by that many UTF-8 bytes; a qid is type[1] version[4] path[8].
 */

// ---- message numbers ------------------------------------------------------
const T = {
  Tlerror: 6, Rlerror: 7,
  Tstatfs: 8, Rstatfs: 9,
  Tlopen: 12, Rlopen: 13,
  Tlcreate: 14, Rlcreate: 15,
  Tsymlink: 16, Rsymlink: 17,
  Tmknod: 18, Rmknod: 19,
  Trename: 20, Rrename: 21,
  Treadlink: 22, Rreadlink: 23,
  Tgetattr: 24, Rgetattr: 25,
  Tsetattr: 26, Rsetattr: 27,
  Txattrwalk: 30, Rxattrwalk: 31,
  Txattrcreate: 32, Rxattrcreate: 33,
  Treaddir: 40, Rreaddir: 41,
  Tfsync: 50, Rfsync: 51,
  Tlock: 52, Rlock: 53,
  Tgetlock: 54, Rgetlock: 55,
  Tlink: 70, Rlink: 71,
  Tmkdir: 72, Rmkdir: 73,
  Trenameat: 74, Rrenameat: 75,
  Tunlinkat: 76, Runlinkat: 77,
  Tversion: 100, Rversion: 101,
  Tauth: 102, Rauth: 103,
  Tattach: 104, Rattach: 105,
  Terror: 106, Rerror: 107,
  Tflush: 108, Rflush: 109,
  Twalk: 110, Rwalk: 111,
  Topen: 112, Ropen: 113,
  Tcreate: 114, Rcreate: 115,
  Tread: 116, Rread: 117,
  Twrite: 118, Rwrite: 119,
  Tclunk: 120, Rclunk: 121,
  Tremove: 122, Rremove: 123,
  Tstat: 124, Rstat: 125,
  Twstat: 126, Rwstat: 127,
};
const TYPE_NAME = {};
for (const k of Object.keys(T)) TYPE_NAME[T[k]] = k;

const VERSION = '9P2000.L';
const NOTAG = 0xffff;
const NOFID = 0xffffffff;
const HDR = 7; // size[4] type[1] tag[2]
const MAXWELEM = 16;
const IOHDRSZ = 24; // what Linux reserves per Tread/Twrite frame (msize - IOHDRSZ = iounit)
const V9FS_MAGIC = 0x01021997;

// qid.type bits
const QT = { DIR: 0x80, APPEND: 0x40, EXCL: 0x20, MOUNT: 0x10, AUTH: 0x08, TMP: 0x04, SYMLINK: 0x02, LINK: 0x01, FILE: 0x00 };
// readdir d_type values
const DT = { UNKNOWN: 0, FIFO: 1, CHR: 2, DIR: 4, BLK: 6, REG: 8, LNK: 10, SOCK: 12 };

// Tlopen / Tlcreate flags (Linux x86 octal open(2) values, as the kernel sends them)
const L = {
  O_RDONLY: 0o0, O_WRONLY: 0o1, O_RDWR: 0o2, O_NOACCESS: 0o3, O_ACCMODE: 0o3,
  O_CREAT: 0o100, O_EXCL: 0o200, O_NOCTTY: 0o400, O_TRUNC: 0o1000, O_APPEND: 0o2000,
  O_NONBLOCK: 0o4000, O_DSYNC: 0o10000, O_FASYNC: 0o20000, O_DIRECT: 0o40000,
  O_LARGEFILE: 0o100000, O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000,
  O_NOATIME: 0o1000000, O_CLOEXEC: 0o2000000, O_SYNC: 0o4000000,
};

// Tgetattr request_mask / Rgetattr valid bits
const GETATTR = {
  MODE: 0x1, NLINK: 0x2, UID: 0x4, GID: 0x8, RDEV: 0x10, ATIME: 0x20, MTIME: 0x40, CTIME: 0x80,
  INO: 0x100, SIZE: 0x200, BLOCKS: 0x400, BTIME: 0x800, GEN: 0x1000, DATA_VERSION: 0x2000,
  BASIC: 0x7ff, ALL: 0x3fff,
};
// Tsetattr valid bits
const SETATTR = {
  MODE: 0x1, UID: 0x2, GID: 0x4, SIZE: 0x8, ATIME: 0x10, MTIME: 0x20, CTIME: 0x40,
  ATIME_SET: 0x80, MTIME_SET: 0x100,
};
const AT_REMOVEDIR = 0x200;
const LOCK_TYPE = { RDLCK: 0, WRLCK: 1, UNLCK: 2 };
const LOCK_STATUS = { SUCCESS: 0, BLOCKED: 1, ERROR: 2, GRACE: 3 };

// Linux errno numbers (asm-generic). The guest kernel hands these to programs.
const ERRNO = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9,
  ECHILD: 10, EAGAIN: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, ENOTBLK: 15, EBUSY: 16,
  EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23,
  EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30,
  EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, EDEADLK: 35, ENAMETOOLONG: 36, ENOLCK: 37,
  ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40, ENODATA: 61, ENOSTR: 60, ETIME: 62, ENOLINK: 67,
  EPROTO: 71, EBADMSG: 74, EOVERFLOW: 75, EBADFD: 77, EILSEQ: 84, EUSERS: 87,
  ENOTSOCK: 88, EMSGSIZE: 90, EPROTONOSUPPORT: 93, EOPNOTSUPP: 95, ENOTSUP: 95,
  EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETDOWN: 100, ENETUNREACH: 101, ECONNABORTED: 103,
  ECONNRESET: 104, ENOBUFS: 105, ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111,
  EHOSTUNREACH: 113, EALREADY: 114, ESTALE: 116, EDQUOT: 122, ECANCELED: 125,
};
const ERRNO_NAME = {};
for (const k of Object.keys(ERRNO)) if (!ERRNO_NAME[ERRNO[k]]) ERRNO_NAME[ERRNO[k]] = k;
ERRNO_NAME[95] = 'EOPNOTSUPP';

class ProtoError extends Error {
  constructor(msg, errno) { super(msg); this.name = 'ProtoError'; this.errno = errno || ERRNO.EINVAL; }
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// Bounds-checked reader over one frame. Any read past the end throws a
// ProtoError (EINVAL), which the server turns into Rlerror instead of a crash.
class Reader {
  constructor(buf, off) { this.buf = buf; this.off = off === undefined ? HDR : off; }
  need(n) {
    if (this.off + n > this.buf.length) throw new ProtoError('message truncated');
  }
  get remaining() { return this.buf.length - this.off; }
  u8() { this.need(1); return this.buf[this.off++]; }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return v; }
  // u64 that must fit a JS safe integer (offsets, sizes); larger -> errno
  u64n(errno) {
    const v = this.u64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtoError('64-bit value out of range', errno || ERRNO.EINVAL);
    return Number(v);
  }
  bytes(n) { this.need(n); const b = this.buf.subarray(this.off, this.off + n); this.off += n; return b; }
  rawStr() { const n = this.u16(); return this.bytes(n); }
  // lenient string (version, uname, aname, lock client ids)
  str() { return this.rawStr().toString('utf8'); }
  // file names / link targets: must be valid UTF-8 (a name that cannot be
  // decoded could otherwise alias another one after replacement characters)
  name() {
    const b = this.rawStr();
    try { return strictUtf8.decode(b); } catch (e) { throw new ProtoError('name is not valid UTF-8', ERRNO.EILSEQ); }
  }
  qid() { return { type: this.u8(), version: this.u32(), path: this.u64() }; }
}

// Growable writer that produces one complete frame.
class Writer {
  constructor(type, tag, cap) {
    this.buf = Buffer.allocUnsafe(Math.max(cap || 64, 16));
    this.pos = HDR;
    this.type = type;
    this.tag = tag;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.buf.copy(nb, 0, 0, this.pos);
    this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; return this; }
  u16(v) { this.ensure(2); this.buf.writeUInt16LE(v & 0xffff, this.pos); this.pos += 2; return this; }
  u32(v) { this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; return this; }
  u64(v) {
    this.ensure(8);
    this.buf.writeBigUInt64LE(BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(Math.trunc(v))), this.pos);
    this.pos += 8;
    return this;
  }
  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; return this; }
  str(s) {
    const n = Buffer.byteLength(s, 'utf8');
    if (n > 0xffff) throw new ProtoError('string too long', ERRNO.ENAMETOOLONG);
    this.u16(n);
    this.ensure(n);
    this.buf.write(s, this.pos, n, 'utf8');
    this.pos += n;
    return this;
  }
  qid(q) { return this.u8(q.type).u32(q.version).u64(q.path); }
  finish() {
    this.buf.writeUInt32LE(this.pos, 0);
    this.buf[4] = this.type;
    this.buf.writeUInt16LE(this.tag, 5);
    return this.buf.subarray(0, this.pos);
  }
}

function strSize(s) { return 2 + Buffer.byteLength(s, 'utf8'); }

module.exports = {
  T, TYPE_NAME, VERSION, NOTAG, NOFID, HDR, MAXWELEM, IOHDRSZ, V9FS_MAGIC,
  QT, DT, L, GETATTR, SETATTR, AT_REMOVEDIR, LOCK_TYPE, LOCK_STATUS,
  ERRNO, ERRNO_NAME, ProtoError, Reader, Writer, strSize,
};
