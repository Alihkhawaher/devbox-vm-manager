'use strict';
/*
 * Which engine can run an image, and why not (microVM spec section 14).
 * Pure and table-driven: no I/O, no clock; callers pass what they know.
 *
 * THE RULE THAT MATTERS: the server never switches engine on its own once a
 * task has started. A rule that needs the image (its config, its size, its
 * files) can only SUGGEST Docker-in-VM: the run ends with
 * `fallback: {engine: 'docker-vm', code, reason}` on the container record,
 * and the client decides (GUI: a confirm modal with the cost; MCP
 * deploy_image engine=auto: follows; run_image: reports it). Only a rule
 * that needs nothing but the request itself (privileged, host network, a
 * restart policy...) may pick Docker-in-VM up front, and only when the
 * caller asked for engine "auto" - the reply then says so and why.
 *
 *   requestRules(body)            -> null | {engine:'docker-vm', code, reason}
 *                                    | {error: {status, code, message}}
 *   imageRules(o)                 -> [finding]   before flatten (config + manifest)
 *   rootfsRules(o)                -> [finding]   after flatten (exact size, files)
 *   decide(findings, engine)      -> {fallback | null, warnings: [text]}
 *   classify(o)                   -> null | {class, offer, reason, memMB?}
 *                                    (why a container that just ended failed)
 *   memCapMB(cfg)                 -> the "too big for a microVM" line
 *   entryArgv0(runtime, over)     -> the program the container would start
 *
 * finding = {level: 'fallback' | 'large' | 'warning', code, reason}
 *   fallback  Docker-in-VM is needed whatever the caller chose
 *   large     too big to hold in RAM comfortably: engine auto suggests
 *             Docker-in-VM, engine microvm runs it with a warning. RAM ROOT
 *             ONLY (o.rootfs 'ram', the default of these pure functions):
 *             a disk root keeps the image on its disk, so its size says
 *             nothing about RAM - the engine checks free disk instead
 *   warning   runs, with a note
 */

const SYSTEMD_INITS = ['/sbin/init', '/usr/sbin/init', '/lib/systemd/systemd', '/usr/lib/systemd/systemd', '/bin/systemd'];
const DOCKER_SOCKS = ['/var/run/docker.sock', '/run/docker.sock'];
// unpacked / compressed measured 2.26 (alpine) to 2.82 (python): 3 is safe
const UNPACK_RATIO = 3;

function memCapMB(cfg) {
  cfg = cfg || {};
  if (cfg.microvmMemCapMB) return cfg.microvmMemCapMB;
  return Math.min(2048, Math.floor((cfg.maxMem || 4096) / 2));
}

const truthy = (v) => v === true || v === 1 || v === 'true' || v === '1' || v === 'yes' || v === 'on';
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : !!v && v !== 'false' && v !== '0');

// Targets named by volume entries of any shape (strings "src:/target[:opt]"
// or objects {target|guestPath}); used only for the docker.sock rule.
function volumeTargets(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (v && typeof v === 'object') { if (v.target || v.guestPath) out.push(String(v.target || v.guestPath)); continue; }
    const s = String(v || '');
    const i = s.lastIndexOf(':/');
    if (i >= 0) out.push(s.slice(i + 1).split(':')[0]);
  }
  return out.map((t) => t.replace(/\/+$/, ''));
}

// Decisions that need nothing but the request (spec 14.1).
function requestRules(body) {
  body = body || {};
  if (truthy(body.tty) || truthy(body.interactive) || truthy(body.it)) {
    return { error: { status: 400, code: 'NOT_SUPPORTED', message: 'interactive containers (-it, a terminal) are not supported by either engine here - run a command or a server instead' } };
  }
  const why = [];
  if (truthy(body.privileged)) why.push(['PRIVILEGED', 'privileged containers need the Docker engine']);
  if (truthy(body.hostNetwork)) why.push(['HOST_NETWORK', 'host networking needs the Docker engine']);
  if (nonEmpty(body.devices)) why.push(['DEVICES', 'device access needs the Docker engine']);
  if (nonEmpty(body.compose)) why.push(['COMPOSE', 'compose stacks run on the Docker engine']);
  const rp = body.restartPolicy === undefined || body.restartPolicy === null ? '' : String(body.restartPolicy);
  if (rp && rp !== 'no') why.push(['RESTART_POLICY', 'restart policies ("' + rp + '") need the Docker engine (microVM restart policies are not available yet)']);
  if (volumeTargets(body.volumes).some((t) => DOCKER_SOCKS.includes(t))) why.push(['DOCKER_SOCKET', 'the image wants the Docker socket, which only the Docker engine has']);
  if (!why.length) return null;
  return { engine: 'docker-vm', code: why[0][0], reason: why.map((w) => w[1]).join('; ') };
}

