'use strict';
/*
 * Facts about an image's root filesystem, read from its cached initrd
 * (the flattened rootfs archive comes first in that file):
 *
 *   imageFacts(initrdFile) -> {passwd, group, s6}   cached per file
 *       passwd / group: the text of /etc/passwd and /etc/group (null when
 *       missing, at most 256 KB each); s6: the image ships s6-overlay
 *       (/package/admin/s6-overlay or /etc/s6-overlay; spec 14.3)
 *   diskFacts(meta) -> {passwd, group, s6}
 *       the same facts of a DISK-ROOT image: the image-disk writer captures
 *       them while it streams the layers (rootdisk.js sidecar), so nothing
 *       has to be scanned - a disk root's initrd holds no image at all
 *   resolveUser(user, facts) -> {uid, gid, found}
 *       Docker's USER forms ("", name, uid, name:group, uid:gid) resolved
 *       the way init.sh does it in the guest, so a live shared folder can
 *       report files as owned by the container user (the 9P server has no
 *       real owners on Windows, and the guest checks permissions itself: a
 *       non-root app could not write to a folder shown as root's).
 *
 * WHY scan the initrd instead of asking the flattener: the rootfs archive is
 * deleted once the initrd exists, the caches from earlier versions have no
 * such facts, and the scan is cheap - one read of the newc header and name
 * per entry, seeking over file data (a 60 MB python image: ~3500 entries).
 * The initrd is named by content, so a result never goes stale.
 */
const fs = require('fs');

const HEADER = 110;
const MAX_TEXT = 256 * 1024;
const WANT = { 'etc/passwd': 'passwd', 'etc/group': 'group' };
const S6_RE = /^(package\/admin\/s6-overlay|etc\/s6-overlay)(\/|$)/;
const cache = new Map(); // file -> {size, mtimeMs, facts}

const align4 = (n) => (n + 3) & ~3;

function scan(file) {
  const facts = { passwd: null, group: null, s6: false, entries: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(HEADER + 4096);
    let pos = 0;
    while (pos + HEADER <= size && facts.entries < 4000000) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n < HEADER) break;
      // zero padding between concatenated archives: the rootfs archive is
      // over by then (its TRAILER!!! came first), so this is not reached
      // in practice; skip it anyway
      if (buf[0] === 0) {
        let i = 0;
        while (i < n && buf[i] === 0) i++;
        const step = i & ~3;
        if (!step) break;
        pos += step;
        continue;
      }
      const magic = buf.toString('latin1', 0, 6);
      if (magic !== '070701' && magic !== '070702') break;
      const field = (i) => parseInt(buf.toString('latin1', 6 + i * 8, 14 + i * 8), 16);
      const mode = field(1);
      const fileSize = field(6);
      const nameSize = field(11);
      if (!(nameSize >= 1 && nameSize <= 4096)) break;
      let name;
      if (HEADER + nameSize <= n) name = buf.toString('utf8', HEADER, HEADER + nameSize - 1);
      else {
        const nb = Buffer.alloc(nameSize);
        fs.readSync(fd, nb, 0, nameSize, pos + HEADER);
        name = nb.toString('utf8', 0, nameSize - 1);
      }
      if (name === 'TRAILER!!!') break; // the image rootfs ends here
      facts.entries++;
      const dataPos = pos + align4(HEADER + nameSize);
      const key = WANT[name.replace(/^\.\//, '')];
      // regular files only (0o100000); a symlinked passwd is not followed
      if (key && (mode & 0o170000) === 0o100000 && fileSize > 0 && fileSize <= MAX_TEXT) {
        const d = Buffer.alloc(fileSize);
        fs.readSync(fd, d, 0, fileSize, dataPos);
        facts[key] = d.toString('utf8');
      }
      if (!facts.s6 && S6_RE.test(name)) facts.s6 = true;
      pos = dataPos + align4(fileSize);
    }
  } finally { fs.closeSync(fd); }
  return facts;
}

function imageFacts(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { passwd: null, group: null, s6: false, entries: 0 }; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.facts;
  let facts;
  try { facts = scan(file); } catch (e) { facts = { passwd: null, group: null, s6: false, entries: 0, error: String(e.message || e) }; }
  if (cache.size > 64) cache.clear();
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, facts });
  return facts;
}

function diskFacts(meta) {
  const f = (meta && meta.facts) || {};
  const text = (v) => (typeof v === 'string' && v.length <= MAX_TEXT ? v : null);
  return { passwd: text(f.passwd), group: text(f.group), s6: !!f.s6 };
}

function lines(text) { return String(text || '').split(/\r?\n/).filter(Boolean).map((l) => l.split(':')); }

// user: Docker's USER; facts: {passwd, group}. Mirrors init.sh ("user"
// section): a name or uid found in passwd gives its uid:gid; an unknown
// numeric uid gets gid 0; ":group" overrides the gid.
function resolveUser(user, facts) {
  facts = facts || {};
  const s = String(user || '').trim();
  if (!s) return { uid: 0, gid: 0, found: true };
  const i = s.indexOf(':');
  const u = i >= 0 ? s.slice(0, i) : s;
  const g = i >= 0 ? s.slice(i + 1) : '';
  let uid = null, gid = null;
  for (const f of lines(facts.passwd)) {
    if (f[0] === u || f[2] === u) { uid = parseInt(f[2], 10); gid = parseInt(f[3], 10); break; }
  }
  if (uid === null) {
    if (!/^\d{1,10}$/.test(u)) return { uid: 0, gid: 0, found: false };
    uid = parseInt(u, 10);
    gid = 0;
  }
  if (g) {
    if (/^\d{1,10}$/.test(g)) gid = parseInt(g, 10);
    else {
      const row = lines(facts.group).find((f) => f[0] === g);
      if (!row) return { uid, gid: gid || 0, found: false };
      gid = parseInt(row[2], 10);
    }
  }
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return { uid: 0, gid: 0, found: false };
  return { uid, gid, found: true };
}

module.exports = { imageFacts, diskFacts, resolveUser, scan };
