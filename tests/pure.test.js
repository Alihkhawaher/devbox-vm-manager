'use strict';
/*
 * Unit tests for the pure helpers of docker.js, deploy.js and vm.js (the
 * port parser has its own file, tests/ports.test.js).
 *
 * The v1 "(v1 behaviour ...)" pins were replaced by the fixed behaviour:
 * parseInspect reads one JSON document (a "|" can no longer shift fields,
 * MNT-10) and drops unsafe volume paths (SEC-6); netdevFor binds every
 * forward to 127.0.0.1 or 0.0.0.0 as the user chose (SEC-5, spec section 7);
 * the deploy port planner and the __RC parser are extracted and tested.
 *
 * Run: node --test tests/     (only node:test + node:assert, no dependencies)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseInspect, ndjson, parseDockerState, isSafeVolumePath, localtimeFix } = require('../lib/docker');
const { planPortMappings, parseRunResult, containerNameFor } = require('../lib/deploy');
const { macForPort, netdevFor, qemuArgs, accelArgs } = require('../lib/vm');
const { fmtBytes } = require('../lib/util');

// ---------------------------------------------------------------------------
// parseInspect (docker image inspect --format "{{json .Config}}")
// ---------------------------------------------------------------------------
test('parseInspect: a typical image', () => {
  const cfg = {
    ExposedPorts: { '80/tcp': {}, '443/tcp': {}, '53/udp': {} },
    Volumes: { '/usr/share/nginx/html': {}, '/var/log': {} },
    Env: ['PATH=/usr/local/sbin:/usr/bin', 'NGINX_VERSION=1.27.0'],
    Cmd: ['nginx', '-g', 'daemon off;'],
    Entrypoint: ['/docker-entrypoint.sh'],
  };
  assert.deepEqual(parseInspect(JSON.stringify(cfg) + '\n'), {
    ports: [{ port: 80, proto: 'tcp' }, { port: 443, proto: 'tcp' }, { port: 53, proto: 'udp' }],
    volumes: ['/usr/share/nginx/html', '/var/log'],
    ignoredVolumes: [],
    env: ['PATH=/usr/local/sbin:/usr/bin', 'NGINX_VERSION=1.27.0'],
    cmd: ['nginx', '-g', 'daemon off;'],
    entrypoint: ['/docker-entrypoint.sh'],
  });
});

test('parseInspect: an image that declares nothing, or unreadable output', () => {
  const none = { ports: [], volumes: [], ignoredVolumes: [], env: [], cmd: null, entrypoint: null };
  assert.deepEqual(parseInspect('{"ExposedPorts":null,"Volumes":null,"Env":null,"Cmd":null,"Entrypoint":null}'), none);
  assert.deepEqual(parseInspect('null'), none);
  assert.deepEqual(parseInspect(''), none);
  assert.deepEqual(parseInspect(undefined), none);
  assert.deepEqual(parseInspect('{broken'), none);
  assert.deepEqual(parseInspect('[1,2]'), none);
});

test('parseInspect: only <number>/tcp|udp port keys survive', () => {
  const r = parseInspect(JSON.stringify({ ExposedPorts: { '80': {}, 'http/tcp': {}, '8080/sctp': {}, '9000/udp': {}, '7000/TCP': {} } }));
  assert.deepEqual(r.ports, [{ port: 9000, proto: 'udp' }]);
  assert.deepEqual(parseInspect(JSON.stringify({ ExposedPorts: [80] })).ports, []);
});

test('parseInspect: env keeps only NAME=value entries', () => {
  const r = parseInspect(JSON.stringify({ Env: ['OK=1', '=nokey', '1BAD=x', 'NOEQUALS', '_UNDER=y', 'lower_case=z', 'EMPTY=', 5] }));
  assert.deepEqual(r.env, ['OK=1', '_UNDER=y', 'lower_case=z', 'EMPTY=']);
});

test('parseInspect: a "|" inside a value no longer shifts the fields (MNT-10)', () => {
  const r = parseInspect(JSON.stringify({ Env: ['PS1=a|b'], Cmd: ['nginx'], Entrypoint: null }));
  assert.deepEqual(r.env, ['PS1=a|b']);
  assert.deepEqual(r.cmd, ['nginx']);
  assert.equal(r.entrypoint, null);
});

test('parseInspect: unsafe volume paths are dropped and reported (SEC-6)', () => {
  const r = parseInspect(JSON.stringify({ Volumes: { 'x;touch /tmp/pwned': {}, 'relative/path': {}, '/ok/data': {}, '/a/../b': {}, '/$(id)': {}, "/it's": {} } }));
  assert.deepEqual(r.volumes, ['/ok/data']);
  assert.deepEqual(r.ignoredVolumes.sort(), ["/$(id)", '/a/../b', "/it's", 'relative/path', 'x;touch /tmp/pwned'].sort());
  assert.equal(isSafeVolumePath('/var/lib/postgresql/data'), true);
  assert.equal(isSafeVolumePath('/'), true);
  assert.equal(isSafeVolumePath('/..'), false);
});

// ---------------------------------------------------------------------------
// ndjson + the one-call docker state
// ---------------------------------------------------------------------------
test('ndjson: one object per line, LF or CRLF; warnings, arrays, scalars and broken lines skipped', () => {
  assert.deepEqual(ndjson(''), []);
  assert.deepEqual(ndjson(null), []);
  assert.deepEqual(ndjson('{"a":1}\r\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
  const txt = ['WARNING: No swap limit support', '{"ID":"abc","Names":"web"}', '{not json', '[1,2,3]', '42', '{"a":1} trailing', '{"ID":"def","Names":"db"}'].join('\n');
  assert.deepEqual(ndjson(txt), [{ ID: 'abc', Names: 'web' }, { ID: 'def', Names: 'db' }]);
});

test('parseDockerState: sections between markers; no server version = not installed', () => {
  const out = [
    '__VER__27.3.1',
    '__PS__',
    '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 2 minutes","Ports":"0.0.0.0:8080->80/tcp","CreatedAt":"x"}',
    '__IM__',
    '{"ID":"i1","Repository":"nginx","Tag":"latest","Size":"50MB","CreatedSince":"2 weeks ago"}',
    '{"ID":"i2","Repository":"<none>","Tag":"<none>","Size":"1MB","CreatedSince":"1 day ago"}',
    '__NW__',
    '{"ID":"n1","Name":"bridge","Driver":"bridge","Scope":"local"}',
    '__VO__',
    '{"Name":"data","Driver":"local"}',
    '__END__',
  ].join('\n');
  const s = parseDockerState(out);
  assert.equal(s.installed, true);
  assert.equal(s.version, '27.3.1');
  assert.equal(s.containers.length, 1);
  assert.equal(s.containers[0].running, true);
  assert.equal(s.images.length, 2);
  assert.equal(s.images[1].dangling, true);
  assert.deepEqual(s.networks, [{ id: 'n1', name: 'bridge', driver: 'bridge', scope: 'local' }]);
  assert.deepEqual(s.volumes, [{ name: 'data', driver: 'local' }]);
  assert.equal(parseDockerState('__VER__\n').installed, false);
  assert.equal(parseDockerState('').installed, false);
});

test('localtimeFix only interpolates a plain zone name', () => {
  assert.match(localtimeFix('America/New_York'), /zoneinfo\/America\/New_York/);
  assert.match(localtimeFix('x; rm -rf /'), /zoneinfo\/UTC /);
});

// ---------------------------------------------------------------------------
// deploy port planner (MNT-10: extracted and testable)
// ---------------------------------------------------------------------------
test('planPortMappings: image ports map host=guest=container when free', () => {
  const added = planPortMappings({ vmPorts: [], sshPort: 2223, explicit: [], imagePorts: [80, 443], cname: 'nginx', taken: new Set([8777]), defaultLan: false });
  assert.deepEqual(added, [
    { host: 80, guest: 80, container: 80, owner: 'nginx', lan: false },
    { host: 443, guest: 443, container: 443, owner: 'nginx', lan: false },
  ]);
});

test('planPortMappings: explicit host:container picks a free GUEST port; derived host ports skip taken ones', () => {
  const vmPorts = [{ host: 9080, guest: 8080, container: 80, owner: 'other' }];
  const added = planPortMappings({
    vmPorts: vmPorts, sshPort: 2223, explicit: [{ host: 8080, guest: 80, lan: true }], imagePorts: [80, 3000],
    cname: 'web', taken: new Set([3000, 3001]), defaultLan: false,
  });
  assert.deepEqual(added, [
    { host: 8080, guest: 8081, container: 80, owner: 'web', lan: true },
    { host: 3002, guest: 3000, container: 3000, owner: 'web', lan: false },
  ]);
});

test('planPortMappings: an explicit host port that is taken is a clear 409, not silently moved', () => {
  assert.throws(() => planPortMappings({ vmPorts: [], explicit: [{ host: 8777, guest: 80 }], imagePorts: [], cname: 'x', taken: new Set([8777]) }),
    (e) => e.status === 409 && /8777/.test(e.message));
  assert.throws(() => planPortMappings({ vmPorts: [], sshPort: 2223, explicit: [{ host: 2223, guest: 80 }], imagePorts: [], cname: 'x', taken: new Set() }),
    (e) => e.status === 409);
});

test('planPortMappings: redeploying the same container reuses its mappings', () => {
  const vmPorts = [{ host: 8080, guest: 8080, container: 80, owner: 'web' }];
  assert.deepEqual(planPortMappings({ vmPorts: vmPorts, explicit: [], imagePorts: [80], cname: 'web', taken: new Set() }), []);
});

test('planPortMappings: host networking forwards host -> the container port itself (BUG-18)', () => {
  const added = planPortMappings({ vmPorts: [], explicit: [{ host: 8123, guest: 8123 }], imagePorts: [], cname: 'ha', taken: new Set(), hostNetwork: true });
  assert.deepEqual(added, [{ host: 8123, guest: 8123, container: 8123, owner: 'ha', lan: false }]);
  const added2 = planPortMappings({ vmPorts: [], explicit: [{ host: 9000, guest: 80 }], imagePorts: [], cname: 'x', taken: new Set(), hostNetwork: true });
  assert.equal(added2[0].guest, 80);
});

test('parseRunResult: exit status from the __RC marker; a missing marker is NOT success (MNT-8)', () => {
  assert.deepEqual(parseRunResult('abc123\n__RC=0\n'), { rc: 0, body: 'abc123' });
  assert.deepEqual(parseRunResult('Error: port is already allocated\n__RC=125'), { rc: 125, body: 'Error: port is already allocated' });
  assert.deepEqual(parseRunResult('__RC=1'), { rc: 1, body: '' });
  assert.equal(parseRunResult('abc123').rc, null);
  assert.equal(parseRunResult('').rc, null);
  assert.equal(parseRunResult('echo __RC=0 in the middle\nmore').rc, null);
});

test('containerNameFor: derived from the image unless given', () => {
  assert.equal(containerNameFor('ghcr.io/home-assistant/home-assistant:stable'), 'home-assistant');
  assert.equal(containerNameFor('nginx@sha256:abc'), 'nginx');
  assert.equal(containerNameFor('nginx', 'mine'), 'mine');
});

// ---------------------------------------------------------------------------
// QEMU command line
// ---------------------------------------------------------------------------
test('macForPort: locally administered QEMU prefix + the port in the last two bytes, unique per port', () => {
  assert.equal(macForPort(2223), '52:54:00:00:08:af');
  assert.equal(macForPort(8777), '52:54:00:00:22:49');
  assert.equal(macForPort(65535), '52:54:00:00:ff:ff');
  const seen = new Set();
  for (let p = 1; p <= 65535; p++) seen.add(macForPort(p));
  assert.equal(seen.size, 65535);
});

test('netdevFor: SSH + app forwards, each bound to 127.0.0.1 (this PC) or 0.0.0.0 (LAN) as chosen', () => {
  assert.equal(netdevFor({ port: 2223 }), 'user,id=n0,hostfwd=tcp:127.0.0.1:2223-:22');
  assert.equal(netdevFor({ port: 2223, sshLan: true, ports: [] }), 'user,id=n0,hostfwd=tcp:0.0.0.0:2223-:22');
  const vm = { port: 2224, ports: [{ host: 8080, guest: 80, container: 80, owner: 'nginx', lan: false }, { host: 3000, guest: 3000, lan: true }] };
  assert.equal(netdevFor(vm), 'user,id=n0,hostfwd=tcp:127.0.0.1:2224-:22,hostfwd=tcp:127.0.0.1:8080-:80,hostfwd=tcp:0.0.0.0:3000-:3000');
  // invalid rows can never reach QEMU
  assert.equal(netdevFor({ port: 2225, ports: [null, { host: 0, guest: 80 }, { host: 9000 }, { host: 70000, guest: 1 }] }), 'user,id=n0,hostfwd=tcp:127.0.0.1:2225-:22');
});

test('qemuArgs: direct spawn arguments - private sockets, pidfile, no -no-reboot, escaped commas', () => {
  const a = qemuArgs({
    name: 'web', disk: 'C:/data,1/sandboxes/web.qcow2', mem: 2048, cpus: 2, accel: 'tcg',
    netdev: 'user,id=n0,hostfwd=tcp:127.0.0.1:2223-:22', mac: '52:54:00:00:08:af',
    monitor: { host: '127.0.0.2', port: 50001 }, serial: { host: '127.0.0.2', port: 50002 },
    serialLog: 'C:/data/sandboxes/web-serial.log', pidFile: 'C:/data/run/web.pid',
  });
  const s = a.join(' ');
  assert.deepEqual(a.slice(0, 6), ['-name', 'web', '-m', '2048', '-smp', '2']);
  assert.ok(s.includes('-accel tcg -cpu max'));
  assert.ok(s.includes('file=C:/data,,1/sandboxes/web.qcow2,if=virtio,format=qcow2,discard=unmap,detect-zeroes=unmap'));
  assert.ok(s.includes('-chardev socket,id=ser0,host=127.0.0.2,port=50002,server=on,wait=off,logfile=C:/data/sandboxes/web-serial.log,logappend=off -serial chardev:ser0'));
  assert.ok(s.includes('-chardev socket,id=mon0,host=127.0.0.2,port=50001,server=on,wait=off -mon chardev=mon0,mode=readline'));
  assert.ok(s.includes('-pidfile C:/data/run/web.pid'));
  assert.ok(s.includes('-display none'));
  assert.equal(a.indexOf('-no-reboot'), -1);
  assert.equal(a.indexOf('-nographic'), -1);
  const u = qemuArgs({ name: 'w', disk: '/d/w.qcow2', mem: 1024, cpus: 1, accel: 'kvm', netdev: 'user,id=n0', mac: 'm',
    monitor: { path: '/run/w.mon' }, serial: { path: '/run/w.ser' } }).join(' ');
  assert.ok(u.includes('-chardev socket,id=mon0,path=/run/w.mon,server=on,wait=off'));
  assert.ok(u.includes('-accel kvm -accel tcg'));
});

// microVM spec item J: the fallback TCG gets a 256 MB translation cache
// instead of the 1 GiB QEMU commits up front on Windows
test('accelArgs: hardware accel falls back to TCG inside QEMU (with a capped translation cache)', () => {
  assert.deepEqual(accelArgs('tcg'), ['-accel', 'tcg', '-cpu', 'max']);
  assert.deepEqual(accelArgs('whpx'), ['-accel', 'whpx,kernel-irqchip=off', '-accel', 'tcg,tb-size=256']);
  assert.deepEqual(accelArgs('hvf'), ['-accel', 'hvf', '-accel', 'tcg,tb-size=256']);
});

// ---------------------------------------------------------------------------
// fmtBytes
// ---------------------------------------------------------------------------
test('fmtBytes: bytes raw, larger units with one decimal, TB the largest, unknown = "?"', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
  assert.equal(fmtBytes(2 * Math.pow(1024, 5)), '2048.0 TB');
  assert.equal(fmtBytes(1048575), '1024.0 KB');
  for (const v of [null, undefined, NaN, '']) assert.equal(fmtBytes(v), '?');
});