// The program a container starts: argv[0] of ENTRYPOINT + CMD (with the
// request's overrides, Docker's rules: --entrypoint drops the image CMD).
function entryArgv0(runtime, over) {
  runtime = runtime || {};
  over = over || {};
  const has = (v) => v !== undefined && v !== null;
  const ep = has(over.entrypoint) ? over.entrypoint : (runtime.entrypoint || []);
  const cmd = has(over.cmd) ? over.cmd : (has(over.entrypoint) ? [] : (runtime.cmd || []));
  const argv = [].concat(ep || [], cmd || []);
  return argv.length ? String(argv[0]) : null;
}

const mb = (bytes) => Math.round(bytes / 1048576);

// Before flatten: the config and the compressed size (spec 14.2).
// o: {runtime (registry.runtimeConfig), compressedBytes, capMB,
//     recommendedMemMB (fn: bytes -> MB), over: {entrypoint, cmd},
//     rootfs ('ram' default | 'disk': no size rule)}
function imageRules(o) {
  const f = [];
  const rt = o.runtime || {};
  const argv0 = entryArgv0(rt, o.over);
  if (argv0 && SYSTEMD_INITS.includes(argv0)) {
    f.push({ level: 'fallback', code: 'NEEDS_PID1', reason: 'the image boots ' + argv0 + ' (systemd), which must run as PID 1 with full privileges' });
  }
  if ((rt.volumes || []).some((v) => DOCKER_SOCKS.includes(String(v).replace(/\/+$/, '')))) {
    f.push({ level: 'fallback', code: 'DOCKER_SOCKET', reason: 'the image declares the Docker socket as a volume, which only the Docker engine has' });
  }
  // s6-overlay v3 ("/init") must be PID 1; its images set S6_* variables
  if (argv0 === '/init' && (rt.env || []).some((e) => /^S6_[A-Z_]+=/.test(String(e)))) {
    f.push({ level: 'fallback', code: 'NEEDS_PID1', reason: 'the image uses s6-overlay (/init), which must run as PID 1' });
  }
  if (o.rootfs !== 'disk' && o.compressedBytes && o.recommendedMemMB && o.capMB) {
    const est = o.recommendedMemMB(UNPACK_RATIO * o.compressedBytes);
    if (est > o.capMB) {
      f.push({
        level: 'large', code: 'LARGE_IMAGE',
        reason: 'large image (about ' + mb(UNPACK_RATIO * o.compressedBytes) + ' MB unpacked; a microVM would hold it in about ' + est + ' MB of RAM, above the ' + o.capMB + ' MB limit)',
      });
    }
  }
  return f;
}

// After flatten: the exact initrd size and what is in the tree (spec 14.3).
// o: {runtime, over, initrdBytes, capMB, recommendedMemMB, facts: {s6},
//     warnings: [flatten warnings], rootfs ('ram' default | 'disk')}
function rootfsRules(o) {
  const f = [];
  const argv0 = entryArgv0(o.runtime, o.over);
  if (argv0 === '/init' && o.facts && o.facts.s6) {
    f.push({ level: 'fallback', code: 'NEEDS_PID1', reason: 'the image uses s6-overlay (/init), which must run as PID 1' });
  }
  if (o.rootfs !== 'disk' && o.initrdBytes && o.recommendedMemMB && o.capMB) {
    const need = o.recommendedMemMB(o.initrdBytes);
    if (need > o.capMB) {
      f.push({ level: 'large', code: 'LARGE_IMAGE', reason: 'large image (' + mb(o.initrdBytes) + ' MB held in RAM; it needs about ' + need + ' MB, above the ' + o.capMB + ' MB limit)' });
    }
  }
  if ((o.warnings || []).some((w) => /security\.capability/.test(String(w)))) {
    f.push({ level: 'warning', code: 'FILE_CAPS', reason: 'file capabilities were dropped (the app runs as root in its own VM, and low ports are open to every user there)' });
  }
  return f;
}

// engine: 'auto' | 'microvm'
function decide(findings, engine) {
  const out = { fallback: null, warnings: [] };
  for (const x of findings || []) {
    if (x.level === 'fallback' || (x.level === 'large' && engine !== 'microvm')) {
      if (!out.fallback) out.fallback = { engine: 'docker-vm', code: x.code, reason: x.reason };
    } else {
      out.warnings.push(x.level === 'large' ? x.reason + ' - it may be slow to start' : x.reason);
    }
  }
  return out;
}

