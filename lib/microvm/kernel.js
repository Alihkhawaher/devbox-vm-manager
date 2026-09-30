'use strict';
/*
 * The microVM kernel: prepare its assets from two verified Alpine packages,
 * report whether they are installed (the "microVM kernel" prerequisite), and
 * install them as a task step (ensureKernel - spec section 5).
 *
 *   linux-virt-<ver>.apk      -> vmlinuz-virt, config-virt, selected modules
 *   busybox-static-<ver>.apk  -> busybox.static
 *
 * Layout (CFG.kernelDir, <root>/kernel/):
 *   linux-virt-<ver>.apk, busybox-static-<ver>.apk   the verified packages
 *   <kver>/                e.g. 6.18.54-0-virt - appears only through an
 *                          atomic rename of a finished <kver>.tmp-<rand>
 *     vmlinuz-virt         bzImage, booted with QEMU -kernel
 *     config-virt          the kernel .config (for diagnostics)
 *     busybox.static       statically linked busybox (init + tools in guest)
 *     modules/<name>.ko    decompressed modules (.ko.gz -> .ko)
 *     manifest.json        {kver, modules: {name: {file, deps: [names]}},
 *                          features: {feature: [names in load order]},
 *                          sha256: {file: hex}, sources: {...}}
 *   host.json              host facts (plan.hostDefaults)
 *
 * FEATURES maps a runtime need to the module names it requires; the
 * dependency closure and load order come from modules.dep. A manifest made
 * before a feature existed (e.g. "ninep", the shared-folder modules) still
 * boots images: kernelStatus() reports it as usable but `needsUpdate`, and
 * ensureKernel() re-prepares it from the cached packages (no download).
 *
 * ensureKernel(t, opts) - idempotent, serialised by a module-level promise
 * (a setup and a direct /api/install/kernel may overlap):
 *   1. an installed kernel that verifies and has every feature: done;
 *   2. else the cached packages in <root>/kernel when both verify by their
 *      own Alpine signature (bundled keys) and datahash chain: prepared
 *      offline - no network at all;
 *   3. else (or opts.update) the signed APKINDEX of the pinned branch is
 *      fetched and verified (apk.js), the current linux-virt and
 *      busybox-static entries are chosen (never pinned versions: Alpine
 *      removes superseded revisions from its mirrors), each package is
 *      downloaded through lib/download.js and verified against the index;
 *   4. prepareKernelAssets into <kver>.tmp-<rand>, checked (built-in
 *      drivers, module closure), then swapped in by renames;
 *   5. host facts (plan.hostDefaults: CPU model probe, one TSC calibration
 *      boot under WHPX) unless opts.skipHostFacts.
 *
 * Exports: FEATURES, BUILTIN_EXPECTED, ALPINE_BRANCH, prepareKernelAssets(opts),
 *   loadManifest(dir), modulesFor(manifest, features), extractVmlinux,
 *   hasPvhNote, findKernelDir(root?), kernelStatus(opts?), missingFeatures(m),
 *   findCachedApks(root?), ensureKernel(t, opts), repoUrl(opts?),
 *   invalidateStatus().
 * PVH (QEMU -kernel vmlinux) boots on q35 under WHPX (~0.27 s faster to
 * init) but fails on microvm under WHPX ("Unexpected VP exit code 4"), so
 * the engine boots the bzImage.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { CFG } = require('../config');
const apk = require('./apk');
const kmod = require('./kmod');

// Needs -> modules (names as in modules.dep, dashes or underscores).
const FEATURES = {
  net: ['virtio_net', 'af_packet'],
  blk: ['virtio_blk'],
  ext4: ['ext4'],
  overlay: ['overlay'],
  vsock: ['vmw_vsock_virtio_transport'],
  rng: ['virtio_rng'],
  acpibutton: ['button', 'evdev'],
  fwcfg: ['qemu_fw_cfg'],
  balloon: ['virtio_balloon'],
  // live shared folders: the 9P2000.L client over TCP (lib/ninep, lib/shares.js);
  // modules.dep pulls in netfs and 9pnet
  ninep: ['9pnet_fd', '9p'],
};

// Drivers the engine relies on being built in (=y) in config-virt; checked
// by prepareKernelAssets so a future kernel bump fails loudly.
const BUILTIN_EXPECTED = ['VIRTIO_PCI', 'VIRTIO_MMIO', 'VIRTIO_CONSOLE', 'SERIAL_8250',
  'SERIAL_8250_CONSOLE', 'DEVTMPFS', 'TMPFS', 'BLK_DEV_INITRD', 'RD_GZIP', 'UNIX', 'INET', 'CGROUPS', 'BINFMT_SCRIPT'];

// The Alpine branch the kernel comes from: a constant bumped with app
// releases, never "latest-stable" (a new branch may change the kernel config).
const ALPINE_BRANCH = 'v3.23';
const DEFAULT_MIRROR = 'https://dl-cdn.alpinelinux.org/alpine/';
const PACKAGES = { kernel: 'linux-virt', busybox: 'busybox-static' };

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function writeIfChanged(file, buf) {
  try { if (fs.readFileSync(file).equals(buf)) return false; } catch (e) { /* missing */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.part';
  fs.writeFileSync(part, buf);
  fs.renameSync(part, file);
  return true;
}

