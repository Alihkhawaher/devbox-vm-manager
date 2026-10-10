'use strict';
/*
 * Probe this PC for the best way to run VMs (Ali, 2026-10-10: "can you make a
 * tool to auto prob the pc for best configurations?"). Hardware acceleration
 * is a speed-up, never a requirement ("the purpose of this project is to run in
 * any env, so making it use hyperv access should be helping it not depend on
 * it"): the probe boots a small test guest under each candidate setting, keeps
 * the best one that really works, and falls back to TCG (software emulation,
 * which always works) when none does.
 *
 * Why boot a guest instead of just starting QEMU: on an i7-8550U with Windows
 * 10 22H2 and QEMU 11.1, QEMU starts fine with WHPX and the manager's old CPU
 * model (qemu64 + x86-64-v2 + the AVX/XSAVE family), yet a Linux 6.16 kernel
 * panicked in fpstate_reset 0.33 s into its boot and the microVM calibration
 * boot never finished; with x86-64-v2 flags only, the same kernel reached its
 * splash in 20 s instead of ~3 min under TCG. What works depends on the CPU, the
 * Windows build and the QEMU version, so it is measured per PC - and measured
 * again when any of the three changes (key below).
 *
 * The test guest is the microVM kernel (Alpine linux-virt, installed by "Set
 * up for Docker images") booted on q35 with 2 vCPUs, running a fixed busybox
 * script (probeScript): the CPU flags, the kernel's FPU/XSAVE messages, two
 * floating-point jobs in parallel (the FPU state is saved and restored on every
 * switch, on both vCPUs) and a checksum loop. A candidate PASSES when the
 * script ends with the exact expected results; it FAILS on a kernel panic, a
 * hypervisor fault (QEMU 11.1 pauses the VM instead of exiting - seen through
 * "info status"), a QEMU error, wrong results or a timeout.
 *
 * Candidates, in order of preference (candidates()): with WHPX on Windows
 *   host        -cpu host                      every host feature (QEMU 11.1+)
 *   host-noxsave -cpu host,-xsave,-avx...      the same without XSAVE and the
 *                                              AVX family that needs it
 *   v3          qemu64 + v2 + AVX/XSAVE family the manager's model until 2.2
 *   v2          qemu64 + SSSE3/SSE4.x/POPCNT   x86-64-v2, no XSAVE/AVX
 *   host-lapic  -cpu host, -M pic=off          Hyper-V's LAPIC (QEMU's Windows 10 advice)
 *   v2-lapic    v2, -M pic=off
 *   v2-irqoff   v2, kernel-irqchip=off         the old explicit option (older QEMU)
 *   default     QEMU's default model
 * then tcg (-cpu max), always, as the reference and the fallback. Linux (KVM)
 * and Intel Macs (HVF) get host and max before tcg. The pic=off variants come
 * after the plain ones: legacy guests (BIOS boot, old systems) may need the
 * PIC, so they are chosen only when nothing plainer works.
 *
 * Result file <root>/host-probe.json:
 *   {version, probedAt, key {qemuVersion, cpu, os}, results [{id, label, accel,
 *    machine, cpu, accelOpts, ok, bootMs, workS, flags, error}], best {...}}
 * best() returns the chosen candidate while the key still matches this PC;
 * vm.js (full VMs, appliances) and the microVM engine use it. Without a valid
 * probe they keep their previous defaults.
 *
 * Exports: probe(t, opts), read(), best(), keyNow(), invalidate(), state(),
 * validateProbe(body) / opProbe(t, a) (POST /api/host/probe), candidates(o),
 * probeScript(o), parseProbeOutput(text, o), pickBest(results), summary(r),
 * EXPECT, PROBE_VERSION.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('./config');

const PROBE_VERSION = 1;
const V2_FLAGS = ['ssse3', 'sse4.1', 'sse4.2', 'popcnt'];
const V2 = 'qemu64,' + V2_FLAGS.map((f) => '+' + f).join(',');
const HOST_NOXSAVE = 'host,' + ['xsave', 'xsaveopt', 'xsavec', 'xsaves', 'avx', 'avx2', 'fma', 'f16c', 'avx512f'].map((f) => '-' + f).join(',');
// what probeScript must print (computed once with the same arithmetic: IEEE
// doubles summed in order, and md5 over 64 MiB of zeros)
const EXPECT = { fpuN: 1000000, fpu: '666667166', sumMB: 64, md5: '7f614da9329cd3aebf59b91aadc30bf0' };
const FLAGS_OF_INTEREST = ['sse4_2', 'popcnt', 'aes', 'movbe', 'bmi2', 'rdrand', 'xsave', 'avx', 'avx2', 'fma', 'avx512f', 'sha_ni', 'hypervisor'];

function file() { return path.join(CFG.root, 'host-probe.json'); }

// ---------------------------------------------------------------------------
// what is tried (pure)
// ---------------------------------------------------------------------------
// o: {accel: the detected hardware accelerator or null, v3Model: the old WHPX
// model (hostcpu.whpxCpuModel) or null, tcg: include the TCG reference (true)}
function candidates(o) {
  o = o || {};
  const out = [];
  const add = (c) => out.push(Object.assign({ machine: 'q35', accelOpts: '' }, c));
  if (o.accel === 'whpx') {
    add({ id: 'host', label: 'WHPX, host CPU', accel: 'whpx', cpu: 'host' });
    // measured on Windows 10 22H2 + QEMU 11.1: anything that shows XSAVE to
    // the guest panics Linux in fpstate_reset; the host CPU minus XSAVE keeps
    // every other host feature. The AVX family goes too: it needs XSAVE, and
    // with "-xsave" alone the guest still listed avx/avx2/fma - a program
    // trusting those flags would die on its first AVX instruction.
    add({ id: 'host-noxsave', label: 'WHPX, host CPU without XSAVE/AVX', accel: 'whpx', cpu: HOST_NOXSAVE });
    if (o.v3Model && o.v3Model !== V2) add({ id: 'v3', label: 'WHPX, x86-64-v2 + AVX/XSAVE flags (the manager\'s old model)', accel: 'whpx', cpu: o.v3Model, accelOpts: 'kernel-irqchip=off' });
    add({ id: 'v2', label: 'WHPX, x86-64-v2 flags', accel: 'whpx', cpu: V2 });
    add({ id: 'host-lapic', label: 'WHPX, host CPU, Hyper-V LAPIC (pic=off)', accel: 'whpx', cpu: 'host', machine: 'q35,pic=off' });
    add({ id: 'v2-lapic', label: 'WHPX, x86-64-v2 flags, Hyper-V LAPIC (pic=off)', accel: 'whpx', cpu: V2, machine: 'q35,pic=off' });
    add({ id: 'v2-irqoff', label: 'WHPX, x86-64-v2 flags, kernel-irqchip=off', accel: 'whpx', cpu: V2, accelOpts: 'kernel-irqchip=off' });
    add({ id: 'default', label: 'WHPX, QEMU\'s default CPU model', accel: 'whpx', cpu: null });
  } else if (o.accel === 'kvm' || o.accel === 'hvf') {
    add({ id: 'host', label: o.accel.toUpperCase() + ', host CPU', accel: o.accel, cpu: 'host' });
    add({ id: 'max', label: o.accel.toUpperCase() + ', max CPU', accel: o.accel, cpu: 'max' });
  }
  if (o.tcg !== false) add({ id: 'tcg', label: 'TCG software emulation (always works)', accel: 'tcg', cpu: 'max' });
  return out;
}

// The guest's script (busybox ash). Every line it prints starts with PROBE-.
function probeScript(o) {
  o = o || {};
  const n = o.fpuN || EXPECT.fpuN;
  const mb = o.sumMB || EXPECT.sumMB;
  const B = '/.devbox/busybox';
  const awk = (tag) => B + ' awk \'BEGIN{s=0; for(i=1;i<=' + n + ';i++) s+=sqrt(i); printf "PROBE-' + tag + ' %.0f\\n", s}\'';
  return [
    'B=' + B,
    'echo "PROBE-FLAGS $($B grep -m1 \'^flags\' /proc/cpuinfo)"',
    '$B dmesg | $B grep -i -E "x86/fpu|xsave|Hypervisor detected|panic" | $B head -12 | $B sed "s/^/PROBE-DMESG /"',
    't0=$($B date +%s)',
    // two FPU jobs at once: the FPU/SSE state is saved and restored on every switch
    awk('FPU1') + ' &',
    awk('FPU2') + ' &',
    'wait',
    'echo "PROBE-SUM $($B dd if=/dev/zero bs=1048576 count=' + mb + ' 2>/dev/null | $B md5sum)"',
    'echo "PROBE-DONE $(( $($B date +%s) - t0 ))"',
  ].join('\n');
}

// What the guest printed -> {done, ok, problems, flags, fpu: [..], md5, workS, dmesg}
function parseProbeOutput(text, o) {
  o = o || {};
  const exp = Object.assign({}, EXPECT, o.expect || {});
  const s = String(text || '');
  const line = (tag) => { const m = new RegExp('^PROBE-' + tag + ' (.*)$', 'm').exec(s); return m ? m[1].trim() : null; };
  const flagsLine = line('FLAGS') || '';
  const all = flagsLine.replace(/^flags\s*:\s*/, '').split(/\s+/).filter(Boolean);
  const flags = FLAGS_OF_INTEREST.filter((f) => all.indexOf(f) !== -1);
  const fpu = [line('FPU1'), line('FPU2')];
  const sum = line('SUM');
  const md5 = sum ? sum.split(/\s+/)[0] : null;
  const done = line('DONE');
  const problems = [];
  if (done === null) problems.push('the test script did not finish');
  for (const [i, v] of fpu.entries()) if (v !== exp.fpu) problems.push('floating-point job ' + (i + 1) + ' printed ' + JSON.stringify(v) + ', expected ' + exp.fpu);
  if (md5 !== exp.md5) problems.push('checksum ' + JSON.stringify(md5) + ', expected ' + exp.md5);
  if (!all.length) problems.push('no CPU flags in /proc/cpuinfo');
  const dmesg = (s.match(/^PROBE-DMESG .*$/gm) || []).map((l) => l.slice(12).trim()).slice(0, 12);
  return { done: done !== null, ok: problems.length === 0, problems, flags, fpu, md5, workS: done !== null ? parseInt(done, 10) : null, dmesg, flagCount: all.length };
}

