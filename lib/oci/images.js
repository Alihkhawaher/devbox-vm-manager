'use strict';
/*
 * The local image cache as the microVM engine sees it (<root>/images, see
 * lib/oci/registry.js for the blob layout).
 *
 * This module is the ONLY place that decides when a cached file may go, and
 * the place that serialises work on one image inside the manager:
 *
 *   withImageLock(configDigest, fn)
 *       In-process keyed mutex: concurrent runs of the SAME image build its
 *       root filesystem and initrd once, one after another (bug V4); runs
 *       of different images never wait for each other. Unique .part names
 *       (registry.js, cpio.js, plan.js) cover a second process on the same
 *       data root.
 *   KeyedMutex
 *       The mutex class itself (volumes.js reuses it for volume:<name>).
 *   pruneInitrds({dir, keep, inUse, minAgeMs, now})
 *       Age- and use-aware GC of the RAM-root initrds in images/initrd
 *       (spec section 4; the disk-root boot archives disk-*.initrd are
 *       rootdisk.pruneDiskInitrds' business, run by pruneImages): an initrd
 *       is deleted only when it is not in `keep` (still referenced), not in
 *       `inUse` (the runtime.initrd of a live container), and older than
 *       minAgeMs (default 10 minutes - a run that just built it may be about
 *       to boot it). Windows refuses to delete a file a QEMU holds open;
 *       that is skipped, not an error. Leftover .part files of dead writers
 *       older than an hour go too. The prototype instead deleted every other
 *       initrd of the image right after a build, including one another run
 *       was about to boot (bug V4b).
 *   requireSpace(bytes, what)
 *       Refuse a pull or flatten that would fill the disk (bug D).
 *   readIndex() / updateIndex(configDigest, patch)
 *       images/index.json: configDigest -> {references, lastUsed, rootfsBytes,
 *       initrd:{file, key, bytes}, disk:{file, key, bytes, virtualBytes,
 *       builtAt}}. Atomic writes; the manager is the only writer.
 *   listImages()                GET /api/images: one row per image (config
 *       digest) with its references, sizes (download, unpacked, initrd),
 *       last use, the containers using it and what engine it needs (the
 *       compat rules), plus the last Docker Hub rate-limit headers and the
 *       whole cache size. index.json is completed from refs.json on the way
 *       (the caches of earlier versions have no index).
 *   imageInfo(ref)              one row of listImages
 *   removeImage(sel, ctx)       Docker "rmi" rules: 409 IMAGE_IN_USE while a
 *       container record uses it (unless force); a reference of an image
 *       that has other references only untags it; otherwise the refs,
 *       index entry, rootfs sidecar, initrds (not the ones a live container
 *       booted), image disks (not one a container's writable layer, record
 *       or live run uses - lib/microvm/rootdisk.js "GC RULES": such a disk
 *       stays, unindexed, until its last container goes) and every blob no
 *       other image needs are deleted.
 *   pruneImages(ctx)            "Prune unused images": every image no
 *       container record uses (ctx.olderThanDays: only images unused for
 *       that long - the light profile's auto-prune), then GC of initrds,
 *       image disks no index entry and no container names, disk-root boot
 *       archives, transient rootfs archives, orphan blobs (all older than
 *       10 minutes: a pull or build in flight is never raced) and dead
 *       writers' .part files.
 *     Both read who uses what (ctx.records, inUse, disksInUse, liveRefs -
 *     functions from the engine) UNDER each image's lock, at the moment of
 *     the decision: a container that is starting holds that lock while it
 *     builds or finds its image disk and claims the disk inside it, so a
 *     list taken earlier would miss it (cr-1).
 *   usage()                     bytes per cache folder
 *   noteRateLimit(rl)           remember the last rate-limit headers
 *
 * Nothing runs at require time.
 */
const fs = require('fs');
const path = require('path');
const { CFG } = require('../config');
const platform = require('../platform');
const { ApiError, atomicWriteFileSync, fmtBytes } = require('../util');

// ---------------------------------------------------------------------------
// keyed mutex
// ---------------------------------------------------------------------------
class KeyedMutex {
  constructor() { this.tails = new Map(); }

