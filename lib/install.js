'use strict';
/*
 * Prerequisites and one-time setup: QEMU install (Windows), the SSH key, the
 * Alpine guest image, and the "bake" that turns it into the golden base image
 * every VM is cloned from (the guest fetches a cloud-init seed over HTTP).
 *
 * Task operations take the task context `t` first (see tasks.js) and are
 * started by http.js after the matching validate*() function passed:
 *   validateSetup(body)       -> opSetup(t, args)        SSH key -> QEMU -> microVM kernel
 *                                                         -> Alpine -> bake, each step skipped
 *                                                         when already done; {only:'microvm'}
 *                                                         stops after the kernel (no SSH key)
 *   validateInstallQemu(body) -> opInstallQemu(t, args)  also "Update QEMU"
 *   validateBuildBase(body)   -> opBuildBase(t, args)
 *   validateInstallKernel(body) -> opInstallKernel(t, args)  the microVM kernel
 *                                                         (lib/microvm/kernel.ensureKernel)
 * shutdown() stops the seed server and kills a running bake QEMU (manager exit).
 *
 * The microVM kernel (spec microVM section 5) is what runs single Docker
 * images WITHOUT a full VM: about 43 MB of verified Alpine packages, set up
 * in under a minute. prereqs().microvm reports it (not required: full VMs
 * work without it); prereqs().microvmMachine appears only when this QEMU has
 * no "microvm" machine (then q35 is used, ~0.8 s slower per start).
 *
 * Live shared folders: the bake installs the devbox-shares OpenRC service
 * (lib/assets/devbox-shares.initd) and autoloads qemu_fw_cfg, so every clone
 * mounts the folders the manager lists for it over fw_cfg at every boot.
 * Base images baked before that get the service over SSH on first use
 * (lib/shares.js).
 *
 * Downloads (lib/download.js) go to <file>.part, are verified against the
 * published sha512 when there is one, and only then renamed (BUG-3, SEC-10).
 *
 * Discovery is shared with tools/check-sources.js (MNT-14): the pure parsers
 * parseAlpineBranches / parseAlpineCloudImages / chooseAlpineImage /
 * pickQemuInstaller, and the async findAlpineImage / findQemuInstaller.
 *   Alpine (OPS-12): branches come from the mirror index, newest first. The
 *   "nocloud_alpine-<ver>-x86_64-bios-cloudinit-r<N>.qcow2" images are the
 *   ones known to work with the NoCloud net seed below; they exist up to
 *   v3.23 (3.23.4). Newer releases are named "alpine-<ver>-x86_64-[bios-]
 *   cloudinit-r<N>.qcow2" / "generic_alpine-..." and are used only when no
 *   nocloud_ image exists at all (and the log says they are untested).
 *   QEMU: the newest qemu-w64-setup-YYYYMMDD.exe; its checksum is published
 *   as qemu-w64-setup-YYYYMMDD.sha512 (no ".exe"). That comes from the same
 *   server, so the installer's Authenticode signature must also be the known
 *   publisher's (checkInstallerSignature) - config.json "allowUnsignedQemu"
 *   overrides that.
 *
 * A bake VM left behind by a crashed manager is only ended when its own
 * monitor confirms it is the bake (run/bake.json) - Windows reuses pids.
 *
 * The bake (spec section 9, BUG-11, BUG-12, BUG-22, XTR-3, XTR-14):
 *  - vm-alpine.qcow2 stays the pristine, verified download; the bake boots a
 *    throwaway overlay (downloads/bake-work.qcow2), so a failed or interrupted
 *    bake never poisons a retry, and every bake uses a new cloud-init
 *    instance-id;
 *  - the seed server listens on a free port on 127.0.0.1 (10.0.2.2 in the
 *    guest), the bake's SSH forward on 127.0.0.1:2222;
 *  - hardware acceleration is used when available; if the guest does not get
 *    going under it, the bake is retried once with TCG;
 *  - the guest reports "=== BAKE END rc=N ===": N is the exit status of the
 *    toolchain install, and anything but 0 fails the bake with the console
 *    tail; then python3 and git are checked over SSH;
 *  - the guest is powered off cleanly (SSH, then ACPI via the monitor); a
 *    bake VM that had to be killed is never used;
 *  - the overlay is flattened into devbox-base.qcow2 atomically (temp file +
 *    rename); rebuilding is refused while VMs are clones of the base.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const { CFG } = require('./config');
const platform = require('./platform');
const { state } = require('./state');
const vmMod = require('./vm');
const monitor = require('./monitor');
const {
  exists, sizeOf, run, runSync, fmtBytes, sleep, badRequest, conflict, toBool, errMsg, probeSsh, tailFile, atomicWriteFileSync,
} = require('./util');
const { download, fetchText, fetchSha512, sha512File } = require('./download');
const ssh = require('./ssh');
const tasks = require('./tasks');
const kernel = require('./microvm/kernel');

// The guest side of live shared folders, installed by the bake.
const SHARES_INITD = path.join(__dirname, 'assets', 'devbox-shares.initd');
function sharesServiceScript() {
  return fs.readFileSync(SHARES_INITD, 'utf8').replace(/\r\n/g, '\n');
}

const ALPINE_MIRROR = 'https://dl-cdn.alpinelinux.org/alpine/';
const QEMU_LISTING = 'https://qemu.weilnetz.de/w64/';
const GB = 1024 * 1024 * 1024;
const PACKAGES = 'bash git curl jq make gcc musl-dev python3 py3-pip vim nano tree htop strace coreutils tzdata';

// ---------------------------------------------------------------------------
// cloud-init seed server (used only while baking a fresh base image)
// ---------------------------------------------------------------------------
let seedServer = null;
// the running bake VM: {child, pid, monitor, exited}
let bake = null;

function pubKey() {
  try { return fs.readFileSync(CFG.sshPub, 'utf8').trim().split('\n')[0]; }
  catch (e) { return null; }
}

// instanceId must be unique per bake: cloud-init skips its per-instance steps
// when it has seen the id before (a retried bake on a reused image, BUG-12).
function buildSeed(instanceId) {
  const key = pubKey();
  if (!key) throw new Error('SSH public key missing: ' + CFG.sshPub);
  if (/['"\\\n]/.test(key)) throw new Error('the SSH public key contains quotes or line breaks: ' + CFG.sshPub);
  const meta = 'instance-id: ' + (instanceId || 'devbox-' + Date.now()) + '\nlocal-hostname: devbox\n';
  const user = [
    '#cloud-config',
    'hostname: devbox',
    'manage_etc_hosts: true',
    'ssh_pwauth: false',
    'disable_root: false',
    'users:',
    '  - name: dev',
    '    gecos: Dev User',
    '    groups: wheel',
    '    shell: /bin/ash',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    '      - ' + key,
    'runcmd:',
    '  - [ sh, -c, "echo \'=== BAKE START ===\' >> /dev/ttyS0" ]',
    '  - [ sh, -c, "mkdir -p /root/.ssh /home/dev/.ssh;',
    '      printf \'%s\\\\n\' \'' + key + '\' >> /root/.ssh/authorized_keys;',
    '      printf \'%s\\\\n\' \'' + key + '\' >> /home/dev/.ssh/authorized_keys;',
    '      chmod 700 /root/.ssh /home/dev/.ssh; chmod 600 /root/.ssh/authorized_keys /home/dev/.ssh/authorized_keys;',
    '      chown -R dev:dev /home/dev/.ssh 2>/dev/null || true" ]',
    // Locked shadow entries block pubkey auth (sshd here has no PAM): force to "*".
    '  - [ sh, -c, "sed -i \'s|^dev:[^:]*:|dev:*:|\' /etc/shadow; sed -i \'s|^root:[^:]*:|root:*:|\' /etc/shadow;',
    '      grep -E \'^(dev|root):\' /etc/shadow >> /dev/ttyS0 2>&1" ]',
    '  - [ sh, -c, "if grep -q \'^ttyS0::respawn\' /etc/inittab; then',
    '      sed -i \'s|^ttyS0::respawn:.*|ttyS0::respawn:/bin/login -f root|\' /etc/inittab;',
    '      else echo \'ttyS0::respawn:/bin/login -f root\' >> /etc/inittab; fi;',
    '      rc-update add sshd default >/dev/null 2>&1 || true" ]',
    // Boot time of every clone (measured under WHPX: 31 s -> ~14 s to SSH):
    //  - the cloud image waits 10 s in the SYSLINUX menu on EVERY boot (nobody
    //    is there to pick an entry): 1 s instead, in the generated file and in
    //    the settings update-extlinux regenerates it from after a kernel update;
    //  - chronyd holds up the boot (and sshd) until NTP has synced, ~7 s. The
    //    guest clock already comes from the host's RTC, so FAST_STARTUP lets
    //    chrony sync in the background instead;
    //  - dhcpcd's duplicate-address ARP probe costs 3-5 s, and QEMU's user
    //    network has no other hosts that could hold the address: noarp.
    '  - [ sh, -c, "sed -i \'s/^timeout=.*/timeout=1/\' /etc/update-extlinux.conf 2>/dev/null;',
    '      sed -i \'s/^TIMEOUT .*/TIMEOUT 10/\' /boot/extlinux.conf 2>/dev/null;',
    '      sed -i \'s/^FAST_STARTUP=.*/FAST_STARTUP=yes/\' /etc/conf.d/chronyd 2>/dev/null;',
    '      grep -q \'^noarp\' /etc/dhcpcd.conf 2>/dev/null || echo noarp >> /etc/dhcpcd.conf; true" ]',
    // no_timer_check: the kernel's early "IO-APIC + timer" check measures
    // timer ticks against the wall clock; a vCPU starved by a busy host fails
    // it and the guest PANICS at 0.006 s (seen under WHPX with the host CPU at
    // 100%). Cloud images for VMs commonly turn the check off, as here - in
    // the settings update-extlinux uses and in the generated boot entry.
    '  - [ sh, -c, "grep -q no_timer_check /etc/update-extlinux.conf 2>/dev/null ||',
    '      sed -i \'/^default_kernel_opts=/ s/\\"$/ no_timer_check\\"/\' /etc/update-extlinux.conf 2>/dev/null;',
    '      grep -q no_timer_check /boot/extlinux.conf 2>/dev/null ||',
    '      sed -i \'/^ *APPEND / s/$/ no_timer_check/\' /boot/extlinux.conf 2>/dev/null; true" ]',
    // The toolchain: retried (mirrors hiccup), and its exit status is kept so
    // the END marker can report it - a bake without a toolchain must fail
    // instead of freezing a useless base (XTR-3).
    '  - [ sh, -c, "echo \'--- toolchain ---\' >> /dev/ttyS0; rc=1; for i in 1 2 3; do',
    '      if apk update >> /dev/ttyS0 2>&1 && apk add --no-cache ' + PACKAGES + ' >> /dev/ttyS0 2>&1; then rc=0; break; fi;',
    '      echo \\"apk failed (attempt $i of 3)\\" >> /dev/ttyS0; sleep 10; done;',
    '      if [ $rc -eq 0 ]; then python3 -V >> /dev/ttyS0 2>&1 && git --version >> /dev/ttyS0 2>&1 || rc=2; fi;',
    '      echo $rc > /root/.devbox-bake-rc" ]',
    // Live shared folders: the OpenRC service that mounts, at every boot,
    // the folders listed in fw_cfg opt/devbox/shares (lib/shares.js), plus
    // the fw_cfg module on the boot module list. The script travels as
    // base64 (no quotes or newlines to escape in this YAML).
    '  - [ sh, -c, "echo ' + Buffer.from(sharesServiceScript()).toString('base64') + ' | base64 -d > /etc/init.d/devbox-shares &&',
    '      chmod 755 /etc/init.d/devbox-shares && rc-update add devbox-shares default >/dev/null 2>&1;',
    '      grep -q \'^qemu_fw_cfg\' /etc/modules 2>/dev/null || echo qemu_fw_cfg >> /etc/modules; true" ]',
    // Make clones self-contained: no datasource needed on later boots.
    '  - [ sh, -c, "touch /etc/cloud/cloud-init.disabled;',
    '      rc-update del cloud-init default >/dev/null 2>&1 || true;',
    '      rc-update del cloud-init-local default >/dev/null 2>&1 || true;',
    '      rc-update del cloud-final default >/dev/null 2>&1 || true" ]',
    '  - [ sh, -c, "rc=$(cat /root/.devbox-bake-rc 2>/dev/null || echo 99); rm -f /root/.devbox-bake-rc; sync;',
    '      echo \\"=== BAKE END rc=$rc ===\\" >> /dev/ttyS0" ]',
    'final_message: "base baked after $UPTIME seconds"',
    ''
  ].join('\n');
  return { meta: meta, user: user };
}