// The first passing candidate in preference order. Pure.
function pickBest(results) {
  return (results || []).find((r) => r && r.ok) || null;
}

// ---------------------------------------------------------------------------
// the result file and its key
// ---------------------------------------------------------------------------
let cache = null; // {mtimeMs, data}
function read() {
  try {
    const st = fs.statSync(file());
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { mtimeMs: st.mtimeMs, data: data && data.version === PROBE_VERSION ? data : null };
    return cache.data;
  } catch (e) { return null; }
}

// What the probe result depends on: this QEMU, this CPU, this OS build.
// Cached for a minute: os.cpus() costs 15-400 ms on a many-core Windows PC,
// and best() runs at every start and status poll.
let keyCache = null; // {at, key}
function keyNow() {
  if (keyCache && Date.now() - keyCache.at < 60000) return keyCache.key;
  const platform = require('./platform');
  const qemu = platform.findTool('qemu');
  const cpus = os.cpus();
  const key = {
    qemuVersion: qemu ? require('./microvm/plan').qemuVersionOf(qemu) : null,
    cpu: cpus && cpus.length ? String(cpus[0].model).trim() : null,
    os: os.platform() + ' ' + os.release(),
  };
  keyCache = { at: Date.now(), key: key };
  return key;
}
// after a QEMU install: the next keyNow() reads the version again
function invalidate() { keyCache = null; cache = null; }
function sameKey(a, b) { return !!a && !!b && a.qemuVersion === b.qemuVersion && a.cpu === b.cpu && a.os === b.os; }

