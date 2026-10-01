'use strict';
/*
 * Disk-root microVMs: the image stays on a READ-ONLY ext4 "image disk"
 * shared by every container of that image, and each container writes into
 * its own copy-on-write qcow2 overlay of it (Docker's writable layer).
 * Guest RAM no longer has to hold the image: nginx runs at 128 MB with
 * 170 MB of QEMU private memory instead of 256 MB / 292 MB as a RAM root,
 * a 606 MB image at 96-128 MB instead of 1,456 MB, and the first HTTP 200
 * comes sooner (1.31 s vs 1.82 s) - measured in the disk-root spike.
 *
 * WHY the image disk is built on the host (mkext4.buildImageExt4) and not by
 * a one-off builder VM unpacking the image: as fast as the RAM root's
 * initrd build, 2.4-48x faster than a guest-side unpack under WHPX and ~40x
 * under TCG, and it needs no acceleration at all (nested without VT-x).
 *
 * DATA LAYOUT (paths relative to the data root; the folder stays movable):
 *   images/disks/<cfgHex12>-<key16>.qcow2       the image disk (sparse qcow2 v3)
 *   images/disks/<cfgHex12>-<key16>.qcow2.json  its sidecar, written LAST:
 *       {version, configDigest, key, builtAt, virtualBytes, fileBytes,
 *        unpackedBytes, entries, inodes, files, runtime, warnings,
 *        facts: {passwd, group, s6}, timings}
 *   images/disks/*.part                          a build in progress
 *   images/initrd/disk-<key16>.initrd            the small boot archive: busybox,
 *       init.sh and only the modules the run needs (a few variants). Carrying
 *       all 23 modules (6.4 MB instead of 4.4) made 96 MB boots fail 2 in 16.
 *   microvms/<id>/root.qcow2                     the container's writable layer;
 *       its backing file is the RELATIVE name "../../images/disks/<name>",
 *       backing format qcow2 recorded in the header (an ABSOLUTE name only
 *       when a symlinked microvms/ or images/ would make the relative one
 *       miss on Linux/macOS: backingName)
 * The disk KEY covers what changes the disk's bytes - DISK_FORMAT, the
 * writer's IMAGE_EXT4_FORMAT, the layer semantics (cpio FORMAT_VERSION), the
 * config digest and the minimum virtual size - never the kernel, init or
 * modules: a kernel or init update does not rebuild image disks.
 *
 * GC RULES. An image disk may be deleted only when (1) no overlay names it
 * (the overlay header is authoritative: it is what QEMU opens; an overlay
 * whose header cannot be read counts as naming every disk of its record's
 * image, or every disk when it has no record), (2) no container record
 * names it (rootDisk.disk), (3) no live or starting container uses it, (4)
 * it is not the current disk (index.json) of an image that stays, (5) it is
 * old enough (a run may have just built it) and (6) Windows lets it go (a
 * file a QEMU holds open is skipped, not an error). Deletion happens under
 * the image's lock (images.withImageLock; a disk without its sidecar: the
 * locks of every image whose digest starts with its 12-hex prefix), and the
 * references are read THERE, not before: a starting container claims its
 * disk (containers.js L.disk) inside the same lock, before its overlay
 * exists, so a removal or prune that waited for the lock sees it (cr-1).
 * images.js removes an image's disk
 * itself (dropImage) with the same reference check: a forced "rmi" keeps a
 * disk a stopped container still boots ("dangling" until that container
 * goes, then pruneImageDisks removes it).
 *
 * LOCKS: one build per image (the caller holds images.withImageLock); across
 * processes a unique .part + rename + "exists = success" (the writer is
 * deterministic, so both copies are identical). Many containers share an
 * image disk with no lock: QEMU only ever opens it read-only, as a backing
 * file. An overlay is created/deleted only inside its container's task.
 *
 *   DISK_FORMAT, DISK_MIN_MEM_MB (96)
 *   imageDiskKey({configDigest, minGB}) / imageDiskPaths(configDigest, key)
 *   readDiskMeta(configDigest, key?) / readDiskMetaFor(file, configDigest?)
 *   ensureImageDisk(img, {t, signal, limits, name}) -> {file, meta, cached, ms}
 *   createRootOverlay(runDir, diskFile, virtualBytes) -> {file, backing, absolute}
 *                              (ROOT_DISK_MISSING when the disk is not there)
 *   backingName(runDir, diskFile) -> {name, absolute}
 *   overlayFile(runDir) / overlayBacking(runDir) -> absolute path | null
 *   diskInitrdModules(spec, manifest) / diskInitrdKey({manifest, modules})
 *   ensureDiskInitrd({kernelDir, manifest, spec}) -> {file, key, cached, bytes, modules}
 *                              (a cache hit refreshes the file's mtime)
 *   diskReferences({records, inUse}) / referenceOf(refs, file)
 *   pruneImageDisks({inUse, records, minAgeMs, keep, now}) -> {removed, kept, freedBytes}
 *   pruneDiskInitrds({inUse, minAgeMs, now}) -> {removed, kept}
 *                              (inUse/records: arrays, or functions read at
 *                              each deletion)
 *   minDiskGB() / maxImageGB()
 *
 * Nothing runs at require time.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('../config');
const plan = require('./plan');

const DISK_FORMAT = 1;
const DISK_MIN_MEM_MB = plan.DISK_MIN_MEM_MB;
const DISK_MIN_AGE_MS = 10 * 60 * 1000;
const PART_MAX_AGE_MS = 60 * 60 * 1000;
const MiB = 1048576;
const GiB = 1024 * MiB;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const quiet = { log() {}, step() {}, warn() {} };
const abortError = () => Object.assign(new Error('stopped before the app started'), { code: 'ABORTED' });

function disksDir() { return path.join(CFG.imagesDir, 'disks'); }
function initrdDir() { return path.join(CFG.imagesDir, 'initrd'); }

function configHex(configDigest) {
  const hex = String(configDigest || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('bad image config digest ' + configDigest);
  return hex;
}

// the settings (config.json via lib/config.js) with their normal defaults
// when unset: tests and older configs never define them
function minDiskGB() {
  const v = Number(CFG.microvmImageDiskGB);
  return Number.isInteger(v) && v >= 1 && v <= 4096 ? v : 8;
}
function maxImageGB() {
  const v = Number(CFG.microvmImageMaxGB);
  return v > 0 && v <= 4096 ? v : 16;
}

// comparable form of a path (Windows: case-insensitive, either slash)
function normKey(p) {
  const n = path.resolve(String(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// ------------------------------------------------------------ image disks
function imageDiskKey(o) {
  const cpio = require('../oci/cpio');
  const mkext4 = require('./mkext4');
  return sha256(JSON.stringify({
    f: DISK_FORMAT, ext4: mkext4.IMAGE_EXT4_FORMAT, rootfs: cpio.FORMAT_VERSION,
    config: 'sha256:' + configHex(o.configDigest), minGB: o.minGB === undefined ? minDiskGB() : o.minGB,
  })).slice(0, 16);
}

function imageDiskPaths(configDigest, key) {
  const file = path.join(disksDir(), configHex(configDigest).slice(0, 12) + '-' + key + '.qcow2');
  return { file, meta: file + '.json' };
}

// The sidecar of a disk file, when both exist and the sidecar is complete.
function readMetaFile(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    if (!m || m.version !== DISK_FORMAT || !fs.statSync(file).isFile()) return null;
    return Object.assign({}, m, { file });
  } catch (e) { return null; }
}

// The current disk of an image (key from the current settings unless given)
function readDiskMeta(configDigest, key) {
  const k = key || imageDiskKey({ configDigest });
  const m = readMetaFile(imageDiskPaths(configDigest, k).file);
  return m && m.configDigest === configDigest && m.key === k ? m : null;
}

// Any disk file (e.g. the one a container's overlay names), checked to be an
// image disk of configDigest when that is given.
function readDiskMetaFor(file, configDigest) {
  const m = readMetaFile(file);
  if (!m) return null;
  if (configDigest && m.configDigest !== configDigest) return null;
  return m;
}

function writeSidecar(file, meta) {
  const tmp = file + '.json.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
  try { fs.renameSync(tmp, file + '.json'); }
  catch (e) {
    fs.rmSync(tmp, { force: true });
    // another builder's identical sidecar is being read right now (Windows)
    if (!fs.existsSync(file + '.json')) throw e;
  }
}

// Build (or find) the image disk of a pulled image. The caller holds
// images.withImageLock(img.configDigest). img: a registry.pullImage result
// (layers with their cached blob paths). o: {t, signal, limits, name}
// -> {file, meta, cached, ms}
async function ensureImageDisk(img, o) {
  o = o || {};
  const t = o.t || quiet;
  const t0 = Date.now();
  const minGB = minDiskGB();
  const key = imageDiskKey({ configDigest: img.configDigest, minGB });
  const p = imageDiskPaths(img.configDigest, key);
  plan.checkQemuPath(p.file);
  const have = readDiskMeta(img.configDigest, key);
  if (have) return { file: p.file, meta: have, cached: true, ms: Date.now() - t0 };
  if (o.signal && o.signal.aborted) throw abortError();
  const images = require('../oci/images');
  const layers = require('../oci/layers');
  const cpio = require('../oci/cpio');
  const mkext4 = require('./mkext4');
  const registry = require('../oci/registry');
  const name = o.name || img.reference || img.configDigest.slice(0, 19);
  t.step('Reading the layers of ' + name + '...');
  const limits = Object.assign({ maxBytes: Math.floor(maxImageGB() * GiB) }, o.limits || {});
  let tree;
  try {
    tree = await layers.buildTree(img.layers.map((l) => ({ path: l.path, diffId: l.diffId })), { limits });
  } catch (e) {
    if (e && e.code === 'LIMIT' && /unpacks to more than/.test(e.message)) {
      throw Object.assign(new Error(name + ' unpacks to more than ' + maxImageGB() + ' GB, above the limit for one image (config.json microvmImageMaxGB)'), { code: 'IMAGE_TOO_LARGE', status: 409 });
    }
    throw e;
  }
  const tIndex = Date.now();
  if (o.signal && o.signal.aborted) throw abortError();
  const unpacked = tree.stats.uncompressedBytes;
  // the exact size is known now, before a byte is written
  images.requireSpace(unpacked + 4096 * tree.stats.entries + 64 * MiB, 'building the disk of ' + name);
  cpio.addRuntimeBasics(tree, {});
  // the mount point of the engine's own tmpfs (init, busybox, the spec)
  if (!tree.lookup('.devbox')) tree.addExtra({ path: '.devbox', type: 'dir', mode: 0o755, mtime: 0 });
  t.step('Building the disk of ' + name + ' (' + img.layers.length + ' layer' + (img.layers.length === 1 ? '' : 's') + ', ' + Math.max(1, Math.round(unpacked / MiB)) + ' MB)');
  const created = Math.max(0, Math.floor((Date.parse((img.config && img.config.created) || '') || 0) / 1000));
  const st = await mkext4.buildImageExt4(tree, p.file, { key, now: created, minGB, signal: o.signal, label: 'devbox-image' });
  const meta = {
    version: DISK_FORMAT, configDigest: img.configDigest, key, builtAt: new Date().toISOString(),
    virtualBytes: st.sizeBytes, fileBytes: fs.statSync(p.file).size, unpackedBytes: unpacked, entries: tree.stats.entries,
    inodes: st.inodes, files: st.files, runtime: registry.runtimeConfig(img.config), warnings: tree.warnings.slice(),
    facts: st.facts, timings: { indexMs: tIndex - t0, writeMs: st.ms, ms: Date.now() - t0 },
  };
  writeSidecar(p.file, meta);
  return { file: p.file, meta: Object.assign({}, meta, { file: p.file }), cached: false, ms: Date.now() - t0 };
}

// ------------------------------------------------------------ overlays
function overlayFile(runDir) { return path.join(runDir, 'root.qcow2'); }

// The name a container's overlay stores for its image disk: RELATIVE to the
// run folder (forward slashes), so the data folder stays movable - when that
// name finds the disk the way QEMU will look for it. QEMU joins the overlay's
// folder and the name as text and hands "<runDir>/../../images/disks/x" to
// the OS: Windows collapses ".." textually, but a POSIX kernel resolves it
// on the PHYSICAL path, so with microvms/ or images/ (or a folder below the
// data root) being a symlink, ".." climbs out of the link's target and the
// disk is not found (cr-9). The name is therefore checked against the real
// paths, and an ABSOLUTE name is used when the relative one would miss.
// platform: tests. -> {name, absolute}
function backingName(runDir, diskFile, platform) {
  const rel = path.relative(path.resolve(runDir), path.resolve(diskFile)).split(path.sep).join('/');
  if ((platform || process.platform) === 'win32') return { name: rel, absolute: false };
  let physical = null, target = null;
  try {
    physical = path.resolve(fs.realpathSync(runDir), rel);
    target = fs.realpathSync(diskFile);
  } catch (e) { return { name: rel, absolute: false }; }
  if (physical === target) return { name: rel, absolute: false };
  // the lexical absolute path: the OS follows the links on the way, and the
  // GC (overlayBacking, diskReferences) compares it with the disk files as
  // they are listed
  return { name: path.resolve(diskFile), absolute: true };
}

// The writable layer of a container: an empty qcow2 whose backing file is
// the image disk (backingName). Refuses to overwrite one, and refuses an
// image disk that is not there: QEMU would only fail later, at the spawn, and
// every later start would name the missing file too (cr-1).
// o: {platform (tests)} -> {file, backing, absolute}
function createRootOverlay(runDir, diskFile, virtualBytes, o) {
  const qcow2 = require('./qcow2');
  const file = overlayFile(runDir);
  let st = null;
  try { st = fs.statSync(diskFile); } catch (e) { st = null; }
  if (!st || !st.isFile()) {
    throw Object.assign(new Error('the image disk ' + path.basename(String(diskFile)) + ' was deleted before this container could use it (an image removal or prune) - start it again'), { code: 'ROOT_DISK_MISSING', status: 409 });
  }
  plan.checkQemuPath(file);
  fs.mkdirSync(runDir, { recursive: true });
  const b = backingName(runDir, diskFile, o && o.platform);
  if (!b.absolute) plan.checkQemuPathRaw(path.resolve(runDir) + '/' + b.name);
  else plan.checkQemuPath(b.name);
  qcow2.createOverlay(file, b.name, virtualBytes, { backingFormat: 'qcow2' });
  return { file, backing: b.name, absolute: b.absolute };
}

// The absolute image disk a container's overlay names, or null (no overlay,
// no backing file, unreadable header).
function overlayBacking(runDir) {
  const b = require('./qcow2').readBacking(overlayFile(runDir));
  return b && b.name ? path.resolve(runDir, b.name) : null;
}

// ------------------------------------------------------------ boot archive
// The modules a disk-root run loads, in load order: fw_cfg (init reads the
// spec through it), then what the spec needs (blk + ext4 for the root disk,
// net, rng, ...). Only these go into the initrd (see the header).
function diskInitrdModules(spec, manifest) {
  const feats = (manifest && manifest.features) || {};
  if (!(feats.ext4 || []).length || !(feats.blk || []).length) {
    throw Object.assign(new Error('the microVM kernel has no ext4/virtio-blk modules for a disk root - update it in Setup (no download: it is rebuilt from the cached packages)'), { code: 'KERNEL_UPDATE', status: 409, action: 'install-kernel' });
  }
  const initramfs = require('./initramfs');
  const out = [];
  const add = (n) => { if (!out.includes(n)) out.push(n); };
  for (const n of feats.fwcfg || []) add(n);
  for (const n of initramfs.specModules(Object.assign({}, spec, { rootfs: 'disk' }), manifest)) add(n);
  return out;
}

function diskInitrdKey(o) {
  const initramfs = require('./initramfs');
  const busySha = (o.manifest.sha256 && o.manifest.sha256['busybox.static']) || '';
  return sha256(JSON.stringify({
    f: plan.INITRD_FORMAT, kind: 'disk', kver: o.manifest.kver, busybox: busySha,
    init: sha256(initramfs.initScript()), modules: o.modules,
  })).slice(0, 16);
}

// o: {kernelDir, manifest, spec} -> {file, key, cached, bytes, modules}.
// Built in ~20 ms; "exists = success" across writers.
async function ensureDiskInitrd(o) {
  const modules = diskInitrdModules(o.spec, o.manifest);
  const key = diskInitrdKey({ manifest: o.manifest, modules });
  const file = path.join(initrdDir(), 'disk-' + key + '.initrd');
  plan.checkQemuPath(file);
  const size = () => { try { return fs.statSync(file).size; } catch (e) { return null; } };
  const s0 = size();
  if (s0 !== null) {
    // shared by every container with this module set, so usually older than
    // the prune's 10 minutes: a use makes it young again, and the age rule
    // covers the moment between this cache hit and the start claiming it
    // (cr-8). Best effort: a file a QEMU holds open may refuse.
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch (e) { /* the in-use check still applies */ }
    return { file, key, cached: true, bytes: s0, modules };
  }
  fs.mkdirSync(initrdDir(), { recursive: true });
  const buf = await require('./initramfs').buildInitArchive({ kernelDir: o.kernelDir, manifest: o.manifest, modules });
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
  try {
    fs.writeFileSync(part, buf);
    if (size() === null) {
      try { fs.renameSync(part, file); } catch (e) { if (size() === null) throw e; }
    }
  } finally { fs.rmSync(part, { force: true }); }
  return { file, key, cached: false, bytes: size(), modules };
}

