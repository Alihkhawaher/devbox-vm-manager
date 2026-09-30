'use strict';
/*
 * lib/state.js: atomic write-on-change, corrupt-file recovery, v1 migration,
 * the old registry location, missing disks kept (BUG-4, OPS-6, OPS-7, MNT-11,
 * BUG-17).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const st = require('../lib/state');
const { CFG } = require('../lib/config');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const V1 = {
  vms: {
    web: { port: 2223, mem: 2048, cpus: 4, pid: 4312, startedAt: '2025-01-01T00:00:00Z', createdAt: '2024-12-01T00:00:00Z',
      ports: [{ host: 8080, guest: 80, container: 80, owner: 'nginx' }, { host: 0, guest: 1 }], base: 'C:\\Users\\me\\devbox-base.qcow2', autostart: true, note: 'hi' },
    db: { port: 2224, mem: 1024, cpus: 2, base: 'C:/Users/me/vm-bases/docker-ready.qcow2' },
    'bad name': { port: 2225 },
  },
  nextPort: 2226,
};

function disk(name) { fs.mkdirSync(CFG.sandboxDir, { recursive: true }); fs.writeFileSync(st.diskPath(name), ''); }

test('migrate: v1 records become v2 (template names, lan:false, no pid, bad rows dropped)', () => {
  const m = st.migrate(V1);
  assert.equal(m.version, 2);
  assert.equal(m.migratedFrom, 1);
  assert.deepEqual(m.settings, { accel: 'auto', defaultExpose: 'local' });
  assert.deepEqual(Object.keys(m.vms).sort(), ['db', 'web']);
  const web = m.vms.web;
  assert.equal(web.template, 'devbox-base');
  assert.equal(m.vms.db.template, 'docker-ready');
  assert.equal(web.mem, 2048);
  assert.equal(web.cpus, 4);
  assert.equal(web.autostart, true);
  assert.equal(web.note, 'hi');
  assert.equal(web.runtime, null, 'a pid from a previous boot is never trusted');
  assert.equal(web.pid, undefined);
  assert.equal(web.startedAt, undefined);
  assert.deepEqual(web.ports, [{ host: 8080, guest: 80, container: 80, owner: 'nginx', lan: false }]);
  assert.equal(web.sshLan, false);
  assert.equal(web.createdAt, '2024-12-01T00:00:00Z');
});

test('cleanVm keeps a UDP forward UDP (it used to come back as TCP after a manager restart)', () => {
  const m = st.migrate({ version: 2, settings: {}, vms: { dns: { port: 2230, ports: [{ host: 5353, guest: 53, lan: true, proto: 'udp' }, { host: 8080, guest: 80, proto: 'tcp' }] } } });
  assert.deepEqual(m.vms.dns.ports, [{ host: 5353, guest: 53, lan: true, proto: 'udp' }, { host: 8080, guest: 80, lan: false }]);
});

test('loadState: first run creates vms.json v2 atomically; saveState writes only on change', () => {
  const root = useTempRoot('state1');
  try {
    st.loadState();
    assert.ok(fs.existsSync(CFG.stateFile));
    const j = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    assert.equal(j.version, 2);
    assert.deepEqual(j.vms, {});
    const m1 = fs.statSync(CFG.stateFile).mtimeMs;
    // no change -> no write (the file is not even touched)
    fs.utimesSync(CFG.stateFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
    assert.equal(st.saveState(), true);
    assert.equal(fs.statSync(CFG.stateFile).mtime.getFullYear(), 2000);
    // a change is written, and the previous file is kept as .bak
    st.state.settings.defaultExpose = 'lan';
    assert.equal(st.saveState(), true);
    assert.equal(JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')).settings.defaultExpose, 'lan');
    assert.ok(fs.existsSync(CFG.stateFile + '.bak'));
    assert.equal(fs.existsSync(CFG.stateFile + '.tmp'), false);
    assert.ok(m1 > 0);
    assert.equal(st.stateWarning(), null);
  } finally { resetConfig(); rm(root); }
});

test('loadState: a corrupt vms.json is kept aside (never overwritten), .bak restores the VMs, a warning is shown', () => {
  const root = useTempRoot('state2');
  try {
    disk('web');
    st.loadState();
    st.state.vms.web.mem = 3072;
    st.saveState();
    st.state.vms.web.note = 'second save';
    st.saveState(); // .bak now holds the mem=3072 version
    fs.writeFileSync(CFG.stateFile, '{"version": 2, "vms": {"web": {');
    st.loadState();
    const aside = fs.readdirSync(root).filter((f) => /^vms\.json\.corrupt-/.test(f));
    assert.equal(aside.length, 1, 'the damaged file is renamed aside');
    assert.equal(fs.readFileSync(path.join(root, aside[0]), 'utf8'), '{"version": 2, "vms": {"web": {');
    assert.equal(st.state.vms.web.mem, 3072, 'settings restored from vms.json.bak');
    assert.match(st.stateWarning(), /could not be parsed/);
    assert.match(st.stateWarning(), /restored the VM settings from vms\.json\.bak/);
    assert.equal(JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')).version, 2, 'a fresh valid file is written');
  } finally { resetConfig(); rm(root); }
});

test('loadState: corrupt with no backup starts from the disks found (records re-created, not lost silently)', () => {
  const root = useTempRoot('state3');
  try {
    disk('a'); disk('b');
    fs.writeFileSync(CFG.stateFile, 'garbage');
    st.loadState();
    assert.deepEqual(Object.keys(st.state.vms).sort(), ['a', 'b']);
    assert.equal(st.state.vms.a.template, null, 'template unknown until the backing file is read');
    assert.notEqual(st.state.vms.a.port, st.state.vms.b.port);
    assert.match(st.stateWarning(), /could not be parsed/);
  } finally { resetConfig(); rm(root); }
});

test('loadState: a VM whose disk is missing is kept (status "missing"), never deleted (BUG-17)', () => {
  const root = useTempRoot('state4');
  try {
    fs.writeFileSync(CFG.stateFile, JSON.stringify(V1));
    st.loadState(); // no sandboxes folder at all (e.g. an unplugged drive)
    assert.deepEqual(Object.keys(st.state.vms).sort(), ['db', 'web']);
    const saved = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(Object.keys(saved.vms).sort(), ['db', 'web']);
  } finally { resetConfig(); rm(root); }
});

test('loadState: the old registry beside the code is moved into the data root once (OPS-7)', () => {
  const root = useTempRoot('state5');
  const legacyDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-legacy-'));
  const savedLegacy = CFG.legacyStateFile;
  try {
    CFG.legacyStateFile = path.join(legacyDir, 'vms.json').replace(/\\/g, '/');
    fs.writeFileSync(CFG.legacyStateFile, JSON.stringify(V1));
    // an explicit --data folder never takes the legacy registry
    st.loadState();
    assert.deepEqual(st.state.vms, {});
    assert.ok(fs.existsSync(CFG.legacyStateFile));
    // the default / VM_MANAGER_ROOT / legacy-home roots do
    fs.rmSync(CFG.stateFile);
    CFG.rootSource = 'VM_MANAGER_ROOT';
    st.loadState();
    assert.ok(st.state.vms.web);
    assert.equal(fs.existsSync(CFG.legacyStateFile), false);
    assert.ok(fs.existsSync(CFG.legacyStateFile + '.migrated'));
    assert.equal(JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')).vms.web.template, 'devbox-base');
  } finally { CFG.legacyStateFile = savedLegacy; resetConfig(); rm(root); rm(legacyDir); }
});

test('v1 upgrade: a record whose name v2 cannot take is reported by name, and a copy of the v1 file is kept for good', () => {
  const root = useTempRoot('state-v1');
  try {
    const v1 = { vms: { web: { port: 2223 }, _test: { port: 2224, note: 'keep me' }, 'foo.': { port: 2225 } } };
    fs.writeFileSync(CFG.stateFile, JSON.stringify(v1));
    st.loadState();
    assert.equal(st.migratedFromV1(), true);
    assert.deepEqual(Object.keys(st.state.vms), ['web']);
    const w = st.stateWarning();
    assert.match(w, /the VM "_test" from the old registry was not imported: its name is not valid/);
    assert.match(w, /rename sandboxes\/_test\.qcow2/);
    assert.match(w, /"foo\."/);
    const copies = fs.readdirSync(root).filter((f) => /^vms\.json\.v1-/.test(f));
    assert.equal(copies.length, 1);
    // later saves overwrite .bak, never the v1 copy
    st.state.vms.web.note = 'a'; st.saveState();
    st.state.vms.web.note = 'b'; st.saveState();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, copies[0]), 'utf8')), v1);
    // loading the (now v2) file again: no second copy, no warnings
    st.loadState();
    assert.equal(st.migratedFromV1(), false);
    assert.equal(fs.readdirSync(root).filter((f) => /^vms\.json\.v1-/.test(f)).length, 1);
    assert.equal(st.stateWarning(), null);
  } finally { resetConfig(); rm(root); }
});

test('saveState: a write failure is surfaced as a warning, never swallowed', () => {
  const root = useTempRoot('state6');
  try {
    st.loadState();
    // make the target a directory so the rename fails
    fs.rmSync(CFG.stateFile, { force: true });
    fs.mkdirSync(CFG.stateFile);
    st.state.settings.accel = 'tcg';
    assert.equal(st.saveState(), false);
    assert.match(st.stateWarning(), /could not save vms\.json/);
    fs.rmSync(CFG.stateFile, { recursive: true, force: true });
    assert.equal(st.saveState(), true);
    assert.equal(st.stateWarning(), null, 'the warning clears once saving works again');
  } finally { resetConfig(); rm(root); }
});

test('syncDisks: disks without a record get one with a free port; invalid names are ignored', () => {
  const root = useTempRoot('state7');
  try {
    st.loadState();
    st.state.vms.a = st.newVmRecord({ port: 2223, ports: [{ host: 2224, guest: 80 }] });
    disk('a'); disk('imported');
    fs.writeFileSync(path.join(CFG.sandboxDir, 'bad name.qcow2'), '');
    const added = st.syncDisks();
    assert.deepEqual(added, ['imported']);
    assert.equal(st.state.vms.imported.port, 2225, 'skips SSH ports and forwards already in use');
    assert.equal(st.state.vms.imported.createdBy, 'discovered');
    assert.equal(st.state.vms['bad name'], undefined);
  } finally { resetConfig(); rm(root); }
});

test('updateSettings validates accel and defaultExpose', () => {
  const root = useTempRoot('state8');
  try {
    st.loadState();
    assert.deepEqual(st.updateSettings({ accel: 'tcg', defaultExpose: 'lan' }).settings, { accel: 'tcg', defaultExpose: 'lan' });
    assert.throws(() => st.updateSettings({ accel: 'turbo' }), (e) => e.status === 400);
    assert.throws(() => st.updateSettings({ defaultExpose: 'internet' }), (e) => e.status === 400);
    assert.equal(JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')).settings.accel, 'tcg');
  } finally { resetConfig(); rm(root); }
});

test('getVm: 400 for a bad name, 404 for an unknown VM', () => {
  const root = useTempRoot('state9');
  try {
    st.loadState();
    assert.throws(() => st.getVm('../x'), (e) => e.status === 400);
    assert.throws(() => st.getVm('nope'), (e) => e.status === 404);
  } finally { resetConfig(); rm(root); }
});
