'use strict';
/*
 * Regression tests for the security and correctness review of the microVM
 * and shared-folder integration (ids sec-N / correct-N): the pure and
 * file-level parts. The container lifecycle parts are in
 * microvm-supervisor.test.js (they need its fake QEMU), the MCP ones in
 * mcp-containers.test.js, the tar ones in oci-layers.test.js.
 *
 * All test files may run in ONE process: every global a test changes
 * (CFG, platform stubs, the privacy flag, the adoption gate) is put back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { CFG } = require('../lib/config');
const util = require('../lib/util');
const platform = require('../lib/platform');
const shares = require('../lib/shares');
const tools = require('../lib/mcp/tools');
const ports = require('../lib/ports');
const V = require('../lib/microvm/validate');
const run = require('../lib/microvm/run');
const images = require('../lib/oci/images');
const registry = require('../lib/oci/registry');
const containers = require('../lib/microvm/containers');
const store = require('../lib/microvm/store');
const { putLocalImage, tarBuffer } = require('./oci-mkimage');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const WIN = process.platform === 'win32';
const UNC = ['\\\\localhost\\C$\\Developments\\data', '\\\\127.0.0.1\\C\\x', '//attacker/share', '\\\\?\\UNC\\localhost\\C\\x', '\\\\host@SSL\\x', '\\\\.\\pipe\\x'];

// ---------------------------------------------------------------- sec-1
test('networkPathError: UNC and device paths on Windows (not a local drive in its long form); nothing elsewhere (sec-1)', () => {
  for (const p of UNC) assert.match(util.networkPathError(p, 'win32'), /network and UNC paths/, p);
  for (const p of ['C:\\Users\\me', 'd:/x', '\\\\?\\C:\\Users\\me', '\\\\.\\D:\\x', 'relative', '/x']) assert.equal(util.networkPathError(p, 'win32'), null, p);
  assert.equal(util.networkPathError('//server/share', 'linux'), null, 'a POSIX "//x" is "/x"');
});

test('shared folders: a UNC path is refused BEFORE any file call; the data folder is also found by file identity (sec-1)', () => {
  const root = useTempRoot('sec1');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-sec1-'));
  const origReal = fs.realpathSync.native;
  let touched = 0;
  fs.realpathSync.native = function (p) { touched++; return origReal.apply(this, arguments); };
  try {
    if (WIN) {
      for (const p of UNC) {
        assert.throws(() => shares.validateShare({ hostPath: p, guestPath: '/app' }, { existing: [], dataRoot: root }), (e) => e.status === 400 && /network and UNC paths/.test(e.message), p);
      }
      assert.equal(touched, 0, 'no realpath (no SMB connection) for any of them');
    }
    fs.realpathSync.native = origReal;
    // identity: inside the data folder, containing it, or unrelated
    const sub = path.join(root, 'sandboxes');
    fs.mkdirSync(sub, { recursive: true });
    const idr = shares._internal.identityRefusal;
    assert.match(idr(fs.realpathSync.native(sub), root), /inside the manager's data folder/);
    assert.match(idr(fs.realpathSync.native(path.dirname(root)), root), /contains the manager's data folder/);
    assert.equal(idr(fs.realpathSync.native(other), root), null);
    // and validateShare still takes an ordinary folder
    assert.equal(shares.validateShare({ hostPath: other, guestPath: '/app' }, { existing: [], dataRoot: root }).share.guestPath, '/app');
  } finally {
    fs.realpathSync.native = origReal;
    resetConfig(); rm(root); rm(other);
  }
});

test('folder picker and MCP guards: UNC paths refused before anything opens them (sec-1)', { skip: !WIN && 'Windows paths' }, async () => {
  for (const p of UNC) {
    await assert.rejects(shares.listDirs({ path: p }), (e) => e.status === 400 && /network and UNC paths/.test(e.message), p);
    assert.throws(() => tools.checkLocalPath(p, 'local_path'), /network and UNC paths/, p);
    assert.throws(() => tools.guardLocalPath(p, 'host_path', 'write', true, { dataRoot: 'C:\\nowhere\\data' }), /network and UNC paths/, p);
  }
});

// ---------------------------------------------------------------- sec-5
test('private folders and files: a locked folder is this user\'s only; a file renamed from it keeps that; fw_cfg fails closed (sec-5)', () => {
  const root = useTempRoot('sec5');
  const origProtect = platform.protectPrivateFile, origWin = platform.IS_WIN;
  try {
    const locked = path.join(root, 'run');
    const r = platform.protectPrivateDir(locked);
    assert.equal(r.ok, true, r.error);
    const reg = path.join(root, 'vms.json');
    platform.writePrivateFileSync(reg, '{"secret":"s"}\n', { atomic: true, tmpDir: locked });
    platform.writePrivateFileSync(reg + '.bak', '{"old":1}\n', { atomic: true, tmpDir: locked });
    platform.writePrivateFileSync(path.join(locked, 'x.shares'), 'secrets\n', { required: true });
    assert.equal(fs.readFileSync(reg, 'utf8'), '{"secret":"s"}\n');
    assert.deepEqual(fs.readdirSync(locked).filter((f) => /\.tmp$/.test(f)), [], 'no temp file left');
    for (const f of [reg, reg + '.bak', path.join(locked, 'x.shares')]) {
      if (WIN) {
        const acl = execFileSync('icacls', [f], { encoding: 'utf8', windowsHide: true });
        const entries = acl.split(/\r?\n/).map((l) => l.replace(f, '').trim()).filter((l) => /:\(/.test(l));
        assert.equal(entries.length, 1, 'one entry, the user: ' + entries.join(' | '));
        assert.ok(!/Users|Authenticated|Everyone/i.test(entries[0]), entries[0]);
      } else {
        assert.equal(fs.statSync(f).mode & 0o077, 0, f + ' is 0600');
      }
    }
    // the share list: when it cannot be made private, it is not written at all
    platform.protectPrivateFile = () => ({ ok: false, error: 'icacls failed (test)' });
    platform.IS_WIN = true;
    const out = path.join(root, 'elsewhere', 'vm1.shares');
    assert.throws(() => shares.writeFwcfg(out, 5640, [{ id: 'vm1-1', secret: 'a'.repeat(32), guestPath: '/work', readOnly: false }]), /readable by this user only/);
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(fs.readdirSync(path.dirname(out)), [], 'nor a temp file with the secrets');
  } finally {
    platform.protectPrivateFile = origProtect;
    platform.IS_WIN = origWin;
    platform._lockedDirs.clear();
    platform._setPrivacyAttempted(false);
    resetConfig(); rm(root);
  }
});

// ---------------------------------------------------------------- sec-4
test('readHeadTail: a guest-written log is read at its ends only, never whole (sec-4)', () => {
  const root = useTempRoot('sec4');
  try {
    const f = path.join(root, 'console.log');
    const fd = fs.openSync(f, 'w');
    fs.writeSync(fd, '__DEVBOX_INIT uptime=0.1\n__DEVBOX_READY\n');
    fs.writeSync(fd, Buffer.alloc(3 * 1048576, 0x61));
    fs.writeSync(fd, '\n__DEVBOX_EXIT=7\n');
    fs.closeSync(fd);
    const t = run.readHeadTail(f, 65536);
    assert.ok(t.length <= 2 * 65536 + 1, 'at most 128 KB read');
    const r = run.readExit(root);
    assert.equal(r.exitCode, 7);
    assert.ok(r.markers.READY !== undefined, 'READY from the head');
  } finally { resetConfig(); rm(root); }
});

// ---------------------------------------------------------------- correct-7
test('forceStop: a QEMU spawned here is ended through its child handle, no process listing needed (correct-7)', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  const origList = platform.listQemuPids;
  platform.listQemuPids = async () => null; // tasklist failing on a busy PC
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await run.forceStop({ pid: child.pid, monitor: null }, { child: child, quitWaitMs: 200 });
    assert.equal(r, 'killed');
    assert.equal(platform.pidAlive(child.pid), false);
  } finally { platform.listQemuPids = origList; try { child.kill(); } catch (e) { /* gone */ } }
});

