'use strict';
/*
 * Validation of container requests: an API body -> clean container fields,
 * or a 4xx that names the problem (microVM spec sections 6, 8, 9, 11).
 * Nothing here starts, writes or reserves anything; containers.js does that
 * with the result. Docker's text forms are accepted next to structured
 * values, so the GUI, MCP and plain curl can all use the API:
 *
 *   splitCommand(s)              "sh -c 'echo hi'" -> ['sh', '-c', 'echo hi']
 *   argvField(v, label)          null (image default) | [] | [strings]
 *   envField(v)                  ['K=V'] from ['K=V'] | {K: V} | "K=V\nK2=V2"
 *   portsField(v, o)             null (publish the image's EXPOSE ports) |
 *                                [{host, guest, proto, lan, auto:false}]
 *   mountsField(body, o)         {volumes, shares, copyIn}: named volumes,
 *                                LIVE host folders (shared through the
 *                                manager's 9P server, lib/shares.js) and
 *                                explicit one-way copy-in folders
 *   runFields(body, o)           every run option, including the above
 *   imageRef(v)                  a parsed reference or 400 BAD_REFERENCE
 *
 * Mounts: "name:/path[:ro][,nocopy]" is a named volume; "C:\dir:/path[:ro]"
 * (any absolute host path) is a LIVE shared folder - edits on either side
 * show up on the other at once; objects {name|hostPath, target, readonly,
 * nocopy, copyIn}. copyIn:true (or the separate copyIn list) packs the
 * folder into the VM once at start instead (faster for huge trees such as
 * node_modules, but one-way). Targets must not collide, a named volume is
 * mounted once per container, and nothing may be mounted over /proc, /sys,
 * /dev or the engine's /.devbox. Nesting is allowed (a volume under a
 * shared folder, as in Docker): init mounts parents first.
 */
const { CFG } = require('../config');
const args = require('./args');
const initramfs = require('./initramfs');
const { ApiError, badRequest, toBool, intInRange } = require('../util');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ENV_NAME_RE = /^[^=\0\s]{1,256}$/;
const LIMITS = { argv: 512, argBytes: 16384, env: 1024, envBytes: 30 * 1024, ports: 64, volumes: 16, copyIn: 16, note: 500 };
const RESERVED_TARGETS = ['/proc', '/sys', '/dev'];
const ACCELS = ['auto', 'whpx', 'kvm', 'hvf', 'tcg'];
const MACHINES = ['auto', 'microvm', 'q35'];
const PULLS = ['missing', 'always', 'never'];
const ENGINES = ['auto', 'microvm', 'docker-vm'];

const has = (v) => v !== undefined && v !== null;

// Shell-like word splitting WITHOUT a shell: quotes group, backslash
// escapes, nothing is expanded. For text commands from the GUI or curl.
function splitCommand(s) {
  const out = [];
  let cur = '', inWord = false, q = null;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < str.length && '"\\$`'.includes(str[i + 1])) cur += str[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; inWord = true; continue; }
    if (c === '\\' && i + 1 < str.length) { cur += str[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } continue; }
    cur += c;
    inWord = true;
  }
  if (q) throw badRequest('unbalanced ' + q + ' quote in the command');
  if (inWord) out.push(cur);
  return out;
}

function argvField(v, label) {
  if (!has(v)) return null;
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? splitCommand(v) : null);
  if (!list) throw badRequest(label + ' must be a list of strings (or one string)');
  if (list.length > LIMITS.argv) throw badRequest(label + ' has too many arguments');
  return list.map((x) => {
    if (typeof x !== 'string' && typeof x !== 'number') throw badRequest(label + ' entries must be strings');
    const s = String(x);
    if (s.includes('\0')) throw badRequest(label + ' cannot contain a NUL character');
    if (Buffer.byteLength(s) > LIMITS.argBytes) throw badRequest(label + ' has an argument longer than ' + LIMITS.argBytes + ' bytes');
    return s;
  });
}

