'use strict';
/*
 * Appliance VMs: boot ANY operating-system image - a .img / .img.gz / .qcow2
 * disk image or a .iso installer - with a screen (lib/screen.js) instead of
 * SSH. Made for media boxes, router firmware, rescue systems and the like:
 * the first one was LibreELEC (Kodi) tried out before it went on a mini PC.
 *
 * Create (validateCreate -> opCreate, a task holding vm:<name>):
 *   1. The source is a file on this PC or an https:// URL. A URL is
 *      downloaded once into <root>/appliances/downloads/<file name> with
 *      lib/download.js (progress in the task log; a .part never becomes the
 *      file) and REUSED by later creates. sha256 (optional) is checked on the
 *      finished file, downloaded or local, and a mismatch stops the create.
 *   2. .gz is unpacked with Node's zlib into a temporary file beside the
 *      disk; the format of the unpacked file is read from its first bytes
 *      (QFI\xfb = qcow2; "CD001" at 0x8001 = ISO 9660; anything else = raw).
 *   3. A disk image becomes sandboxes/<name>.qcow2 (qemu-img convert, so
 *      snapshots, reset and compact work like for every other VM) and is
 *      grown to disk_gb (the image's own size when that is bigger; LibreELEC
 *      expands its storage partition into the free space at first boot). An
 *      ISO stays as sandboxes/<name>-media.iso next to an EMPTY disk_gb disk:
 *      the OS is installed from it on screen; a later "eject" removes the ISO.
 *   4. UEFI firmware: the edk2 files that ship inside the QEMU package
 *      (share/edk2-x86_64-code.fd, read-only, and a private copy of
 *      edk2-i386-vars.fd per VM: sandboxes/<name>-vars.fd), the same firmware
 *      a mini PC boots with. 'bios' uses SeaBIOS (QEMU's default).
 *
 * The record is an ordinary VM record (state.newVmRecord) with kind
 * 'appliance' and the appliance block; vm.js starts, stops, deletes, resets
 * and snapshots it with the same code paths, branching on the kind where an
 * SSH guest and a screen guest differ (qemuArgs, the boot wait, stop).
 *
 * Exports: validateCreate(body), opCreate(t, a), qemuArgs(vm, o) (the extra
 * QEMU arguments for the kind), firmwareFiles(), detectFormat(buffer),
 * validateEject/opEject, SOURCE_RE, describe(vm).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { CFG } = require('./config');
const platform = require('./platform');
const st = require('./state');
const { state } = st;
const tasks = require('./tasks');
const ports = require('./ports');
const download = require('./download');
const {
  exists, sizeOf, fmtBytes, run, badRequest, notFound, conflict, vmNameError, toBool, intInRange,
} = require('./util');

const GB = 1024 * 1024 * 1024;
const DEFAULT_DISK_GB = 8;
const DEFAULT_MEM = 1024;
// what a source may be: a local path, or https:// (the download module refuses http://)
const SOURCE_RE = /^(https:\/\/\S+|[A-Za-z]:[\\/].+|\/.+|\\\\.+)$/;

function requireVmName(name, label) {
  const why = vmNameError(name);
  if (why) throw badRequest('bad ' + (label || 'VM') + ' name: ' + why);
  return name;
}

function lastLine(r) {
  const lines = String((r && (r.stderr || r.stdout)) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : 'no output';
}

// ---------------------------------------------------------------------------
// firmware
// ---------------------------------------------------------------------------
// The edk2 (OVMF) files inside the QEMU package: {code, vars} or null when
// this QEMU has none (then only 'bios' can boot).
function firmwareFiles() {
  const qemu = platform.findTool('qemu');
  if (!qemu) return null;
  const share = path.join(path.dirname(qemu), 'share');
  const code = path.join(share, 'edk2-x86_64-code.fd');
  const vars = path.join(share, 'edk2-i386-vars.fd');
  if (!exists(code) || !exists(vars)) return null;
  return { code: code, vars: vars };
}

// ---------------------------------------------------------------------------
// image format (pure)
// ---------------------------------------------------------------------------
// From the first 64 KB of an (unpacked) image: 'qcow2' | 'iso' | 'raw'.
function detectFormat(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'QFI\xfb') return 'qcow2';
  // ISO 9660: a primary volume descriptor at sector 16 (0x8000) + 1
  if (buf.length >= 0x8006 && buf.toString('latin1', 0x8001, 0x8006) === 'CD001') return 'iso';
  // a UDF-only disc without the ISO bridge: "BEA01" / "NSR0x" descriptors
  if (buf.length >= 0x8006 && /^(BEA01|NSR0[23])$/.test(buf.toString('latin1', 0x8001, 0x8006))) return 'iso';
  return 'raw';
}

function isGz(file) { return /\.gz$/i.test(file); }
function baseName(source) {
  try { return path.basename(new URL(source).pathname) || 'image'; } catch (e) { return path.basename(source); }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
async function validateCreate(body) {
  body = body || {};
  const name = requireVmName(body.name);
  if (state.vms[name] || exists(st.diskPath(name))) throw conflict('a VM called "' + name + '" already exists', 'EXISTS');
  tasks.assertFree('vm:' + name);
  const source = String(body.source || '').trim();
  if (!source || !SOURCE_RE.test(source)) throw badRequest('source must be a file on this PC (a .img, .img.gz, .qcow2 or .iso) or an https:// URL of one');
  if (!/^https:\/\//i.test(source) && !exists(source)) throw notFound('no such file: ' + source);
  if (/^http:\/\//i.test(source)) throw badRequest('only https:// downloads are accepted');
  const firmware = body.firmware === undefined || body.firmware === null || body.firmware === '' ? 'uefi' : String(body.firmware);
  if (st.FIRMWARES.indexOf(firmware) === -1) throw badRequest('firmware must be "uefi" or "bios"');
  const bus = body.bus === undefined || body.bus === null || body.bus === '' ? 'virtio' : String(body.bus);
  if (st.BUSES.indexOf(bus) === -1) throw badRequest('bus must be "virtio" (modern Linux) or "sata" (anything else)');
  const vga = body.vga === undefined || body.vga === null || body.vga === '' ? 'virtio' : String(body.vga);
  if (st.VGAS.indexOf(vga) === -1) throw badRequest('vga must be "virtio" (virtio-vga, for Linux) or "std" (plain VGA)');
  const sha = body.sha256 === undefined || body.sha256 === null || body.sha256 === '' ? null : String(body.sha256).trim().toLowerCase();
  if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) throw badRequest('sha256 must be 64 hex characters');
  // the input is checked before the PC's state (bad input is a 400, a missing tool a 409)
  if (!platform.findTool('qemu-img')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  if (firmware === 'uefi' && platform.findTool('qemu') && !firmwareFiles()) {
    throw conflict('this QEMU ships no UEFI firmware (edk2-x86_64-code.fd) - choose firmware "bios"', 'NO_UEFI');
  }
  const mem = intInRange(body.mem, CFG.minMem, CFG.maxMem, Math.min(DEFAULT_MEM, CFG.maxMem), 'Memory (MB)');
  const cpus = intInRange(body.cpus, 1, CFG.maxCpus, Math.min(2, CFG.maxCpus), 'vCPUs');
  const diskGB = intInRange(body.diskGB, CFG.minDiskGB, CFG.maxDiskGB, DEFAULT_DISK_GB, 'Disk (GB)');
  const accel = body.accel === undefined || body.accel === null || body.accel === '' ? 'auto' : body.accel;
  if (st.ACCELS.indexOf(accel) === -1) throw badRequest('accel must be one of ' + st.ACCELS.join(', '));
  const mappings = ports.parsePortSpec(body.ports === undefined ? [] : body.ports, {});
  const start = toBool(body.start, false);
  if (start) tasks.assertFree('qemu');
  const a = {
    name: name, source: source, sha256: sha, firmware: firmware, bus: bus, vga: vga, sound: toBool(body.sound, true),
    mem: mem, cpus: cpus, diskGB: diskGB, accel: accel, ports: mappings, start: start,
    waitS: intInRange(body.waitS, 0, 1800, null, 'waitS'),
    ephemeral: toBool(body.ephemeral, false), autostart: toBool(body.autostart, false),
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
    createdBy: typeof body.createdBy === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(body.createdBy) ? body.createdBy : 'api',
  };
  await ports.validateMappings(name, mappings, { claim: mappings.map((m) => m.host), claimMs: 300000 });
  a.claimed = mappings.map((m) => m.host);
  return a;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// The source as a local file: downloaded (once) when it is a URL.
async function obtainSource(t, source) {
  if (!/^https:\/\//i.test(source)) return source;
  fs.mkdirSync(CFG.appliancesDownloadsDir, { recursive: true });
  const dest = path.join(CFG.appliancesDownloadsDir, baseName(source).replace(/[^A-Za-z0-9._-]/g, '_'));
  if (exists(dest) && sizeOf(dest) > 0) {
    t.log('Using the copy downloaded earlier: ' + dest + ' (' + fmtBytes(sizeOf(dest)) + ')');
    return dest;
  }
  t.step('Downloading ' + baseName(source) + '...');
  await download.download(source, dest, { t: t, label: baseName(source) });
  t.log('Downloaded ' + fmtBytes(sizeOf(dest)) + ' to ' + dest);
  return dest;
}

async function readHead(file, bytes) {
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const r = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, r.bytesRead);
  } finally { await fd.close(); }
}

async function gunzipTo(t, src, dest) {
  t.step('Unpacking ' + path.basename(src) + '...');
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
  t.log('Unpacked: ' + fmtBytes(sizeOf(dest)));
}

async function qemuImg(args) {
  const qi = platform.findTool('qemu-img');
  if (!qi) throw new Error('qemu-img was not found - ' + platform.installHints().qemu);
  const r = await run(qi, args);
  if (r.code !== 0) throw new Error('qemu-img ' + args[0] + ' failed: ' + lastLine(r));
  return r;
}

async function opCreate(t, a) {
  if (state.vms[a.name] || exists(st.diskPath(a.name))) throw new Error('a VM called "' + a.name + '" already exists');
  fs.mkdirSync(CFG.sandboxDir, { recursive: true });
  const held = (a.ports || []).map((m) => m.host);
  for (const p of held) ports.claim(p, 300000, a.name);
  const disk = st.diskPath(a.name);
  const tmp = disk + '.import.' + process.pid + '.tmp';
  let port = null;
  const made = [];
  try {
    const file = await obtainSource(t, a.source);
    if (a.sha256) {
      t.step('Checking the sha256 of ' + path.basename(file) + '...');
      const got = await sha256File(file);
      if (got !== a.sha256) throw new Error('sha256 mismatch for ' + path.basename(file) + ': expected ' + a.sha256 + ', got ' + got + ' - the file is not what you expected; delete it and try again');
      t.log('sha256 ok');
    }
    let image = file;
    if (isGz(file)) { await gunzipTo(t, file, tmp); made.push(tmp); image = tmp; }
    const format = detectFormat(await readHead(image, 0x10000));
    const media = format === 'iso' ? 'iso' : 'disk';
    const sizeBytes = a.diskGB * GB;
    if (media === 'iso') {
      t.step('Keeping the ISO as a CD-ROM and making an empty ' + a.diskGB + ' GB disk...');
      await fs.promises.copyFile(image, st.mediaPath(a.name));
      made.push(st.mediaPath(a.name));
      await qemuImg(['create', '-f', 'qcow2', disk, String(sizeBytes)]);
      made.push(disk);
    } else {
      t.step('Converting the ' + format + ' image (' + fmtBytes(sizeOf(image)) + ') to the VM disk...');
      await qemuImg(['convert', '-f', format, '-O', 'qcow2', image, disk]);
      made.push(disk);
      const info = JSON.parse((await qemuImg(['info', '--output=json', disk])).stdout);
      const virt = info['virtual-size'] || 0;
      if (virt < sizeBytes) {
        await qemuImg(['resize', '-f', 'qcow2', disk, String(sizeBytes)]);
        t.log('Disk grown from ' + fmtBytes(virt) + ' to ' + a.diskGB + ' GB (the guest can expand into it)');
      } else t.log('The image is ' + fmtBytes(virt) + ', bigger than ' + a.diskGB + ' GB: kept as is');
    }
    if (a.firmware === 'uefi') {
      const fw = firmwareFiles();
      if (!fw) throw new Error('this QEMU ships no UEFI firmware - create the VM with firmware "bios"');
      await fs.promises.copyFile(fw.vars, st.varsPath(a.name));
      made.push(st.varsPath(a.name));
    }
    // an SSH port number keeps the MAC unique and the record uniform; it is
    // never forwarded for an appliance (vm.netdevFor)
    port = await ports.allocSshPort();
    state.vms[a.name] = st.newVmRecord({
      kind: 'appliance',
      appliance: { firmware: a.firmware, bus: a.bus, vga: a.vga, sound: a.sound, source: a.source, sourceSha256: a.sha256, media: media },
      port: port, mem: a.mem, cpus: a.cpus, accel: a.accel, template: '', ports: a.ports,   // '': a standalone disk, no template
      ephemeral: a.ephemeral, autostart: a.autostart, note: a.note, createdBy: a.createdBy, personalized: true,
    });
    st.saveState();
    made.length = 0;
  } catch (e) {
    for (const f of made) { try { fs.rmSync(f, { force: true }); } catch (e2) {} }
    throw e;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    if (port) ports.release(port);
    for (const p of held) ports.release(p, a.name);
  }
  const vm = state.vms[a.name];
  t.log('Created the appliance VM "' + a.name + '": ' + a.firmware.toUpperCase() + ', ' + a.mem + ' MB, ' + a.cpus + ' vCPU, ' +
    fmtBytes(sizeOf(disk)) + ' on disk' + (vm.appliance.media === 'iso' ? ' + the ISO as CD-ROM' : '') +
    (a.ports.length ? '; forwards ' + a.ports.map(ports.describe).join(', ') : ''));
  const result = { name: a.name, kind: 'appliance', firmware: a.firmware, media: vm.appliance.media };
  if (a.start) {
    const vmMod = require('./vm');   // lazy: vm.js requires this module
    Object.assign(result, await vmMod.opStart(t, { name: a.name, waitS: a.waitS }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// eject the installer ISO (after the OS was installed on the disk)
// ---------------------------------------------------------------------------
async function validateEject(body) {
  body = body || {};
  const name = requireVmName(body.name);
  const vm = st.getVm(name);
  if (vm.kind !== 'appliance') throw badRequest('"' + name + '" is not an appliance VM');
  if (!vm.appliance || vm.appliance.media !== 'iso') throw conflict('"' + name + '" has no CD-ROM attached', 'NO_MEDIA');
  return { name: name };
}
async function opEject(t, a) {
  const vm = st.getVm(a.name);
  const vmMod = require('./vm');
  if (vm.runtime && (await vmMod.isRunning(a.name))) throw new Error('stop "' + a.name + '" first: the CD-ROM is removed for the next start');
  try { fs.rmSync(st.mediaPath(a.name), { force: true }); } catch (e) {}
  vm.appliance.media = 'disk';
  st.saveState();
  t.log('CD-ROM removed from "' + a.name + '": it boots from its disk from now on');
  return { name: a.name, media: 'disk' };
}

// ---------------------------------------------------------------------------
// QEMU arguments for the kind (pure given the files)
// ---------------------------------------------------------------------------
// o: {disk, display: {host, port}, sound: bool (host audio backend)}
// Returns {drives: [...], extra: [...]}: the drive arguments replace vm.js's
// virtio qcow2 drive; extra goes at the end.
function qemuArgs(vm, o) {
  const ap = vm.appliance || st.cleanAppliance({});
  const qv = (s) => String(s).replace(/,/g, ',,');
  const drives = [];
  if (ap.bus === 'sata') {
    drives.push('-device', 'ich9-ahci,id=ahci');
    drives.push('-drive', 'file=' + qv(o.disk) + ',if=none,id=hd0,format=qcow2,discard=unmap,detect-zeroes=unmap', '-device', 'ide-hd,drive=hd0,bus=ahci.0,bootindex=1');
    if (ap.media === 'iso' && o.media) drives.push('-drive', 'file=' + qv(o.media) + ',if=none,id=cd0,media=cdrom,format=raw,readonly=on', '-device', 'ide-cd,drive=cd0,bus=ahci.1,bootindex=0');
  } else {
    drives.push('-drive', 'file=' + qv(o.disk) + ',if=none,id=hd0,format=qcow2,discard=unmap,detect-zeroes=unmap', '-device', 'virtio-blk-pci,drive=hd0,bootindex=1');
    if (ap.media === 'iso' && o.media) {
      drives.push('-device', 'ich9-ahci,id=ahci');
      drives.push('-drive', 'file=' + qv(o.media) + ',if=none,id=cd0,media=cdrom,format=raw,readonly=on', '-device', 'ide-cd,drive=cd0,bus=ahci.0,bootindex=0');
    }
  }
  const extra = [];
  if (ap.firmware === 'uefi' && o.firmware) {
    extra.push('-drive', 'if=pflash,format=raw,readonly=on,file=' + qv(o.firmware.code));
    extra.push('-drive', 'if=pflash,format=raw,file=' + qv(o.vars));
  }
  // the screen: plain VNC on the private endpoint (never a public port; the
  // manager relays it to the browser), a standard VGA, an absolute-position
  // USB tablet so the mouse pointer matches the browser's, and a keyboard
  extra.push('-vnc', o.display.host + ':' + (o.display.port - 5900) + ',lossy=on');
  // virtio-vga: a plain VGA for the firmware and the boot loader, virtio-gpu
  // once the OS driver loads (LibreELEC, every current Linux); std: QEMU's
  // VGA alone, for an OS without a virtio-gpu driver
  extra.push('-device', ap.vga === 'std' ? 'VGA,vgamem_mb=32' : 'virtio-vga');
  extra.push('-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,bus=xhci.0', '-device', 'usb-kbd,bus=xhci.0');
  if (ap.sound && o.sound) {
    extra.push('-audiodev', o.sound + ',id=snd0', '-device', 'intel-hda', '-device', 'hda-output,audiodev=snd0');
  }
  extra.push('-rtc', 'base=localtime');
  return { drives: drives, extra: extra };
}

// The host audio backend QEMU should play through, per platform.
function hostAudioBackend() {
  if (platform.IS_WIN) return 'dsound';
  if (process.platform === 'darwin') return 'coreaudio';
  return 'pa';
}

// Public fields of the appliance block for /api/state (never a secret)
function describe(vm) {
  if (vm.kind !== 'appliance') return null;
  const ap = vm.appliance || st.cleanAppliance({});
  return { firmware: ap.firmware, bus: ap.bus, vga: ap.vga, sound: ap.sound, media: ap.media, source: ap.source, sourceName: baseName(ap.source || '') };
}

module.exports = {
  validateCreate, opCreate, validateEject, opEject, qemuArgs, firmwareFiles, detectFormat, hostAudioBackend, describe,
  SOURCE_RE, DEFAULT_DISK_GB, baseName,
};
