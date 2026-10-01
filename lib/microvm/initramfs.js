'use strict';
/*
 * The per-run "init" archive of a microVM: /.devbox/{init, busybox, spec.sh,
 * modules/*.ko}. It is concatenated AFTER the image's rootfs archive (the
 * kernel unpacks both into the same tmpfs root; later entries win), so the
 * image archive can be cached per image and only this small one is built per
 * run.
 *
 *   shq(s)                    -> single-quoted shell word
 *   renderSpec(spec)          -> spec.sh text (see SPEC below); at most
 *                                SPEC_MAX_BYTES (32 KB) - bug I: the spec
 *                                travels over QEMU fw_cfg, whose guest-side
 *                                reads cost O(size^2) port exits, so a huge
 *                                environment would stall the boot. Larger
 *                                specs throw (code SPEC_TOO_LARGE)
 *   buildInitArchive(o)       -> Promise<Buffer> (newc cpio, uncompressed;
 *                                written by lib/oci/cpio's CpioWriter, the
 *                                app's only cpio writer)
 *   initScript()              -> the init.sh text (LF line endings forced:
 *                                a CRLF checkout would break the guest shell)
 *   specFeatures(spec)        -> kernel features needed (for kernel.modulesFor)
 *
 * SPEC (all optional except argv):
 *   argv: [string]            entrypoint + cmd, already combined (non-empty)
 *   env: [ 'K=V' ] | {K: V}   image env + overrides (PATH default added by
 *                             init first, so the image's PATH wins)
 *   workdir, user ('', name, uid, name:group, uid:gid), hostname
 *   net: false | {ip: '10.0.2.15/24', gw, dns}
 *   volumes: [{serial, target, readonly, nocopy}]  (ext4 disks; see init.sh)
 *   trim: false                 no fstrim of volumes at shutdown
 *   stopSignal ('TERM' | 'SIGQUIT' | 15 ...), stopTimeout (s, default 10)
 *   extraHosts: [{host, ip}], sysctls: {'net.core.somaxconn': '1024'}
 *   copyIn: {targets: ['/abs/dir'], owner: 'user'|'root'}  host folders packed
 *                             into one cpio archive, attached as a read-only
 *                             raw disk with serial devbox-copyin (init.sh)
 *   shares: [{id, target, readonly}]  LIVE shared folders (lib/shares.js):
 *                             init mounts share `id` from the manager's 9P
 *                             server at `target`; the port and the secret
 *                             come from the fw_cfg file opt/devbox/shares,
 *                             never from the spec
 *                             volumes and shares are also rendered as ONE
 *                             list, devbox_mounts, sorted parents first
 *                             (a volume under a share is mounted after it)
 *   logCap: bytes per stream and boot (default in init.sh: 1 GiB; 0 = none)
 *   rootfs: 'disk' | 'ram' (default ram)  DEVBOX_ROOT: 'disk' = the image is
 *                             the ext4 disk with serial devbox-root (a qcow2
 *                             overlay of the shared image disk), mounted and
 *                             switch_root'ed to by init; needs the blk + ext4
 *                             modules (specFeatures adds them)
 *   modules: [names] (load order), debug: bool, tty: '/dev/ttyS0'
 */
const fs = require('fs');
const path = require('path');
const { CpioWriter } = require('../oci/cpio');

const INIT_PATH = path.join(__dirname, 'init.sh');
const SPEC_MAX_BYTES = 32 * 1024;

function shq(s) {
  const v = String(s);
  if (v.includes('\0')) throw new Error('a NUL byte cannot be passed to the container: ' + JSON.stringify(v.slice(0, 40)));
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

const SIGNALS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE',
  'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF',
  'WINCH', 'IO', 'PWR', 'SYS'];

// Docker STOPSIGNAL forms: "SIGTERM", "TERM", "15", "SIGRTMIN+3" (not supported)
function normSignal(s) {
  if (s === undefined || s === null || s === '') return 'TERM';
  if (typeof s === 'number' || /^\d+$/.test(String(s))) {
    const n = parseInt(s, 10);
    if (n >= 1 && n <= SIGNALS.length) return SIGNALS[n - 1];
    throw new Error('unsupported stop signal ' + s);
  }
  const name = String(s).toUpperCase().replace(/^SIG/, '');
  if (!SIGNALS.includes(name)) throw new Error('unsupported stop signal ' + s);
  return name;
}