// Environment for the container: K=V entries (values are secrets: never
// logged or listed). "K" without a value is refused - Docker would copy the
// variable from the caller's environment, which here would be the
// manager's own.
function envField(v) {
  if (!has(v) || v === '') return [];
  let list;
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'object') list = Object.keys(v).map((k) => k + '=' + (v[k] === null || v[k] === undefined ? '' : String(v[k])));
  else if (typeof v === 'string') list = v.split(/\r?\n/).filter((x) => x.trim());
  else throw badRequest('env must be a list of K=V entries or an object');
  if (list.length > LIMITS.env) throw badRequest('too many environment variables (at most ' + LIMITS.env + ')');
  let bytes = 0;
  const seen = new Map();
  for (const e of list) {
    if (typeof e !== 'string') throw badRequest('env entries must be strings like K=V');
    const i = e.indexOf('=');
    if (i <= 0) throw badRequest('env entries must be K=V (got "' + e.slice(0, 40) + '")');
    const name = e.slice(0, i);
    if (!ENV_NAME_RE.test(name)) throw badRequest('bad environment variable name "' + name.slice(0, 40) + '"');
    if (e.includes('\0')) throw badRequest('environment values cannot contain NUL');
    bytes += Buffer.byteLength(e) + 4;
    seen.set(name, e); // a later entry replaces an earlier one
  }
  if (bytes > LIMITS.envBytes) {
    throw badRequest('the environment is ' + Math.ceil(bytes / 1024) + ' KB; a microVM takes at most ' + Math.round(LIMITS.envBytes / 1024) + ' KB - put large configuration into a file and use copy-in', { code: 'SPEC_TOO_LARGE' });
  }
  return Array.from(seen.values());
}

// Ports: Docker's "-p" forms and the app's own:
//   "8080:80", "8080:80/udp", "8080" (same inside), "lan:8080:80",
//   "8080:80,lan", "127.0.0.1:8080:80", "0.0.0.0:8080:80",
//   {host, guest|container, proto, lan}
// o: {defaultLan}. undefined/null -> null: publish the image's EXPOSE ports.
function portsField(v, o) {
  o = o || {};
  if (!has(v)) return null;
  const items = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[\r\n]+|,(?!\s*(?:lan|local)\b)/i) : null);
  if (!items) throw badRequest('ports must be a list like ["8080:80", "lan:3000"]');
  if (items.length > LIMITS.ports) throw badRequest('too many published ports (at most ' + LIMITS.ports + ')');
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    let m;
    if (raw && typeof raw === 'object') {
      const host = parseInt(raw.host, 10);
      const guest = has(raw.guest) && raw.guest !== '' ? parseInt(raw.guest, 10) : (has(raw.container) && raw.container !== '' ? parseInt(raw.container, 10) : host);
      const proto = has(raw.proto) && raw.proto !== '' ? String(raw.proto).toLowerCase() : 'tcp';
      if (!(host >= 1 && host <= 65535) || String(host) !== String(raw.host).trim()) throw badRequest('host port must be 1-65535 (got ' + JSON.stringify(raw.host) + ')');
      if (!(guest >= 1 && guest <= 65535)) throw badRequest('container port must be 1-65535');
      if (proto !== 'tcp' && proto !== 'udp') throw badRequest('"proto" must be tcp or udp');
      const lan = has(raw.lan) ? toBool(raw.lan, false) : !!o.defaultLan;
      m = { host, guest, proto, lan };
    } else {
      const s = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!s) continue;
      const pre = /^(lan|local):(.+)$/i.exec(s);
      let p;
      try { p = args.parsePort(pre ? pre[2] : s); } catch (e) { throw badRequest(e.message); }
      let lan = p.lan;
      const explicitBind = /^(0\.0\.0\.0|127\.0\.0\.1):/.test(pre ? pre[2] : s) || /,\s*(lan|local)\s*$/i.test(s);
      if (pre) {
        if (explicitBind && (pre[1].toLowerCase() === 'lan') !== p.lan) throw badRequest('conflicting exposure in "' + s + '"');
        lan = pre[1].toLowerCase() === 'lan';
      } else if (!explicitBind) lan = !!o.defaultLan;
      m = { host: p.hostPort, guest: p.guestPort, proto: p.proto, lan };
    }
    const key = m.proto + ':' + m.host;
    if (seen.has(key)) throw badRequest('host port ' + m.host + (m.proto === 'udp' ? '/udp' : '') + ' is listed twice');
    seen.add(key);
    m.auto = false;
    out.push(m);
  }
  return out;
}

function targetOf(t, what, spec) {
  let norm;
  try { norm = args.checkTarget(String(t || ''), what, spec || String(t)); } catch (e) { throw badRequest(e.message); }
  for (const r of RESERVED_TARGETS) {
    if (norm === r || norm.startsWith(r + '/')) throw badRequest(what + ' target ' + norm + ' would hide the system directory ' + r);
  }
  return norm;
}
const inside = (a, b) => a === b || a.startsWith(b + '/');

