'use strict';
/*
 * MCP tools for Docker images that run WITHOUT Docker (microVM spec section
 * 13): each image runs as its own small headless VM. The manager pulls the
 * image from its registry, writes it once into a read-only image disk shared
 * by every container of that image (each container gets its own
 * copy-on-write writable layer on top, kept until the container is removed)
 * and boots it with a tiny Linux kernel whose init runs the image's
 * entrypoint - no Docker Desktop, WSL, Hyper-V or Docker Engine anywhere.
 * rootfs="ram" (opt-in, only when the user asks) holds the whole image in
 * guest RAM instead and resets it at every start (SPEC-diskroot section 9).
 *
 *   run_image         run one image: a server (returns its URLs) or a
 *                     one-shot command (wait_for="exit": output + exit code)
 *   stop_image        stop a container (graceful stop, KILL after the
 *                     timeout - the manager's ack protocol, spec 7.4)
 *   image_logs        its stdout / stderr / console / QEMU output
 *   list_containers   every container: status, exit code, URLs
 *   remove_container  delete a container record, its logs and its ports
 *   pull_image        fetch an image into the cache ahead of time
 *   list_images       the image cache, sizes, the Docker Hub pull quota
 *   remove_image      delete a cached image
 * plus runImageFlow(), which deploy_image (tools.js) shares for its microVM
 * engine.
 *
 * The same THIN-client rules as tools.js: everything goes through the
 * manager's API (lib/microvm/routes.js); the manager owns the registry, the
 * locks and the tasks, and the GUI shows what Claude is doing. The builders
 * get createTools' helpers as a bag (h) instead of requiring tools.js, which
 * requires this file.
 *
 * HOST FOLDERS in volumes become LIVE shared folders (the manager's 9P
 * server, SPEC-shares.md): the guest reads AND writes them. They pass the
 * same guard as upload/download (tools.guardLocalPath) - read-write shares
 * as write targets, read-only shares and copy_in sources as read sources -
 * before the manager is even asked: one prompt-injected share of ~/.ssh or
 * the manager's data folder would hand whatever runs in the guest the keys
 * to every VM.
 *
 * Requiring this module has no side effects.
 */
const fs = require('fs');
const { ToolError } = require('./protocol');
const { OutputCapture, networkPathError } = require('../util');
const margs = require('../microvm/args');

const MiB = 1048576;
// The manager's log API returns at most this many lines (and at most the
// last 256 KB of a stream); run_image asks for all of it and caps the text
// like exec does (the first 20 KB + the last 80 KB).
const LOG_TAIL_MAX = 5000;
const TERMINAL = ['exited', 'error'];
// A container's status is polled more often than a task: a one-shot command
// often ends a second after it started, and the model waits on it.
const STATUS_POLL_MS = 500;
// On top of the stop timeout: the guest's drain/sync/unmount, the KILL
// grace period and the QEMU quit (spec 7.4 steps 3-4).
const STOP_MARGIN_S = 45;

// The root filesystem choice of run_image and deploy_image (one text, so the
// model reads the same trade-off in both). Omitted, the manager decides:
// "disk" unless the user changed the default in its Settings.
const ROOTFS_PARAM = {
  type: 'string', enum: ['disk', 'ram'],
  description: 'Root filesystem. "disk" (the default): the image stays on a read-only disk shared by its containers; the container gets about ' +
    '128 MB of RAM whatever the image size, and its changes outside volumes persist across restarts until the container is removed. "ram": the ' +
    'whole image is held in memory (about 2 x the image + 90 MB of RAM) and resets at every start - use it only when the user asks for it. ' +
    'Omitted: the manager\'s default (disk unless the user changed it).',
};
// What happens to a container's own files, per root filesystem.
const FILES_NOTE = {
  disk: 'its files outside volumes are kept on its own writable layer across stops and restarts, and go when the container is removed (remove_container)',
  ram: 'its root filesystem lives in RAM (rootfs="ram"): changes outside named volumes and shared folders are gone after it stops',
};
// The root filesystem of a record or summary: what it was started with,
// else what it is set to. A record without one (made before disk roots
// existed and never started since) counts as disk: that is what it gets.
function rootfsOf(r) {
  const rt = (r && r.runtime) || null;
  const v = (rt && rt.rootfs) || (r && r.rootfs);
  return v === 'ram' ? 'ram' : 'disk';
}

const secs = (ms) => Math.round(ms / 100) / 10;
// MB with one decimal - three below 1 MB, so a tiny image (hello-world is
// a few KB) does not read as 0
function mb(bytes) {
  if (typeof bytes !== 'number' || !(bytes >= 0)) return null;
  const v = bytes / MiB;
  return v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000;
}
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : undefined);

// ---------------------------------------------------------------------------
// pure helpers (exported for the tests)
// ---------------------------------------------------------------------------
// An absolute folder of THIS PC. On Windows "/x" is not one: Node would put
// it on the current drive, which nobody can predict from here. A UNC path
// (\\server\share) is not one either: it is another computer, and opening
// it sends the user's Windows sign-in there (sec-1) - only a drive letter
// (or its "\\?\C:\" long form) counts.
function isHostAbsolute(p, platformName) {
  const s = String(p || '');
  if ((platformName || process.platform) === 'win32') return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[?.][\\/][A-Za-z]:[\\/]/.test(s);
  return s.charAt(0) === '/';
}

// run_image / deploy_image ports as structured mappings (sec-9). A raw
// string reached the manager as it was, and an explicit bind there beats
// the lan flag: "0.0.0.0:8080:80", "lan:8080:80" or "8080:80,lan" published
// to the network while lan was false - a Docker habit or a prompt-injected
// port string was enough. Here LAN exposure comes from `lan` alone:
// such an entry is refused unless lan=true (",local" / 127.0.0.1 keep a
// port on this PC even then).
//   -> [{host, guest, proto, lan}]
function portMappings(list, lan) {
  const out = [];
  for (const raw of list || []) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) continue;
    const pre = /^(lan|local):(.+)$/i.exec(s);
    const body = pre ? pre[2] : s;
    let p;
    try { p = margs.parsePort(body); } catch (e) { throw new ToolError('ports: ' + e.message); }
    // what the TEXT asks for (parsePort folds it into one boolean)
    const wantsLan = (pre && pre[1].toLowerCase() === 'lan') || /^0\.0\.0\.0:/.test(body) || /,\s*lan\s*$/i.test(body);
    const wantsLocal = (pre && pre[1].toLowerCase() === 'local') || /^127\.0\.0\.1:/.test(body) || /,\s*local\s*$/i.test(body);
    if (wantsLan && !lan) {
      throw new ToolError('ports: "' + s + '" would make the port reachable from other devices on the network - write it as "' + p.hostPort + ':' + p.guestPort +
        (p.proto === 'udp' ? '/udp' : '') + '" (this PC only), and set lan=true only when the user asked for network access');
    }
    out.push({ host: p.hostPort, guest: p.guestPort, proto: p.proto, lan: !!lan && !wantsLocal });
  }
  return out;
}

