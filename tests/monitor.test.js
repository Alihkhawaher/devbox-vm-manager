'use strict';
/*
 * lib/monitor.js: the HMP reply parser (fixtures captured from QEMU 10.2 over
 * a socket in readline mode) and the client against a fake monitor that
 * behaves the same way: banner + prompt first, readline echo with ANSI
 * escapes, reply, next prompt (XTR-15).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const monitor = require('../lib/monitor');

// How QEMU's readline echoes a typed command: each keystroke redraws the line.
function echo(cmd) {
  let s = '';
  for (let i = 1; i <= cmd.length; i++) s += cmd.slice(0, i) + '\x1b[K' + '\x1b[D'.repeat(i);
  return s.replace(/(\x1b\[D)+$/, '');
}

const REPLIES = {
  'hostfwd_add n0 tcp:127.0.0.1:18777-:80': '',
  'hostfwd_add n0 tcp:127.0.0.1:1-:80': "Could not set up host forwarding rule 'tcp:127.0.0.1:1-:80'\r\n",
  'hostfwd_remove n0 tcp:127.0.0.1:18777': 'host forwarding rule for tcp:127.0.0.1:18777 removed\r\n',
  'hostfwd_remove n0 tcp:127.0.0.1:9': 'host forwarding rule for tcp:127.0.0.1:9 not found\r\n',
  'info name': 'web\r\n',
  'system_powerdown': '',
};

test('parseHmpReply: strips the echo line, escapes and the prompt', () => {
  const cmd = 'hostfwd_add n0 tcp:127.0.0.1:18777-:80';
  assert.equal(monitor.parseHmpReply(echo(cmd) + '\r\n(qemu) '), '');
  const bad = "hostfwd_add n0 tcp:127.0.0.1:1-:80";
  const t = monitor.parseHmpReply(echo(bad) + "\r\nCould not set up host forwarding rule 'tcp:127.0.0.1:1-:80'\r\n(qemu) ");
  assert.equal(t, "Could not set up host forwarding rule 'tcp:127.0.0.1:1-:80'");
  assert.equal(monitor.parseHmpReply(echo('info name') + '\r\nweb\r\n(qemu) '), 'web');
  assert.equal(monitor.parseHmpReply(echo('bogus') + "\r\nunknown command: 'bogus'\r\n(qemu) "), "unknown command: 'bogus'");
  assert.equal(monitor.parseHmpReply(''), '');
});

test('isHmpError: failures and successes as QEMU words them', () => {
  assert.equal(monitor.isHmpError("Could not set up host forwarding rule 'tcp::80-:80'"), true);
  assert.equal(monitor.isHmpError('host forwarding rule for tcp:127.0.0.1:9 not found'), true);
  assert.equal(monitor.isHmpError("unknown command: 'bogus'"), true);
  assert.equal(monitor.isHmpError('Error: invalid parameter'), true);
  assert.equal(monitor.isHmpError(''), false);
  assert.equal(monitor.isHmpError('host forwarding rule for tcp:127.0.0.1:18777 removed'), false);
});

// A fake HMP server. Writes the banner in two chunks (like a slow socket) and
// only answers after the prompt was sent. Records what it received.
function fakeMonitor() {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write('QEMU 10.2.0 monitor - type ');
    setTimeout(() => sock.write("'help' for more information\r\n(qemu) "), 30);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const cmd = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        seen.push(cmd);
        if (cmd === 'quit') { sock.destroy(); return; }
        const reply = cmd in REPLIES ? REPLIES[cmd] : "unknown command: '" + cmd.split(' ')[0] + "'\r\n";
        // echo first, reply a little later - the client must wait for the prompt
        sock.write(echo(cmd));
        setTimeout(() => sock.write('\r\n' + reply + '(qemu) '), 20);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server: server, seen: seen, ep: { host: '127.0.0.1', port: server.address().port } })));
}

test('monitorCmd: waits for the first prompt, then reports success, failure and unknown commands', async () => {
  const f = await fakeMonitor();
  try {
    const ok = await monitor.hostfwdAdd(f.ep, { host: 18777, guest: 80, lan: false });
    assert.deepEqual(ok, { ok: true, text: '', error: null });
    const fail = await monitor.hostfwdAdd(f.ep, { host: 1, guest: 80, lan: false });
    assert.equal(fail.ok, false);
    assert.match(fail.error, /Could not set up host forwarding rule/);
    const rm = await monitor.hostfwdRemove(f.ep, { host: 18777, guest: 80, lan: false });
    assert.equal(rm.ok, true);
    assert.match(rm.text, /removed/);
    const missing = await monitor.hostfwdRemove(f.ep, { host: 9, guest: 9, lan: false });
    assert.equal(missing.ok, false);
    const name = await monitor.monitorCmd(f.ep, 'info name', { check: false });
    assert.equal(name.text, 'web');
    const unk = await monitor.monitorCmd(f.ep, 'bogus_cmd');
    assert.equal(unk.ok, false);
    assert.match(unk.error, /unknown command/);
    assert.deepEqual(f.seen.slice(0, 4), [
      'hostfwd_add n0 tcp:127.0.0.1:18777-:80', 'hostfwd_add n0 tcp:127.0.0.1:1-:80',
      'hostfwd_remove n0 tcp:127.0.0.1:18777', 'hostfwd_remove n0 tcp:127.0.0.1:9',
    ]);
  } finally { await new Promise((r) => f.server.close(r)); }
});

test('the LAN choice reaches QEMU: hostfwd rules carry 0.0.0.0 or 127.0.0.1', async () => {
  const f = await fakeMonitor();
  try {
    await monitor.hostfwdAdd(f.ep, { host: 3000, guest: 3000, lan: true });
    await monitor.hostfwdRemove(f.ep, { host: 3000, guest: 3000, lan: true });
    assert.deepEqual(f.seen, ['hostfwd_add n0 tcp:0.0.0.0:3000-:3000', 'hostfwd_remove n0 tcp:0.0.0.0:3000']);
  } finally { await new Promise((r) => f.server.close(r)); }
});

test('quit: the dropped connection counts as success; commands to one monitor are serialised', async () => {
  const f = await fakeMonitor();
  try {
    const [a, b] = await Promise.all([monitor.monitorCmd(f.ep, 'info name', { check: false }), monitor.systemPowerdown(f.ep)]);
    assert.equal(a.text, 'web');
    assert.equal(b.ok, true);
    const q = await monitor.quit(f.ep);
    assert.equal(q.ok, true);
  } finally { await new Promise((r) => f.server.close(r)); }
});

test('an unreachable or silent monitor fails cleanly (never hangs, never throws)', async () => {
  const closed = await monitor.monitorCmd({ host: '127.0.0.1', port: 1 }, 'info name', { timeoutMs: 2000 });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /cannot reach the QEMU monitor|did not answer/);
  const silent = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const r = await monitor.monitorCmd({ host: '127.0.0.1', port: silent.address().port }, 'info name', { timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.match(r.error, /did not answer/);
  } finally { await new Promise((r) => silent.close(r)); }
  const none = await monitor.monitorCmd(null, 'info name');
  assert.equal(none.ok, false);
  assert.match(none.error, /no QEMU monitor/);
});

// `info usernet` exactly as QEMU 10.2 printed it for a VM with three forwards
const USERNET = 'Hub -1 (n0):\r\n' +
  '  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ\r\n' +
  '  TCP[HOST_FORWARD] 107c       127.0.0.1 18733       10.0.2.15  8080     0     0\r\n' +
  '  TCP[HOST_FORWARD] 3d0       127.0.0.1 18731       10.0.2.15    22     0     0\r\n' +
  '  TCP[HOST_FORWARD] 3cc               * 18732       10.0.2.15    80     0     0\r\n' +
  '  TCP[ESTABLISHED]   3f0       10.0.2.15 43210   93.184.216.34   443     0     0\r\n';

test('parseUsernet: host forwards with their bind address ("*" = 0.0.0.0); other sockets ignored', () => {
  assert.deepEqual(monitor.parseUsernet(USERNET), [
    { proto: 'tcp', address: '127.0.0.1', host: 18733, guestAddress: '10.0.2.15', guest: 8080 },
    { proto: 'tcp', address: '127.0.0.1', host: 18731, guestAddress: '10.0.2.15', guest: 22 },
    { proto: 'tcp', address: '0.0.0.0', host: 18732, guestAddress: '10.0.2.15', guest: 80 },
  ]);
  assert.deepEqual(monitor.parseUsernet(''), []);
});

// A fake monitor that keeps a forward table like slirp: hostfwd_add adds
// (or fails for a taken port), hostfwd_remove removes, info usernet lists.
function statefulMonitor(opts) {
  opts = opts || {};
  const fwd = [{ addr: '127.0.0.1', host: 2223, guest: 22 }];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write("QEMU 10.2.0 monitor - type 'help' for more information\r\n(qemu) ");
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const cmd = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let reply = '';
        let m;
        if ((m = cmd.match(/^hostfwd_add n0 tcp:([\d.]+):(\d+)-:(\d+)$/))) {
          if (opts.silentAdd) { /* accepted, never bound */ }
          else if (fwd.some((f) => f.host === +m[2])) reply = "Could not set up host forwarding rule '" + cmd.split(' ')[2] + "'\r\n";
          else fwd.push({ addr: m[1], host: +m[2], guest: +m[3] });
        } else if ((m = cmd.match(/^hostfwd_remove n0 tcp:([\d.]+):(\d+)$/))) {
          const i = fwd.findIndex((f) => f.host === +m[2] && f.addr === m[1]);
          if (i >= 0) { fwd.splice(i, 1); reply = 'host forwarding rule for ' + cmd.split(' ')[2] + ' removed\r\n'; }
          else reply = 'host forwarding rule for ' + cmd.split(' ')[2] + ' not found\r\n';
        } else if (cmd === 'info usernet') {
          reply = 'Hub -1 (n0):\r\n  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ\r\n' +
            fwd.map((f) => '  TCP[HOST_FORWARD] 3d0 ' + (f.addr === '0.0.0.0' ? '*' : f.addr) + ' ' + f.host + ' 10.0.2.15 ' + f.guest + ' 0 0\r\n').join('');
        } else reply = "unknown command: '" + cmd.split(' ')[0] + "'\r\n";
        sock.write(echo(cmd) + '\r\n' + reply + '(qemu) ');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server: server, fwd: fwd, ep: { host: '127.0.0.1', port: server.address().port } })));
}