// Serve the seed on a FREE port bound to 127.0.0.1 (the guest reaches it as
// 10.0.2.2:<port>). Resolves the port. A failed start leaves nothing behind
// (BUG-11), so the next bake can try again.
function startSeedServer(instanceId) {
  stopSeedServer();
  const seed = buildSeed(instanceId);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      if (u === '/meta-data') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(seed.meta); }
      if (u === '/user-data') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(seed.user); }
      if (u === '/vendor-data') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(''); }
      res.writeHead(404); res.end();
    });
    srv.once('error', (e) => { try { srv.close(); } catch (x) {} reject(e); });
    srv.listen(0, '127.0.0.1', () => { seedServer = srv; resolve(srv.address().port); });
  });
}
function stopSeedServer() {
  if (seedServer) { try { seedServer.close(); } catch (e) {} seedServer = null; }
}

// ---------------------------------------------------------------------------
// discovery (pure parsers + the fetching wrappers)
// ---------------------------------------------------------------------------
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// "v3.24/" links of the mirror index -> ['v3.24', 'v3.23', ...] newest first.
function parseAlpineBranches(html) {
  const seen = new Set();
  const re = /href="v(\d+)\.(\d+)\/"/g;
  let m;
  while ((m = re.exec(String(html || '')))) seen.add(m[1] + '.' + m[2]);
  return Array.from(seen).map((s) => s.split('.').map(Number))
    .sort((a, b) => cmpVersion(b, a))
    .map((v) => 'v' + v[0] + '.' + v[1]);
}

// x86_64 cloud-init images in a releases/cloud/ listing:
//   [{file, flavor: 'nocloud'|'generic'|'plain', version: [3,23,4], rev, boot: 'bios'|'uefi'|'any', metal}]
// Other clouds' images (oci_, aws_, ...) and the .asc/.sha512 files are skipped.
function parseAlpineCloudImages(html) {
  const out = [];
  const seen = new Set();
  const re = /(^|[^\w.-])(?:([a-z0-9]+)_)?alpine-(\d+)\.(\d+)\.(\d+)-x86_64-(?:(bios|uefi)-)?cloudinit-(metal-)?r(\d+)\.qcow2(?![\w.])/g;
  let m;
  const text = String(html || '');
  while ((m = re.exec(text))) {
    const prefix = m[2] || null;
    if (prefix && prefix !== 'nocloud' && prefix !== 'generic') continue;
    const file = (prefix ? prefix + '_' : '') + 'alpine-' + m[3] + '.' + m[4] + '.' + m[5] + '-x86_64-' + (m[6] ? m[6] + '-' : '') + 'cloudinit-' + (m[7] || '') + 'r' + m[8] + '.qcow2';
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({
      file: file, flavor: prefix || 'plain', version: [+m[3], +m[4], +m[5]], rev: +m[8],
      boot: m[6] || 'any', metal: !!m[7],
    });
  }
  return out;
}

