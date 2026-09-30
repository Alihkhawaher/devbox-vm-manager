'use strict';
/*
 * The microVM init side: the run spec (renderSpec, sourced by a real sh when
 * one is available), its 32 KB cap (bug I), the init archive built with the
 * app's single cpio writer (bug F) and init.sh itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const initramfs = require('../lib/microvm/initramfs');
const { listCpioBuffer } = require('../lib/oci/cpio');

// a POSIX sh to check the rendered spec with (Git for Windows ships one)
const SH = ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe'].find((p) => fs.existsSync(p));

test('shq quotes anything into one word; NUL is refused', () => {
  assert.strictEqual(initramfs.shq("it's"), "'it'\\''s'");
  assert.strictEqual(initramfs.shq(''), "''");
  assert.throws(() => initramfs.shq('a\0b'), /NUL/);
});

test('normSignal: Docker STOPSIGNAL forms', () => {
  assert.strictEqual(initramfs.normSignal('SIGQUIT'), 'QUIT');
  assert.strictEqual(initramfs.normSignal('term'), 'TERM');
  assert.strictEqual(initramfs.normSignal(9), 'KILL');
  assert.strictEqual(initramfs.normSignal('15'), 'TERM');
  assert.strictEqual(initramfs.normSignal(undefined), 'TERM');
  assert.throws(() => initramfs.normSignal('SIGRTMIN+3'), /unsupported/);
  assert.throws(() => initramfs.normSignal(99), /unsupported/);
});

test('renderSpec validates its input', () => {
  assert.throws(() => initramfs.renderSpec({ argv: [] }), /non-empty/);
  assert.throws(() => initramfs.renderSpec({ argv: ['A=b'] }), /cannot contain "="/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], hostname: 'bad_host!' }), /hostname/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], env: ['NOEQUALS'] }), /environment/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'v', target: 'rel' }] }), /absolute/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'v', target: '/' }] }), /absolute/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'v', target: '/a/../b' }] }), /absolute/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'v', target: '/.devbox/x' }] }), /absolute/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'a', target: '/d' }, { serial: 'b', target: '/d/' }] }), /duplicate/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], volumes: [{ serial: 'x'.repeat(21), target: '/d' }] }), /serial/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], sysctls: { 'a/../b': '1' } }), /sysctl/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], stopTimeout: -1 }), /stopTimeout/);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], modules: ['a;b'] }), /module/);
});

// bug I: fw_cfg reads cost O(size^2) in the guest - a huge environment would
// stall the boot, so the rendered spec is capped at 32 KB
test('renderSpec: at most 32 KB (SPEC_TOO_LARGE with the copy-in hint)', () => {
  assert.strictEqual(initramfs.SPEC_MAX_BYTES, 32 * 1024);
  const ok = initramfs.renderSpec({ argv: ['x'], env: ['BIG=' + 'v'.repeat(30000)] });
  assert.ok(Buffer.byteLength(ok) <= 32 * 1024);
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], env: ['BIG=' + 'v'.repeat(33000)] }),
    (e) => e.code === 'SPEC_TOO_LARGE' && /copy-in/.test(e.message) && /32 KB/.test(e.message));
  const many = [];
  for (let i = 0; i < 2000; i++) many.push('K' + i + '=' + 'x'.repeat(20));
  assert.throws(() => initramfs.renderSpec({ argv: ['x'], env: many }), (e) => e.code === 'SPEC_TOO_LARGE');
});

test('renderSpec output, as the init sees it (sourced by a real sh)', { skip: !SH && 'no POSIX sh here' }, () => {
  const tricky = ["it's", 'a "b" $HOME `id` \\n', 'line1\nline2', '', '*', '--x', 'ünï', '$(reboot)'];
  const spec = {
    argv: ['/bin/prog'].concat(tricky), env: ['K1=v 1', "K2=it's", 'K3=a=b'], user: 'app:staff', workdir: '/srv/my app',
    hostname: 'web-1', stopSignal: 'SIGQUIT', stopTimeout: 3, modules: ['virtio_net'],
    volumes: [{ serial: 'vol0', target: '/var/lib/data', readonly: true, nocopy: true }, { serial: 'vol1', target: '/srv/a b/' }],
    extraHosts: [{ host: 'db', ip: '10.0.2.100' }], sysctls: { 'net.core.somaxconn': '1024' },
  };
  const text = initramfs.renderSpec(spec);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  const f = path.join(dir, 'spec.sh').replace(/\\/g, '/');
  fs.writeFileSync(f, text);
  // stub what init provides, then print every variable/call one per line (NUL separated)
  const script = [
    'devbox_volume() { printf "VOL[%s|%s|%s|%s]\\0" "$1" "$2" "$3" "$4"; }', 'say() { :; }',
    '. "' + f + '"',
    'printf "%s\\0" "$DEVBOX_HOSTNAME" "$DEVBOX_WORKDIR" "$DEVBOX_USER" "$DEVBOX_STOP_SIGNAL" "$DEVBOX_STOP_TIMEOUT" "$DEVBOX_MODULES" "$DEVBOX_NET"',
    'devbox_volumes',
    'devbox_hosts | tr "\\n" "\\0"',
    'devbox_exec printf "%s\\0"',
  ].join('\n');
  const out = execFileSync(SH, ['-c', script], { windowsHide: true }).toString('utf8').split('\0');
  out.pop();
  assert.deepStrictEqual(out, [
    'web-1', '/srv/my app', 'app:staff', 'QUIT', '3', 'virtio_net', '1',
    'VOL[vol0|/var/lib/data|ro|nocopy]', 'VOL[vol1|/srv/a b|rw|]',
    '10.0.2.100\tdb',
    'K1=v 1', "K2=it's", 'K3=a=b', '/bin/prog',
  ].concat(tricky));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('specFeatures / specModules', () => {
  const manifest = { features: { net: ['failover', 'virtio_net'], blk: ['virtio_blk'], ext4: ['crc16', 'ext4'], rng: ['rng_core', 'virtio_rng'], acpibutton: ['button', 'evdev'] } };
  assert.deepStrictEqual(initramfs.specFeatures({ argv: ['x'] }), ['net', 'rng']);
  assert.deepStrictEqual(initramfs.specFeatures({ argv: ['x'], net: false, rng: false }), []);
  assert.deepStrictEqual(initramfs.specModules({ argv: ['x'], net: false, volumes: [{}], acpiButton: true }, manifest),
    ['virtio_blk', 'crc16', 'ext4', 'button', 'evdev', 'rng_core', 'virtio_rng']);
  assert.deepStrictEqual(initramfs.specModules({ modules: ['a'] }, manifest), ['a']);
});

function fakeKernelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdir-'));
  fs.writeFileSync(path.join(dir, 'busybox.static'), 'BUSYBOX');
  fs.mkdirSync(path.join(dir, 'modules'));
  const manifest = { kver: 'test', modules: {}, features: { net: ['virtio_net'], rng: [] } };
  for (const m of ['virtio_net', 'ext4']) {
    fs.writeFileSync(path.join(dir, 'modules', m + '.ko'), 'KO:' + m);
    manifest.modules[m] = { file: 'modules/' + m + '.ko' };
  }
  return { dir, manifest };
}

test('buildInitArchive: per-run (spec + needed modules) and base (all modules, no spec); reproducible', async () => {
  const k = fakeKernelDir();
  try {
    const buf = await initramfs.buildInitArchive({ kernelDir: k.dir, manifest: k.manifest, spec: { argv: ['/bin/true'] } });
    assert.strictEqual(buf.length % 512, 0, 'padded to 512 bytes');
    const run = await listCpioBuffer(buf);
    const names = run.map((e) => e.name);
    for (const n of ['.devbox', '.devbox/busybox', '.devbox/init', '.devbox/spec.sh', '.devbox/modules/virtio_net.ko', 'dev', 'dev/console', 'dev/null']) assert.ok(names.includes(n), n);
    assert.ok(names.indexOf('dev') < names.indexOf('dev/console'), 'parents come first (autoParents)');
    assert.ok(!names.includes('.devbox/modules/ext4.ko'));
    const init = run.find((e) => e.name === '.devbox/init');
    assert.strictEqual(init.perm, 0o755);
    assert.ok(init.data.toString().startsWith('#!/.devbox/busybox sh'));
    const con = run.find((e) => e.name === 'dev/console');
    assert.deepStrictEqual([con.type, con.rdevmajor, con.rdevminor, con.perm], ['char', 5, 1, 0o600]);
    assert.ok(run.every((e) => e.ino >= 0x10000000), 'inode numbers stay clear of the rootfs archive');
    assert.ok(run.every((e) => e.mtime === 0), 'mtime 0: the same inputs give the same bytes');
    const base = (await listCpioBuffer(await initramfs.buildInitArchive({ kernelDir: k.dir, manifest: k.manifest }))).map((e) => e.name);
    assert.ok(base.includes('.devbox/modules/ext4.ko') && base.includes('.devbox/modules/virtio_net.ko'));
    assert.ok(!base.includes('.devbox/spec.sh'));
    const again = await initramfs.buildInitArchive({ kernelDir: k.dir, manifest: k.manifest, spec: { argv: ['/bin/true'] } });
    assert.ok(again.equals(buf), 'byte-identical');
    await assert.rejects(initramfs.buildInitArchive({ kernelDir: k.dir, manifest: k.manifest, modules: ['nope'] }), /not in the kernel manifest/);
  } finally { fs.rmSync(k.dir, { recursive: true, force: true }); }
});

test('init.sh: markers, fw_cfg path and the privilege drop are in place; LF only', () => {
  const s = initramfs.initScript();
  for (const needle of ['__DEVBOX_$*', 'marker READY', 'marker "EXIT=$code"', 'opt/devbox/spec', 'nsenter -S', '__DEVBOX_STOP', '__DEVBOX_KILL', 'poweroff -f', 'devbox.stdout', 'devbox.stderr', 'fstrim']) {
    assert.ok(s.includes(needle), needle);
  }
  assert.ok(!/\r/.test(s), 'init.sh must have LF line endings');
  assert.ok(!/\r/.test(fs.readFileSync(initramfs.INIT_PATH, 'latin1')), 'the shipped file itself is LF (see .gitattributes)');
});

test('devbox_mounts: volumes and shared folders in ONE list, parents before children (correct-1)', { skip: !SH && 'no POSIX sh here' }, () => {
  // the common Docker pattern: the project folder shared, node_modules in a
  // named volume below it; plus a volume listed child-first (x:/a/b, y:/a)
  const text = initramfs.renderSpec({
    argv: ['/bin/true'],
    volumes: [{ serial: 'vol0', target: '/app/node_modules' }, { serial: 'vol1', target: '/a/b' }, { serial: 'vol2', target: '/a' }],
    shares: [{ id: 'abc-1', target: '/app' }],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
  const f = path.join(dir, 'spec.sh').replace(/\\/g, '/');
  fs.writeFileSync(f, text);
  const script = [
    'devbox_volume() { printf "V[%s|%s]\\0" "$1" "$2"; }', 'devbox_share() { printf "S[%s|%s]\\0" "$1" "$2"; }',
    '. "' + f + '"', 'devbox_mounts',
  ].join('\n');
  const out = execFileSync(SH, ['-c', script], { windowsHide: true }).toString('utf8').split('\0');
  out.pop();
  assert.deepStrictEqual(out, ['V[vol2|/a]', 'S[abc-1|/app]', 'V[vol0|/app/node_modules]', 'V[vol1|/a/b]']);
  fs.rmSync(dir, { recursive: true, force: true });
});
