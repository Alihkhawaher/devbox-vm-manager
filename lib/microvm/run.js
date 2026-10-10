'use strict';
/*
 * The microVM engine's building blocks: run one OCI image as its own
 * headless microVM. The image is pulled straight from its registry,
 * flattened on the host, and booted with a small Linux kernel whose PID 1
 * is a busybox init (init.sh) that runs the image's entrypoint. No Docker
 * Engine anywhere. Two root file systems:
 *   disk (the default) - the image is a read-only ext4 IMAGE DISK built on
 *        the host once per image (rootdisk.js) and shared by its
 *        containers; each container boots a small initramfs that mounts its
 *        own copy-on-write overlay of it and switch_roots there. Guest RAM
 *        does not depend on the image size (128 MB by default).
 *   ram  (opt-in) - the image is an initramfs held in guest RAM (about
 *        2 x image + 90 MB to boot) and resets at every start.
 *
 * This module has NO state of its own (no run records, no fixed paths): the
 * container registry (containers.json) lives in containers.js/store.js, data
 * paths come from CFG, QEMU from platform.findTool, the accelerator from
 * platform.detectAccel, control endpoints from vm.runtimeEndpoints (bug B,
 * bug A, bug V3).
 *
 *   prepareImage(ref, o)       pull (blob cache) -> [image lock] -> o.rootfs
 *                              (REQUIRED, 'disk' | 'ram': nothing here picks
 *                              a root for the caller - cov-2) 'disk': the
 *                              image disk by key (built on a miss); 'ram':
 *                              the initrd by content key; on a miss flatten
 *                              (rootfs .cpio), build the initrd, delete the
 *                              transient .cpio. Flatten warnings go to the
 *                              task log and the result (bug V10).
 *                              o.onRoot({disk} | {initrd}) is called INSIDE
 *                              the image lock once the file is there: the
 *                              caller claims it before a removal or prune
 *                              waiting for that lock can look (cr-1).
 *   prepareRootByDigest(cd, o) disk root of a container that already has a
 *                              writable layer: its image disk by config
 *                              digest - no reference resolution, no network
 *                              (Docker: a container stays bound to its image)
 *   hostFacts(o)               host.json via plan.hostDefaults (detected accel)
 *   controlEndpoints(id)       fresh private console + monitor endpoints
 *   rotateLogs(runDir)         *.log -> *.prev.log (one generation)
 *   launch(o)                  plan + spawn QEMU detached (-pidfile), retry
 *                              with fresh endpoints when a control socket
 *                              could not bind; -> runtime record
 *   qemuLogErrors(text)        QEMU's own output minus informational lines,
 *                              plus the recognised failure (bug V9)
 *   sendConsole(ep, text)      one short connection to the ttyS0 socket
 *   requestStop(rt, o)         ONE graceful stop request (console, else ACPI);
 *                              the acknowledged, repeated protocol of spec
 *                              section 7.4 is built on top by containers.js
 *   forceStop(rt)              HMP quit, then kill the pid only if it is
 *                              still a QEMU process
 *   watch(rt, o)               follow console.log for markers and the pid
 *                              for liveness; works for runs another manager
 *                              process started (adoption)
 *   readExit(runDir)           exit marker etc. from console.log
 *   urlsFor(ports)             URLs to show for published tcp ports
 *   imageBaseName(familiar)    "nginx" from "nginx:alpine" (default names)
 *
 * Run directory CFG.microvmsDir/<id>/ (spec section 4):
 *   spec.sh  console.log  stdout.log  stderr.log  qemu.log  qemu.pid
 *   stdout.prev.log  stderr.prev.log  console.prev.log  copyin.cpio
 *   root.qcow2 (disk root: the writable layer, kept across restarts)
 * QEMU writes the logs itself, so a run is observed by tailing files and
 * controlled by short connections to its private endpoints: nothing depends
 * on the manager process that started it staying alive.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { CFG } = require('../config');
const platform = require('../platform');
const monitor = require('../monitor');
const { sleep, errMsg } = require('../util');
const registry = require('../oci/registry');
const ociCpio = require('../oci/cpio');
const images = require('../oci/images');
const kernel = require('./kernel');
const plan = require('./plan');
const { FileTail, LineSplitter } = require('./tail');

class EngineError extends Error {
  constructor(code, message, extra) { super(message); this.name = 'EngineError'; this.code = code; if (extra) Object.assign(this, extra); }
}

// ------------------------------------------------------------------ helpers
function imageBaseName(familiar) {
  const last = String(familiar || '').split('/').pop().split(/[:@]/)[0];
  return last.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40) || 'run';
}

function urlsFor(ports) {
  const urls = [];
  for (const p of ports || []) {
    if ((p.proto || 'tcp') !== 'tcp') continue;
    const hostPort = p.hostPort || p.host;
    const lan = !!(p.lan || p.hostAddr === '0.0.0.0');
    const u = { url: 'http://127.0.0.1:' + hostPort + '/', hostPort, containerPort: p.guestPort || p.guest, lan };
    if (lan) u.lanUrls = platform.lanAddresses().map((a) => 'http://' + a + ':' + hostPort + '/');
    urls.push(u);
  }
  return urls;
}

function requireKernel() {
  const dir = kernel.findKernelDir();
  if (!dir) throw new EngineError('NO_KERNEL', 'the microVM kernel is not installed yet - run Setup ("Set up for Docker images") first', { status: 409 });
  return { dir, manifest: kernel.loadManifest(dir) };
}

// ------------------------------------------------------------------ image
const MiB = 1048576;
// The whole image lives in guest RAM (about 2 x image + 90 MB while booting):
// an image whose estimated need is beyond the most memory a VM may get here
// can never boot, so it is refused before a byte of it is downloaded (sec-3).
const UNPACK_ESTIMATE = 3; // unpacked / compressed, measured 2.26-2.82
function tooLargeError(familiar, compressedBytes) {
  const maxMem = CFG.maxMem || 16384;
  const need = plan.recommendedMemMB(UNPACK_ESTIMATE * compressedBytes);
  if (need <= maxMem) return null;
  return new EngineError('IMAGE_TOO_LARGE', familiar + ' is ' + Math.round(compressedBytes / MiB) + ' MB compressed (about ' +
    Math.round(UNPACK_ESTIMATE * compressedBytes / MiB) + ' MB unpacked): a microVM holds the whole image in RAM and would need about ' + need +
    ' MB, more than the ' + maxMem + ' MB a VM may get on this PC - run it with Docker inside a VM', { status: 409 });
}
// Flatten caps for the RAM root: the uncompressed layer data may not
// exceed twice the memory cap (a gzip bomb stops there, not at the generic
// 8 GiB), but never less than 2 GiB.
function flattenLimits() {
  const capMB = require('./compat').memCapMB(CFG);
  return { maxBytes: Math.min(8 * 1024 * MiB, Math.max(2 * 1024 * MiB, 2 * capMB * MiB)) };
}
// The disk root's cap has nothing to do with RAM: CFG.microvmImageMaxGB
// (16 GiB unpacked by default) - IMAGE_TOO_LARGE above it.
function diskFlattenLimits() {
  return { maxBytes: Math.floor(require('./rootdisk').maxImageGB() * 1024 * MiB) };
}
// Before the layers are downloaded, a disk-root image needs disk, not RAM:
// the download plus its unpacked copy on the image disk (unpacked is at
// most ~2.8 x compressed, measured; 3.3 leaves room for ext4's rounding).
const DISK_SPACE_FACTOR = 3.3;
// The disk root's size cap, checked BEFORE the download (cr-11): the layers
// unpack to at least their compressed size (gzip adds a few bytes per 16 KB
// even to data it cannot shrink: 1% covers it), so an image whose download
// alone passes the cap is refused at once instead of after the pull. An
// image that probably unpacks past it (UNPACK_ESTIMATE x compressed) is only
// warned about: the exact size is known once the layers are indexed.
function diskSizePreflight(familiar, compressedBytes, t) {
  const capBytes = require('./rootdisk').maxImageGB() * 1024 * MiB;
  if (compressedBytes > capBytes * 1.01) {
    return new EngineError('IMAGE_TOO_LARGE', familiar + ' is ' + (compressedBytes / (1024 * MiB)).toFixed(1) + ' GB to download, so it unpacks to more than ' +
      require('./rootdisk').maxImageGB() + ' GB, above the limit for one image (config.json microvmImageMaxGB) - raise that limit, or run it with Docker inside a VM', { status: 409 });
  }
  if (UNPACK_ESTIMATE * compressedBytes > capBytes && t) {
    t.warn(familiar + ' is ' + Math.round(compressedBytes / MiB) + ' MB to download and probably unpacks to more than the ' + require('./rootdisk').maxImageGB() +
      ' GB limit for one image (config.json microvmImageMaxGB): it may be refused once it is downloaded');
  }
  return null;
}

// o: {pull ('missing'|'always'|'never'), t (task context), signal
//     (AbortSignal), onProgress(ev), platform, preflight(img) (called with
//     {reference, manifestDigest, configDigest, config, layers,
//     totalCompressed} once the manifest and config are known - BEFORE any
//     layer is downloaded and before any flatten; throw to stop - the
//     compatibility rules of spec 14.2 use it)}
// Before the layers are downloaded it also refuses an image too large to
// ever boot (IMAGE_TOO_LARGE) and checks the free disk space for the
// download plus the unpacked copies (NO_SPACE) - sec-3, spec 15.6. The
// blobs it uses are held (images.holdBlobs) until it returns, so an image
// removal or prune meanwhile cannot delete them (correct-6).
// o.rootfs: 'disk' | 'ram' - required (EngineError BAD_ROOTFS otherwise: a
// caller that forgot it must not get a RAM root it never asked for - cov-2).
// A disk root is never refused for its RAM need before the download (that
// rule is RAM arithmetic): it needs free DISK for the download and its
// unpacked copy, and its unpacked size may not pass CFG.microvmImageMaxGB
// (refused before the download when the download alone is above it).
// o.onRoot(r): see the header - {disk} or {initrd}, inside the image lock.
// -> RAM root: {reference, familiar, configDigest, manifestDigest, runtime,
//     rootfs: 'ram', initrd, initrdBytes, rootfsBytes, kernelDir, manifest,
//     compressedBytes, downloadedBytes, rateLimit, warnings, config,
//     cached: {image, initrd}, timings: {pullMs, flattenMs, initrdMs}}
//    disk root: {reference, familiar, configDigest, manifestDigest, runtime,
//     rootfs: 'disk', disk (absolute), diskKey, diskBytes, virtualBytes,
//     unpackedBytes, facts, kernelDir, manifest, compressedBytes,
//     downloadedBytes, rateLimit, warnings, config, cached: {image, disk},
//     timings: {pullMs, diskMs}, initrd: null, initrdBytes: null}
async function prepareImage(ref, o) {
  o = o || {};
  if (o.rootfs !== 'disk' && o.rootfs !== 'ram') {
    throw new EngineError('BAD_ROOTFS', 'prepareImage: rootfs must be "disk" or "ram" (got ' + JSON.stringify(o.rootfs === undefined ? null : o.rootfs) + ')');
  }
  const holds = [];
  try { return await prepareImageHeld(ref, o, holds); }
  finally { for (const release of holds) release(); }
}

async function prepareImageHeld(ref, o, holds) {
  const t = o.t || { log() {}, step() {}, warn() {} };
  const k = requireKernel();
  const t0 = Date.now();
  const disk = o.rootfs === 'disk';
  const parsed = registry.parseImageRef(ref);
  const cachedRef = registry.readRefs(CFG.imagesDir)[parsed.canonical];
  if (!cachedRef && !parsed.digest && o.pull !== 'never') t.step('Pulling ' + parsed.familiar + ' from ' + parsed.registry);
  let layersTotal = 0, layersDone = 0;
  let preflighted = false;
  const img = await registry.pullImage(parsed, {
    root: CFG.imagesDir, pullPolicy: o.pull || 'missing', signal: o.signal, platform: o.platform,
    beforeLayers: async (info) => {
      holds.push(images.holdBlobs(info.layers.map((l) => l.digest).concat([info.configDigest, info.manifestDigest])));
      // the compat rules first: with engine "auto" a large image goes to
      // Docker-in-VM, which is a better answer than "too large"
      if (o.preflight) await o.preflight(info);
      preflighted = true;
      if (disk) {
        // the size cap, then the download and the image disk (no RAM rule:
        // the image stays on disk)
        if (info.missingBytes > 0) {
          const big = diskSizePreflight(parsed.familiar, info.totalCompressed, t);
          if (big) throw big;
          images.requireSpace(info.missingBytes + DISK_SPACE_FACTOR * info.totalCompressed + 64 * MiB, 'downloading ' + parsed.familiar);
        }
        return;
      }
      const big = tooLargeError(parsed.familiar, info.totalCompressed);
      if (big) throw big;
      // the download, the unpacked archive and its copy in the initrd
      if (info.missingBytes > 0) images.requireSpace(info.missingBytes + info.totalCompressed * 6, 'downloading ' + parsed.familiar);
    },
    onProgress: (ev) => {
      if (o.onProgress) { try { o.onProgress(ev); } catch (e) { /* a progress consumer must not break the pull */ } }
      if (ev.phase === 'manifest' && ev.layers) layersTotal = ev.layers;
      if (ev.phase === 'blob-done') {
        layersDone++;
        if (!ev.cached) t.log('  layer ' + ev.digest.slice(7, 19) + ' ' + (ev.size / 1048576).toFixed(1) + ' MB downloaded (' + layersDone + '/' + layersTotal + ')');
      }
    },
  });
  const t1 = Date.now();
  if (o.signal && o.signal.aborted) throw new EngineError('ABORTED', 'stopped before the app started');
  if (!preflighted && o.preflight) await o.preflight(img);
  if (disk) return prepareDiskRoot(img, parsed, k, o, t, t1 - t0);
  let flattenMs = 0, initrdMs = 0;
  const out = await images.withImageLock(img.configDigest, async () => {
    const paths = ociCpio.rootfsPaths(CFG.imagesDir, img.configDigest);
    let meta = ociCpio.readRootfsMeta(CFG.imagesDir, img.configDigest);
    let warningsNew = false;
    const buildRootfs = async () => {
      const ta = Date.now();
      // unpacked is ~2.3-2.8x the download; the initrd copy needs as much again
      images.requireSpace(Math.max(64 * 1048576, img.totalCompressed * 6), 'flattening ' + parsed.familiar);
      t.step('Building the root filesystem of ' + parsed.familiar + ' (' + img.layers.length + ' layers)');
      const r = await ociCpio.ensureRootfsCpio(parsed, {
        root: CFG.imagesDir, image: img, limits: flattenLimits(),
        // the exact size is known once the layers are indexed: the archive
        // and its copy in the initrd must fit before a byte is written
        beforeEmit: (s) => { images.requireSpace(s.uncompressedBytes * 2 + 64 * MiB, 'unpacking ' + parsed.familiar); },
      });
      meta = r.meta;
      warningsNew = !r.cached;
      flattenMs = Date.now() - ta;
      return r.path;
    };
    const tb = Date.now();
    // the initrd holds a full copy of the rootfs archive, so only a miss
    // needs the archive (re-flattened from the blobs when it was deleted)
    if (!meta) await buildRootfs();
    const ir = await plan.ensureImageInitrd({
      configDigest: img.configDigest, manifest: k.manifest, kernelDir: k.dir,
      rootfsCpio: async () => (fs.existsSync(paths.archive) && meta ? paths.archive : buildRootfs()),
    });
    initrdMs = Date.now() - tb - flattenMs;
    // the rootfs archive is TRANSIENT once the initrd exists (spec section 4:
    // halves the disk use); its .json sidecar stays
    if (fs.existsSync(paths.archive)) { try { fs.rmSync(paths.archive, { force: true }); } catch (e) { /* busy: next time */ } }
    const warnings = (meta && meta.warnings) || [];
    if (warnings.length && (warningsNew || !ir.cached)) {
      for (const w of warnings.slice(0, 20)) t.warn('image: ' + w);
      if (warnings.length > 20) t.warn('image: ... and ' + (warnings.length - 20) + ' more warnings');
    }
    try {
      images.updateIndex(img.configDigest, {
        references: [img.reference], lastUsed: new Date().toISOString(), manifestDigest: img.manifestDigest,
        compressedBytes: img.totalCompressed, rootfsBytes: meta ? meta.cpioBytes : null,
        initrd: { file: path.basename(ir.file), key: ir.key, bytes: ir.bytes }, warnings: warnings.length,
      });
    } catch (e) { t.warn('could not update the image index: ' + errMsg(e)); }
    // claimed before the lock goes (cr-1)
    if (o.onRoot) o.onRoot({ initrd: ir.file });
    return { ir, meta, warnings };
  });
  return {
    reference: img.reference, familiar: parsed.familiar, configDigest: img.configDigest, manifestDigest: img.manifestDigest,
    runtime: (out.meta && out.meta.runtime) || registry.runtimeConfig(img.config), rootfs: 'ram',
    initrd: out.ir.file, initrdBytes: out.ir.bytes, initrdKey: out.ir.key, rootfsBytes: out.meta ? out.meta.cpioBytes : null,
    kernelDir: k.dir, manifest: k.manifest,
    compressedBytes: img.totalCompressed, downloadedBytes: img.downloadedBytes, rateLimit: img.rateLimit,
    warnings: out.warnings.slice(), config: img.config,
    cached: { image: img.downloadedBytes === 0, initrd: out.ir.cached },
    timings: { pullMs: t1 - t0, flattenMs, initrdMs },
  };
}