// Why a container that ended with a non-zero code failed (spec 14.4). Runs
// for an end before READY or within 10 s of it - and, for running out of
// memory, at ANY time (cr-3): a disk root has little RAM by default, and a
// database or JVM killed by the kernel an hour in deserves the same "run it
// with more memory" offer as one that died at once.
// o: {exitCode, beforeReady, sinceReadyMs, console (text), stderrTail (text),
//     initMessages: [text], exitReason, memMB, recommendedMemMB (number),
//     oomKills (init's __DEVBOX_OOM: processes the kernel killed for lack
//     of memory during the boot)}
// What the app itself prints when it runs out of memory: the JVM, Node's
// heap, Go's runtime, InnoDB's buffer pool, Python, C++.
const APP_OOM_RE = /java\.lang\.OutOfMemoryError|JavaScript heap out of memory|fatal error: runtime: out of memory|Cannot allocate memory for the buffer pool|\bMemoryError\b|std::bad_alloc/;
const KERNEL_OOM_RE = /Initramfs unpacking failed|System is deadlocked on memory|Out of memory: Killed process|Kernel panic - not syncing: Out of memory/;
const outOfMemory = (o) => o.oomKills > 0 || KERNEL_OOM_RE.test(o.console || '') || APP_OOM_RE.test(o.stderrTail || '');
const CLASSES = [
  {
    cls: 'NEEDS_MEMORY', offer: 'memory',
    test: outOfMemory,
    reason: (o) => 'the VM ran out of memory' + (o.memMB ? ' at ' + o.memMB + ' MB' : '') +
      (o.oomKills > 0 ? ' (the kernel killed ' + o.oomKills + ' process' + (o.oomKills === 1 ? '' : 'es') + ')' : ''),
  },
  { cls: 'NEEDS_PID1', offer: 'docker-vm', test: (o) => /can only run as pid 1/i.test(o.stderrTail || ''), reason: () => 'the app must run as PID 1 (s6-overlay or a similar init)' },
  {
    cls: 'NESTED_RUNTIME', offer: 'docker-vm',
    test: (o) => /pivot_root|failed to create shim|cgroup.*(denied|read-only|not supported)|mount: permission denied/i.test(o.stderrTail || ''),
    reason: () => 'the app runs containers itself and needs a full, privileged Docker engine',
  },
  { cls: 'CPU_FEATURES', offer: null, test: (o) => o.exitCode === 132, reason: () => 'illegal instruction: the app needs a CPU feature the VM does not offer' },
  { cls: 'WRONG_ARCH', offer: null, test: (o) => /Exec format error/i.test((o.stderrTail || '') + '\n' + (o.initMessages || []).join('\n')), reason: () => 'the program is not built for x86-64 (exec format error)' },
  {
    cls: 'USER_ERROR', offer: null,
    test: (o) => (o.exitCode === 126 || o.exitCode === 127),
    reason: (o) => o.exitReason || (o.exitCode === 127 ? 'command not found' : 'command not executable or user not found'),
  },
  {
    cls: 'SETUP_ERROR', offer: null,
    test: (o) => o.exitCode === 125 && (o.initMessages || []).some((m) => /volume|copy-in|shared folder/i.test(m)),
    reason: (o) => o.exitReason || 'the container could not be set up',
  },
  { cls: 'ENGINE_ERROR', offer: 'docker-vm', test: (o) => /Kernel panic - not syncing/.test(o.console || ''), reason: () => 'the microVM kernel stopped (a panic) - please report it' },
];

function classify(o) {
  o = o || {};
  if (o.exitCode === 0 || o.exitCode === null || o.exitCode === undefined) return null;
  const early = o.beforeReady || (o.sinceReadyMs >= 0 && o.sinceReadyMs < 10000);
  if (!early && !outOfMemory(o)) return null;
  for (const c of CLASSES) {
    if (!c.test(o)) continue;
    const r = { class: c.cls, offer: c.offer, reason: c.reason(o) };
    if (c.cls === 'NEEDS_MEMORY' && o.recommendedMemMB) r.memMB = Math.ceil((o.recommendedMemMB * 1.5) / 16) * 16;
    return r;
  }
  return null;
}

module.exports = {
  requestRules, imageRules, rootfsRules, decide, classify, memCapMB, entryArgv0, volumeTargets,
  SYSTEMD_INITS, UNPACK_RATIO,
};
