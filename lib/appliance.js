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
 *      ISO stays as sandboxes/install-media/<name>.iso next to an EMPTY
 *      disk_gb disk, and with `install` a disk image stays as
 *      sandboxes/install-media/<name>.qcow2 (a second, bootable disk - the USB
 *      stick): the OS is installed from it on screen; a later "eject" removes
 *      it. (Not in sandboxes/ itself: every *.qcow2 there is adopted as a VM.)
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
 * Where the screen goes (appliance.display):
 *   browser - QEMU's VNC server on the private display endpoint, relayed to
 *             the GUI's Screen tab (lib/screen.js). Plain 2D graphics.
 *   window  - a QEMU window on the PC that runs the manager, "full speed":
 *             with the 3D GPU (virtio-vga-gl, virgl) when this QEMU has it,
 *             so OpenGL programs such as Kodi run on the host's graphics card.
 *             3D cannot reach the browser on Windows: QEMU's only way to hand
 *             GL frames to VNC is its egl-headless display, which makes its
 *             copy texture as RGBA filled with BGRA data - legal in desktop
 *             OpenGL, refused by OpenGL ES, which is what QEMU uses on Windows
 *             (ANGLE) - so every frame arrives black (seen 2026-10-10 with QEMU
 *             11.1: Kodi drew correctly inside the guest and in a GTK window,
 *             VNC stayed black under the D3D11 and D3D9 back-ends). And QEMU
 *             refuses VNC next to a GL window ("Display vnc is incompatible
 *             with the GL context"). windowDisplay() picks the window per
 *             platform from what the QEMU build offers (qemuCaps).
 * The guest's SSH port is forwarded like for every VM (vm.port -> 22): the
 * guest's own SSH server, its own accounts (appliance.sshUser, a password
 * typed in the GUI - lib/sessions.js, lib/ssh.js guestArgs).
 *
 * Exports: validateCreate(body), opCreate(t, a), qemuArgs(vm, o) (the extra
 * QEMU arguments for the kind), firmwareFiles(), detectFormat(buffer),
 * validateEject/opEject, SOURCE_RE, describe(vm), windowDisplay(caps,
 * platform, env), parseCaps(deviceHelp, displayHelp), qemuCaps(),
 * windowSetting().
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
  const display = body.display === undefined || body.display === null || body.display === '' ? 'browser' : String(body.display);
  if (st.DISPLAYS.indexOf(display) === -1) throw badRequest('display must be "browser" (the Screen tab) or "window" (a window on this PC, with 3D graphics)');
  const sshUser = body.sshUser === undefined || body.sshUser === null || body.sshUser === '' ? 'root' : String(body.sshUser);
  if (!st.SSH_USER_RE.test(sshUser)) throw badRequest('sshUser must be a plain user name (letters, digits, "_", "-", ".")');
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
    display: display, sshUser: sshUser,
    // install: keep a disk image as installation media (a second, bootable
    // disk - the USB stick) and give the VM an EMPTY disk to install onto
    install: toBool(body.install, false),
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

