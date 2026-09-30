'use strict';
/*
 * lib/platform.js: the pure parsers (with real-world fixtures, including a
 * German netstat - OPS-1), the port checks, and the small helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const p = require('../lib/platform');

// ---------------------------------------------------------------------------
// netstat (Windows)
// ---------------------------------------------------------------------------
const NETSTAT_EN = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2020',
  '  TCP    127.0.0.1:2223         0.0.0.0:0              LISTENING       4312',
  '  TCP    127.0.0.1:2223         127.0.0.1:50123        ESTABLISHED     4312',
  '  TCP    192.168.1.5:50124      140.82.112.4:443       TIME_WAIT       0',
  '  TCP    [::]:135               [::]:0                 LISTENING       2020',
  '  TCP    [::1]:8777             [::]:0                 LISTENING       9000',
  '  TCP    [fe80::1%4]:139        [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:123            *:*                                    1500',
].join('\r\n');

const NETSTAT_DE = [
  '',
  'Aktive Verbindungen',
  '',
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  '  TCP    0.0.0.0:2224           0.0.0.0:0              ABHÖREN         7788',
  '  TCP    127.0.0.1:8080         0.0.0.0:0              ABHÖREN         7788',
  '  TCP    127.0.0.1:8080         127.0.0.1:61000        HERGESTELLT     7788',
  '  TCP    [::]:445               [::]:0                 ABHÖREN         4',
].join('\r\n');

test('parseNetstat: listening rows by their 0.0.0.0:0 / [::]:0 foreign address (English)', () => {
  assert.deepEqual(p.parseNetstat(NETSTAT_EN), [
    { port: 135, address: '0.0.0.0', pid: 2020 },
    { port: 2223, address: '127.0.0.1', pid: 4312 },
    { port: 135, address: '::', pid: 2020 },
    { port: 8777, address: '::1', pid: 9000 },
    { port: 139, address: 'fe80::1', pid: 4 },
  ]);
});

test('parseNetstat: works on German Windows (ABHÖREN) - never matches the state word', () => {
  assert.deepEqual(p.parseNetstat(NETSTAT_DE), [
    { port: 2224, address: '0.0.0.0', pid: 7788 },
    { port: 8080, address: '127.0.0.1', pid: 7788 },
    { port: 445, address: '::', pid: 4 },
  ]);
  // French and Spanish state words behave the same
  assert.equal(p.parseNetstat('  TCP    0.0.0.0:22   0.0.0.0:0   ÉCOUTE   11').length, 1);
  assert.equal(p.parseNetstat('  TCP    0.0.0.0:22   0.0.0.0:0   ESCUCHANDO   11').length, 1);
});

test('parseNetstat: empty, garbage and non-TCP input give nothing', () => {
  assert.deepEqual(p.parseNetstat(''), []);
  assert.deepEqual(p.parseNetstat(null), []);
  assert.deepEqual(p.parseNetstat('UDP 0.0.0.0:53 *:* 12\nhello world'), []);
});

// ---------------------------------------------------------------------------
// tasklist (Windows), ps (macOS)
// ---------------------------------------------------------------------------
test('parseTasklistCsv: qemu-system-* rows only; localised "no tasks" text is no match', () => {
  const out = [
    '"qemu-system-x86_64.exe","4312","Console","1","412,332 K"',
    '"qemu-system-x86_64w.exe","4400","Console","1","12 K"',
    '"node.exe","10092","Console","1","38,908 K"',
  ].join('\r\n');
  assert.deepEqual([...p.parseTasklistCsv(out)].sort(), [4312, 4400]);
  assert.equal(p.parseTasklistCsv('INFO: No tasks are running which match the specified criteria.').size, 0);
  assert.equal(p.parseTasklistCsv('INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.').size, 0);
  assert.equal(p.parseTasklistCsv('').size, 0);
});

test('parsePs: matches the qemu-system basename', () => {
  const out = '  123 /opt/homebrew/bin/qemu-system-x86_64\n  456 /usr/sbin/sshd\n 789 qemu-system-aarch64\n';
  assert.deepEqual([...p.parsePs(out)].sort(), [123, 789]);
});

// ---------------------------------------------------------------------------
// ss, /proc/net/tcp (Linux), lsof (macOS)
// ---------------------------------------------------------------------------
test('parseSs: addresses, ports and pids (when shown)', () => {
  const out = [
    'LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=585,fd=14))',
    'LISTEN 0      128          0.0.0.0:2223      0.0.0.0:*    users:(("qemu-system-x86",pid=4312,fd=12))',
    'LISTEN 0      4096            [::]:22           [::]:*',
    'LISTEN 0      511                *:8080            *:*',
    'ESTAB  0      0          127.0.0.1:2223    127.0.0.1:40000',
  ].join('\n');
  assert.deepEqual(p.parseSs(out), [
    { port: 53, address: '127.0.0.53', pid: 585 },
    { port: 2223, address: '0.0.0.0', pid: 4312 },
    { port: 22, address: '::', pid: null },
    { port: 8080, address: '0.0.0.0', pid: null },
  ]);
});

test('parseProcNetTcp: LISTEN (0A) rows, little-endian IPv4', () => {
  const txt = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:08AF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1',
    '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1',
    '   2: 0100007F:08AF 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
    '   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 444 1',
  ].join('\n');
  assert.deepEqual(p.parseProcNetTcp(txt), [
    { port: 2223, address: '127.0.0.1', pid: null },
    { port: 22, address: '0.0.0.0', pid: null },
    { port: 22, address: '::', pid: null },
  ]);
});

test('parseLsof: LISTEN rows with pid and address', () => {
  const out = [
    'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'qemu-syst 12345 usr   12u  IPv4 0x1234567890      0t0  TCP 127.0.0.1:2223 (LISTEN)',
    'rapportd    500 usr    4u  IPv6 0xabcdef          0t0  TCP *:49152 (LISTEN)',
    'Google      800 usr   30u  IPv4 0xfeed            0t0  TCP 192.168.1.2:50000->1.2.3.4:443 (ESTABLISHED)',
  ].join('\n');
  assert.deepEqual(p.parseLsof(out), [
    { port: 2223, address: '127.0.0.1', pid: 12345 },
    { port: 49152, address: '0.0.0.0', pid: 500 },
  ]);
});

test('splitHostPort handles IPv4, IPv6, wildcards and zones', () => {
  assert.deepEqual(p.splitHostPort('127.0.0.1:80'), { host: '127.0.0.1', port: 80 });
  assert.deepEqual(p.splitHostPort('[::]:22'), { host: '::', port: 22 });
  assert.deepEqual(p.splitHostPort('*:8080'), { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(p.splitHostPort('[::ffff:127.0.0.1]:80'), { host: '127.0.0.1', port: 80 });
  assert.deepEqual(p.splitHostPort('0.0.0.0:*'), { host: '0.0.0.0', port: 0 });
  assert.equal(p.splitHostPort('nonsense'), null);
});

// ---------------------------------------------------------------------------
// live checks (no external programs needed)
// ---------------------------------------------------------------------------
function listen(host) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => resolve(s));
  });
}
const close = (s) => new Promise((r) => s.close(r));

test('isPortFree: false while something listens on 127.0.0.1 or 0.0.0.0, true after', async () => {
  const a = await listen('127.0.0.1');
  const pa = a.address().port;
  assert.equal(await p.isPortFree(pa), false);
  await close(a);
  assert.equal(await p.isPortFree(pa), true);
  const b = await listen('0.0.0.0');
  const pb = b.address().port;
  assert.equal(await p.isPortFree(pb), false);
  await close(b);
  assert.equal(await p.isPortFree(0), false, 'port 0 is never "free"');
  assert.equal(await p.isPortFree(70000), false);
});

test('freeLocalPort returns a bindable port', async () => {
  const port = await p.freeLocalPort('127.0.0.1');
  assert.ok(port > 0 && port < 65536);
  assert.equal(await p.canListen(port, '127.0.0.1'), true);
});

test('internalHost: a fresh random private 127.x.y.z per call on Windows (never 127.0.0.1), unix sockets (null) elsewhere', async () => {
  const h = await p.internalHost();
  if (process.platform !== 'win32') { assert.equal(h, null); return; }
  assert.match(h, /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  assert.notEqual(h, '127.0.0.1', 'guests reach 127.0.0.1 through 10.0.2.2');
  assert.equal(await p.canListen(0, h), true);
  const seen = new Set();
  for (let i = 0; i < 5; i++) seen.add(await p.internalHost());
  assert.ok(seen.size >= 4, 'not predictable: ' + Array.from(seen).join(', '));
});

test('randomLoopback: always 127.a.b.c with a and c in 1-254, never in 127.0.x.x', () => {
  for (let i = 0; i < 2000; i++) {
    const m = p.randomLoopback().split('.').map(Number);
    assert.equal(m[0], 127);
    assert.ok(m[1] >= 1 && m[1] <= 254, m.join('.'));
    assert.ok(m[2] >= 0 && m[2] <= 255, m.join('.'));
    assert.ok(m[3] >= 1 && m[3] <= 254, m.join('.'));
  }
});

test('internalHost fails closed when no private loopback can be bound (unless allowSharedLoopback)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { CFG } = require('../lib/config');
  const orig = p.canListen;
  // internalHost calls the module-internal canListen; simulate a PC that
  // refuses every loopback address but 127.0.0.1 by stubbing the socket layer
  const net = require('net');
  const origCreate = net.createServer;
  net.createServer = function () {
    const s = origCreate.apply(net, arguments);
    const listen = s.listen.bind(s);
    s.listen = function (o, cb) {
      if (o && typeof o === 'object' && o.host && o.host !== '127.0.0.1' && /^127\./.test(o.host)) {
        process.nextTick(() => s.emit('error', Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })));
        return s;
      }
      return listen(o, cb);
    };
    return s;
  };
  try {
    CFG.allowSharedLoopback = false;
    await assert.rejects(p.internalHost(), (e) => e.code === 'NO_PRIVATE_LOOPBACK' && /allowSharedLoopback/.test(e.message));
    CFG.allowSharedLoopback = true;
    assert.equal(await p.internalHost(), '127.0.0.1');
  } finally {
    net.createServer = origCreate;
    CFG.allowSharedLoopback = false;
    // the opt-in is surfaced as a /api/state warning: do not leak it into later tests
    const stm = require('../lib/state');
    stm._meta.warnings = stm._meta.warnings.filter((w) => !/allowSharedLoopback/.test(w));
    assert.equal(p.canListen, orig);
  }
});

test('isPortFree: two probes of the same port at once do not make each other fail', async () => {
  const port = await p.freeLocalPort('127.0.0.1');
  const r = await Promise.all([p.isPortFree(port), p.isPortFree(port), p.isPortFree(port)]);
  assert.deepEqual(r, [true, true, true]);
});

test('pidAlive: this process yes, an absurd pid no', () => {
  assert.equal(p.pidAlive(process.pid), true);
  assert.equal(p.pidAlive(0), false);
  assert.equal(p.pidAlive(2147483646), false);
});

test('diskFree reports the volume of the given folder (or its nearest existing parent)', () => {
  const d = p.diskFree(require('os').tmpdir() + '/does/not/exist/yet');
  assert.equal(d.error, null);
  assert.ok(d.total > 0 && d.free >= 0 && d.free <= d.total);
});

test('hostTimezone, osInfo and installHints have the expected shape', () => {
  assert.match(p.hostTimezone(), /^[A-Za-z_+\-/0-9]+$/);
  const o = p.osInfo();
  assert.equal(o.os, process.platform);
  assert.equal(o.arch, process.arch);
  const h = p.installHints();
  for (const k of ['qemu', 'ssh', 'sevenZip', 'accel']) assert.equal(typeof h[k], 'string', k);
});

test('openBrowser refuses URLs that could break out of the shell command', () => {
  // (only invalid URLs are tried here - no browser is ever launched by the tests)
  assert.equal(p.openBrowser('http://127.0.0.1:1/" & calc'), false);
  assert.equal(p.openBrowser('javascript:alert(1)'), false);
  assert.equal(p.openBrowser('http://x/%PATH%'), false);
});
