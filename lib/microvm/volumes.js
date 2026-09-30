'use strict';
/*
 * Named volumes for microVM runs: one sparse qcow2 file per name, formatted
 * as ext4 by the host (mkext4.js; the guest busybox has no mkfs), attached
 * as a virtio-blk disk and bind-mounted by init.sh at the target. The data
 * lives in the volume's "data" directory; on FIRST use init copies the
 * image's content at the target into it (Docker named-volume semantics,
 * "nocopy" disables that).
 *
 *   volumeFile(dir, name)                 -> <dir>/<name>.qcow2
 *   ensureVolume(dir, name, {sizeBytes})  -> {name, file, created, sizeBytes, ms}
 *   listVolumes(dir)                      -> [{name, file, fileBytes, virtualBytes, mtime, createdAt}]
 *   removeVolume(dir, name)
 *   acquireLock(dir, name, o) / releaseLock(dir, name, containerId) /
 *   readLock(dir, name)                   the attach lock (below)
 *
 * EXCLUSIVITY (bug V1). A volume must never be attached to two running VMs:
 * two ext4 drivers on one disk corrupt it. QEMU on Windows does NOT lock
 * the image file (verified: two VMs mounted one volume and a write was
 * lost), so the engine guarantees it itself:
 *  - the start re-reads the container registry AFTER the (slow) image
 *    preparation, then
 *  - creates <name>.lock with flag "wx" (atomic: of two starts, even in two
 *    processes, exactly one creates it) holding {managerPid, containerId,
 *    at}, and keeps it while the VM runs; it is released on exit, remove
 *    or a failed start.
 *  - A lock is STALE when its container is not running (the caller's
 *    isLive) and its manager is dead or is this very manager; a lock of a
 *    live other manager process is always respected. A lock file that
 *    cannot be read yet (another process between its create and its write)
 *    is respected for 10 s.
 * Names are matched case-insensitively (NTFS is case-insensitive).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mkext4 = require('./mkext4');
const { readQcow2Header } = require('./qcow2');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_SIZE = 8 * 1024 ** 3;
const UNREADABLE_GRACE_MS = 10000;

class VolumeError extends Error {
  constructor(code, message, status, extra) { super(message); this.name = 'VolumeError'; this.code = code; this.status = status || 400; if (extra) Object.assign(this, extra); }
}

function checkName(name) {
  if (!NAME_RE.test(String(name))) throw new VolumeError('BAD_REQUEST', 'bad volume name "' + name + '" (letters, digits and . _ -, at most 64, starting with a letter or digit)');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new VolumeError('BAD_REQUEST', 'volume name "' + name + '" is reserved on Windows');
  return name;
}

function volumeFile(dir, name) {
  return path.join(dir, checkName(name).toLowerCase() + '.qcow2');
}
function lockFile(dir, name) {
  return path.join(dir, checkName(name).toLowerCase() + '.lock');
}

function ensureVolume(dir, name, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const file = volumeFile(dir, name);
  if (fs.existsSync(file)) {
    const hdr = readQcow2Header(readHead(file));
    return { name, file, created: false, sizeBytes: Number(hdr.size), ms: Date.now() - t0 };
  }
  fs.mkdirSync(dir, { recursive: true });
  const sizeBytes = opts.sizeBytes || DEFAULT_SIZE;
  if (sizeBytes < 16 * 1048576) throw new VolumeError('BAD_REQUEST', 'a volume must be at least 16 MB');
  // write under a temporary name so a crash never leaves a half-made volume;
  // unique per writer (another manager process on this data root may make
  // the same volume at the same moment - the first rename wins)
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  try {
    mkext4.createQcow2(part, sizeBytes, { label: String(name).slice(0, 16) });
    if (!fs.existsSync(file)) {
      try { fs.renameSync(part, file); } catch (e) { if (!fs.existsSync(file)) throw e; }
    }
  } finally {
    fs.rmSync(part, { force: true });
  }
  const hdr = readQcow2Header(readHead(file));
  return { name, file, created: true, sizeBytes: Number(hdr.size), ms: Date.now() - t0 };
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(512);
    fs.readSync(fd, b, 0, 512, 0);
    return b;
  } finally { fs.closeSync(fd); }
}

function listVolumes(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const f of names.sort()) {
    if (!f.endsWith('.qcow2')) continue;
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      const hdr = readQcow2Header(readHead(file));
      out.push({
        name: f.slice(0, -6), file, fileBytes: st.size, virtualBytes: Number(hdr.size),
        mtime: st.mtime.toISOString(), createdAt: (st.birthtimeMs ? st.birthtime : st.ctime).toISOString(),
      });
    } catch (e) { /* not ours */ }
  }
  return out;
}

