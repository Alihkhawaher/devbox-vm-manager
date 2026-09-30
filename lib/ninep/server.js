'use strict';
/*
 * lib/ninep/server.js - a 9P2000.L file server over TCP, for live two-way shared
 * folders between this PC and QEMU guests (Node standard library only).
 *
 * Why: the Windows QEMU build has neither virtfs/9p nor virtio-fs. Instead the
 * manager serves each shared folder itself and the guest kernel mounts it
 * through QEMU user networking (slirp maps guest 10.0.2.2 -> host 127.0.0.1):
 *
 *   mount -t 9p -o trans=tcp,port=<P>,version=9p2000.L,aname=<id>:<secret>,
 *                  msize=<n>,cache=<mode> 10.0.2.2 /mnt/x
 *
 * SECURITY MODEL
 *  - The server listens on 127.0.0.1 only (refuses other hosts unless
 *    allowNonLoopback). Every guest and every local process can connect, so
 *    the per-share secret carried in the attach name is the access control:
 *    aname = "<shareId>:<secret>" (or the secret alone). Secrets are compared
 *    as SHA-256 digests with crypto.timingSafeEqual against every share, a
 *    failed attach costs 100 ms and the connection is dropped after
 *    maxAuthFailures failures. A connection that has not attached within
 *    preAuthTimeoutMs is closed, and at most maxPreAuthConnections may wait
 *    unauthenticated (the oldest is dropped for a newcomer), so a hostile
 *    guest cannot hold every connection slot.
 *  - Jail: a fid never holds a host path string. It points at a node in a
 *    path tree rooted at the share's real root; every name added to the tree
 *    passes validateName() (no "", ".", "..", "/", NUL, and on Windows no
 *    "\\ : * ? \" < > |", control characters, trailing dot/space or DOS device
 *    names such as CON, NUL.txt, COM1, LPT9.log; names with "~<digit>" must
 *    not be 8.3 aliases of a different long name). ".." in Twalk moves to the
 *    parent node but never above the share root.
 *  - Links: symlinks and junctions are never walked through (Twalk stops
 *    with ENOTDIR), never opened (Tlopen -> ELOOP) and are shown to the guest
 *    as symlinks whose target the GUEST resolves in its own namespace.
 *    Readlink returns in-share targets as relative paths and anything outside
 *    the share as "/.devbox/link-outside-share" (host paths are not leaked).
 *    Everything that opens, creates, renames, links or changes a host object
 *    first resolves the containing directory (or the object) with
 *    fs.realpath and refuses (EACCES) anything whose real path leaves the
 *    share root (case-insensitive on Windows/macOS), then operates on the
 *    resolved path. Guest-created symlinks must be relative and must stay
 *    inside the share lexically (Windows resolves relative targets
 *    lexically), otherwise EPERM - e.g. `python -m venv` needs --copies.
 *    Moving a relative symlink somewhere its target would leave the share is
 *    refused too, and hard links to symlinks or directories are refused.
 *  - Races: operations that can make a link appear at an already-checked
 *    path (rename, renameat, symlink, link) take a server-wide exclusive
 *    lock; walks and the check-then-act part of every other path operation
 *    take it shared. A guest therefore cannot swap a directory for a link
 *    between our check and our use. Host processes can (pnpm turns
 *    node_modules directories into junctions), so the realpath check is
 *    repeated on every open/create/mutation and never cached. The one
 *    residue: Tgetattr of a fid walked BEFORE a host-side swap uses lstat of
 *    its path and may report the link target's metadata (never content).
 *  - Read-only shares refuse every mutating operation with EROFS (opens for
 *    writing or truncation, create, mkdir, symlink, link, mknod, rename,
 *    unlink, remove, setattr) and report no write permission bits.
 *  - Robustness: frames are length-checked before allocation (size < 7 or
 *    > msize closes the connection; until an attach succeeds the limit is
 *    64 KiB and only 2 requests may be in flight, so unauthenticated peers
 *    cannot make the server allocate much); message bodies are read with a
 *    bounds-checked reader so a malformed body yields Rlerror(EINVAL) and the
 *    connection keeps working; handler errors never escape a connection;
 *    requests that take longer than requestTimeoutMs are answered with
 *    ETIMEDOUT (the operation itself may still complete - the same caveat
 *    as an NFS soft mount).
 *  - Memory is bounded whatever a guest sends: per connection at most
 *    maxInflightPerConnection requests and maxRequestBytesPerConnection
 *    bytes of request frames + read/readdir reply buffers are in flight; no
 *    new request is started while more than WRITE_HIGH_WATER bytes of
 *    replies wait for the guest to read them (a guest that pipelines reads
 *    and never takes the replies stalls itself, not the server); the socket
 *    is paused while requests queue up. Directory listings keep a snapshot
 *    per open directory for stable paging; all snapshots together hold at
 *    most maxDirEntriesCached names (least recently used ones are dropped
 *    and transparently re-read), and open directories count as open files.
 *    Fids are capped per connection and per share, open files per
 *    connection and in total, connections in total and per share. With the
 *    defaults a hostile guest holding its share's secret can pin at most
 *    about 8 connections x (16 MiB + 2 x msize in flight/unsent + 5 x msize
 *    queued or half-received) ~ 190 MB of buffers, ~30 MB of fids and the shared
 *    ~60 MB listing cache - and a connection that stops reading or sending
 *    mid-frame is closed after stallTimeoutMs.
 *  - Dead peers: idle attached connections are NOT closed by default
 *    (idleTimeoutMs = 0) because the Linux 9p TCP transport never
 *    reconnects. TCP keepalive cannot notice a hung guest either (slirp's
 *    host socket belongs to the live QEMU process). A connection that OWES
 *    something - the rest of a partly received frame while we are reading,
 *    or taking replies we have queued - and makes no progress for
 *    stallTimeoutMs is closed (slow-loris, a hung or reset guest). Timeouts
 *    run on a clock that advances at most two sweep ticks per sweep, so a
 *    host sleep/hibernate does not time out every connection at wake-up.
 *    Connections left behind by a guest that rebooted inside the same QEMU
 *    process (slirp keeps their host side open, measured: idle mounts and
 *    mounts with open files survive `reboot -f` and a kernel panic) are
 *    closed as soon as the new boot mounts with a different
 *    uname=boot-<boot_id> (supersede()); untagged ones are reclaimed when the
 *    share reaches maxConnectionsPerShare (the least recently active idle
 *    connection of the share makes room - shares are per VM, so only the
 *    VM's own connections compete), and the manager can drop them all with
 *    disconnectShare(id) when it stops or restarts the VM.
 *
 * SEMANTICS AND CHOICES
 *  - qid.path is the 64-bit file id (fs.stat bigint ino) when the object is
 *    on the share root's volume, otherwise a server-lifetime id from a map
 *    (top bit set); objects without an inode number get a path-keyed id.
 *    qid.version = low 32 bits of (mtime in microseconds ^ size << 8).
 *  - Ownership: every object is reported as the share's uid:gid (default
 *    0:0). chown (Tsetattr uid/gid) is accepted and ignored so tools like
 *    cp -p, tar and rsync do not fail. Set uid/gid to the guest user.
 *  - Modes on Windows: directories 0755, files 0644, symlinks 0777. A file
 *    is 0755 when its name ends in .sh/.bash/.zsh/.ksh/.csh/.fish/.command/
 *    .run/.appimage, or when it has no extension and starts with "#!" or the
 *    ELF magic (read once per mtime+size, cached). The write bits follow the
 *    Windows read-only attribute, and chmod of a regular file sets/clears
 *    that attribute (the only mode bit Windows can store). Execute bits are
 *    not persisted, so git's filemode probe correctly concludes
 *    core.fileMode=false. On Linux/macOS hosts the real mode bits are used.
 *  - Readdir: the first Treaddir at offset 0 takes a snapshot of the
 *    directory ("." and ".." first); the offset of entry i is i+1, so
 *    offsets stay stable while paging even if the directory changes;
 *    offset 0 again re-reads it. Host names that the guest could not address
 *    (see validateName) are omitted. Entry types and qids come from lstat;
 *    entries deleted since the snapshot are skipped, and a page whose entries
 *    all vanished goes on with the next one (an empty reply would end the
 *    guest's listing early).
 *  - Rename follows POSIX: replaces a file, replaces an empty directory,
 *    ENOTEMPTY/EISDIR/ENOTDIR/EINVAL like Linux. Windows refuses to rename
 *    over a file that is open or read-only, so the target is first renamed
 *    aside and unlinked (POSIX delete semantics keep open handles working).
 *    Windows also refuses to rename a directory while files below it are
 *    open; when the open handles are this server's own, they are closed,
 *    the directory renamed and the files reopened at the new path, invisibly
 *    to the guest (reads/writes wait for the swap). Files held open by other
 *    Windows programs still make such a rename fail with EPERM.
 *    Fids below a renamed directory follow it (the path tree moves).
 *  - Tflush: requests cannot be aborted mid-syscall, so the reply to the
 *    flushed request is still sent (Linux accepts it) and Rflush follows it.
 *  - Tlock/Tgetlock grant everything (no host locking); xattrs are not
 *    supported (EOPNOTSUPP); Tmknod is EPERM; Tauth is EOPNOTSUPP (the
 *    secret travels in the attach name instead).
 *
 * API
 *   const srv = await createServer({host:'127.0.0.1', port, shares:[{id,
 *     root, secret, readOnly, uid, gid}], ...limits})
 *   srv.port, srv.addShare(def), srv.removeShare(id),
 *   srv.disconnectShare(id) (drop its connections, keep the share),
 *   srv.stats() / srv.stats({connections: true}) (adds connectionList and
 *   recentCloses: why the last 20 mounts ended), await srv.close()
 *   generateSecret(), formatAname(share), mountOptions({...}) (optional
 *   uname: 'boot-<boot_id>'), mountCommand({...}), validateName(name),
 *   toErrno(err)
 *   opts.log(level, message): level is 'error' | 'warn' | 'info' (one info
 *   line per attached connection that ends, with the reason).
 *   opts.onAttach({share, boot, connection}): after every successful attach
 *   (boot = the connection's "boot-<id>" tag or null), called asynchronously.
 *
 * PERFORMANCE NOTE: all file I/O runs on libuv's thread pool (4 threads by
 * default). The embedding process should set UV_THREADPOOL_SIZE (e.g. 16)
 * before any fs call to let concurrent guest requests overlap.
 */

const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./proto');

const { T, ERRNO, QT, DT, L, GETATTR, SETATTR, Reader, Writer, ProtoError } = P;
const { performance } = require('perf_hooks');

const IS_WIN = process.platform === 'win32';
const CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin';
const SEP = path.sep;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const PRE_VERSION_MAX = 8192; // frame limit before Tversion
const PRE_ATTACH_MAX = 65536; // frame limit until an attach succeeds
const PRE_ATTACH_INFLIGHT = 2; // in-flight limit until an attach succeeds
const MIN_MSIZE = 4096;
const WRITE_HIGH_WATER = 4 * 1024 * 1024; // unsent reply bytes above which no new request starts
const FOREIGN_ID_CAP = 65536; // qid map for objects without a usable inode number (ids are never reused)
const OUTSIDE_LINK = '/.devbox/link-outside-share';
const EXEC_EXT = new Set(['.sh', '.bash', '.zsh', '.ksh', '.csh', '.fish', '.command', '.run', '.appimage']);
const WIN_BAD_CHARS = /[\\:*?"<>|\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const ALIAS_LIKE = /~[0-9]/;
// Attach uname "boot-<id>" (the guest mounts with uname=boot-$(cat
// /proc/sys/kernel/random/boot_id)) marks which boot of the VM a connection
// belongs to; see supersede().
const BOOT_TAG = /^boot-[A-Za-z0-9-]{8,64}$/;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 0,
  maxMsize: 1024 * 1024,
  maxConnections: 64,
  maxPreAuthConnections: 16,
  maxConnectionsPerShare: 8,
  maxFidsPerConnection: 65536,
  maxFidsPerShare: 131072,
  maxOpenFilesPerConnection: 1024,
  maxOpenFilesTotal: 4096,
  maxInflightPerConnection: 32,
  maxRequestBytesPerConnection: 16 * 1024 * 1024,
  maxDirEntriesCached: 1000000,
  requestTimeoutMs: 60000,
  stallTimeoutMs: 60000,
  preAuthTimeoutMs: 15000,
  idleTimeoutMs: 0,
  maxAuthFailures: 3,
  authFailureDelayMs: 100,
  execHeuristics: true,
  syncMetadata: 'auto', // see syncCall(): true | false | 'auto' (local drives sync, UNC async)
  syncSlowMs: 50,
  syncSlowStrikes: 3,
  syncStallMs: 1000,
  allowNonLoopback: false,
  log: null,
  onAttach: null, // ({share, boot, connection}) after every successful Tattach (see tattach)
};

