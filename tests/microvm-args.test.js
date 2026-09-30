'use strict';
/*
 * Docker-style text forms the container API accepts (lib/microvm/args.js):
 * ports (this PC only by default, ",lan" on request), volumes (named, or a
 * host folder = a LIVE shared folder), copy-in, env, sizes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parsePort, parseVolume, parseCopyIn, parseEnv, parseSize, checkTarget, UsageError } = require('../lib/microvm/args');

test('parsePort: local by default, ,lan binds 0.0.0.0, explicit address, udp, single port', () => {
  assert.deepStrictEqual(parsePort('19480:80'), { hostAddr: '127.0.0.1', hostPort: 19480, guestPort: 80, proto: 'tcp', lan: false });
  assert.deepStrictEqual(parsePort('19480:80,lan'), { hostAddr: '0.0.0.0', hostPort: 19480, guestPort: 80, proto: 'tcp', lan: true });
  assert.deepStrictEqual(parsePort('19480:80,local'), { hostAddr: '127.0.0.1', hostPort: 19480, guestPort: 80, proto: 'tcp', lan: false });
  assert.deepStrictEqual(parsePort('0.0.0.0:19480:80'), { hostAddr: '0.0.0.0', hostPort: 19480, guestPort: 80, proto: 'tcp', lan: true });
  assert.deepStrictEqual(parsePort('127.0.0.1:8080:80/udp'), { hostAddr: '127.0.0.1', hostPort: 8080, guestPort: 80, proto: 'udp', lan: false });
  assert.deepStrictEqual(parsePort('8080'), { hostAddr: '127.0.0.1', hostPort: 8080, guestPort: 8080, proto: 'tcp', lan: false });
  // exposure is this PC or the LAN (the user's choice): no other bind addresses
  for (const bad of ['0:80', '80:70000', 'x:80', '1:2:3:4', '19480:80,public', '127.0.0.1:1:2,lan', '0.0.0.0:1:2,local', '999.1.1.1:1:2', '::1:1:2', '192.168.1.5:8080:80']) {
    assert.throws(() => parsePort(bad), UsageError, bad);
  }
});

test('parseVolume: named volumes with options; host folders become live shared folders', () => {
  assert.deepStrictEqual(parseVolume('data:/var/lib/data'), { kind: 'volume', name: 'data', target: '/var/lib/data', readonly: false, nocopy: false });
  assert.deepStrictEqual(parseVolume('cfg:/etc/app/:ro'), { kind: 'volume', name: 'cfg', target: '/etc/app', readonly: true, nocopy: false });
  assert.deepStrictEqual(parseVolume('db.v2:/db:rw,nocopy'), { kind: 'volume', name: 'db.v2', target: '/db', readonly: false, nocopy: true });
  // a one-letter volume name is not a drive letter unless a second ":" follows
  assert.deepStrictEqual(parseVolume('a:/x'), { kind: 'volume', name: 'a', target: '/x', readonly: false, nocopy: false });
  assert.deepStrictEqual(parseVolume('a:/x:ro'), { kind: 'volume', name: 'a', target: '/x', readonly: true, nocopy: false });
  assert.deepStrictEqual(parseVolume('C:\\data:/data'), { kind: 'host', hostDir: 'C:\\data', target: '/data', readonly: false });
  assert.deepStrictEqual(parseVolume('C:/data:/data:ro'), { kind: 'host', hostDir: 'C:/data', target: '/data', readonly: true });
  assert.deepStrictEqual(parseVolume('./site:/app'), { kind: 'host', hostDir: './site', target: '/app', readonly: false });
  assert.deepStrictEqual(parseVolume('/home/me:/app/'), { kind: 'host', hostDir: '/home/me', target: '/app', readonly: false });
  assert.deepStrictEqual(parseVolume('~/x:/x'), { kind: 'host', hostDir: '~/x', target: '/x', readonly: false });
  for (const bad of ['data', 'data:relative', 'data:/', 'data:/.devbox/x', 'data:/a/../b', '-x:/a', 'data:/a:rx', 'C:\\data', 'C:\\data:/d:nocopy', '/x:/.devbox']) {
    assert.throws(() => parseVolume(bad), UsageError, bad);
  }
});

test('parseCopyIn: splits at the last ":/" so drive letters work', () => {
  assert.deepStrictEqual(parseCopyIn('C:\\site:/usr/share/nginx/html'), { hostDir: 'C:\\site', target: '/usr/share/nginx/html' });
  assert.deepStrictEqual(parseCopyIn('C:/work/site:/app/'), { hostDir: 'C:/work/site', target: '/app' });
  assert.deepStrictEqual(parseCopyIn('./site:/srv'), { hostDir: './site', target: '/srv' });
  for (const bad of ['site', 'site:app', 'C:/app', 'site:/', 'site:/.devbox']) assert.throws(() => parseCopyIn(bad), UsageError, bad);
});

test('parseEnv: K=V as given, K alone from the host (skipped when unset), = in values kept', () => {
  assert.strictEqual(parseEnv('A=1', {}), 'A=1');
  assert.strictEqual(parseEnv('A=x=y', {}), 'A=x=y');
  assert.strictEqual(parseEnv('A=', {}), 'A=');
  assert.strictEqual(parseEnv('HOSTVAR', { HOSTVAR: 'v' }), 'HOSTVAR=v');
  assert.strictEqual(parseEnv('MISSING', {}), null);
  assert.throws(() => parseEnv('=x', {}), UsageError);
});

test('parseSize: plain numbers in the given unit, suffixes', () => {
  assert.strictEqual(parseSize('512'), 512 * 1048576);
  assert.strictEqual(parseSize('512m'), 512 * 1048576);
  assert.strictEqual(parseSize('1g'), 1073741824);
  assert.strictEqual(parseSize('1.5GiB'), 1.5 * 1073741824);
  assert.strictEqual(parseSize('8', 1073741824), 8 * 1073741824);
  for (const bad of ['', 'x', '-1', '0', '1q']) assert.throws(() => parseSize(bad), UsageError, bad);
});

test('UsageError is an API 400; checkTarget normalises', () => {
  const e = new UsageError('x');
  assert.deepStrictEqual([e.status, e.code], [400, 'USAGE']);
  assert.strictEqual(checkTarget('/a/b/', 'volume', 's'), '/a/b');
  assert.throws(() => checkTarget('/a\nb', 'volume', 's'), /control character/);
});