test('addForwardLive is confirmed by `info usernet` with the chosen bind address; removal of an inactive rule is fine', async () => {
  const f = await statefulMonitor();
  try {
    const vmRec = { runtime: { pid: 1, monitor: f.ep } };
    assert.deepEqual(await monitor.addForwardLive(vmRec, { host: 18080, guest: 80, lan: false }), { ok: true, why: null });
    assert.deepEqual(await monitor.addForwardLive(vmRec, { host: 18081, guest: 3000, lan: true }), { ok: true, why: null });
    assert.deepEqual(f.fwd.map((x) => x.addr + ':' + x.host), ['127.0.0.1:2223', '127.0.0.1:18080', '0.0.0.0:18081']);
    const taken = await monitor.addForwardLive(vmRec, { host: 2223, guest: 22, lan: false });
    assert.equal(taken.ok, false);
    assert.match(taken.why, /Could not set up host forwarding rule/);
    const l = await monitor.listForwards(f.ep);
    assert.equal(l.ok, true);
    assert.equal(l.forwards.find((x) => x.host === 18081).address, '0.0.0.0');
    assert.deepEqual(await monitor.removeForwardLive(vmRec, { host: 18081, guest: 3000, lan: true }), { ok: true, why: null });
    assert.deepEqual(await monitor.removeForwardLive(vmRec, { host: 18999, guest: 1, lan: false }), { ok: true, why: 'was not active' });
  } finally { await new Promise((r) => f.server.close(r)); }
  // QEMU says OK but does not list the rule: not reported as live
  const g = await statefulMonitor({ silentAdd: true });
  try {
    const r = await monitor.addForwardLive({ runtime: { pid: 1, monitor: g.ep } }, { host: 18082, guest: 80, lan: false });
    assert.equal(r.ok, false);
    assert.match(r.why, /does not list it/);
  } finally { await new Promise((r) => g.server.close(r)); }
});

test('addForwardLive refuses VMs without a monitor or adopted from v1', async () => {
  assert.equal((await monitor.addForwardLive({ runtime: null }, { host: 1, guest: 1 })).ok, false);
  const legacy = await monitor.addForwardLive({ runtime: { pid: 1, legacy: true, monitor: { host: '127.0.0.1', port: 1 } } }, { host: 1, guest: 1 });
  assert.equal(legacy.ok, false);
  assert.match(legacy.why, /restart it once/);
});