// The image to use: the newest nocloud_ BIOS image (known to work with the
// seed); only if there is none anywhere, the newest other BIOS-capable image
// (verified:false). Metal (bare-metal kernel) and UEFI-only images are never
// picked. Returns the image plus {verified}, or null. Pure.
function chooseAlpineImage(images) {
  const usable = (images || []).filter((i) => !i.metal && i.boot !== 'uefi');
  const cmp = (a, b) => cmpVersion(a.version, b.version) || a.rev - b.rev;
  const nocloud = usable.filter((i) => i.flavor === 'nocloud' && i.boot === 'bios').sort(cmp);
  if (nocloud.length) return Object.assign({ verified: true }, nocloud[nocloud.length - 1]);
  const rank = { generic: 0, plain: 1 };
  const other = usable.filter((i) => rank[i.flavor] !== undefined)
    .sort((a, b) => cmp(a, b) || rank[a.flavor] - rank[b.flavor]);
  return other.length ? Object.assign({ verified: false }, other[other.length - 1]) : null;
}

// The newest QEMU installer in the build listing:
//   {file, date, url, sha512Url} or null. Pure.
function pickQemuInstaller(html, base) {
  const hits = String(html || '').match(/qemu-w64-setup-\d{8}\.exe/g) || [];
  if (!hits.length) return null;
  const file = Array.from(new Set(hits)).sort().pop();
  const date = file.match(/(\d{8})/)[1];
  const dir = (base || QEMU_LISTING) + date.slice(0, 4) + '/';
  return { file: file, date: date, url: dir + file, sha512Url: dir + file.replace(/\.exe$/, '.sha512') };
}

// t is optional so tools/check-sources.js can call these outside a task.
async function findAlpineImage(t, opts) {
  opts = opts || {};
  const say = (m) => { if (t) t.log(m); };
  say('Finding the newest Alpine cloud image...');
  const branches = parseAlpineBranches(await fetchText(ALPINE_MIRROR)).slice(0, opts.maxBranches || 4);
  if (!branches.length) throw new Error('the Alpine mirror index lists no release branches');
  const all = [];
  const errors = [];
  for (const b of branches) {
    let listing;
    try { listing = await fetchText(ALPINE_MIRROR + b + '/releases/cloud/'); }
    catch (e) { errors.push(b + ': ' + errMsg(e)); continue; }
    const imgs = parseAlpineCloudImages(listing).map((i) => Object.assign(i, { branch: b }));
    all.push(...imgs);
    // older branches only hold older releases: stop at the first nocloud_ hit
    if (imgs.some((i) => i.flavor === 'nocloud' && i.boot === 'bios' && !i.metal)) break;
  }
  const pick = chooseAlpineImage(all);
  if (!pick) {
    throw new Error('could not find an Alpine x86_64 cloud-init image in ' + branches.join(', ') + (errors.length ? ' (' + errors.join('; ') + ')' : ''));
  }
  const url = ALPINE_MIRROR + pick.branch + '/releases/cloud/' + pick.file;
  say('Newest usable image: ' + pick.file + ' (' + pick.branch + ')' + (pick.verified ? '' : ' - WARNING: this image family is untested with the manager\'s setup'));
  return {
    url: url, file: pick.file, branch: pick.branch, version: pick.version.join('.'), flavor: pick.flavor,
    verified: pick.verified, sha512Url: url + '.sha512',
  };
}
// v1 name, kept for callers that only need the URL
async function pickAlpineUrl(t) { return (await findAlpineImage(t)).url; }

async function findQemuInstaller(t) {
  if (t) t.log('Looking up the latest QEMU build for Windows...');
  const pick = pickQemuInstaller(await fetchText(QEMU_LISTING));
  if (!pick) throw new Error('could not find any qemu-w64-setup-*.exe in ' + QEMU_LISTING);
  return pick;
}

// ---------------------------------------------------------------------------
// prerequisites
// ---------------------------------------------------------------------------
const versionCache = new Map();
function qemuVersion(qemuPath) {
  const q = qemuPath || platform.findTool('qemu');
  if (!q) return '';
  if (!versionCache.has(q)) versionCache.set(q, runSync(q, ['--version']).split('\n')[0].trim() || 'unknown version');
  return versionCache.get(q);
}

function alpineSourceFile() { return CFG.alpine + '.json'; }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// Everything the manager needs, each with ok/detail and, when missing, the
// exact fix for this OS. `required` items block creating VMs.
function prereqs() {
  const hints = platform.installHints();
  const q = platform.findTool('qemu');
  const qi = platform.findTool('qemu-img');
  const sshBin = platform.findTool('ssh');
  const kg = platform.findTool('ssh-keygen');
  const scp = platform.findTool('scp');
  const out = {
    qemu: {
      ok: !!(q && qi), required: true, label: 'QEMU emulator',
      detail: q && qi ? qemuVersion(q) + ' - ' + path.dirname(q) : (q ? 'qemu-img is missing next to ' + q : 'not installed'),
      fix: q && qi ? null : hints.qemu, action: platform.IS_WIN ? 'install-qemu' : null,
    },
    ssh: {
      ok: !!(sshBin && kg), required: true, label: 'OpenSSH client (ssh, ssh-keygen)',
      detail: sshBin && kg ? path.dirname(sshBin) : 'not found',
      fix: sshBin && kg ? null : hints.ssh, action: null,
    },
    scp: {
      ok: !!scp, required: false, label: 'scp (optional: file-copy fallback for the Claude/MCP tools when this PC has no tar)',
      detail: scp || 'not found', fix: scp ? null : hints.ssh, action: null,
    },
  };
  if (platform.IS_WIN) {
    const z = platform.findTool('7z');
    out.sevenzip = {
      ok: !!z, required: !(q && qi), label: '7-Zip (only needed to unpack QEMU)',
      detail: z || 'not found', fix: z ? null : hints.sevenZip, action: null,
    };
  }
  const acc = platform.accelStatus();
  const hw = acc.available ? acc.available.filter((a) => a !== 'tcg') : null;
  out.accel = {
    ok: !!(hw && hw.length), required: false, label: 'Hardware acceleration (optional, much faster)',
    detail: acc.detecting ? 'checking...' : (hw === null ? 'not checked yet' : (hw.length ? hw.join(', ').toUpperCase() + ' available' : 'not available - VMs use TCG software emulation (slower)')),
    fix: hw && hw.length ? null : hints.accel, action: null,
  };
  out.sshkey = {
    ok: exists(CFG.sshKey), required: false, label: 'SSH key',
    detail: exists(CFG.sshKey) ? CFG.sshKey : 'will be generated', fix: null, action: null,
  };
  const src = readJson(alpineSourceFile());
  out.alpine = {
    ok: exists(CFG.alpine), required: false, label: 'Alpine guest image',
    detail: exists(CFG.alpine) ? (src && src.file ? src.file + ', ' : '') + fmtBytes(sizeOf(CFG.alpine)) : 'not downloaded yet',
    fix: null, action: null,
  };
  out.base = {
    ok: exists(CFG.base), required: true, label: 'Golden base image (template for new VMs)',
    detail: exists(CFG.base) ? fmtBytes(sizeOf(CFG.base)) : 'not built yet', fix: null, action: 'build-base',
  };
  const k = kernel.kernelStatus();
  out.microvm = {
    ok: k.ok, required: false, label: 'microVM kernel (runs Docker images without Docker)',
    detail: k.ok ? k.kver + ', ' + fmtBytes(k.bytes) + (k.needsUpdate ? ' - update available (adds ' + k.missingFeatures.join(', ') + '; no download needed)' : '')
      : (k.installed ? 'damaged: ' + k.error : 'not installed'),
    fix: null, action: 'install-kernel', needsUpdate: !!k.needsUpdate,
  };
  // only when this QEMU cannot do "microvm" (known once host facts exist)
  const facts = readJson(CFG.hostFactsFile);
  if (facts && Array.isArray(facts.machines) && facts.machines.length && facts.machines.indexOf('microvm') === -1) {
    out.microvmMachine = {
      ok: false, required: false, label: 'QEMU "microvm" machine (faster Docker image starts)',
      detail: 'this QEMU build has no microvm machine - q35 is used instead (about 0.8 s slower per start)',
      fix: 'Update QEMU to a build with the microvm machine', action: platform.IS_WIN ? 'install-qemu' : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { return false; } }

// Refuse to start a big download/unpack on a nearly full disk; warn when tight.
function requireSpace(t, bytes, what) {
  const d = platform.diskFree(CFG.root);
  if (d.free === null) return;
  if (d.free < bytes) {
    throw new Error('not enough free disk space for ' + what + ': ' + fmtBytes(d.free) + ' free on ' + d.path + ', about ' + fmtBytes(bytes) + ' needed');
  }
  if (d.free < bytes * 2) t.warn('disk space is getting low: ' + fmtBytes(d.free) + ' free on ' + d.path);
}

// Names of registry VMs whose QEMU process is running (verified pids).
async function runningVmNames() {
  const withRt = Object.keys(state.vms).filter((n) => state.vms[n].runtime && state.vms[n].runtime.pid);
  if (!withRt.length) return [];
  const pids = await platform.listQemuPids();
  return withRt.filter((n) => (pids ? pids.has(state.vms[n].runtime.pid) : platform.pidAlive(state.vms[n].runtime.pid)));
}

async function waitGone(pid, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!platform.pidAlive(pid)) return true;
    await sleep(500);
  }
  return !platform.pidAlive(pid);
}

