'use strict';
/*
 * lib/sessions.js: the ssh pty marker and remote command (pure), request
 * validation, and serial-console sessions against a fake QEMU serial socket:
 * the log prefill, input, one client per VM, the 16-session cap, closing on
 * VM stop, and the SSE stream with ?since= replay (SEC-9, BUG-13, XTR-2).
 * No ssh or QEMU is started here (tests/vm.test.js drives a real serial
 * console when QEMU is installed).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const vmMod = require('../lib/vm');
const sessions = require('../lib/sessions');
const { sleep } = require('../lib/util');
const { useTempRoot, resetConfig, rm } = require('./helpers');

let SH = null;
for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) { if (fs.existsSync(c)) { SH = c; break; } }

test('extractPtyMarker: finds and strips the OSC marker; only plain tty paths are trusted', () => {
  const r = sessions.extractPtyMarker('\x1b]777;devbox-pty;/dev/pts/3\x07Welcome to Alpine!\r\n');
  assert.deepEqual(r, { pty: '/dev/pts/3', rest: 'Welcome to Alpine!\r\n' });
  assert.deepEqual(sessions.extractPtyMarker('a\x1b]777;devbox-pty;/dev/ttyS0\x1b\\b'), { pty: '/dev/ttyS0', rest: 'ab' });
  assert.equal(sessions.extractPtyMarker('\x1b]777;devbox-pty;not a tty\x07x').pty, null);
  assert.equal(sessions.extractPtyMarker('\x1b]777;devbox-pty;/dev/pts/1; rm -rf /\x07').pty, null);
  assert.equal(sessions.extractPtyMarker('no marker here'), null);
  assert.equal(sessions.extractPtyMarker('\x1b]777;devbox-pty;/dev/pts/3'), null); // incomplete: wait for more
});

test('sshRemoteCommand: reports the pty, applies the size, execs a login shell - and is valid sh', () => {
  const c = sessions.sshRemoteCommand(132, 43);
  assert.match(c, /stty cols 132 rows 43/);
  assert.match(c, /exec "\$\{SHELL:-\/bin\/sh\}" -l$/);
  assert.match(c, /devbox-pty/);
  if (SH) execFileSync(SH, ['-n'], { input: c, windowsHide: true });
});

// a fake QEMU serial chardev: accepts clients, records what they type
function fakeSerial() {
  const got = [];
  const conns = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    conns.push(sock);
    sock.on('data', (d) => got.push(d.toString()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, got: got, conns: conns,
    close: () => new Promise((r) => { for (const c of conns) c.destroy(); server.close(r); }),
  })));
}

// SSE reader: GET /stream?id=&since= through sessions.stream()
function sseServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    sessions.stream(req, res, { id: u.searchParams.get('id'), since: u.searchParams.get('since') });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }),
  })));
}
function readEvents(port, id, since, until) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port: port, path: '/stream?id=' + encodeURIComponent(id) + '&since=' + since }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events: events }); }
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve({ status: 200, events: events, timedOut: true }); }, 3000);
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = block.match(/^data: (.*)$/m);
          if (m) events.push(JSON.parse(m[1]));
        }
        if (until(events)) { clearTimeout(timer); req.destroy(); resolve({ status: 200, events: events }); }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: 200, events: events, ended: true }); });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
const text = (events) => events.filter((e) => e.t).map((e) => e.t).join('');

async function withVm(fn) {
  const root = useTempRoot('sessions');
  tasks._reset();
  st.loadState();
  const serial = await fakeSerial();
  const savedIsRunning = vmMod.isRunning;
  vmMod.isRunning = async (name) => !!(st.state.vms[name] && st.state.vms[name].runtime);
  try {
    st.state.vms.s1 = st.newVmRecord({ port: 1, runtime: { pid: 99999, serial: { host: '127.0.0.1', port: serial.port }, monitor: null } });
    fs.mkdirSync(require('../lib/config').CFG.sandboxDir, { recursive: true });
    fs.writeFileSync(st.serialLogPath('s1'), 'Welcome to Alpine Linux 3.23\nKernel 6.12 on x86_64 (/dev/ttyS0)\n');
    await fn(serial);
  } finally {
    sessions.closeAllSessions();
    vmMod.isRunning = savedIsRunning;
    await serial.close();
    for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
    tasks._reset();
    resetConfig();
    rm(root);
  }
}

test('open: validates kind, user, name and VM state before doing anything', () => withVm(async () => {
  await assert.rejects(sessions.open({ name: 's1', kind: 'telnet' }), (e) => e.status === 400);
  await assert.rejects(sessions.open({ name: 's1', user: 'admin' }), (e) => e.status === 400);
  await assert.rejects(sessions.open({ name: '../x' }), (e) => e.status === 400);
  await assert.rejects(sessions.open({ name: 'nope', kind: 'serial' }), (e) => e.status === 404);
  st.state.vms.off = st.newVmRecord({ port: 2 });
  await assert.rejects(sessions.open({ name: 'off', kind: 'serial' }), (e) => e.status === 409 && e.code === 'NOT_RUNNING');
  await assert.rejects(sessions.open({ name: 'off', kind: 'ssh' }), (e) => e.status === 409);
  // adopted from v1: no serial socket until it restarts
  st.state.vms.old = st.newVmRecord({ port: 3, runtime: { pid: 5, legacy: true, monitor: { host: '127.0.0.1', port: 25001 } } });
  await assert.rejects(sessions.open({ name: 'old', kind: 'serial' }), (e) => e.status === 409 && e.code === 'NO_SERIAL');
  // socket not there
  st.state.vms.gone = st.newVmRecord({ port: 4, runtime: { pid: 6, serial: { host: '127.0.0.1', port: 1 }, monitor: null } });
  await assert.rejects(sessions.open({ name: 'gone', kind: 'serial' }), (e) => e.status === 409 && e.code === 'NO_SERIAL');
  assert.throws(() => sessions.input({ id: 'nope', data: 'x' }), (e) => e.status === 404);
  assert.throws(() => sessions.input({ id: 'x', data: 5 }), (e) => e.status === 400);
  assert.throws(() => sessions.resize({ id: 'nope', cols: 80, rows: 24 }), (e) => e.status === 404);
  assert.deepEqual(sessions.close({ id: 'nope' }), { closed: false });
}));

test('serial console: log prefill, typed input reaches the VM, SSE with since-replay, one client per VM, closes with the VM', () => withVm(async (serial) => {
  const sse = await sseServer();
  try {
    const s = await sessions.open({ name: 's1', kind: 'serial', cols: 100, rows: 30 });
    assert.equal(s.kind, 'serial');
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    await sleep(100);
    assert.equal(serial.conns.length, 1);
    serial.conns[0].write('localhost login: root (automatic login)\r\n# ');
    assert.equal(sessions.writeInput(s.id, 'uname -a\r'), true);
    assert.deepEqual(sessions.input({ id: s.id, data: 'ls\r' }), {});
    await sleep(100);
    assert.equal(serial.got.join(''), 'uname -a\rls\r');
    assert.deepEqual(sessions.resize({ id: s.id, cols: 90, rows: 20 }), { applied: 'queued' });

    const all = await readEvents(sse.port, s.id, 0, (ev) => /automatic login/.test(text(ev)));
    const t0 = text(all.events);
    assert.match(t0, /Welcome to Alpine Linux 3\.23\r\n/); // what the console printed before we attached
    assert.match(t0, /press Enter for a prompt/);
    assert.match(t0, /automatic login/);
    const n = all.events[all.events.length - 1].n;
    serial.conns[0].write('new output\r\n');
    await sleep(100);
    const more = await readEvents(sse.port, s.id, n, (ev) => /new output/.test(text(ev)));
    assert.equal(text(more.events), 'new output\r\n', 'only what was missed');
    assert.equal(more.events[more.events.length - 1].n, n + 'new output\r\n'.length);

    // a second serial session replaces the first (QEMU serves one client)
    const s2 = await sessions.open({ name: 's1', kind: 'serial', replace: s.id });
    await sleep(100);
    assert.equal(sessions.writeInput(s.id, 'x'), false);
    assert.equal(serial.conns[0].destroyed || serial.conns[0].readableEnded, true);
    assert.equal(sessions.listSessions().filter((x) => !x.closed).length, 1);

    // the VM stops: its sessions end, a watching stream gets {exit}
    const watching = readEvents(sse.port, s2.id, 0, (ev) => ev.some((e) => 'exit' in e));
    await sleep(100);
    vmMod.closeVmSessions('s1');
    const w = await watching;
    assert.ok(w.events.some((e) => 'exit' in e), 'exit event delivered');
    assert.equal(sessions.writeInput(s2.id, 'x'), false);
    assert.equal((await readEvents(sse.port, 'no-such-id', 0, () => true)).status, 404);
  } finally { await sse.close(); }
}));

test('SSE output is batched: a console that writes byte by byte does not become one event per byte', () => withVm(async (serial) => {
  const sse = await sseServer();
  try {
    const s = await sessions.open({ name: 's1', kind: 'serial' });
    await sleep(100);
    const got = readEvents(sse.port, s.id, 0, (ev) => /END-OF-BOOT/.test(text(ev)));
    await sleep(100);
    // what a real guest UART does: one or two bytes per socket read
    const msg = '[    1.234] a line of boot output\r\n'.repeat(20) + 'END-OF-BOOT\r\n';
    for (const ch of msg) { serial.conns[0].write(ch); await new Promise((r) => setImmediate(r)); }
    const r = await got;
    const live = r.events.filter((e) => e.t && /boot output|END-OF-BOOT/.test(e.t));
    assert.ok(text(r.events).endsWith(msg), 'every byte arrives, in order');
    assert.ok(live.length < 25, live.length + ' events for ' + msg.length + ' bytes');
    const last = r.events[r.events.length - 1];
    // n is still the running offset: a reconnect from it gets nothing twice
    serial.conns[0].write('after\r\n');
    await sleep(100);
    const more = await readEvents(sse.port, s.id, last.n, (ev) => /after/.test(text(ev)));
    assert.equal(text(more.events), 'after\r\n');
  } finally { await sse.close(); }
}));

test('at most 16 live sessions', () => withVm(async (serial) => {
  const ids = [];
  for (let i = 0; i < sessions.MAX_SESSIONS; i++) {
    const n = 'v' + i;
    st.state.vms[n] = st.newVmRecord({ port: 100 + i, runtime: { pid: 1000 + i, serial: { host: '127.0.0.1', port: serial.port }, monitor: null } });
    ids.push((await sessions.open({ name: n, kind: 'serial' })).id);
  }
  assert.equal(new Set(ids).size, sessions.MAX_SESSIONS);
  await assert.rejects(sessions.open({ name: 's1', kind: 'serial' }), (e) => e.status === 409 && e.code === 'TOO_MANY_SESSIONS');
  sessions.closeSession(ids[0]);
  const again = await sessions.open({ name: 's1', kind: 'serial' });
  assert.ok(again.id);
}));