// opts: {kernelApk, busyboxApk, outRoot (writes outRoot/<kver>) | outDir
// (writes exactly there), kernelEntry?, busyboxEntry? (APKINDEX records, to
// verify again), features?: names (default all FEATURES), keys?}
// -> {dir, kver, manifest}
function prepareKernelAssets(opts) {
  const kbuf = fs.readFileSync(opts.kernelApk);
  const bbuf = fs.readFileSync(opts.busyboxApk);
  const kv = apk.verifyApk(kbuf, opts.kernelEntry, { keys: opts.keys });
  const bv = apk.verifyApk(bbuf, opts.busyboxEntry, { keys: opts.keys });
  const kfiles = kv.apk.data();
  const byName = new Map(kfiles.map((e) => [e.name, e]));

  const modDir = kfiles.find((e) => e.type === 'dir' && /^lib\/modules\/[^/]+$/.test(e.name));
  if (!modDir) throw new Error('no lib/modules/<kver> in ' + opts.kernelApk);
  const kver = modDir.name.split('/')[2];
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(kver)) throw new Error('unexpected kernel version name ' + JSON.stringify(kver));
  const cfgE = byName.get('boot/config-' + kver);
  const vmlE = byName.get('boot/vmlinuz-virt') || byName.get('lib/modules/' + kver + '/vmlinuz');
  if (!cfgE || !vmlE) throw new Error('kernel image or config missing in package');
  const cfg = kmod.parseKconfig(cfgE.data.toString('utf8'));
  const notBuiltin = BUILTIN_EXPECTED.filter((s) => kmod.kconfigState(cfg, s) !== 'y');
  if (notBuiltin.length) throw new Error('kernel lacks built-in ' + notBuiltin.join(', '));

  const dep = kmod.parseModulesDep(byName.get('lib/modules/' + kver + '/modules.dep').data.toString('utf8'));
  const builtin = kmod.parseModulesBuiltin(byName.get('lib/modules/' + kver + '/modules.builtin').data.toString('utf8'));

  const outDir = opts.outDir || path.join(opts.outRoot, kver);
  const shas = {};
  const put = (rel, buf) => { writeIfChanged(path.join(outDir, rel), buf); shas[rel] = sha256(buf); };
  put('vmlinuz-virt', vmlE.data);
  put('config-virt', cfgE.data);

  const bbE = bv.apk.data().find((e) => e.name === 'bin/busybox.static');
  if (!bbE) throw new Error('bin/busybox.static missing in ' + opts.busyboxApk);
  put('busybox.static', bbE.data);

  const featureNames = opts.features || Object.keys(FEATURES);
  const modules = {};
  const features = {};
  for (const f of featureNames) {
    const r = kmod.resolveModules(FEATURES[f], dep, builtin);
    if (r.missing.length) throw new Error('feature ' + f + ': modules not found: ' + r.missing.join(', '));
    features[f] = r.order.map(kmod.moduleNameOf);
    for (const rel of r.order) {
      const name = kmod.moduleNameOf(rel);
      if (modules[name]) continue;
      const e = byName.get('lib/modules/' + kver + '/' + rel);
      if (!e) throw new Error('module file missing: ' + rel);
      const m = kmod.decompressModule(rel, e.data);
      put('modules/' + name + '.ko', m.data);
      modules[name] = { file: 'modules/' + name + '.ko', src: rel, deps: (dep.get(rel) || []).map(kmod.moduleNameOf), size: m.data.length };
    }
  }
  const manifest = {
    kver,
    createdAt: new Date().toISOString(),
    sources: {
      kernel: { file: path.basename(opts.kernelApk), pkgver: kv.pkginfo.pkgver, controlSha1: kv.controlSha1, dataSha256: kv.dataSha256, signedBy: kv.signature && kv.signature.keyName },
      busybox: { file: path.basename(opts.busyboxApk), pkgver: bv.pkginfo.pkgver, controlSha1: bv.controlSha1, dataSha256: bv.dataSha256, signedBy: bv.signature && bv.signature.keyName },
    },
    builtin: BUILTIN_EXPECTED,
    features,
    modules,
    sha256: shas,
  };
  writeIfChanged(path.join(outDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { dir: outDir, kver, manifest };
}

// The uncompressed ELF kernel (vmlinux) inside a bzImage, for PVH boot
// (QEMU -kernel <ELF with a PVH note> skips the real-mode setup code and the
// in-guest decompression). Only gzip payloads are supported (Node stdlib);
// others throw. Header fields: boot protocol >= 2.08 (payload_offset/length).
function extractVmlinux(bz) {
  if (bz.readUInt32LE(0x202) !== 0x53726448) throw new Error('not a bzImage (no HdrS)');
  if (bz.readUInt16LE(0x206) < 0x208) throw new Error('boot protocol too old for payload_offset');
  const setupSects = bz[0x1f1] || 4;
  const pm = (setupSects + 1) * 512;
  const off = bz.readUInt32LE(0x248), len = bz.readUInt32LE(0x24c);
  const payload = bz.subarray(pm + off, pm + off + len);
  if (payload[0] !== 0x1f || payload[1] !== 0x8b) {
    throw new Error('bzImage payload is not gzip (magic ' + payload.subarray(0, 4).toString('hex') + ')');
  }
  // payload_length includes the 4-byte decompressed-size trailer the
  // kernel's own decompressor wants; decode just the first gzip member
  const hl = apk.gzipHeaderLength(payload, 0);
  const elf = zlib.inflateRawSync(payload.subarray(hl));
  if (elf.readUInt32BE(0) !== 0x7f454c46) throw new Error('payload is not an ELF image');
  return elf;
}

// True when an ELF vmlinux carries the Xen PVH entry note (type 18,
// XEN_ELFNOTE_PHYS32_ENTRY) that QEMU needs to boot it directly.
function hasPvhNote(elf) {
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2) return false; // ELF64 only
  const phoff = Number(elf.readBigUInt64LE(0x20));
  const phentsize = elf.readUInt16LE(0x36), phnum = elf.readUInt16LE(0x38);
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (elf.readUInt32LE(ph) !== 4) continue; // PT_NOTE
    const off = Number(elf.readBigUInt64LE(ph + 8)), size = Number(elf.readBigUInt64LE(ph + 32));
    let p = off;
    while (p + 12 <= off + size) {
      const namesz = elf.readUInt32LE(p), descsz = elf.readUInt32LE(p + 4), type = elf.readUInt32LE(p + 8);
      const name = elf.toString('ascii', p + 12, p + 12 + namesz).replace(/\0+$/, '');
      if (name === 'Xen' && type === 18) return true;
      p += 12 + Math.ceil(namesz / 4) * 4 + Math.ceil(descsz / 4) * 4;
    }
  }
  return false;
}

function loadManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

// Load order (deps first, no duplicates) for a set of features.
function modulesFor(manifest, feats) {
  const out = [];
  for (const f of feats) {
    const list = manifest.features[f];
    if (!list) throw new Error('unknown kernel feature ' + f + ' (update the microVM kernel: Setup)');
    for (const n of list) if (!out.includes(n)) out.push(n);
  }
  return out;
}

function missingFeatures(manifest) {
  const have = (manifest && manifest.features) || {};
  return Object.keys(FEATURES).filter((f) => !have[f]);
}

// ---------------------------------------------------------------------------
// installed kernel
// ---------------------------------------------------------------------------
const numericParts = (s) => String(s).split(/[^0-9]+/).filter(Boolean).map(Number);
function cmpNumeric(a, b) {
  const x = numericParts(a), y = numericParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return String(a).localeCompare(String(b));
}

// The newest prepared kernel directory (one with a manifest.json) under
// root (default CFG.kernelDir), or null. Half-made (.tmp-*) and replaced
// (.old-*) directories are never picked.
function findKernelDir(root) {
  const r = root || CFG.kernelDir;
  let dirs = [];
  try {
    dirs = fs.readdirSync(r).filter((d) => /^[A-Za-z0-9._+-]+$/.test(d) && !/\.(tmp|old)-/.test(d) &&
      fs.existsSync(path.join(r, d, 'manifest.json')));
  } catch (e) { return null; }
  if (!dirs.length) return null;
  dirs.sort(cmpNumeric);
  return path.join(r, dirs[dirs.length - 1]);
}

const statusCache = new Map(); // dir -> {mtimeMs, result}
function invalidateStatus() { statusCache.clear(); }