// The publisher of the QEMU for Windows builds (qemu.weilnetz.de): Stefan
// Weil, who signs them with the certificate of his employer - checked on
// QEMU 10.2: "CN=Universität Mannheim, O=Universität Mannheim, ..." (older
// builds: "CN=Stefan Weil"). The umlaut is matched loosely: its encoding
// depends on the console code page PowerShell runs with.
const QEMU_SIGNER_RE = /(?:^|,\s*)CN="?(?:Stefan Weil|Universit.{1,2}t Mannheim)"?\s*(?:,|$)/i;

// Is this Authenticode result acceptable for the QEMU installer? Pure.
// The sha512 sidecar comes from the same web server as the installer, so if
// that server were compromised both would match: only the signature proves
// who made the file (SEC-10). So the signer is PINNED (QEMU_SIGNER_RE). The
// certificate has expired since (status "UnknownError", or "NotTrusted" on
// some PCs), which is accepted for that signer only; an unsigned file,
// another signer, or content changed after signing ("HashMismatch") is
// refused - unless config.json says "allowUnsignedQemu": true (then
// everything but HashMismatch passes).
//   sig: {status, signer, chainOk} | null (could not be checked)
function checkInstallerSignature(sig, allowUnsigned) {
  if (sig && sig.status === 'HashMismatch') {
    return { ok: false, why: 'the installer\'s digital signature does not match its content (it was changed after signing)' };
  }
  const pinned = !!(sig && sig.signer && QEMU_SIGNER_RE.test(sig.signer));
  // Valid, or the known expired certificate: still issued by a trusted CA
  if (pinned && (sig.status === 'Valid' || (/^(UnknownError|NotTrusted)$/.test(sig.status) && sig.chainOk))) return { ok: true, why: null };
  if (allowUnsigned) return { ok: true, why: 'accepted because allowUnsignedQemu is set in config.json' };
  if (!sig) return { ok: false, why: 'its digital signature could not be checked (PowerShell Get-AuthenticodeSignature is not available)' };
  if (!sig.signer || sig.status === 'NotSigned') return { ok: false, why: 'the installer is not signed (the QEMU for Windows installers are signed by Stefan Weil / Universität Mannheim)' };
  if (!pinned) return { ok: false, why: 'the installer is signed by "' + sig.signer + '", not by the publisher of the QEMU for Windows builds (Stefan Weil / Universität Mannheim)' };
  return { ok: false, why: 'its signature carries the name of the QEMU publisher but does not chain to a trusted certificate authority (' + sig.status + ') - it may be forged' };
}

// Windows Authenticode status of a file: {status, signer, chainOk} or null
// (not Windows / PowerShell unavailable). chainOk: the signing certificate
// chains up to a root this PC trusts, ignoring only expiry - a self-signed
// certificate that merely COPIES the publisher's name fails it, although
// Get-AuthenticodeSignature reports "UnknownError" for both. Locale-free: no
// status message text is parsed. See checkInstallerSignature.
async function authenticode(file) {
  if (!platform.IS_WIN) return null;
  const lit = String(file).replace(/'/g, "''");
  const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = Get-AuthenticodeSignature -LiteralPath '" + lit + "'; " +
    "$c = $s.SignerCertificate; $ok = $false; " +
    "if ($c) { try { $ch = New-Object System.Security.Cryptography.X509Certificates.X509Chain; " +
    "$ch.ChainPolicy.RevocationMode = 'NoCheck'; $ch.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'; $ok = $ch.Build($c) } catch { $ok = $false } }; " +
    "$s.Status.ToString() + '|' + $ok + '|' + $(if ($c) { $c.Subject } else { '' })";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 60000 });
  if (r.code !== 0) return null;
  return parseAuthenticode(r.stdout);
}
// "Status|True|Subject" -> {status, chainOk, signer} or null. Pure.
function parseAuthenticode(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
  const m = line.match(/^([A-Za-z]+)\|(True|False)\|(.*)$/);
  if (!m) return null;
  return { status: m[1], chainOk: m[2] === 'True', signer: m[3].trim() };
}

// ---------------------------------------------------------------------------
// QEMU install / update (Windows only)
// ---------------------------------------------------------------------------
async function validateInstallQemu(body) {
  if (!platform.IS_WIN) throw badRequest('automatic QEMU install is only available on Windows - ' + platform.installHints().qemu);
  if (!platform.findTool('7z')) throw conflict('7-Zip is needed to unpack QEMU - ' + platform.installHints().sevenZip, 'PREREQ_MISSING');
  const running = await runningVmNames();
  if (running.length) throw conflict('stop every VM first (' + running.join(', ') + '): Windows locks the QEMU files of running VMs', 'VMS_RUNNING');
  // microVM containers run on the same QEMU binaries (spec microVM section
  // 5.3) - also those still pulling or unpacking: they spawn QEMU from this
  // folder within moments (correct-18)
  const cm = require('./microvm/containers');
  const names = new Set((await cm.runningContainers()).map((c) => c.name));
  for (const c of cm.liveContainers ? cm.liveContainers() : []) names.add(c.name);
  if (names.size) throw conflict('stop every container first (' + Array.from(names).join(', ') + '): Windows locks the QEMU files while they run, and a starting one is about to use them', 'VMS_RUNNING');
  return {};
}