// Mounts from body.volumes (+ body.copyIn). o: {validateHostDir(hostPath) ->
// {hostPath, warnings}} (lib/shares.validateShare's host-side checks: the
// folder exists, is not the data root or a system folder), maxShares.
function mountsField(body, o) {
  o = o || {};
  const out = { volumes: [], shares: [], copyIn: [], warnings: [] };
  const raw = has(body.volumes) ? body.volumes : [];
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null);
  if (!list) throw badRequest('volumes must be a list like ["pgdata:/var/lib/postgresql/data", "C:\\\\site:/usr/share/nginx/html"]');
  if (list.length > LIMITS.volumes) throw badRequest('too many volumes (at most ' + LIMITS.volumes + ')');
  const hostDir = (p, what) => {
    const r = o.validateHostDir ? o.validateHostDir(p, what) : { hostPath: p, warnings: [] };
    for (const w of r.warnings || []) out.warnings.push(w);
    return r.hostPath;
  };
  for (const v of list) {
    let e;
    if (v && typeof v === 'object') {
      const src = v.hostPath || v.hostDir || v.source;
      const target = targetOf(v.target || v.guestPath, 'volume', JSON.stringify(v).slice(0, 80));
      if (src) e = { kind: 'host', hostDir: String(src), target, readonly: toBool(has(v.readOnly) ? v.readOnly : v.readonly, false), copyIn: toBool(v.copyIn, false) };
      else if (v.name) {
        if (!args.VOLUME_NAME.test(String(v.name))) throw badRequest('bad volume name "' + String(v.name).slice(0, 64) + '"');
        e = { kind: 'volume', name: String(v.name), target, readonly: toBool(has(v.readOnly) ? v.readOnly : v.readonly, false), nocopy: toBool(v.nocopy, false) };
      } else throw badRequest('a volume needs a name (named volume) or a hostPath (a folder on this PC)');
    } else {
      try { e = args.parseVolume(String(v)); } catch (x) { throw badRequest(x.message); }
      e.target = targetOf(e.target, 'volume', String(v));
    }
    if (e.kind === 'volume') {
      if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(e.name)) throw badRequest('volume name "' + e.name + '" is reserved on Windows');
      out.volumes.push({ name: e.name, target: e.target, readonly: !!e.readonly, nocopy: !!e.nocopy });
    } else if (e.copyIn) {
      if (e.readonly) out.warnings.push('copy-in of ' + e.hostDir + ' ignores "read-only" (the files are a copy)');
      out.copyIn.push({ hostDir: hostDir(e.hostDir, 'copy-in'), target: e.target });
    } else {
      if (/\s/.test(e.target)) throw badRequest('a shared folder target cannot contain spaces: ' + e.target);
      out.shares.push({ hostPath: hostDir(e.hostDir, 'shared folder'), guestPath: e.target, readOnly: !!e.readonly });
    }
  }
  const ci = has(body.copyIn) ? body.copyIn : [];
  const ciList = Array.isArray(ci) ? ci : (typeof ci === 'string' ? ci.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null);
  if (!ciList) throw badRequest('copyIn must be a list like ["C:\\\\site:/usr/share/nginx/html"]');
  for (const c of ciList) {
    let e;
    if (c && typeof c === 'object') e = { hostDir: String(c.hostDir || c.hostPath || c.source || ''), target: c.target || c.guestPath };
    else { try { e = args.parseCopyIn(String(c)); } catch (x) { throw badRequest(x.message); } }
    if (!e.hostDir) throw badRequest('a copy-in entry needs the folder on this PC (hostDir)');
    out.copyIn.push({ hostDir: hostDir(e.hostDir, 'copy-in'), target: targetOf(e.target, 'copy-in') });
  }
  if (out.copyIn.length > LIMITS.copyIn) throw badRequest('too many copy-in folders (at most ' + LIMITS.copyIn + ')');
  if (out.shares.length > (o.maxShares || 8)) throw badRequest('at most ' + (o.maxShares || 8) + ' shared folders per container');
  // one volume, one attachment (correct-2): two targets of the same volume
  // would be two disks on ONE qcow2 file, both mounted read-write - ext4
  // mounted twice is corrupted (names are case-insensitive: one file)
  const vnames = new Map();
  for (const v of out.volumes) {
    const k = v.name.toLowerCase();
    if (vnames.has(k)) throw badRequest('volume "' + v.name + '" is listed twice (at ' + vnames.get(k) + ' and ' + v.target + ') - a volume can be mounted once per container');
    vnames.set(k, v.target);
  }
  // one target per mount; copy-in never writes into a live share (it would
  // change the user's folder on this PC)
  const mounts = out.volumes.map((x) => ['volume', x.target]).concat(out.shares.map((x) => ['shared folder', x.guestPath]));
  const seen = new Map();
  for (const [what, t] of mounts) {
    if (seen.has(t)) throw badRequest('two mounts use the target ' + t + ' (' + seen.get(t) + ' and ' + what + ')');
    seen.set(t, what);
  }
  const ciSeen = new Set();
  for (const c of out.copyIn) {
    if (ciSeen.has(c.target)) throw badRequest('two copy-in folders use the target ' + c.target);
    ciSeen.add(c.target);
    const s = out.shares.find((x) => inside(c.target, x.guestPath));
    if (s) throw badRequest('copy-in target ' + c.target + ' is inside the shared folder at ' + s.guestPath + ' - copy-in there would change the folder on this PC');
  }
  return out;
}

