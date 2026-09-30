'use strict';
/*
 * QEMU human monitor (HMP) client.
 *
 * Every VM gets a private monitor socket (spec section 8/9): TCP on
 * platform.internalHost() (Windows: a random 127.x.y.z per start - out of the
 * guests' reach, because slirp maps 10.0.2.2 to 127.0.0.1 only, and not
 * guessable by a web page) or a unix socket in a private folder on
 * Linux/macOS. An endpoint is {host, port} or {path}. HMP has no password
 * and can run programs as the user, so the endpoint is the secret.
 *
 * Protocol, as QEMU 10 actually speaks it over a socket in readline mode:
 *   on connect : "QEMU 10.2.0 monitor - type 'help' ...\r\n(qemu) "
 *   we send    : "<command>\n"
 *   it answers : the echo of the command (redrawn with ANSI escapes, no CR/LF),
 *                "\r\n", the reply lines, then the next "(qemu) " prompt.
 * So: wait for the FIRST prompt before sending (XTR-15 - v1 took the banner
 * for the reply), then collect until the next prompt and keep what lies
 * between the end of the echo line and that prompt.
 *
 * Uses: live port forwards (hostfwd_add/remove WITH the bind address, so the
 * user's local/LAN choice holds for live changes too), confirmed with
 * `info usernet` (the list of forwards QEMU really has bound - XTR-15: never
 * "something answers on that port", which may be another program),
 * system_powerdown, quit.
 */
const net = require('net');
const ports = require('./ports');
const { portListening, sleep } = require('./util');

const ESC_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function stripAnsi(s) { return String(s).replace(ESC_RE, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b/g, ''); }

// raw = everything received after the command was sent. Pure.
function parseHmpReply(raw) {
  let s = String(raw || '');
  const pi = s.lastIndexOf('(qemu)');
  if (pi >= 0) s = s.slice(0, pi);
  // the echo line ends at the first line break
  const nl = s.indexOf('\n');
  s = nl >= 0 ? s.slice(nl + 1) : '';
  return stripAnsi(s).replace(/\r/g, '').replace(/\n+$/, '').trim();
}

// Did the reply report a failure? Success is usually an empty reply.
function isHmpError(text) {
  return /\b(error|could not|invalid|unknown command|not found|failed|no such|unable)\b/i.test(String(text || ''));
}

// The host forwards in an `info usernet` reply. QEMU 6-10 print one row per
// socket; forwards look like (a '*' source address means 0.0.0.0):
//   "  TCP[HOST_FORWARD] 3d0       127.0.0.1 18731       10.0.2.15    22     0     0"
// Pure: [{proto, address, host, guestAddress, guest}].
function parseUsernet(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(TCP|UDP)\[HOST_FORWARD\]\s+\S+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\b/i);
    if (!m) continue;
    out.push({
      proto: m[1].toLowerCase(), address: m[2] === '*' ? '0.0.0.0' : m[2], host: parseInt(m[3], 10),
      guestAddress: m[4], guest: parseInt(m[5], 10),
    });
  }
  return out;
}

// One command at a time per monitor: QEMU's socket chardev serves a single
// client, a second connection would just wait (and could time out).
const chains = new Map();
function keyOf(ep) { return ep.path ? 'p:' + ep.path : 't:' + ep.host + ':' + ep.port; }

function rawCommand(endpoint, cmd, opts) {
  return new Promise((resolve) => {
    let buf = '', phase = 'banner', settled = false, sock = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch (e) {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({
      ok: false, text: parseHmpReply(buf),
      error: phase === 'banner' ? 'the QEMU monitor did not answer' : 'the QEMU monitor did not finish "' + cmd + '" in time',
    }), opts.timeoutMs || 8000);
    try {
      sock = endpoint.path ? net.connect({ path: endpoint.path }) : net.connect({ host: endpoint.host, port: endpoint.port });
    } catch (e) { return finish({ ok: false, text: '', error: 'cannot reach the QEMU monitor: ' + e.message }); }
    // After "quit" QEMU exits and the connection drops (reset or close):
    // that IS the success signal.
    sock.on('error', (e) => finish(phase === 'reply' && opts.expectClose
      ? { ok: true, text: parseHmpReply(buf), error: null }
      : { ok: false, text: '', error: 'cannot reach the QEMU monitor: ' + e.message }));
    sock.on('close', () => finish(phase === 'reply' && opts.expectClose
      ? { ok: true, text: parseHmpReply(buf), error: null }
      : { ok: false, text: parseHmpReply(buf), error: 'the QEMU monitor closed the connection' }));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (phase === 'banner') {
        if (buf.indexOf('(qemu) ') === -1) return;
        phase = 'reply';
        buf = '';
        sock.write(cmd + '\n');
        return;
      }
      if (/\(qemu\) ?$/.test(buf)) {
        const text = parseHmpReply(buf);
        const bad = opts.check !== false && isHmpError(text);
        finish({ ok: !bad, text: text, error: bad ? text : null });
      }
    });
  });
}