// Download, verify, unpack into <root>/qemu-new, check that it runs, then swap
// it in by renaming - an update never leaves a half-replaced QEMU (XTR-18).
async function installQemu(t) {
  if (!platform.IS_WIN) throw new Error('automatic QEMU install is only available on Windows - ' + platform.installHints().qemu);
  const z = platform.findTool('7z');
  if (!z) throw new Error('7-Zip not found - ' + platform.installHints().sevenZip);
  let running = await runningVmNames();
  if (running.length) throw new Error('stop every VM first (' + running.join(', ') + '): Windows locks the QEMU files of running VMs');
  const inst = await findQemuInstaller(t);
  t.log('Latest build: ' + inst.file);
  requireSpace(t, 1.5 * GB, 'the QEMU download and install');
  fs.mkdirSync(CFG.downloadsDir, { recursive: true });
  const setup = path.posix.join(CFG.downloadsDir, inst.file);
  const sha = await fetchSha512(inst.url, { sidecarUrl: inst.sha512Url, fileName: inst.file });
  if (sha) t.log('The published sha512 was found - the download will be verified.');
  else t.warn('no published checksum was found for ' + inst.file + ' - relying on HTTPS alone');
  if (exists(setup)) {
    // a leftover is only reused when it matches the published checksum
    if (sha && (await sha512File(setup)) === sha) t.log('Using the installer downloaded earlier (checksum verified).');
    else { t.log('Discarding an earlier download of ' + inst.file + ' that cannot be verified.'); fs.rmSync(setup, { force: true }); }
  }
  if (!exists(setup)) {
    t.step('Downloading ' + inst.file + '...');
    await download(inst.url, setup, { t: t, label: 'QEMU installer', sha512: sha });
  }
  const sig = await authenticode(setup);
  if (sig) t.log('Installer signature: ' + (sig.signer || 'none') + ' (' + sig.status + ')');
  const verdict = checkInstallerSignature(sig, CFG.allowUnsignedQemu);
  if (!verdict.ok) {
    fs.rmSync(setup, { force: true });
    throw new Error('not installing ' + inst.file + ': ' + verdict.why + '. If you trust this file anyway, set "allowUnsignedQemu": true in ' + CFG.configFile + ' and try again, or install QEMU yourself from https://qemu.weilnetz.de/w64/');
  }
  if (verdict.why) t.warn('installer signature: ' + verdict.why);

  t.step('Unpacking QEMU with 7-Zip...');
  const next = CFG.qemuDir + '-new';
  rmrf(next);
  const r = await run(z, ['x', setup, '-o' + next, '-y'], { timeout: 15 * 60 * 1000 });
  if (r.code !== 0) { rmrf(next); throw new Error('7-Zip extraction failed: ' + (r.stderr || r.stdout).trim().slice(-400)); }
  const exe = path.join(next, 'qemu-system-x86_64.exe');
  const img = path.join(next, 'qemu-img.exe');
  if (!exists(exe) || !exists(img)) { rmrf(next); throw new Error('the installer did not contain qemu-system-x86_64.exe and qemu-img.exe'); }
  const ver = runSync(exe, ['--version'], 30000).split('\n')[0].trim();
  if (!/QEMU emulator version/i.test(ver)) { rmrf(next); throw new Error('the unpacked QEMU does not run (' + (ver || 'no output') + ')'); }
  t.log('Unpacked and checked: ' + ver);

  // swap it in (re-check: a VM may have been started meanwhile)
  running = await runningVmNames();
  if (running.length) { rmrf(next); throw new Error('a VM was started during the install (' + running.join(', ') + ') - stop it and try again'); }
  let old = null;
  if (exists(CFG.qemuDir)) {
    old = CFG.qemuDir + '-old-' + Date.now();
    try { fs.renameSync(CFG.qemuDir, old); }
    catch (e) { rmrf(next); throw new Error('cannot replace ' + CFG.qemuDir + ' (' + errMsg(e) + ') - is a QEMU program from it still running?'); }
  }
  try { fs.renameSync(next, CFG.qemuDir); }
  catch (e) {
    if (old) { try { fs.renameSync(old, CFG.qemuDir); } catch (e2) {} }
    rmrf(next);
    throw new Error('cannot move the new QEMU into place: ' + errMsg(e));
  }
  if (old && !rmrf(old)) t.log('The previous QEMU is kept in ' + old + ' (it could not be deleted now; delete it later).');
  platform.refresh();
  versionCache.clear();
  const q = platform.findTool('qemu');
  if (!q) throw new Error('QEMU was unpacked but qemu-system-x86_64.exe is not found in ' + CFG.qemuDir);
  platform.detectAccel(q).catch(() => {});
  t.log('QEMU installed: ' + qemuVersion(q) + ' (' + q + ')');
  try { fs.rmSync(setup, { force: true }); } catch (e) {}
  return { qemu: q, version: qemuVersion(q), installer: inst.file };
}

async function opInstallQemu(t, args) {
  return installQemu(t);
}

// ---------------------------------------------------------------------------
// Alpine image
// ---------------------------------------------------------------------------
// vm-alpine.qcow2 is the pristine download; <it>.json records where it came
// from and its sha512, so a leftover is only trusted when it still matches.
async function ensureAlpineImage(t) {
  const src = readJson(alpineSourceFile());
  if (exists(CFG.alpine)) {
    if (src && src.sha512) {
      t.log('Checking the Alpine image downloaded earlier...');
      if ((await sha512File(CFG.alpine)) === src.sha512) {
        t.log('Alpine image OK: ' + (src.file || path.basename(CFG.alpine)) + ' (' + fmtBytes(sizeOf(CFG.alpine)) + ')');
        return { file: src.file || null, reused: true };
      }
      t.log('The Alpine image on disk no longer matches its checksum - downloading it again.');
    } else {
      // v1 baked this file in place, so it may already be configured (and
      // then a bake of it never finishes): start from a fresh download.
      t.log('The Alpine image on disk was not downloaded by this version (it may already be configured) - downloading a fresh copy.');
    }
    fs.rmSync(CFG.alpine, { force: true });
  }
  requireSpace(t, 1 * GB, 'the Alpine image');
  const img = await findAlpineImage(t);
  const sha = await fetchSha512(img.url, { fileName: img.file });
  if (!sha) t.warn('no published checksum was found for ' + img.file + ' - relying on HTTPS alone');
  t.step('Downloading ' + img.file + '...');
  const res = await download(img.url, CFG.alpine, { t: t, label: 'Alpine image', sha512: sha });
  try {
    fs.writeFileSync(alpineSourceFile(), JSON.stringify({
      url: img.url, file: img.file, branch: img.branch, version: img.version, flavor: img.flavor,
      sha512: res.sha512, publishedSha512: !!sha, downloadedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch (e) { t.warn('could not record the image checksum: ' + errMsg(e)); }
  return { file: img.file, reused: false };
}

// ---------------------------------------------------------------------------
// the bake
// ---------------------------------------------------------------------------
const bakeSerialLog = () => path.posix.join(CFG.sandboxDir, 'base-bake.log'); // GET /api/log?name=@bake
const bakeQemuLog = () => path.posix.join(CFG.logsDir, 'qemu-bake.log');
const bakePidFile = () => path.posix.join(CFG.runDir, 'bake.pid');
const bakeWorkFile = () => path.posix.join(CFG.downloadsDir, 'bake-work.qcow2');

const BAKE_START_RE = /=== BAKE START ===/;
const BAKE_END_RE = /=== BAKE END(?: rc=(\d+))? ===/;

// The END marker's status: {rc} (null when an old seed printed no rc), or null
// when there is no marker in the text. Pure.
function parseBakeEnd(text) {
  const m = String(text || '').match(BAKE_END_RE);
  if (!m) return null;
  return { rc: m[1] === undefined ? null : parseInt(m[1], 10) };
}

// Reads only what was appended since the last poll (the bake log grows for
// many minutes; re-reading it whole every few seconds was OPS-10). poll()
// returns the new text prefixed with the end of the previous chunk, so a
// marker split across two reads is still found.
class LogWatcher {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.carry = '';
    this.lastLine = '';
    this.decoder = new StringDecoder('utf8');
  }
  poll() {
    let fd = null, text = '';
    try {
      const size = fs.statSync(this.file).size;
      if (size < this.offset) { this.offset = 0; this.carry = ''; }
      if (size > this.offset) {
        const len = Math.min(size - this.offset, 8 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fd = fs.openSync(this.file, 'r');
        const n = fs.readSync(fd, buf, 0, len, this.offset);
        this.offset += n;
        text = this.decoder.write(buf.subarray(0, n));
      }
    } catch (e) { /* not there yet */ }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} } }
    const hay = this.carry + text;
    this.carry = hay.slice(-256);
    if (text) {
      // from hay, not text: a line written in two pieces is still one line
      // eslint-disable-next-line no-control-regex
      const lines = hay.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length) this.lastLine = lines[lines.length - 1];
    }
    return hay;
  }
}

// Poll a log until `marker` (string or RegExp) appears. Resolves true, or
// false on timeout or when isAlive() says the writer is gone.
async function waitForMarker(file, marker, timeoutMs, isAlive, pollMs) {
  const w = new LogWatcher(file);
  const hit = (s) => (marker instanceof RegExp ? marker.test(s) : s.indexOf(marker) !== -1);
  const t0 = Date.now();
  for (;;) {
    if (hit(w.poll())) return true;
    if (isAlive && !isAlive()) return hit(w.poll());
    if (Date.now() - t0 >= timeoutMs) return false;
    await sleep(pollMs || 2000);
  }
}