// Docker-compatible exit codes (spec 6.3) in words, for a non-zero code.
function exitMeaning(code) {
  if (code === null || code === undefined) return 'no exit status (stopped before the app started, or stopped outside the manager)';
  if (code === 0) return undefined;
  if (code === 125) return 'the engine failed (see exit_reason)';
  if (code === 126) return 'the command is not executable, or the user does not exist';
  if (code === 127) return 'command not found';
  const sig = { 130: 'SIGINT', 132: 'SIGILL (the CPU lacks an instruction the app needs)', 134: 'SIGABRT', 137: 'SIGKILL', 139: 'SIGSEGV (crashed)', 143: 'SIGTERM' }[code];
  if (sig) return 'killed by ' + sig;
  if (code > 128 && code < 160) return 'killed by signal ' + (code - 128);
  return 'the app exited with an error';
}

// volumes / copy_in of run_image (and deploy_image's microVM engine), checked
// and rewritten with absolute folders. guard(abs, label, mode, isDir) is
// tools.guardLocalPath bound to this PC's protected paths.
//   -> {volumes: [text], copyIn: [text], hostFolders: [{hostDir, target, readonly}], named: [...]}
function prepareMounts(volumes, copyIn, guard, platformName) {
  const out = { volumes: [], copyIn: [], hostFolders: [], named: [] };
  const hostDir = (dir, spec, label, mode) => {
    const netWhy = networkPathError(dir, platformName);
    if (netWhy) throw new ToolError(label + ' "' + spec + '": ' + netWhy);
    if (!isHostAbsolute(dir, platformName)) {
      throw new ToolError(label + ' "' + spec + '": the folder on this PC must be an absolute path such as ' +
        ((platformName || process.platform) === 'win32' ? 'C:\\Users\\me\\project' : '/home/me/project') +
        ' (a relative or ~ path would depend on where this server was started)' + (label === 'volumes' ? '; a named volume is written name:/path' : ''));
    }
    let st = null;
    try { st = fs.statSync(dir); } catch (e) { /* reported below */ }
    if (!st) throw new ToolError(label + ' "' + spec + '": there is no folder ' + dir + ' on this PC');
    if (!st.isDirectory()) throw new ToolError(label + ' "' + spec + '": ' + dir + ' is a file - only folders can be ' + (label === 'volumes' ? 'shared' : 'copied in'));
    return guard(dir, label, mode, true);
  };
  for (const spec of volumes || []) {
    let v;
    try { v = margs.parseVolume(spec); } catch (e) { throw new ToolError('volumes: ' + e.message); }
    if (v.kind === 'host') {
      // a live share: the guest can write into it unless it is read-only
      const abs = hostDir(v.hostDir, spec, 'volumes', v.readonly ? 'read' : 'write');
      out.hostFolders.push({ hostDir: abs, target: v.target, readonly: v.readonly });
      out.volumes.push(abs + ':' + v.target + (v.readonly ? ':ro' : ''));
    } else {
      out.named.push(v);
      out.volumes.push(String(spec));
    }
  }
  for (const spec of copyIn || []) {
    let ci;
    try { ci = margs.parseCopyIn(spec); } catch (e) { throw new ToolError('copy_in: ' + e.message); }
    const abs = hostDir(ci.hostDir, spec, 'copy_in', 'read');
    out.copyIn.push(abs + ':' + ci.target);
  }
  return out;
}

// run_image's arguments -> the POST /api/container/run body.
//   a: coerced arguments; mounts: prepareMounts(); envList: tools.envList
function runBody(a, mounts, envList, createdBy) {
  const b = { image: String(a.image).trim(), engine: a.engine || 'microvm', createdBy: createdBy, ephemeral: a.ephemeral !== false, lan: !!a.lan };
  if (a.name) b.name = a.name;
  if (a.command) b.cmd = a.command;
  if (a.entrypoint) b.entrypoint = a.entrypoint;
  if (a.env && Object.keys(a.env).length) b.env = envList(a.env);
  // [] publishes nothing; left out, the manager publishes the image's EXPOSE
  // ports. Structured, with the exposure from `lan` only (sec-9).
  if (Array.isArray(a.ports)) b.ports = portMappings(a.ports, !!a.lan);
  if (mounts && mounts.volumes.length) b.volumes = mounts.volumes;
  if (mounts && mounts.copyIn.length) b.copyIn = mounts.copyIn;
  if (a.workdir) b.workdir = a.workdir;
  if (a.user) b.user = a.user;
  if (a.memory_mb !== undefined) b.mem = a.memory_mb;
  // left out, the manager's default applies (disk unless the user changed it)
  if (a.rootfs) b.rootfs = a.rootfs;
  if (a.pull) b.pull = a.pull;
  // The manager deletes an autoRemove container WITH its logs the moment it
  // exits. When this call waits for the exit it reads the output first and
  // removes the container itself; only a detached run hands it to the manager.
  if (a.remove_on_exit && a.wait_for !== 'exit') b.autoRemove = true;
  return b;
}

// Guest ports as URLs (tcp only: a udp port has no URL). lanUrls: tools.lanUrls.
function containerUrls(ports, lanAddrs, lanUrls) {
  return (ports || []).filter((p) => p && p.host && (p.proto || 'tcp') === 'tcp').map((p) => {
    const o = { url: 'http://127.0.0.1:' + p.host, host_port: p.host, container_port: p.guest, lan: !!p.lan, reachable_from: p.lan ? 'this PC and the LAN' : 'this PC only' };
    if (p.lan && lanAddrs && lanUrls) o.lan_urls = lanUrls(p.host, lanAddrs);
    return o;
  });
}

function envNames(env) {
  return (Array.isArray(env) ? env : []).map((e) => String(e).split('=')[0]).filter(Boolean);
}