  // Run fn() once every earlier holder of `key` has finished. Resolves or
  // rejects with fn's own result; a failed holder never blocks the next one.
  run(key, fn) {
    const k = String(key);
    const prev = this.tails.get(k) || Promise.resolve();
    const p = prev.then(() => fn());
    const tail = p.then(() => {}, () => {});
    this.tails.set(k, tail);
    tail.then(() => { if (this.tails.get(k) === tail) this.tails.delete(k); });
    return p;
  }

  // Is anybody holding or waiting for `key`?
  busy(key) { return this.tails.has(String(key)); }
}

const imageMutex = new KeyedMutex();
function withImageLock(configDigest, fn) { return imageMutex.run('image:' + configDigest, fn); }

// ---------------------------------------------------------------------------
// garbage collection
// ---------------------------------------------------------------------------
const INITRD_MIN_AGE_MS = 10 * 60 * 1000;
const PART_MAX_AGE_MS = 60 * 60 * 1000;

// Blobs an image preparation in THIS process is using right now (correct-6):
// a pull that found them cached - or just downloaded them - flattens them a
// moment later, under ITS image's lock, not the lock of an image being
// removed that happens to share a layer. Refs and the index only name them
// once the pull is recorded, so the keep-set of a removal cannot see them.
// digest -> count
const heldBlobs = new Map();
// Hold digests until the returned release() is called (idempotent).
function holdBlobs(digests) {
  const list = Array.from(new Set((digests || []).filter((d) => typeof d === 'string')));
  for (const d of list) heldBlobs.set(d, (heldBlobs.get(d) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const d of list) {
      const n = (heldBlobs.get(d) || 1) - 1;
      if (n > 0) heldBlobs.set(d, n); else heldBlobs.delete(d);
    }
  };
}
const isHeld = (digest) => heldBlobs.has(digest);