// Show a disk build's flatten warnings once (when it was built), and keep the
// image index current. Caller holds the image lock.
// reference: the tag just resolved (a pull). Without one (a restart bound by
// config digest) the index is only touched when the image is still listed -
// a disk kept for a container after a forced removal of its image must stay
// unindexed, or it would never be collected - and an older disk the overlay
// names never replaces the image's current one.
function noteDisk(img, d, t, reference) {
  const warnings = (d.meta && d.meta.warnings) || [];
  if (warnings.length && !d.cached) {
    for (const w of warnings.slice(0, 20)) t.warn('image: ' + w);
    if (warnings.length > 20) t.warn('image: ... and ' + (warnings.length - 20) + ' more warnings');
  }
  try {
    if (!reference) {
      const cur = images.readIndex().images[d.meta.configDigest];
      if (!cur) return warnings;
      if (d.meta.key !== require('./rootdisk').imageDiskKey({ configDigest: d.meta.configDigest })) {
        images.updateIndex(d.meta.configDigest, { lastUsed: new Date().toISOString() });
        return warnings;
      }
    }
    const patch = {
      lastUsed: new Date().toISOString(), unpackedBytes: d.meta.unpackedBytes,
      disk: { file: path.basename(d.file), key: d.meta.key, bytes: fileBytes(d.file), virtualBytes: d.meta.virtualBytes, builtAt: d.meta.builtAt },
      warnings: warnings.length,
    };
    if (reference) patch.references = [reference];
    if (img && img.manifestDigest) patch.manifestDigest = img.manifestDigest;
    if (img && img.totalCompressed) patch.compressedBytes = img.totalCompressed;
    images.updateIndex(d.meta.configDigest, patch);
  } catch (e) { t.warn('could not update the image index: ' + errMsg(e)); }
  return warnings;
}

