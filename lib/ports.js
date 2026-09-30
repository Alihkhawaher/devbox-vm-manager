'use strict';
/*
 * Host port forwards - ONE parser and validator for the whole app (MNT-5),
 * plus reservation, free checks and allocation (spec section 7).
 *
 * A mapping is {host, guest, container?, owner?, lan}:
 *   host      - the port on this PC that QEMU listens on
 *   guest     - the port inside the VM it forwards to
 *   container - (deploys) the port the container listens on inside the VM
 *   owner     - (deploys) the container that owns the mapping
 *   lan       - the USER'S CHOICE of exposure: false = this PC only
 *               (hostfwd bound to 127.0.0.1, the default), true = reachable
 *               from other devices on the network (bound to 0.0.0.0)
 *
 *   proto     - 'udp' for a UDP forward; absent means TCP (the only kind
 *               VMs used before microVM containers, so old records and
 *               replies are unchanged). Only TCP forwards get URLs.
 *
 * Text form (API/MCP convenience; the GUI uses row editors): entries separated
 * by commas or newlines, each [lan:|local:|0.0.0.0:|127.0.0.1:]host[:guest][/udp],
 * e.g. "8080:80", "lan:3000:3000", "0.0.0.0:8123", "5353:53/udp". Without a
 * prefix the caller's default applies (settings.defaultExpose, "local" out of
 * the box).
 *
 * Reservations cover VMs AND microVM containers: reservedPorts() adds every
 * container record's host ports, running or not, and their pending claims
 * (lib/microvm/containers.js reservedPorts(), loaded lazily - it requires
 * this module), so VMs, deploys and containers never collide.
 */
const { CFG } = require('./config');
const { state } = require('./state');
const platform = require('./platform');
const { ApiError, badRequest, toInt } = require('./util');

const PREFIX_LAN = { lan: true, '0.0.0.0': true, local: false, '127.0.0.1': false };

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const bindAddress = (lan) => (lan ? '0.0.0.0' : '127.0.0.1');

const protoOf = (m) => (m && m.proto === 'udp' ? 'udp' : 'tcp');

// QEMU hostfwd rule for a mapping: "tcp:127.0.0.1:8080-:80"
function hostfwdRule(m) { return protoOf(m) + ':' + bindAddress(!!m.lan) + ':' + m.host + '-:' + m.guest; }
// The host side only, as hostfwd_remove wants it: "tcp:127.0.0.1:8080"
function hostfwdHost(m) { return protoOf(m) + ':' + bindAddress(!!m.lan) + ':' + m.host; }

function describe(m) {
  return m.host + ' -> ' + m.guest + (protoOf(m) === 'udp' ? '/udp' : '') + (m.container && m.container !== m.guest ? ' (container ' + m.container + ')' : '') +
    (m.lan ? ' [LAN]' : ' [this PC only]');
}
function urlFor(m) { return { url: 'http://127.0.0.1:' + m.host, lan: !!m.lan, host: m.host }; }

function defaultLanOf(opts) {
  if (opts.defaultLan !== undefined) return !!opts.defaultLan;
  const exp = opts.defaultExpose !== undefined ? opts.defaultExpose : (state.settings && state.settings.defaultExpose);
  return exp === 'lan';
}