function envList(env) {
  if (!env) return [];
  const list = Array.isArray(env) ? env.slice() : Object.entries(env).map(([k, v]) => k + '=' + v);
  for (const e of list) {
    const i = String(e).indexOf('=');
    if (i <= 0) throw new Error('bad environment entry ' + JSON.stringify(e));
  }
  return list;
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function renderSpec(spec) {
  if (!spec || !Array.isArray(spec.argv) || !spec.argv.length) throw new Error('spec.argv must be a non-empty array (no command specified)');
  if (String(spec.argv[0]).includes('=')) throw new Error('the command name cannot contain "=" (env would take it as a variable)');
  const L = ['# generated by devbox - do not edit', 'DEVBOX_SPEC_VERSION=1'];
  const hostname = spec.hostname || 'devbox';
  if (!HOSTNAME_RE.test(hostname)) throw new Error('bad hostname ' + JSON.stringify(hostname));
  L.push('DEVBOX_HOSTNAME=' + shq(hostname));
  L.push('DEVBOX_WORKDIR=' + shq(spec.workdir || '/'));
  L.push('DEVBOX_USER=' + shq(spec.user || ''));
  if (spec.net === false) L.push('DEVBOX_NET=0');
  else {
    const n = spec.net || {};
    L.push('DEVBOX_NET=1');
    if (n.ip) L.push('DEVBOX_IP=' + shq(n.ip));
    if (n.gw) L.push('DEVBOX_GW=' + shq(n.gw));
    if (n.dns) L.push('DEVBOX_DNS=' + shq(n.dns));
  }
  L.push('DEVBOX_STOP_SIGNAL=' + normSignal(spec.stopSignal));
  const t = spec.stopTimeout === undefined ? 10 : Number(spec.stopTimeout);
  if (!(t >= 0 && t <= 86400)) throw new Error('bad stopTimeout');
  L.push('DEVBOX_STOP_TIMEOUT=' + Math.round(t));
  const mods = spec.modules || [];
  for (const m of mods) if (!/^[A-Za-z0-9_-]+$/.test(m)) throw new Error('bad module name ' + m);
  L.push('DEVBOX_MODULES=' + shq(mods.join(' ')));
  L.push('DEVBOX_DEBUG=' + (spec.debug ? 1 : 0));
  L.push('DEVBOX_TRIM=' + (spec.trim === false ? 0 : 1));
  L.push('DEVBOX_ROOT=' + (spec.rootfs === 'disk' ? 'disk' : 'ram'));
  if (spec.tty) L.push('DEVBOX_TTY=' + shq(spec.tty));
  if (spec.logCap !== undefined && spec.logCap !== null) {
    const cap = Number(spec.logCap);
    if (!(Number.isInteger(cap) && cap >= 0 && cap <= 2 ** 50)) throw new Error('bad logCap ' + spec.logCap);
    L.push('DEVBOX_LOG_CAP=' + cap);
  }

  L.push('devbox_volumes() {');
  L.push('  :');
  const targets = new Set();
  const mounts = []; // {target, call} of both kinds, for devbox_mounts
  for (const v of spec.volumes || []) {
    if (!v.serial || !/^[A-Za-z0-9_.-]{1,20}$/.test(v.serial)) throw new Error('volume serial must be 1-20 chars [A-Za-z0-9_.-]');
    const t = String(v.target || '');
    if (!t.startsWith('/') || t === '/' || /(^|\/)\.\.?(\/|$)/.test(t) || t.startsWith('/.devbox') || /[\n\r\0]/.test(t)) {
      throw new Error('volume target must be an absolute path other than / and /.devbox: ' + JSON.stringify(t));
    }
    const norm = t.replace(/\/+$/, '');
    if (targets.has(norm)) throw new Error('duplicate volume target ' + norm);
    targets.add(norm);
    const call = 'devbox_volume ' + shq(v.serial) + ' ' + shq(norm) + (v.readonly ? ' ro' : ' rw') + (v.nocopy ? ' nocopy' : '');
    mounts.push({ target: norm, call });
    L.push('  ' + call + ' || return 1');
  }
  L.push('}');
  // live shared folders: the id names the entry of the fw_cfg share list;
  // targets are plain paths (init keeps them in a space-separated list)
  L.push('devbox_shares() {');
  L.push('  :');
  for (const s of spec.shares || []) {
    if (!s.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.id)) throw new Error('bad shared folder id ' + JSON.stringify(s.id));
    const t = String(s.target || '');
    if (!t.startsWith('/') || t === '/' || /(^|\/)\.\.?(\/|$)/.test(t) || t.startsWith('/.devbox') || /[\s\0]/.test(t)) {
      throw new Error('shared folder target must be an absolute path without spaces, other than / and /.devbox: ' + JSON.stringify(t));
    }
    const norm = t.replace(/\/+$/, '');
    if (targets.has(norm)) throw new Error('duplicate volume or shared folder target ' + norm);
    targets.add(norm);
    const call = 'devbox_share ' + shq(s.id) + ' ' + shq(norm) + (s.readonly ? ' ro' : ' rw');
    mounts.push({ target: norm, call });
    L.push('  ' + call + ' || return 1');
  }
  L.push('}');
  // Both kinds in ONE list, parents before children (Docker's sortMounts):
  // a volume under a shared folder or under another volume is mounted after
  // it, not hidden by it (correct-1). A stable sort by depth keeps the given
  // order among mounts of the same depth.
  const depth = (t) => t.split('/').length;
  const ordered = mounts.map((m, i) => Object.assign({ i }, m)).sort((a, b) => depth(a.target) - depth(b.target) || a.i - b.i);
  L.push('devbox_mounts() {');
  L.push('  :');
  for (const m of ordered) L.push('  ' + m.call + ' || return 1');
  L.push('}');
  // copy-in: the archive is a read-only raw disk (serial devbox-copyin); the spec
  // only lists the target directories (created before extraction) and who
  // owns what was copied
  const ci = spec.copyIn;
  L.push('DEVBOX_COPYIN=' + (ci && ci.targets && ci.targets.length ? 1 : 0));
  L.push('DEVBOX_COPYIN_OWNER=' + (ci && ci.owner === 'root' ? 'root' : 'user'));
  L.push('devbox_copyin_targets() {');
  L.push('  :');
  for (const t of (ci && ci.targets) || []) {
    const s = String(t);
    if (!s.startsWith('/') || s === '/' || /(^|\/)\.\.?(\/|$)/.test(s) || s.startsWith('/.devbox') || s.includes('\n')) {
      throw new Error('copy-in target must be an absolute path other than / and /.devbox: ' + JSON.stringify(s));
    }
    L.push('  devbox_copyin_target ' + shq(s.replace(/\/+$/, '')) + ' || return 1');
  }
  L.push('}');
  L.push('devbox_hosts() {');
  L.push('  :');
  for (const h of spec.extraHosts || []) {
    if (!IP_RE.test(h.ip) && !/^[0-9a-fA-F:]+$/.test(h.ip)) throw new Error('bad extra host ip ' + h.ip);
    L.push("  printf '%s\\t%s\\n' " + shq(h.ip) + ' ' + shq(h.host));
  }
  L.push('}');
  L.push('devbox_sysctls() {');
  L.push('  :');
  for (const [k, v] of Object.entries(spec.sysctls || {})) {
    if (!/^[a-z0-9_.]+$/i.test(k) || k.includes('..')) throw new Error('bad sysctl ' + k);
    L.push('  echo ' + shq(v) + ' >' + shq('/proc/sys/' + k.replace(/\./g, '/')) + ' || say ' + shq('sysctl ' + k + ' failed'));
  }
  L.push('}');
  // init calls: devbox_exec <prefix...>; the image env and argv are appended
  // here as literal words
  const words = envList(spec.env).concat(spec.argv).map(shq);
  L.push('devbox_exec() {');
  L.push('  exec "$@" \\');
  for (let i = 0; i < words.length; i++) L.push('    ' + words[i] + (i < words.length - 1 ? ' \\' : ''));
  L.push('}');
  const text = L.join('\n') + '\n';
  const size = Buffer.byteLength(text);
  if (size > SPEC_MAX_BYTES) {
    const e = new Error('the run configuration is ' + Math.ceil(size / 1024) + ' KB, more than the ' + (SPEC_MAX_BYTES / 1024) +
      ' KB a microVM accepts (environment, command and volume list together) - put large configuration into a file and use copy-in');
    e.code = 'SPEC_TOO_LARGE';
    throw e;
  }
  return text;
}