function imageRef(v) {
  if (typeof v !== 'string' || !v.trim()) throw badRequest('image is required (e.g. nginx:alpine)', { code: 'BAD_REFERENCE' });
  const registry = require('../oci/registry');
  try { return registry.parseImageRef(v.trim()); } catch (e) { throw new ApiError(400, 'BAD_REFERENCE', e.message); }
}

function oneOf(v, list, def, label) {
  if (!has(v) || v === '') return def;
  const s = String(v).toLowerCase();
  if (!list.includes(s)) throw badRequest(label + ' must be one of ' + list.join(', '));
  return s;
}

const createdByOf = (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : 'api');

function nameField(v) {
  if (!has(v) || v === '') return null;
  const s = String(v);
  if (!NAME_RE.test(s)) throw badRequest('container name must be 1-63 letters, digits and . _ - (starting with a letter or digit)');
  return s;
}

// All run options except the image and the mounts. o: {defaultLan}.
function runFields(body, o) {
  o = o || {};
  const f = {};
  f.name = nameField(body.name);
  f.cmd = argvField(has(body.cmd) ? body.cmd : body.command, 'cmd');
  f.entrypoint = argvField(body.entrypoint, 'entrypoint');
  f.env = envField(body.env);
  f.lan = has(body.lan) ? toBool(body.lan, false) : !!o.defaultLan;
  f.ports = portsField(body.ports, { defaultLan: f.lan });
  if (has(body.workdir) && body.workdir !== '') {
    const w = String(body.workdir);
    if (!w.startsWith('/') || /[\0\n\r]/.test(w) || w.length > 1024) throw badRequest('workdir must be an absolute path in the container');
    f.workdir = w;
  } else f.workdir = null;
  if (has(body.user) && body.user !== '') {
    const u = String(body.user);
    if (!USER_RE.test(u)) throw badRequest('user must be a name or uid, optionally with :group or :gid');
    f.user = u;
  } else f.user = null;
  if (has(body.hostname) && body.hostname !== '') {
    if (!HOSTNAME_RE.test(String(body.hostname))) throw badRequest('bad hostname (letters, digits and -, at most 63)');
    f.hostname = String(body.hostname);
  } else f.hostname = null;
  f.mem = has(body.mem) && body.mem !== '' ? intInRange(body.mem, 128, CFG.maxMem, null, 'Memory (MB)') : null;
  f.cpus = intInRange(body.cpus, 1, CFG.maxCpus || 64, 1, 'vCPUs');
  f.accel = oneOf(body.accel, ACCELS, 'auto', 'accel');
  f.machine = oneOf(body.machine, MACHINES, 'auto', 'machine');
  const net = oneOf(body.network, ['default', 'none', 'bridge'], 'default', 'network');
  f.network = net === 'none' ? 'none' : 'default';
  if (has(body.stopSignal) && body.stopSignal !== '') {
    try { f.stopSignal = initramfs.normSignal(body.stopSignal); } catch (e) { throw badRequest(e.message); }
  } else f.stopSignal = null;
  f.stopTimeout = intInRange(body.stopTimeout, 0, 3600, 10, 'stopTimeout (s)');
  f.pull = oneOf(body.pull, PULLS, 'missing', 'pull');
  f.autoRemove = toBool(has(body.autoRemove) ? body.autoRemove : body.rm, false);
  f.autostart = toBool(body.autostart, false);
  f.ephemeral = toBool(body.ephemeral, false);
  // who made it (gui, mcp, claude, api...): the same lenient rule as VMs
  f.createdBy = createdByOf(body.createdBy);
  f.copyInOwner = oneOf(body.copyInOwner, ['user', 'root'], 'user', 'copyInOwner');
  f.note = has(body.note) ? String(body.note).slice(0, LIMITS.note) : '';
  if (f.autoRemove && f.autostart) throw badRequest('autostart and "remove when it exits" cannot both be on');
  return f;
}

module.exports = {
  splitCommand, argvField, envField, portsField, mountsField, runFields, imageRef, nameField, targetOf, createdByOf,
  NAME_RE, USER_RE, HOSTNAME_RE, LIMITS, ENGINES, ACCELS, MACHINES, PULLS,
};