// run/bake.json: {pid, monitor} of the running bake VM - the monitor is what
// proves later that a pid is still that bake (the pid file alone cannot).
const bakeInfoFile = () => path.posix.join(CFG.runDir, 'bake.json');
function forgetBakeFiles() {
  for (const f of [bakePidFile(), bakeInfoFile()]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* gone */ } }
}

// Stop a bake VM left behind by an earlier manager session (BUG-22): it would
// hold port 2222 and make every retry wait for nothing. Its pid was written
// by an earlier session, and Windows reuses pids: by now it may be a VM's
// QEMU (found in a review - Stop/Setup then killed an unrelated VM). So it is
// only ended when it is no VM's recorded pid AND its own monitor answers
// `info name` with "devbox-bake"; then it is told to quit through that
// monitor first. Anything else is left alone (the port check that follows
// reports a port that is still held).
async function killOrphanBake(t) {
  let pid = null, mon = null;
  try { const j = JSON.parse(fs.readFileSync(bakeInfoFile(), 'utf8')); pid = parseInt(j.pid, 10); mon = j.monitor || null; } catch (e) { /* older session: pid file only */ }
  if (!(pid > 0)) { try { pid = parseInt(fs.readFileSync(bakePidFile(), 'utf8'), 10); } catch (e) { /* none */ } }
  if (pid > 0 && platform.pidAlive(pid)) {
    const vmPid = Object.keys(state.vms).find((n) => state.vms[n].runtime && state.vms[n].runtime.pid === pid);
    const pids = vmPid ? null : await platform.listQemuPids();
    if (vmPid) t.log('The old bake pid ' + pid + ' now belongs to the VM "' + vmPid + '" - left alone.');
    else if (pids && pids.has(pid)) {
      const name = mon ? await monitor.infoName(mon, 5000) : null;
      if (name === 'devbox-bake') {
        t.log('Stopping a bake VM left over from an earlier run (pid ' + pid + ')...');
        await monitor.quit(mon);
        if (!(await waitGone(pid, 5000))) { platform.killPid(pid); await waitGone(pid, 10000); }
      } else {
        t.log('pid ' + pid + ' (from an earlier bake) is a QEMU process that cannot be confirmed to be that bake - left alone.');
      }
    }
  }
  forgetBakeFiles();
}

async function bakeAccel() {
  const g = state.settings && state.settings.accel;
  if (g && g !== 'auto') return g;
  const d = await platform.detectAccel();
  return d.recommended || 'tcg';
}

// The bake's private monitor: same rules as a VM's (vm.runtimeEndpoints).
async function monitorEndpoint() {
  const host = await platform.internalHost();
  if (host) return { host: host, port: await platform.freeLocalPort(host) };
  let p;
  try { p = vmMod.socketPaths('_bake').monitor; } catch (e) { return null; }
  fs.mkdirSync(path.posix.dirname(p), { recursive: true, mode: 0o700 });
  try { fs.rmSync(p, { force: true }); } catch (e) {}
  return { path: p };
}

// QEMU arguments of the bake VM. Pure.
//   o: {disk, accel, mem, cpus, seedPort, sshPort, serialLog, monitor, pidFile}
function bakeArgs(o) {
  const a = ['-name', 'devbox-bake', '-m', String(o.mem), '-smp', String(o.cpus)]
    .concat(vmMod.accelArgs(o.accel), vmMod.cpuArgs(o.accel));
  a.push('-drive', 'file=' + vmMod.qv(o.disk) + ',if=virtio,format=qcow2');
  a.push('-netdev', 'user,id=n0,hostfwd=tcp:127.0.0.1:' + o.sshPort + '-:22', '-device', 'virtio-net-pci,netdev=n0');
  a.push('-smbios', 'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:' + o.seedPort + '/');
  a.push('-display', 'none', '-chardev', 'file,id=ser0,path=' + vmMod.qv(o.serialLog), '-serial', 'chardev:ser0');
  if (o.monitor) a.push('-chardev', vmMod.chardevSpec('mon0', o.monitor), '-mon', 'chardev=mon0,mode=readline');
  else a.push('-monitor', 'none');
  if (o.pidFile) a.push('-pidfile', o.pidFile);
  a.push('-no-reboot');
  return a;
}

// A fresh overlay over the pristine image, grown by 8 GB (the guest's
// cloud-init grows its filesystem on first boot).
async function makeWorkDisk(qi, work, sizeBytes) {
  try { fs.rmSync(work, { force: true }); } catch (e) {}
  const backing = path.relative(path.dirname(work), CFG.alpine).replace(/\\/g, '/');
  const r = await run(qi, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', backing, work, String(sizeBytes)]);
  if (r.code !== 0) throw new Error('qemu-img create failed: ' + (r.stderr || r.stdout).trim().slice(0, 300));
}

// Stop the bake VM: quit through the monitor, else kill (verified QEMU pid).
async function killBakeVm() {
  const b = bake;
  if (!b || b.exited) return;
  if (b.monitor) await monitor.quit(b.monitor);
  if (!(await waitGone(b.pid, 4000))) {
    platform.killPid(b.pid);
    await waitGone(b.pid, 8000);
  }
  // the child's 'exit' event may come a moment after the process is gone
  if (!platform.pidAlive(b.pid)) b.exited = true;
}

// Boot the work disk once and follow the console. Resolves
//   {status: 'end'|'died'|'no-start'|'timeout', rc, started, early}
async function bakeOnce(t, o) {
  const serialLog = bakeSerialLog();
  fs.mkdirSync(path.dirname(serialLog), { recursive: true });
  fs.mkdirSync(CFG.logsDir, { recursive: true });
  fs.mkdirSync(CFG.runDir, { recursive: true });
  try { fs.rmSync(serialLog, { force: true }); } catch (e) {}
  const mon = await monitorEndpoint();
  const args = bakeArgs({
    disk: o.work, accel: o.accel, mem: o.mem, cpus: o.cpus, seedPort: o.seedPort, sshPort: CFG.bakeSshPort,
    serialLog: serialLog, monitor: mon, pidFile: bakePidFile(),
  });
  const fd = fs.openSync(bakeQemuLog(), 'w');
  let child;
  try { child = spawn(o.qemu, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }); }
  finally { fs.closeSync(fd); }
  const b = { child: child, pid: child.pid, monitor: mon, exited: false, t0: Date.now() };
  bake = b;
  try { atomicWriteFileSync(bakeInfoFile(), JSON.stringify({ pid: child.pid, monitor: mon, startedAt: new Date().toISOString() }) + '\n'); }
  catch (e) { /* only needed to clean up after a crash */ }
  child.on('error', (e) => { b.exited = true; t.log('QEMU could not start: ' + errMsg(e)); });
  child.on('exit', () => { b.exited = true; });
  child.unref();
  t.log('Bake VM started (pid ' + child.pid + ', ' + o.accel + ') - the guest installs its toolchain now; this takes a few minutes' + (o.accel === 'tcg' ? ' (10-20 under TCG)' : '') + '.');

  const w = new LogWatcher(serialLog);
  let started = false, lastNote = Date.now();
  for (;;) {
    await sleep(2000);
    const hay = w.poll();
    if (!started && BAKE_START_RE.test(hay)) { started = true; t.log('The guest booted and is configuring itself...'); }
    const end = parseBakeEnd(hay);
    const elapsed = Date.now() - b.t0;
    if (end) return { status: 'end', rc: end.rc, started: true, early: false };
    if (b.exited) return { status: 'died', rc: null, started: started, early: elapsed < 30000 };
    // a panicked kernel just hangs (panic=0): do not wait minutes for it
    if (/Kernel panic - not syncing/.test(hay)) return { status: 'panic', rc: null, started: started, early: elapsed < 30000 };
    if (!started && o.startCapMs && elapsed > o.startCapMs) return { status: 'no-start', rc: null, started: false, early: false };
    if (elapsed > o.totalMs) return { status: 'timeout', rc: null, started: started, early: false };
    if (Date.now() - lastNote >= 30000) {
      lastNote = Date.now();
      // seconds while short: "(1 min)" after 30 s and again after 60 s read as a hang
      const secs = Math.round(elapsed / 1000);
      t.log('  still working (' + (secs < 120 ? secs + ' s' : Math.floor(secs / 60) + ' min') + ')' + (w.lastLine ? ' - console: ' + w.lastLine.slice(0, 140) : ''));
    }
  }
}