// The chosen setting while it still applies to this PC, else null.
// -> {id, label, accel, machine, cpu, accelOpts, bootMs, flags}
function best() {
  const r = read();
  if (!r || !r.best || !sameKey(r.key, keyNow())) return null;
  return r.best;
}

// Short text for task logs and the GUI.
function summary(r) {
  if (!r) return 'not probed yet';
  if (!r.best) return 'nothing passed';
  const b = r.best;
  const tcg = (r.results || []).find((x) => x.id === 'tcg' && x.ok);
  return b.label + ' - test boot ' + (b.bootMs / 1000).toFixed(1) + ' s' +
    (tcg && b.id !== 'tcg' ? ' (TCG: ' + (tcg.bootMs / 1000).toFixed(1) + ' s)' : '');
}

// ---------------------------------------------------------------------------
// the probe
// ---------------------------------------------------------------------------
// opts: {timeoutS (per hardware candidate, 60), tcgTimeoutS (240), tcg (true),
//        quick (stop at the first pass), only: [ids]}
async function probe(t, opts) {
  opts = opts || {};
  const platform = require('./platform');
  const kernel = require('./microvm/kernel');
  const plan = require('./microvm/plan');
  const initramfs = require('./microvm/initramfs');
  const hostcpu = require('./microvm/hostcpu');
  const qemu = platform.findTool('qemu');
  if (!qemu) throw new Error('QEMU is not installed - run "Set up for Docker images" first');
  const ks = kernel.kernelStatus({ fresh: true });
  if (!ks.ok) throw new Error('the probe boots the microVM kernel, which is not installed yet - run "Set up for Docker images" first');
  const manifest = kernel.loadManifest(ks.dir);
  const detected = (await platform.detectAccel(qemu)).available || [];
  const hw = detected.find((a) => a !== 'tcg') || null;
  let v3Model = null;
  if (hw === 'whpx') {
    try { v3Model = hostcpu.whpxCpuModel(await hostcpu.probeWindowsCpuFeatures()); } catch (e) { v3Model = null; }
  }
  let list = candidates({ accel: hw, v3Model: v3Model, tcg: opts.tcg !== false });
  if (Array.isArray(opts.only) && opts.only.length) list = list.filter((c) => opts.only.indexOf(c.id) !== -1);
  const key = keyNow();
  t.step('Probing this PC: ' + list.length + ' test boot' + (list.length === 1 ? '' : 's') + ' (' + key.cpu + ', ' + (key.qemuVersion || 'QEMU') + ')...');
  if (!hw) t.log('No hardware accelerator was found (' + (platform.IS_WIN ? 'Windows Hypervisor Platform' : 'KVM/HVF') + '): only TCG is tried.');
  const workDir = path.join(CFG.runDir, 'host-probe');
  fs.mkdirSync(workDir, { recursive: true });
  const initrd = path.join(workDir, 'probe.initrd');
  fs.writeFileSync(initrd, await initramfs.buildInitArchive({ kernelDir: ks.dir, manifest: manifest }));
  const spec = plan.buildSpec({}, { entrypoint: ['/.devbox/busybox', 'sh', '-c', probeScript()], net: false, rng: false });
  const results = [];
  try {
    for (const c of list) {
      t.step('Test boot: ' + c.label + '...');
      const r = await bootOnce(c, { qemu, plan, ks, manifest, initrd, spec, workDir, timeoutS: c.accel === 'tcg' ? (opts.tcgTimeoutS || 240) : (opts.timeoutS || 60) });
      results.push(r);
      t.log((r.ok ? 'PASS  ' : 'FAIL  ') + c.label + ': ' + (r.ok
        ? 'booted and ran the test in ' + (r.bootMs / 1000).toFixed(1) + ' s; CPU flags: ' + (r.flags.join(' ') || 'none of interest')
        : r.error));
      if (opts.quick && r.ok) break;
    }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* busy: next probe */ }
  }
  const b = pickBest(results);
  const out = {
    version: PROBE_VERSION, probedAt: new Date().toISOString(), key: key, hardwareAccel: hw,
    results: results, best: b ? pick(b, ['id', 'label', 'accel', 'machine', 'cpu', 'accelOpts', 'bootMs', 'flags']) : null,
  };
  const tmp = file() + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
  fs.renameSync(tmp, file());
  cache = null;
  // the microVM engine's host facts (CPU model, TSC) depend on the setting: measure them again
  try { for (const f of fs.readdirSync(path.dirname(CFG.hostFactsFile))) if (/^host(-[a-z0-9]+)?\.json$/i.test(f)) fs.rmSync(path.join(path.dirname(CFG.hostFactsFile), f), { force: true }); } catch (e) { /* none yet */ }
  t.log('Best: ' + summary(out));
  return out;
}

