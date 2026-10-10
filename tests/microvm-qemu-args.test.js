'use strict';
/*
 * The microVM QEMU command line (pure) and the host CPU helpers. Control
 * endpoints come from the caller (no fixed 127.0.0.2 and no -qmp: HMP
 * through a private socket, like every VM - bug V3).
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildQemuArgs, kernelAppend, qv, hostfwdRule, chardevArg } = require('../lib/microvm/qemu-args');
const hostcpu = require('../lib/microvm/hostcpu');

const valuesOf = (args, flag) => args.map((a, i) => (a === flag ? args[i + 1] : null)).filter((x) => x !== null);

test('microvm: virtio-mmio devices, legacy devices kept, no reboot, headless, HMP monitor', () => {
  const a = buildQemuArgs({
    machine: 'microvm', accel: 'whpx', kernel: 'k', initrd: 'i', append: ['console=ttyS0', 'quiet'],
    console: { socket: { host: '127.9.8.7', port: 40001, server: true }, logfile: 'C:/logs/con,sole.log' },
    monitor: { host: '127.9.8.7', port: 40002 },
    net: { hostfwd: [{ hostPort: 18080, guestPort: 80 }, { proto: 'udp', hostAddr: '0.0.0.0', hostPort: 18081, guestPort: 53 }] },
    drives: [{ path: 'C:/v/a.qcow2', format: 'qcow2', serial: 'vol0' }, { path: 'b.raw', readonly: true, serial: 'vol1' }],
    vports: [{ name: 'devbox.stdout', chardev: { file: 'out.log' } }, { name: 'devbox.stderr', chardev: { file: 'err.log' } }],
    rng: true, fwcfg: [{ name: 'opt/devbox/spec', file: 'spec.sh' }], paused: true,
  });
  assert.deepStrictEqual(valuesOf(a, '-machine'), ['microvm,isa-serial=on,rtc=on,pit=on,pic=on']);
  assert.deepStrictEqual(valuesOf(a, '-accel'), ['whpx,kernel-irqchip=off', 'tcg,tb-size=128']);
  assert.ok(!a.includes('-cpu'), 'WHPX without an explicit model keeps QEMU default');
  for (const f of ['-nodefaults', '-no-user-config', '-no-reboot', '-S']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('-qmp'), 'one monitor protocol for the whole app: HMP');
  assert.deepStrictEqual(valuesOf(a, '-display'), ['none']);
  assert.deepStrictEqual(valuesOf(a, '-append'), ['console=ttyS0 quiet']);
  const devs = valuesOf(a, '-device');
  assert.ok(devs.some((d) => d.startsWith('virtio-net-device,netdev=n0')));
  assert.ok(devs.includes('virtio-blk-device,drive=vd0,serial=vol0'));
  assert.ok(devs.some((d) => d.startsWith('virtio-serial-device,id=vser0')));
  assert.ok(devs.includes('virtserialport,bus=vser0.0,nr=1,chardev=vp0,name=devbox.stdout'));
  assert.ok(devs.includes('virtio-rng-device,rng=rng0'));
  assert.ok(!devs.some((d) => /-pci/.test(d)));
  assert.deepStrictEqual(valuesOf(a, '-netdev'), ['user,id=n0,hostfwd=tcp:127.0.0.1:18080-:80,hostfwd=udp:0.0.0.0:18081-:53']);
  const drives = valuesOf(a, '-drive');
  assert.ok(drives[0].startsWith('file=C:/v/a.qcow2,if=none,id=vd0,format=qcow2'));
  assert.ok(drives[1].includes('readonly=on') && drives[1].includes('format=raw'));
  const chardevs = valuesOf(a, '-chardev');
  assert.strictEqual(chardevs[0], 'socket,id=con0,host=127.9.8.7,port=40001,server=on,wait=off,logfile=C:/logs/con,,sole.log,logappend=off');
  assert.strictEqual(chardevs[1], 'socket,id=mon0,host=127.9.8.7,port=40002,server=on,wait=off');
  assert.deepStrictEqual(valuesOf(a, '-mon'), ['chardev=mon0,mode=readline']);
  assert.deepStrictEqual(valuesOf(a, '-serial'), ['chardev:con0']);
  assert.deepStrictEqual(valuesOf(a, '-fw_cfg'), ['name=opt/devbox/spec,file=spec.sh']);
});

test('q35: virtio-pci devices; tcg gets -cpu max; no net -> no netdev', () => {
  const a = buildQemuArgs({ machine: 'q35', accel: 'tcg', kernel: 'k', net: false, drives: [{ path: 'd', serial: 's' }], rng: true });
  assert.deepStrictEqual(valuesOf(a, '-machine'), ['q35']);
  assert.deepStrictEqual(valuesOf(a, '-accel'), ['tcg,tb-size=128']);
  assert.deepStrictEqual(valuesOf(buildQemuArgs({ machine: 'q35', accel: 'tcg', kernel: 'k', tcgTbSizeMB: 0 }), '-accel'), ['tcg'], 'tb-size 0 = QEMU default');
  assert.deepStrictEqual(valuesOf(a, '-cpu'), ['max']);
  assert.ok(!a.includes('-netdev'));
  const devs = valuesOf(a, '-device');
  assert.ok(devs.includes('virtio-blk-pci,drive=vd0,serial=s'));
  assert.ok(devs.includes('virtio-rng-pci,rng=rng0'));
  assert.deepStrictEqual(valuesOf(a, '-serial'), ['none']);
});

test('control endpoints: unix sockets or an explicit host/port - never a default address (bug V3)', () => {
  assert.strictEqual(chardevArg('c', { socket: { path: '/run/d,v/con.sock', server: true } }), 'socket,id=c,path=/run/d,,v/con.sock,server=on,wait=off');
  const a = buildQemuArgs({ machine: 'microvm', accel: 'tcg', kernel: 'k', monitor: { path: '/run/mon.sock' } });
  assert.deepStrictEqual(valuesOf(a, '-chardev'), ['socket,id=mon0,path=/run/mon.sock,server=on,wait=off']);
  assert.throws(() => chardevArg('c', { socket: { port: 1, server: true } }), /no default address/);
  assert.throws(() => buildQemuArgs({ machine: 'microvm', accel: 'tcg', kernel: 'k', monitor: {} }), /no default address/);
  assert.throws(() => chardevArg('c', {}), /socket, file or null/);
});

test('explicit CPU model and irqchip; no TCG fallback when asked', () => {
  const model = hostcpu.whpxCpuModel({ ssse3: true, sse41: true, sse42: true, avx2: true, rdrand: true });
  const a = buildQemuArgs({ machine: 'q35', accel: 'whpx', whpxIrqchip: true, cpu: model, kernel: 'k', accelFallback: false });
  assert.deepStrictEqual(valuesOf(a, '-accel'), ['whpx,kernel-irqchip=on']);
  assert.deepStrictEqual(valuesOf(a, '-cpu'), [model]);
});

test('kernelAppend: standard line, quiet, TSC for microvm under WHPX, extras last', () => {
  const s = kernelAppend({ tscKhz: 2298666.4, extra: ['foo=1'] });
  assert.strictEqual(s[0], 'console=ttyS0');
  for (const w of ['rdinit=/.devbox/init', 'panic=-1', 'quiet', 'tsc_early_khz=2298666', 'random.trust_cpu=on']) assert.ok(s.includes(w), w);
  assert.strictEqual(s[s.length - 1], 'foo=1');
  assert.ok(!kernelAppend({ quiet: false }).includes('quiet'));
  assert.ok(!kernelAppend({}).some((w) => w.startsWith('tsc_early_khz')));
});

test('qv doubles commas; hostfwdRule defaults to tcp on 127.0.0.1', () => {
  assert.strictEqual(qv('a,b,,c'), 'a,,b,,,,c');
  assert.strictEqual(hostfwdRule({ hostPort: 1, guestPort: 2 }), 'tcp:127.0.0.1:1-:2');
  assert.strictEqual(hostfwdRule({ hostAddr: '', hostPort: 1, guestPort: 2 }), 'tcp::1-:2');
});

test('hostcpu: whpxCpuModel and parseTscKhz', () => {
  assert.strictEqual(hostcpu.whpxCpuModel(null), null);
  assert.strictEqual(hostcpu.whpxCpuModel({ ssse3: true, sse42: false }), null);
  assert.strictEqual(hostcpu.whpxCpuModel({ ssse3: true, sse41: true, sse42: true }), 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt');
  const full = hostcpu.whpxCpuModel({ ssse3: true, sse41: true, sse42: true, avx2: true, rdrand: true });
  assert.ok(full.includes('+avx') && full.includes('+aes') && full.includes('+xsave') && full.endsWith('+rdrand'));
  const log = '[0.009] tsc: Detected 2299.109 MHz processor\n[1.47] tsc: Refined TSC clocksource calibration: 2298.666 MHz\n';
  assert.strictEqual(hostcpu.parseTscKhz(log), 2298666, 'the refined value wins');
  assert.strictEqual(hostcpu.parseTscKhz('tsc: Detected 2298.7 MHz processor'), 2298700);
  assert.strictEqual(hostcpu.parseTscKhz('nothing'), null);
});

test('whpxOpts (the host probe\'s): "" is QEMU\'s own defaults, a value is passed as is; absent keeps the old kernel-irqchip', () => {
  const base = { machine: 'q35', accel: 'whpx', kernel: 'k', accelFallback: false };
  assert.deepStrictEqual(valuesOf(buildQemuArgs(Object.assign({ whpxOpts: '' }, base)), '-accel'), ['whpx']);
  assert.deepStrictEqual(valuesOf(buildQemuArgs(Object.assign({ whpxOpts: 'kernel-irqchip=off' }, base)), '-accel'), ['whpx,kernel-irqchip=off']);
  assert.deepStrictEqual(valuesOf(buildQemuArgs(base), '-accel'), ['whpx,kernel-irqchip=off']);
  // the probe's CPU model goes through untouched; no CPU model = QEMU's default
  assert.deepStrictEqual(valuesOf(buildQemuArgs(Object.assign({ whpxOpts: '', cpu: 'host,-xsave,-avx' }, base)), '-cpu'), ['host,-xsave,-avx']);
  assert.deepStrictEqual(valuesOf(buildQemuArgs(Object.assign({ whpxOpts: '' }, base)), '-cpu'), []);
});