// Send one HMP command. Resolves {ok, text, error}; never rejects.
//   opts: {timeoutMs (8 s), check (treat error words as failure, default true),
//          expectClose (the command ends QEMU, e.g. quit)}
function monitorCmd(endpoint, cmd, opts) {
  opts = opts || {};
  if (!endpoint || (!endpoint.path && !(endpoint.host && endpoint.port))) {
    return Promise.resolve({ ok: false, text: '', error: 'this VM has no QEMU monitor (it was started by an older version - restart it once)' });
  }
  const key = keyOf(endpoint);
  const prev = chains.get(key) || Promise.resolve();
  const p = prev.then(() => rawCommand(endpoint, cmd, opts));
  const tail = p.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return p;
}

// The monitor endpoint of a VM record, or null (not running / legacy).
function monitorFor(vm) { return (vm && vm.runtime && vm.runtime.monitor) || null; }

const hostfwdAdd = (ep, m) => monitorCmd(ep, 'hostfwd_add n0 ' + ports.hostfwdRule(m));
const hostfwdRemove = (ep, m) => monitorCmd(ep, 'hostfwd_remove n0 ' + ports.hostfwdHost(m));
const systemPowerdown = (ep) => monitorCmd(ep, 'system_powerdown');
const quit = (ep) => monitorCmd(ep, 'quit', { expectClose: true, check: false });

// The -name of the QEMU behind a monitor endpoint (`info name`), or null when
// the monitor does not answer. Proves WHICH VM a recorded pid/endpoint is
// before the manager adopts or kills it (SEC-8, BUG-6): a stale pid can have
// been reused by any other qemu-system process.
async function infoName(ep, timeoutMs) {
  const r = await monitorCmd(ep, 'info name', { check: false, timeoutMs: timeoutMs || 5000 });
  return r.ok ? String(r.text || '').trim() : null;
}

// The forwards QEMU has bound right now. Resolves {ok, forwards, error}.
async function listForwards(ep) {
  const r = await monitorCmd(ep, 'info usernet', { check: false });
  if (!r.ok) return { ok: false, forwards: [], error: r.error };
  return { ok: true, forwards: parseUsernet(r.text), error: null };
}

const LEGACY_WHY = 'started by an older version of the manager - restart it once to allow live changes';

// Add a forward to a RUNNING VM. Success = QEMU accepted the rule AND lists it
// as bound with the chosen address (so the user's local/LAN choice really
// holds). Only if `info usernet` cannot be read do we fall back to "the host
// port accepts connections". Resolves {ok, why}.
async function addForwardLive(vm, m) {
  const ep = monitorFor(vm);
  if (!ep) return { ok: false, why: 'no QEMU monitor for this VM' };
  if (vm.runtime && vm.runtime.legacy) return { ok: false, why: LEGACY_WHY };
  const r = await hostfwdAdd(ep, m);
  if (!r.ok) return { ok: false, why: (r.error || 'monitor rejected the command').slice(0, 200) };
  const l = await listForwards(ep);
  if (l.ok && l.forwards.length) {
    const bind = ports.bindAddress(!!m.lan);
    const proto = ports.protoOf(m);
    if (l.forwards.some((f) => f.proto === proto && f.host === m.host && f.address === bind)) return { ok: true, why: null };
    return { ok: false, why: 'QEMU accepted the rule for port ' + m.host + (proto === 'udp' ? '/udp' : '') + ' but does not list it as bound' };
  }
  // a UDP socket cannot be probed with a connect: QEMU accepting the rule is all there is
  if (ports.protoOf(m) === 'udp') return { ok: true, why: null };
  for (let i = 0; i < 12; i++) {
    if (await portListening(m.host, 500, '127.0.0.1')) return { ok: true, why: null };
    await sleep(300);
  }
  return { ok: false, why: 'accepted, but port ' + m.host + ' never started listening' };
}

// Remove a forward from a RUNNING VM. A rule QEMU does not have ("not found":
// e.g. saved while a restart was pending) is already gone - that is success.
// Resolves {ok, why}.
async function removeForwardLive(vm, m) {
  const ep = monitorFor(vm);
  if (!ep) return { ok: false, why: 'no QEMU monitor for this VM' };
  if (vm.runtime && vm.runtime.legacy) return { ok: false, why: LEGACY_WHY };
  const r = await hostfwdRemove(ep, m);
  if (r.ok) return { ok: true, why: null };
  if (/not found/i.test(r.text || r.error || '')) return { ok: true, why: 'was not active' };
  return { ok: false, why: (r.error || 'monitor rejected the command').slice(0, 200) };
}

module.exports = {
  stripAnsi, parseHmpReply, isHmpError, parseUsernet,
  monitorCmd, monitorFor, hostfwdAdd, hostfwdRemove, systemPowerdown, quit, infoName, listForwards,
  addForwardLive, removeForwardLive,
};