function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k] === undefined ? null : o[k]; return r; }

// ---------------------------------------------------------------------------
// the task (POST /api/host/probe, the setup's probe step)
// ---------------------------------------------------------------------------
async function validateProbe(body) {
  body = body || {};
  const platform = require('./platform');
  const { conflict, badRequest, toBool } = require('./util');
  // the input first (a 400), then this PC's state (a 409)
  let only;
  if (body.only !== undefined && body.only !== null && body.only !== '') {
    only = (Array.isArray(body.only) ? body.only : String(body.only).split(',')).map((s) => String(s).trim()).filter(Boolean);
    const known = candidates({ accel: 'whpx', v3Model: 'x' }).concat(candidates({ accel: 'kvm' })).map((c) => c.id);
    const bad = only.filter((id) => known.indexOf(id) === -1);
    if (bad.length) throw badRequest('unknown candidate(s): ' + bad.join(', ') + ' - known: ' + Array.from(new Set(known)).join(', '));
  }
  const a = { quick: toBool(body.quick, false), tcg: toBool(body.tcg, true), only: only };
  if (!platform.findTool('qemu')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  if (!require('./microvm/kernel').kernelStatus().ok) {
    throw conflict('the probe boots the microVM kernel, which is not installed - run "Set up for Docker images" first', 'NO_KERNEL');
  }
  require('./tasks').assertFree('qemu');   // QEMU is being installed
  return a;
}

// The probe, then the microVM engine's host facts again (its CPU model and
// TSC frequency follow the probe). -> {best, summary, results}
async function opProbe(t, a) {
  const r = await probe(t, a || {});
  try {
    const kernel = require('./microvm/kernel');
    const ks = kernel.kernelStatus();
    if (ks.ok) await require('./microvm/plan').hostDefaults({ kernelDir: ks.dir, manifest: kernel.loadManifest(ks.dir), t: t, force: true });
  } catch (e) { t.warn('the microVM host facts could not be measured again: ' + ((e && e.message) || e) + ' - the next container start measures them'); }
  return { best: r.best, summary: summary(r), probedAt: r.probedAt, results: r.results.map((x) => pick(x, ['id', 'label', 'ok', 'bootMs', 'workS', 'flags', 'error'])) };
}

// For /api/state and the setup card: small, from the cached file.
function state() {
  const r = read();
  const b = best();
  return { probed: !!r, current: !!b, best: b, summary: r ? summary(r) : null, probedAt: r ? r.probedAt : null, hardwareAccel: r ? r.hardwareAccel || null : null };
}

// One test boot. Never throws: a failure is a result.
async function bootOnce(c, x) {
  const { startVm, qemuErrorLines } = require('./microvm/vmrun');
  const monitor = require('./monitor');
  const vm = require('./vm');
  const res = { id: c.id, label: c.label, accel: c.accel, machine: c.machine, cpu: c.cpu, accelOpts: c.accelOpts, ok: false, bootMs: null, workS: null, flags: [], error: null };
  const dir = path.join(x.workDir, c.id);
  let h = null, watch = null, why = null;
  try {
    const ep = await vm.runtimeEndpoints('_probe');
    const p = x.plan.planRun({
      kernelDir: x.ks.dir, manifest: x.manifest, initrd: x.initrd, runDir: dir, spec: x.spec, name: 'devbox-probe-' + c.id,
      machine: c.machine, accel: c.accel, accelFallback: false, cpuModel: c.cpu || undefined, whpxOpts: c.accel === 'whpx' ? c.accelOpts : undefined,
      cpus: 2, memMB: 256, console: ep.serial, monitor: ep.monitor,
    });
    h = await startVm({ qemu: x.qemu, args: p.args, console: ep.serial, timeoutMs: x.timeoutS * 1000 });
    // a panicked kernel or a hypervisor fault never finishes: end it at once
    watch = setInterval(async () => {
      if (why) return;
      if (/Kernel panic - not syncing/.test(h.output())) { why = 'the guest kernel panicked: ' + panicLine(h.output()); h.kill(); return; }
      const s = await monitor.queryStatus(ep.monitor, 1500).catch(() => null);
      if (s && !s.running && s.status === 'paused') { why = 'the hypervisor stopped the guest (VM status: paused' + (s.reason ? ', ' + s.reason : '') + ')'; h.kill(); }
    }, 1500);
    const r = await h.done;
    const out = fs.existsSync(p.logs.stdout) ? fs.readFileSync(p.logs.stdout, 'utf8') : '';
    const parsed = parseProbeOutput(out);
    res.flags = parsed.flags;
    res.workS = parsed.workS;
    res.bootMs = r.timings.exitMarkerMs !== null ? r.timings.exitMarkerMs : r.timings.qemuExitMs;
    if (why) res.error = why;
    else if (r.exitCode === null) {
      const qe = r.stderr ? qemuErrorLines(r.stderr).filter((l) => !/warning/i.test(l)).slice(-2).join(' | ') : '';
      res.error = qe ? 'QEMU: ' + qe : (r.timings.qemuExitMs >= x.timeoutS * 1000 - 500 ? 'no result within ' + x.timeoutS + ' s' : 'the guest stopped without a result');
    } else if (!parsed.ok) res.error = parsed.problems.join('; ');
    else res.ok = true;
    if (!res.ok && parsed.dmesg.length) res.dmesg = parsed.dmesg;
  } catch (e) {
    res.error = String((e && e.message) || e);
    if (h) h.kill();
  } finally {
    if (watch) clearInterval(watch);
  }
  return res;
}

function panicLine(text) {
  const m = /Kernel panic - not syncing:?[^\n]*/.exec(String(text || ''));
  const rip = /RIP: [^\n]*/.exec(String(text || ''));
  return (m ? m[0].trim() : 'Kernel panic') + (rip ? ' (' + rip[0].trim() + ')' : '');
}

module.exports = {
  probe, read, best, keyNow, sameKey, invalidate, candidates, probeScript, parseProbeOutput, pickBest, summary, file,
  validateProbe, opProbe, state,
  EXPECT, PROBE_VERSION, V2, HOST_NOXSAVE,
};
