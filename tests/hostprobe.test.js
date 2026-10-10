'use strict';
/*
 * lib/hostprobe.js and what uses it: the candidate list and its order, the
 * guest script and the parser of its output (on what a real guest printed on
 * 2026-10-10), the choice, the result file and its key, the validator, and in
 * vm.js the accelerator choice, the WHPX setting, the hypervisor-fault
 * fallback to TCG and its reset. PROBE_E2E=1 also runs a real probe of two
 * candidates on this PC (QEMU and the microVM kernel must be installed).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { CFG } = config;
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const hp = require('../lib/hostprobe');
const vm = require('../lib/vm');
const { useTempRoot, resetConfig, rm } = require('./helpers');

function withRoot(fn) {
  const root = useTempRoot('probe');
  tasks._reset();
  st.loadState();
  hp.invalidate();
  return Promise.resolve().then(() => fn(root)).finally(() => { tasks._reset(); hp.invalidate(); resetConfig(); rm(root); });
}

// what the guest printed under WHPX with x86-64-v2 flags (trimmed)
const REAL_OK = [
  'PROBE-FLAGS flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm rep_good nopl xtopology cpuid tsc_known_freq pni ssse3 cx16 sse4_1 sse4_2 x2apic popcnt hypervisor lahf_lm',
  'PROBE-DMESG [    0.165303] x86/fpu: x87 FPU will use FXSAVE',
  'PROBE-FPU2 666667166',
  'PROBE-FPU1 666667166',
  'PROBE-SUM 7f614da9329cd3aebf59b91aadc30bf0  -',
  'PROBE-DONE 3',
].join('\n');

test('candidates: WHPX tries the host CPU first and TCG last; pic=off only after the plain ones; KVM/HVF host and max', () => {
  const w = hp.candidates({ accel: 'whpx', v3Model: 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+xsave,+avx' });
  assert.deepEqual(w.map((c) => c.id), ['host', 'host-noxsave', 'v3', 'v2', 'host-lapic', 'v2-lapic', 'v2-irqoff', 'default', 'tcg']);
  const byId = Object.fromEntries(w.map((c) => [c.id, c]));
  assert.equal(byId.host.cpu, 'host');
  assert.match(byId['host-noxsave'].cpu, /^host,-xsave,.*-avx,-avx2,-fma/);
  assert.equal(byId.v3.accelOpts, 'kernel-irqchip=off', 'the old model with the old option, as it really ran');
  assert.equal(byId.v2.cpu, hp.V2);
  assert.equal(byId['v2-lapic'].machine, 'q35,pic=off');
  assert.equal(byId.default.cpu, null);
  assert.deepEqual([byId.tcg.accel, byId.tcg.cpu], ['tcg', 'max']);
  for (const c of w) assert.ok(c.label && c.machine, c.id);
  // the old model equal to v2 (a host without AVX2) is not tried twice
  assert.equal(hp.candidates({ accel: 'whpx', v3Model: hp.V2 }).filter((c) => c.id === 'v3').length, 0);
  assert.deepEqual(hp.candidates({ accel: 'kvm' }).map((c) => c.id + ':' + c.cpu), ['host:host', 'max:max', 'tcg:max']);
  assert.deepEqual(hp.candidates({ accel: null }).map((c) => c.id), ['tcg']);
  assert.deepEqual(hp.candidates({ accel: 'whpx', tcg: false }).slice(-1)[0].id, 'default');
});

test('probeScript: busybox only, two FPU jobs in parallel, the checksum, every line tagged', () => {
  const s = hp.probeScript();
  assert.match(s, /^B=\/\.devbox\/busybox$/m);
  assert.equal((s.match(/ awk /g) || []).length, 2);
  assert.match(s, /PROBE-FPU1 [^']*' &\n.*PROBE-FPU2 [^']*' &\nwait/);
  assert.match(s, /dd if=\/dev\/zero bs=1048576 count=64/);
  assert.match(s, /PROBE-DONE/);
  assert.doesNotMatch(s, /\$\(\$B (wget|nc|curl)/, 'no network');
});

test('parseProbeOutput: the real output passes; a wrong sum, a missing end or no flags fail with the reason', () => {
  const ok = hp.parseProbeOutput(REAL_OK);
  assert.equal(ok.ok, true, ok.problems.join('; '));
  assert.deepEqual(ok.flags, ['sse4_2', 'popcnt', 'hypervisor']);
  assert.equal(ok.workS, 3);
  assert.deepEqual(ok.dmesg, ['[    0.165303] x86/fpu: x87 FPU will use FXSAVE']);
  const bad = hp.parseProbeOutput(REAL_OK.replace('PROBE-FPU2 666667166', 'PROBE-FPU2 666667165'));
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /floating-point job 2 printed "666667165"/);
  const cut = hp.parseProbeOutput(REAL_OK.split('\n').slice(0, 3).join('\n'));
  assert.equal(cut.ok, false);
  assert.match(cut.problems.join(), /did not finish/);
  assert.match(cut.problems.join(), /checksum null/);
  assert.match(hp.parseProbeOutput('').problems.join(), /no CPU flags/);
});

test('pickBest and summary: the first pass in preference order; TCG\'s time alongside', () => {
  const rs = [
    { id: 'host', label: 'WHPX, host CPU', ok: false, bootMs: 3300, error: 'the guest kernel panicked' },
    { id: 'v2', label: 'WHPX, x86-64-v2 flags', accel: 'whpx', ok: true, bootMs: 6131 },
    { id: 'default', label: 'WHPX, QEMU\'s default CPU model', ok: true, bootMs: 5550 },
    { id: 'tcg', label: 'TCG', accel: 'tcg', ok: true, bootMs: 77429 },
  ];
  assert.equal(hp.pickBest(rs).id, 'v2', 'preference order, not the fastest boot');
  assert.equal(hp.pickBest([rs[0]]), null);
  assert.equal(hp.summary({ best: rs[1], results: rs }), 'WHPX, x86-64-v2 flags - test boot 6.1 s (TCG: 77.4 s)');
  assert.equal(hp.summary({ best: null, results: [] }), 'nothing passed');
  assert.equal(hp.summary(null), 'not probed yet');
});

test('the result file: best() only while the key (QEMU, CPU, OS) matches this PC; state() for the GUI', () => withRoot(() => {
  assert.equal(hp.best(), null);
  assert.deepEqual(hp.state(), { probed: false, current: false, best: null, summary: null, probedAt: null, hardwareAccel: null });
  const best = { id: 'v2', label: 'WHPX, x86-64-v2 flags', accel: 'whpx', machine: 'q35', cpu: hp.V2, accelOpts: '', bootMs: 6131, flags: ['sse4_2'] };
  const write = (key) => { fs.writeFileSync(hp.file(), JSON.stringify({ version: hp.PROBE_VERSION, probedAt: '2026-10-10T07:00:00Z', key: key, hardwareAccel: 'whpx', results: [best], best: best })); hp.invalidate(); };
  write(hp.keyNow());
  assert.deepEqual(hp.best(), best);
  assert.equal(hp.state().current, true);
  assert.match(hp.state().summary, /^WHPX, x86-64-v2 flags - test boot 6\.1 s$/);
  write(Object.assign({}, hp.keyNow(), { qemuVersion: 'QEMU emulator version 9.0.0' }));
  assert.equal(hp.best(), null, 'another QEMU: probe again');
  assert.equal(hp.state().probed, true);
  assert.equal(hp.state().current, false);
}));

test('validateProbe: unknown candidates are refused first (400), then a missing QEMU or kernel (409)', () => withRoot(async () => {
  await assert.rejects(hp.validateProbe({ only: 'host,turbo' }), (e) => e.status === 400 && /unknown candidate\(s\): turbo/.test(e.message));
  await assert.rejects(hp.validateProbe({}), (e) => e.status === 409 && /PREREQ_MISSING|NO_KERNEL/.test(e.code));
}));

test('vm.js: the accelerator follows the probe; a pinned accelerator and a fallback win; WHPX gets the probe\'s CPU, machine and options', () => withRoot(async () => {
  const rec = st.newVmRecord({ port: 2300 });
  const write = (best) => { fs.writeFileSync(hp.file(), JSON.stringify({ version: hp.PROBE_VERSION, probedAt: 'x', key: hp.keyNow(), results: [best], best: best })); hp.invalidate(); };
  write({ id: 'tcg', label: 'TCG', accel: 'tcg', machine: 'q35', cpu: 'max', accelOpts: '' });
  assert.equal(await vm.chooseAccel(rec), 'tcg', 'the probe found nothing faster that works');
  assert.equal(await vm.chooseAccel(Object.assign({}, rec, { accel: 'whpx' })), 'whpx', 'a pinned accelerator wins');
  write({ id: 'v2-lapic', label: 'WHPX, x86-64-v2 flags, Hyper-V LAPIC (pic=off)', accel: 'whpx', machine: 'q35,pic=off', cpu: hp.V2, accelOpts: '' });
  assert.equal(await vm.chooseAccel(rec), 'whpx');
  assert.equal(await vm.chooseAccel(Object.assign({}, rec, { accelFallback: { accel: 'tcg', at: 'x', reason: 'y' } })), 'tcg', 'after a hypervisor fault');
  const ws = await vm.whpxSetting();
  assert.deepEqual([ws.cpu, ws.machine, ws.accelOpts, ws.source], [hp.V2, 'q35,pic=off', '', 'probe']);
  // the QEMU line: plain "-accel whpx" (QEMU's defaults), the probe's model and machine
  const line = vm.qemuArgs({ name: 'k', disk: 'd.qcow2', mem: 512, cpus: 2, accel: 'whpx', accelOpts: ws.accelOpts, cpuModel: ws.cpu, machine: ws.machine,
    netdev: 'user,id=n0', mac: '52:54:00:00:00:01', monitor: { host: '127.1.2.3', port: 1 }, serial: { host: '127.1.2.3', port: 2 } }).join(' ');
  assert.match(line, /-machine q35,pic=off/);
  assert.match(line, /-accel whpx -accel tcg,tb-size=256/);
  assert.match(line, new RegExp('-cpu ' + hp.V2.replace(/[.+]/g, '\\$&')));
  // no probe: the old explicit option
  assert.deepEqual(vm.accelArgs('whpx').slice(0, 2), ['-accel', 'whpx,kernel-irqchip=off']);
  assert.deepEqual(vm.accelArgs('whpx', 'kernel-irqchip=off,ssd=off').slice(0, 2), ['-accel', 'whpx,kernel-irqchip=off,ssd=off']);
}));

test('hypervisor faults: a WHPX fault in QEMU\'s log is recognised; an automatic VM falls back to TCG and restarts, a pinned one only records it', () => withRoot(async () => {
  assert.ok(vm.HV_FAULT_STATES.test('internal-error') && vm.HV_FAULT_STATES.test('guest-panicked'));
  assert.ok(!vm.HV_FAULT_STATES.test('io-error') && !vm.HV_FAULT_STATES.test('') , 'a full disk or a user pause is not the hypervisor');
  fs.mkdirSync(CFG.logsDir, { recursive: true });
  fs.writeFileSync(st.qemuLogPath('a'), 'warning: x\nqemu-system-x86_64.exe: WHPX: Unexpected VP exit code 4\n');
  assert.equal(vm.hvFaultText('a'), 'WHPX: Unexpected VP exit code 4');
  assert.equal(vm.hvFaultText('none'), null);
  // pinned to WHPX: recorded, not restarted
  st.state.vms.p = st.newVmRecord({ port: 2301, accel: 'whpx' });
  assert.equal(vm.hypervisorFault('p', 'the hypervisor stopped the guest', false), false);
  assert.equal(st.state.vms.p.accelFallback, null);
  assert.match(st.state.vms.p.lastError.message, /set to whpx, so it was not restarted under TCG/);
  // automatic: falls back and a start task begins (it fails here - no QEMU - which is fine)
  st.state.vms.a = st.newVmRecord({ port: 2302 });
  assert.equal(vm.hypervisorFault('a', 'the hypervisor stopped the guest: WHPX: Unexpected VP exit code 4', false), true);
  assert.equal(st.state.vms.a.accelFallback.accel, 'tcg');
  assert.match(st.state.vms.a.accelFallback.reason, /Unexpected VP exit code 4/);
  const t = tasks.list().find((x) => x.vm === 'a');
  assert.ok(t && t.kind === 'start' && /under TCG/.test(t.title), JSON.stringify(t));
  await tasks.wait(t.id);
  // choosing an accelerator ends the fallback
  const r = await vm.updateSettings({ name: 'a', accel: 'auto' });
  assert.equal(st.state.vms.a.accelFallback, null);
  assert.equal(r.vm.accelFallback, null);
  // the record keeps a fallback across a save and load, and drops junk
  assert.deepEqual(st.newVmRecord({ accelFallback: { accel: 'tcg', at: '2026-10-10', reason: 'r', extra: 1 } }).accelFallback, { accel: 'tcg', at: '2026-10-10', reason: 'r' });
  assert.equal(st.newVmRecord({ accelFallback: { accel: 'whpx' } }).accelFallback, null);
}));

test('a real probe of two candidates on this PC', { skip: !process.env.PROBE_E2E && 'set PROBE_E2E=1 (needs QEMU and the microVM kernel; about a minute)' }, async () => {
  const lines = [];
  const t = { log: (m) => lines.push(m), step: (m) => lines.push('> ' + m), warn: (m) => lines.push('WARNING ' + m) };
  const before = fs.existsSync(hp.file()) ? fs.readFileSync(hp.file()) : null;
  try {
    const r = await hp.probe(t, { only: ['v2', 'tcg'], tcg: true });
    assert.equal(r.results.length >= 1, true, lines.join('\n'));
    assert.ok(r.best, 'something passes - TCG always does:\n' + lines.join('\n'));
  } finally {
    if (before) fs.writeFileSync(hp.file(), before);   // keep the real full result
    hp.invalidate();
  }
});