// Remove a file this create made. On Windows an antivirus scan can hold a
// fresh file for a moment, and a plain rmSync that fails silently left a
// 1.1 GB unpacked image behind (found 2026-10-10): retried for ~5 s
// (vm.retryFs), then left with a warning that names it.
async function removeFile(t, file) {
  if (!exists(file)) return;
  try { await require('./vm').retryFs('removing ' + path.basename(file), () => fs.rmSync(file, { force: true })); }
  catch (e) { t.warn(e.message + ' - delete it by hand: ' + file); }
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
    const media = format === 'iso' ? 'iso' : (a.install ? 'image' : 'disk');
    const sizeBytes = a.diskGB * GB;
    if (media !== 'disk') fs.mkdirSync(st.mediaDir(), { recursive: true });
    if (media === 'iso') {
      t.step('Keeping the ISO as a CD-ROM and making an empty ' + a.diskGB + ' GB disk...');
      await fs.promises.copyFile(image, st.mediaPath(a.name));
      made.push(st.mediaPath(a.name));
      await qemuImg(['create', '-f', 'qcow2', disk, String(sizeBytes)]);
      made.push(disk);
    } else if (media === 'image') {
      t.step('Keeping the image as installation media (a second disk) and making an empty ' + a.diskGB + ' GB disk...');
      await qemuImg(['convert', '-f', format, '-O', 'qcow2', image, st.mediaDiskPath(a.name)]);
      made.push(st.mediaDiskPath(a.name));
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
    // the SSH port: forwarded to the guest's port 22 (its own SSH server, if
    // it runs one), and it keeps the MAC unique (vm.netdevFor)
    port = await ports.allocSshPort();
    state.vms[a.name] = st.newVmRecord({
      kind: 'appliance',
      appliance: {
        firmware: a.firmware, bus: a.bus, vga: a.vga, sound: a.sound, source: a.source, sourceSha256: a.sha256, media: media,
        display: a.display || 'browser', sshUser: a.sshUser || 'root',
      },
      port: port, mem: a.mem, cpus: a.cpus, accel: a.accel, template: '', ports: a.ports,   // '': a standalone disk, no template
      ephemeral: a.ephemeral, autostart: a.autostart, note: a.note, createdBy: a.createdBy, personalized: true,
    });
    st.saveState();
    made.length = 0;
  } catch (e) {
    for (const f of made) await removeFile(t, f);
    throw e;
  } finally {
    await removeFile(t, tmp);
    if (port) ports.release(port);
    for (const p of held) ports.release(p, a.name);
  }
  const vm = state.vms[a.name];
  t.log('Created the appliance VM "' + a.name + '": ' + a.firmware.toUpperCase() + ', ' + a.mem + ' MB, ' + a.cpus + ' vCPU, ' +
    fmtBytes(sizeOf(disk)) + ' on disk' + (vm.appliance.media === 'iso' ? ' + the ISO as CD-ROM' : (vm.appliance.media === 'image' ? ' + the image as installation media (boots first; "Remove media" once installed)' : '')) +
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
  if (!vm.appliance || vm.appliance.media === 'disk') throw conflict('"' + name + '" has no installation media attached', 'NO_MEDIA');
  return { name: name };
}
async function opEject(t, a) {
  const vm = st.getVm(a.name);
  const vmMod = require('./vm');
  if (vm.runtime && (await vmMod.isRunning(a.name))) throw new Error('stop "' + a.name + '" first: the installation media is removed for the next start');
  const what = vm.appliance.media === 'iso' ? 'CD-ROM' : 'installation media';
  for (const f of [st.mediaPath(a.name), st.mediaDiskPath(a.name)]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  vm.appliance.media = 'disk';
  st.saveState();
  t.log(what + ' removed from "' + a.name + '": it boots from its own disk from now on');
  return { name: a.name, media: 'disk' };
}

// ---------------------------------------------------------------------------
// the window display (display: 'window')
// ---------------------------------------------------------------------------
// What a QEMU build offers, from `-device help` and `-display help`. Pure.
function parseCaps(deviceHelp, displayHelp) {
  const devices = new Set();
  const re = /name "([^"]+)"/g;
  let m;
  while ((m = re.exec(String(deviceHelp || '')))) devices.add(m[1]);
  const displays = new Set();
  let listing = false;
  for (const raw of String(displayHelp || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Available display backend types/i.test(line)) { listing = true; continue; }
    if (!listing) continue;
    if (!line || /\s/.test(line)) break;   // the list ends at the first blank or prose line
    displays.add(line);
  }
  return { devices: devices, displays: displays };
}

