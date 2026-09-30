'use strict';
/*
 * Host CPU facts the microVM engine needs under WHPX (Windows):
 *
 * 1. CPU model. With WHPX and QEMU's default model the guest lacks SSSE3,
 *    SSE4.1/4.2 and POPCNT (not even x86-64-v2), AES and AVX; "-cpu host"
 *    and "-cpu max" abort with "WHPX: Unexpected VP exit code 4", and
 *    "Haswell-noTSX" hangs. qemu64 plus explicit flags works: v2 always,
 *    v3 + AES when the host has AVX2, +rdrand when the host has RDRAND
 *    (then random.trust_cpu=on seeds the guest CRNG at once; otherwise the
 *    first getrandom() blocks ~1.4 s unless a virtio-rng device is present).
 *    Features come from IsProcessorFeaturePresent (kernel32) via PowerShell.
 *
 * 2. TSC frequency. The microvm machine has no HPET / ACPI PM timer, so under
 *    WHPX the kernel cannot calibrate the TSC and hangs at boot unless it is
 *    told the frequency (tsc_early_khz=). Best source: a one-off q35 boot's
 *    "tsc: Refined TSC clocksource calibration: 2298.664 MHz" (cache it);
 *    fallback: the registry's "~MHz" (nominal, ~0.02% off -> ~15 s/day drift).
 *
 * Exports: PF, whpxCpuModel(features), parseTscKhz(dmesg),
 *          probeWindowsCpuFeatures() -> Promise<{ssse3, sse41, sse42, avx, avx2, avx512f, rdrand}>,
 *          windowsNominalMhz() -> Promise<number|null>
 */
const util = require('../util');

// PF_* constants for IsProcessorFeaturePresent
const PF = { rdrand: 28, ssse3: 36, sse41: 37, sse42: 38, avx: 39, avx2: 40, avx512f: 41 };

const V2 = ['ssse3', 'sse4.1', 'sse4.2', 'popcnt'];
const V3 = ['aes', 'pclmulqdq', 'xsave', 'avx', 'fma', 'f16c', 'movbe']; // avx2/bmi1/bmi2 come through already

// features: result of probeWindowsCpuFeatures (unknown -> default model)
function whpxCpuModel(features) {
  if (!features || !features.sse42 || !features.ssse3) return null; // leave QEMU's default
  const flags = V2.slice();
  if (features.avx2) flags.push(...V3);
  if (features.rdrand) flags.push('rdrand');
  return 'qemu64,' + flags.map((f) => '+' + f).join(',');
}

function parseTscKhz(text) {
  const s = String(text || '');
  let m = /tsc: Refined TSC clocksource calibration: (\d+)\.(\d+) MHz/.exec(s);
  if (!m) m = /tsc: Detected (\d+)\.(\d+) MHz processor/.exec(s);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000 + parseInt((m[2] + '000').slice(0, 3), 10);
}

// stdout of a successful run, else null (util.run: the app's one runner)
async function run(cmd, args, timeoutMs) {
  const r = await util.run(cmd, args, { timeout: timeoutMs || 20000 });
  return r.code === 0 ? r.stdout : null;
}

async function probeWindowsCpuFeatures() {
  if (process.platform !== 'win32') return null;
  const ps = "$s='[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(uint f);';" +
    '$k=Add-Type -MemberDefinition $s -Name K32 -Namespace DevboxCpuProbe -PassThru;' +
    Object.entries(PF).map(([k, v]) => "'" + k + "='+$k::IsProcessorFeaturePresent(" + v + ')').join(';');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!out) return null;
  const res = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\w+)=(True|False)$/.exec(line.trim());
    if (m) res[m[1]] = m[2] === 'True';
  }
  return Object.keys(res).length ? res : null;
}

async function windowsNominalMhz() {
  if (process.platform !== 'win32') return null;
  const out = await run('reg.exe', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0', '/v', '~MHz']);
  const m = out && /~MHz\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  return m ? parseInt(m[1], 16) : null;
}

module.exports = { PF, whpxCpuModel, parseTscKhz, probeWindowsCpuFeatures, windowsNominalMhz };
