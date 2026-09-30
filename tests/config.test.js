'use strict';
/*
 * lib/config.js: data-root and port precedence (spec section 2), config.json
 * overrides, derived limits, the access token and the command line.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');
const { CFG, configure, parseArgs, APP_DIR } = config;
const { useTempRoot, resetConfig, rm } = require('./helpers');

const norm = (p) => path.resolve(p).replace(/\\/g, '/');
function tmp(label) { return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-cfg-' + label + '-')); }

test('data root: --data beats VM_MANAGER_ROOT beats the legacy home layout beats <app>/data', () => {
  const home = tmp('home');
  const envRoot = tmp('env');
  const dataArg = tmp('arg');
  try {
    // nothing special: the portable default next to the code
    configure({ env: {}, home: home });
    assert.equal(CFG.root, norm(path.join(APP_DIR, 'data')));
    assert.equal(CFG.rootSource, 'default');
    // an existing v1 install in the home folder keeps working
    fs.mkdirSync(path.join(home, 'sandboxes'));
    configure({ env: {}, home: home });
    assert.equal(CFG.root, norm(home));
    // the environment beats the legacy layout
    configure({ env: { VM_MANAGER_ROOT: envRoot }, home: home });
    assert.equal(CFG.root, norm(envRoot));
    assert.equal(CFG.rootSource, 'VM_MANAGER_ROOT');
    // the command line beats everything
    configure({ data: dataArg, env: { VM_MANAGER_ROOT: envRoot }, home: home });
    assert.equal(CFG.root, norm(dataArg));
    assert.equal(CFG.rootSource, '--data');
  } finally {
    resetConfig();
    rm(home); rm(envRoot); rm(dataArg);
  }
});

test('a legacy home is also recognised by devbox-base.qcow2 alone', () => {
  const home = tmp('home2');
  try {
    fs.writeFileSync(path.join(home, 'devbox-base.qcow2'), '');
    configure({ env: {}, home: home });
    assert.equal(CFG.root, norm(home));
  } finally { resetConfig(); rm(home); }
});

test('port: --port beats VM_MANAGER_PORT beats config.json beats 8777', () => {
  const root = tmp('port');
  try {
    configure({ data: root, env: {} });
    assert.equal(CFG.serverPort, 8777);
    assert.equal(CFG.portSource, 'default');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port: 9100 }));
    configure({ data: root, env: {} });
    assert.equal(CFG.serverPort, 9100);
    assert.equal(CFG.portSource, 'config.json');
    configure({ data: root, env: { VM_MANAGER_PORT: '9200' } });
    assert.equal(CFG.serverPort, 9200);
    configure({ data: root, env: { VM_MANAGER_PORT: 'junk' } });
    assert.equal(CFG.serverPort, 9100, 'a bad env value is ignored, not fatal');
    configure({ data: root, port: 9300, env: { VM_MANAGER_PORT: '9200' } });
    assert.equal(CFG.serverPort, 9300);
    assert.equal(CFG.portSource, '--port');
  } finally { resetConfig(); rm(root); }
});

test('config.json: tool overrides are read; a broken file is a warning, not a crash', () => {
  const root = tmp('cfgjson');
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ qemuDir: 'D:/tools/qemu', ssh: 'C:/x/ssh.exe', scp: '', sevenZip: 5 }));
    configure({ data: root, env: {} });
    assert.equal(CFG.toolOverrides.qemuDir, 'D:/tools/qemu');
    assert.equal(CFG.toolOverrides.ssh, 'C:/x/ssh.exe');
    assert.equal(CFG.toolOverrides.scp, null);
    assert.equal(CFG.toolOverrides.sevenZip, null);
    assert.equal(CFG.configWarning, null);
    fs.writeFileSync(path.join(root, 'config.json'), '{ not json');
    configure({ data: root, env: {} });
    assert.match(CFG.configWarning, /config\.json ignored/);
    assert.equal(CFG.serverPort, 8777);
  } finally { resetConfig(); rm(root); }
});

test('every path lives under the data root, including vms.json and the token', () => {
  const root = useTempRoot('paths');
  try {
    const r = norm(root);
    assert.equal(CFG.root, r);
    for (const k of ['sandboxDir', 'basesDir', 'base', 'alpine', 'downloadsDir', 'qemuDir', 'seedDir', 'sshKey', 'sshPub',
      'runDir', 'knownHostsDir', 'managerFile', 'logsDir', 'managerLog', 'tasksLog', 'stateFile', 'tokenFile', 'configFile']) {
      assert.ok(CFG[k].indexOf(r + '/') === 0, k + ' = ' + CFG[k]);
    }
    assert.equal(CFG.stateFile, r + '/vms.json');
    assert.equal(CFG.managerFile, r + '/run/manager.json');
    assert.equal(CFG.tokenFile, r + '/manager-token');
    assert.equal(CFG.legacyStateFile, norm(path.join(APP_DIR, 'vms.json')));
  } finally { resetConfig(); rm(root); }
});

test('configure mutates CFG in place (modules keep one reference)', () => {
  const before = CFG;
  const root = useTempRoot('inplace');
  try {
    assert.equal(CFG, before);
    const { diskPath } = require('../lib/state');
    assert.equal(norm(diskPath('web')), norm(path.join(root, 'sandboxes', 'web.qcow2')));
  } finally { resetConfig(); rm(root); }
});

test('limits are derived from the host', () => {
  assert.equal(config.maxMemFor(16 * 1024 ** 3), 14848);
  assert.equal(config.maxMemFor(4 * 1024 ** 3), 2560);
  assert.equal(config.maxMemFor(1 * 1024 ** 3), 1024, 'never below 1 GB');
  assert.equal(CFG.maxCpus, os.cpus().length);
  assert.equal(CFG.defaultMem, 1024);
  assert.equal(CFG.defaultCpus, 2);
  assert.equal(CFG.firstSshPort, 2223);
  assert.ok(CFG.maxMem >= 1024 && CFG.maxMem % 256 === 0);
});

test('rootId: 12 hex chars, stable, different per folder', () => {
  const a = config.rootId('C:/data/one'), b = config.rootId('C:/data/one'), c = config.rootId('C:/data/two');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('ensureToken: created once (48 hex chars), then reused; readToken rejects junk', () => {
  const root = useTempRoot('token');
  try {
    assert.equal(config.readToken(), null);
    const t1 = config.ensureToken();
    assert.match(t1, /^[0-9a-f]{48}$/);
    assert.equal(config.ensureToken(), t1);
    assert.equal(config.readToken(), t1);
    fs.writeFileSync(CFG.tokenFile, 'not a token');
    assert.equal(config.readToken(), null);
    const t2 = config.ensureToken();
    assert.notEqual(t2, t1);
    assert.equal(config.readToken(), t2);
  } finally { resetConfig(); rm(root); }
});

test('protectToken: an EXISTING token file is made private again (a moved data folder gives it open permissions - security-5)', () => {
  const root = useTempRoot('token-acl');
  try {
    assert.deepEqual(config.protectToken(), { ok: true, error: null }, 'no file: nothing to do');
    config.ensureToken();
    if (process.platform !== 'win32') fs.chmodSync(CFG.tokenFile, 0o644);
    const r = config.protectToken();
    assert.equal(r.ok, true, r.error);
    if (process.platform !== 'win32') assert.equal(fs.statSync(CFG.tokenFile).mode & 0o777, 0o600);
    else {
      // only this user (and no inherited entries) may read it
      const out = require('child_process').execFileSync('icacls', [path.win32.normalize(CFG.tokenFile)], { encoding: 'utf8', windowsHide: true });
      assert.doesNotMatch(out, /Everyone|Authenticated Users|BUILTIN\\Users|\(I\)/i, out);
    }
  } finally { resetConfig(); rm(root); }
});

test('config.json opt-outs: allowSharedLoopback / allowUnsignedQemu only for the JSON value true', () => {
  const root = useTempRoot('optin');
  try {
    assert.equal(CFG.allowSharedLoopback, false);
    assert.equal(CFG.allowUnsignedQemu, false);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ allowSharedLoopback: 'yes', allowUnsignedQemu: true }));
    config.configure({ data: root });
    assert.equal(CFG.allowSharedLoopback, false, '"yes" is not true');
    assert.equal(CFG.allowUnsignedQemu, true);
  } finally { resetConfig(); rm(root); }
});

test('parseArgs: defaults and every flag form', () => {
  assert.deepEqual(parseArgs([]), { port: null, data: null, noOpen: false, help: false, unknown: [] });
  assert.deepEqual(parseArgs(undefined), { port: null, data: null, noOpen: false, help: false, unknown: [] });
  assert.deepEqual(parseArgs(['--port', '8781', '--data', 'C:/x y/d', '--no-open']),
    { port: 8781, data: 'C:/x y/d', noOpen: true, help: false, unknown: [] });
  assert.equal(parseArgs(['--port=9000']).port, 9000);
  assert.equal(parseArgs(['--data=/tmp/a b']).data, '/tmp/a b');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.deepEqual(parseArgs(['--bogus', 'x', '--no-open']).unknown, ['--bogus', 'x']);
});

test('parseArgs: bad values are refused with a clear message', () => {
  assert.throws(() => parseArgs(['--port', '0']), /--port must be a number between 1 and 65535/);
  assert.throws(() => parseArgs(['--port', '65536']), /--port must be/);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port must be/);
  assert.throws(() => parseArgs(['--port', '80.5']), /--port must be/);
  assert.throws(() => parseArgs(['--port=']), /--port must be/);
  assert.throws(() => parseArgs(['--port']), /--port needs a value/);
  assert.throws(() => parseArgs(['--port', '--no-open']), /--port needs a value/);
  assert.throws(() => parseArgs(['--data']), /--data needs a value/);
  assert.throws(() => parseArgs(['--data', '  ']), /--data needs a folder path/);
});

test('normDir keeps drive roots and the POSIX root absolute', () => {
  assert.equal(config.normDir('C:\\'), 'C:/');
  assert.equal(config.normDir('C:\\data\\'), 'C:/data');
  assert.equal(config.normDir('/'), '/');
  assert.equal(config.normDir('/srv/vms/'), '/srv/vms');
});
