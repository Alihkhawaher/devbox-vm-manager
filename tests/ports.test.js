'use strict';
/*
 * lib/ports.js: the one parser/validator for port forwards (MNT-5), the
 * local/LAN choice (spec section 7), metadata preservation (BUG-10),
 * reservation, free checks and allocation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const ports = require('../lib/ports');
const st = require('../lib/state');
const { CFG } = require('../lib/config');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const L = (host, guest, lan) => ({ host: host, guest: guest, lan: !!lan });

test('parsePortSpec: empty or missing spec gives no mappings', () => {
  assert.deepEqual(ports.parsePortSpec('', { defaultLan: false }), []);
  assert.deepEqual(ports.parsePortSpec(undefined), []);
  assert.deepEqual(ports.parsePortSpec(null), []);
  assert.deepEqual(ports.parsePortSpec(' , ,\n  '), []);
  assert.deepEqual(ports.parsePortSpec([]), []);
});

test('parsePortSpec: host only, host:guest, commas and newlines, order kept', () => {
  assert.deepEqual(ports.parsePortSpec('8080', { defaultLan: false }), [L(8080, 8080)]);
  assert.deepEqual(ports.parsePortSpec(8080, { defaultLan: false }), [L(8080, 8080)]);
  assert.deepEqual(ports.parsePortSpec(' 8080:80 ,, 3000\n9000:90\r\n', { defaultLan: false }), [L(8080, 80), L(3000, 3000), L(9000, 90)]);
  assert.deepEqual(ports.parsePortSpec('08080:080', { defaultLan: false }), [L(8080, 80)]);
});

test('parsePortSpec: lan:/local:/0.0.0.0:/127.0.0.1: prefixes set the exposure per entry', () => {
  assert.deepEqual(ports.parsePortSpec('lan:3000:3000, local:8080:80, 0.0.0.0:8123, 127.0.0.1:9000', { defaultLan: false }),
    [L(3000, 3000, true), L(8080, 80, false), L(8123, 8123, true), L(9000, 9000, false)]);
  assert.deepEqual(ports.parsePortSpec('LAN:5000', { defaultLan: false }), [L(5000, 5000, true)]);
});

test('parsePortSpec: without a prefix the default exposure applies ("local" unless set otherwise)', () => {
  assert.deepEqual(ports.parsePortSpec('8080', { defaultExpose: 'lan' }), [L(8080, 8080, true)]);
  assert.deepEqual(ports.parsePortSpec('8080', { defaultExpose: 'local' }), [L(8080, 8080, false)]);
  assert.deepEqual(ports.parsePortSpec('lan:8080', { defaultExpose: 'local' })[0].lan, true);
  assert.deepEqual(ports.parsePortSpec('local:8080', { defaultExpose: 'lan' })[0].lan, false);
});

test('parsePortSpec: range 1..65535 on both sides', () => {
  assert.deepEqual(ports.parsePortSpec('1:65535', { defaultLan: false }), [L(1, 65535)]);
  for (const bad of ['65536', '0:80', '80:0', '00000', '99999:80']) {
    assert.throws(() => ports.parsePortSpec(bad), (e) => e.status === 400 && /out of range/.test(e.message), bad);
  }
});

test('parsePortSpec: malformed entries are rejected with a hint', () => {
  for (const bad of ['abc', '123456', '80:', ':80', '8080-8090', '1.5', '8080:80:1', '-1', '80 : 81', 'tcp:80', 'lan:', 'wan:80', '10.0.0.1:80']) {
    assert.throws(() => ports.parsePortSpec(bad), (e) => e.status === 400 && /bad port mapping ".*" - use \[lan:\]host\[:guest\]/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => ports.parsePortSpec('8080,abc'), /bad port mapping "abc"/);
});

test('parsePortSpec: the SSH port and duplicate host ports are refused; shared guest ports are fine', () => {
  assert.throws(() => ports.parsePortSpec('2223:22', 2223), /this VM's SSH port/);
  assert.throws(() => ports.parsePortSpec('8080:80,lan:8080:81'), /duplicate host port 8080/);
  assert.deepEqual(ports.parsePortSpec('8080:80,8081:80', { defaultLan: false }), [L(8080, 80), L(8081, 80)]);
});

test('parsePortSpec: arrays of objects (the GUI row editor) with metadata', () => {
  const out = ports.parsePortSpec([
    { host: 8080, guest: 80, container: 80, owner: 'nginx', lan: true },
    { host: '3000', guest: '3001' },
    '9000:9',
  ], { defaultLan: false });
  assert.deepEqual(out, [
    { host: 8080, guest: 80, container: 80, owner: 'nginx', lan: true },
    { host: 3000, guest: 3001, lan: false },
    L(9000, 9),
  ]);
  assert.throws(() => ports.parsePortSpec([{ host: 'x', guest: 1 }]), (e) => e.status === 400);
  assert.throws(() => ports.parsePortSpec([{ host: 1, guest: 70000 }]), (e) => e.status === 400);
  assert.throws(() => ports.parsePortSpec([{ host: 80, owner: 'bad owner;' }]), (e) => e.status === 400);
  assert.throws(() => ports.parsePortSpec([{ host: 80, lan: 'yes' }]), (e) => e.status === 400);
  assert.throws(() => ports.parsePortSpec([[80]]), (e) => e.status === 400);
});

test('hostfwd rules carry the bind address of the user\'s choice', () => {
  assert.equal(ports.hostfwdRule(L(8080, 80, false)), 'tcp:127.0.0.1:8080-:80');
  assert.equal(ports.hostfwdRule(L(8080, 80, true)), 'tcp:0.0.0.0:8080-:80');
  assert.equal(ports.hostfwdHost(L(8080, 80, true)), 'tcp:0.0.0.0:8080');
  assert.equal(ports.bindAddress(false), '127.0.0.1');
  assert.match(ports.describe(L(8080, 80, true)), /LAN/);
  assert.match(ports.describe(L(8080, 80, false)), /this PC only/);
  assert.deepEqual(ports.urlFor(L(8080, 80, true)), { url: 'http://127.0.0.1:8080', lan: true, host: 8080 });
});

test('mergeMappings keeps container/owner of rows the user did not change (BUG-10)', () => {
  const old = [
    { host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false },
    { host: 3000, guest: 3000, lan: false },
  ];
  const edited = [L(8080, 8080, true), L(4000, 4000), { host: 3000, guest: 3000, lan: false, owner: 'explicit' }];
  assert.deepEqual(ports.mergeMappings(old, edited), [
    { host: 8080, guest: 8080, lan: true, container: 80, owner: 'nginx' },
    L(4000, 4000),
    { host: 3000, guest: 3000, lan: false, owner: 'explicit' },
  ]);
  // a changed guest port is a different mapping: no metadata carried over
  assert.deepEqual(ports.mergeMappings(old, [L(8080, 81)]), [L(8080, 81)]);
});

test('reservedPorts / validateMappings: manager, SSH ports, other VMs\' forwards, monitors', async () => {
  const root = useTempRoot('ports');
  try {
    st.loadState();
    st.state.vms.a = st.newVmRecord({ port: 2223, ports: [L(8080, 80)] });
    st.state.vms.b = st.newVmRecord({ port: 2224, ports: [L(9000, 9000)], runtime: { pid: 1, monitor: { host: '127.0.0.2', port: 50001 }, serial: { host: '127.0.0.2', port: 50002 } } });
    const r = ports.reservedPorts();
    assert.match(r.get(CFG.serverPort), /manager/);
    assert.match(r.get(2222), /base-image build/);
    assert.match(r.get(2224), /SSH port of VM "b"/);
    assert.match(r.get(8080), /forward of VM "a"/);
    assert.match(r.get(50001), /monitor of VM "b"/);
    // a VM's own forwards do not count when its list is being replaced
    assert.equal(ports.reservedPorts({ exceptVm: 'a' }).has(8080), false);
    await ports.validateMappings('a', [L(8080, 81), L(8081, 80)]);
    await assert.rejects(ports.validateMappings('a', [L(9000, 1)]), (e) => e.status === 409 && /already used by a port forward of VM "b"/.test(e.message));
    await assert.rejects(ports.validateMappings('a', [L(CFG.serverPort, 1)]), (e) => e.status === 409 && /manager/.test(e.message));
    await assert.rejects(ports.validateMappings('a', [L(2224, 22)]), (e) => /SSH port of VM "b"/.test(e.message));
    await assert.rejects(ports.validateMappings('a', [L(2223, 22)]), (e) => e.status === 400 && /SSH port of this VM/.test(e.message));
    // a port another program holds is refused when it must be bound now
    const srv = net.createServer();
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const busy = srv.address().port;
    try {
      await ports.validateMappings('a', [L(busy, 80)]); // not checked unless asked
      await assert.rejects(ports.validateMappings('a', [L(busy, 80)], { checkFree: [busy] }), (e) => e.status === 409 && /in use by another program/.test(e.message));
    } finally { await new Promise((res) => srv.close(res)); }
  } finally { resetConfig(); rm(root); }
});

test('allocSshPort skips reserved and busy ports and never hands out the same port twice', async () => {
  const root = useTempRoot('alloc');
  try {
    st.loadState();
    st.state.vms.a = st.newVmRecord({ port: 2223, ports: [L(2224, 80)] });
    const [p1, p2] = await Promise.all([ports.allocSshPort(), ports.allocSshPort()]);
    assert.ok(p1 >= 2225 && p2 >= 2225);
    assert.notEqual(p1, p2);
    ports.release(p1); ports.release(p2);
    const h = await ports.allocHostPort(8080, { taken: new Set([8080]) });
    assert.ok(h > 8080);
    ports.release(h);
  } finally { resetConfig(); rm(root); }
});