// A container record (GET /api/containers, /api/container) or an /api/state
// summary -> what the model sees. Env VALUES never appear (they are secrets;
// the API redacts them anyway).
function summarizeContainer(r, lanAddrs, lanUrls) {
  const rt = r.runtime || null;
  const o = {
    id: r.id, name: r.name, image: r.image,
    status: r.status || 'created',
    exit_code: r.exitCode === undefined ? null : r.exitCode,
  };
  if (r.exitCode !== undefined && r.exitCode !== null && r.exitCode !== 0) o.exit_meaning = exitMeaning(r.exitCode);
  if (r.exitReason) o.exit_reason = r.exitReason;
  o.urls = containerUrls(r.ports, lanAddrs, lanUrls);
  const udp = (r.ports || []).filter((p) => p && p.proto === 'udp').map((p) => ({ host_port: p.host, container_port: p.guest, lan: !!p.lan }));
  if (udp.length) o.udp_ports = udp;
  const vols = (r.volumes || []).filter((v) => v && v.name).map((v) => v.name + ':' + v.target + (v.readonly ? ':ro' : ''));
  if (vols.length) o.volumes = vols;
  const shares = (r.shares || []).map((s) => ({ host_path: s.hostPath, guest_path: s.guestPath, read_only: !!s.readOnly }));
  if (shares.length) o.shared_folders = shares;
  o.memory_mb = (rt && rt.memMB) || r.mem || null;
  if (rt && (rt.effectiveAccel || rt.accel)) o.accel = rt.effectiveAccel || rt.accel;
  o.rootfs = rootfsOf(r);
  // QEMU paused it because the disk of this PC is full (summary: the reason;
  // record: {at, reason})
  const paused = r.paused && (typeof r.paused === 'string' ? r.paused : r.paused.reason);
  if (paused) o.paused = paused;
  // the writable layer's size on this PC (disk root): summary or record
  const layer = typeof r.rootDiskBytes === 'number' ? r.rootDiskBytes
    : (r.rootDisk && typeof r.rootDisk.overlayBytes === 'number' ? r.rootDisk.overlayBytes : null);
  if (layer !== null) o.writable_layer_mb = mb(layer);
  if (r.createdBy !== undefined) o.created_by = r.createdBy || null;
  if (r.ephemeral !== undefined) o.ephemeral = !!r.ephemeral;
  if (r.autoRemove) o.remove_on_exit = true;
  if (r.createdAt) o.created_at = r.createdAt;
  o.started_at = r.startedAt || null;
  if (r.endedAt) o.ended_at = r.endedAt;
  const names = envNames(r.env);
  if (names.length) o.env_names = names;
  if (r.busy) o.busy_task = r.busy;
  if (nonEmpty(r.warnings)) o.warnings = r.warnings;
  if (r.fallback) o.fallback = { engine: r.fallback.engine || 'docker-vm', reason: r.fallback.reason || r.fallback.code || null };
  if (r.lastError) o.last_error = typeof r.lastError === 'string' ? r.lastError : r.lastError.message;
  return o;
}

// The "call this next" line for a container (by name when it has one).
function nextFor(ref, status) {
  const q = JSON.stringify(ref);
  if (TERMINAL.indexOf(status) !== -1) {
    return 'image_logs(container=' + q + ') shows its output again (stream="console" for the boot if something went wrong); remove_container(container=' + q + ') deletes it and its logs.';
  }
  return 'image_logs(container=' + q + ') shows its output; stop_image(container=' + q + ') stops it; remove_container(container=' + q + ', force=true) stops and deletes it.';
}

function containerIdOf(start, t) {
  const task = (start && start.task) || {};
  const res = (t && t.result) || {};
  return task.ctr || (start && start.container && start.container.id) || (t && t.ctr) || res.id ||
    (res.container && typeof res.container === 'object' ? res.container.id : null) || null;
}