// ---------------------------------------------------------------- errors --

class NineError extends Error {
  constructor(errno, msg) {
    super(msg || P.ERRNO_NAME[errno] || ('errno ' + errno));
    this.name = 'NineError';
    this.errno = errno;
  }
}
const nerr = (name, msg) => new NineError(ERRNO[name], msg);

// Node error -> Linux errno for Rlerror.
function toErrno(err) {
  if (!err) return ERRNO.EIO;
  if (err instanceof NineError || err instanceof ProtoError) return err.errno;
  if (typeof err.errno === 'number' && err.name === 'NineError') return err.errno;
  const code = err.code;
  if (typeof code === 'string') {
    if (Object.prototype.hasOwnProperty.call(ERRNO, code)) return ERRNO[code];
    if (code === 'ERR_FS_FILE_TOO_LARGE') return ERRNO.EFBIG;
    if (code === 'ERR_OUT_OF_RANGE' || code === 'ERR_INVALID_ARG_VALUE' || code === 'ERR_INVALID_ARG_TYPE') return ERRNO.EINVAL;
    if (code === 'ERR_BUFFER_TOO_LARGE') return ERRNO.ENOMEM;
  }
  return ERRNO.EIO;
}

// ------------------------------------------------------------ name rules --

// 0 when `name` may be used as a single path component, else a Linux errno.
function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) return ERRNO.EINVAL;
  if (name === '.' || name === '..') return ERRNO.EINVAL;
  if (name.indexOf('/') !== -1 || name.indexOf('\0') !== -1) return ERRNO.EINVAL;
  if (Buffer.byteLength(name, 'utf8') > 255) return ERRNO.ENAMETOOLONG;
  if (IS_WIN) {
    if (WIN_BAD_CHARS.test(name)) return ERRNO.EINVAL; // ':' would address an NTFS alternate data stream
    const last = name.charCodeAt(name.length - 1);
    if (last === 0x2e || last === 0x20) return ERRNO.EINVAL; // Win32 strips trailing dots/spaces -> aliasing
    const dot = name.indexOf('.');
    const stem = (dot === -1 ? name : name.slice(0, dot)).replace(/ +$/, '');
    if (WIN_RESERVED.test(stem)) return ERRNO.EINVAL;
  }
  return 0;
}
function checkName(name, errnoName) {
  const e = validateName(name);
  if (e) throw new NineError(e === ERRNO.ENAMETOOLONG ? e : ERRNO[errnoName || 'EINVAL'], 'invalid name');
}

const cmpKey = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
// dir is a real host directory path, name a validated component
const childPath = (dir, name) => (dir.endsWith(SEP) ? dir + name : dir + SEP + name);

// ------------------------------------------------------------- path tree --
// Fids reference nodes, not path strings. Renames move nodes, so every fid
// below a renamed directory follows it; unlinks detach nodes, so stale fids
// fail with ENOENT instead of silently addressing a new object.

class PathTree {
  constructor() { this.tops = new Map(); }
  key(name) { return cmpKey(name); }
  nodeFor(abs) {
    const parsed = path.parse(abs);
    const rootKey = this.key(parsed.root);
    let top = this.tops.get(rootKey);
    if (!top) {
      top = { name: parsed.root, key: rootKey, parent: null, children: null, refs: 1, detached: false, top: true };
      this.tops.set(rootKey, top);
    }
    let node = top;
    for (const part of abs.slice(parsed.root.length).split(/[\\/]+/)) {
      if (part) node = this.child(node, part);
    }
    return node;
  }
  child(parent, name) {
    const k = this.key(name);
    let c = parent.children ? parent.children.get(k) : undefined;
    if (!c) {
      c = { name, key: k, parent, children: null, refs: 0, detached: false, top: false };
      if (!parent.children) parent.children = new Map();
      parent.children.set(k, c);
    }
    return c;
  }
  peek(parent, name) { return parent.children ? parent.children.get(this.key(name)) : undefined; }
  ref(n) { n.refs++; }
  unref(n) { n.refs--; this.prune(n); }
  prune(n) {
    while (n && !n.top && n.parent && n.refs <= 0 && !(n.children && n.children.size)) {
      const p = n.parent;
      const inMap = p.children && p.children.get(n.key) === n;
      if (inMap) { p.children.delete(n.key); if (!p.children.size) p.children = null; }
      n.parent = null;
      if (!inMap) break;
      n = p;
    }
  }
  detach(parent, n) {
    if (parent.children && parent.children.get(n.key) === n) {
      parent.children.delete(n.key);
      if (!parent.children.size) parent.children = null;
    }
    n.detached = true;
    this.prune(parent);
  }
  detachChild(parent, name) {
    const n = this.peek(parent, name);
    if (n) this.detach(parent, n);
  }
  move(srcParent, srcName, dstParent, dstName) {
    const src = this.peek(srcParent, srcName);
    const dst = this.peek(dstParent, dstName);
    if (dst && dst !== src) { // the replaced object: its fids go stale
      dstParent.children.delete(dst.key);
      dst.detached = true;
    }
    if (src) {
      srcParent.children.delete(src.key);
      src.name = dstName;
      src.key = this.key(dstName);
      src.parent = dstParent;
      if (!dstParent.children) dstParent.children = new Map();
      dstParent.children.set(src.key, src);
    }
    // prune only after the tree is consistent again
    for (const p of [srcParent, dstParent]) if (p.children && !p.children.size) p.children = null;
    this.prune(srcParent);
    this.prune(dstParent);
  }
  isUnder(n, root) {
    for (let x = n; x; x = x.parent) {
      if (x === root) return true;
      if (x.detached) return false;
    }
    return false;
  }
}

// ---------------------------------------------------------------- RW lock --

class RWLock {
  constructor() { this.active = 0; this.q = []; } // active: >0 readers, -1 writer
  acquire(excl) {
    if (!this.q.length && (excl ? this.active === 0 : this.active >= 0)) {
      this.active = excl ? -1 : this.active + 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.q.push({ excl, resolve }));
  }
  release(excl) {
    if (excl) this.active = 0; else this.active--;
    while (this.q.length) {
      const h = this.q[0];
      if (h.excl) {
        if (this.active !== 0) break;
        this.q.shift(); this.active = -1; h.resolve();
        break;
      }
      if (this.active < 0) break;
      this.q.shift(); this.active++; h.resolve();
    }
  }
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = [];
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(run());
  await Promise.all(workers);
}

function splitNs(ns) {
  let sec = ns / 1000000000n;
  let nsec = ns % 1000000000n;
  if (nsec < 0n) { nsec += 1000000000n; sec -= 1n; }
  return [sec, nsec];
}

// ------------------------------------------------------------------ misc --

function generateSecret() { return crypto.randomBytes(24).toString('base64url'); }
function formatAname(share) { return share.id + ':' + share.secret; }
function mountOptions(o) {
  const opts = ['trans=tcp', 'port=' + o.port, 'version=9p2000.L', 'aname=' + formatAname(o.share),
    'msize=' + (o.msize || 524288), 'cache=' + (o.cache || 'mmap')];
  if (o.access) opts.push('access=' + o.access);
  if (o.uname) opts.push('uname=' + o.uname); // e.g. 'boot-' + the guest's boot_id (see BOOT_TAG)
  return opts.join(',');
}
function mountCommand(o) {
  return 'mount -t 9p -o ' + mountOptions(o) + ' ' + (o.hostIp || '10.0.2.2') + ' ' + o.mountPoint;
}

// Tlopen/Tlcreate flags (Linux values) -> fs.open flags for this platform.
function openFlags(dotl) {
  const C = fs.constants;
  let f;
  switch (dotl & L.O_ACCMODE) {
    case L.O_WRONLY: f = C.O_WRONLY; break;
    case L.O_RDWR: f = C.O_RDWR; break;
    default: f = C.O_RDONLY;
  }
  // libuv on Windows rejects O_TRUNC without O_CREAT (EINVAL) and would map
  // O_CREAT|O_TRUNC to CREATE_ALWAYS, which fails on hidden/system files; the
  // callers truncate after opening instead (see truncateAfterOpen).
  if ((dotl & L.O_TRUNC) && !IS_WIN) f |= C.O_TRUNC;
  if (dotl & L.O_APPEND) f |= C.O_APPEND;
  if (dotl & L.O_CREAT) f |= C.O_CREAT;
  if (dotl & L.O_EXCL) f |= C.O_EXCL;
  if (C.O_NOFOLLOW) f |= C.O_NOFOLLOW; // POSIX hosts: never follow a final symlink
  return f;
}

async function truncateAfterOpen(fh, realPath, dotl) {
  if (!IS_WIN || !(dotl & L.O_TRUNC)) return;
  const acc = dotl & L.O_ACCMODE;
  if (acc === L.O_WRONLY || acc === L.O_RDWR) await fh.truncate(0);
  else await fsp.truncate(realPath, 0);
}

function syncMetaFor(setting, realRoot) {
  if (setting === true || setting === false) return setting;
  return !/^[\\/]{2}/.test(realRoot); // 'auto': UNC / network roots stay async
}

// ------------------------------------------------------------------ server --

class NinepServer {
  constructor(opts) {
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    const o = this.opts;
    if (!o.allowNonLoopback && !['127.0.0.1', '::1', 'localhost'].includes(o.host)) {
      throw new Error('9p server must listen on a loopback address (got ' + o.host + ')');
    }
    o.maxMsize = Math.max(MIN_MSIZE, Math.min(o.maxMsize | 0, 16 * 1024 * 1024));
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.tree = new PathTree();
    this.lock = new RWLock();
    this.shares = new Map();
    this.conns = new Set();
    this.connSeq = 0;
    this.openFiles = 0;
    this.foreignIds = new Map();
    this.nextForeignId = 1n;
    this.execCache = new Map();
    this.dirSnaps = new Map(); // Fid -> number of names in its readdir snapshot (LRU order)
    this.dirEntries = 0;
    this.recentCloses = []; // last 20 attached connections that ended, and why (diagnostics)
    this.counters = {
      connections: 0, rejected: 0, requests: 0, errors: 0, authFailures: 0, protocolErrors: 0, timeouts: 0,
      evicted: 0, stalled: 0, reclaimed: 0, superseded: 0, dirSnapshotsDropped: 0, serviceMs: 0,
    };
    this.opStats = {}; // per message type: count, total and max service ms
    this.port = 0;
    this.host = o.host;
    this.server = null;
    this.sweeper = null;
    this.closed = false;
    // Timeouts use a clock that advances at most two ticks per sweep, so
    // a host sleep or a long event-loop stall never expires everything at once.
    const limits = [o.requestTimeoutMs, o.stallTimeoutMs].filter((v) => v > 0);
    this.tickMs = Math.max(20, Math.min(1000, Math.floor((limits.length ? Math.min(...limits) : 4000) / 4)));
    this.vclock = 0;
    this.vwall = Date.now();
    for (const s of o.shares || []) this.addShare(s);
  }

  vnow() {
    const d = Date.now() - this.vwall;
    return this.vclock + (d < 0 ? 0 : Math.min(d, 2 * this.tickMs));
  }

