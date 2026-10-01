'use strict';
/*
 * The pure decision makers of the microVM engine: compatibility rules and
 * the runtime failure classifier (compat.js, microVM spec section 14), the
 * request validators (validate.js), image facts read from an initrd
 * (facts.js), the volume attach lock (volumes.js, bug V1) and the init.sh /
 * spec pieces of the stop protocol and live shares. The real configs of the
 * cached approved images are used when data/images has them (read only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const compat = require('../lib/microvm/compat');
const V = require('../lib/microvm/validate');
const facts = require('../lib/microvm/facts');
const volumes = require('../lib/microvm/volumes');
const initramfs = require('../lib/microvm/initramfs');
const plan = require('../lib/microvm/plan');
const { CpioWriter } = require('../lib/oci/cpio');

const rmm = plan.recommendedMemMB;

test('requestRules: privileged/host network/restart policy/docker.sock pick Docker-in-VM; -it is refused', () => {
  assert.equal(compat.requestRules({ image: 'nginx' }), null);
  assert.equal(compat.requestRules({ restartPolicy: 'no' }), null);
  assert.equal(compat.requestRules({ privileged: true }).code, 'PRIVILEGED');
  assert.equal(compat.requestRules({ hostNetwork: 'true' }).engine, 'docker-vm');
  assert.equal(compat.requestRules({ restartPolicy: 'unless-stopped' }).code, 'RESTART_POLICY');
  assert.equal(compat.requestRules({ volumes: ['/var/run/docker.sock:/var/run/docker.sock'] }).code, 'DOCKER_SOCKET');
  assert.equal(compat.requestRules({ volumes: [{ hostPath: 'C:\\x', target: '/run/docker.sock/' }] }).code, 'DOCKER_SOCKET');
  assert.equal(compat.requestRules({ compose: 'services: {}' }).code, 'COMPOSE');
  const it = compat.requestRules({ tty: true });
  assert.deepEqual([it.error.status, it.error.code], [400, 'NOT_SUPPORTED']);
  assert.match(compat.requestRules({ privileged: true, hostNetwork: true }).reason, /privileged.*host networking/);
});

test('imageRules / rootfsRules / decide: systemd and s6 need PID 1, large images differ by engine', () => {
  const small = { cmd: ['nginx'], env: [] };
  assert.deepEqual(compat.imageRules({ runtime: small, compressedBytes: 10e6, capMB: 2048, recommendedMemMB: rmm }), []);
  const sd = compat.imageRules({ runtime: { cmd: ['/lib/systemd/systemd'] }, capMB: 2048, recommendedMemMB: rmm });
  assert.deepEqual(sd.map((f) => [f.level, f.code]), [['fallback', 'NEEDS_PID1']]);
  // --entrypoint overrides the image's
  assert.deepEqual(compat.imageRules({ runtime: { cmd: ['/sbin/init'] }, over: { entrypoint: ['sh'] }, capMB: 2048 }), []);
  const s6env = compat.imageRules({ runtime: { entrypoint: ['/init'], env: ['S6_VERBOSITY=1'] }, capMB: 2048 });
  assert.equal(s6env[0].code, 'NEEDS_PID1');
  const sock = compat.imageRules({ runtime: { cmd: ['x'], volumes: ['/var/run/docker.sock'] }, capMB: 2048 });
  assert.equal(sock[0].code, 'DOCKER_SOCKET');
  const big = compat.imageRules({ runtime: small, compressedBytes: 900e6, capMB: 2048, recommendedMemMB: rmm });
  assert.deepEqual(big.map((f) => f.level), ['large']);
  assert.equal(compat.decide(big, 'auto').fallback.code, 'LARGE_IMAGE');
  assert.equal(compat.decide(big, 'microvm').fallback, null);
  assert.match(compat.decide(big, 'microvm').warnings[0], /large image/);
  assert.equal(compat.decide(sd, 'microvm').fallback.code, 'NEEDS_PID1', 'PID 1 needs are not a matter of choice');
  const s6 = compat.rootfsRules({ runtime: { entrypoint: ['/init'] }, facts: { s6: true }, capMB: 2048 });
  assert.equal(s6[0].code, 'NEEDS_PID1');
  assert.deepEqual(compat.rootfsRules({ runtime: { entrypoint: ['/init'] }, facts: { s6: false }, capMB: 2048 }), []);
  const exact = compat.rootfsRules({ runtime: small, initrdBytes: 1500 * 1048576, capMB: 2048, recommendedMemMB: rmm });
  assert.equal(exact[0].code, 'LARGE_IMAGE');
  // a disk root keeps the image on disk: its size says nothing about RAM
  assert.deepEqual(compat.imageRules({ runtime: small, compressedBytes: 900e6, capMB: 2048, recommendedMemMB: rmm, rootfs: 'disk' }), []);
  assert.deepEqual(compat.rootfsRules({ runtime: small, initrdBytes: 1500 * 1048576, capMB: 2048, recommendedMemMB: rmm, rootfs: 'disk' }), []);
  assert.equal(compat.rootfsRules({ runtime: { entrypoint: ['/init'] }, facts: { s6: true }, rootfs: 'disk' })[0].code, 'NEEDS_PID1', 'the other rules stay');
  assert.equal(compat.rootfsRules({ runtime: small, rootfs: 'disk', warnings: ['x: security.capability dropped'] })[0].code, 'FILE_CAPS');
  assert.equal(compat.memCapMB({ maxMem: 3072 }), 1536);
  assert.equal(compat.memCapMB({ maxMem: 65536 }), 2048);
  assert.equal(compat.memCapMB({ maxMem: 65536, microvmMemCapMB: 999 }), 999);
});

test('the cached approved images all run as microVMs (real configs, when present)', () => {
  const dir = path.join(__dirname, '..', 'data', 'images', 'rootfs');
  let metas = [];
  try { metas = fs.readdirSync(dir).filter((f) => f.endsWith('.cpio.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { metas = []; }
  if (!metas.length) return;
  for (const m of metas) {
    const f = compat.imageRules({ runtime: m.runtime, compressedBytes: m.compressedBytes, capMB: 2048, recommendedMemMB: rmm });
    assert.equal(compat.decide(f, 'auto').fallback, null, m.reference);
  }
});

test('classify: memory, PID 1, nested runtimes, CPU features, user errors, setup errors, kernel panics', () => {
  const c = (o) => compat.classify(Object.assign({ beforeReady: true }, o));
  assert.equal(c({ exitCode: 0 }), null);
  assert.equal(c({ exitCode: null }), null);
  assert.equal(compat.classify({ exitCode: 1, beforeReady: false, sinceReadyMs: 60000 }), null, 'only early failures');
  const mem = c({ exitCode: 125, console: 'Initramfs unpacking failed: write error', recommendedMemMB: 256 });
  assert.deepEqual([mem.class, mem.offer, mem.memMB], ['NEEDS_MEMORY', 'memory', 384]);
  assert.equal(c({ exitCode: 1, stderrTail: 's6-overlay-suexec: fatal: can only run as pid 1' }).class, 'NEEDS_PID1');
  assert.equal(c({ exitCode: 1, stderrTail: 'failed to create shim task' }).offer, 'docker-vm');
  assert.equal(c({ exitCode: 132 }).class, 'CPU_FEATURES');
  assert.equal(c({ exitCode: 127, exitReason: 'command not found: sh: /x: not found' }).class, 'USER_ERROR');
  assert.equal(c({ exitCode: 126, stderrTail: 'Exec format error' }).class, 'WRONG_ARCH');
  assert.equal(c({ exitCode: 125, initMessages: ['cannot mount the shared folder at /app: refused'] }).class, 'SETUP_ERROR');
  assert.deepEqual([c({ exitCode: 125, console: 'Kernel panic - not syncing: VFS' }).class, c({ exitCode: 125, console: 'Kernel panic - not syncing: VFS' }).offer], ['ENGINE_ERROR', 'docker-vm']);
  assert.equal(compat.classify({ exitCode: 1, beforeReady: false, sinceReadyMs: 2000, stderrTail: 'can only run as pid 1' }).class, 'NEEDS_PID1');
});

test('classify: running out of memory earns the offer at ANY time - init\'s OOM count, a JVM, Node, Go, InnoDB (cr-3)', () => {
  const late = (o) => compat.classify(Object.assign({ beforeReady: false, sinceReadyMs: 3600000, memMB: 128, recommendedMemMB: 128 }, o));
  const k = late({ exitCode: 137, oomKills: 1 });
  assert.deepEqual([k.class, k.offer, k.memMB], ['NEEDS_MEMORY', 'memory', 192]);
  assert.equal(k.reason, 'the VM ran out of memory at 128 MB (the kernel killed 1 process)');
  assert.match(late({ exitCode: 1, oomKills: 3 }).reason, /killed 3 processes/);
  for (const line of ['Exception in thread "main" java.lang.OutOfMemoryError: Java heap space', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'fatal error: runtime: out of memory', '[ERROR] InnoDB: Cannot allocate memory for the buffer pool', 'MemoryError', "terminate called after throwing an instance of 'std::bad_alloc'"]) {
    assert.equal((late({ exitCode: 1, stderrTail: line }) || {}).class, 'NEEDS_MEMORY', line);
  }
  // an exit 0 says nothing; other late failures stay unclassified
  assert.equal(late({ exitCode: 0, oomKills: 2 }), null);
  assert.equal(late({ exitCode: 1, stderrTail: 'can only run as pid 1' }), null);
  assert.equal(late({ exitCode: 1, oomKills: 0 }), null);
});

test('validate: commands, env, ports (lan/udp/prefix/suffix), names, users, limits', () => {
  assert.deepEqual(V.splitCommand(`sh -c 'echo "hi"; exit 3' "a b" c\\ d`), ['sh', '-c', 'echo "hi"; exit 3', 'a b', 'c d']);
  assert.throws(() => V.splitCommand('echo "x'), /unbalanced/);
  assert.equal(V.argvField(undefined, 'cmd'), null);
  assert.deepEqual(V.argvField([], 'cmd'), []);
  assert.deepEqual(V.argvField(['a', 1], 'cmd'), ['a', '1']);
  assert.throws(() => V.argvField([{}], 'cmd'), /strings/);
  assert.deepEqual(V.envField({ A: '1', B: 'x=y' }), ['A=1', 'B=x=y']);
  assert.deepEqual(V.envField(['A=1', 'A=2']), ['A=2'], 'a later value wins');
  assert.throws(() => V.envField(['NOVALUE']), /K=V/, 'never the manager\'s own environment');
  assert.throws(() => V.envField(['BIG=' + 'x'.repeat(40000)]), (e) => e.code === 'SPEC_TOO_LARGE' && /copy-in/.test(e.message));
  const p = V.portsField(['8080:80', '8081:81,lan', 'lan:9000', 'local:9001:91', '0.0.0.0:9002:92', '53:53/udp', { host: 7000, guest: 70, lan: true }], { defaultLan: false });
  assert.deepEqual(p.map((x) => [x.host, x.guest, x.proto, x.lan]), [
    [8080, 80, 'tcp', false], [8081, 81, 'tcp', true], [9000, 9000, 'tcp', true], [9001, 91, 'tcp', false], [9002, 92, 'tcp', true], [53, 53, 'udp', false], [7000, 70, 'tcp', true]]);
  assert.equal(V.portsField(['8080:80'], { defaultLan: true })[0].lan, true, 'the global default applies without a prefix');
  assert.equal(V.portsField(undefined), null, 'omitted: the image EXPOSE ports');
  assert.deepEqual(V.portsField([]), []);
  assert.deepEqual(V.portsField('8080:80,lan\n5353:53/udp').map((x) => [x.host, x.lan, x.proto]), [[8080, true, 'tcp'], [5353, false, 'udp']]);
  assert.throws(() => V.portsField(['8080:80', '8080:81']), /twice/);
  assert.throws(() => V.portsField(['10.0.0.5:80:80']), /127\.0\.0\.1|0\.0\.0\.0/);
  assert.throws(() => V.portsField(['lan:127.0.0.1:80:80']), /conflicting/);
  const f = V.runFields({ name: 'web-1', user: 'nginx:nginx', hostname: 'h1', stopSignal: 'SIGQUIT', rm: true, network: 'none', cmd: 'nginx -g "daemon off;"' }, {});
  assert.deepEqual([f.name, f.user, f.hostname, f.stopSignal, f.autoRemove, f.network], ['web-1', 'nginx:nginx', 'h1', 'QUIT', true, 'none']);
  assert.deepEqual(f.cmd, ['nginx', '-g', 'daemon off;']);
  assert.throws(() => V.runFields({ name: '-bad' }), /container name/);
  assert.throws(() => V.runFields({ user: 'a b' }), /user/);
  assert.throws(() => V.runFields({ mem: 64 }), /Memory/);
  assert.throws(() => V.runFields({ autostart: true, autoRemove: true }), /cannot both/);
  assert.throws(() => V.imageRef('Bad Ref!'), (e) => e.code === 'BAD_REFERENCE' && e.status === 400);
});

test('validate: mounts - named volumes, LIVE host folders, explicit copy-in, target conflicts', () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mnt-'));
  try {
    const ok = (p) => ({ hostPath: path.resolve(p), warnings: [] });
    const m = V.mountsField({
      volumes: ['pgdata:/var/lib/postgresql/data:ro,nocopy', host + ':/app', { hostPath: host, target: '/cache', copyIn: true }],
      copyIn: [host + ':/seed'],
    }, { validateHostDir: ok });
    assert.deepEqual(m.volumes, [{ name: 'pgdata', target: '/var/lib/postgresql/data', readonly: true, nocopy: true }]);
    assert.deepEqual(m.shares, [{ hostPath: path.resolve(host), guestPath: '/app', readOnly: false }], 'a host folder is a live share by default');
    assert.deepEqual(m.copyIn.map((c) => c.target), ['/cache', '/seed']);
    assert.throws(() => V.mountsField({ volumes: ['a:/d', 'b:/d'] }, { validateHostDir: ok }), /two mounts use the target \/d/);
    assert.throws(() => V.mountsField({ volumes: [host + ':/app'], copyIn: [host + ':/app/sub'] }, { validateHostDir: ok }), /inside the shared folder/);
    assert.throws(() => V.mountsField({ volumes: ['v:/proc/x'] }, { validateHostDir: ok }), /system directory/);
    assert.throws(() => V.mountsField({ volumes: ['v:/.devbox/x'] }, { validateHostDir: ok }), /reserved/);
    assert.throws(() => V.mountsField({ volumes: [host + ':/a b'] }, { validateHostDir: ok }), /spaces/);
    assert.throws(() => V.mountsField({ volumes: ['con:/x'] }, { validateHostDir: ok }), /reserved on Windows/);
    const many = Array.from({ length: 9 }, (_, i) => host + ':/s' + i);
    assert.throws(() => V.mountsField({ volumes: many }, { validateHostDir: ok, maxShares: 8 }), /at most 8/);
  } finally { fs.rmSync(host, { recursive: true, force: true }); }
});

test('facts: passwd, group and s6-overlay read from the rootfs part of an initrd; USER resolved like init.sh', async () => {
  const w = new CpioWriter(null, { autoParents: true, mtime: 0 });
  await w.file('bin/sh', 'x', 0o755);
  await w.file('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nnginx:x:101:101:nginx:/var/cache/nginx:/sbin/nologin\nnode:x:1000:1000::/home/node:/bin/sh\n', 0o644);
  await w.file('etc/group', 'root:x:0:\nnginx:x:101:\nstaff:x:50:\n', 0o644);
  await w.dir('package/admin/s6-overlay', 0o755);
  await w.finish({ padTo: 512 });
  // the base init archive follows the rootfs; its files must not count
  const w2 = new CpioWriter(null, { autoParents: true, mtime: 0 });
  await w2.file('etc/passwd', 'evil:x:0:0::/:/bin/sh\n', 0o644);
  await w2.finish();
  const file = path.join(os.tmpdir(), 'devbox-facts-' + process.pid + '.initrd');
  fs.writeFileSync(file, Buffer.concat([w.toBuffer(), w2.toBuffer()]));
  try {
    const f = facts.imageFacts(file);
    assert.match(f.passwd, /nginx:x:101/);
    assert.ok(!/evil/.test(f.passwd));
    assert.match(f.group, /staff/);
    assert.equal(f.s6, true);
    assert.deepEqual(facts.resolveUser('', f), { uid: 0, gid: 0, found: true });
    assert.deepEqual(facts.resolveUser('nginx', f), { uid: 101, gid: 101, found: true });
    assert.deepEqual(facts.resolveUser('1000', f), { uid: 1000, gid: 1000, found: true }, 'a uid in passwd takes its gid');
    assert.deepEqual(facts.resolveUser('4242', f), { uid: 4242, gid: 0, found: true }, 'an unknown uid gets gid 0 (as init.sh)');
    assert.deepEqual(facts.resolveUser('node:staff', f), { uid: 1000, gid: 50, found: true });
    assert.equal(facts.resolveUser('ghost', f).found, false);
    assert.equal(facts.imageFacts(path.join(os.tmpdir(), 'no-such.initrd')).passwd, null);
  } finally { fs.rmSync(file, { force: true }); }
});

test('volume lock (V1): wx-exclusive, taken over when stale, never over a live holder or another live manager', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-vlock-'));
  const live = new Set();
  const o = (id) => ({ containerId: id, isLive: (x) => live.has(x), nameOf: (x) => 'ctr-' + x });
  try {
    assert.equal(volumes.acquireLock(dir, 'Data', o('aaaaaaaaaaaa')), true);
    live.add('aaaaaaaaaaaa');
    assert.throws(() => volumes.acquireLock(dir, 'data', o('bbbbbbbbbbbb')), (e) => e.code === 'VOLUME_IN_USE' && e.status === 409 && /ctr-aaaaaaaaaaaa/.test(e.message));
    assert.equal(volumes.acquireLock(dir, 'data', o('aaaaaaaaaaaa')), true, 'its own lock again (restart)');
    assert.equal(volumes.releaseLock(dir, 'data', 'bbbbbbbbbbbb'), false, 'only the holder releases');
    // the holder ended without releasing (crash): stale for the next one
    live.delete('aaaaaaaaaaaa');
    assert.equal(volumes.acquireLock(dir, 'data', o('bbbbbbbbbbbb')), true);
    assert.equal(volumes.readLock(dir, 'data').containerId, 'bbbbbbbbbbbb');
    assert.equal(volumes.releaseLock(dir, 'data', 'bbbbbbbbbbbb'), true);
    assert.equal(volumes.readLock(dir, 'data'), null);
    // a lock of another manager process that is alive is always respected
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
    try {
      fs.writeFileSync(volumes.lockFile(dir, 'data'), JSON.stringify({ managerPid: other.pid, containerId: 'cccccccccccc', at: 'x' }));
      assert.throws(() => volumes.acquireLock(dir, 'data', o('dddddddddddd')), /another manager process/);
    } finally { other.kill(); }
    // a lock being written right now (unreadable, fresh) is respected too
    fs.writeFileSync(volumes.lockFile(dir, 'data'), '');
    assert.throws(() => volumes.acquireLock(dir, 'data', o('dddddddddddd')), /taking it right now/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spec: live shares and the log cap are rendered; shares pull in the 9P modules; bad targets refused', () => {
  const s = plan.buildSpec({ cmd: ['nginx'] }, { shares: [{ id: 'abc123abc123-1', target: '/usr/share/nginx/html', readonly: true }], logCap: 1048576 });
  const text = initramfs.renderSpec(s);
  assert.match(text, /devbox_share 'abc123abc123-1' '\/usr\/share\/nginx\/html' ro \|\| return 1/);
  assert.match(text, /DEVBOX_LOG_CAP=1048576/);
  assert.deepEqual(initramfs.specFeatures(s), ['net', 'rng', 'ninep']);
  assert.throws(() => initramfs.renderSpec(Object.assign({}, s, { shares: [{ id: 'x', target: '/a b' }] })), /without spaces/);
  assert.throws(() => initramfs.renderSpec(Object.assign({}, s, { shares: [{ id: 'x;rm', target: '/a' }] })), /shared folder id/);
  assert.throws(() => initramfs.renderSpec(Object.assign({}, s, { volumes: [{ serial: 'v0', target: '/data' }], shares: [{ id: 'x', target: '/data' }] })), /duplicate/);
  assert.throws(() => initramfs.renderSpec(Object.assign({}, s, { logCap: -1 })), /logCap/);
});

test('init.sh: the stop protocol pieces are in place (early reader, ack, NOSTART, ERROR, RAM-root cap, log cap, shares)', () => {
  const sh = initramfs.initScript();
  const at = (needle) => { const i = sh.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  // the reader starts right after the spec is sourced, before modules,
  // volumes, shares and copy-in (bug V2)
  const reader = at('done <"$DEVBOX_TTY"');
  assert.ok(at('. "$SPEC"') < reader);
  // (the disk root's stage 1 loads its modules before the reader on purpose:
  // nothing may run in the background before switch_root; the host resends)
  assert.ok(reader < sh.lastIndexOf('for m in $DEVBOX_MODULES'), 'the main module loop');
  for (const later of ['devbox_mounts ||', 'if [ "$DEVBOX_COPYIN" = 1 ]']) assert.ok(reader < at(later), later);
  // volumes and shared folders in one ordered list, after the share helpers
  // exist (correct-1); the spec comes from fw_cfg before /.devbox/spec.sh (sec-7)
  assert.ok(at('share_mount() {') < at('devbox_mounts ||'));
  assert.ok(at('opt/devbox/spec/raw') < at('SPEC=/.devbox/spec.sh'));
  at('remount_nested "$2"');
  at('$B mv "$m/data.new" "$m/data"');
  at('marker STOPPING');
  at('marker NOSTART');
  at('marker "ERROR=');
  at('MemAvailable:');
  at('remount,size=$((used + avail / 2))k');
  at('/proc/$p/io');
  at('trans=tcp,port=$sp,version=9p2000.L,msize=524288,cache=mmap,aname=$sc');
  at('uname=boot-$BOOT_ID');
  // the wrapper writes child.pid BEFORE it looks at the stop flag
  const wrap = at("echo $$ >'\"$R\"'/child.pid; if [ -e '\"$R\"'/stopping ]");
  assert.ok(wrap > 0);
  // "no start" is decided before any FIFO exists: PID 1 never opens a FIFO
  // (an EINTR there ended PID 1 - a kernel panic on a stop during boot)
  assert.ok(at('$B touch "$R/nostart"') < at('$B mkfifo -m 0600 "$R/out"'));
  assert.ok(!/^\s*: >"\$R\/(out|err)"/m.test(sh), 'no FIFO opened by PID 1');
  assert.ok(!/^\s*(: )?>"\$R\/stopping"/m.test(sh));
  assert.ok(!/\r/.test(sh));
});

test('init.sh: the disk root - stage 1 mounts devbox-root and switch_roots before any background job; stage 2 reuses the spec; no fstrim of /', () => {
  const sh = initramfs.initScript();
  const at = (needle) => { const i = sh.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const stage1 = at('if [ "$DEVBOX_ROOT" = disk ] && [ "$DEVBOX_STAGE" != 2 ]; then');
  const sw = at('exec $B switch_root /newroot /.devbox/init');
  assert.ok(at('. "$SPEC"') < stage1, 'the spec decides the root');
  assert.ok(sw < at('done <"$DEVBOX_TTY"'), 'switch_root before the console reader (nothing may hold the initramfs)');
  assert.ok(at('disk_by_serial devbox-root') < sw);
  // a fresh tmpfs (the image cannot plant a spec there), capped at half the
  // RAM: copy-in extracts its path list there (cr-5 - 16 MB was too small)
  assert.ok(at('mount -t tmpfs -o mode=0755,size=50% devbox /newroot/.devbox') < sw, 'the engine folder is a fresh tmpfs: the image cannot plant a spec there');
  // OOM kills of the boot reach the host just before EXIT, on both ends (cr-3)
  assert.ok(at('oom_marker\nmarker "EXIT=$code"') > 0);
  assert.ok(sh.indexOf('oom_marker\n  marker "EXIT=$1"') > 0, 'die() too');
  at('[ "$k" = oom_kill ]');
  // the RAM root's / is root's too (cr-2: the disk root writes it 0755 root:root)
  assert.ok(at('$B chown 0:0 /') < at('$B chmod 755 /'));
  assert.ok(at('$B cp "$R/spec.sh" /newroot/.devbox/run/spec.sh') < sw);
  assert.ok(at('if [ "$DEVBOX_STAGE" = 2 ] && [ -s "$R/spec.sh" ]; then') < stage1, 'stage 2 does not read fw_cfg again');
  at('marker "ROOT uptime=');
  at('[ "$DEVBOX_ROOT" = disk ] || cap_root');
  // a clean journal at every end: the normal exit and die()
  const ro = at('$B mount -o remount,ro / 2>/dev/null || $B sync');
  assert.ok(sh.lastIndexOf('unmount_volumes') < ro && ro < sh.lastIndexOf('marker "EXIT=$code"'), 'after the volumes, before the exit marker');
  assert.ok(at('$B mount -o remount,ro /newroot 2>/dev/null || $B mount -o remount,ro / 2>/dev/null') < at('marker "EXIT=$1"'));
  assert.ok(!/fstrim\s+\/(\s|$)/m.test(sh), 'no fstrim of the root (measured: +150-190 ms and +1 MB of overlay per exit)');
  assert.ok(!/^DEVBOX_ROOT=disk/m.test(sh), 'the default is the RAM root; the spec says disk');
});
