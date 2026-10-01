'use strict';
/*
 * lib/config.js: data-root and port precedence (spec section 2), config.json
 * overrides, derived limits, the access token and the command line, and the
 * engine settings with the light profile (SPEC-diskroot sections 10, 13).
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

// ---------------------------------------------------------------------------
// engine settings and the light profile (SPEC-diskroot sections 10, 13.4)
// ---------------------------------------------------------------------------
const ENGINE_CFG = ['lightProfile', 'microvmRootfs', 'microvmMemMB', 'tcgTbSizeMB', 'vmTcgTbSizeMB', 'defaultMem',
  'keepAlpineDownload', 'imagePruneDays', 'minFreeDiskMB', 'microvmImageDiskGB', 'microvmImageMaxGB'];
const engineCfg = () => { const o = {}; for (const k of ENGINE_CFG) o[k] = CFG[k]; return o; };
const NORMAL = { lightProfile: false, microvmRootfs: 'disk', microvmMemMB: 128, tcgTbSizeMB: 128, vmTcgTbSizeMB: 0, defaultMem: 1024,
  keepAlpineDownload: true, imagePruneDays: 0, minFreeDiskMB: 1024, microvmImageDiskGB: 8, microvmImageMaxGB: 16 };
const LIGHT = Object.assign({}, NORMAL, { lightProfile: true, microvmMemMB: 112, tcgTbSizeMB: 64, vmTcgTbSizeMB: 256, defaultMem: 512,
  keepAlpineDownload: false, imagePruneDays: 7 });

test('engine settings: no config.json = the normal profile on CFG (the table of spec 10)', () => {
  const root = useTempRoot('eng-normal');
  try {
    assert.deepEqual(engineCfg(), NORMAL);
    assert.deepEqual(CFG.engineExplicit, []);
    assert.equal(CFG.configWarning, null);
  } finally { resetConfig(); rm(root); }
});

test('engine settings: "lightProfile": true picks the light column; an explicit key beats the profile', () => {
  const root = tmp('eng-light');
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lightProfile: true }));
    configure({ data: root, env: {} });
    assert.deepEqual(engineCfg(), LIGHT);
    assert.deepEqual(CFG.engineExplicit, ['lightProfile']);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lightProfile: true, microvmMemMB: 160, keepAlpineDownload: true, microvmRootfs: 'ram', imagePruneDays: 0, minFreeDiskMB: 2048 }));
    configure({ data: root, env: {} });
    assert.deepEqual(engineCfg(), Object.assign({}, LIGHT, { microvmMemMB: 160, keepAlpineDownload: true, microvmRootfs: 'ram', imagePruneDays: 0, minFreeDiskMB: 2048 }));
    assert.deepEqual(CFG.engineExplicit.slice().sort(), ['imagePruneDays', 'keepAlpineDownload', 'lightProfile', 'microvmMemMB', 'microvmRootfs', 'minFreeDiskMB']);
    // the normal profile with one explicit key: only that key differs
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lightProfile: false, vmTcgTbSizeMB: 512 }));
    configure({ data: root, env: {} });
    assert.deepEqual(engineCfg(), Object.assign({}, NORMAL, { vmTcgTbSizeMB: 512 }));
  } finally { resetConfig(); rm(root); }
});

test('engine settings: an invalid value is a warning and takes the profile default - the manager still starts', () => {
  const root = tmp('eng-bad');
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      lightProfile: 'yes', microvmRootfs: 'tmpfs', microvmMemMB: 64, tcgTbSizeMB: 8, vmTcgTbSizeMB: 4096, vmDefaultMemMB: 100,
      keepAlpineDownload: 'no', imagePruneDays: 1.5, minFreeDiskMB: -1, microvmImageDiskGB: '8', microvmImageMaxGB: 0, port: 9100,
    }));
    configure({ data: root, env: {} });
    assert.deepEqual(engineCfg(), NORMAL, 'every bad key: the normal default (the bad lightProfile is ignored too)');
    assert.deepEqual(CFG.engineExplicit, []);
    for (const k of ['lightProfile', 'microvmRootfs', 'microvmMemMB', 'tcgTbSizeMB', 'vmTcgTbSizeMB', 'vmDefaultMemMB', 'keepAlpineDownload',
      'imagePruneDays', 'minFreeDiskMB', 'microvmImageDiskGB', 'microvmImageMaxGB']) {
      assert.match(CFG.configWarning, new RegExp('config\\.json: ' + k + '\\b'), k + ' is reported');
    }
    assert.match(CFG.configWarning, /microvmMemMB \(the default memory of a disk-root container\) must be a whole number of MB: 96 to \d+ - using 128/);
    assert.equal(CFG.serverPort, 9100, 'the other keys still apply');
    // 0 is "QEMU's default" for the TCG caches; null is "not set"
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lightProfile: true, tcgTbSizeMB: 0, vmTcgTbSizeMB: 0, microvmMemMB: null }));
    configure({ data: root, env: {} });
    assert.equal(CFG.tcgTbSizeMB, 0);
    assert.equal(CFG.vmTcgTbSizeMB, 0);
    assert.equal(CFG.microvmMemMB, 112);
    assert.equal(CFG.configWarning, null);
  } finally { resetConfig(); rm(root); }
});

test('effectiveDefaults is pure: profile columns, explicit keys, host memory as the upper bound', () => {
  const e = config.effectiveDefaults({ lightProfile: true, vmDefaultMemMB: 4096, microvmMemMB: 3000 }, { maxMem: 2048 });
  assert.equal(e.lightProfile, true);
  assert.equal(e.values.vmDefaultMemMB, 512, 'above this host\'s limit: the profile default');
  assert.equal(e.values.microvmMemMB, 112);
  assert.equal(e.warnings.length, 2);
  assert.deepEqual(e.explicit, ['lightProfile']);
  const n = config.effectiveDefaults({}, { maxMem: 2048 });
  assert.equal(n.lightProfile, false);
  assert.deepEqual(n.values, { microvmRootfs: 'disk', microvmMemMB: 128, tcgTbSizeMB: 128, vmTcgTbSizeMB: 0, vmDefaultMemMB: 1024,
    keepAlpineDownload: true, imagePruneDays: 0, minFreeDiskMB: 1024, microvmImageDiskGB: 8, microvmImageMaxGB: 16 });
  assert.deepEqual(config.profileDefaults().light, { microvmRootfs: 'disk', microvmMemMB: 112, tcgTbSizeMB: 64, vmTcgTbSizeMB: 256,
    vmDefaultMemMB: 512, keepAlpineDownload: false, imagePruneDays: 7 });
  // the profile never changes the root filesystem: nothing switches to RAM by itself
  assert.equal(config.profileDefaults().light.microvmRootfs, 'disk');
});

test('validateEngineSettings: the POST /api/settings ranges of spec 13.1; null = back to the profile; unknown keys ignored', () => {
  const ok = (b) => config.validateEngineSettings(b).changes;
  const bad = (b, re) => assert.throws(() => config.validateEngineSettings(b), (e) => e.status === 400 && e.code === 'BAD_REQUEST' && re.test(e.message));
  assert.deepEqual(ok({}), {});
  assert.deepEqual(ok({ accel: 'whpx', minFreeDiskMB: 5, foo: 1 }), {}, 'not engine API keys');
  assert.deepEqual(ok({ lightProfile: true, microvmRootfs: 'ram', microvmMemMB: 96, tcgTbSizeMB: 0, vmTcgTbSizeMB: 64, vmDefaultMemMB: 256, keepAlpineDownload: false, imagePruneDays: 365 }),
    { lightProfile: true, microvmRootfs: 'ram', microvmMemMB: 96, tcgTbSizeMB: 0, vmTcgTbSizeMB: 64, vmDefaultMemMB: 256, keepAlpineDownload: false, imagePruneDays: 365 });
  assert.deepEqual(ok({ microvmMemMB: null, lightProfile: null }), { microvmMemMB: null, lightProfile: null });
  bad({ lightProfile: 'true' }, /lightProfile must be true or false/);
  bad({ microvmRootfs: 'tmpfs' }, /microvmRootfs must be one of "disk", "ram"/);
  bad({ microvmMemMB: 95 }, /microvmMemMB .* 96 to /);
  bad({ microvmMemMB: CFG.maxMem + 1 }, /microvmMemMB/);
  bad({ microvmMemMB: '128' }, /microvmMemMB/);
  bad({ tcgTbSizeMB: 15 }, /tcgTbSizeMB .*0 for QEMU.s default, or 16 to 1024/);
  bad({ tcgTbSizeMB: 1025 }, /tcgTbSizeMB/);
  bad({ vmTcgTbSizeMB: 63 }, /vmTcgTbSizeMB .*64 to 2048/);
  bad({ vmDefaultMemMB: 255 }, /vmDefaultMemMB .*256 to /);
  bad({ keepAlpineDownload: 1 }, /keepAlpineDownload must be true or false/);
  bad({ imagePruneDays: 366 }, /imagePruneDays .*days: 0 to 365/);
  bad({ imagePruneDays: -1 }, /imagePruneDays/);
});

test('updateEngineSettings: ONE write to config.json (other keys kept), CFG updated in place, null removes the key', () => {
  const root = useTempRoot('eng-update');
  const before = CFG;
  try {
    fs.writeFileSync(CFG.configFile, JSON.stringify({ port: 9100, ninepPort: 5641, microvmImageDiskGB: 12 }));
    configure({ data: root, env: {} });
    let r = config.updateEngineSettings({ lightProfile: true, microvmMemMB: 144 });
    assert.equal(CFG, before, 'the same object');
    assert.equal(CFG.lightProfile, true);
    assert.equal(CFG.microvmMemMB, 144);
    assert.equal(CFG.defaultMem, 512, 'the profile default of a key nobody set');
    assert.equal(CFG.microvmImageDiskGB, 12, 'a config.json-only key stays');
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG.configFile, 'utf8')), { port: 9100, ninepPort: 5641, microvmImageDiskGB: 12, lightProfile: true, microvmMemMB: 144 });
    assert.equal(r.settings.lightProfile, true);
    assert.equal(r.settings.microvmMemMB, 144);
    assert.equal(r.settings.vmDefaultMemMB, 512);
    assert.deepEqual(r.settings.explicit.sort(), ['lightProfile', 'microvmMemMB']);
    assert.deepEqual(r.settings.profileDefaults, config.profileDefaults());
    assert.deepEqual(r.settings.ranges.microvmMemMB, { min: 96, max: CFG.maxMem, zeroOr: false });
    assert.deepEqual(r.settings.ranges.tcgTbSizeMB, { min: 16, max: 1024, zeroOr: true });
    // null: back to the profile default, the key leaves config.json
    r = config.updateEngineSettings({ microvmMemMB: null });
    assert.equal(CFG.microvmMemMB, 112);
    assert.deepEqual(r.settings.explicit, ['lightProfile']);
    assert.equal('microvmMemMB' in JSON.parse(fs.readFileSync(CFG.configFile, 'utf8')), false);
    // a bad value writes nothing at all
    const text = fs.readFileSync(CFG.configFile, 'utf8');
    assert.throws(() => config.updateEngineSettings({ lightProfile: false, tcgTbSizeMB: 3 }), /tcgTbSizeMB/);
    assert.equal(fs.readFileSync(CFG.configFile, 'utf8'), text);
    assert.equal(CFG.lightProfile, true);
    // the manager starting again reads the same
    configure({ data: root, env: {} });
    assert.deepEqual(engineCfg(), Object.assign({}, LIGHT, { microvmImageDiskGB: 12 }));
    // a config.json the manager cannot parse is never overwritten (409)
    fs.writeFileSync(CFG.configFile, '{ broken');
    assert.throws(() => config.updateEngineSettings({ lightProfile: false }), (e) => e.status === 409 && e.code === 'CONFIG_UNREADABLE');
    assert.equal(fs.readFileSync(CFG.configFile, 'utf8'), '{ broken');
    // an empty change does not touch the file
    assert.equal(config.updateEngineSettings({}).settings.lightProfile, true);
  } finally { resetConfig(); rm(root); }
});

test('setConfigValues: several keys in one write; undefined removes; never over a broken file', () => {
  const root = useTempRoot('setvals');
  try {
    assert.equal(config.setConfigValues({ a: 1, b: 'x' }), true);
    assert.equal(config.setConfigValue('a', undefined), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(CFG.configFile, 'utf8')), { b: 'x' });
    fs.writeFileSync(CFG.configFile, '[1]');
    assert.equal(config.setConfigValues({ c: 1 }), false);
    assert.equal(fs.readFileSync(CFG.configFile, 'utf8'), '[1]');
  } finally { resetConfig(); rm(root); }
});