function fileBytes(f) { try { return fs.statSync(f).size; } catch (e) { return null; } }

function diskResult(d, o) {
  return {
    rootfs: 'disk', disk: d.file, diskKey: d.meta.key, diskBytes: fileBytes(d.file), virtualBytes: d.meta.virtualBytes,
    unpackedBytes: d.meta.unpackedBytes, facts: Object.assign({ passwd: null, group: null, s6: false }, d.meta.facts || {}),
    initrd: null, initrdBytes: null, initrdKey: null, rootfsBytes: null, kernelDir: o.k.dir, manifest: o.k.manifest,
  };
}

async function prepareDiskRoot(img, parsed, k, o, t, pullMs) {
  const rootdisk = require('./rootdisk');
  let diskMs = 0;
  const out = await images.withImageLock(img.configDigest, async () => {
    const d = await rootdisk.ensureImageDisk(img, { t, signal: o.signal, limits: diskFlattenLimits(), name: parsed.familiar });
    diskMs = d.ms;
    const warnings = noteDisk(img, d, t, img.reference);
    // claimed before the lock goes: a forced removal or a prune waiting for
    // this lock must see the disk as in use, though no overlay names it yet
    // (cr-1)
    if (o.onRoot) o.onRoot({ disk: d.file });
    return { d, warnings };
  });
  return Object.assign({
    reference: img.reference, familiar: parsed.familiar, configDigest: img.configDigest, manifestDigest: img.manifestDigest,
    runtime: out.d.meta.runtime || registry.runtimeConfig(img.config),
    compressedBytes: img.totalCompressed, downloadedBytes: img.downloadedBytes, rateLimit: img.rateLimit,
    warnings: out.warnings.slice(), config: img.config,
    cached: { image: img.downloadedBytes === 0, disk: out.d.cached },
    timings: { pullMs, diskMs },
  }, diskResult(out.d, { k }));
}

