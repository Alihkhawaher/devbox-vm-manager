'use strict';
/*
 * --copy-in HOSTDIR:/path - the substitute for bind mounts (this QEMU build
 * has neither 9p nor virtio-fs). Host folders are packed into ONE newc cpio
 * archive that QEMU attaches as a read-only raw virtio-blk disk (serial
 * devbox-copyin; the archive is padded to 512 bytes, a whole sector);
 * init.sh extracts it with busybox cpio after the volumes are mounted and
 * before the container starts, then chowns what it extracted to the
 * container user (or leaves root with --copy-in-owner root).
 *
 *   packCopyIn(items, outFile, opts) -> Promise<{file, entries, files, dirs,
 *       symlinks, bytes, archiveBytes, skipped: [{path, reason}], ms}>
 *     items: [{hostDir, target}]  target: absolute container path (normalized)
 *     opts:  {maxBytes (default 512 MiB), platform (process.platform)}
 *
 * What goes in:
 *  - the CONTENTS of hostDir at <target>/<relative path>, parents before
 *    children, names sorted (deterministic). The target directory itself is
 *    not an entry: init creates it when missing, and an existing one (e.g.
 *    /usr/share/nginx/html) keeps its owner and mode;
 *  - .devbox/run/copyin.list: every extracted path, one per line (init chowns
 *    exactly these, never the image's own files around them).
 * Modes: Windows has no Unix permission bits, so directories are 0755 and
 *   files 0644, or 0755 when they start with "#!" or the ELF magic. On POSIX
 *   hosts the file's own permission bits are kept.
 * Symlinks: relative targets are kept (backslashes become "/"); absolute ones
 *   (C:\..., /home/...) point outside the guest's world and are skipped.
 * Skipped with a reason: sockets/fifos/devices, names containing a newline
 *   (the list is line-based) or a backslash on POSIX hosts, unreadable files.
 *
 * LIMITS (by design): a one-way copy made at every start (changes on either
 * side are not synced; nothing flows back). It is extracted OVER the
 * container's files: on a disk root (its writable layer persists) a file
 * deleted on the host since the last start stays in the container (cr-7);
 * a RAM root starts clean. With a RAM root the files live in the guest's RAM
 * unless the target is inside a volume (guest memory is raised by the
 * archive size); the archive is a second copy on the host disk for the
 * run's lifetime, newc caps files at 4 GiB, the total is capped by maxBytes
 * (512 MiB), and Unix modes are guessed on Windows hosts (see Modes).
 * Why a disk and not QEMU fw_cfg: the guest's fw_cfg sysfs read re-skips to
 * its offset with single-byte port reads for every 4 KB chunk, so a 1 MB
 * archive did not arrive within 10 minutes under WHPX.
 */
const fs = require('fs');
const path = require('path');
const { CpioWriter, partName } = require('../oci/cpio');

const DEFAULT_MAX = 512 * 1048576;
const SMALL_FILE = 1048576;
const READ_AHEAD = 16;
const LIST_PATH = '.devbox/run/copyin.list';

class CopyInError extends Error {
  constructor(message) { super(message); this.name = 'CopyInError'; this.code = 'COPY_IN'; }
}

const isExecutableHead = (b, n) => (n >= 2 && b[0] === 0x23 && b[1] === 0x21) || (n >= 4 && b.readUInt32BE(0) === 0x7f454c46);

function sniffExecutable(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    return isExecutableHead(b, n);
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Walk one host folder: [{rel, abs, type, size, mode, mtime, linkpath}] with
// parents before children.
function walk(root, platform, skipped) {
  const out = [];
  const win = platform === 'win32';
  const visit = (absDir, relDir) => {
    let names;
    try { names = fs.readdirSync(absDir); } catch (e) { skipped.push({ path: absDir, reason: e.code || e.message }); return; }
    names.sort();
    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = relDir ? relDir + '/' + name : name;
      if (/[\n\r]/.test(name) || (!win && name.includes('\\'))) { skipped.push({ path: abs, reason: 'name contains a newline or backslash' }); continue; }
      let st;
      try { st = fs.lstatSync(abs); } catch (e) { skipped.push({ path: abs, reason: e.code || e.message }); continue; }
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isSymbolicLink()) {
        let target;
        try { target = fs.readlinkSync(abs); } catch (e) { skipped.push({ path: abs, reason: e.code || e.message }); continue; }
        if (win) target = target.replace(/\\/g, '/');
        if (target.startsWith('/') || /^[A-Za-z]:/.test(target) || target.startsWith('//')) {
          skipped.push({ path: abs, reason: 'absolute symlink target ' + target + ' has no meaning in the guest' });
          continue;
        }
        out.push({ rel, abs, type: 'symlink', linkpath: target, mtime });
      } else if (st.isDirectory()) {
        out.push({ rel, abs, type: 'dir', mode: win ? 0o755 : (st.mode & 0o7777), mtime });
        visit(abs, rel);
      } else if (st.isFile()) {
        // Windows: the mode is decided from the content when the file is read
        const mode = win ? null : (st.mode & 0o7777);
        out.push({ rel, abs, type: 'file', size: st.size, mode, mtime });
      } else {
        skipped.push({ path: abs, reason: 'not a regular file, directory or symlink' });
      }
    }
  };
  visit(root, '');
  return out;
}