// The prerequisite row's facts. Verifying the sha256 of vmlinuz-virt and
// busybox.static costs ~50 ms, so the answer is cached per manifest file
// (its mtime) - checked once per manager start, not on every poll.
//   -> {ok, installed, kver, dir, bytes, needsUpdate, missingFeatures, error}
function kernelStatus(opts) {
  opts = opts || {};
  const dir = findKernelDir(opts.root);
  if (!dir) return { ok: false, installed: false, kver: null, dir: null, bytes: 0, needsUpdate: false, missingFeatures: [], error: null };
  let mt = 0;
  try { mt = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs; } catch (e) { /* raced with a swap */ }
  const hit = statusCache.get(dir);
  if (hit && hit.mtimeMs === mt && !opts.fresh) return hit.result;
  let result;
  try {
    const m = loadManifest(dir);
    let bytes = 0;
    for (const f of ['vmlinuz-virt', 'busybox.static']) {
      const buf = fs.readFileSync(path.join(dir, f));
      bytes += buf.length;
      if (!m.sha256 || m.sha256[f] !== sha256(buf)) throw new Error(f + ' does not match its manifest');
    }
    for (const mod of Object.values(m.modules || {})) {
      try { bytes += fs.statSync(path.join(dir, mod.file)).size; } catch (e) { throw new Error('module file missing: ' + mod.file); }
    }
    const missing = missingFeatures(m);
    result = { ok: true, installed: true, kver: m.kver, dir, bytes, needsUpdate: missing.length > 0, missingFeatures: missing, error: null };
  } catch (e) {
    result = { ok: false, installed: true, kver: path.basename(dir), dir, bytes: 0, needsUpdate: true, missingFeatures: [], error: String(e.message || e) };
  }
  statusCache.set(dir, { mtimeMs: mt, result });
  return result;
}

// The newest cached linux-virt and busybox-static packages in root that
// verify on their own (Alpine signature + datahash): {kernel, busybox}, each
// {path, pkgver} or null.
function findCachedApks(root, keys) {
  const r = root || CFG.kernelDir;
  const out = { kernel: null, busybox: null };
  let names = [];
  try { names = fs.readdirSync(r).filter((f) => /\.apk$/.test(f)); } catch (e) { return out; }
  for (const [slot, pkg] of Object.entries(PACKAGES)) {
    const re = new RegExp('^' + pkg.replace(/[-]/g, '\\-') + '-(\\d[^/]*)\\.apk$');
    const cands = names.map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m)
      .sort((a, b) => apk.compareApkVersions(b.m[1], a.m[1]));
    for (const c of cands) {
      try {
        const v = apk.verifyApk(fs.readFileSync(path.join(r, c.f)), null, { keys });
        if (v.pkginfo.pkgname !== pkg) continue;
        out[slot] = { path: path.join(r, c.f), pkgver: v.pkginfo.pkgver };
        break;
      } catch (e) { /* damaged or unsigned: try an older one */ }
    }
  }
  return out;
}

function repoUrl(opts) {
  opts = opts || {};
  const mirror = opts.mirror || CFG.alpineMirror || DEFAULT_MIRROR;
  return mirror.replace(/\/+$/, '') + '/' + (opts.branch || ALPINE_BRANCH) + '/main/x86_64';
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* busy */ } }

// Replace root/<kver> by the finished tmp dir: the old one is renamed aside
// first (a directory cannot be renamed over another), then removed. Readers
// only ever see a complete directory.
function swapIn(root, tmp, kver) {
  const final = path.join(root, kver);
  let aside = null;
  if (fs.existsSync(final)) {
    aside = final + '.old-' + crypto.randomBytes(3).toString('hex');
    try { fs.renameSync(final, aside); }
    catch (e) {
      rmrf(tmp);
      throw new Error('the microVM kernel ' + kver + ' is in use and cannot be replaced (' + (e.code || e.message) + ') - stop the running containers and try again');
    }
  }
  try { fs.renameSync(tmp, final); }
  catch (e) {
    if (aside) { try { fs.renameSync(aside, final); } catch (x) { /* leave it: findKernelDir skips .old- */ } }
    rmrf(tmp);
    throw e;
  }
  if (aside) rmrf(aside);
  return final;
}

let ensuring = null;

// t: task context. opts: {update (check the index even when installed),
// mirror, branch, root (default CFG.kernelDir), keys, allowHttp (tests),
// skipHostFacts, hostFacts(t, {dir, manifest}) (override, tests)}
// -> {kver, dir, bytesDownloaded, verified, source, cpuModel, tscKhz, accel}
function ensureKernel(t, opts) {
  if (ensuring) return ensuring;
  ensuring = ensureKernelOnce(t, opts || {}).finally(() => { ensuring = null; });
  return ensuring;
}

