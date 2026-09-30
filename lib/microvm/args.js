'use strict';
/*
 * Docker-style text forms the container API accepts for convenience, parsed
 * into structured values. Pure: no I/O (the host environment is passed in
 * for "-e NAME"). The API validators (containers.js) call these; the GUI and
 * MCP may send structured objects instead. There is no CLI (spec section 19).
 *
 *   parsePort(s)    "19480:80" | "19480:80,lan" | "127.0.0.1:19480:80" | "8080" |
 *                   "19482:53/udp" -> {hostAddr, hostPort, guestPort, proto, lan}
 *                   (lib/ports.parsePortSpec is the app-wide parser for
 *                   VM forwards; this one keeps the Docker "-p" shapes)
 *   parseVolume(s)  "name:/path[:ro|rw][,nocopy]"
 *                       -> {kind: 'volume', name, target, readonly, nocopy}
 *                   "C:\dir:/path[:ro]" | "/home/me/x:/path" | "./x:/path"
 *                       -> {kind: 'host', hostDir, target, readonly}
 *                   A host folder becomes a LIVE shared folder (lib/shares.js,
 *                   the manager's 9P server) - no longer an error.
 *   parseCopyIn(s)  "C:\site:/usr/share/nginx/html" -> {hostDir, target}
 *   parseEnv(s, env) "K=V" -> "K=V"; "K" -> "K=<host value>" or null when unset
 *   parseSize(s, unit) "512" (in `unit`, default MiB) | "512m" | "8g" | "1t" -> bytes
 *   checkTarget(t, what, spec) -> normalised absolute container path
 *
 * Errors are UsageError (code USAGE); API callers turn them into 400s.
 */

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.code = 'USAGE'; this.status = 400; }
}

const MiB = 1048576;
const UNITS = { b: 1, k: 1024, m: MiB, g: 1024 * MiB, t: 1024 * 1024 * MiB };

function parseSize(s, unit) {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmgt])?i?b?$/i.exec(String(s).trim());
  if (!m) throw new UsageError('bad size ' + JSON.stringify(s) + ' (examples: 512, 512m, 8g)');
  const mult = m[2] ? UNITS[m[2].toLowerCase()] : (unit || MiB);
  const v = Math.floor(parseFloat(m[1]) * mult);
  if (!(v > 0)) throw new UsageError('size must be positive: ' + s);
  return v;
}

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function toPort(s, what, spec) {
  if (!/^\d+$/.test(String(s))) throw new UsageError(what + ' port must be a number in "' + spec + '"');
  const n = parseInt(s, 10);
  if (!validPort(n)) throw new UsageError(what + ' port must be 1-65535 in "' + spec + '"');
  return n;
}