// ---------------------------------------------------------------- correct-14
test('the shared-folder server\'s port is reserved as the manager\'s own (correct-14)', () => {
  const root = useTempRoot('c14');
  try {
    assert.equal(ports.reservedPorts().get(5640), 'the shared-folder server of the VM manager');
    CFG.ninepPort = 5712;
    assert.equal(ports.reservedPorts().get(5712), 'the shared-folder server of the VM manager');
  } finally { resetConfig(); rm(root); }
});

// ---------------------------------------------------------------- correct-1/2
test('mounts: a volume listed twice is refused; a volume under a shared folder is allowed (init mounts parents first) (correct-1, correct-2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-c2-'));
  try {
    assert.throws(() => V.mountsField({ volumes: ['data:/a', 'DATA:/b'] }, {}), (e) => e.status === 400 && /listed twice/.test(e.message) && /\/a/.test(e.message) && /\/b/.test(e.message));
    const m = V.mountsField({ volumes: [dir + ':/app', 'nm:/app/node_modules', 'x:/a/b', 'y:/a'] }, {});
    assert.deepEqual(m.volumes.map((v) => v.target), ['/app/node_modules', '/a/b', '/a']);
    assert.deepEqual(m.shares.map((s) => s.guestPath), ['/app']);
  } finally { rm(dir); }
});