function removeVolume(dir, name) {
  const file = volumeFile(dir, name);
  if (!fs.existsSync(file)) throw new VolumeError('NOT_FOUND', 'no volume called "' + name + '"', 404);
  fs.rmSync(file);
  try { fs.rmSync(lockFile(dir, name), { force: true }); } catch (e) { /* gone */ }
}

// ---------------------------------------------------------------------------
// the attach lock
// ---------------------------------------------------------------------------
const pidAlive = (pid) => require('../platform').pidAlive(pid);

// -> null (no lock) | {managerPid, containerId, at} | {unreadable: true, ageMs}
function readLock(dir, name) {
  const file = lockFile(dir, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? null : { unreadable: true, ageMs: 0 }; }
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return j;
  } catch (e) { /* being written, or damaged */ }
  let ageMs = 0;
  try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch (e) { /* gone meanwhile */ }
  return { unreadable: true, ageMs };
}

// Is the lock `cur` still held? o: {containerId, isLive(id) -> bool}
function lockHeld(cur, o) {
  if (!cur) return false;
  if (cur.unreadable) return cur.ageMs < UNREADABLE_GRACE_MS;
  if (cur.managerPid && cur.managerPid !== process.pid && pidAlive(cur.managerPid)) return true;
  return !!(cur.containerId && cur.containerId !== o.containerId && o.isLive && o.isLive(cur.containerId));
}

// Take the attach lock of volume `name` for container o.containerId.
// o: {containerId, isLive(id) -> bool, nameOf(id) -> text}. Throws
// VolumeError VOLUME_IN_USE (409) naming the holder.
function acquireLock(dir, name, o) {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir, name);
  const body = JSON.stringify({ managerPid: process.pid, containerId: o.containerId, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const cur = readLock(dir, name);
    if (cur && !cur.unreadable && cur.containerId === o.containerId && !(cur.managerPid && cur.managerPid !== process.pid && pidAlive(cur.managerPid))) {
      // our own lock, left by this container's previous run (or an earlier
      // manager process that is gone): take it over
      fs.writeFileSync(file, body);
      return true;
    }
    if (lockHeld(cur, o)) {
      const who = cur.unreadable ? 'another start that is taking it right now'
        : (cur.managerPid !== process.pid && pidAlive(cur.managerPid)) ? 'another manager process (pid ' + cur.managerPid + ')'
          : 'container "' + ((o.nameOf && o.nameOf(cur.containerId)) || cur.containerId) + '"';
      throw new VolumeError('VOLUME_IN_USE', 'volume "' + name + '" is in use by ' + who + ' - a volume can be attached to one running container at a time', 409,
        { holder: cur.unreadable ? null : { containerId: cur.containerId || null, managerPid: cur.managerPid || null } });
    }
    // stale: its container is not running any more
    try { fs.rmSync(file, { force: true }); } catch (e) { /* retried */ }
  }
  throw new VolumeError('VOLUME_IN_USE', 'volume "' + name + '" is locked and the lock could not be taken over - try again', 409);
}

// Release only a lock this container holds.
function releaseLock(dir, name, containerId) {
  const cur = readLock(dir, name);
  if (cur && !cur.unreadable && cur.containerId === containerId) {
    try { fs.rmSync(lockFile(dir, name), { force: true }); return true; } catch (e) { return false; }
  }
  return false;
}

module.exports = {
  ensureVolume, listVolumes, removeVolume, volumeFile, lockFile, checkName, readLock, acquireLock, releaseLock, lockHeld,
  VolumeError, DEFAULT_SIZE, NAME_RE,
};