// ------------------------------------------------------------ references
// Who uses which image disk (see "GC RULES"). o: {records (container
// records), inUse: [absolute disk paths of live containers] | () => [...]}
// -> {files: Map<normKey, why>, prefixes: Map<cfgHex12, why>, all: why|null}
function diskReferences(o) {
  o = o || {};
  const records = o.records || [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const out = { files: new Map(), prefixes: new Map(), all: null };
  const nameOf = (id) => { const r = byId.get(id); return r && r.name ? r.name : id; };
  let dirs = [];
  try { dirs = fs.readdirSync(CFG.microvmsDir); } catch (e) { dirs = []; }
  for (const d of dirs) {
    const runDir = path.join(CFG.microvmsDir, d);
    const ov = overlayFile(runDir);
    if (!fs.existsSync(ov)) continue;
    const why = 'the writable layer of container "' + nameOf(d) + '" uses it';
    const b = require('./qcow2').readBacking(ov);
    if (b && b.name) { out.files.set(normKey(path.resolve(runDir, b.name)), why); continue; }
    // an overlay whose header cannot be read: conservative
    const r = byId.get(d);
    const cd = r && r.rootDisk && r.rootDisk.configDigest;
    if (cd && /^sha256:[a-f0-9]{64}$/.test(cd)) out.prefixes.set(cd.slice(7, 19), why);
    else out.all = why;
  }
  for (const r of records) {
    const rel = r && r.rootDisk && r.rootDisk.disk;
    if (typeof rel === 'string' && rel) {
      const k = normKey(path.resolve(CFG.root, rel));
      if (!out.files.has(k)) out.files.set(k, 'container "' + (r.name || r.id) + '" was created from it');
    }
  }
  const live = typeof o.inUse === 'function' ? o.inUse() : (o.inUse || []);
  for (const f of live) if (f) out.files.set(normKey(f), 'in use by a running container');
  return out;
}

// why the disk file is referenced, or null
function referenceOf(refs, file) {
  if (!refs) return null;
  const k = normKey(file);
  if (refs.files.has(k)) return refs.files.get(k);
  const prefix = path.basename(String(file)).slice(0, 12);
  if (refs.prefixes.has(prefix)) return refs.prefixes.get(prefix);
  return refs.all;
}

// ------------------------------------------------------------ GC
// Delete image disks that are not the current (index.json) disk of an image,
// not referenced (diskReferences), old enough, and not open in a QEMU; their
// sidecars go with them; .part files of dead writers after an hour.
// o: {records, inUse (array | fn), minAgeMs (10 min; 0 = the dangling
//     cleanup after a container is removed), keep: [files], now}
// -> {removed: [file], kept: [{file, why}], freedBytes}
async function pruneImageDisks(o) {
  o = o || {};
  const images = require('../oci/images');
  const now = o.now || Date.now();
  const minAge = o.minAgeMs === undefined ? DISK_MIN_AGE_MS : o.minAgeMs;
  const out = { removed: [], kept: [], freedBytes: 0 };
  const dir = disksDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  const currentDisks = () => {
    const set = new Set((o.keep || []).map(normKey));
    const idx = images.readIndex();
    for (const cd of Object.keys(idx.images)) {
      const d = idx.images[cd] && idx.images[cd].disk;
      if (d && typeof d.file === 'string') set.add(normKey(path.join(dir, path.basename(d.file))));
    }
    return set;
  };
  const statOf = (f) => { try { return fs.statSync(f); } catch (e) { return null; } };
  for (const n of names) {
    const f = path.join(dir, n);
    const st = statOf(f);
    if (!st || !st.isFile()) continue;
    if (/\.part$/.test(n)) {
      if (now - st.mtimeMs > PART_MAX_AGE_MS) { try { fs.rmSync(f, { force: true }); out.removed.push(f); } catch (e) { /* busy */ } }
      continue;
    }
    if (/\.qcow2\.json$/.test(n)) {
      // a sidecar without its disk (the disk went first)
      if (!fs.existsSync(f.slice(0, -5)) && now - st.mtimeMs >= minAge) { try { fs.rmSync(f, { force: true }); } catch (e) { /* busy */ } }
      continue;
    }
    if (!/\.qcow2$/.test(n)) continue;
    if (currentDisks().has(normKey(f))) continue;
    const meta = readMetaFile(f);
    // the sidecar is written last: without one, a build may be finishing
    if (!meta && now - st.mtimeMs < Math.max(minAge, DISK_MIN_AGE_MS)) { out.kept.push({ file: f, why: 'being built' }); continue; }
    if (now - st.mtimeMs < minAge) { out.kept.push({ file: f, why: 'younger than ' + Math.round(minAge / 60000) + ' min' }); continue; }
    const attempt = () => {
      // checked again under the lock: a start may have taken it meanwhile
      if (currentDisks().has(normKey(f))) return;
      const why = referenceOf(diskReferences({ records: typeof o.records === 'function' ? o.records() : o.records, inUse: o.inUse }), f);
      if (why) { out.kept.push({ file: f, why }); return; }
      try {
        fs.rmSync(f);
        out.removed.push(f);
        out.freedBytes += st.size;
        try { fs.rmSync(f + '.json', { force: true }); } catch (e) { /* removed with the next prune */ }
      } catch (e) {
        out.kept.push({ file: f, why: e.code === 'EBUSY' || e.code === 'EPERM' ? 'open in a running QEMU' : 'could not delete (' + (e.code || e.message) + ')' });
      }
    };
    if (meta && meta.configDigest) await images.withImageLock(meta.configDigest, async () => attempt());
    else await withLocks(imagesWithPrefix(n.slice(0, 12)), attempt);
  }
  return out;
}

// The config digests (index.json and refs.json) whose hex starts with the
// 12-hex prefix of a disk's file name: a disk whose sidecar is gone is
// deleted under the locks of every image it may belong to (SPEC 8, cov-6).
function imagesWithPrefix(prefix) {
  const images = require('../oci/images');
  const out = new Set();
  if (!/^[a-f0-9]{12}$/.test(prefix)) return [];
  try { for (const cd of Object.keys(images.readIndex().images)) if (cd.slice(7, 19) === prefix) out.add(cd); } catch (e) { /* no index */ }
  try {
    const refs = require('../oci/registry').readRefs(CFG.imagesDir);
    for (const c of Object.keys(refs)) { const cd = refs[c] && refs[c].configDigest; if (typeof cd === 'string' && cd.slice(7, 19) === prefix) out.add(cd); }
  } catch (e) { /* no refs */ }
  return Array.from(out).sort();
}
// fn() under the image locks of every digest, taken in a fixed order (two
// callers never wait for each other crosswise)
async function withLocks(digests, fn) {
  if (!digests.length) return fn();
  const images = require('../oci/images');
  return images.withImageLock(digests[0], () => withLocks(digests.slice(1), fn));
}

// Disk-root boot archives no live container uses, older than minAgeMs
// (they are rebuilt in ~20 ms). o: {inUse: [files] | () => [files] (read
// for every file, at its deletion: a start that found the archive cached a
// moment ago claims it - cr-8), minAgeMs, now}
function pruneDiskInitrds(o) {
  o = o || {};
  const now = o.now || Date.now();
  const minAge = o.minAgeMs === undefined ? DISK_MIN_AGE_MS : o.minAgeMs;
  const inUseNow = () => new Set(Array.from((typeof o.inUse === 'function' ? o.inUse() : o.inUse) || []).filter(Boolean).map(normKey));
  const out = { removed: [], kept: [] };
  let names;
  try { names = fs.readdirSync(initrdDir()); } catch (e) { return out; }
  for (const n of names) {
    if (!/^disk-[a-f0-9]{16}\.initrd$/.test(n)) continue;
    const f = path.join(initrdDir(), n);
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; }
    if (inUseNow().has(normKey(f))) { out.kept.push({ file: f, why: 'in use by a running container' }); continue; }
    if (now - st.mtimeMs < minAge) { out.kept.push({ file: f, why: 'younger than ' + Math.round(minAge / 60000) + ' min' }); continue; }
    try { fs.rmSync(f); out.removed.push(f); }
    catch (e) { out.kept.push({ file: f, why: 'could not delete (' + (e.code || e.message) + ')' }); }
  }
  return out;
}

// Bytes of the image disks (cache usage).
function disksBytes() {
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(disksDir()); } catch (e) { return 0; }
  for (const n of names) { try { total += fs.statSync(path.join(disksDir(), n)).size; } catch (e) { /* gone */ } }
  return total;
}

module.exports = {
  DISK_FORMAT, DISK_MIN_MEM_MB, DISK_MIN_AGE_MS,
  imageDiskKey, imageDiskPaths, readDiskMeta, readDiskMetaFor, ensureImageDisk,
  createRootOverlay, backingName, overlayFile, overlayBacking, imagesWithPrefix,
  diskInitrdModules, diskInitrdKey, ensureDiskInitrd,
  diskReferences, referenceOf, pruneImageDisks, pruneDiskInitrds, disksBytes,
  minDiskGB, maxImageGB, disksDir, normKey,
};