// The image of a container cached locally by config digest (no network):
// {reference, configDigest, manifestDigest, config, layers: [{digest, size,
// diffId, path}], totalCompressed} or null when a blob is missing.
function cachedImageByConfig(configDigest) {
  const idx = images.readIndex().images[configDigest] || {};
  const refs = registry.readRefs(CFG.imagesDir);
  const tops = [];
  if (idx.manifestDigest) tops.push(idx.manifestDigest);
  for (const c of Object.keys(refs)) {
    const r = refs[c];
    if (r && r.configDigest === configDigest) { if (r.platformDigest) tops.push(r.platformDigest); if (r.manifestDigest) tops.push(r.manifestDigest); }
  }
  const readJson = (d) => {
    try { if (registry.hasBlob(CFG.imagesDir, d)) return JSON.parse(fs.readFileSync(registry.blobPath(CFG.imagesDir, d), 'utf8')); } catch (e) { /* damaged */ }
    return null;
  };
  const config = readJson(configDigest);
  if (!config) return null;
  const diffIds = (config.rootfs && config.rootfs.diff_ids) || [];
  for (const md of tops) {
    const m = readJson(md);
    if (!m || !Array.isArray(m.layers) || !m.config || m.config.digest !== configDigest || m.layers.length !== diffIds.length) continue;
    const layers = m.layers.map((l, i) => ({ digest: l.digest, size: l.size, mediaType: l.mediaType, diffId: diffIds[i] }));
    if (!layers.every((l) => registry.hasBlob(CFG.imagesDir, l.digest, l.size))) return null;
    for (const l of layers) l.path = registry.blobPath(CFG.imagesDir, l.digest);
    const reference = (idx.references && idx.references[0]) || Object.keys(refs).find((c) => refs[c] && refs[c].configDigest === configDigest) || configDigest;
    return { reference, configDigest, manifestDigest: md, config, layers, totalCompressed: layers.reduce((a, l) => a + (Number(l.size) || 0), 0), downloadedBytes: 0 };
  }
  return null;
}