function samePath(a, b) {
  const n = (p) => path.resolve(String(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

// opts: {dir (default CFG.imagesDir/initrd), keep: [file] (still referenced),
//        inUse: [file] | Set (live containers' runtime.initrd), minAgeMs,
//        now (tests)}
// Returns {removed: [file], kept: [{file, why}]}.
function pruneInitrds(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(CFG.imagesDir, 'initrd');
  const now = opts.now || Date.now();
  const minAge = opts.minAgeMs === undefined ? INITRD_MIN_AGE_MS : opts.minAgeMs;
  const keep = Array.from(opts.keep || []);
  const inUse = Array.from(opts.inUse || []);
  const out = { removed: [], kept: [] };
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of names) {
    const file = path.join(dir, f);
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (/\.part$/.test(f)) {
      if (now - st.mtimeMs > PART_MAX_AGE_MS) { try { fs.rmSync(file, { force: true }); out.removed.push(file); } catch (e) { /* busy */ } }
      continue;
    }
    if (!/\.initrd$/.test(f)) continue;
    // disk-root boot archives: rootdisk.pruneDiskInitrds (run by pruneImages)
    if (/^disk-/.test(f)) continue;
    if (keep.some((k) => samePath(k, file))) { out.kept.push({ file, why: 'referenced' }); continue; }
    if (inUse.some((k) => samePath(k, file))) { out.kept.push({ file, why: 'in use by a running container' }); continue; }
    if (now - st.mtimeMs < minAge) { out.kept.push({ file, why: 'younger than ' + Math.round(minAge / 60000) + ' min' }); continue; }
    try { fs.rmSync(file); out.removed.push(file); }
    catch (e) { out.kept.push({ file, why: 'could not delete (' + (e.code || e.message) + ')' }); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// disk space
// ---------------------------------------------------------------------------
// Throws an Error (code NO_SPACE) when the volume holding the image cache has
// less than `bytes` free. Returns {free, warn} - warn when under twice that.
function requireSpace(bytes, what) {
  const d = platform.diskFree(CFG.imagesDir);
  if (d.free === null) return { free: null, warn: false };
  if (d.free < bytes) {
    const e = new Error('not enough free disk space for ' + (what || 'the image') + ': ' + fmtBytes(d.free) + ' free on ' + d.path + ', about ' + fmtBytes(bytes) + ' needed');
    e.code = 'NO_SPACE';
    throw e;
  }
  return { free: d.free, warn: d.free < bytes * 2 };
}

// ---------------------------------------------------------------------------
// index.json
// ---------------------------------------------------------------------------
function indexFile() { return path.join(CFG.imagesDir, 'index.json'); }

function readIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    if (j && typeof j === 'object' && j.images && typeof j.images === 'object') return j;
  } catch (e) { /* missing or damaged: rebuilt from the cache by the engine */ }
  return { version: 1, images: {} };
}

// Merge `patch` into the entry of configDigest and save atomically.
// Returns the new entry.
function updateIndex(configDigest, patch) {
  const idx = readIndex();
  const cur = idx.images[configDigest] || { references: [], lastUsed: null, rootfsBytes: null, initrd: null };
  const next = Object.assign({}, cur, patch || {});
  if (patch && Array.isArray(patch.references)) {
    next.references = Array.from(new Set((cur.references || []).concat(patch.references)));
  }
  idx.images[configDigest] = next;
  fs.mkdirSync(CFG.imagesDir, { recursive: true });
  atomicWriteFileSync(indexFile(), JSON.stringify(idx, null, 2) + '\n');
  return next;
}

// ---------------------------------------------------------------------------
// API-level functions
// ---------------------------------------------------------------------------
let lastRateLimit = null;
function noteRateLimit(rl) {
  if (rl && (rl.limit !== null && rl.limit !== undefined || rl.remaining !== null && rl.remaining !== undefined)) {
    lastRateLimit = { limit: rl.limit, remaining: rl.remaining, window: rl.windowSeconds || rl.window || null, source: rl.source || null, at: rl.at || new Date().toISOString() };
  }
}

const reg = () => require('./registry');
const CFG_RE = /^sha256:[a-f0-9]{64}$/;
const jsonCache = new Map(); // digest -> parsed JSON (blobs never change)

function readJsonBlob(digest) {
  if (!digest || !CFG_RE.test(digest)) return null;
  if (jsonCache.has(digest)) return jsonCache.get(digest);
  let j = null;
  try {
    const file = reg().blobPath(CFG.imagesDir, digest);
    if (fs.statSync(file).size <= 16 * 1048576) j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { j = null; }
  if (j) {
    if (jsonCache.size > 500) jsonCache.clear();
    jsonCache.set(digest, j);
  }
  return j;
}

function fileSize(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }
function dirBytes(dir) {
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const n of names) total += fileSize(path.join(dir, n));
  return total;
}

function usage() {
  const blobs = dirBytes(path.join(CFG.imagesDir, 'blobs', 'sha256'));
  const rootfs = dirBytes(path.join(CFG.imagesDir, 'rootfs'));
  const initrd = dirBytes(path.join(CFG.imagesDir, 'initrd'));
  const disks = dirBytes(path.join(CFG.imagesDir, 'disks'));
  return { blobs, rootfs, initrd, disks, total: blobs + rootfs + initrd + disks };
}

// Every image the cache knows: configDigest -> {configDigest, references,
// manifestDigest, tops (index/manifest digests the refs resolved to)}.
function knownImages() {
  const refs = reg().readRefs(CFG.imagesDir);
  const idx = readIndex();
  const out = new Map();
  const get = (cd) => {
    if (!out.has(cd)) out.set(cd, { configDigest: cd, references: new Set(), manifestDigest: null, tops: new Set(), pulledAt: null, index: null });
    return out.get(cd);
  };
  for (const canon of Object.keys(refs)) {
    const r = refs[canon];
    if (!r || !CFG_RE.test(r.configDigest || '')) continue;
    const e = get(r.configDigest);
    e.references.add(canon);
    e.manifestDigest = e.manifestDigest || r.platformDigest || r.manifestDigest;
    if (r.manifestDigest) e.tops.add(r.manifestDigest);
    if (r.platformDigest) e.tops.add(r.platformDigest);
    if (!e.pulledAt || String(r.pulledAt) > e.pulledAt) e.pulledAt = r.pulledAt || null;
  }
  for (const cd of Object.keys(idx.images)) {
    if (!CFG_RE.test(cd)) continue;
    const x = idx.images[cd];
    const e = get(cd);
    e.index = x;
    for (const r of x.references || []) e.references.add(r);
    if (!e.manifestDigest && x.manifestDigest) e.manifestDigest = x.manifestDigest;
    if (x.manifestDigest) e.tops.add(x.manifestDigest);
  }
  return { images: out, refs, idx };
}

// Digests an image needs: its config, manifests and layers.
function blobsOf(e) {
  const set = new Set([e.configDigest]);
  for (const d of e.tops) {
    set.add(d);
    const m = readJsonBlob(d);
    if (m && Array.isArray(m.manifests)) {
      // an index: only the platform manifest this cache resolved matters
      continue;
    }
    if (m && Array.isArray(m.layers)) for (const l of m.layers) if (l && l.digest) set.add(l.digest);
  }
  return set;
}

function initrdFilesOf(cd) {
  const dir = path.join(CFG.imagesDir, 'initrd');
  const prefix = cd.replace(/^sha256:/, '').slice(0, 12) + '-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter((n) => n.startsWith(prefix) && n.endsWith('.initrd')).map((n) => path.join(dir, n));
}

function diskFilesOf(cd) {
  const dir = path.join(CFG.imagesDir, 'disks');
  const prefix = cd.replace(/^sha256:/, '').slice(0, 12) + '-';
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.filter((n) => n.startsWith(prefix) && n.endsWith('.qcow2')).map((n) => path.join(dir, n));
}

// ctx.records, ctx.inUse, ctx.disksInUse and ctx.liveRefs may be arrays or
// functions. The engine passes FUNCTIONS, called under the image's lock at
// the moment of the decision (cr-1): a container that starts while a removal
// or a prune waits for that lock is only known once it holds the lock itself
// (its image disk or initrd is claimed inside it), so a list taken when the
// removal was asked for misses it.
function listOf(v) {
  const x = typeof v === 'function' ? v() : v;
  return Array.from(x || []);
}
function recordsOf(ctx) {
  if (ctx && ctx.records) return listOf(ctx.records);
  try { return require('../microvm/store').list(); } catch (e) { return []; }
}

function describeImage(e, records) {
  const cpio = require('./cpio');
  const compat = require('../microvm/compat');
  const plan = require('../microvm/plan');
  const manifest = readJsonBlob(e.manifestDigest);
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const compressedBytes = layers.reduce((a, l) => a + (Number(l.size) || 0), 0) || (e.index && e.index.compressedBytes) || null;
  const config = readJsonBlob(e.configDigest);
  const runtime = config ? reg().runtimeConfig(config) : null;
  const meta = cpio.readRootfsMeta(CFG.imagesDir, e.configDigest);
  const files = initrdFilesOf(e.configDigest);
  const want = e.index && e.index.initrd && e.index.initrd.file ? path.join(CFG.imagesDir, 'initrd', e.index.initrd.file) : null;
  const initrd = want && files.some((f) => samePath(f, want)) ? want : files[0] || null;
  const initrdBytes = initrd ? fileSize(initrd) : null;
  // the image disk (disk root): the index names the current one
  const di = e.index && e.index.disk && typeof e.index.disk.file === 'string' ? e.index.disk : null;
  const diskFile = di ? path.join(CFG.imagesDir, 'disks', path.basename(di.file)) : null;
  const diskBytes = diskFile ? fileSize(diskFile) || null : null;
  const diskMeta = diskBytes ? require('../microvm/rootdisk').readDiskMetaFor(diskFile, e.configDigest) : null;
  const flattenWarnings = meta && Array.isArray(meta.warnings) ? meta.warnings : (diskMeta && Array.isArray(diskMeta.warnings) ? diskMeta.warnings : []);
  const capMB = compat.memCapMB(CFG);
  // what the engine would decide for a run with the CURRENT default root
  // file system: a disk root never flags an image as too large for RAM
  const rootfs = CFG.microvmRootfs === 'ram' ? 'ram' : 'disk';
  let engine = 'microvm';
  const reasons = [];
  if (runtime) {
    const f = compat.imageRules({ runtime, compressedBytes, capMB, recommendedMemMB: plan.recommendedMemMB, rootfs })
      .concat(rootfs === 'ram'
        ? (initrdBytes ? compat.rootfsRules({ runtime, initrdBytes, capMB, recommendedMemMB: plan.recommendedMemMB, warnings: flattenWarnings, rootfs }) : [])
        : (diskMeta ? compat.rootfsRules({ runtime, rootfs, facts: diskMeta.facts || {}, warnings: flattenWarnings }) : []));
    const d = compat.decide(f, 'auto');
    if (d.fallback) { engine = 'docker-vm'; reasons.push(d.fallback.reason); }
    for (const w of d.warnings) reasons.push(w);
  }
  const hasLayers = layers.length > 0 && layers.every((l) => reg().hasBlob(CFG.imagesDir, l.digest, l.size));
  return {
    references: Array.from(e.references).sort(),
    configDigest: e.configDigest,
    manifestDigest: e.manifestDigest || null,
    compressedBytes,
    rootfsBytes: meta ? meta.cpioBytes : (e.index && e.index.rootfsBytes) || null,
    initrdBytes,
    unpackedBytes: (diskMeta && diskMeta.unpackedBytes) || (e.index && e.index.unpackedBytes) || null,
    diskBytes,
    disk: diskBytes ? { file: path.basename(diskFile), key: di.key || null } : null,
    lastUsed: (e.index && e.index.lastUsed) || null,
    pulledAt: e.pulledAt,
    usedBy: records.filter((r) => r.configDigest === e.configDigest).map((r) => r.id),
    warnings: flattenWarnings.slice(0, 20),
    complete: hasLayers,
    runtime: runtime ? { entrypoint: runtime.entrypoint, cmd: runtime.cmd, user: runtime.user, exposedPorts: runtime.exposedPorts, workingDir: runtime.workingDir } : null,
    compat: { engine, reasons },
  };
}

async function listImages(ctx) {
  const k = knownImages();
  // index.json is built on the first scan from what refs.json knows
  const missing = Array.from(k.images.values()).filter((e) => !e.index && e.references.size);
  for (const e of missing) {
    try { e.index = updateIndex(e.configDigest, { references: Array.from(e.references), manifestDigest: e.manifestDigest }); } catch (x) { /* read-only folder: shown anyway */ }
  }
  const records = recordsOf(ctx);
  const images = Array.from(k.images.values()).map((e) => describeImage(e, records))
    .sort((a, b) => String(b.lastUsed || b.pulledAt || '').localeCompare(String(a.lastUsed || a.pulledAt || '')));
  return { images, rateLimit: lastRateLimit, cacheBytes: usage().total };
}

// ref: an image reference or a config digest
async function imageInfo(ref, ctx) {
  const cd = resolveConfigDigest(ref);
  const k = knownImages();
  const e = k.images.get(cd);
  if (!e) throw new ApiError(404, 'NOT_FOUND', 'image ' + ref + ' is not in the local cache');
  return describeImage(e, recordsOf(ctx));
}

function resolveConfigDigest(ref) {
  const s = String(ref || '').trim();
  if (CFG_RE.test(s)) return s;
  if (/^[a-f0-9]{12,64}$/.test(s)) {
    const k = knownImages();
    const hits = Array.from(k.images.keys()).filter((cd) => cd.slice(7).startsWith(s));
    if (hits.length === 1) return hits[0];
  }
  let canon;
  try { canon = reg().parseImageRef(s).canonical; } catch (e) { throw new ApiError(400, 'BAD_REFERENCE', e.message); }
  const refs = reg().readRefs(CFG.imagesDir);
  if (refs[canon] && refs[canon].configDigest) return refs[canon].configDigest;
  const idx = readIndex();
  for (const cd of Object.keys(idx.images)) if ((idx.images[cd].references || []).includes(canon)) return cd;
  throw new ApiError(404, 'NOT_FOUND', 'image ' + s + ' is not in the local cache');
}

function writeRefs(refs) {
  fs.mkdirSync(CFG.imagesDir, { recursive: true });
  atomicWriteFileSync(path.join(CFG.imagesDir, 'refs.json'), JSON.stringify(refs, null, 2));
}

function rmCount(file, out) {
  const size = fileSize(file);
  try { fs.rmSync(file); out.files++; out.freedBytes += size; return true; }
  catch (e) { if (e.code !== 'ENOENT') out.kept.push({ file: path.basename(file), why: e.code || e.message }); return false; }
}

// Delete one image completely (caller holds its image lock). -> counters
// ctx: {inUse: [initrd files of live containers - also those still starting,
//       whose initrd is built but not booted yet], disksInUse: [image disks
//       of live containers], records (each an array or a function, read
//       here - under the lock), minAgeMs (prune: files younger than this
//       stay - a pull or build in flight is never raced), now}
function dropImage(cd, ctx, out) {
  ctx = ctx || {};
  const now = ctx.now || Date.now();
  const young = (f) => {
    if (!(ctx.minAgeMs > 0)) return false;
    try { return now - fs.statSync(f).mtimeMs < ctx.minAgeMs; } catch (e) { return false; }
  };
  const k = knownImages();
  const e = k.images.get(cd);
  const need = e ? blobsOf(e) : new Set([cd]);
  // refs and index first: nothing points at the files any more
  let changed = false;
  for (const canon of Object.keys(k.refs)) if (k.refs[canon] && k.refs[canon].configDigest === cd) { delete k.refs[canon]; changed = true; }
  if (changed) writeRefs(k.refs);
  if (k.idx.images[cd]) {
    delete k.idx.images[cd];
    fs.mkdirSync(CFG.imagesDir, { recursive: true });
    atomicWriteFileSync(indexFile(), JSON.stringify(k.idx, null, 2) + '\n');
  }
  const inUse = listOf(ctx.inUse);
  for (const f of initrdFilesOf(cd)) {
    if (inUse.some((u) => samePath(u, f))) { out.kept.push({ file: path.basename(f), why: 'in use by a running container' }); continue; }
    if (young(f)) { out.kept.push({ file: path.basename(f), why: 'younger than ' + Math.round(ctx.minAgeMs / 60000) + ' min' }); continue; }
    rmCount(f, out);
  }
  // image disks: a disk a container still boots (its writable layer names
  // it, its record does, or it runs) stays with its sidecar - "dangling"
  // without an index entry until its last container is removed
  const rootdisk = require('../microvm/rootdisk');
  const refs = rootdisk.diskReferences({ records: recordsOf(ctx), inUse: listOf(ctx.disksInUse) });
  for (const f of diskFilesOf(cd)) {
    const why = rootdisk.referenceOf(refs, f);
    if (why) { out.kept.push({ file: path.basename(f), why }); continue; }
    if (young(f)) { out.kept.push({ file: path.basename(f), why: 'younger than ' + Math.round(ctx.minAgeMs / 60000) + ' min' }); continue; }
    if (rmCount(f, out)) { try { fs.rmSync(f + '.json', { force: true }); } catch (x) { /* the next prune */ } }
  }
  const hex = cd.slice(7);
  let rootfs = [];
  try { rootfs = fs.readdirSync(path.join(CFG.imagesDir, 'rootfs')).filter((n) => n.startsWith(hex + '-v')); } catch (x) { rootfs = []; }
  for (const n of rootfs) rmCount(path.join(CFG.imagesDir, 'rootfs', n), out);
  // blobs no remaining image needs
  const keep = new Set();
  for (const other of knownImages().images.values()) for (const d of blobsOf(other)) keep.add(d);
  for (const d of need) {
    if (keep.has(d)) continue;
    let f;
    try { f = reg().blobPath(CFG.imagesDir, d); } catch (x) { continue; }
    if (isHeld(d)) { out.kept.push({ file: path.basename(f), why: 'used by an image being prepared' }); continue; }
    if (young(f)) continue;
    rmCount(f, out);
  }
}

// A container that is STARTING may not know its config digest yet (it is
// set once the pull resolves): it uses an image through its reference.
// ctx.liveRefs: canonical references of the live (starting or running)
// containers.
function usedByRef(e, ctx) {
  const live = new Set(listOf(ctx && ctx.liveRefs));
  if (!live.size || !e) return false;
  for (const r of e.references || []) if (live.has(r)) return true;
  return false;
}

// The container records that use image cd: by config digest, or - one still
// pulling - by a live reference of the image (ctx.liveRefs).
function usersOf(cd, ctx, e) {
  const records = recordsOf(ctx);
  const users = records.filter((r) => r.configDigest === cd);
  const liveRefs = new Set(listOf(ctx && ctx.liveRefs));
  for (const r of records) {
    if (users.indexOf(r) === -1 && r.reference && liveRefs.has(r.reference) && !r.configDigest && e && e.references.has(r.reference)) users.push(r);
  }
  return users;
}

// sel: {image | configDigest, force}; ctx: {records, inUse: [initrd files],
//       disksInUse: [image disks of live containers],
//       liveRefs: [canonical references of live containers]} - arrays, or
//       functions read under the image's lock (what the engine passes)
async function removeImage(sel, ctx) {
  sel = sel || {};
  const given = sel.configDigest || sel.image;
  if (!given) throw new ApiError(400, 'BAD_REQUEST', 'image (a reference) or configDigest is required');
  const cd = resolveConfigDigest(given);
  const out = { configDigest: cd, untagged: [], removed: false, files: 0, freedBytes: 0, kept: [] };
  return withImageLock(cd, async () => {
    const k = knownImages();
    const e = k.images.get(cd);
    if (!e) throw new ApiError(404, 'NOT_FOUND', 'image ' + given + ' is not in the local cache');
    // who uses it is decided HERE, under the lock: a container whose start
    // held the lock until a moment ago is counted (cr-1)
    const users = usersOf(cd, ctx, e);
    // "rmi <tag>" of an image with other tags only removes that tag
    if (sel.image && !CFG_RE.test(String(sel.image)) && e.references.size > 1) {
      const canon = reg().parseImageRef(String(sel.image).trim()).canonical;
      if (k.refs[canon]) { delete k.refs[canon]; writeRefs(k.refs); }
      if (k.idx.images[cd]) {
        k.idx.images[cd].references = (k.idx.images[cd].references || []).filter((r) => r !== canon);
        atomicWriteFileSync(indexFile(), JSON.stringify(k.idx, null, 2) + '\n');
      }
      out.untagged.push(canon);
      return out;
    }
    if (users.length && !sel.force) {
      throw new ApiError(409, 'IMAGE_IN_USE', 'image ' + given + ' is used by container ' + users.map((r) => '"' + r.name + '"').join(', ') + ' - remove the container(s) first, or force');
    }
    out.untagged = Array.from(e.references);
    dropImage(cd, ctx, out);
    out.removed = true;
    return out;
  });
}

// ctx: {records, inUse, disksInUse, liveRefs (arrays, or functions read at
//       each decision - under the image's lock), t, now, minAgeMs,
//       olderThanDays (only images whose last use - else their pull - is
//       older; an image with neither date is kept)}
async function pruneImages(ctx) {
  ctx = ctx || {};
  const now = ctx.now || Date.now();
  const minAge = ctx.minAgeMs === undefined ? INITRD_MIN_AGE_MS : ctx.minAgeMs;
  const out = { images: [], files: 0, freedBytes: 0, kept: [] };
  const say = (m) => { if (ctx.t) ctx.t.log(m); };
  const dropCtx = Object.assign({}, ctx, { now, minAgeMs: minAge });
  const cutoff = ctx.olderThanDays > 0 ? now - ctx.olderThanDays * 86400000 : null;
  const unused = (cd, e) => !recordsOf(ctx).some((r) => r.configDigest === cd) && !usedByRef(e, ctx);
  for (const e0 of Array.from(knownImages().images.values())) {
    if (!unused(e0.configDigest, e0)) continue;
    if (cutoff !== null) {
      const last = Date.parse((e0.index && e0.index.lastUsed) || e0.pulledAt || '');
      if (!(last < cutoff)) continue;
    }
    await withImageLock(e0.configDigest, async () => {
      // looked at again under the lock (cr-1): a container created while the
      // prune ran - or whose start held this lock until now - uses it, and
      // a start may have used it (lastUsed) since the list was taken
      const e = knownImages().images.get(e0.configDigest);
      if (!e || !unused(e.configDigest, e)) return;
      if (cutoff !== null) {
        const last = Date.parse((e.index && e.index.lastUsed) || e.pulledAt || '');
        if (!(last < cutoff)) return;
      }
      say('Removing ' + (Array.from(e.references).join(', ') || e.configDigest.slice(0, 19)));
      dropImage(e.configDigest, dropCtx, out);
      out.images.push(Array.from(e.references)[0] || e.configDigest);
    });
  }
  // what is left: stale initrds (older init/kernel), transient rootfs
  // archives, orphan blobs, dead writers' .part files
  const k = knownImages();
  const keepInitrd = [];
  for (const e of k.images.values()) {
    const x = e.index && e.index.initrd && e.index.initrd.file;
    if (x) keepInitrd.push(path.join(CFG.imagesDir, 'initrd', x));
  }
  const g = pruneInitrds({ keep: keepInitrd, inUse: listOf(ctx.inUse), minAgeMs: minAge, now });
  for (const f of g.removed) { out.files++; }
  // image disks no index entry and no container names (stale keys, the
  // disks of force-removed images whose last container went), and disk-root
  // boot archives no live container booted - who uses what is read at each
  // deletion (cr-1, cr-8)
  const rootdisk = require('../microvm/rootdisk');
  const rd = await rootdisk.pruneImageDisks({ records: () => recordsOf(ctx), inUse: () => listOf(ctx.disksInUse), minAgeMs: minAge, now });
  out.files += rd.removed.length;
  out.freedBytes += rd.freedBytes;
  for (const k of rd.kept) out.kept.push({ file: path.basename(k.file), why: k.why });
  const ri = rootdisk.pruneDiskInitrds({ inUse: () => listOf(ctx.inUse), minAgeMs: minAge, now });
  out.files += ri.removed.length;
  const oldEnough = (f) => { try { return now - fs.statSync(f).mtimeMs >= minAge; } catch (e) { return false; } };
  const rootfsDir = path.join(CFG.imagesDir, 'rootfs');
  let names = [];
  try { names = fs.readdirSync(rootfsDir); } catch (e) { names = []; }
  const keepCfg = new Set(Array.from(k.images.keys()).map((cd) => cd.slice(7)));
  for (const n of names) {
    const f = path.join(rootfsDir, n);
    const hex = n.slice(0, 64);
    if (/\.part$/.test(n)) { if (now - (fs.statSync(f).mtimeMs || 0) > PART_MAX_AGE_MS) rmCount(f, out); continue; }
    // the archive is transient once an initrd holds it; sidecars of kept
    // images stay
    if (/\.cpio(\.gz)?$/.test(n) && oldEnough(f)) { rmCount(f, out); continue; }
    if (/\.json$/.test(n) && !keepCfg.has(hex) && oldEnough(f)) rmCount(f, out);
  }
  const keepBlobs = new Set();
  for (const e of k.images.values()) for (const d of blobsOf(e)) keepBlobs.add(d);
  const blobDir = path.join(CFG.imagesDir, 'blobs', 'sha256');
  let blobs = [];
  try { blobs = fs.readdirSync(blobDir); } catch (e) { blobs = []; }
  for (const n of blobs) {
    const f = path.join(blobDir, n);
    if (/\.part$/.test(n)) { try { if (now - fs.statSync(f).mtimeMs > PART_MAX_AGE_MS) rmCount(f, out); } catch (e) { /* gone */ } continue; }
    if (!/^[a-f0-9]{64}$/.test(n) || keepBlobs.has('sha256:' + n) || isHeld('sha256:' + n)) continue;
    if (oldEnough(f)) rmCount(f, out);
  }
  say('Cache now ' + fmtBytes(usage().total));
  return out;
}

module.exports = {
  KeyedMutex, withImageLock, pruneInitrds, requireSpace, readIndex, updateIndex, indexFile, holdBlobs,
  listImages, imageInfo, removeImage, pruneImages, usage, noteRateLimit, resolveConfigDigest,
  INITRD_MIN_AGE_MS,
};