  async listen() {
    const srv = net.createServer((sock) => this.onConnection(sock));
    this.server = srv;
    await new Promise((resolve, reject) => {
      const onErr = (e) => { srv.off('listening', onOk); reject(e); };
      const onOk = () => { srv.off('error', onErr); resolve(); };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      srv.listen({ port: this.opts.port, host: this.opts.host, exclusive: true });
    });
    srv.on('error', (e) => this.log('error', '9p listener error: ' + e.message));
    this.port = srv.address().port;
    this.sweeper = setInterval(() => this.sweep(), this.tickMs);
    this.sweeper.unref();
    return this;
  }

  // ---- shares ----
  addShare(def) {
    if (!def || typeof def !== 'object') throw new TypeError('share definition must be an object');
    const id = def.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('share id must be 1-64 of A-Z a-z 0-9 . _ - (got ' + JSON.stringify(id) + ')');
    if (this.shares.has(id)) throw new Error('share "' + id + '" already exists');
    const secret = def.secret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9._~+=-]{16,256}$/.test(secret)) throw new Error('share secret must be 16-256 characters of A-Z a-z 0-9 . _ ~ + = -');
    if (typeof def.root !== 'string' || !path.isAbsolute(def.root)) throw new Error('share root must be an absolute path');
    const realRoot = fs.realpathSync.native(def.root);
    const st = fs.statSync(realRoot, { bigint: true });
    if (!st.isDirectory()) throw new Error('share root is not a directory: ' + def.root);
    const u = (v, name) => {
      if (v === undefined || v === null) return 0;
      if (!Number.isInteger(v) || v < 0 || v > 0xfffffffe) throw new Error('share ' + name + ' must be an integer 0-4294967294');
      return v;
    };
    const digest = crypto.createHash('sha256').update(secret, 'utf8').digest();
    for (const other of this.shares.values()) {
      if (crypto.timingSafeEqual(other.secretDigest, digest)) throw new Error('share secrets must be unique');
    }
    const cmpRoot = cmpKey(realRoot);
    const share = {
      id, root: def.root, realRoot, secret, secretDigest: digest,
      readOnly: !!def.readOnly, uid: u(def.uid, 'uid'), gid: u(def.gid, 'gid'),
      cmpRoot, cmpRootSep: cmpRoot.endsWith(SEP) ? cmpRoot : cmpRoot + SEP,
      realRootSep: realRoot.endsWith(SEP) ? realRoot : realRoot + SEP,
      dev: st.dev, rootNode: null, conns: new Set(), removed: false, fidCount: 0,
      syncMeta: syncMetaFor(def.syncMetadata !== undefined ? def.syncMetadata : this.opts.syncMetadata, realRoot),
      fsid: crypto.createHash('sha256').update(cmpRoot).digest().readBigUInt64LE(0),
      stats: { attaches: 0, ops: 0, errors: 0, bytesRead: 0, bytesWritten: 0 },
    };
    share.rootNode = this.tree.nodeFor(realRoot);
    this.tree.ref(share.rootNode);
    this.shares.set(id, share);
    return { id, root: def.root, realRoot, readOnly: share.readOnly, uid: share.uid, gid: share.gid, syncMetadata: share.syncMeta };
  }

  removeShare(id) {
    const share = this.shares.get(id);
    if (!share) return false;
    share.removed = true;
    this.shares.delete(id);
    for (const c of Array.from(share.conns)) c.destroy('share removed');
    this.tree.unref(share.rootNode);
    return true;
  }

  // Close every connection attached to share `id` but keep the share: for the
  // manager to call when it stops/restarts the VM that owns the share, so
  // mounts of the previous boot cannot linger. Returns the number closed.
  disconnectShare(id) {
    const share = this.shares.get(id);
    if (!share) return 0;
    const list = Array.from(share.conns);
    for (const c of list) c.destroy('share disconnected');
    return list.length;
  }

  authenticate(aname) {
    let id = null;
    let secret = aname;
    const i = aname.indexOf(':');
    if (i >= 0) { id = aname.slice(0, i); secret = aname.slice(i + 1); }
    const digest = crypto.createHash('sha256').update(secret, 'utf8').digest();
    let found = null;
    for (const sh of this.shares.values()) {
      const ok = crypto.timingSafeEqual(digest, sh.secretDigest); // compare all: no early exit
      if (ok && !found && (id === null || id === sh.id) && !sh.removed) found = sh;
    }
    return found;
  }

  // stats({connections: true}) adds one row per connection (diagnostics).
  stats(o) {
    const shares = [];
    for (const s of this.shares.values()) {
      let open = 0;
      for (const c of s.conns) for (const f of c.fids.values()) if (f.share === s && f.reserved) open++;
      shares.push(Object.assign({ id: s.id, root: s.root, readOnly: s.readOnly, syncMetadata: s.syncMeta, connections: s.conns.size, fids: s.fidCount, openFiles: open }, s.stats));
    }
    let inflight = 0;
    let requestBytes = 0;
    let unsentBytes = 0;
    for (const c of this.conns) {
      inflight += c.inflight;
      requestBytes += c.cost;
      if (!c.closed) unsentBytes += c.sock.writableLength;
    }
    const ops = {};
    for (const [t, v] of Object.entries(this.opStats)) ops[P.TYPE_NAME[t] || t] = { count: v.count, avgMs: +(v.ms / v.count).toFixed(3), maxMs: +v.maxMs.toFixed(1) };
    const out = {
      host: this.host, port: this.port, connections: this.conns.size, openFiles: this.openFiles, inflight,
      requestBytes, unsentBytes, dirSnapshots: this.dirSnaps.size, dirEntriesCached: this.dirEntries,
      shares, counters: Object.assign({}, this.counters), ops,
    };
    if (o && o.connections) {
      const now = this.vnow();
      out.connectionList = Array.from(this.conns, (c) => ({
        id: c.id, attached: c.attached, shares: Array.from(c.shares, (s) => s.id), boot: c.bootTag, fids: c.fids.size, openFiles: c.openFiles,
        inflight: c.inflight, partialFrame: c.frame !== null || c.hdrLen > 0, unsentBytes: c.sock.writableLength,
        idleMs: now - c.lastActive,
      }));
      out.recentCloses = this.recentCloses.slice();
    }
    return out;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const done = this.server ? new Promise((r) => this.server.close(() => r())) : Promise.resolve();
    for (const c of Array.from(this.conns)) c.destroy('server closing');
    await done;
  }

  onConnection(sock) {
    if (this.closed) { sock.destroy(); return; }
    // Every guest can reach the port, so a hostile one could park connections
    // that never attach and starve everyone else. Unauthenticated connections
    // have their own cap; the oldest one makes room for a newcomer (a real
    // client attaches within milliseconds of connecting).
    let waiting = 0;
    let oldest = null;
    for (const c of this.conns) if (!c.attached && !c.closed) { waiting++; if (!oldest) oldest = c; }
    if (waiting >= this.opts.maxPreAuthConnections && oldest) {
      this.counters.evicted++;
      oldest.destroy('evicted: too many unauthenticated connections');
    }
    if (this.conns.size >= this.opts.maxConnections) {
      this.counters.rejected++;
      sock.destroy();
      return;
    }
    this.counters.connections++;
    const c = new Conn(this, sock);
    this.conns.add(c);
  }

  sweep() {
    const now = this.vnow();
    this.vclock = now;
    this.vwall = Date.now();
    const limit = this.opts.requestTimeoutMs;
    for (const c of Array.from(this.conns)) {
      try {
        if (limit > 0) {
          for (const ctx of c.tags.values()) {
            if (!ctx.done && ctx.type !== T.Tflush && now - ctx.start > limit) {
              ctx.expired = true;
              this.counters.timeouts++;
              c.finishErr(ctx, nerr('ETIMEDOUT', 'request timed out'));
            }
          }
        }
        if (!c.closed) c.checkStall(now);
      } catch (e) {
        c.fatal('internal error in sweep: ' + e.message);
      }
    }
  }

  // ---- readdir snapshots (bounded, least recently used dropped first) ----
  keepSnapshot(f, snap) {
    this.dropSnapshot(f);
    f.dir = snap;
    const n = snap.names.length;
    this.dirSnaps.set(f, n);
    this.dirEntries += n;
    if (this.dirEntries <= this.opts.maxDirEntriesCached) return;
    for (const [g, m] of this.dirSnaps) {
      if (this.dirEntries <= this.opts.maxDirEntriesCached) break;
      if (g === f) continue; // the newest one stays even when it alone exceeds the budget
      this.dirSnaps.delete(g);
      this.dirEntries -= m;
      g.dir = null; // re-read on its next Treaddir
      this.counters.dirSnapshotsDropped++;
    }
  }

  touchSnapshot(f) {
    const n = this.dirSnaps.get(f);
    if (n === undefined) return;
    this.dirSnaps.delete(f);
    this.dirSnaps.set(f, n);
  }

  dropSnapshot(f) {
    const n = this.dirSnaps.get(f);
    if (n !== undefined) {
      this.dirSnaps.delete(f);
      this.dirEntries -= n;
    }
    f.dir = null;
  }

  // ---- lock / jail helpers ----
  async withLock(excl, ctx, fn) {
    await this.lock.acquire(excl);
    try {
      if (!ctx.alive()) throw nerr('ETIMEDOUT');
      return await fn();
    } finally {
      this.lock.release(excl);
    }
  }

  pathOf(share, node) {
    const names = [];
    let x = node;
    while (x !== share.rootNode) {
      if (!x || x.detached || !x.parent || x.top) throw nerr('ENOENT', 'stale fid');
      names.push(x.name);
      x = x.parent;
    }
    if (share.rootNode.detached) throw nerr('ENOENT', 'share root is gone');
    if (!names.length) return share.realRoot;
    names.reverse();
    return share.realRootSep + names.join(SEP);
  }

  isInside(real, share) {
    const a = cmpKey(real);
    return a === share.cmpRoot || a.startsWith(share.cmpRootSep);
  }

  // ---- metadata fast path ----
  // Every async fs call is two thread hand-offs (event loop -> libuv pool ->
  // event loop). Under CPU contention on Windows each hand-off can wait for a
  // scheduler quantum, and an lstat that costs ~0.2 ms synchronously was
  // measured at 3-9 ms asynchronously. Lookups (walk + getattr) are the hot
  // path of source-code workloads, so for shares on local disks lstat,
  // fstat and realpath run synchronously. A watchdog switches a share back
  // to async for good after syncSlowStrikes calls slower than syncSlowMs
  // (one blip is usually just CPU preemption) or one call slower than
  // syncStallMs (a waking disk, a stalled filter driver), and UNC roots start
  // async, so slow storage cannot keep stalling the event loop. Opens, reads,
  // writes, closes, readdir and mutations always stay asynchronous.
  syncCall(share, fn) {
    const t = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t;
      if (ms > this.opts.syncSlowMs && share.syncMeta) {
        share.slowStrikes = (share.slowStrikes || 0) + 1;
        if (share.slowStrikes >= this.opts.syncSlowStrikes || ms > this.opts.syncStallMs) {
          share.syncMeta = false;
          this.log('warn', '9p: share "' + share.id + '" metadata calls are slow (' + ms.toFixed(0) + ' ms); using async calls from now on');
        }
      }
    }
  }

  lstat(share, p) {
    if (share.syncMeta) return this.syncCall(share, () => fs.lstatSync(p, { bigint: true }));
    return fsp.lstat(p, { bigint: true });
  }

  fstat(share, fh) {
    if (share.syncMeta) return this.syncCall(share, () => fs.fstatSync(fh.fd, { bigint: true }));
    return fh.stat({ bigint: true });
  }

  realpath(share, p) {
    if (share.syncMeta) return this.syncCall(share, () => fs.realpathSync.native(p));
    return fsp.realpath(p);
  }

  // Resolve p with fs.realpath and refuse it unless it stays inside the share.
  // exact (the default): the real path must also BE the logical path (up to
  // case on case-insensitive hosts), i.e. no symlink, junction or 8.3 alias
  // anywhere along it - fids only ever address link-free paths.
  async realInside(p, share, loose) {
    const rp = await this.realpath(share, p);
    if (!this.isInside(rp, share)) {
      this.log('warn', '9p: refused path outside share "' + share.id + '"');
      throw nerr('EACCES', 'path leaves the share');
    }
    if (!loose && cmpKey(rp) !== cmpKey(p)) {
      this.log('warn', '9p: refused path through a link in share "' + share.id + '"');
      throw nerr('EACCES', 'path goes through a link');
    }
    return rp;
  }

  // Windows 8.3 aliases ("PROGRA~1") would give one object two names; a name
  // that looks like one must be the object's real name.
  async aliasGuard(share, dir, name, errnoName) {
    if (!IS_WIN || !ALIAS_LIKE.test(name)) return;
    let rp;
    try { rp = await this.realpath(share, childPath(dir, name)); } catch (e) { return; } // does not exist: fine
    if (cmpKey(path.basename(rp)) !== cmpKey(name)) throw nerr(errnoName, '8.3 alias');
  }

  qidOf(st, share, absPath) {
    let type = QT.FILE;
    if (st.isDirectory()) type = QT.DIR;
    else if (st.isSymbolicLink()) type = QT.SYMLINK;
    const version = Number(BigInt.asUintN(32, (st.mtimeNs / 1000n) ^ (st.size << 8n)));
    let qpath;
    if (st.ino > 0n && st.dev === share.dev) {
      qpath = st.ino;
    } else {
      const key = st.ino > 0n ? st.dev + ':' + st.ino : 'p:' + cmpKey(absPath || '');
      qpath = this.foreignIds.get(key);
      if (qpath === undefined) {
        // bounded: the oldest mapping is forgotten (that object gets a new,
        // never reused id next time - a changed inode number, never a clash)
        if (this.foreignIds.size >= FOREIGN_ID_CAP) this.foreignIds.delete(this.foreignIds.keys().next().value);
        qpath = (1n << 63n) | this.nextForeignId++;
        this.foreignIds.set(key, qpath);
      }
    }
    return { type, version, path: qpath };
  }

  async isExecutable(share, name, absPath, st, qpath) {
    if (!this.opts.execHeuristics) return false;
    const ext = path.extname(name).toLowerCase();
    if (EXEC_EXT.has(ext)) return true;
    if (ext !== '' || name.charCodeAt(0) === 0x2e || st.size < 2n || !absPath) return false;
    const key = String(qpath);
    const hit = this.execCache.get(key);
    if (hit && hit.m === st.mtimeNs && hit.s === st.size) return hit.x;
    let x = false;
    let fh = null;
    try {
      const rp = await this.realInside(absPath, share);
      fh = await fsp.open(rp, fs.constants.O_RDONLY);
      const b = Buffer.alloc(4);
      const { bytesRead } = await fh.read(b, 0, 4, 0);
      x = (bytesRead >= 2 && b[0] === 0x23 && b[1] === 0x21) ||
        (bytesRead === 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46);
    } catch (e) {
      x = false;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    if (this.execCache.size >= 65536) this.execCache.clear();
    this.execCache.set(key, { m: st.mtimeNs, s: st.size, x });
    return x;
  }

  async modeOf(share, st, name, absPath, qpath) {
    if (!IS_WIN) {
      let m = Number(st.mode) & 0o177777;
      if (share.readOnly) m &= ~0o222;
      return m;
    }
    if (st.isDirectory()) return S_IFDIR | (share.readOnly ? 0o555 : 0o755);
    if (st.isSymbolicLink()) return S_IFLNK | 0o777;
    let perm = (await this.isExecutable(share, name, absPath, st, qpath)) ? 0o755 : 0o644;
    if (share.readOnly || !(Number(st.mode) & 0o200)) perm &= ~0o222;
    return S_IFREG | perm;
  }

  // Readlink target as the guest should see it.
  translateLink(raw, linkPath, share) {
    let t = String(raw);
    if (IS_WIN) {
      if (t.startsWith('\\\\?\\UNC\\')) t = '\\\\' + t.slice(8);
      else if (t.startsWith('\\\\?\\') || t.startsWith('\\??\\')) t = t.slice(4);
      if (path.win32.isAbsolute(t)) {
        const abs = path.win32.resolve(path.win32.dirname(linkPath), t).replace(/\\+$/, '') || t;
        if (this.isInside(abs, share)) return (path.win32.relative(path.win32.dirname(linkPath), abs) || '.').replace(/\\/g, '/');
        return OUTSIDE_LINK;
      }
      return t.replace(/\\/g, '/');
    }
    if (path.isAbsolute(t)) {
      const abs = path.resolve(t);
      if (this.isInside(abs, share)) return path.relative(path.dirname(linkPath), abs) || '.';
      return OUTSIDE_LINK;
    }
    return t;
  }

  // ---- handle swapping for directory renames (Windows) ----
  openFidsUnder(node) {
    const out = [];
    for (const c of this.conns) {
      for (const f of c.fids.values()) {
        if (!f.dead && f.fh && !f.swapping && this.tree.isUnder(f.node, node)) out.push(f);
      }
    }
    return out;
  }

  async suspendHandles(fids) {
    for (const f of fids) {
      f.swapping = new Promise((resolve) => { f.swapDone = resolve; });
      const fh = f.fh;
      f.fh = null;
      try { await fh.close(); } catch (e) { /* ignore */ } // waits for in-flight reads/writes
    }
  }

  async resumeHandles(fids) {
    for (const f of fids) {
      if (!f.dead) {
        try {
          const rp = await this.realInside(this.pathOf(f.share, f.node), f.share);
          const fh = await fsp.open(rp, f.reopenFlags);
          if (f.dead) await fh.close().catch(() => {}); else f.fh = fh;
        } catch (e) {
          f.broken = true;
          this.log('warn', '9p: could not reopen a file after a directory rename: ' + e.message);
        }
      }
      const done = f.swapDone;
      f.swapping = null;
      f.swapDone = null;
      if (done) done();
    }
  }

  // A symlink moved into `newDir` must still point inside the share.
  async checkLinkMove(share, linkPath, newDir) {
    const raw = await fsp.readlink(linkPath);
    let t = String(raw);
    if (IS_WIN && (t.startsWith('\\\\?\\') || t.startsWith('\\??\\'))) return; // absolute: unaffected by the move
    if (path.isAbsolute(t)) return;
    if (IS_WIN) t = t.replace(/\//g, '\\');
    if (!this.isInside(path.resolve(newDir, t), share)) throw nerr('EPERM', 'moved symlink would point outside the share');
  }
}

// ------------------------------------------------------------ connection --

class Ctx {
  constructor(conn, tag, type, cost) {
    this.conn = conn;
    this.tag = tag;
    this.type = type;
    this.cost = cost; // bytes counted against maxRequestBytesPerConnection
    this.session = conn.session;
    this.start = conn.srv.vnow();
    this.t0 = performance.now();
    this.done = false;
    this.expired = false;
    this.after = null;
  }
  alive() { return !this.expired && !this.conn.closed && this.session === this.conn.session; }
}

class Fid {
  constructor(share, node, kind, qid) {
    this.share = share;
    this.node = node;
    this.kind = kind; // 'dir' | 'file' | 'symlink' | 'other'
    this.qid = qid;
    this.opened = false;
    this.fh = null;
    this.reserved = false; // holds an open-file slot (released on clunk)
    this.reopenFlags = 0; // fs.open flags to reopen the file after a directory rename
    this.swapping = null; // promise while the handle is closed for a directory rename
    this.swapDone = null;
    this.broken = false; // could not be reopened after a directory rename
    this.canRead = false;
    this.canWrite = false;
    this.append = false;
    this.dir = null; // readdir snapshot {base, names, dot, dotdot} (see keepSnapshot)
    this.dead = false;
    this.counted = false; // counted in share.fidCount
  }
}
function kindOf(st) {
  if (st.isDirectory()) return 'dir';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  return 'other';
}

class Conn {
  constructor(srv, sock) {
    this.srv = srv;
    this.sock = sock;
    this.id = ++srv.connSeq;
    this.msize = 0;
    this.versioned = false;
    this.session = 0;
    this.fids = new Map();
    this.openFiles = 0;
    this.tags = new Map();
    this.shares = new Set();
    this.attached = false;
    this.authFailures = 0;
    this.inflight = 0;
    this.cost = 0; // request frame + reply buffer bytes of the requests in flight
    this.queue = [];
    this.hdr = Buffer.alloc(4);
    this.hdrLen = 0;
    this.frame = null;
    this.fill = 0;
    this.closed = false;
    this.paused = false;
    this.lastProgress = srv.vnow(); // last time the peer sent bytes or took reply bytes
    this.lastFlushed = 0;
    this.lastActive = this.lastProgress; // last request received (for reclaiming a share's stale connections)
    this.bootTag = null; // "boot-<id>" attach uname: which boot of the VM this mount belongs to
    try { sock.setNoDelay(true); sock.setKeepAlive(true, 30000); } catch (e) { /* ignore */ }
    sock.on('data', (d) => { try { this.onData(d); } catch (e) { this.fatal('internal error: ' + e.message); } });
    sock.on('error', (e) => this.destroy('socket error ' + (e && e.code ? e.code : '')));
    sock.on('close', () => this.destroy('closed by the guest'));
    sock.on('end', () => this.destroy('closed by the guest'));
    sock.on('drain', () => this.pump());
    const o = srv.opts;
    if (o.preAuthTimeoutMs > 0) {
      this.preAuth = setTimeout(() => { if (!this.attached) this.destroy('no attach in time'); }, o.preAuthTimeoutMs);
      this.preAuth.unref();
    }
    if (o.idleTimeoutMs > 0) sock.setTimeout(o.idleTimeoutMs, () => this.destroy('idle'));
  }

  fatal(why) {
    this.srv.counters.protocolErrors++;
    this.srv.log('warn', '9p connection ' + this.id + ' closed: ' + why);
    this.destroy(why);
  }

  destroy(why) {
    if (this.closed) return;
    this.closed = true;
    if (this.preAuth) clearTimeout(this.preAuth);
    try { this.sock.destroy(); } catch (e) { /* ignore */ }
    const srv = this.srv;
    if (this.attached) { // mounts ending are worth a line; unauthenticated churn is not
      const ids = Array.from(this.shares, (s) => s.id);
      srv.log('info', '9p connection ' + this.id + ' (' + (ids.join(',') || 'no share') + ') closed: ' + (why || 'closed'));
      srv.recentCloses.push({ id: this.id, shares: ids, reason: why || 'closed', at: new Date().toISOString(), openFiles: this.openFiles, fids: this.fids.size });
      if (srv.recentCloses.length > 20) srv.recentCloses.shift();
    }
    this.queue = [];
    for (const f of this.fids.values()) this.releaseFid(f).catch(() => {});
    this.fids.clear();
    for (const s of this.shares) s.conns.delete(this);
    this.shares.clear();
    srv.conns.delete(this);
  }

  // A connection that owes us something and makes no progress for
  // stallTimeoutMs is closed: the rest of a frame we are waiting for (while
  // we are reading - not while we paused the socket ourselves), or reply
  // bytes it does not take. An idle connection owes nothing and stays open.
  checkStall(now) {
    const limit = this.srv.opts.stallTimeoutMs;
    const unsent = this.sock.writableLength;
    const flushed = this.sock.bytesWritten - unsent;
    if (flushed !== this.lastFlushed) { this.lastFlushed = flushed; this.lastProgress = now; }
    const owesFrame = (this.frame !== null || this.hdrLen > 0) && !this.paused;
    if (!(owesFrame || unsent > 0) || !(limit > 0)) { this.lastProgress = now; return; }
    if (now - this.lastProgress > limit) {
      this.srv.counters.stalled++;
      this.srv.log('warn', '9p connection ' + this.id + ' closed: no progress for ' + limit + ' ms (' +
        (owesFrame ? 'partial frame' : unsent + ' reply bytes not taken') + ')');
      this.destroy('stalled');
    }
  }

  // ---- framing ----
  onData(chunk) {
    this.lastProgress = this.srv.vnow();
    let off = 0;
    const len = chunk.length;
    while (off < len && !this.closed) {
      if (!this.frame) {
        if (this.hdrLen === 0 && len - off >= 4) {
          const size = chunk.readUInt32LE(off);
          if (!this.sizeOk(size)) return;
          if (len - off >= size) { // whole frame inside this chunk: no copy
            this.queue.push(chunk.subarray(off, off + size));
            off += size;
            this.pump();
            continue;
          }
          this.frame = Buffer.allocUnsafe(size);
          this.fill = 0;
        } else {
          const n = Math.min(4 - this.hdrLen, len - off);
          chunk.copy(this.hdr, this.hdrLen, off, off + n);
          this.hdrLen += n;
          off += n;
          if (this.hdrLen < 4) break;
          const size = this.hdr.readUInt32LE(0);
          this.hdrLen = 0;
          if (!this.sizeOk(size)) return;
          this.frame = Buffer.allocUnsafe(size);
          this.hdr.copy(this.frame, 0, 0, 4);
          this.fill = 4;
        }
      }
      const n = Math.min(this.frame.length - this.fill, len - off);
      chunk.copy(this.frame, this.fill, off, off + n);
      this.fill += n;
      off += n;
      if (this.fill === this.frame.length) {
        this.queue.push(this.frame);
        this.frame = null;
        this.pump();
      }
    }
    this.pump();
  }

  sizeOk(size) {
    // unauthenticated peers get small frames and little concurrency, so they
    // cannot make the server allocate much memory
    const limit = !this.versioned ? PRE_VERSION_MAX : this.attached ? this.msize : Math.min(this.msize, PRE_ATTACH_MAX);
    if (size < P.HDR || size > limit) { this.fatal('bad frame size ' + size + ' (limit ' + limit + ')'); return false; }
    return true;
  }

  // Start queued requests while the limits allow. Nothing new starts while
  // the guest leaves more than WRITE_HIGH_WATER reply bytes unread ('drain'
  // pumps again), and the bytes of requests in flight plus replies not yet
  // taken stay within maxRequestBytesPerConnection (one request may exceed
  // it when nothing else is in flight), so replies can never pile up.
  pump() {
    if (this.closed) return;
    const o = this.srv.opts;
    const max = this.attached ? o.maxInflightPerConnection : PRE_ATTACH_INFLIGHT;
    const unsent = this.sock.writableLength;
    const backlog = unsent > WRITE_HIGH_WATER;
    while (!backlog && this.queue.length && this.inflight < max && !this.closed) {
      const cost = this.costOf(this.queue[0]);
      if (this.inflight > 0 && this.cost + unsent + cost > o.maxRequestBytesPerConnection) break;
      this.dispatch(this.queue.shift(), cost);
    }
    if (this.closed) return;
    const congested = this.queue.length >= 4 || backlog;
    if (congested && !this.paused) { this.paused = true; this.sock.pause(); }
    else if (!congested && this.paused) { this.paused = false; this.sock.resume(); }
  }

  // Memory a request holds while in flight: its frame, plus the reply buffer
  // Tread/Treaddir allocate up front (count, capped by msize).
  costOf(frame) {
    let cost = frame.length;
    const type = frame[4];
    if ((type === T.Tread || type === T.Treaddir) && frame.length >= 23) {
      cost += Math.min(frame.readUInt32LE(19), Math.max(0, this.msize - 11));
    }
    return cost;
  }

  dispatch(frame, cost) {
    const type = frame[4];
    const tag = frame.readUInt16LE(5);
    this.srv.counters.requests++;
    const prev = this.tags.get(tag);
    if (prev && !prev.done) { this.fatal('tag ' + tag + ' reused while in flight'); return; }
    const ctx = new Ctx(this, tag, type, cost || 0);
    this.tags.set(tag, ctx);
    this.inflight++;
    this.cost += ctx.cost;
    this.lastActive = ctx.start;
    let p;
    try {
      p = this.handle(ctx, type, new Reader(frame, P.HDR));
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).then((buf) => this.finish(ctx, buf), (err) => this.finishErr(ctx, err));
  }

  finish(ctx, buf) {
    if (ctx.done) return;
    ctx.done = true;
    const ms = performance.now() - ctx.t0;
    this.srv.counters.serviceMs += ms;
    const os = this.srv.opStats[ctx.type] || (this.srv.opStats[ctx.type] = { count: 0, ms: 0, maxMs: 0 });
    os.count++;
    os.ms += ms;
    if (ms > os.maxMs) os.maxMs = ms;
    this.inflight--;
    this.cost -= ctx.cost;
    if (this.tags.get(ctx.tag) === ctx) this.tags.delete(ctx.tag);
    if (!this.closed && ctx.session === this.session && buf) {
      try { this.sock.write(buf); } catch (e) { this.destroy(); }
    }
    if (ctx.after) for (const fn of ctx.after) { try { fn(); } catch (e) { /* ignore */ } }
    this.pump();
  }

  finishErr(ctx, err) {
    if (ctx.done) return;
    const errno = toErrno(err);
    this.srv.counters.errors++;
    if (ctx.share) ctx.share.stats.errors++;
    if (errno === ERRNO.EIO && !(err instanceof NineError)) this.srv.log('warn', '9p ' + (P.TYPE_NAME[ctx.type] || ctx.type) + ' failed: ' + (err && err.message));
    const w = new Writer(T.Rlerror, ctx.tag, 16);
    w.u32(errno);
    this.finish(ctx, w.finish());
  }

  // ---- fid helpers ----
  getFid(ctx, n) {
    const f = this.fids.get(n);
    if (!f) throw nerr('EBADF', 'unknown fid ' + n);
    if (f.share.removed) throw nerr('EACCES', 'share removed');
    if (ctx.share !== f.share) { ctx.share = f.share; f.share.stats.ops++; }
    return f;
  }

  // May fid number n become a new fid of `share`? (replacing an existing fid
  // of this connection does not add one)
  fidRoom(n, share) {
    if (this.fids.has(n)) return;
    const o = this.srv.opts;
    if (this.fids.size >= o.maxFidsPerConnection) throw nerr('ENFILE', 'too many fids');
    if (share && share.fidCount >= o.maxFidsPerShare) throw nerr('ENFILE', 'too many fids for this share');
  }

  reserveOpen() {
    const o = this.srv.opts;
    if (this.openFiles >= o.maxOpenFilesPerConnection) throw nerr('EMFILE');
    if (this.srv.openFiles >= o.maxOpenFilesTotal) throw nerr('ENFILE');
    this.openFiles++;
    this.srv.openFiles++;
  }

  unreserveOpen() {
    this.openFiles--;
    this.srv.openFiles--;
  }

  async releaseFid(f) {
    if (f.dead) return;
    f.dead = true;
    this.srv.dropSnapshot(f);
    if (f.counted) { f.counted = false; f.share.fidCount--; }
    const fh = f.fh;
    f.fh = null;
    this.srv.tree.unref(f.node);
    if (f.reserved) { f.reserved = false; this.unreserveOpen(); }
    if (fh) {
      try { await fh.close(); } catch (e) { /* ignore */ }
    }
  }

  // The open handle of a file fid, waiting out a directory-rename swap.
  async fhOf(f) {
    while (f.swapping) await f.swapping;
    if (f.broken) throw nerr('EIO', 'file could not be reopened after its directory was renamed');
    return f.fh;
  }

  setFid(n, f) {
    const old = this.fids.get(n);
    this.fids.set(n, f);
    if (!f.counted && !f.dead) { f.counted = true; f.share.fidCount++; }
    if (old && old !== f) this.releaseFid(old).catch(() => {});
  }

  resetSession() {
    this.session++;
    for (const f of this.fids.values()) this.releaseFid(f).catch(() => {});
    this.fids.clear();
    this.tags.clear();
  }

  writable(share) {
    if (share.readOnly) throw nerr('EROFS');
  }

  // ---- dispatch ----
  handle(ctx, type, r) {
    if (!this.versioned && type !== T.Tversion) throw nerr('EPROTO', 'Tversion must come first');
    const hook = this.srv.opts._testHooks && this.srv.opts._testHooks.beforeOp;
    const run = () => {
      switch (type) {
        case T.Tversion: return this.tversion(ctx, r);
        case T.Tauth: return this.tauth(ctx, r);
        case T.Tattach: return this.tattach(ctx, r);
        case T.Tflush: return this.tflush(ctx, r);
        case T.Twalk: return this.twalk(ctx, r);
        case T.Tlopen: return this.tlopen(ctx, r);
        case T.Tlcreate: return this.tlcreate(ctx, r);
        case T.Tread: return this.tread(ctx, r);
        case T.Twrite: return this.twrite(ctx, r);
        case T.Tclunk: return this.tclunk(ctx, r);
        case T.Tremove: return this.tremove(ctx, r);
        case T.Tgetattr: return this.tgetattr(ctx, r);
        case T.Tsetattr: return this.tsetattr(ctx, r);
        case T.Treaddir: return this.treaddir(ctx, r);
        case T.Tmkdir: return this.tmkdir(ctx, r);
        case T.Tunlinkat: return this.tunlinkat(ctx, r);
        case T.Trenameat: return this.trenameat(ctx, r);
        case T.Trename: return this.trename(ctx, r);
        case T.Tstatfs: return this.tstatfs(ctx, r);
        case T.Tfsync: return this.tfsync(ctx, r);
        case T.Tsymlink: return this.tsymlink(ctx, r);
        case T.Treadlink: return this.treadlink(ctx, r);
        case T.Tlink: return this.tlink(ctx, r);
        case T.Tmknod: return this.tmknod(ctx, r);
        case T.Tlock: return this.tlock(ctx, r);
        case T.Tgetlock: return this.tgetlock(ctx, r);
        case T.Txattrwalk: return this.txattrwalk(ctx, r);
        case T.Txattrcreate: return this.txattrcreate(ctx, r);
        default: throw nerr('EOPNOTSUPP', 'unsupported message type ' + type);
      }
    };
    if (hook && type !== T.Tversion) return Promise.resolve(hook(P.TYPE_NAME[type], ctx)).then(run);
    return run();
  }

  reply(ctx, rtype, cap) { return new Writer(rtype, ctx.tag, cap || 32); }

  // ---- session ----
  tversion(ctx, r) {
    const msize = r.u32();
    const version = r.str();
    this.resetSession();
    ctx.session = this.session;
    this.tags.set(ctx.tag, ctx);
    const w = this.reply(ctx, T.Rversion, 32);
    if (version !== P.VERSION && !version.startsWith(P.VERSION + '.')) {
      this.versioned = false;
      w.u32(Math.min(msize, this.srv.opts.maxMsize)).str('unknown');
      return w.finish();
    }
    if (msize < MIN_MSIZE) {
      this.versioned = false;
      w.u32(msize).str('unknown');
      return w.finish();
    }
    this.msize = Math.min(msize, this.srv.opts.maxMsize);
    this.versioned = true;
    w.u32(this.msize).str(P.VERSION);
    return w.finish();
  }

  async tauth(ctx, r) {
    r.u32(); r.str(); r.str();
    throw nerr('EOPNOTSUPP', 'no Tauth: put the share secret in the attach name');
  }

  async tattach(ctx, r) {
    const fid = r.u32();
    const afid = r.u32();
    const uname = r.str();
    const aname = r.str();
    if (r.remaining >= 4) r.u32(); // n_uname
    const srv = this.srv;
    if (afid !== P.NOFID) throw nerr('EINVAL', 'no auth fids');
    const share = aname.length <= 400 ? srv.authenticate(aname) : null;
    if (!share) {
      this.authFailures++;
      srv.counters.authFailures++;
      if (srv.opts.authFailureDelayMs > 0) await new Promise((res) => setTimeout(res, srv.opts.authFailureDelayMs));
      if (this.authFailures >= srv.opts.maxAuthFailures) {
        ctx.after = ctx.after || [];
        ctx.after.push(() => setImmediate(() => this.destroy('too many failed attaches')));
      }
      throw nerr('EACCES', 'bad share secret');
    }
    ctx.share = share;
    share.stats.ops++;
    if (this.fids.has(fid)) throw nerr('EINVAL', 'fid in use');
    this.fidRoom(fid, share);
    if (BOOT_TAG.test(uname) && !this.bootTag) this.bootTag = uname;
    if (this.bootTag) this.supersede(share);
    this.shareRoom(share);
    const st = await srv.lstat(share, share.realRoot);
    if (!st.isDirectory()) throw nerr('ENOTDIR');
    if (!ctx.alive() || share.removed) throw nerr('ECANCELED');
    if (this.fids.has(fid)) throw nerr('EINVAL', 'fid in use');
    this.fidRoom(fid, share);
    this.shareRoom(share);
    const qid = srv.qidOf(st, share, share.realRoot);
    srv.tree.ref(share.rootNode);
    this.setFid(fid, new Fid(share, share.rootNode, 'dir', qid));
    this.shares.add(share);
    share.conns.add(this);
    share.stats.attaches++;
    if (!this.attached) {
      this.attached = true;
      if (this.preAuth) { clearTimeout(this.preAuth); this.preAuth = null; }
    }
    // The embedding manager learns which boot of a guest mounted which share
    // (a new boot tag = the guest rebooted inside the same QEMU process; the
    // manager then re-mounts shares that guest's boot-time list lacks). Never
    // inline: a slow or throwing callback must not delay or break the reply.
    if (typeof srv.opts.onAttach === 'function') {
      const info = { share: share.id, boot: this.bootTag, connection: this.id };
      setImmediate(() => { try { srv.opts.onAttach(info); } catch (e) { /* the caller's problem, not the guest's */ } });
    }
    return this.reply(ctx, T.Rattach, 24).qid(qid).finish();
  }

  // A mount from a new boot of the VM (another "boot-<id>" attach uname)
  // closes the share's connections left from earlier boots at once: after an
  // in-QEMU reboot slirp keeps their host side open, and they would pin a
  // connection slot and any files they had open (Windows then refuses to
  // rename the folders holding them). Shares are per VM, so a different boot
  // tag on the same share can only be an earlier boot. Untagged connections
  // (hand-made mounts, host tools) are left alone.
  supersede(share) {
    for (const c of Array.from(share.conns)) {
      if (c === this || c.closed || !c.bootTag || c.bootTag === this.bootTag) continue;
      this.srv.counters.superseded++;
      c.destroy('superseded by a newer boot of the VM');
    }
  }

  // Room for this connection among the share's connections? At the cap, the
  // least recently active idle connection of the share is closed instead of
  // refusing: shares are per VM, so those are the VM's own leftovers - above
  // all the mounts of a previous boot that slirp still holds open after an
  // in-QEMU reboot (the host side never learns they are gone). A newer boot's
  // mounts are always more recently active than an older boot's.
  shareRoom(share) {
    if (share.conns.has(this) || share.conns.size < this.srv.opts.maxConnectionsPerShare) return;
    let victim = null;
    for (const c of share.conns) {
      if (c === this || c.closed || c.inflight > 0) continue;
      if (!victim || c.lastActive < victim.lastActive) victim = c;
    }
    if (!victim) throw nerr('EUSERS', 'too many connections to this share');
    this.srv.counters.reclaimed++;
    this.srv.log('warn', '9p: share "' + share.id + '" reached ' + share.conns.size + ' connections; closing the least recently active one (connection ' + victim.id + ')');
    victim.destroy('reclaimed for a new mount');
  }

  tflush(ctx, r) {
    const oldtag = r.u16();
    const old = this.tags.get(oldtag);
    const rflush = () => this.reply(ctx, T.Rflush, 8).finish();
    if (!old || old === ctx || old.done) return rflush();
    return new Promise((resolve) => {
      old.after = old.after || [];
      old.after.push(() => resolve(rflush()));
    });
  }

  // ---- walk ----
  async twalk(ctx, r) {
    const fidn = r.u32();
    const newfid = r.u32();
    const nw = r.u16();
    if (nw > P.MAXWELEM) throw nerr('EINVAL', 'too many walk elements');
    const names = [];
    for (let i = 0; i < nw; i++) {
      try { names.push(r.name()); } catch (e) { if (e instanceof ProtoError && e.errno === ERRNO.EILSEQ) names.push(null); else throw e; }
    }
    const f = this.getFid(ctx, fidn);
    if (newfid !== fidn && this.fids.has(newfid)) throw nerr('EINVAL', 'newfid in use');
    this.fidRoom(newfid, f.share);
    const srv = this.srv;
    const share = f.share;
    if (nw === 0) {
      if (f.dead) throw nerr('EBADF');
      srv.tree.ref(f.node);
      this.setFid(newfid, new Fid(share, f.node, f.kind, f.qid));
      return this.reply(ctx, T.Rwalk, 16).u16(0).finish();
    }
    return srv.withLock(false, ctx, async () => {
      if (f.kind !== 'dir') throw nerr('ENOTDIR');
      let node = f.node;
      let cur = srv.pathOf(share, node);
      srv.tree.ref(node);
      const qids = [];
      let lastSt = null;
      let firstErr = null;
      try {
        for (let i = 0; i < nw; i++) {
          const name = names[i];
          let next;
          let nextPath;
          if (name === '..') {
            next = node === share.rootNode ? node : node.parent;
            if (!next || !srv.tree.isUnder(next, share.rootNode)) { firstErr = nerr('ENOENT'); break; }
            nextPath = srv.pathOf(share, next);
          } else {
            if (name === null || validateName(name)) { firstErr = nerr(name !== null && validateName(name) === ERRNO.ENAMETOOLONG ? 'ENAMETOOLONG' : 'ENOENT'); break; }
            nextPath = cur === share.realRoot ? share.realRootSep + name : cur + SEP + name;
            next = null;
          }
          let st;
          try {
            st = await srv.lstat(share, nextPath);
            if (name !== '..') await srv.aliasGuard(share, cur, name, 'ENOENT');
          } catch (e) { firstErr = e; break; }
          if (!ctx.alive()) throw nerr('ECANCELED');
          if (next === null) {
            if (!srv.tree.isUnder(node, share.rootNode)) throw nerr('ENOENT', 'stale fid');
            next = srv.tree.child(node, name);
          }
          srv.tree.ref(next);
          srv.tree.unref(node);
          node = next;
          cur = nextPath;
          lastSt = st;
          qids.push(srv.qidOf(st, share, nextPath));
          if (i < nw - 1 && !st.isDirectory()) break; // cannot walk through files or links
        }
        if (qids.length === 0) throw firstErr || nerr('ENOENT');
        if (qids.length === nw) {
          if (!ctx.alive()) throw nerr('ECANCELED');
          if (newfid === fidn ? f.dead : (this.fids.has(newfid))) throw nerr(newfid === fidn ? 'EBADF' : 'EINVAL');
          if (newfid !== fidn) this.fidRoom(newfid, share);
          const nf = new Fid(share, node, kindOf(lastSt), qids[qids.length - 1]);
          node = null; // ownership of the walk reference moves to the fid
          this.setFid(newfid, nf);
        }
      } finally {
        if (node) srv.tree.unref(node);
      }
      const w = this.reply(ctx, T.Rwalk, 2 + 13 * qids.length + 8);
      w.u16(qids.length);
      for (const q of qids) w.qid(q);
      return w.finish();
    });
  }

  // ---- open / create ----
  async tlopen(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const flags = r.u32();
    if (f.opened) throw nerr('EINVAL', 'fid already open');
    const acc = flags & L.O_ACCMODE;
    const wantsWrite = acc === L.O_WRONLY || acc === L.O_RDWR || (flags & L.O_TRUNC) !== 0;
    if (wantsWrite) this.writable(f.share);
    const srv = this.srv;
    return srv.withLock(false, ctx, async () => {
      const p = srv.pathOf(f.share, f.node);
      const st = await srv.lstat(f.share, p);
      if (st.isSymbolicLink()) throw nerr('ELOOP', 'refusing to open a symlink');
      if (st.isDirectory()) {
        if (wantsWrite) throw nerr('EISDIR');
        await srv.realInside(p, f.share);
        if (!ctx.alive() || f.dead) throw nerr('ECANCELED');
        if (f.opened) throw nerr('EINVAL', 'fid already open');
        this.reserveOpen(); // an open directory holds a listing snapshot: it counts as an open file
        f.reserved = true;
        f.opened = true;
        f.kind = 'dir';
        srv.dropSnapshot(f);
        f.qid = srv.qidOf(st, f.share, p);
        return this.reply(ctx, T.Rlopen, 24).qid(f.qid).u32(0).finish();
      }
      if (!st.isFile()) throw nerr('EPERM', 'not a regular file');
      if (flags & L.O_DIRECTORY) throw nerr('ENOTDIR');
      // resolved on every open (not cached): a host tool may turn a directory
      // into a junction at any moment (pnpm does), and the answer must hold
      const rp = await srv.realInside(p, f.share);
      this.reserveOpen();
      let fh;
      try {
        fh = await fsp.open(rp, openFlags(flags & ~(L.O_CREAT | L.O_EXCL)));
      } catch (e) {
        this.unreserveOpen();
        throw e;
      }
      try {
        await truncateAfterOpen(fh, rp, flags);
      } catch (e) {
        this.unreserveOpen();
        await fh.close().catch(() => {});
        throw e;
      }
      if (!ctx.alive() || f.dead || f.opened) {
        this.unreserveOpen();
        await fh.close().catch(() => {});
        throw nerr(f.opened ? 'EINVAL' : 'ECANCELED');
      }
      this.installHandle(f, fh, flags);
      f.qid = srv.qidOf(st, f.share, p);
      return this.reply(ctx, T.Rlopen, 24).qid(f.qid).u32(0).finish();
    });
  }

  // f takes over an open handle whose slot was reserved with reserveOpen()
  installHandle(f, fh, flags) {
    const acc = flags & L.O_ACCMODE;
    f.fh = fh;
    f.reserved = true;
    f.opened = true;
    f.kind = 'file';
    f.canRead = acc === L.O_RDONLY || acc === L.O_RDWR;
    f.canWrite = acc === L.O_WRONLY || acc === L.O_RDWR;
    f.append = (flags & L.O_APPEND) !== 0;
    f.reopenFlags = openFlags(flags & ~(L.O_CREAT | L.O_EXCL | L.O_TRUNC));
  }

  async tlcreate(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const name = r.name();
    const flags = r.u32();
    const mode = r.u32();
    r.u32(); // gid
    this.writable(f.share);
    if (f.opened) throw nerr('EINVAL', 'fid already open');
    if (f.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(name);
    const srv = this.srv;
    return srv.withLock(false, ctx, async () => {
      const dir = await srv.realInside(srv.pathOf(f.share, f.node), f.share);
      const target = childPath(dir, name);
      await srv.aliasGuard(f.share, dir, name, 'EEXIST');
      let existing = null;
      try { existing = await srv.lstat(f.share, target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        if (flags & L.O_EXCL) throw nerr('EEXIST');
        if (existing.isSymbolicLink()) throw nerr('EEXIST', 'refusing to create through a symlink');
        if (existing.isDirectory()) throw nerr('EISDIR');
        if (!existing.isFile()) throw nerr('EPERM');
      }
      this.reserveOpen();
      let fh;
      try {
        fh = await fsp.open(target, openFlags(flags | L.O_CREAT), mode & 0o777);
      } catch (e) {
        this.unreserveOpen();
        throw e;
      }
      let st;
      try {
        await truncateAfterOpen(fh, target, flags);
        st = await srv.fstat(f.share, fh);
      } catch (e) {
        this.unreserveOpen();
        await fh.close().catch(() => {});
        throw e;
      }
      if (!ctx.alive() || f.dead || f.opened || !srv.tree.isUnder(f.node, f.share.rootNode)) {
        this.unreserveOpen();
        await fh.close().catch(() => {});
        throw nerr('ECANCELED');
      }
      const node = srv.tree.child(f.node, name);
      srv.tree.ref(node);
      srv.tree.unref(f.node);
      f.node = node;
      this.installHandle(f, fh, flags);
      f.qid = srv.qidOf(st, f.share, target);
      return this.reply(ctx, T.Rlcreate, 24).qid(f.qid).u32(0).finish();
    });
  }

  // ---- data ----
  async tread(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const offset = r.u64n(ERRNO.EINVAL);
    let count = r.u32();
    if (f.opened && f.kind === 'dir') throw nerr('EISDIR');
    const fh = await this.fhOf(f);
    if (!fh || !f.canRead) throw nerr('EBADF', 'fid not open for reading');
    count = Math.min(count, this.msize - 11);
    const buf = Buffer.allocUnsafe(11 + count);
    let n = 0;
    if (count > 0) {
      const res = await fh.read(buf, 11, count, offset);
      n = res.bytesRead;
    }
    f.share.stats.bytesRead += n;
    buf.writeUInt32LE(11 + n, 0);
    buf[4] = T.Rread;
    buf.writeUInt16LE(ctx.tag, 5);
    buf.writeUInt32LE(n, 7);
    return buf.subarray(0, 11 + n);
  }

  async twrite(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const offset = r.u64n(ERRNO.EFBIG);
    const count = r.u32();
    const data = r.bytes(count);
    this.writable(f.share);
    if (f.opened && f.kind === 'dir') throw nerr('EISDIR');
    const fh = await this.fhOf(f);
    if (!fh || !f.canWrite) throw nerr('EBADF', 'fid not open for writing');
    let done = 0;
    while (done < count) {
      const { bytesWritten } = await fh.write(data, done, count - done, f.append ? null : offset + done);
      if (bytesWritten <= 0) break;
      done += bytesWritten;
    }
    f.share.stats.bytesWritten += done;
    return this.reply(ctx, T.Rwrite, 16).u32(done).finish();
  }

  async tclunk(ctx, r) {
    const n = r.u32();
    const f = this.getFid(ctx, n);
    this.fids.delete(n);
    await this.releaseFid(f);
    return this.reply(ctx, T.Rclunk, 8).finish();
  }

  async tremove(ctx, r) {
    const n = r.u32();
    const f = this.getFid(ctx, n);
    this.fids.delete(n); // clunked whatever happens
    const srv = this.srv;
    const share = f.share;
    const node = f.node;
    srv.tree.ref(node); // keep the node while we work
    try {
      await this.releaseFid(f);
      this.writable(share);
      if (node === share.rootNode) throw nerr('EBUSY', 'cannot remove the share root');
      await srv.withLock(false, ctx, async () => {
        // an unlinked node's name may already belong to a different object
        if (node.detached || !node.parent) throw nerr('ENOENT');
        const parent = node.parent;
        const dir = await srv.realInside(srv.pathOf(share, parent), share);
        const target = childPath(dir, node.name);
        const st = await srv.lstat(share, target);
        if (st.isDirectory()) await fsp.rmdir(target); else await fsp.unlink(target);
        srv.tree.detach(parent, node);
      });
    } finally {
      srv.tree.unref(node);
    }
    return this.reply(ctx, T.Rremove, 8).finish();
  }

  // ---- attributes ----
  // Stat a fid: through its open handle when it has one (works for unlinked
  // files), else lstat of its path. p is null for an unlinked open file.
  async statFid(f) {
    const srv = this.srv;
    const fh = f.opened && f.kind === 'file' ? await this.fhOf(f) : null;
    if (fh) {
      const st = await srv.fstat(f.share, fh);
      let p = null;
      try { p = srv.pathOf(f.share, f.node); } catch (e) { p = null; }
      return { st, p, fh };
    }
    const p = srv.pathOf(f.share, f.node);
    return { st: await srv.lstat(f.share, p), p, fh: null };
  }

  async tgetattr(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    r.u64(); // request mask: we always return the basic set + btime
    const srv = this.srv;
    const share = f.share;
    const { st, p } = await this.statFid(f);
    const qid = srv.qidOf(st, share, p);
    f.qid = qid;
    if (!f.opened) f.kind = kindOf(st);
    const mode = await srv.modeOf(share, st, f.node === share.rootNode ? '' : f.node.name, p, qid.path);
    const size = st.isDirectory() && IS_WIN ? 4096n : st.size;
    let blocks = typeof st.blocks === 'bigint' && st.blocks > 0n ? st.blocks : (st.size + 511n) / 512n;
    if (st.isDirectory() && IS_WIN) blocks = 8n;
    const nlink = st.nlink > 0n ? st.nlink : 1n;
    const w = this.reply(ctx, T.Rgetattr, 160);
    w.u64(BigInt(GETATTR.BASIC | GETATTR.BTIME));
    w.qid(qid);
    w.u32(mode).u32(share.uid).u32(share.gid);
    w.u64(nlink).u64(0n).u64(size).u64(4096n).u64(blocks);
    for (const ns of [st.atimeNs, st.mtimeNs, st.ctimeNs, st.birthtimeNs]) {
      const [s, n] = splitNs(ns);
      w.u64(s).u64(n);
    }
    w.u64(0n).u64(0n); // gen, data_version
    return w.finish();
  }

  async tsetattr(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const valid = r.u32();
    const mode = r.u32();
    r.u32(); r.u32(); // uid, gid: accepted and ignored (see header)
    const size = r.u64n(ERRNO.EFBIG);
    const atimeSec = r.u64();
    const atimeNsec = r.u64();
    const mtimeSec = r.u64();
    const mtimeNsec = r.u64();
    const S = SETATTR;
    const mutating = valid & (S.MODE | S.UID | S.GID | S.SIZE | S.ATIME | S.MTIME);
    if (!mutating) return this.reply(ctx, T.Rsetattr, 8).finish();
    this.writable(f.share);
    if (((valid & S.ATIME_SET) && atimeNsec >= 1000000000n) || ((valid & S.MTIME_SET) && mtimeNsec >= 1000000000n)) throw nerr('EINVAL');
    const srv = this.srv;
    const share = f.share;
    await srv.withLock(false, ctx, async () => {
      const { st, p, fh } = await this.statFid(f);
      const isLink = st.isSymbolicLink();
      const isDir = st.isDirectory();
      let rp = null;
      const real = async () => {
        if (rp) return rp;
        if (!p) throw nerr('ENOENT');
        rp = await srv.realInside(p, share);
        return rp;
      };
      if ((valid & S.MODE) && !isLink) {
        if (!IS_WIN) await fsp.chmod(await real(), mode & 0o7777);
        else if (!isDir) {
          const wantRo = (mode & 0o200) === 0;
          const isRo = (Number(st.mode) & 0o200) === 0;
          if (wantRo !== isRo) await fsp.chmod(await real(), wantRo ? 0o444 : 0o666);
        }
      }
      if (valid & S.SIZE) {
        if (isDir) throw nerr('EISDIR');
        if (isLink) throw nerr('EINVAL');
        if (fh && f.canWrite) await fh.truncate(size);
        else await fsp.truncate(await real(), size);
      }
      if (valid & (S.ATIME | S.MTIME)) {
        const now = Date.now() / 1000;
        const secs = (ns) => Number(ns) / 1e9;
        const at = (valid & S.ATIME) ? ((valid & S.ATIME_SET) ? Number(atimeSec) + Number(atimeNsec) / 1e9 : now) : secs(st.atimeNs);
        const mt = (valid & S.MTIME) ? ((valid & S.MTIME_SET) ? Number(mtimeSec) + Number(mtimeNsec) / 1e9 : now) : secs(st.mtimeNs);
        if (isLink) {
          if (!p) throw nerr('ENOENT');
          await fsp.lutimes(p, at, mt);
        } else if (fh && f.canWrite) {
          await fh.utimes(at, mt);
        } else {
          await fsp.utimes(await real(), at, mt);
        }
      }
    });
    return this.reply(ctx, T.Rsetattr, 8).finish();
  }

  // ---- directories ----
  async treaddir(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const offset = r.u64();
    let count = r.u32();
    if (!f.opened) throw nerr('EBADF', 'directory not open');
    if (f.kind !== 'dir') throw nerr('ENOTDIR');
    const srv = this.srv;
    const share = f.share;
    count = Math.min(count, this.msize - 11);
    return srv.withLock(false, ctx, async () => {
      let snap = f.dir;
      if (offset === 0n || !snap) {
        snap = await this.snapshotDir(f);
        if (f.dead || !ctx.alive()) throw nerr('ECANCELED');
        srv.keepSnapshot(f, snap);
      } else {
        srv.touchSnapshot(f);
      }
      // entry i: 0 ".", 1 "..", then the names; the offset of entry i is i+1
      const total = snap.names.length + 2;
      const nameAt = (i) => (i === 0 ? '.' : i === 1 ? '..' : snap.names[i - 2]);
      const pathAt = (i) => (i === 0 ? snap.dot : i === 1 ? snap.dotdot : snap.base + snap.names[i - 2]);
      let start = offset > BigInt(total) ? total : Number(offset);
      const w = this.reply(ctx, T.Rreaddir, 64 + Math.min(count, 4096));
      w.u32(0);
      const countPos = w.pos - 4;
      let used = 0;
      // Pick a page by size (an entry's size does not depend on its qid),
      // stat it, and skip entries that vanished since the snapshot; if all of
      // them did, go on with the next page - an empty reply means "end".
      while (start < total && used === 0) {
        const page = [];
        let room = count;
        let end = start;
        while (end < total) {
          const name = nameAt(end);
          const sz = 24 + Buffer.byteLength(name, 'utf8');
          if (sz > room) break;
          room -= sz;
          page.push(end);
          end++;
        }
        if (!page.length) break;
        const stats = new Array(page.length);
        await mapLimit(page, 32, async (i, k) => {
          try { stats[k] = await fsp.lstat(pathAt(i), { bigint: true }); } catch (err) { stats[k] = null; }
        });
        if (!ctx.alive()) throw nerr('ECANCELED');
        for (let k = 0; k < page.length; k++) {
          const st = stats[k];
          if (!st) continue;
          const i = page[k];
          const dt = st.isDirectory() ? DT.DIR : st.isSymbolicLink() ? DT.LNK : st.isFile() ? DT.REG : DT.UNKNOWN;
          const before = w.pos;
          w.qid(srv.qidOf(st, share, pathAt(i))).u64(BigInt(i + 1)).u8(dt).str(nameAt(i));
          used += w.pos - before;
        }
        start = end;
      }
      w.buf.writeUInt32LE(w.pos - countPos - 4, countPos);
      return w.finish();
    });
  }

  // The directory's addressable names, read once (Treaddir at offset 0) and
  // kept for paging; compact on purpose (names only), see keepSnapshot().
  async snapshotDir(f) {
    const srv = this.srv;
    const share = f.share;
    const p = srv.pathOf(share, f.node);
    const rp = await srv.realInside(p, share);
    const all = await fsp.readdir(rp);
    const base = rp.endsWith(SEP) ? rp : rp + SEP;
    let dotdot = rp;
    if (f.node !== share.rootNode) dotdot = srv.pathOf(share, f.node.parent);
    const names = [];
    for (const name of all) if (!validateName(name)) names.push(name); // others are not addressable from the guest
    return { base, names, dot: rp, dotdot };
  }

  async tmkdir(ctx, r) {
    const d = this.getFid(ctx, r.u32());
    const name = r.name();
    const mode = r.u32();
    r.u32(); // gid
    this.writable(d.share);
    if (d.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(name);
    const srv = this.srv;
    return srv.withLock(false, ctx, async () => {
      const dir = await srv.realInside(srv.pathOf(d.share, d.node), d.share);
      await srv.aliasGuard(d.share, dir, name, 'EEXIST');
      const target = childPath(dir, name);
      await fsp.mkdir(target, IS_WIN ? undefined : { mode: mode & 0o7777 });
      const st = await srv.lstat(d.share, target);
      return this.reply(ctx, T.Rmkdir, 24).qid(srv.qidOf(st, d.share, target)).finish();
    });
  }

  async tunlinkat(ctx, r) {
    const d = this.getFid(ctx, r.u32());
    const name = r.name();
    const flags = r.u32();
    this.writable(d.share);
    if (d.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(name, 'ENOENT');
    const srv = this.srv;
    await srv.withLock(false, ctx, async () => {
      const dir = await srv.realInside(srv.pathOf(d.share, d.node), d.share);
      await srv.aliasGuard(d.share, dir, name, 'ENOENT');
      const target = childPath(dir, name);
      const st = await srv.lstat(d.share, target);
      if (flags & P.AT_REMOVEDIR) {
        if (!st.isDirectory()) throw nerr('ENOTDIR');
        await fsp.rmdir(target);
      } else {
        if (st.isDirectory()) throw nerr('EISDIR');
        await fsp.unlink(target);
      }
      srv.tree.detachChild(d.node, name);
    });
    return this.reply(ctx, T.Runlinkat, 8).finish();
  }

  async trenameat(ctx, r) {
    const od = this.getFid(ctx, r.u32());
    const oldName = r.name();
    const nd = this.getFid(ctx, r.u32());
    const newName = r.name();
    if (od.share !== nd.share) throw nerr('EXDEV');
    if (od.kind !== 'dir' || nd.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(oldName, 'ENOENT');
    await this.doRename(ctx, od.share, () => ({ dirNode: od.node, name: oldName }), nd.node, newName);
    return this.reply(ctx, T.Rrenameat, 8).finish();
  }

  async trename(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const d = this.getFid(ctx, r.u32());
    const newName = r.name();
    if (f.share !== d.share) throw nerr('EXDEV');
    if (d.kind !== 'dir') throw nerr('ENOTDIR');
    // resolved under the lock: a concurrent rename may have moved the node
    const src = () => {
      const n = f.node;
      if (n === f.share.rootNode) throw nerr('EBUSY', 'cannot rename the share root');
      if (!n.parent || n.detached) throw nerr('ENOENT');
      return { dirNode: n.parent, name: n.name };
    };
    await this.doRename(ctx, f.share, src, d.node, newName);
    return this.reply(ctx, T.Rrename, 8).finish();
  }

  async doRename(ctx, share, srcOf, dstDirNode, dstName) {
    this.writable(share);
    checkName(dstName);
    const srv = this.srv;
    await srv.withLock(true, ctx, async () => {
      const { dirNode: srcDirNode, name: srcName } = srcOf();
      const sdir = await srv.realInside(srv.pathOf(share, srcDirNode), share);
      const ddir = await srv.realInside(srv.pathOf(share, dstDirNode), share);
      await srv.aliasGuard(share, sdir, srcName, 'ENOENT');
      await srv.aliasGuard(share, ddir, dstName, 'EINVAL');
      const src = childPath(sdir, srcName);
      const dst = childPath(ddir, dstName);
      const sst = await srv.lstat(share, src);
      if (src === dst) return;
      const srcIsDir = sst.isDirectory();
      if (srcIsDir && cmpKey(dst).startsWith(cmpKey(src) + SEP)) throw nerr('EINVAL', 'cannot move a directory into itself');
      if (sst.isSymbolicLink() && cmpKey(sdir) !== cmpKey(ddir)) await srv.checkLinkMove(share, src, ddir);
      let dstSt = null;
      try { dstSt = await srv.lstat(share, dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let suspended = null;
      try {
        if (dstSt) {
          const same = sst.ino !== 0n && dstSt.ino === sst.ino && dstSt.dev === sst.dev;
          if (same) {
            if (!(CASE_INSENSITIVE && cmpKey(src) === cmpKey(dst))) return; // two links to one file: POSIX no-op
            suspended = srcIsDir ? await this.renameDir(src, dst, srcDirNode, srcName) : (await fsp.rename(src, dst), null); // case-only
          } else if (srcIsDir) {
            if (!dstSt.isDirectory()) throw nerr('ENOTDIR');
            if ((await fsp.readdir(dst)).length) throw nerr('ENOTEMPTY');
            await fsp.rmdir(dst);
            try { suspended = await this.renameDir(src, dst, srcDirNode, srcName); } catch (e) { await fsp.mkdir(dst).catch(() => {}); throw e; }
          } else {
            if (dstSt.isDirectory()) throw nerr('EISDIR');
            await this.replaceFile(src, dst, ddir);
          }
        } else if (srcIsDir) {
          suspended = await this.renameDir(src, dst, srcDirNode, srcName);
        } else {
          await fsp.rename(src, dst);
        }
        srv.tree.move(srcDirNode, srcName, dstDirNode, dstName);
      } finally {
        if (suspended) await srv.resumeHandles(suspended); // reopened at their new paths
      }
    });
  }

  // Windows refuses to rename a directory while any handle is open below it,
  // including our own. If ours are the reason, close them, rename, and let
  // the caller reopen them at the new location (fhOf() makes reads/writes
  // wait meanwhile). Returns the suspended fids, or null.
  async renameDir(src, dst, srcDirNode, srcName) {
    try {
      await fsp.rename(src, dst);
      return null;
    } catch (e) {
      if (!IS_WIN || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const srv = this.srv;
      const node = srv.tree.peek(srcDirNode, srcName);
      const held = node ? srv.openFidsUnder(node) : [];
      if (!held.length) throw e;
      await srv.suspendHandles(held);
      try {
        await fsp.rename(src, dst);
      } catch (e2) {
        await srv.resumeHandles(held);
        throw e2;
      }
      return held;
    }
  }

  // rename(src, dst) where dst is an existing non-directory. Windows refuses
  // when dst is open or read-only; move it aside first, then delete it.
  async replaceFile(src, dst, ddir) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(e.code)) throw e;
    }
    const aside = childPath(ddir, '.9p-replaced-' + crypto.randomBytes(6).toString('hex'));
    await fsp.rename(dst, aside);
    try {
      await fsp.rename(src, dst);
    } catch (e) {
      await fsp.rename(aside, dst).catch(() => {});
      throw e;
    }
    try {
      await fsp.unlink(aside);
    } catch (e) {
      try { await fsp.chmod(aside, 0o666); await fsp.unlink(aside); } catch (e2) { this.srv.log('warn', '9p: could not delete ' + aside + ': ' + e2.message); }
    }
  }

  // ---- links ----
  async tsymlink(ctx, r) {
    const d = this.getFid(ctx, r.u32());
    const name = r.name();
    const target = r.name();
    r.u32(); // gid
    this.writable(d.share);
    if (d.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(name);
    if (!target || Buffer.byteLength(target, 'utf8') > 4095 || target.indexOf('\0') !== -1) throw nerr('EINVAL');
    if (target.startsWith('/')) throw nerr('EPERM', 'absolute symlink targets are not supported');
    const parts = target.split('/');
    for (const c of parts) {
      if (c === '' || c === '.' || c === '..') continue;
      if (validateName(c)) throw nerr('EPERM', 'symlink target has a component the host cannot store');
    }
    const srv = this.srv;
    const share = d.share;
    return srv.withLock(true, ctx, async () => {
      const dir = await srv.realInside(srv.pathOf(share, d.node), share);
      await srv.aliasGuard(share, dir, name, 'EEXIST');
      const resolved = path.resolve(dir, ...parts.filter((c) => c !== ''));
      if (!srv.isInside(resolved, share)) throw nerr('EPERM', 'symlink target leaves the share');
      let type = 'file';
      try {
        const rt = await srv.realInside(resolved, share, true);
        if ((await fsp.stat(rt)).isDirectory()) type = 'dir';
      } catch (e) { /* dangling or outside: a file link */ }
      const linkPath = childPath(dir, name);
      await fsp.symlink(IS_WIN ? target.replace(/\//g, '\\') : target, linkPath, IS_WIN ? type : undefined);
      const st = await srv.lstat(share, linkPath);
      return this.reply(ctx, T.Rsymlink, 24).qid(srv.qidOf(st, share, linkPath)).finish();
    });
  }

  async treadlink(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const srv = this.srv;
    return srv.withLock(false, ctx, async () => {
      const p = srv.pathOf(f.share, f.node);
      const st = await srv.lstat(f.share, p);
      if (!st.isSymbolicLink()) throw nerr('EINVAL', 'not a symlink');
      const t = srv.translateLink(await fsp.readlink(p), p, f.share);
      if (P.strSize(t) + 11 > this.msize) throw nerr('ENAMETOOLONG');
      return this.reply(ctx, T.Rreadlink, 16 + t.length * 3).str(t).finish();
    });
  }

  async tlink(ctx, r) {
    const d = this.getFid(ctx, r.u32());
    const f = this.getFid(ctx, r.u32());
    const name = r.name();
    if (d.share !== f.share) throw nerr('EXDEV');
    this.writable(d.share);
    if (d.kind !== 'dir') throw nerr('ENOTDIR');
    checkName(name);
    const srv = this.srv;
    const share = d.share;
    await srv.withLock(true, ctx, async () => {
      const sp = srv.pathOf(share, f.node);
      const st = await srv.lstat(share, sp);
      if (st.isDirectory()) throw nerr('EPERM', 'hard links to directories are not allowed');
      if (st.isSymbolicLink()) throw nerr('EPERM', 'hard links to symlinks are not supported');
      if (!st.isFile()) throw nerr('EPERM');
      const src = await srv.realInside(sp, share);
      const dir = await srv.realInside(srv.pathOf(share, d.node), share);
      await srv.aliasGuard(share, dir, name, 'EEXIST');
      await fsp.link(src, childPath(dir, name));
    });
    return this.reply(ctx, T.Rlink, 8).finish();
  }

  async tmknod(ctx, r) {
    const d = this.getFid(ctx, r.u32());
    r.name(); r.u32(); r.u32(); r.u32(); r.u32();
    this.writable(d.share);
    throw nerr('EPERM', 'device nodes, fifos and sockets are not supported');
  }

  // ---- misc ----
  async tstatfs(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const s = await fsp.statfs(f.share.realRoot, { bigint: true });
    const files = s.files > 0n ? s.files : s.blocks;
    const ffree = s.files > 0n ? s.ffree : s.bfree;
    const w = this.reply(ctx, T.Rstatfs, 72);
    w.u32(P.V9FS_MAGIC).u32(Number(s.bsize) || 4096).u64(s.blocks).u64(s.bfree).u64(s.bavail)
      .u64(files).u64(ffree).u64(f.share.fsid).u32(255);
    return w.finish();
  }

  async tfsync(ctx, r) {
    const f = this.getFid(ctx, r.u32());
    const datasync = r.remaining >= 4 ? r.u32() : 0;
    const fh = f.opened && f.kind === 'file' ? await this.fhOf(f) : null;
    if (fh && f.canWrite) {
      if (datasync) await fh.datasync(); else await fh.sync();
    }
    return this.reply(ctx, T.Rfsync, 8).finish();
  }

  async tlock(ctx, r) {
    this.getFid(ctx, r.u32());
    r.u8(); r.u32(); r.u64(); r.u64(); r.u32(); r.str();
    return this.reply(ctx, T.Rlock, 8).u8(P.LOCK_STATUS.SUCCESS).finish();
  }

  async tgetlock(ctx, r) {
    this.getFid(ctx, r.u32());
    r.u8();
    const start = r.u64();
    const length = r.u64();
    const procId = r.u32();
    const clientId = r.str();
    return this.reply(ctx, T.Rgetlock, 40 + clientId.length * 3)
      .u8(P.LOCK_TYPE.UNLCK).u64(start).u64(length).u32(procId).str(clientId).finish();
  }

  async txattrwalk(ctx, r) {
    this.getFid(ctx, r.u32());
    r.u32(); r.str();
    throw nerr('EOPNOTSUPP', 'extended attributes are not supported');
  }

  async txattrcreate(ctx, r) {
    this.getFid(ctx, r.u32());
    r.str(); r.u64(); r.u32();
    throw nerr('EOPNOTSUPP', 'extended attributes are not supported');
  }
}

async function createServer(opts) {
  const s = new NinepServer(opts);
  try {
    await s.listen();
  } catch (e) {
    await s.close().catch(() => {});
    throw e;
  }
  return s;
}

module.exports = {
  createServer, NinepServer, validateName, toErrno, generateSecret, formatAname, mountOptions, mountCommand,
  NineError, PathTree, RWLock, OUTSIDE_LINK, DEFAULTS, proto: P,
};