// Disk root of a container that already has a writable layer: it stays
// bound to its image by config digest (a later pull of the tag does not
// change it). o.disk: the image disk its overlay names (absolute) - booted
// when it is still there (even if a writer or format bump made a newer one);
// else the image's current disk; else rebuilt from the cached blobs under
// the image lock; else IMAGE_GONE. No reference resolution, no network.
// o: {t, signal, disk, onRoot} -> as prepareImage (disk root)
async function prepareRootByDigest(configDigest, o) {
  o = o || {};
  const t = o.t || { log() {}, step() {}, warn() {} };
  const k = requireKernel();
  const rootdisk = require('./rootdisk');
  const t0 = Date.now();
  let holds = [];
  try {
    const out = await images.withImageLock(configDigest, async () => {
      let meta = o.disk ? rootdisk.readDiskMetaFor(o.disk, configDigest) : null;
      let d = meta ? { file: meta.file, meta, cached: true, ms: 0 } : null;
      if (!d) { meta = rootdisk.readDiskMeta(configDigest); if (meta) d = { file: meta.file, meta, cached: true, ms: 0 }; }
      let img = null;
      if (!d) {
        img = cachedImageByConfig(configDigest);
        if (!img) {
          throw new EngineError('IMAGE_GONE', 'the image this container was created from is no longer in the cache - start it fresh (pulls the image again and drops the changes outside volumes) or remove it', { status: 409, hint: 'fresh' });
        }
        holds = [images.holdBlobs(img.layers.map((l) => l.digest).concat([configDigest, img.manifestDigest]))];
        if (o.signal && o.signal.aborted) throw new EngineError('ABORTED', 'stopped before the app started');
        d = await rootdisk.ensureImageDisk(img, { t, signal: o.signal, limits: diskFlattenLimits(), name: img.reference });
      }
      const warnings = noteDisk(img, d, t, null);
      if (o.onRoot) o.onRoot({ disk: d.file }); // inside the lock (cr-1)
      return { d, warnings, img };
    });
    const meta = out.d.meta;
    return Object.assign({
      reference: (out.img && out.img.reference) || null, familiar: null, configDigest, manifestDigest: (out.img && out.img.manifestDigest) || null,
      runtime: meta.runtime, compressedBytes: (out.img && out.img.totalCompressed) || null, downloadedBytes: 0, rateLimit: null,
      warnings: out.warnings.slice(), config: null, cached: { image: true, disk: out.d.cached },
      timings: { pullMs: 0, diskMs: Date.now() - t0 },
    }, diskResult(out.d, { k }));
  } finally { for (const release of holds) release(); }
}

// ------------------------------------------------------------------ host
// host.json for the detected accelerator and this QEMU (plan.hostDefaults).
async function hostFacts(o) {
  o = o || {};
  const k = requireKernel();
  return plan.hostDefaults({ kernelDir: k.dir, manifest: k.manifest, t: o.t, accel: o.accel, force: o.force });
}

// ------------------------------------------------------------------ endpoints
// A fresh private console + monitor endpoint pair for one start, exactly as
// VMs get them (random 127.a.b.c + OS-assigned ports on Windows, unix
// sockets in a private folder elsewhere). {console, monitor}.
async function controlEndpoints(id) {
  const ep = await require('../vm').runtimeEndpoints('ctr-' + id);
  return { console: ep.serial, monitor: ep.monitor };
}

// ------------------------------------------------------------------ logs
const ROTATED = ['stdout', 'stderr', 'console'];
function rotateLogs(runDir) {
  for (const n of ROTATED) {
    const cur = path.join(runDir, n + '.log');
    const prev = path.join(runDir, n + '.prev.log');
    try { if (fs.existsSync(cur)) { fs.rmSync(prev, { force: true }); fs.renameSync(cur, prev); } } catch (e) { /* busy: overwritten by QEMU */ }
  }
}

// QEMU's own output as it matters to a user (bug V9). The detached QEMU
// writes stdout and stderr to ONE file, so the text is taken as whole lines;
// informational lines (WHPX announcing itself, deprecation notes) are
// dropped, and a recognised failure is named.
//   -> {lines: [meaningful lines], code: null | 'CONTROL_PORT' | 'PORT_IN_USE'
//       | 'FILE' | 'ACCEL' | 'MEMORY' | 'OTHER', message}
const QEMU_INFO_RE = /accelerator is operational|^warning: .*(deprecated|dropping)|^qemu-system-x86_64: warning: host doesn't support requested feature/i;
const QEMU_ERRORS = [
  { code: 'CONTROL_PORT', re: /Failed to find an available port|Failed to bind socket|Address already in use|Only one usage of each socket address/i },
  { code: 'PORT_IN_USE', re: /Could not set up host forwarding rule/i },
  { code: 'FILE', re: /No such file or directory|could not open|Could not open|Permission denied/i },
  { code: 'ACCEL', re: /whpx|WHPX|hvf|kvm|accelerator|Unexpected VP exit code/i },
  { code: 'MEMORY', re: /cannot set up guest memory|Cannot allocate memory|out of memory/i },
];
function qemuLogErrors(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !QEMU_INFO_RE.test(l)).slice(-20);
  for (const e of QEMU_ERRORS) {
    const hit = lines.find((l) => e.re.test(l));
    if (hit) return { lines, code: e.code, message: hit.slice(0, 300) };
  }
  return { lines, code: lines.length ? 'OTHER' : null, message: lines.length ? lines[lines.length - 1].slice(0, 300) : null };
}