// The run task's result may carry an output tail (a container that exited
// before READY, or one removed on exit): accept the likely field names.
function resultOutput(res, stream) {
  if (!res) return undefined;
  const v = res[stream] !== undefined ? res[stream] : (res[stream + 'Tail'] !== undefined ? res[stream + 'Tail'] : undefined);
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// the flows
// ---------------------------------------------------------------------------
// GET /api/container?id= -> the record, or null when there is none (removed
// on exit, or never created).
async function getContainer(h, c, id) {
  if (!id) return null;
  try {
    const r = await c.get('/api/container?id=' + enc(id));
    return r && r.container ? r.container : (r && r.id ? r : null);
  } catch (e) {
    if (e && e.status === 404) return null;
    throw h.apiFail(e);
  }
}

async function waitForExit(h, c, id, deadlineMs) {
  const every = Math.max(5, Math.min(STATUS_POLL_MS, h.deps.pollMs || STATUS_POLL_MS));
  for (;;) {
    const rec = await getContainer(h, c, id);
    if (!rec || TERMINAL.indexOf(rec.status) !== -1 || Date.now() >= deadlineMs) return rec;
    await sleep(Math.min(every, Math.max(5, deadlineMs - Date.now())));
  }
}

// One stream, capped like exec: {text, truncated, size}. A stream the
// manager cannot serve (e.g. an older manager) reads as null.
async function readStream(h, c, id, stream, tail) {
  let r;
  try { r = await c.get('/api/container/logs?id=' + enc(id) + '&stream=' + stream + '&tail=' + (tail || LOG_TAIL_MAX)); }
  catch (e) {
    if (e && (e.status === 404 || e.status === 501)) return null;
    throw h.apiFail(e);
  }
  const cap = new OutputCapture(h.OUTPUT_CAP, h.OUTPUT_HEAD_SHARE);
  cap.push(String((r && r.text) || ''));
  return { text: cap.text(), truncated: cap.truncated || !!(r && r.truncated), size: r && typeof r.size === 'number' ? r.size : null };
}

async function removeQuietly(c, id) {
  try {
    const r = await c.post('/api/container/remove', { id: id, force: true });
    return !!r;
  } catch (e) { return false; }
}

// The error for a run that failed: the manager's reason, the guest's own
// init messages, the task log and - when the manager suggested it - the
// Docker-in-VM alternative.
function runFailure(image, t, rec, removed) {
  const fb = (rec && rec.fallback) || (t && t.result && t.result.fallback) || null;
  const lines = [];
  lines.push('running ' + image + ' ' + (fb ? 'as a microVM is not possible: ' : 'failed: ') + ((t && t.error) || (rec && rec.exitReason) || (fb && fb.reason) || 'unknown error'));
  if (rec && rec.exitReason && (!t || String(t.error || '').indexOf(rec.exitReason) === -1)) lines.push('Reason: ' + rec.exitReason);
  const init = (rec && Array.isArray(rec.initMessages) ? rec.initMessages : []).slice(-5);
  if (init.length) lines.push('The guest said:\n' + init.map((m) => '  ' + String(m).slice(0, 300)).join('\n'));
  const log = t && Array.isArray(t.log) ? t.log.slice(-8) : [];
  if (log.length) lines.push('Last log lines:\n' + log.join('\n'));
  if (fb && fb.code === 'NEEDS_MEMORY' && Number.isInteger(fb.memMB)) {
    // spec 14.4: the cheaper fix first - the same microVM with more memory
    lines.push('It ran out of memory: retry with more, run_image(image=' + JSON.stringify(image) + ', memory_mb=' + fb.memMB + ').');
  }
  if (fb) {
    lines.push('It can run with Docker inside a full VM instead' + (fb.reason ? ' (' + fb.reason + ')' : '') +
      ': deploy_image(image=' + JSON.stringify(image) + ', engine="docker-vm") - that creates a full VM (about 2 GB of RAM) and takes several minutes the first time.' +
      (removed ? ' The failed microVM attempt was removed, so its ports are free.' : ''));
  } else if (rec && rec.id) {
    const ref = JSON.stringify(rec.name || rec.id);
    lines.push('The container is kept: image_logs(container=' + ref + ', stream="console") shows the boot; remove_container(container=' + ref + ') deletes it.');
  }
  if (t && t.id) lines.push('(task_id ' + t.id + ')');
  return new ToolError(lines.join('\n'));
}

// The result of a container that ended: its exit code and output.
async function exitedResult(h, c, rec, o) {
  const out = {
    status: 'exited',
    container: { id: rec.id, name: rec.name },
    image: rec.image,
    engine: 'microvm',
    rootfs: rootfsOf(rec),
    exit_code: rec.exitCode === undefined ? null : rec.exitCode,
  };
  const meaning = exitMeaning(out.exit_code);
  if (meaning) out.exit_meaning = meaning;
  if (rec.exitReason) out.exit_reason = rec.exitReason;
  const init = (Array.isArray(rec.initMessages) ? rec.initMessages : []).slice(-5);
  if (init.length && out.exit_code !== 0) out.init_messages = init.map((m) => String(m).slice(0, 300));
  let truncated = false, notServed = false;
  for (const s of ['stdout', 'stderr']) {
    const r = await readStream(h, c, rec.id, s);
    if (!r) { notServed = true; out[s] = resultOutput(o.result, s) || ''; continue; }
    out[s] = r.text;
    if (r.truncated) truncated = true;
  }
  out.truncated = truncated;
  if (truncated) out.output_note = 'the output was longer than 100 KB (or than what the manager keeps for a quick read): the first 20 KB and the last 80 KB are shown; image_logs reads it again';
  if (notServed) out.output_note = 'the manager could not return the full logs; what the run task reported is shown';
  out.duration_s = secs(Date.now() - o.t0);
  if (nonEmpty(rec.warnings)) out.warnings = rec.warnings;
  // ran out of memory (spec 14.4): say how much to ask for
  if (rec.fallback && rec.fallback.code === 'NEEDS_MEMORY' && Number.isInteger(rec.fallback.memMB)) {
    out.memory_hint = 'it ran out of memory - run it again with memory_mb=' + rec.fallback.memMB;
  }
  if (o.removeOnExit) {
    out.removed = await removeQuietly(c, rec.id);
    if (!out.removed) out.note = 'remove_on_exit: removing the container failed - remove_container(container=' + JSON.stringify(rec.name || rec.id) + ') deletes it';
    else out.next = 'The container was removed (remove_on_exit). Named volumes are kept.';
  }
  if (!out.next) out.next = nextFor(rec.name || rec.id, rec.status);
  return out;
}

function runningResult(h, rec, o) {
  const lanAddrs = h.addrs();
  const out = {
    status: 'running',
    container: { id: rec.id, name: rec.name },
    image: rec.image,
    engine: 'microvm',
    urls: containerUrls(rec.ports, lanAddrs, h.lanUrls),
  };
  const udp = (rec.ports || []).filter((p) => p && p.proto === 'udp').map((p) => ({ host_port: p.host, container_port: p.guest, lan: !!p.lan }));
  if (udp.length) out.udp_ports = udp;
  if (!out.urls.length && !udp.length) out.urls_note = 'no ports are published - pass ports (e.g. ["8080:80"]) to reach a server in it';
  if (out.urls.some((u) => u.lan)) out.firewall = 'Windows Firewall may ask the user once to allow QEMU on the network';
  const rt = rec.runtime || {};
  out.memory_mb = rt.memMB || rec.mem || null;
  out.rootfs = rootfsOf(rec);
  if (rt.effectiveAccel || rt.accel) out.accel = rt.effectiveAccel || rt.accel;
  if (out.accel === 'tcg') out.accel_note = 'running without hardware acceleration: slower, and not a security boundary';
  const shares = (rec.shares || []).map((s) => ({ host_path: s.hostPath, guest_path: s.guestPath, read_only: !!s.readOnly }));
  if (shares.length) out.shared_folders = shares;
  if (nonEmpty(rec.warnings)) out.warnings = rec.warnings;
  out.duration_s = secs(Date.now() - o.t0);
  if (o.stillRunningNote) out.note = o.stillRunningNote;
  else out.note = 'it keeps running in its own microVM; ' + FILES_NOTE[out.rootfs] + '.';
  out.next = nextFor(rec.name || rec.id, rec.status);
  return out;
}

// POST /api/container/run and follow it to the point o.waitFor asks for.
//   body: runBody(); o: {image, waitFor: 'ready'|'exit', deadline (ms),
//     timeoutS, removeOnExit, onFallback: 'report' (throw with the
//     docker-vm hint) | 'return' (deploy_image follows automatically)}
// -> {dockerVm: {start (the manager already started the quick deploy) |
//                fallback, reason}}
//    {result: the run_image result}
async function runImageFlow(h, c, body, o) {
  const t0 = Date.now();
  const start = await h.api(c, 'POST', '/api/container/run', body);
  if (start && start.engine === 'docker-vm') return { dockerVm: { start: start, reason: start.reason || null } };
  const task = (start && start.task) || {};
  const id0 = containerIdOf(start, null);
  const t = await h.waitTask(c, task.id, Math.max(0, o.deadline - Date.now()));
  if (!t || t.status === 'running') {
    return {
      result: {
        status: 'running', task_id: task.id || (t && t.id) || null,
        container: id0 ? { id: id0, name: (start.container && start.container.name) || body.name || null } : undefined,
        engine: 'microvm', step: (t && t.step) || null,
        hint: 'still preparing after ' + o.timeoutS + ' s (pulling, unpacking or booting) - it continues in the background; call get_task with this task_id (or list_containers) to follow it',
      },
    };
  }
  const id = containerIdOf(start, t) || id0;
  let rec = await getContainer(h, c, id);
  const fb = (rec && rec.fallback) || (t.result && t.result.fallback) || null;
  // The app itself ended before READY with its own exit code (126 a user
  // that does not exist, 127 a missing command, any code of an app that
  // exits at once): the task failed, but for the caller that is an exit
  // code like any other - only 125 (the engine) and no code are failures.
  if (t.status === 'error' && !fb && rec && TERMINAL.indexOf(rec.status) !== -1 &&
      typeof rec.exitCode === 'number' && rec.exitCode !== 125) {
    return { result: await exitedResult(h, c, rec, { t0: t0, result: null, removeOnExit: !!o.removeOnExit }) };
  }
  if (t.status === 'error' || fb) {
    // a failed attempt Claude made would keep its host ports reserved and
    // block the Docker-in-VM run that is suggested next
    let removed = false;
    if (fb && rec && rec.id) removed = await removeQuietly(c, rec.id);
    if (fb && o.onFallback === 'return') return { dockerVm: { fallback: fb, reason: fb.reason || fb.code || 'the image needs Docker', removed: removed } };
    throw runFailure(o.image, t, rec, removed);
  }
  if (rec && o.waitFor === 'exit' && TERMINAL.indexOf(rec.status) === -1) rec = await waitForExit(h, c, rec.id, o.deadline);
  const ctx = { t0: t0, result: t.result, removeOnExit: !!o.removeOnExit };
  if (!id) {
    // a manager that did not say which container it made: report what it did say
    return {
      result: {
        status: 'done', task_id: t.id, engine: 'microvm', result: t.result || null,
        note: 'the manager did not say which container it created - list_containers shows it',
      },
    };
  }
  if (!rec) {
    // removed on exit by the manager (autoRemove): only the task's result is left
    const res = t.result || {};
    const code = res.exitCode === undefined ? null : res.exitCode;
    const r = {
      status: 'exited', container: { id: id, name: (res.container && res.container.name) || res.name || body.name || null }, image: body.image, engine: 'microvm',
      exit_code: code, exit_meaning: exitMeaning(code), removed: true,
      stdout: resultOutput(res, 'stdout'), stderr: resultOutput(res, 'stderr'),
      duration_s: secs(Date.now() - t0),
      note: 'the container exited and was removed with its logs (remove_on_exit)',
    };
    return { result: r };
  }
  if (TERMINAL.indexOf(rec.status) !== -1) return { result: await exitedResult(h, c, rec, ctx) };
  if (o.waitFor === 'exit') {
    ctx.stillRunningNote = 'still running after ' + o.timeoutS + ' s (wait_for="exit") - it keeps running; image_logs shows its output so far, stop_image stops it';
  }
  return { result: runningResult(h, rec, ctx) };
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------
// h: {deps, conn, api, apiFail, waitTask, taskOutcome, addrs, lanUrls,
//     envList, guard(abs, label, mode, isDir), followDeploy(c, start, a,
//     deadline, extra), OUTPUT_CAP, OUTPUT_HEAD_SHARE, CREATED_BY ("mcp": what the container API calls this server), RO, ann}
function containerTools(h) {
  const RO = h.RO, ann = h.ann;
  const ref = { type: 'string', required: true, minLength: 1, description: 'The container: its name, its id, or a unique start of the id (3 characters or more), as returned by run_image or list_containers.' };
  const tools = [];

  // --------------------------------------------------------------- run_image
  tools.push({
    name: 'run_image',
    title: 'Run a Docker image (microVM)',
    description: 'Run a Docker image WITHOUT Docker: the manager pulls it from its registry and boots it as its own small, isolated VM (a microVM - ' +
      'no Docker Engine, Docker Desktop or WSL). A cached image starts in 1-3 s; the first run of an image adds its download. Use it to run a ' +
      'server from an image or to test a command against an image. Two modes: wait_for="ready" (default) returns as soon as the app has ' +
      'started, with its URLs (http://127.0.0.1:<port>) - the container keeps running; wait_for="exit" waits until the app exits (one-shot ' +
      'commands, e.g. image "python:3-alpine" with command ["python", "-c", "print(1)"]) and returns exit_code, stdout and stderr (capped like exec: ' +
      'the first 20 KB + the last 80 KB). A non-zero exit_code is a normal result. ports are "host:container" such as "8080:80" (or "3000" for the ' +
      'same number); left out, the ports the image declares (EXPOSE) are published, [] publishes nothing. Ports are reachable from THIS PC ONLY ' +
      'unless lan=true (only when the user asks). By default (rootfs="disk") the image stays on a read-only disk and the container needs about ' +
      '128 MB of RAM whatever the image size; its own changes outside volumes persist across restarts and go when it is removed. Keep data that ' +
      'must outlive the container in named volumes ("name:/path", created on first use, seeded from the image, kept after the container is ' +
      'removed). rootfs="ram" holds the whole image in memory and resets it at every start (only when the user asks). A folder of this PC in ' +
      'volumes ("C:\\Users\\me\\project:/app", ":ro" for read-only) is shared LIVE both ways - edits on this PC appear in the container at once, ' +
      'but raise no file-watch events there (dev servers need polling mode) and chmod +x is not stored; every program in the container can ' +
      'use the whole folder with the share\'s access, so share only what it may change (":ro" otherwise). copy_in copies a folder in at every start ' +
      'instead (one way, faster for huge trees; copied over the container\'s files, so a file deleted on this PC stays in a disk-root ' +
      'container). Memory: the default suits most servers; databases and Java apps get more on their own (PostgreSQL 256 MB; MySQL, MariaDB, ' +
      'MongoDB, Java 512 MB; Elasticsearch 1 GB) - pass memory_mb for any other app that needs more than 128 MB. Not supported here: interactive terminals, exec into the container, privileged mode, docker ' +
      'compose - use deploy_image with engine="docker-vm" (or create_vm with docker=true) for those. If it runs longer than timeout_s it ' +
      'returns {status:"running", task_id} (follow it with get_task). Containers are temporary by default (cleanup removes them).',
    params: {
      image: { type: 'string', required: true, minLength: 1, description: 'Image reference, e.g. "nginx:alpine", "python:3-alpine", "ghcr.io/owner/app:1.2". linux/amd64 images only.' },
      name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$', description: 'Container name (letters, digits, ".", "_", "-"). Default: derived from the image, e.g. nginx-3f9c.' },
      command: { type: 'array', items: { type: 'string' }, description: 'Replaces the image\'s CMD, one list entry per argument, e.g. ["sh", "-c", "echo hi; exit 3"].' },
      entrypoint: { type: 'array', items: { type: 'string' }, description: 'Replaces the image\'s ENTRYPOINT (list of arguments; [] clears it).' },
      env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables, e.g. {"POSTGRES_PASSWORD": "secret"}. Values are stored privately and never listed.' },
      ports: { type: 'array', items: { type: 'string' }, description: 'Published ports: "host:container" (e.g. "8080:80"), "port" (same on both sides), "host:container/udp". Omit for the image\'s EXPOSE ports; [] for none.' },
      lan: { type: 'boolean', default: false, description: 'true = the published ports are also reachable from other devices on the network (only when the user asks). false = this PC only.' },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Named volumes "name:/path[:ro]" (persistent ext4 disks, kept after the container is removed), or a folder of this PC "C:\\dir:/path[:ro]" shared live (absolute path).' },
      copy_in: { type: 'array', items: { type: 'string' }, description: 'Folders of this PC copied into the container at every start, "C:\\dir:/path" (one way, at most 512 MB; copied over the container\'s files, so a file deleted on this PC is not deleted in the container).' },
      workdir: { type: 'string', description: 'Working directory in the container (absolute). Default: the image\'s WORKDIR.' },
      user: { type: 'string', description: 'User to run as ("name", "uid" or "uid:gid"). Default: the image\'s USER.' },
      // 96: the manager's own minimum for a disk root (validate.runFields;
      // 128 for rootfs "ram", which the manager checks). A smaller value
      // passed the schema and then failed with a 400
      memory_mb: { type: 'integer', minimum: 96, maximum: 65536, description: 'Guest memory in MB. Default with rootfs="disk": 128 MB (the manager\'s setting) whatever the image size, or more for apps known to need it (PostgreSQL 256; MySQL, MariaDB, MongoDB, Java apps 512; Elasticsearch 1024) - pass it for any other memory-hungry app (databases and JVMs want 512 or more); at least 96, and below 128 only for small apps (a too-small container slows to a crawl rather than failing). With rootfs="ram": at least 128, default computed from the image size (the image is held in RAM).' },
      rootfs: ROOTFS_PARAM,
      pull: { type: 'string', enum: ['missing', 'always', 'never'], default: 'missing', description: '"missing" uses the cached image when there is one, "always" checks the registry for a newer one, "never" fails when it is not cached.' },
      wait_for: { type: 'string', enum: ['ready', 'exit'], default: 'ready', description: '"ready": return once the app has started (servers). "exit": wait until the app exits and return its exit code and output (one-shot commands).' },
      timeout_s: { type: 'integer', default: 300, minimum: 1, maximum: 3600, description: 'Seconds to wait (for the start, and with wait_for="exit" for the exit) before returning {status:"running"} - the container carries on.' },
      remove_on_exit: { type: 'boolean', default: false, description: 'Delete the container (and its logs) once it exits. With wait_for="exit" the output is read first.' },
      ephemeral: { type: 'boolean', default: true, description: 'Mark the container as temporary so cleanup removes it. Set false only when the user wants to keep it.' },
      engine: { type: 'string', enum: ['microvm', 'auto'], default: 'microvm', description: '"microvm" (default): always a microVM; if the image cannot run that way the call fails and says why. "auto": the manager may choose Docker inside a full VM instead when the request or image needs it (slower: minutes, about 2 GB RAM).' },
    },
    annotations: ann({}),
    handler: async (a) => {
      // every folder is checked before the manager is asked
      const mounts = prepareMounts(a.volumes, a.copy_in, h.guard);
      const body = runBody(a, mounts, h.envList, h.CREATED_BY);
      const c = await h.conn();
      const deadline = Date.now() + a.timeout_s * 1000;
      const flow = await runImageFlow(h, c, body, {
        image: body.image, waitFor: a.wait_for, deadline: deadline, timeoutS: a.timeout_s, removeOnExit: a.remove_on_exit, onFallback: 'report',
      });
      if (flow.dockerVm) {
        // engine "auto" and the manager chose Docker-in-VM (it already started that task)
        const d = await h.followDeploy(c, flow.dockerVm.start.task, { image: body.image, name: a.name, wait: true, timeout_s: a.timeout_s }, deadline,
          { engine: 'docker-vm', engine_reason: flow.dockerVm.reason || undefined });
        if (a.wait_for === 'exit' && d.status === 'done') d.note = 'this ran with Docker inside a full VM, where output is read with exec(name="' + d.vm + '", command="docker logs ' + d.container + '")';
        return d;
      }
      return flow.result;
    },
  });

  // -------------------------------------------------------------- stop_image
  tools.push({
    name: 'stop_image',
    title: 'Stop a container',
    description: 'Stop a container started with run_image (or deploy_image\'s microVM engine): the app gets its stop signal (SIGTERM unless the ' +
      'image says otherwise) and timeout_s to exit, then SIGKILL; the guest still flushes and unmounts its volumes, so named-volume data is safe. ' +
      'Returns the exit code and how it stopped. force=true sends SIGKILL at once. The container record and its logs are kept (image_logs still ' +
      'works; remove_container deletes them). With the default disk root its files are kept too, until it is removed; a container run with ' +
      'rootfs="ram" loses everything outside named volumes and shared folders. Stopping a container that has already exited just reports its ' +
      'exit code.',
    params: {
      container: ref,
      timeout_s: { type: 'integer', minimum: 0, maximum: 600, description: 'Seconds the app gets to exit after its stop signal before it is killed. Default: the container\'s stop timeout (10 s).' },
      force: { type: 'boolean', default: false, description: 'Kill the app immediately (SIGKILL) instead of asking it to stop.' },
    },
    // a RAM root filesystem (rootfs "ram") is discarded: not a merely
    // reversible change, and the app is killed after its timeout
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const c = await h.conn();
      const body = { id: a.container, force: a.force };
      if (a.timeout_s !== undefined) body.timeoutS = a.timeout_s;
      let start;
      try { start = await c.post('/api/container/stop', body); }
      catch (e) {
        // already exited (or never started): report instead of failing
        if (e && e.status === 409) {
          const rec = await getContainer(h, c, a.container);
          if (rec && TERMINAL.concat(['created']).indexOf(rec.status) !== -1) {
            return { status: 'done', container: { id: rec.id, name: rec.name }, already_stopped: true, container_status: rec.status, exit_code: rec.exitCode === undefined ? null : rec.exitCode, how: 'already exited' };
          }
        }
        throw h.apiFail(e);
      }
      const waitS = (a.timeout_s === undefined ? 10 : a.timeout_s) + STOP_MARGIN_S;
      const out = h.taskOutcome(await h.waitTask(c, start.task.id, waitS * 1000), 'stopping ' + a.container, waitS);
      if (out.status !== 'done') return Object.assign(out, { container: a.container });
      const res = out.result || {};
      const code = res.exitCode === undefined ? null : res.exitCode;
      // the stop result names the id only: the record says the rest
      let rec = null;
      try { rec = await getContainer(h, c, res.id || a.container); } catch (e) { /* the stop itself succeeded */ }
      const r = {
        status: 'done',
        container: { id: res.id || (rec && rec.id) || null, name: res.name || (rec && rec.name) || null },
        exit_code: code, how: res.how || null,
      };
      if (!r.container.id && !r.container.name) r.container = a.container;
      if (rec && rec.exitReason && code !== 0) r.exit_reason = rec.exitReason;
      const meaning = exitMeaning(code);
      if (meaning && code !== null) r.exit_meaning = meaning;
      if (typeof res.ms === 'number') r.stop_ms = res.ms;
      r.task_id = out.task_id;
      r.next = 'The stopped container is kept with its logs' + (rec && rootfsOf(rec) === 'ram' ? '' : ' and its files') +
        ': image_logs reads the logs, remove_container deletes it. run_image starts a fresh one.';
      return r;
    },
  });

  // -------------------------------------------------------------- image_logs
  tools.push({
    name: 'image_logs',
    title: 'Container output',
    description: 'Read a container\'s output: stdout and stderr of the app (stream="both", the default), "console" (the microVM\'s boot and init ' +
      'messages - read it when a container failed to start or exited with 125/126/127) or "qemu" (the VM process\'s own errors). Returns the ' +
      'last `tail` lines of each stream (each capped at 100 KB: the first 20 KB + the last 80 KB), plus the container\'s status and exit code. ' +
      'previous=true reads the run before the latest restart. Works for running and exited containers.',
    params: {
      container: ref,
      stream: { type: 'string', enum: ['both', 'stdout', 'stderr', 'console', 'qemu'], default: 'both', description: 'Which output: "both" (stdout + stderr), "stdout", "stderr", "console" (boot/init) or "qemu".' },
      tail: { type: 'integer', default: 200, minimum: 1, maximum: LOG_TAIL_MAX, description: 'How many of the last lines of each stream to return.' },
      previous: { type: 'boolean', default: false, description: 'Read the previous run\'s logs (before the last start) instead of the current ones.' },
    },
    annotations: RO,
    handler: async (a) => {
      const c = await h.conn();
      const rec = await getContainer(h, c, a.container);
      if (!rec) throw new ToolError('no container "' + a.container + '" - list_containers shows the containers that exist');
      const out = { container: { id: rec.id, name: rec.name }, status: rec.status, exit_code: rec.exitCode === undefined ? null : rec.exitCode };
      if (rec.exitReason) out.exit_reason = rec.exitReason;
      const streams = a.stream === 'both' ? ['stdout', 'stderr'] : [a.stream];
      let truncated = false;
      for (const s of streams) {
        let r;
        try {
          r = await c.get('/api/container/logs?id=' + enc(rec.id) + '&stream=' + s + '&tail=' + a.tail + (a.previous ? '&prev=1' : ''));
        } catch (e) { throw h.apiFail(e); }
        const cap = new OutputCapture(h.OUTPUT_CAP, h.OUTPUT_HEAD_SHARE);
        cap.push(String((r && r.text) || ''));
        out[s] = cap.text();
        if (cap.truncated || (r && r.truncated)) truncated = true;
      }
      out.truncated = truncated;
      if (a.previous) out.note = 'the previous run (before the latest start)';
      return out;
    },
  });

  // --------------------------------------------------------- list_containers
  tools.push({
    name: 'list_containers',
    title: 'List containers',
    description: 'List the containers (Docker images run as microVMs by run_image or deploy_image): name, id, image, status (created | preparing | ' +
      'booting | running | stopping | exited | error), exit code and its meaning, URLs (and whether each is reachable from this PC only or the ' +
      'LAN), volumes, shared folders, memory, root filesystem (rootfs "disk" with the size of its writable layer, or "ram"), who created it and ' +
      'whether it is temporary. all=false lists only the ones that are starting or running.',
    params: {
      all: { type: 'boolean', default: true, description: 'true = every container, including exited ones; false = only the ones starting or running.' },
    },
    annotations: RO,
    handler: async (a) => {
      const c = await h.conn();
      let list, source = 'containers';
      try { list = (await c.get('/api/containers?all=1')).containers || []; }
      catch (e) {
        if (!(e && e.status === 501)) throw h.apiFail(e);
        // an engine that cannot list yet: the registry summaries in /api/state
        list = ((await h.getState(c)).containers) || [];
        source = 'state';
      }
      if (!a.all) list = list.filter((r) => TERMINAL.concat(['created']).indexOf(r.status || 'created') === -1);
      const lanAddrs = h.addrs();
      const out = { count: list.length, containers: list.map((r) => summarizeContainer(r, lanAddrs, h.lanUrls)) };
      if (source === 'state') out.note = 'summaries only (this manager version has no full container listing)';
      return out;
    },
  });

  // -------------------------------------------------------- remove_container
  tools.push({
    name: 'remove_container',
    title: 'Remove a container',
    description: 'Delete a container: its record, its logs, its published ports and its own files (the writable layer of a disk-root container). ' +
      'Named volumes are kept (they hold data; they are separate). ' +
      'A running container is refused unless force=true, which stops it first. Only remove containers you created, or ones the user asked you ' +
      'to remove. Removing one that no longer exists succeeds (already_gone).',
    params: {
      container: ref,
      force: { type: 'boolean', default: false, description: 'Stop the container first if it is still running.' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const c = await h.conn();
      let r;
      try { r = await c.post('/api/container/remove', { id: a.container, force: a.force }, 120000); }
      catch (e) {
        if (e && e.status === 404) return { status: 'done', container: a.container, removed: false, already_gone: true };
        if (e && e.status === 409 && e.code === 'RUNNING') throw new ToolError('container "' + a.container + '" is running - stop it first (stop_image), or call remove_container with force=true');
        throw h.apiFail(e);
      }
      if (r && r.task && r.task.id && r.task.status === 'running') {
        const out = h.taskOutcome(await h.waitTask(c, r.task.id, 120000), 'removing ' + a.container, 120);
        if (out.status !== 'done') return Object.assign(out, { container: a.container });
      }
      return { status: 'done', container: a.container, removed: true, note: 'named volumes are kept (they are separate from the container)' };
    },
  });

  // -------------------------------------------------------------- pull_image
  tools.push({
    name: 'pull_image',
    title: 'Pull an image into the cache',
    description: 'Download an image (or check for a newer one) into the local image cache without running it, so a later run_image starts in ' +
      'seconds. Always asks the registry; returns the canonical reference, the digest, the download size and the Docker Hub pull quota left. ' +
      'Anonymous pulls only (public images). If it takes longer than timeout_s it returns {status:"running", task_id}.',
    params: {
      image: { type: 'string', required: true, minLength: 1, description: 'Image reference, e.g. "nginx:alpine".' },
      timeout_s: { type: 'integer', default: 600, minimum: 1, maximum: 3600, description: 'Seconds to wait for the download before returning {status:"running", task_id} (it continues in the background).' },
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const c = await h.conn();
      const start = await h.api(c, 'POST', '/api/image/pull', { image: a.image.trim() });
      const out = h.taskOutcome(await h.waitTask(c, start.task.id, a.timeout_s * 1000), 'pulling ' + a.image, a.timeout_s);
      if (out.status !== 'done') return Object.assign(out, { image: a.image });
      const res = out.result || {};
      const r = { status: 'done', image: a.image, reference: res.reference || res.familiar || null };
      if (res.configDigest) r.config_digest = res.configDigest;
      if (res.manifestDigest) r.manifest_digest = res.manifestDigest;
      if (typeof res.compressedBytes === 'number') r.download_size_mb = mb(res.compressedBytes);
      if (typeof res.downloadedBytes === 'number') r.downloaded_now_mb = mb(res.downloadedBytes);
      if (res.cached && typeof res.cached === 'object') r.was_cached = !!res.cached.image;
      if (res.rateLimit) r.docker_hub_pull_quota = { limit: res.rateLimit.limit, remaining: res.rateLimit.remaining };
      if (nonEmpty(res.warnings)) r.warnings = res.warnings;
      r.task_id = out.task_id;
      return r;
    },
  });

  // ------------------------------------------------------------- list_images
  tools.push({
    name: 'list_images',
    title: 'List cached images',
    description: 'List the local image cache used by run_image: each image\'s references (tags), download and unpacked size, when it was last ' +
      'used, which containers use it, and whether it runs as a microVM or needs Docker-in-VM (compat). Also the total cache size and the ' +
      'Docker Hub anonymous pull quota (remaining out of the limit).',
    params: {},
    annotations: RO,
    handler: async () => {
      const c = await h.conn();
      const r = await h.api(c, 'GET', '/api/images');
      const images = (r.images || []).map((i) => {
        const o = { references: i.references || [], config_digest: i.configDigest || null };
        if (typeof i.compressedBytes === 'number') o.download_size_mb = mb(i.compressedBytes);
        // a RAM-root image: its rootfs archive; a disk-root one: its unpacked size (cov-1)
        if (typeof i.rootfsBytes === 'number') o.unpacked_mb = mb(i.rootfsBytes);
        else if (typeof i.unpackedBytes === 'number') o.unpacked_mb = mb(i.unpackedBytes);
        if (typeof i.initrdBytes === 'number') o.boot_image_mb = mb(i.initrdBytes);
        // the read-only image disk every disk-root container of it shares
        if (typeof i.diskBytes === 'number') o.image_disk_mb = mb(i.diskBytes);
        o.last_used = i.lastUsed || null;
        o.used_by = i.usedBy || [];
        if (nonEmpty(i.warnings)) o.warnings = i.warnings;
        if (i.compat) o.compat = { engine: i.compat.engine || null, reasons: i.compat.reasons || [] };
        return o;
      });
      const out = { count: images.length, images: images };
      if (typeof r.cacheBytes === 'number') out.cache_mb = mb(r.cacheBytes);
      if (r.rateLimit) out.docker_hub_pull_quota = { limit: r.rateLimit.limit, remaining: r.rateLimit.remaining, window: r.rateLimit.window, checked_at: r.rateLimit.at };
      return out;
    },
  });

  // ------------------------------------------------------------ remove_image
  tools.push({
    name: 'remove_image',
    title: 'Remove a cached image',
    description: 'Delete an image from the local cache (its image disk, unpacked and boot copies, and the downloaded layers no other image ' +
      'needs). Refused while a container uses it unless force=true (then an image disk a container\'s writable layer still needs is kept until ' +
      'that container is removed). The next run_image of it downloads it again. Use a reference ("nginx:alpine") or a config digest ("sha256:...").',
    params: {
      image: { type: 'string', required: true, minLength: 1, description: 'Image reference as listed by list_images, or its config digest "sha256:...".' },
      force: { type: 'boolean', default: false, description: 'Remove it even though containers use it.' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const c = await h.conn();
      const v = a.image.trim();
      const body = /^sha256:[0-9a-f]{12,64}$/i.test(v) ? { configDigest: v, force: a.force } : { image: v, force: a.force };
      let r;
      try { r = await c.post('/api/image/remove', body); }
      catch (e) {
        if (e && e.status === 409 && e.code === 'IMAGE_IN_USE') throw new ToolError(e.message + ' -> remove those containers first (remove_container), or call remove_image with force=true');
        throw h.apiFail(e);
      }
      const out = { status: 'done', image: v, removed: true };
      if (r && typeof r.freedBytes === 'number') out.freed_mb = mb(r.freedBytes);
      if (r && nonEmpty(r.warnings)) out.warnings = r.warnings;
      return out;
    },
  });

  return tools;
}

module.exports = {
  containerTools, runImageFlow, ROOTFS_PARAM,
  // pure helpers (tests)
  isHostAbsolute, portMappings, exitMeaning, prepareMounts, runBody, containerUrls, summarizeContainer, envNames, nextFor, containerIdOf, resultOutput,
  rootfsOf, mb, LOG_TAIL_MAX,
};
