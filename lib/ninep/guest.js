'use strict';
/*
 * lib/ninep/guest.js - what the manager hands a guest so it can mount the folders
 * shared with it by lib/ninep/server.js (Node standard library only).
 *
 * Delivery: QEMU fw_cfg. At every VM start the manager writes the VM's share
 * list to a per-VM file and adds  qemuFwCfgArgs(file)  to the QEMU command
 * line. The guest reads /sys/firmware/qemu_fw_cfg/by_name/opt/devbox/shares/raw
 * (root only; module qemu_fw_cfg) and mounts each line - see
 * lib/assets/devbox-shares.initd. The list survives reboots
 * inside the VM and needs no SSH; the secret stays off the QEMU command line.
 * Line format (secrets and guest paths never contain whitespace):
 *   <port> <shareId>:<secret> <guest path> <rw|ro>
 *
 * For a VM that is already running (share added/removed, manager restarted)
 * the manager runs sshMountScript() over SSH instead.
 *
 *   validateGuestPath(p) -> null | 'reason'
 *   fwcfgContent(port, shares) -> string      shares: [{id, secret, guestPath, readOnly}]
 *   qemuFwCfgArgs(file) -> ['-fw_cfg', 'name=opt/devbox/shares,file=...']
 *   fstabLine(port, share, o) -> string       (alternative for hand-made VMs)
 *   sshMountScript(port, shares, o) -> string (idempotent: remounts what is
 *                                             listed; o.skipMounted keeps live mounts)
 *   sshUnmountScript(paths) -> string
 *   sshServiceScript(initd) -> string         (installs the boot-time service)
 *   parseScriptOutput(stdout) -> {boot, ok, kept, fail, gone, stuck, service}
 */

const FWCFG_NAME = 'opt/devbox/shares';
const GUEST_CFG = '/sys/firmware/qemu_fw_cfg/by_name/' + FWCFG_NAME + '/raw';
const GUEST_MODULES = ['9pnet_fd', '9p']; // modprobe pulls in 9pnet and netfs; virtio_net is needed for the network anyway
const HOST_IP = '10.0.2.2'; // slirp's alias for the host's 127.0.0.1

// System locations a share must never cover (exact or below), and top-level
// directories it must not replace as a whole.
const DENY_UNDER = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr', '/var'];
const DENY_EXACT = ['/', '/home', '/root', '/tmp', '/mnt', '/opt', '/srv', '/media'];

function validateGuestPath(p) {
  if (typeof p !== 'string' || !p) return 'guest path is required';
  if (p.length > 200) return 'guest path is too long';
  if (!/^(\/[A-Za-z0-9._@+-]+)+$/.test(p)) return 'guest path must be absolute and use only letters, digits and . _ @ + - (no spaces)';
  if (p.split('/').some((c) => c === '.' || c === '..')) return 'guest path must not contain . or .. components';
  if (DENY_EXACT.includes(p)) return 'guest path ' + p + ' would hide a system directory';
  for (const d of DENY_UNDER) if (p === d || p.startsWith(d + '/')) return 'guest path must not be under ' + d;
  return null;
}

function checkShare(s) {
  if (!s || typeof s !== 'object') throw new TypeError('share must be an object');
  if (typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.id)) throw new Error('bad share id');
  if (typeof s.secret !== 'string' || !/^[A-Za-z0-9._~+=-]{16,256}$/.test(s.secret)) throw new Error('bad share secret');
  const why = validateGuestPath(s.guestPath);
  if (why) throw new Error(why);
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
}

function fwcfgContent(port, shares) {
  checkPort(port);
  const seen = new Set();
  let out = '';
  for (const s of shares || []) {
    checkShare(s);
    if (seen.has(s.guestPath)) throw new Error('two shares use the guest path ' + s.guestPath);
    seen.add(s.guestPath);
    out += port + ' ' + s.id + ':' + s.secret + ' ' + s.guestPath + ' ' + (s.readOnly ? 'ro' : 'rw') + '\n';
  }
  return out;
}

// QEMU option values escape "," as ",,".
function qemuFwCfgArgs(file) {
  if (typeof file !== 'string' || !file) throw new Error('fw_cfg file path is required');
  return ['-fw_cfg', 'name=' + FWCFG_NAME + ',file=' + file.replace(/,/g, ',,')];
}

function options(port, s, o) {
  o = o || {};
  const opts = ['trans=tcp', 'port=' + port, 'version=9p2000.L', 'msize=' + (o.msize || 524288), 'cache=' + (o.cache || 'mmap'), 'aname=' + s.id + ':' + s.secret];
  if (s.readOnly) opts.push('ro');
  return opts;
}

function fstabLine(port, s, o) {
  checkPort(port);
  checkShare(s);
  return HOST_IP + ' ' + s.guestPath + ' 9p ' + options(port, s, o).concat(['_netdev', 'nofail']).join(',') + ' 0 0';
}

// Every line the SSH scripts print for the manager starts with MARK:
//   MARK boot <boot_id>       MARK ok <path>     (mounted now)
//   MARK kept <path>          (skipMounted: a live mount was left alone)
//   MARK fail <path>          (mount's own message is on stderr)
//   MARK gone <path>          MARK stuck <path>  (unmount script)
//   MARK service installed|present|unavailable   (sshServiceScript)
// parseScriptOutput() turns them back into an object.
const MARK = 'DEVBOX-SHARES';

