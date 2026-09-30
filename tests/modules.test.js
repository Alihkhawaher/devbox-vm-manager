'use strict';
/*
 * Layout tests: requiring any module has no side effects (MNT-10), shared
 * state lives in one place, the task model replaced the v1 globals, and the
 * lib/ modules export the contract other parts of the app rely on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB = ['config', 'util', 'platform', 'state', 'tasks', 'ports', 'ssh', 'monitor', 'download',
  'install', 'vm', 'sessions', 'docker', 'deploy', 'http', 'client', 'route', 'shares', 'shares-routes',
  'oci/registry', 'oci/layers', 'oci/cpio', 'oci/images',
  'microvm/apk', 'microvm/tar', 'microvm/kmod', 'microvm/kernel', 'microvm/initramfs', 'microvm/qemu-args',
  'microvm/hostcpu', 'microvm/plan', 'microvm/vmrun', 'microvm/qcow2', 'microvm/mkext4', 'microvm/volumes',
  'microvm/copyin', 'microvm/tail', 'microvm/args', 'microvm/run', 'microvm/store', 'microvm/containers', 'microvm/routes',
  'microvm/compat', 'microvm/facts', 'microvm/validate', 'microvm/logs',
  'mcp/protocol', 'mcp/tools', 'mcp/containers', 'mcp/shares',
  'ninep/proto', 'ninep/server', 'ninep/guest'];

test('requiring server.js and every lib module does nothing (no listen, spawn, write or output)', () => {
  const code = ['server.js'].concat(LIB.map((m) => 'lib/' + m + '.js'))
    .map((f) => 'require(' + JSON.stringify(path.join(ROOT, f)) + ');').join('');
  // an empty scratch data root: any file written there would be a side effect
  const scratch = require('fs').mkdtempSync(path.join(os.tmpdir(), 'devbox-noside-'));
  try {
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: os.tmpdir(), timeout: 15000, encoding: 'utf8', windowsHide: true,
      env: Object.assign({}, process.env, { VM_MANAGER_ROOT: scratch }),
    });
    assert.equal(r.error, undefined, 'child did not exit by itself - something is listening or waiting');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.deepEqual(require('fs').readdirSync(scratch), [], 'nothing was written to the data root');
  } finally { require('fs').rmSync(scratch, { recursive: true, force: true }); }
});

// microVM bug F: the prototypes brought second copies of things the app has
// (a buffer cpio writer, an HTTPS getter, pid/process checks, a tasklist per
// call, a fixed control-port range): one implementation each
test('one implementation each: cpio writer, HTTP downloads, process checks, control endpoints (microVM bug F)', () => {
  const fs = require('fs');
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.js$/.test(f)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  const having = (re) => files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(having(/class CpioWriter\b/), ['lib/oci/cpio.js']);
  // HTTPS clients: downloads (apk packages go through it too) and the registry protocol
  assert.deepEqual(having(/require\('https'\)/), ['lib/download.js', 'lib/oci/registry.js']);
  assert.deepEqual(having(/execFileSync\(\s*'tasklist'|execFile\(\s*'tasklist'|'tasklist', \[/), ['lib/platform.js']);
  assert.deepEqual(having(/function processImage|isOurQemu/), []);
  assert.deepEqual(having(/controlHost\(|127\.0\.0\.2['"]/).filter((f) => f !== 'lib/platform.js'), []);
});

test('server.js exports main and only runs it when started directly', () => {
  const entry = require('../server.js');
  assert.equal(typeof entry.main, 'function');
});

test('shared state lives in exactly one module; the v1 single-task globals are gone', () => {
  assert.equal(require('../lib/state').state, require('../lib/state').state);
  const tasks = require('../lib/tasks');
  for (const gone of ['current', 'setKeep', 'beginTask', 'tlog', 'endTask']) assert.equal(tasks[gone], undefined, gone);
  for (const fn of ['start', 'runAndWait', 'get', 'list', 'overview', 'wait', 'holder', 'assertFree', 'vmBusy']) assert.equal(typeof tasks[fn], 'function', fn);
});

test('no module still uses the v1 task helpers or the process-by-port identity', () => {
  const fs = require('fs');
  for (const m of LIB) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', m + '.js'), 'utf8');
    for (const bad of ['beginTask(', 'endTask(', 'tlog(', 'KEEP_TASK', 'setKeep(', 'pidForPort(', 'portPidMap(']) {
      assert.equal(src.indexOf(bad), -1, 'lib/' + m + '.js still contains ' + bad);
    }
  }
});

test('every task operation takes the task context first; validators exist for each', () => {
  const vm = require('../lib/vm');
  const docker = require('../lib/docker');
  const deploy = require('../lib/deploy');
  const install = require('../lib/install');
  const pairs = [
    [vm, ['Create', 'Start', 'Stop', 'Restart', 'Delete', 'Resize', 'GrowFs', 'Freeze', 'Reset', 'Compact', 'Snapshot']],
    [install, ['InstallQemu', 'BuildBase', 'Setup']],
    [deploy, ['Deploy', 'QuickDeploy']],
  ];
  for (const [mod, names] of pairs) {
    for (const n of names) {
      assert.equal(typeof mod['validate' + n], 'function', 'validate' + n);
      assert.equal(typeof mod['op' + n], 'function', 'op' + n);
      assert.equal(mod['op' + n].length, 2, 'op' + n + '(t, args)');
    }
  }
  for (const n of ['DockerInstall', 'DockerPull', 'DockerRun', 'DockerAction', 'DockerRmi', 'Compose', 'ImageInspect']) {
    assert.equal(typeof docker['op' + n], 'function', 'op' + n);
    assert.equal(docker['op' + n].length, 2, 'op' + n + '(t, args)');
  }
});

test('the API client finds nothing for a data root without a running manager', async () => {
  const client = require('../lib/client');
  const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'devbox-client-'));
  try {
    assert.equal(client.readManagerInfo(dir), null);
    assert.equal(client.readToken(dir), null);
    assert.equal(await client.findManager(dir), null);
    await assert.rejects(client.connect({ root: dir, start: false }), /not running/);
  } finally { require('fs').rmSync(dir, { recursive: true, force: true }); }
});