// ------------------------------------------------------------------ launch
// Resolves the exit code if the child exits within ms, else null.
function earlyExit(child, ms) {
  return new Promise((resolve) => {
    const settle = (code) => setTimeout(() => resolve(code === null ? -1 : code), 100);
    if (child.exitCode !== null || child.signalCode !== null) { settle(child.exitCode); return; }
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(null); }, ms);
    const onExit = (code) => { clearTimeout(timer); settle(code); };
    child.once('exit', onExit);
  });
}

// Detached, windowsHide, stdio straight into qemu.log: containers outlive
// the manager like VMs, and never belong to a kill-on-close job object.
function spawnQemu(qemu, args, qemuLog) {
  const fd = fs.openSync(qemuLog, 'w');
  let child;
  try { child = spawn(qemu, args, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  child.on('error', () => { /* reported through the exit / qemu.log */ });
  child.unref();
  return child;
}

// o: {id, runDir, prep (prepareImage result), host (hostFacts result),
//     spec (plan.buildSpec result), ports: [{hostPort, guestPort, proto, lan}],
//     volumes: [{file, format}] (same order as spec.volumes),
//     extraDrives, extraMemMB, fwcfg, accel, machine, memMB, cpus, t,
//     earlyExitMs (400), spawnFn(qemu, args, qemuLogFile) -> ChildProcess
//     (tests: a stand-in for QEMU; default: spawn it detached),
//     writeSpec(file, text) (plan.planRun: the spec holds env values),
//     onSpawn(runtime) - called right after EACH spawn, before the start
//     window: the caller records the runtime at once (spec 7.2 - a manager
//     that dies while the start is being checked must not leave a QEMU
//     nobody knows about); onSpawn(null) after an attempt that failed,
//     initrd (default prep.initrd; a disk root boots its small disk
//     initrd), rootDisk: {file (overlay), backing, backingRel} (disk root)}
// -> runtime {pid, startedAt, accel, effectiveAccel, machine, memMB, cpus,
//     initrd, rootfs, disk, overlay, monitor, console, logs, child}
//    (child: the ChildProcess, only while this manager process runs)
async function launch(o) {
  const qemu = platform.findTool('qemu');
  if (!qemu) throw new EngineError('PREREQ_MISSING', 'QEMU is not installed - ' + platform.installHints().qemu, { status: 409 });
  const t = o.t || { log() {}, step() {}, warn() {} };
  fs.mkdirSync(o.runDir, { recursive: true });
  const accel = o.accel || (await platform.detectAccel(qemu)).recommended || 'tcg';
  const machines = (o.host && o.host.machines) || ['microvm', 'q35'];
  const machine = o.machine || (machines.includes('microvm') ? 'microvm' : 'q35');
  const logs = {
    console: path.join(o.runDir, 'console.log'), stdout: path.join(o.runDir, 'stdout.log'),
    stderr: path.join(o.runDir, 'stderr.log'), qemu: path.join(o.runDir, 'qemu.log'),
  };
  const pidFile = path.join(o.runDir, 'qemu.pid');
  const initrd = o.initrd || o.prep.initrd;
  rotateLogs(o.runDir);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ep = await controlEndpoints(o.id);
    const p = plan.planRun({
      kernelDir: o.prep.kernelDir, manifest: o.prep.manifest, initrd, runDir: o.runDir, spec: o.spec,
      machine, accel, cpuModel: accel === 'whpx' && o.host ? o.host.cpuModel : undefined, tscKhz: o.host ? o.host.tscKhz : null,
      // the probe's WHPX options ('' = QEMU's defaults); facts from before the probe have none
      whpxOpts: accel === 'whpx' && o.host && typeof o.host.whpxOpts === 'string' ? o.host.whpxOpts : undefined,
      memMB: o.memMB || undefined, cpus: o.cpus || 1, rootDisk: o.rootDisk || undefined,
      // the light profile's smaller TCG translation cache (undefined: 128 MB)
      tcgTbSizeMB: Number.isInteger(CFG.tcgTbSizeMB) && CFG.tcgTbSizeMB >= 0 ? CFG.tcgTbSizeMB : undefined,
      ports: (o.ports || []).map((x) => ({ proto: x.proto || 'tcp', hostAddr: x.lan ? '0.0.0.0' : '127.0.0.1', hostPort: x.hostPort, guestPort: x.guestPort })),
      volumes: o.volumes || [], extraDrives: o.extraDrives || [], extraMemMB: o.extraMemMB || 0, fwcfg: o.fwcfg || [],
      console: ep.console, monitor: ep.monitor, name: qemuName(o.id), logs, pidFile, writeSpec: o.writeSpec,
    });
    for (const f of [logs.console, logs.stdout, logs.stderr]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* QEMU truncates */ } }
    try { fs.rmSync(pidFile, { force: true }); } catch (e) { /* stale */ }
    const child = (o.spawnFn || spawnQemu)(qemu, p.args, logs.qemu);
    const runtime = {
      pid: child.pid || null, startedAt: new Date().toISOString(), accel, effectiveAccel: accel, machine, memMB: p.memMB, cpus: o.cpus || 1,
      initrd, rootfs: o.rootDisk ? 'disk' : 'ram', disk: o.rootDisk ? o.rootDisk.backing || null : null, overlay: o.rootDisk ? o.rootDisk.file : null,
      monitor: ep.monitor, console: ep.console, logs, child,
    };
    if (o.onSpawn && runtime.pid) { try { o.onSpawn(runtime); } catch (e) { /* recording is the caller's business */ } }
    const early = await earlyExit(child, o.earlyExitMs || 400);
    // a guest that finished within the window (an instant one-shot command)
    // is a normal end, not a failed start: its exit marker is in the log
    if (early === null || /__DEVBOX_EXIT=\d/.test(readText(logs.console))) {
      runtime.effectiveAccel = await settledAccel(accel, logs.qemu, child, o.accelWaitMs, ep.monitor);
      if (runtime.effectiveAccel !== accel) t.warn('QEMU could not use ' + accel + ' and fell back to TCG software emulation: slower, and not a security boundary');
      return runtime;
    }
    if (o.onSpawn) { try { o.onSpawn(null); } catch (e) { /* see above */ } }
    const q = qemuLogErrors(readText(logs.qemu));
    lastErr = q;
    // a control socket was taken between choosing it and QEMU's bind: new
    // endpoints (spec section 7.2, bug V3)
    if (q.code === 'CONTROL_PORT' && attempt < 2) { t.log('A control port was busy - retrying with new ones...'); continue; }
    if (q.code === 'PORT_IN_USE') throw new EngineError('PORT_CONFLICT', 'QEMU could not listen on a published port: ' + q.message, { status: 409 });
    throw new EngineError('QEMU_FAILED', 'QEMU stopped at once' + (q.message ? ': ' + q.message : ' (exit code ' + early + ')'), { qemu: q });
  }
  throw new EngineError('QEMU_FAILED', 'QEMU could not bind its control sockets' + (lastErr && lastErr.message ? ': ' + lastErr.message : ''));
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }

// The QEMU -name of a container: what `info name` and the process command
// line show, so a pid can be proven to be this container's before it is
// adopted or killed.
function qemuName(id) { return 'devbox-ctr-' + id; }

// The first and the last `bytes` of a file the GUEST writes (console.log):
// never the whole thing - a root app can make it as big as it likes (sec-4).
// The start holds INIT/READY, the end the exit markers.
function readHeadTail(f, bytes) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 2 * bytes) {
      const b = Buffer.alloc(size);
      const n = fs.readSync(fd, b, 0, size, 0);
      return b.toString('utf8', 0, n);
    }
    const head = Buffer.alloc(bytes);
    const tail = Buffer.alloc(bytes);
    const nh = fs.readSync(fd, head, 0, bytes, 0);
    const nt = fs.readSync(fd, tail, 0, bytes, size - bytes);
    return head.toString('utf8', 0, nh) + '\n' + tail.toString('utf8', 0, nt);
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
  }
}

// The accelerator QEMU really uses. First QEMU's own answer through the
// monitor ("info accelerators": the active one in brackets - QEMU 11.1 no
// longer announces WHPX in its output, and every WHPX container got a false
// "fell back to TCG" warning). Without that command (older QEMU): WHPX
// announces itself in QEMU's output, but on a busy PC that line can come later
// than the start window (found in the E2E runs), so its absence is only
// believed after waitMs more (default 3 s) or once QEMU has ended.
async function settledAccel(accel, qemuLog, child, waitMs, monitorEp) {
  const vm = require('../vm');
  const end = Date.now() + (waitMs === undefined ? 3000 : waitMs);
  let askMonitor = !!monitorEp;
  for (;;) {
    const gone = child && (child.exitCode !== null || child.signalCode !== null);
    if (askMonitor && !gone) {
      const a = await require('../monitor').queryAccel(monitorEp, 1500).catch(() => null);
      if (a) return a;
      // no answer yet (still starting) or no such command: the log decides after the window
      if (Date.now() >= end) askMonitor = false;
    }
    const got = vm.effectiveAccel(accel, readText(qemuLog));
    if (got === accel || Date.now() >= end || gone) return got;
    await sleep(100);
  }
}

// ------------------------------------------------------------------ control
// One short connection to the console socket; resolves when the text was
// handed to the socket (NOT an acknowledgement: the guest may not be
// reading yet - containers.js resends until __DEVBOX_STOPPING appears).
function sendConsole(ep, text, timeoutMs) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    if (!ep || (!ep.path && !(ep.host && ep.port))) { reject(new Error('no console endpoint')); return; }
    const s = ep.path ? net.connect({ path: ep.path }) : net.connect({ host: ep.host, port: ep.port });
    const timer = setTimeout(() => { s.destroy(); reject(new Error('console connect timeout')); }, timeoutMs || 1500);
    s.once('connect', () => {
      s.end(text, () => { clearTimeout(timer); setTimeout(() => { s.destroy(); resolve(); }, 50); });
    });
    s.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ONE graceful stop request -> 'console' | 'acpi' | null (nothing reachable).
// o: {timeoutS (the guest's grace period, sent along), force (KILL at once)}
async function requestStop(rt, o) {
  o = o || {};
  const cmd = o.force ? '__DEVBOX_KILL KILL\n' : '__DEVBOX_STOP' + (o.timeoutS !== undefined ? ' ' + Math.max(0, Math.round(o.timeoutS)) : '') + '\n';
  try { await sendConsole(rt.console, cmd, 1500); return 'console'; } catch (e) { /* try ACPI */ }
  if (!o.force && rt.monitor) {
    const r = await monitor.systemPowerdown(rt.monitor);
    if (r.ok) return 'acpi';
  }
  return null;
}

async function waitDead(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!platform.pidAlive(pid)) return true;
    await sleep(50);
  }
  return !platform.pidAlive(pid);
}