// One mapping object from the API -> a clean mapping (or a 400).
function normalizeMapping(obj, opts) {
  opts = opts || {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badRequest('each port mapping must be an object like {host: 8080, guest: 80}');
  const host = toInt(obj.host);
  const guest = obj.guest === undefined || obj.guest === null || obj.guest === '' ? host : toInt(obj.guest);
  if (!validPort(host)) throw badRequest('host port must be 1-65535 (got ' + JSON.stringify(obj.host) + ')');
  if (!validPort(guest)) throw badRequest('guest port must be 1-65535 (got ' + JSON.stringify(obj.guest) + ')');
  const m = { host: host, guest: guest };
  if (obj.container !== undefined && obj.container !== null && obj.container !== '') {
    const c = toInt(obj.container);
    if (!validPort(c)) throw badRequest('container port must be 1-65535');
    m.container = c;
  }
  if (obj.owner !== undefined && obj.owner !== null && obj.owner !== '') {
    if (typeof obj.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(obj.owner)) throw badRequest('bad owner name for port ' + host);
    m.owner = obj.owner;
  }
  if (obj.lan === undefined || obj.lan === null) m.lan = defaultLanOf(opts);
  else if (typeof obj.lan === 'boolean') m.lan = obj.lan;
  else if (obj.lan === 'true' || obj.lan === 'false') m.lan = obj.lan === 'true';
  else throw badRequest('"lan" must be true or false');
  if (obj.proto !== undefined && obj.proto !== null && obj.proto !== '') {
    const p = String(obj.proto).toLowerCase();
    if (p !== 'tcp' && p !== 'udp') throw badRequest('"proto" must be tcp or udp');
    if (p === 'udp') m.proto = 'udp';
  }
  return m;
}

// Parse a text spec OR an array (of strings or mapping objects) into clean
// mappings. Checks syntax, range, duplicates and the VM's own SSH port; the
// cross-VM checks are validateMappings()'s job.
//   opts: {sshPort?, defaultLan?, defaultExpose?}; a bare number = sshPort (v1 form)
function parsePortSpec(spec, opts) {
  if (typeof opts === 'number') opts = { sshPort: opts };
  opts = opts || {};
  const items = Array.isArray(spec) ? spec
    : (spec === undefined || spec === null ? [] : String(spec).split(/[,\r\n]+/));
  const out = [];
  for (const item of items) {
    if (item && typeof item === 'object') { out.push(normalizeMapping(item, opts)); continue; }
    const t = String(item === undefined || item === null ? '' : item).trim();
    if (!t) continue;
    const m = t.match(/^(?:(lan|local|0\.0\.0\.0|127\.0\.0\.1):)?(\d{1,5})(?::(\d{1,5}))?(?:\/(tcp|udp))?$/i);
    if (!m) throw badRequest('bad port mapping "' + t + '" - use [lan:]host[:guest][/udp], e.g. 8080:80 or lan:3000');
    const host = parseInt(m[2], 10);
    const guest = parseInt(m[3] || m[2], 10);
    if (!validPort(host) || !validPort(guest)) throw badRequest('port out of range (1-65535): ' + t);
    const row = { host: host, guest: guest, lan: m[1] ? PREFIX_LAN[m[1].toLowerCase()] : defaultLanOf(opts) };
    if (m[4] && m[4].toLowerCase() === 'udp') row.proto = 'udp';
    out.push(row);
  }
  const seen = new Set();
  for (const m of out) {
    if (opts.sshPort && m.host === opts.sshPort && protoOf(m) === 'tcp') throw badRequest('port ' + m.host + ' is this VM\'s SSH port');
    // one TCP and one UDP forward may share a host port number
    const key = protoOf(m) + ':' + m.host;
    if (seen.has(key)) throw badRequest('duplicate host port ' + m.host + (protoOf(m) === 'udp' ? '/udp' : ''));
    seen.add(key);
  }
  return out;
}

// Keep the container/owner metadata of rows the user did not change, so a
// settings save never orphans a deployed app's ports (BUG-10, MNT-1).
function mergeMappings(oldList, newList) {
  const old = oldList || [];
  return (newList || []).map((m) => {
    if (m.owner !== undefined || m.container !== undefined) return m;
    const prev = old.find((o) => o.host === m.host && o.guest === m.guest);
    if (!prev) return m;
    const out = Object.assign({}, m);
    if (prev.container !== undefined) out.container = prev.container;
    if (prev.owner !== undefined) out.owner = prev.owner;
    return out;
  });
}

// ---------------------------------------------------------------------------
// reservation
// ---------------------------------------------------------------------------
// Ports promised to an operation that is not in the registry yet: an SSH port
// just allocated, the forwards of a VM being created, a port change or a
// deploy between its check and its commit. Without a claim, two such
// operations on DIFFERENT VMs (which hold different locks) both pass the
// registry check and both take the same host port (found in a review: two
// forward_port calls at once saved one host port on two VMs).
//   owner: the VM the claim is for (its own later checks ignore it, like
//   its registry forwards with exceptVm); none = anonymous.
const claimed = new Map(); // port -> {exp, owner}
function claim(port, ms, owner) { claimed.set(port, { exp: Date.now() + (ms || 120000), owner: owner || null }); }
// Drop a claim. With an owner, only that owner's claim (another operation may
// have claimed the port since - never drop theirs).
function release(port, owner) {
  const c = claimed.get(port);
  if (!c) return;
  if (owner && c.owner && c.owner !== owner) return;
  claimed.delete(port);
}
// Validators that claim ports list them in args.claimed; when the task then
// cannot start (409 BUSY) http.js hands them back here at once.
function releaseClaims(args) {
  if (!args || !Array.isArray(args.claimed)) return;
  for (const p of args.claimed) release(p, args.name);
}
// Tests only: forget every claim.
function _resetClaims() { claimed.clear(); }

// Every host port the manager already uses or has promised, with who uses it.
//   opts.exceptVm: ignore that VM's app forwards and claims (they are being
//                  replaced by the caller)
function reservedPorts(opts) {
  opts = opts || {};
  const r = new Map();
  const add = (p, why) => { if (p && !r.has(p)) r.set(p, why); };
  add(CFG.serverPort, 'the VM manager itself');
  add(CFG.bakeSshPort, 'the base-image build (SSH)');
  // the shared-folder (9P) server: running guests' mounts name its port, so
  // a forward there must be refused as the manager's, not reported as
  // "another program" (and must never push the server to another port)
  add(CFG.ninepPort || 5640, 'the shared-folder server of the VM manager');
  try {
    const live = require('./shares').port();
    if (live) add(live, 'the shared-folder server of the VM manager');
  } catch (e) { /* not loaded */ }
  for (const name of Object.keys(state.vms)) {
    const vm = state.vms[name];
    add(vm.port, 'the SSH port of VM "' + name + '"');
    if (name !== opts.exceptVm) {
      for (const m of vm.ports || []) add(m.host, 'a port forward of VM "' + name + '"');
    }
    const rt = vm.runtime;
    if (rt && rt.monitor && rt.monitor.port) add(rt.monitor.port, 'the QEMU monitor of VM "' + name + '"');
    if (rt && rt.serial && rt.serial.port) add(rt.serial.port, 'the serial console of VM "' + name + '"');
  }
  const now = Date.now();
  for (const [p, c] of claimed) {
    if (c.exp < now) { claimed.delete(p); continue; }
    if (c.owner && c.owner === opts.exceptVm) continue;
    // containers claim as "ctr:<id>" (a settings change being saved)
    if (c.owner && opts.exceptContainer && c.owner === 'ctr:' + opts.exceptContainer) continue;
    add(p, !c.owner ? 'a VM that is being created'
      : /^ctr:/.test(c.owner) ? 'a change being made to a container' : 'a change being made to VM "' + c.owner + '"');
  }
  // microVM containers: every record's ports, running or not (a later Start
  // must not find its port taken). Lazy: containers.js requires this module.
  const containers = require('./microvm/containers');
  for (const x of containers.reservedPorts({ exceptContainer: opts.exceptContainer }) || []) add(x.port, x.why);
  return r;
}

class PortConflict extends ApiError {
  constructor(msg) { super(409, 'PORT_CONFLICT', msg); }
}

// The synchronous part of validateMappings: syntax-level duplicates, the VM's
// own SSH port, and every port the manager has already used or promised.
function checkMappings(vmName, list, opts) {
  opts = opts || {};
  const vm = state.vms[vmName];
  const sshPort = opts.sshPort || (vm && vm.port) || null;
  const reserved = reservedPorts({ exceptVm: vmName });
  const seen = new Set();
  for (const m of list) {
    if (sshPort && m.host === sshPort) throw badRequest('host port ' + m.host + ' is the SSH port of this VM');
    if (seen.has(m.host)) throw badRequest('duplicate host port ' + m.host);
    seen.add(m.host);
    const why = reserved.get(m.host);
    if (why) throw new PortConflict('host port ' + m.host + ' is already used by ' + why);
  }
  return list;
}

// Check a VM's complete mapping list against everything else.
//   opts.sshPort    - the VM's SSH port (defaults to the record's)
//   opts.claim      - host ports to CLAIM for vmName right after the registry
//                     check, before anything is awaited, so a concurrent
//                     operation on another VM sees them (the caller releases
//                     them once its registry change is saved; on a rejection
//                     here they are released already)
//   opts.claimMs    - how long an unreleased claim lasts (default 2 min)
//   opts.checkFree  - host ports that must ALSO be free in the OS right now
//                     (the ones about to be bound on a running VM)
// Resolves with the list; rejects with a 400/409 naming the conflict.
async function validateMappings(vmName, list, opts) {
  opts = opts || {};
  checkMappings(vmName, list, opts);
  const mine = [];
  for (const p of opts.claim || []) { claim(p, opts.claimMs, vmName); mine.push(p); }
  try {
    for (const p of opts.checkFree || []) {
      if (!(await platform.isPortFree(p))) throw new PortConflict('host port ' + p + ' is in use by another program on this PC - pick another port');
    }
  } catch (e) {
    for (const p of mine) release(p, vmName);
    throw e;
  }
  return list;
}

// ---------------------------------------------------------------------------
// allocation
// ---------------------------------------------------------------------------
// Allocations run one at a time, so two concurrent creates cannot pick the
// same port between "is it free?" and "record it".
let allocChain = Promise.resolve();
function serial(fn) {
  const p = allocChain.then(fn, fn);
  allocChain = p.catch(() => {});
  return p;
}

// Lowest SSH port from firstSshPort that is neither reserved nor in use. The
// port stays claimed for 2 minutes (release() once it is in the registry).
function allocSshPort() {
  return serial(async () => {
    const reserved = reservedPorts();
    for (let p = CFG.firstSshPort; p <= 65535; p++) {
      if (reserved.has(p)) continue;
      if (await platform.isPortFree(p)) { claim(p); return p; }
    }
    throw new ApiError(409, 'NO_FREE_PORT', 'no free port found for SSH');
  });
}

// The preferred host port if usable, else the next usable one above it.
//   opts.taken: extra ports to skip (e.g. ones planned in the same request)
function allocHostPort(preferred, opts) {
  opts = opts || {};
  return serial(async () => {
    const reserved = reservedPorts({ exceptVm: opts.exceptVm });
    const taken = opts.taken || new Set();
    const start = validPort(preferred) ? preferred : 8000;
    for (let p = start, n = 0; p <= 65535 && n < 500; p++, n++) {
      if (reserved.has(p) || taken.has(p)) continue;
      if (await platform.isPortFree(p)) { claim(p); return p; }
    }
    throw new ApiError(409, 'NO_FREE_PORT', 'no free host port found near ' + start);
  });
}

module.exports = {
  bindAddress, hostfwdRule, hostfwdHost, describe, urlFor,
  normalizeMapping, parsePortSpec, mergeMappings,
  reservedPorts, checkMappings, validateMappings, PortConflict,
  allocSshPort, allocHostPort, claim, release, releaseClaims, _resetClaims,
  validPort, protoOf,
};