// CR stripped: git on Windows may check the file out with CRLF line endings
// (.gitattributes forbids it, but a zip download ignores that), and the
// guest's shell would then see "\r" at the end of every word.
let initCache = null;
function initScript() {
  if (initCache === null) initCache = fs.readFileSync(INIT_PATH, 'utf8').replace(/\r\n/g, '\n');
  return initCache;
}

// Kernel features a spec needs. rng is on unless spec.rng === false: without
// a virtio-rng device the first getrandom() in the guest blocks ~1.4 s
// (measured with python3), since the WHPX CPU model has no RDRAND.
function specFeatures(spec) {
  const f = [];
  if (spec.net !== false) f.push('net');
  // the disk root and volumes are ext4 on virtio-blk
  if ((spec.volumes || []).length || spec.rootfs === 'disk') f.push('blk', 'ext4');
  if (spec.acpiButton) f.push('acpibutton');
  if (spec.rng !== false) f.push('rng');
  if (spec.copyIn && spec.copyIn.targets && spec.copyIn.targets.length && !f.includes('blk')) f.push('blk');
  // live shared folders: the 9P client (the share list itself comes through
  // qemu_fw_cfg, which init loads first anyway)
  if ((spec.shares || []).length) f.push('ninep');
  return f;
}

// Module load order for a spec (deps first), from the kernel manifest.
function specModules(spec, manifest) {
  if (spec.modules) return spec.modules.slice();
  const names = [];
  for (const f of specFeatures(spec)) for (const n of manifest.features[f] || []) if (!names.includes(n)) names.push(n);
  return names;
}