function consoleTail(lines) {
  const s = tailFile(bakeSerialLog(), { lines: lines || 30 }).text.trim();
  const q = tailFile(bakeQemuLog(), { lines: 10 }).text.trim();
  return (q ? 'QEMU said:\n' + q + '\n' : '') + (s ? 'Console (last lines):\n' + s : '');
}

async function bakeBase(t) {
  const qemu = platform.findTool('qemu');
  const qi = platform.findTool('qemu-img');
  if (!qemu || !qi) throw new Error('QEMU is not installed yet - ' + platform.installHints().qemu);
  if (!exists(CFG.alpine)) throw new Error('the Alpine image is missing: ' + CFG.alpine);
  if (!pubKey()) throw new Error('the SSH public key is missing: ' + CFG.sshPub);
  const clones = cloneNames();
  if (exists(CFG.base) && clones.length) throw new Error(inUseMessage(clones));
  await killOrphanBake(t);
  if (!(await platform.isPortFree(CFG.bakeSshPort))) {
    throw new Error('port ' + CFG.bakeSshPort + ' (SSH of the bake VM) is taken by another program - close it and try again');
  }
  const info = await vmMod.diskInfo(CFG.alpine);
  if (!info.ok) throw new Error('the Alpine image cannot be read (' + info.error + ') - delete ' + CFG.alpine + ' and run the setup again');
  requireSpace(t, 3 * GB, 'building the base image');
  fs.mkdirSync(CFG.downloadsDir, { recursive: true });
  const work = bakeWorkFile();
  const size = info.virtualSize + 8 * GB;
  let accel = await bakeAccel();
  const instanceId = 'devbox-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const seedPort = await startSeedServer(instanceId);
  t.log('Cloud-init seed served on 127.0.0.1:' + seedPort + ' (instance ' + instanceId + ')');
  ssh.forgetHostKey('_bake');
  let ok = false;
  try {
    let res;
    let retriedPanic = false, retriedTcg = false;
    for (;;) {
      await makeWorkDisk(qi, work, size);
      res = await bakeOnce(t, {
        qemu: qemu, accel: accel, work: work, seedPort: seedPort,
        mem: Math.min(2048, CFG.maxMem), cpus: Math.min(2, CFG.maxCpus),
        // under hardware acceleration the guest must get going quickly;
        // if not, TCG is the safe fallback
        startCapMs: accel === 'tcg' ? 0 : 8 * 60000,
        totalMs: (accel === 'tcg' ? 35 : 25) * 60000,
      });
      if (res.status === 'end') break;
      await killBakeVm();
      // the pristine cloud image has no no_timer_check yet: its early timer
      // check can panic on a very busy PC - a timing problem, so try again
      if (res.status === 'panic' && !retriedPanic) {
        retriedPanic = true;
        t.log('The guest kernel panicked while booting (this can happen when the PC is very busy) - trying again...');
        continue;
      }
      if (accel !== 'tcg' && !retriedTcg && (res.status === 'no-start' || res.status === 'panic' || (res.status === 'died' && res.early))) {
        t.log('The bake did not get going with ' + accel + ' acceleration (' + (res.status === 'died' ? 'QEMU stopped' : (res.status === 'panic' ? 'kernel panic' : 'no progress')) + ') - retrying with TCG software emulation.');
        accel = 'tcg';
        retriedTcg = true;
        continue;
      }
      const why = res.status === 'died' ? 'the bake VM stopped before it finished'
        : (res.status === 'timeout' ? 'the bake did not finish in time'
          : (res.status === 'panic' ? 'the guest kernel panicked while booting' : 'the guest never started configuring itself'));
      throw new Error(why + '. ' + consoleTail(30));
    }
    if (res.rc !== null && res.rc !== 0) {
      await killBakeVm();
      throw new Error('installing the toolchain inside the guest failed (rc=' + res.rc + ') - usually no internet or DNS inside the VM (VPN, proxy) or a mirror problem. ' + consoleTail(30));
    }

    t.step('Checking the guest over SSH...');
    let up = false;
    for (let i = 0; i < 45 && !up && !bake.exited; i++) { up = await probeSsh(CFG.bakeSshPort, 4000); if (!up) await sleep(2000); }
    if (!up) { await killBakeVm(); throw new Error('the bake VM never answered on SSH. ' + consoleTail(20)); }
    const chk = await ssh.sshExec({ name: '_bake', port: CFG.bakeSshPort }, 'python3 -V && git --version && test -d /usr/share/zoneinfo && echo TOOLCHAIN_OK', { timeoutMs: 60000 });
    if (!chk.ok || chk.stdout.indexOf('TOOLCHAIN_OK') === -1) {
      await killBakeVm();
      throw new Error('the guest\'s toolchain check failed (exit ' + chk.code + '): ' + (chk.stderr || chk.stdout).trim().slice(-300));
    }
    t.log(chk.stdout.replace('TOOLCHAIN_OK', '').trim());

    t.step('Shutting the guest down cleanly...');
    await ssh.sshExec({ name: '_bake', port: CFG.bakeSshPort }, 'sync; poweroff', { timeoutMs: 20000 });
    let gone = await waitGone(bake.pid, 120000);
    if (!gone && bake.monitor) {
      t.log('The guest did not power off over SSH - sending an ACPI power-off...');
      await monitor.systemPowerdown(bake.monitor);
      gone = await waitGone(bake.pid, 60000);
    }
    if (!gone) {
      await killBakeVm();
      throw new Error('the bake VM did not shut down cleanly, so its disk may be incomplete - the base image was NOT updated. Try again.');
    }

    t.step('Writing the golden base image...');
    const part = CFG.base + '.part';
    try { fs.rmSync(part, { force: true }); } catch (e) {}
    const conv = await run(qi, ['convert', '-O', 'qcow2', work, part], { timeout: 30 * 60000 });
    if (conv.code !== 0) { try { fs.rmSync(part, { force: true }); } catch (e) {} throw new Error('qemu-img convert failed: ' + (conv.stderr || conv.stdout).trim().slice(0, 300)); }
    if (exists(CFG.base) && cloneNames().length) { fs.rmSync(part, { force: true }); throw new Error(inUseMessage(cloneNames())); }
    fs.renameSync(part, CFG.base);
    ok = true;
    t.log('Base ready: ' + fmtBytes(sizeOf(CFG.base)) + ' (' + (res.rc === null ? 'no status marker' : 'toolchain OK') + ', ' + accel + ') - VMs can now be created in seconds.');
    return { base: CFG.base, bytes: sizeOf(CFG.base), accel: accel };
  } finally {
    stopSeedServer();
    ssh.forgetHostKey('_bake');
    if (bake && !bake.exited) await killBakeVm();
    bake = null;
    forgetBakeFiles();
    try { fs.rmSync(work, { force: true }); } catch (e) {}
    if (!ok) t.log('The full console log of this attempt: logs "@bake" (' + bakeSerialLog() + ')');
  }
}

// VMs that are thin clones of devbox-base (template unknown counts: it may be).
function cloneNames() {
  return Object.keys(state.vms).filter((n) => state.vms[n].template === 'devbox-base' || state.vms[n].template === null);
}
function inUseMessage(clones) {
  return 'the base image is in use by ' + clones.length + ' VM(s) (' + clones.slice(0, 5).join(', ') + (clones.length > 5 ? ', ...' : '') +
    ') - rebuilding it would corrupt them. Delete them first, or freeze a VM into a new template instead.';
}