// HMP quit (QEMU flushes the volume images), then kill the process:
//  - a QEMU spawned by THIS manager through its child handle (o.child): the
//    handle pins the pid, so no listing is needed - and a listing is what
//    fails on a busy Windows PC (tasklist timing out) - correct-7;
//  - otherwise only after a process listing confirmed the pid is still a
//    QEMU (pids get reused); a failed listing is retried once.
// -> 'already-gone' | 'quit' | 'killed' | 'failed'
async function forceStop(rt, o) {
  o = o || {};
  const pid = rt && rt.pid;
  const child = o.child && o.child.pid === pid ? o.child : null;
  const childGone = () => !!child && (child.exitCode !== null || child.signalCode !== null);
  if (!pid || childGone() || !platform.pidAlive(pid)) return 'already-gone';
  if (rt.monitor) await monitor.quit(rt.monitor);
  if (await waitDead(pid, o.quitWaitMs || 3000)) return 'quit';
  if (child) {
    if (!childGone()) { try { child.kill('SIGKILL'); } catch (e) { /* ended meanwhile */ } }
    if (await waitDead(pid, 5000)) return 'killed';
    return platform.pidAlive(pid) && !childGone() ? 'failed' : 'killed';
  }
  let pids = await platform.listQemuPids();
  if (pids === null) pids = await platform.listQemuPids();
  if (pids && pids.has(pid)) {
    platform.killPid(pid);
    if (await waitDead(pid, 5000)) return 'killed';
  }
  return platform.pidAlive(pid) ? 'failed' : 'killed';
}

// ------------------------------------------------------------------ watching
// Markers are guest output: only this strict shape counts (spec section 15).
const MARKER_RE = /^(?:.*?)__DEVBOX_([A-Z_]{1,32})(?:=(\S{0,300}))?(?:\s+uptime=([\d.]{1,20}))?/;

// Follow a run by its files: markers from console.log, output from
// stdout.log/stderr.log (only when asked), liveness from isAlive() (default
// platform.pidAlive of rt.pid; the supervisor passes its shared
// listQemuPids check). Works for a run started by an earlier manager
// process: fromStart re-reads console.log from byte 0 (it holds only kernel
// messages and markers, which is small).
// o: {onMarker(name, value, ms), onConsole(line), onStdout(buf),
//     onStderr(buf), isAlive(), pollMs (250), t0}
// -> {events (EventEmitter: 'marker', 'exit'), marks, exited: Promise<{exitCode,
//     reason, clean, kernelPanic, markers}>, stop()}
function watch(rt, o) {
  o = o || {};
  const t0 = o.t0 || Date.parse(rt.startedAt) || Date.now();
  const ev = new EventEmitter();
  const marks = {};
  const markers = {};
  let exitCode = null, kernelPanic = false, stopped = false;
  let resolveExited;
  const exited = new Promise((r) => { resolveExited = r; });
  const lines = new LineSplitter((line) => {
    if (o.onConsole) { try { o.onConsole(line); } catch (e) { /* consumer error */ } }
    if (/Kernel panic - not syncing/.test(line)) kernelPanic = true;
    const m = MARKER_RE.exec(line);
    if (!m) return;
    const t = Date.now() - t0;
    if (!(m[1] in marks)) marks[m[1]] = t;
    markers[m[1]] = m[2] === undefined ? true : m[2];
    if (m[1] === 'EXIT' && /^\d{1,3}$/.test(m[2] || '')) exitCode = parseInt(m[2], 10);
    if (o.onMarker) { try { o.onMarker(m[1], m[2], t); } catch (e) { /* consumer error */ } }
    ev.emit('marker', m[1], m[2], t);
  }, { maxLine: 4096 });
  const tails = [new FileTail(rt.logs.console, (b) => lines.push(b), { intervalMs: o.pollMs || 250 })];
  if (o.onStdout) tails.push(new FileTail(rt.logs.stdout, o.onStdout, { intervalMs: o.pollMs || 250 }));
  if (o.onStderr) tails.push(new FileTail(rt.logs.stderr, o.onStderr, { intervalMs: o.pollMs || 250 }));
  for (const t of tails) t.start();
  let timer = null;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const t of tails) t.stop();
    lines.flush();
    const q = qemuLogErrors(readText(rt.logs.qemu));
    let code = exitCode, reason = null;
    if (code === null) {
      code = 125;
      reason = kernelPanic ? 'guest kernel panic' : 'the VM ended without an exit status' + (q.message ? ': ' + q.message : '');
    }
    const res = { exitCode: code, reason, clean: exitCode !== null, kernelPanic, markers: Object.assign({}, markers), qemu: q };
    ev.emit('exit', res);
    resolveExited(res);
  };
  const isAlive = o.isAlive || (() => platform.pidAlive(rt.pid));
  const poll = async () => {
    if (stopped) return;
    let alive = true;
    try { alive = await isAlive(); } catch (e) { alive = true; /* cannot tell: keep watching */ }
    if (alive === false) { setTimeout(finish, 50); return; }
    timer = setTimeout(poll, o.pollMs || 250);
  };
  poll();
  return {
    events: ev, marks, markers, exited,
    // stop following (the VM keeps running)
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      for (const t of tails) t.stop();
    },
  };
}

// Markers of a run from its console.log - its first and last 64 KB only:
// the file is guest-controlled and can be huge (sec-4).
function readExit(runDir) {
  return plan.parseConsole(readHeadTail(path.join(runDir, 'console.log'), 65536));
}

module.exports = {
  EngineError, prepareImage, prepareRootByDigest, cachedImageByConfig, hostFacts, controlEndpoints, rotateLogs, launch, qemuLogErrors,
  sendConsole, requestStop, forceStop, watch, readExit, urlsFor, imageBaseName, requireKernel,
  qemuName, readHeadTail, MARKER_RE,
};