async function ensureKernelOnce(t, opts) {
  const root = opts.root || CFG.kernelDir;
  fs.mkdirSync(root, { recursive: true });
  // leftovers of an interrupted install or swap
  try {
    for (const d of fs.readdirSync(root)) if (/\.(tmp|old)-[0-9a-f]+$/.test(d)) rmrf(path.join(root, d));
  } catch (e) { /* unreadable: the steps below report it */ }

  let status = kernelStatus({ root, fresh: true });
  let source = 'installed';
  let bytesDownloaded = 0;
  if (status.ok && !status.needsUpdate && !opts.update) {
    t.log('microVM kernel: ' + status.kver + ' is installed and verified.');
  } else {
    let kernelApk = null, busyboxApk = null, kernelEntry = null, busyboxEntry = null;
    if (!opts.update) {
      const cached = findCachedApks(root, opts.keys);
      if (cached.kernel && cached.busybox) {
        t.log('microVM kernel: using the verified packages already downloaded (' + cached.kernel.pkgver + ', busybox ' + cached.busybox.pkgver + ') - no download needed.');
        kernelApk = cached.kernel.path;
        busyboxApk = cached.busybox.path;
        source = 'cached';
      }
    }
    if (!kernelApk) {
      source = 'download';
      const repo = repoUrl(opts);
      t.step('microVM kernel: reading the Alpine package index');
      const idx = await apk.fetchApkIndex(repo, { dir: path.join(root, '.index'), t, keys: opts.keys, allowHttp: opts.allowHttp });
      t.log('Package index verified (signed with ' + idx.keyName + ').');
      kernelEntry = idx.index.get(PACKAGES.kernel);
      busyboxEntry = idx.index.get(PACKAGES.busybox);
      if (!kernelEntry || !busyboxEntry) throw new Error('the Alpine ' + (opts.branch || ALPINE_BRANCH) + ' index lists no ' + (!kernelEntry ? PACKAGES.kernel : PACKAGES.busybox));
      t.step('microVM kernel: downloading ' + apk.apkFileName(kernelEntry) + ' and ' + apk.apkFileName(busyboxEntry));
      const k = await apk.downloadApk(repo, kernelEntry, root, { t, keys: opts.keys, allowHttp: opts.allowHttp });
      const b = await apk.downloadApk(repo, busyboxEntry, root, { t, keys: opts.keys, allowHttp: opts.allowHttp });
      bytesDownloaded = (k.bytes || 0) + (b.bytes || 0);
      kernelApk = k.path;
      busyboxApk = b.path;
    }
    t.step('microVM kernel: unpacking the kernel, busybox and modules');
    const tmp = path.join(root, 'k.tmp-' + crypto.randomBytes(4).toString('hex'));
    let prep;
    try {
      prep = prepareKernelAssets({ kernelApk, busyboxApk, kernelEntry, busyboxEntry, outDir: tmp, keys: opts.keys });
    } catch (e) { rmrf(tmp); throw e; }
    swapIn(root, tmp, prep.kver);
    invalidateStatus();
    status = kernelStatus({ root, fresh: true });
    if (!status.ok) throw new Error('the prepared microVM kernel does not verify: ' + status.error);
    t.log('microVM kernel ' + status.kver + ' ready (' + Math.round(status.bytes / 1048576) + ' MB, ' + Object.keys(loadManifest(status.dir).modules).length + ' modules).');
  }
  const res = { kver: status.kver, dir: status.dir, bytesDownloaded, verified: true, source, cpuModel: null, tscKhz: null, accel: null };
  if (!opts.skipHostFacts) {
    t.step('microVM kernel: measuring this PC (one short test boot)');
    const facts = opts.hostFacts
      ? await opts.hostFacts(t, { dir: status.dir, manifest: loadManifest(status.dir) })
      : await require('./plan').hostDefaults({ kernelDir: status.dir, manifest: loadManifest(status.dir), t });
    if (facts) { res.cpuModel = facts.cpuModel || null; res.tscKhz = facts.tscKhz || null; res.accel = facts.accel || null; }
  }
  return res;
}

module.exports = {
  FEATURES, BUILTIN_EXPECTED, ALPINE_BRANCH, DEFAULT_MIRROR, PACKAGES,
  prepareKernelAssets, loadManifest, modulesFor, missingFeatures, extractVmlinux, hasPvhNote,
  findKernelDir, kernelStatus, invalidateStatus, findCachedApks, repoUrl, ensureKernel,
};