async function validateBuildBase(body) {
  body = body || {};
  if (!platform.findTool('qemu') || !platform.findTool('qemu-img')) throw conflict('QEMU is not installed yet - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  if (!platform.findTool('ssh-keygen') || !platform.findTool('ssh')) throw conflict('the OpenSSH client is missing - ' + platform.installHints().ssh, 'PREREQ_MISSING');
  if (exists(CFG.base)) {
    // Replacing a backing file under its clones silently corrupts every one
    // of them (XTR-14), so a rebuild is only allowed when nothing uses it.
    await vmMod.fillUnknownTemplates().catch(() => {});
    const clones = cloneNames();
    if (clones.length) throw conflict(inUseMessage(clones), 'BASE_IN_USE');
  }
  return { force: toBool(body.force, false) };
}

async function opBuildBase(t, args) {
  fs.mkdirSync(CFG.seedDir, { recursive: true });
  fs.mkdirSync(CFG.sandboxDir, { recursive: true });
  t.step('Step 1/3: SSH key');
  await ssh.ensureSshKey(t);
  t.step('Step 2/3: Alpine guest image');
  await ensureAlpineImage(t);
  t.step('Step 3/3: building the base image (the guest installs its toolchain - several minutes)');
  return bakeBase(t);
}

// ---------------------------------------------------------------------------
// microVM kernel (spec microVM section 5.2)
// ---------------------------------------------------------------------------
// body: {update?: bool (check the Alpine index for a newer kernel even when
// one is installed)}
async function validateInstallKernel(body) {
  body = body || {};
  tasks.assertFree('qemu');
  if (!platform.findTool('qemu')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  return { update: toBool(body.update, false) };
}

async function opInstallKernel(t, args) {
  const r = await kernel.ensureKernel(t, { update: !!(args && args.update) });
  t.log('Docker images can run now ("Run a Docker image").');
  return r;
}


// ---------------------------------------------------------------------------
// one-click setup (spec section 9, microVM section 5.3):
//   SSH key -> QEMU -> microVM kernel -> Alpine -> bake
// {only:'microvm'}: QEMU -> microVM kernel, then stop (running Docker images
// needs neither the SSH key nor the several-minute base-image bake)
// ---------------------------------------------------------------------------
async function validateSetup(body) {
  body = body || {};
  const hints = platform.installHints();
  if (body.only !== undefined && body.only !== 'microvm') throw badRequest('only must be "microvm" (or left out for everything)');
  const only = body.only === 'microvm' ? 'microvm' : null;
  if (!only && (!platform.findTool('ssh') || !platform.findTool('ssh-keygen'))) throw conflict('the OpenSSH client is missing - ' + hints.ssh, 'PREREQ_MISSING');
  const haveQemu = !!(platform.findTool('qemu') && platform.findTool('qemu-img'));
  if (!haveQemu) {
    if (!platform.IS_WIN) throw conflict('QEMU is not installed - ' + hints.qemu, 'PREREQ_MISSING');
    if (!platform.findTool('7z')) throw conflict('7-Zip is needed to unpack QEMU - ' + hints.sevenZip, 'PREREQ_MISSING');
  }
  return only ? { installQemu: !haveQemu, only: only } : { installQemu: !haveQemu };
}

async function opSetup(t, args) {
  const steps = [];
  const only = args && args.only === 'microvm';
  const n = only ? 2 : 5;
  let i = 0;
  const step = (what) => t.step('Step ' + (++i) + '/' + n + ': ' + what);
  if (!only) {
    fs.mkdirSync(CFG.seedDir, { recursive: true });
    fs.mkdirSync(CFG.sandboxDir, { recursive: true });
    step('SSH key');
    steps.push({ step: 'ssh-key', done: (await ssh.ensureSshKey(t)) ? 'created' : 'already there' });
  }

  step('QEMU');
  if (platform.findTool('qemu') && platform.findTool('qemu-img')) {
    t.log('QEMU is already installed: ' + qemuVersion());
    steps.push({ step: 'qemu', done: 'already there' });
  } else {
    await installQemu(t);
    steps.push({ step: 'qemu', done: 'installed' });
  }

  step('microVM kernel (runs Docker images without a full VM; about 43 MB)');
  try {
    const k = await kernel.ensureKernel(t, {});
    steps.push({ step: 'kernel', done: k.source === 'installed' ? 'already there' : (k.source === 'cached' ? 'prepared' : 'downloaded') });
    t.log('Docker images can run now ("Run a Docker image")' + (only ? '.' : '; the base image for full VMs is still being built.'));
  } catch (e) {
    // full setup: the kernel is optional for full VMs - report it and go on
    if (only) throw e;
    t.warn('the microVM kernel could not be set up (' + errMsg(e) + ') - Docker images will run inside full VMs until it is; retry with "Set up for Docker images"');
    steps.push({ step: 'kernel', done: 'failed: ' + errMsg(e).slice(0, 200) });
  }
  if (only) {
    t.log('Set up for Docker images. Full VMs need the base image: "Set up everything" builds it (several minutes).');
    return { ready: true, only: 'microvm', steps: steps, qemu: platform.findTool('qemu') };
  }

  if (exists(CFG.base)) {
    step('Alpine guest image');
    t.log('Skipped - the base image is already built.');
    step('base image');
    t.log('The base image is already built: ' + fmtBytes(sizeOf(CFG.base)));
    steps.push({ step: 'alpine', done: 'not needed' }, { step: 'base', done: 'already there' });
  } else {
    step('Alpine guest image');
    const a = await ensureAlpineImage(t);
    steps.push({ step: 'alpine', done: a.reused ? 'already there' : 'downloaded' });
    step('building the base image (the guest installs its toolchain - several minutes)');
    await bakeBase(t);
    steps.push({ step: 'base', done: 'built' });
  }
  t.log('Everything is set up - create a VM with "New VM".');
  return { ready: true, steps: steps, base: CFG.base, qemu: platform.findTool('qemu') };
}

// Manager exit: stop the seed server and a bake VM (its disk is a throwaway
// overlay, so killing it loses nothing). The pid files go too: bakeBase's
// finally never runs (server.js exits right after this), and QEMU leaves its
// -pidfile behind when it is killed - a stale pid that a later bake would
// otherwise try to "clean up" after Windows reused it for a VM.
function shutdown() {
  stopSeedServer();
  if (bake && bake.pid && !bake.exited) {
    try { process.kill(bake.pid); } catch (e) {}
    forgetBakeFiles();
  }
  bake = null;
}

// For the network view: the bake VM's SSH forward while a bake runs.
function bakeRunning() { return !!(bake && !bake.exited); }

module.exports = {
  pubKey, buildSeed, startSeedServer, stopSeedServer,
  qemuVersion, prereqs,
  parseAlpineBranches, parseAlpineCloudImages, chooseAlpineImage, pickQemuInstaller, cmpVersion,
  findAlpineImage, findQemuInstaller, pickAlpineUrl,
  validateInstallQemu, opInstallQemu, installQemu, authenticode, parseAuthenticode, checkInstallerSignature, QEMU_SIGNER_RE,
  ensureAlpineImage,
  parseBakeEnd, LogWatcher, waitForMarker, bakeArgs,
  validateBuildBase, opBuildBase, bakeBase,
  validateSetup, opSetup,
  validateInstallKernel, opInstallKernel, sharesServiceScript,
  shutdown, bakeRunning,
  ALPINE_MIRROR, QEMU_LISTING, PACKAGES,
  // for tests: drive one bake boot with real QEMU on a blank disk
  _internal: { bakeOnce: bakeOnce, makeWorkDisk: makeWorkDisk, killBakeVm: killBakeVm, bakeSerialLog: bakeSerialLog, bakePidFile: bakePidFile, bakeInfoFile: bakeInfoFile, killOrphanBake: killOrphanBake },
};