// ---------------------------------------------------------------- correct-6
test('image removal and prune never delete what a starting container uses: held blobs, its reference, young files (correct-6)', async () => {
  const root = useTempRoot('c6');
  try {
    fs.mkdirSync(CFG.imagesDir, { recursive: true });
    fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), '{}');
    const a = putLocalImage(CFG.imagesDir, 'alpha', { layers: [{ tar: tarBuffer([{ path: 'a', type: 'file', data: 'A' }]) }], config: { Cmd: ['/a'] } });
    const d = putLocalImage(CFG.imagesDir, 'delta', { layers: [{ tar: tarBuffer([{ path: 'd', type: 'file', data: 'D' }]) }], config: { Cmd: ['/d'] } });
    // A: a container starting from "alpha" has no config digest yet - its
    // reference counts for removal and prune
    const starting = [{ id: 'aaaaaaaaaaaa', name: 'web', reference: 'docker.io/library/alpha:latest', configDigest: null }];
    const live = ['docker.io/library/alpha:latest'];
    await assert.rejects(images.removeImage({ image: 'alpha' }, { records: starting, liveRefs: live }), (e) => e.code === 'IMAGE_IN_USE' && /"web"/.test(e.message));
    const release = images.holdBlobs([JSON.parse(fs.readFileSync(registry.blobPath(CFG.imagesDir, d.manifest), 'utf8')).layers[0].digest]);
    const layerOfD = JSON.parse(fs.readFileSync(registry.blobPath(CFG.imagesDir, d.manifest), 'utf8')).layers[0].digest;
    let pr;
    try {
      pr = await images.pruneImages({ records: starting, liveRefs: live, minAgeMs: 0 });
      assert.ok(!pr.images.includes('docker.io/library/alpha:latest'), 'prune skips the starting container\'s image');
      assert.ok(registry.readRefs(CFG.imagesDir)['docker.io/library/alpha:latest']);
      // B: delta was dropped (nobody uses it), but a preparation holds its
      // layer (it pulled it a moment ago and flattens it next)
      assert.ok(pr.images.includes('docker.io/library/delta:latest'));
      assert.ok(fs.existsSync(registry.blobPath(CFG.imagesDir, layerOfD)), 'held: kept while the preparation runs');
    } finally { release(); }
    await images.pruneImages({ records: starting, liveRefs: live, minAgeMs: 0 });
    assert.ok(!fs.existsSync(registry.blobPath(CFG.imagesDir, layerOfD)), 'released: an orphan now, and gone');
    assert.ok(a.config);
  } finally { resetConfig(); rm(root); }
});

// ---------------------------------------------------------------- correct-4
test('operations on existing containers wait until adoption has run - or say the manager is starting (correct-4)', async () => {
  const root = useTempRoot('c4');
  const g = containers._internal;
  try {
    store.load();
    g.armAdoptGate();
    await assert.rejects(g.whenAdopted(50), (e) => e.code === 'STARTING_UP' && e.status === 409);
    let passed = false;
    const waiting = g.whenAdopted(5000).then(() => { passed = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(passed, false, 'still waiting');
    const origList = platform.listQemuPids;
    platform.listQemuPids = async () => new Set();
    try { await containers.adoptAll(); } finally { platform.listQemuPids = origList; }
    await waiting;
    assert.equal(passed, true, 'adoptAll opened the gate');
    await g.whenAdopted(1); // open from now on
  } finally { containers.shutdown(); resetConfig(); rm(root); store.load(); }
});

// ---------------------------------------------------------------- correct-3
test('adoption serves shared folders with the owner the start used, not root (correct-3)', () => {
  const root = useTempRoot('c3');
  try {
    const cpio = require('../lib/oci/cpio');
    const cd = 'sha256:' + 'c'.repeat(64);
    const rec = { id: 'abcabcabcabc', user: null, configDigest: cd, runtime: { initrd: null, shareIds: { uid: 101, gid: 101 } } };
    assert.deepEqual(containers._internal.adoptShareIds(rec), { uid: 101, gid: 101 });
    // a record from before shareIds: the image's USER from the rootfs sidecar
    const p = cpio.rootfsPaths(CFG.imagesDir, cd);
    fs.mkdirSync(path.dirname(p.meta || p.archive), { recursive: true });
    fs.writeFileSync((p.meta || p.archive + '.json'), JSON.stringify({ configDigest: cd, runtime: { user: '101' }, formatVersion: 1 }));
    delete rec.runtime.shareIds;
    const ids = containers._internal.adoptShareIds(rec);
    assert.equal(ids.uid, 101);
  } finally { resetConfig(); rm(root); }
});