// -p [ip:]host[:container][/tcp|/udp][,lan|,local]
// Default bind is 127.0.0.1 (this PC only); ",lan" (or ip 0.0.0.0) makes the
// port reachable from the network - the user's choice, never the default.
function parsePort(spec) {
  const s = String(spec).trim();
  const parts = s.split(',');
  const main = parts.shift();
  let lan = null;
  for (const f of parts) {
    const k = f.trim().toLowerCase();
    if (k === 'lan') lan = true;
    else if (k === 'local') lan = false;
    else throw new UsageError('unknown port flag "' + f + '" in "' + s + '" (use ,lan or ,local)');
  }
  let proto = 'tcp';
  let body = main;
  const pm = /\/(tcp|udp)$/i.exec(body);
  if (pm) { proto = pm[1].toLowerCase(); body = body.slice(0, pm.index); }
  const f = body.split(':');
  let addr = null, host, guest;
  if (f.length === 1) { host = f[0]; guest = f[0]; }
  else if (f.length === 2) { host = f[0]; guest = f[1]; }
  else if (f.length === 3) { addr = f[0]; host = f[1]; guest = f[2]; }
  else throw new UsageError('bad port mapping "' + s + '" (host:container[,lan])');
  const hostPort = toPort(host, 'host', s);
  const guestPort = toPort(guest, 'container', s);
  if (addr !== null) {
    if (!IPV4.test(addr)) throw new UsageError('bad bind address "' + addr + '" in "' + s + '" (IPv4 only)');
    if (addr !== '0.0.0.0' && addr !== '127.0.0.1') throw new UsageError('bind address must be 127.0.0.1 (this PC only) or 0.0.0.0 (LAN) in "' + s + '"');
    if (lan === true && addr !== '0.0.0.0') throw new UsageError('",lan" conflicts with bind address ' + addr + ' in "' + s + '"');
    if (lan === false && addr === '0.0.0.0') throw new UsageError('",local" conflicts with bind address 0.0.0.0 in "' + s + '"');
  }
  const hostAddr = addr !== null ? addr : (lan ? '0.0.0.0' : '127.0.0.1');
  return { hostAddr, hostPort, guestPort, proto, lan: hostAddr === '0.0.0.0' };
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A host path: starts with / \ . ~, or a drive letter followed by a
// backslash, or "X:/..." followed by ":/container-path" (C:/data:/data).
// "a:/x" and "a:/x:ro" are volume "a" at /x, as in Docker.
const looksLikeHostPath = (s) => /^[\\/.~]/.test(s) || /^[A-Za-z]:\\/.test(s) || /^[A-Za-z]:\/[^:]*:\//.test(s) || /^[A-Za-z]:$/.test(s);

function checkTarget(t, what, spec) {
  if (!t.startsWith('/')) throw new UsageError(what + ' target must be an absolute container path in "' + spec + '"');
  if (/(^|\/)\.\.?(\/|$)/.test(t)) throw new UsageError(what + ' target may not contain . or .. in "' + spec + '"');
  const norm = t.replace(/\/+$/, '');
  if (!norm) throw new UsageError(what + ' target cannot be / in "' + spec + '"');
  if (norm === '/.devbox' || norm.startsWith('/.devbox/')) throw new UsageError(what + ' target /.devbox is reserved');
  if (/[\n\r\0]/.test(norm)) throw new UsageError(what + ' target contains a control character');
  return norm;
}

function parseOptions(list, spec, allowed) {
  const o = { readonly: false, nocopy: false };
  for (const raw of list) {
    const k = raw.trim().toLowerCase();
    if (k === 'ro' && allowed.includes('ro')) o.readonly = true;
    else if (k === 'rw' && allowed.includes('rw')) o.readonly = false;
    else if (k === 'nocopy' && allowed.includes('nocopy')) o.nocopy = true;
    else throw new UsageError('unknown option "' + raw + '" in "' + spec + '" (' + allowed.join(', ') + ')');
  }
  return o;
}

// -v name:/path[:ro|rw][,nocopy]  or  -v HOSTDIR:/path[:ro|rw]
function parseVolume(spec) {
  const s = String(spec);
  if (looksLikeHostPath(s)) {
    // HOSTDIR may itself contain a drive colon (C:\site): split at the LAST
    // ":/" that starts the container path; a ":" after that starts options
    const i = s.lastIndexOf(':/');
    if (i <= 0) throw new UsageError('bad volume "' + s + '" (HOSTDIR:/container/path[:ro])');
    const hostDir = s.slice(0, i);
    if (/^[A-Za-z]$/.test(hostDir)) throw new UsageError('bad volume "' + s + '": missing the container path after the host folder');
    let target = s.slice(i + 1);
    let opts = [];
    const c = target.indexOf(':');
    if (c >= 0) { opts = target.slice(c + 1).split(','); target = target.slice(0, c); }
    const o = parseOptions(opts, s, ['ro', 'rw']);
    return { kind: 'host', hostDir, target: checkTarget(target, 'volume', s), readonly: o.readonly };
  }
  const i = s.indexOf(':');
  if (i <= 0) throw new UsageError('bad volume "' + s + '" (NAME:/container/path[:ro])');
  const name = s.slice(0, i);
  if (!VOLUME_NAME.test(name)) throw new UsageError('bad volume name "' + name + '" ([A-Za-z0-9][A-Za-z0-9_.-]*, at most 64)');
  let rest = s.slice(i + 1);
  let o = { readonly: false, nocopy: false };
  const j = rest.indexOf(':');
  if (j >= 0) {
    o = parseOptions(rest.slice(j + 1).split(','), s, ['ro', 'rw', 'nocopy']);
    rest = rest.slice(0, j);
  }
  return { kind: 'volume', name, target: checkTarget(rest, 'volume', s), readonly: o.readonly, nocopy: o.nocopy };
}

// --copy-in HOSTDIR:/container/path; HOSTDIR may itself contain a drive
// colon (C:\site), so the split is at the LAST ":/".
function parseCopyIn(spec) {
  const s = String(spec);
  const i = s.lastIndexOf(':/');
  if (i <= 0) throw new UsageError('bad copy-in "' + s + '" (HOSTDIR:/container/path)');
  const hostDir = s.slice(0, i);
  if (/^[A-Za-z]$/.test(hostDir)) throw new UsageError('bad copy-in "' + s + '": missing the container path after the host folder');
  return { hostDir, target: checkTarget(s.slice(i + 1), 'copy-in', s) };
}

function parseEnv(spec, env) {
  const s = String(spec);
  const i = s.indexOf('=');
  if (i === 0) throw new UsageError('bad environment variable "' + s + '"');
  if (i < 0) {
    // Docker: "-e NAME" passes the host's value, or nothing when unset
    const v = env && Object.prototype.hasOwnProperty.call(env, s) ? env[s] : undefined;
    return v === undefined ? null : s + '=' + v;
  }
  if (s.includes('\0')) throw new UsageError('environment values cannot contain NUL');
  return s;
}

module.exports = { parsePort, parseVolume, parseCopyIn, parseEnv, parseSize, checkTarget, looksLikeHostPath, UsageError, VOLUME_NAME };