async function packCopyIn(items, outFile, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const platform = opts.platform || process.platform;
  const maxBytes = opts.maxBytes || DEFAULT_MAX;
  const skipped = [];
  const plan = [];
  const seenTargets = new Set();
  let bytes = 0;
  for (const it of items) {
    const hostDir = path.resolve(it.hostDir);
    let st;
    try { st = fs.statSync(hostDir); } catch (e) { throw new CopyInError('--copy-in: host folder not found: ' + hostDir); }
    if (!st.isDirectory()) throw new CopyInError('--copy-in: not a folder: ' + hostDir + ' (copy-in takes folders)');
    const target = String(it.target).replace(/\/+$/, '');
    if (!target.startsWith('/') || target === '') throw new CopyInError('--copy-in: bad target ' + it.target);
    if (seenTargets.has(target)) throw new CopyInError('--copy-in: two folders copied to ' + target);
    seenTargets.add(target);
    const prefix = target.slice(1);
    for (const e of walk(hostDir, platform, skipped)) {
      e.path = prefix + '/' + e.rel;
      if (e.type === 'file') bytes += e.size;
      plan.push(e);
    }
    if (bytes > maxBytes) {
      throw new CopyInError('--copy-in: ' + Math.round(bytes / 1048576) + ' MB is more than the ' + Math.round(maxBytes / 1048576) +
        ' MB limit (the files live in guest RAM); use a volume for bulk data');
    }
  }
  // A later item may copy into a folder an earlier one created: keep the
  // first entry per path (dirs), let later files win (like cp -r twice).
  const byPath = new Map();
  for (const e of plan) {
    const prev = byPath.get(e.path);
    if (prev && prev.type === 'dir' && e.type === 'dir') continue;
    byPath.set(e.path, e);
  }
  const entries = [...byPath.values()];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const part = partName(outFile);
  const ws = fs.createWriteStream(part, { highWaterMark: 1 << 20 });
  const w = new CpioWriter(ws);
  const counts = { files: 0, dirs: 0, symlinks: 0 };
  const list = [];
  // read-ahead: small files are read READ_AHEAD at a time on the libuv pool,
  // which hides most of the per-open cost (~1 ms each on Windows, antivirus)
  const small = entries.filter((e) => e.type === 'file' && e.size > 0 && e.size <= SMALL_FILE);
  const pending = new Map();
  let next = 0;
  const fill = () => {
    while (next < small.length && pending.size < READ_AHEAD) {
      const e = small[next++];
      const p = fs.promises.readFile(e.abs);
      p.catch(() => {}); // handled when awaited
      pending.set(e, p);
    }
  };
  try {
    fill();
    for (const e of entries) {
      if (e.type === 'dir') {
        await w.add({ path: e.path, type: 'dir', mode: e.mode, uid: 0, gid: 0, mtime: e.mtime });
        counts.dirs++;
      } else if (e.type === 'symlink') {
        await w.add({ path: e.path, type: 'symlink', linkpath: e.linkpath, uid: 0, gid: 0, mtime: e.mtime });
        counts.symlinks++;
      } else {
        // small files: ONE open and read (each open is scanned on Windows);
        // large ones are streamed
        let data = null, mode = e.mode;
        try {
          if (e.size === 0) {
            data = Buffer.alloc(0);
            if (mode === null) mode = 0o644;
          } else if (e.size <= SMALL_FILE) {
            data = await pending.get(e);
            pending.delete(e);
            fill();
            if (mode === null) mode = isExecutableHead(data, data.length) ? 0o755 : 0o644;
          } else {
            if (mode === null) mode = sniffExecutable(e.abs) ? 0o755 : 0o644;
            data = fs.createReadStream(e.abs, { highWaterMark: 1 << 20 });
          }
          await w.add({ path: e.path, type: 'file', mode, uid: 0, gid: 0, mtime: e.mtime, size: e.size }, e.size ? data : null);
        } catch (err) {
          if (data && data.destroy) data.destroy();
          if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EBUSY' || err.code === 'EPERM') throw new CopyInError('--copy-in: cannot read ' + e.abs + ' (' + err.code + ')');
          throw new CopyInError('--copy-in: ' + e.abs + ' changed while it was being copied (' + err.message + ')');
        }
        counts.files++;
      }
      list.push(e.path);
    }
    const listBuf = Buffer.from(list.length ? list.join('\n') + '\n' : '', 'utf8');
    await w.add({ path: LIST_PATH, type: 'file', mode: 0o600, uid: 0, gid: 0, mtime: 0 }, listBuf);
    await w.finish();
    await new Promise((resolve, reject) => { ws.once('error', reject); ws.once('close', resolve); ws.end(); });
    fs.renameSync(part, outFile);
  } catch (e) {
    ws.destroy();
    await new Promise((r) => (ws.closed ? r() : ws.once('close', r)));
    fs.rmSync(part, { force: true });
    throw e;
  }
  return {
    file: outFile, entries: entries.length, files: counts.files, dirs: counts.dirs, symlinks: counts.symlinks,
    bytes, archiveBytes: fs.statSync(outFile).size, targets: [...seenTargets], skipped, ms: Date.now() - t0,
  };
}

module.exports = { packCopyIn, walk, sniffExecutable, CopyInError, LIST_PATH, DEFAULT_MAX };