// o: {kernelDir, manifest, spec?, busybox (Buffer, optional), modules?, extra(w)}
// With a spec: a per-run archive holding /.devbox/spec.sh and only the
// modules that spec needs. Without one: the per-image BASE archive with
// every module in the manifest and no spec; the spec then comes through
// fw_cfg (renderSpec -> file -> qemu -fw_cfg name=opt/devbox/spec,file=...),
// so rootfs + base can be cached as one initrd and nothing is copied per run.
// In memory (a few MB), parents added automatically, mtime 0 (reproducible:
// the same kernel + init give byte-identical archives), inode numbers far
// above the rootfs archive's. o.extra(w) may add entries (async).
async function buildInitArchive(o) {
  const w = new CpioWriter(null, { inoStart: 0x10000000, autoParents: true, mtime: 0 });
  await w.dir('.devbox', 0o755);
  await w.dir('.devbox/run', 0o755);
  await w.dir('.devbox/modules', 0o755);
  await w.device('dev/console', 'char', 5, 1, 0o600);
  await w.device('dev/null', 'char', 1, 3, 0o666);
  const bb = o.busybox || fs.readFileSync(path.join(o.kernelDir, 'busybox.static'));
  await w.file('.devbox/busybox', bb, 0o755);
  await w.file('.devbox/init', Buffer.from(initScript()), 0o755);
  let spec = null;
  let mods;
  if (o.spec) {
    spec = Object.assign({}, o.spec);
    spec.modules = specModules(spec, o.manifest);
    mods = spec.modules;
  } else {
    mods = o.modules || Object.keys(o.manifest.modules);
  }
  for (const m of mods) {
    const mod = o.manifest.modules[m];
    if (!mod) throw new Error('module ' + m + ' is not in the kernel manifest');
    await w.file('.devbox/modules/' + m + '.ko', fs.readFileSync(path.join(o.kernelDir, mod.file)), 0o644);
  }
  if (spec) await w.file('.devbox/spec.sh', Buffer.from(renderSpec(spec)), 0o644);
  if (o.extra) await o.extra(w);
  await w.finish({ padTo: 512 });
  return w.toBuffer();
}

// spec.sh for the fw_cfg path (modules resolved from the manifest).
function renderSpecFor(spec, manifest) {
  return renderSpec(Object.assign({}, spec, { modules: specModules(spec, manifest) }));
}

module.exports = {
  shq, renderSpec, renderSpecFor, buildInitArchive, initScript, specFeatures, specModules, normSignal, envList, SIGNALS,
  SPEC_MAX_BYTES, INIT_PATH,
};