// The -display value for a window on this PC, given the QEMU build's caps,
// the platform and the environment. Pure. Returns {display, gl, ui} or
// {error}: gl = the 3D GPU (virtio-vga-gl) goes with it.
//   Windows: GTK with OpenGL ES (ANGLE; SDL with GL crashed QEMU 11.1 on the
//            test PC, so SDL is only the plain fallback)
//   macOS:   Cocoa (no virgl in the usual builds: a plain window)
//   others:  GTK, else SDL, with desktop OpenGL - and only inside a desktop
//            session (DISPLAY / WAYLAND_DISPLAY)
// QEMU hands the window's size to the guest as its screen size, and GTK opens
// the window at the firmware's 640x480 (Kodi came up at 640x480, 2026-10-10):
// on Windows the manager sizes the window right after the start, before the
// guest reads it (lib/wincap.js fit; Kodi then drew at 1321x825 in a
// 1321-pixel-wide window). zoom-to-fit scales the picture when the window is
// resized later. Full screen: Ctrl+Alt+F.
// window-close=off: closing the window must not pull the plug on the guest
// (stop it from the manager).
function windowDisplay(caps, platformName, env) {
  const gl = caps.devices.has('virtio-vga-gl');
  if (platformName === 'win32') {
    if (caps.displays.has('gtk')) return { display: 'gtk,gl=' + (gl ? 'es' : 'off') + ',zoom-to-fit=on,window-close=off', gl: gl, ui: 'gtk' };
    if (caps.displays.has('sdl')) return { display: 'sdl,window-close=off', gl: false, ui: 'sdl' };
    return { error: 'this QEMU has no window display (gtk or sdl) - use the browser view' };
  }
  if (platformName === 'darwin') {
    if (caps.displays.has('cocoa')) return { display: 'cocoa,zoom-to-fit=on', gl: false, ui: 'cocoa' };
    return { error: 'this QEMU has no window display (cocoa) - use the browser view' };
  }
  env = env || {};
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { error: 'the manager runs outside a desktop session (no DISPLAY or WAYLAND_DISPLAY), so it cannot open a window - use the browser view' };
  if (caps.displays.has('gtk')) return { display: 'gtk,gl=' + (gl ? 'on' : 'off') + ',zoom-to-fit=on,window-close=off', gl: gl, ui: 'gtk' };
  if (caps.displays.has('sdl')) return { display: 'sdl,gl=' + (gl ? 'on' : 'off') + ',window-close=off', gl: gl, ui: 'sdl' };
  return { error: 'this QEMU has no window display (gtk or sdl) - use the browser view' };
}

// The caps of the installed QEMU, asked once per QEMU file (path + mtime).
let capsCache = null;   // {key, caps}
async function qemuCaps() {
  const qemu = platform.findTool('qemu');
  if (!qemu) throw new Error('QEMU is not installed - ' + platform.installHints().qemu);
  let key = qemu;
  try { key += '|' + fs.statSync(qemu).mtimeMs; } catch (e) { /* key without the time */ }
  if (capsCache && capsCache.key === key) return capsCache.caps;
  const [dev, disp] = await Promise.all([run(qemu, ['-device', 'help'], { timeout: 20000 }), run(qemu, ['-display', 'help'], { timeout: 20000 })]);
  const caps = parseCaps(dev.stdout + '\n' + dev.stderr, disp.stdout + '\n' + disp.stderr);
  capsCache = { key: key, caps: caps };
  return caps;
}

// The window this PC can open for a VM: {display, gl, ui} or {error}.
async function windowSetting() {
  return windowDisplay(await qemuCaps(), process.platform, process.env);
}