// Shell helpers the scripts share. Whether a path is a mount point comes
// from /proc/mounts, NOT mountpoint(1): a mount whose server went away (the
// manager restarted - the 9p TCP transport never reconnects) fails every
// stat, so `mountpoint` calls it "not a mount point" and a new mount would
// land on top of the dead one. unmnt lazily detaches everything stacked
// there (umount -l never needs the dead server). alive = the mount answers
// a statfs within 5 s.
const SH_FUNCS = [
  "ismnt() { awk -v p=\"$1\" '$2 == p { f = 1 } END { exit !f }' /proc/mounts; }",
  'unmnt() { n=0; while ismnt "$1" && [ $n -lt 8 ]; do umount -l "$1" 2>/dev/null || break; n=$((n + 1)); done; }',
  'alive() { timeout 5 stat -f "$1" >/dev/null 2>&1; }',
];

// Shell script (POSIX sh, run as root over SSH - fed on stdin, so the secrets
// never appear on a command line): load the modules, then mount each share.
// Default: whatever is mounted at the path is detached first (after a
// manager restart every mount of the previous run is dead). o.skipMounted:
// a mount that is there AND answers is kept (after a start or a reboot,
// where the boot-time service may already have mounted it).
// Mounts carry uname=boot-<boot_id> so that the server closes this VM's
// mounts from earlier boots as soon as a new boot mounts (see the server's
// supersede()). Paths and secrets are validated to a shell-safe alphabet
// (safe inside double quotes too) before use.
function sshMountScript(port, shares, o) {
  checkPort(port);
  o = o || {};
  const lines = ['set -u'].concat(SH_FUNCS, ['modprobe -q 9pnet_fd 2>/dev/null; modprobe -q 9p 2>/dev/null', 'rc=0',
    'b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)', 'echo "' + MARK + ' boot $b"']);
  for (const s of shares || []) {
    checkShare(s);
    const p = "'" + s.guestPath + "'";
    const mount = 'if mkdir -p ' + p + ' && mount -t 9p -o "' + options(port, s, o).join(',') + '${b:+,uname=boot-$b}" ' + HOST_IP + ' ' + p +
      "; then echo '" + MARK + ' ok ' + s.guestPath + "'; else echo '" + MARK + ' fail ' + s.guestPath + "'; rc=1; fi";
    if (o.skipMounted) lines.push('if ismnt ' + p + ' && alive ' + p + "; then echo '" + MARK + ' kept ' + s.guestPath + "'; else unmnt " + p + '; ' + mount + '; fi');
    else lines.push('unmnt ' + p, mount);
  }
  lines.push('exit $rc');
  return lines.join('\n') + '\n';
}

// Guest paths that are no longer shared (to unmount over SSH when a share is removed).
function sshUnmountScript(paths) {
  const lines = SH_FUNCS.slice();
  for (const g of paths || []) {
    const why = validateGuestPath(g);
    if (why) throw new Error(why);
    lines.push("unmnt '" + g + "'; if ismnt '" + g + "'; then echo '" + MARK + ' stuck ' + g + "'; else echo '" + MARK + ' gone ' + g + "'; fi");
  }
  return lines.join('\n') + '\n';
}

// Installs the boot-time service (initd: the text of
// lib/assets/devbox-shares.initd) into a guest whose image predates it, or
// replaces an older copy; adds it to the default runlevel and makes
// qemu_fw_cfg (the share list's transport) load at boot. Idempotent and
// quiet when everything is in place; never ends the script (it is followed
// by sshMountScript). A guest without OpenRC reports "unavailable": the
// manager then mounts over SSH only.
function sshServiceScript(initd) {
  if (typeof initd !== 'string' || !initd.startsWith('#!')) throw new Error('the devbox-shares service text is required');
  const b64 = Buffer.from(initd.replace(/\r\n/g, '\n'), 'utf8').toString('base64');
  return [
    'f=/etc/init.d/devbox-shares',
    'if command -v rc-update >/dev/null 2>&1 && [ -d /etc/init.d ]; then',
    '  t=$(mktemp) || t=/tmp/devbox-shares.$$',
    "  echo '" + b64 + "' | base64 -d > \"$t\"",
    '  if [ -s "$t" ] && ! cmp -s "$t" "$f"; then',
    '    cat "$t" > "$f.new" && chmod 755 "$f.new" && mv -f "$f.new" "$f" && echo "' + MARK + ' service installed"',
    '  else echo "' + MARK + ' service present"; fi',
    '  rm -f "$t"',
    '  rc-update add devbox-shares default >/dev/null 2>&1 || true',
    "  grep -q '^qemu_fw_cfg' /etc/modules 2>/dev/null || echo qemu_fw_cfg >> /etc/modules",
    '  modprobe -q qemu_fw_cfg 2>/dev/null || true',
    'else echo "' + MARK + ' service unavailable"; fi',
  ].join('\n') + '\n';
}

// The MARK lines of a script's output -> {boot, ok, kept, fail, gone, stuck, service}.
function parseScriptOutput(text) {
  const out = { boot: null, ok: [], kept: [], fail: [], gone: [], stuck: [], service: null };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^DEVBOX-SHARES (\w+) ?(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === 'boot') out.boot = /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
    else if (m[1] === 'service') out.service = v;
    else if (Array.isArray(out[m[1]]) && v) out[m[1]].push(v);
  }
  return out;
}

module.exports = {
  FWCFG_NAME, GUEST_CFG, GUEST_MODULES, HOST_IP, MARK,
  validateGuestPath, fwcfgContent, qemuFwCfgArgs, fstabLine, sshMountScript, sshUnmountScript, sshServiceScript, parseScriptOutput,
};