// ---------------------------------------------------------------------------
// QEMU arguments for the kind (pure given the files)
// ---------------------------------------------------------------------------
// o: {disk, media (ISO path | null), mediaDisk (qcow2 path | null),
//     display: {host, port} (browser view) | null, window: {display, gl}
//     (window view, windowSetting) | null, firmware, vars,
//     sound: host audio backend | null}
// Returns {drives: [...], extra: [...], display: the -display value}: the
// drive arguments replace vm.js's virtio qcow2 drive; extra goes at the end.
// Installation media boots first (bootindex 0), the VM's own disk second.
function qemuArgs(vm, o) {
  const ap = vm.appliance || st.cleanAppliance({});
  const qv = (s) => String(s).replace(/,/g, ',,');
  const drives = [];
  const mediaDisk = ap.media === 'image' && o.mediaDisk ? 'file=' + qv(o.mediaDisk) + ',if=none,id=hd1,format=qcow2' : null;
  if (ap.bus === 'sata') {
    drives.push('-device', 'ich9-ahci,id=ahci');
    drives.push('-drive', 'file=' + qv(o.disk) + ',if=none,id=hd0,format=qcow2,discard=unmap,detect-zeroes=unmap', '-device', 'ide-hd,drive=hd0,bus=ahci.0,bootindex=1');
    if (ap.media === 'iso' && o.media) drives.push('-drive', 'file=' + qv(o.media) + ',if=none,id=cd0,media=cdrom,format=raw,readonly=on', '-device', 'ide-cd,drive=cd0,bus=ahci.1,bootindex=0');
    if (mediaDisk) drives.push('-drive', mediaDisk, '-device', 'ide-hd,drive=hd1,bus=ahci.2,bootindex=0');
  } else {
    drives.push('-drive', 'file=' + qv(o.disk) + ',if=none,id=hd0,format=qcow2,discard=unmap,detect-zeroes=unmap', '-device', 'virtio-blk-pci,drive=hd0,bootindex=1');
    if (ap.media === 'iso' && o.media) {
      drives.push('-device', 'ich9-ahci,id=ahci');
      drives.push('-drive', 'file=' + qv(o.media) + ',if=none,id=cd0,media=cdrom,format=raw,readonly=on', '-device', 'ide-cd,drive=cd0,bus=ahci.0,bootindex=0');
    }
    if (mediaDisk) drives.push('-drive', mediaDisk, '-device', 'virtio-blk-pci,drive=hd1,bootindex=0');
  }
  const extra = [];
  if (ap.firmware === 'uefi' && o.firmware) {
    extra.push('-drive', 'if=pflash,format=raw,readonly=on,file=' + qv(o.firmware.code));
    extra.push('-drive', 'if=pflash,format=raw,file=' + qv(o.vars));
  }
  // virtio-vga: a plain VGA for the firmware and the boot loader, virtio-gpu
  // once the OS driver loads (LibreELEC, every current Linux); std: QEMU's
  // VGA alone, for an OS without a virtio-gpu driver
  const vgaDevice = ap.vga === 'std' ? 'VGA,vgamem_mb=32' : 'virtio-vga';
  let display = 'none';
  if (ap.display === 'window' && o.window && o.window.display) {
    // a window on this PC: the 3D GPU (virgl renders the guest's OpenGL on the
    // host's graphics card) when QEMU has it and the guest has a virtio-gpu
    // driver; no VNC (QEMU refuses VNC next to a GL window)
    extra.push('-device', o.window.gl && ap.vga !== 'std' ? 'virtio-vga-gl' : vgaDevice);
    display = o.window.display;
  } else {
    // the browser: plain VNC on the private endpoint (never a public port;
    // the manager relays it to the browser)
    extra.push('-vnc', o.display.host + ':' + (o.display.port - 5900) + ',lossy=on');
    extra.push('-device', vgaDevice);
  }
  // an absolute-position USB tablet (the pointer is where the user points) and a keyboard
  extra.push('-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,bus=xhci.0', '-device', 'usb-kbd,bus=xhci.0');
  if (ap.sound && o.sound) {
    extra.push('-audiodev', o.sound + ',id=snd0', '-device', 'intel-hda', '-device', 'hda-output,audiodev=snd0');
  }
  extra.push('-rtc', 'base=localtime');
  return { drives: drives, extra: extra, display: display };
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
  return {
    firmware: ap.firmware, bus: ap.bus, vga: ap.vga, sound: ap.sound, media: ap.media, source: ap.source, sourceName: baseName(ap.source || ''),
    display: ap.display || 'browser', sshUser: ap.sshUser || 'root',
  };
}

module.exports = {
  validateCreate, opCreate, validateEject, opEject, qemuArgs, firmwareFiles, detectFormat, hostAudioBackend, describe,
  parseCaps, windowDisplay, qemuCaps, windowSetting,
  SOURCE_RE, DEFAULT_DISK_GB, baseName,
};
