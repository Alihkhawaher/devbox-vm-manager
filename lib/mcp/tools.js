'use strict';
/*
 * The MCP tools (spec section 13): what Claude can do with the sandbox VMs.
 *
 *   status, list_vms                          what exists, is the system ready
 *   setup                                     one-time: QEMU, microVM kernel,
 *                                             Alpine, base image
 *   create_vm, start_vm, stop_vm, delete_vm, reset_vm, snapshot, cleanup
 *   exec, write_file, read_file, upload, download     work inside a VM
 *   forward_port                              reach apps from this PC
 *   share_folder, unshare_folder, list_shares live folders of this PC in a VM
 *                                             (lib/mcp/shares.js)
 *   run_image, stop_image, image_logs, list_containers, remove_container,
 *   pull_image, list_images, remove_image     Docker images as microVMs, no
 *                                             Docker (lib/mcp/containers.js)
 *   deploy_image                              an image in one step: microVM,
 *                                             or Docker inside a full VM
 *   get_task, serial_log                      follow long work, debug boots
 *   restart_server                            reload this server's code
 *
 * Which sandbox for which job (the INSTRUCTIONS tell the model the same):
 * one Docker image - a server or a one-shot command - is a microVM
 * (run_image: seconds, its own tiny VM, no Docker Engine); an interactive
 * Linux box to build and test in is a full VM (create_vm + exec); compose
 * stacks, privileged images and anything a microVM cannot run use Docker
 * inside a full VM (deploy_image engine="docker-vm", create_vm docker=true).
 * A project folder the user edits is shared live (share_folder, or a host
 * folder in run_image's volumes) instead of being copied back and forth.
 *
 * This is a THIN client. Everything that changes a VM goes through the
 * manager's HTTP API (lib/client.js finds or starts the manager for this data
 * root), so the GUI, the registry, the locks and the task history stay the
 * single source of truth and the GUI shows what Claude is doing. Commands
 * and file transfers go straight to the guest over ssh (lib/ssh.js: the same
 * key and per-VM known_hosts as the manager) - they are not manager tasks and
 * would only add latency there.
 *
 * Long operations are manager tasks. A tool waits up to its timeout_s polling
 * GET /api/task; if the task is still running then, the tool returns
 * {status:'running', task_id, hint} instead of failing - the work carries on
 * in the manager and get_task follows it.
 *
 * Port exposure is the user's choice (spec section 7): every forward made
 * here is reachable from THIS PC only unless the call says lan=true, and the
 * descriptions tell the model to do that only when the user asks.
 *
 * createTools(deps) builds the tool list; deps are injectable so the tests can
 * run every handler against a fake manager. Requiring this module has no side
 * effects.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ToolError, logErr } = require('./protocol');
const { shq, networkPathError } = require('../util');
const containerMod = require('./containers');
const shareMod = require('./shares');

const OUTPUT_CAP = 100 * 1024;          // exec: per stream
const OUTPUT_HEAD_SHARE = 0.2;          // keep the first 20 KB + the last 80 KB
const BACKGROUND_WAIT_MS = 6 * 3600 * 1000;
// VMs this server creates are marked "claude"; the container API takes only
// gui | mcp | api (microVM spec 6.1), so containers - and a VM the manager
// starts for one (Docker-in-VM) - are marked "mcp". Both mean "Claude made
// it": cleanup deletes either kind, never anything else.
const CREATED_BY = 'claude';
const CONTAINER_CREATED_BY = 'mcp';
const CLAUDE_ORIGINS = [CREATED_BY, CONTAINER_CREATED_BY];
// the least memory a full VM may get (the manager's CFG.minMem)
const FULL_VM_MIN_MEM_MB = 256;

const INSTRUCTIONS = [
  'devbox-vms runs Linux sandboxes on the user\'s PC with QEMU, managed by the local devbox VM Manager (which also has a GUI the user can watch). No Docker Desktop, WSL or Hyper-V is needed. Pick the kind of sandbox by the job:',
  '- Run or test ONE Docker image (a server, a database, a one-shot command, a CLI tool from an image): run_image. Each image runs as its own small isolated VM (a microVM, no Docker Engine) and starts in seconds; it returns the URLs, or with wait_for="exit" the exit code and output. It needs about 128 MB of RAM whatever the image size. Its files outside volumes persist across restarts of the same container and go when it is removed (remove_container); keep data that must outlive the container in named volumes (volumes: ["name:/path"]). rootfs="ram" (whole image in memory, reset at every start) only when the user asks for it.',
  '- An interactive Linux box to build, install and test in (Alpine Linux, root, apk add ...): create_vm, then exec, write_file, read_file, upload, download. docker=true gives it Docker.',
  '- Docker compose stacks, privileged images, or an image run_image cannot run (it says so): deploy_image with engine="docker-vm", or create_vm with docker=true and exec. These take minutes and about 2 GB of RAM.',
  '- A project folder the user works on, used live from inside a sandbox (both sides see the same files at once, no copying): share_folder for a VM, or a folder of this PC in run_image\'s volumes (e.g. "C:\\Users\\me\\project:/app"). ' + shareMod.CAVEAT,
  '',
  'Workflow:',
  '1. Call status first. ready says whether full VMs can be created, ready_for_images whether run_image works. If what you need is not ready, do what next_step / next_step_for_images says - usually call setup once: setup(images_only=true) takes about a minute and is all run_image needs; plain setup also builds the base image for VMs (5-20 minutes). If something must be installed by the user (e.g. the OpenSSH client), tell them the exact fix from status. Without hardware acceleration status has accel_hint (everything runs several times slower): pass its steps to the user - often nested virtualization on the outer host when this PC is itself a VM - instead of trying them yourself.',
  '2. create_vm makes a VM from a template in seconds and boots it (usually 15-30 s with hardware acceleration, up to 2-3 minutes without). It returns the VM name. VMs and containers you create are temporary (ephemeral) by default.',
  '3. To reach a server in a VM from this PC, call forward_port; run_image and deploy_image publish ports themselves. Every port is reachable from THIS PC ONLY by default. Use lan=true only when the user explicitly asks for other devices on their network to reach it.',
  '4. When finished, remove what you created (stop_image / remove_container, delete_vm, or cleanup for everything temporary you made) unless the user wants to keep it. Never share a folder the user did not name or agree to.',
  '',
  'Long operations (setup, create_vm, start_vm, run_image, deploy_image, pull_image, reset_vm, snapshot) wait up to timeout_s. If they are not finished by then they return {status:"running", task_id}: the work continues in the background; poll get_task with that task_id every 10-30 s. If a call timed out on your side, status lists the running tasks with their task_id.',
  'If a VM does not boot or SSH does not come up, serial_log shows its console output; for a container, image_logs with stream="console".',
  'Never delete, reset or stop VMs or containers you did not create unless the user asks.',
].join('\n');

// ---------------------------------------------------------------------------
// small pure helpers (exported for the tests)
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const secs = (ms) => Math.round(ms / 100) / 10;
// The manager waits up to 240 s for a VM's SSH (600 s under TCG emulation).
// timeout_s is how long THIS call waits: it never shortens the boot itself (a
// slow TCG boot cut off at 300 s would fail just before it succeeded - the
// call returns {status:'running', task_id} instead); a longer one extends it.
function bootWaitS(timeoutS) { return timeoutS > 600 ? clamp(timeoutS, 30, 1800) : undefined; }

// A path inside the guest, quoted for sh. "~" and "~/x" mean the home of the
// ssh user; everything else is used literally.
function remotePathExpr(p) {
  if (p === '~') return '"$HOME"';
  if (p.indexOf('~/') === 0) return '"$HOME"/' + shq(p.slice(2));
  return shq(p);
}
function checkRemotePath(p, label) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError(label + ' is required');
  if (/[\0\r\n]/.test(p)) throw new ToolError(label + ' must not contain newlines or NUL characters');
  if (p.charAt(0) === '-') throw new ToolError(label + ' must not start with "-" - use an absolute path such as /root/' + p.replace(/^-+/, ''));
  return p;
}
function checkLocalPath(p, label) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError(label + ' is required');
  if (/[\0\r\n]/.test(p)) throw new ToolError(label + ' must not contain newlines or NUL characters');
  // a UNC path is another computer: refused before anything opens it (sec-1)
  const netWhy = networkPathError(p);
  if (netWhy) throw new ToolError(label + ': ' + netWhy);
  // relative paths would resolve against whatever folder the MCP host started
  // this server in, which nobody can predict
  if (!path.isAbsolute(p)) throw new ToolError(label + ' must be an absolute path on this PC (got "' + p + '")');
  return path.resolve(p);
}

// ---------------------------------------------------------------------------
// what upload/download may touch on this PC (security-2)
// ---------------------------------------------------------------------------
// While Claude tests code in a VM, everything the guest prints is untrusted,
// and one prompt-injected upload/download is enough to do damage: copying
// the manager's access token or SSH key INTO a VM gives that guest the API
// (guests reach the host loopback through 10.0.2.2) and root SSH to every
// sibling VM; writing over config.json points the manager at other programs
// to run; writing into its code or a Startup folder runs anything later.
// So these are refused, whatever the path looks like (symlinks and junctions
// are resolved, Windows paths compared case-insensitively):
//   both ways - the data folder's private parts (token, key, registry,
//               config, runtime files, disks, logs) and ~/.ssh
//   writes    - also the manager's program folder and the Startup folders
// A folder that CONTAINS a protected path cannot be uploaded (it would be
// copied along) or downloaded into (the guest's archive decides the names).
// DEVBOX_MCP_FILES (folders separated by the OS path separator) narrows every
// transfer to those folders.
// microVM parts: containers.json and microvms/ hold container env values
// (secrets) and run specs; volumes/ are the containers' disks; kernel/ and
// images/ are what every microVM boots - writing into any of them would
// reach into other sandboxes.
const DATA_ROOT_PRIVATE = ['manager-token', 'seed', 'run', 'config.json', 'vms.json', 'qemu', 'logs',
  'sandboxes', 'vm-bases', 'downloads', 'devbox-base.qcow2', 'vm-alpine.qcow2',
  'containers.json', 'microvms', 'volumes', 'kernel', 'images'];
// a name that also protects its siblings with suffixes (.bak, corrupt-<time>)
const PRIVATE_PREFIX = ['vms.json', 'containers.json'];
const WIN = process.platform === 'win32';
const normCase = (p) => (WIN ? p.toLowerCase() : p);

// Resolve symlinks/junctions of the longest existing part of p.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 256; i++) {
    try {
      const r = (fs.realpathSync.native || fs.realpathSync)(cur);
      return rest.length ? path.join(r, ...rest.reverse()) : r;
    } catch (e) {
      const up = path.dirname(cur);
      if (up === cur) break;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  return path.resolve(p);
}
function within(child, parent) {
  const rel = path.relative(normCase(parent), normCase(child));
  return rel === '' || (!!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

// env: {dataRoot, appDir, home, appData, programData}; mode 'read' | 'write'. Pure.
function protectedPaths(env, mode) {
  const out = [];
  const add = (p, why, prefix) => { if (p) out.push({ path: path.resolve(p), why: why, prefix: !!prefix }); };
  if (env.dataRoot) {
    for (const n of DATA_ROOT_PRIVATE) add(path.join(env.dataRoot, n), 'the VM manager\'s private files (' + path.join(env.dataRoot, n) + ')', PRIVATE_PREFIX.indexOf(n) !== -1);
  }
  if (env.home) add(path.join(env.home, '.ssh'), 'your SSH keys (' + path.join(env.home, '.ssh') + ')');
  if (mode === 'write') {
    if (env.appDir) add(env.appDir, 'the VM manager\'s program folder (' + env.appDir + ')');
    const startup = ['Microsoft', 'Windows', 'Start Menu', 'Programs'];
    if (env.appData) add(path.join(env.appData, ...startup, 'Startup'), 'the Windows Startup folder');
    if (env.programData) add(path.join(env.programData, ...startup, 'StartUp'), 'the Windows Startup folder');
  }
  return out;
}

// Throws a ToolError when `p` may not be used; returns the resolved path.
//   mode: 'read' (upload source) | 'write' (download target)
//   isDir: p is a folder whose contents are copied (from or into)
function guardLocalPath(p, label, mode, isDir, env) {
  // BEFORE realish() touches the file system (sec-1): "\\localhost\C$\..."
  // names the data folder in a form within() never matches, and opening any
  // UNC path sends the user's Windows sign-in to that host
  const netWhy = networkPathError(p);
  if (netWhy) throw new ToolError(label + ' ' + p + ': ' + netWhy);
  const abs = path.resolve(p);
  const real = realish(abs);
  // a mapped network drive resolves to \\server\share
  if (networkPathError(real)) throw new ToolError(label + ' ' + abs + ' is on a network drive: ' + networkPathError(real));
  const cands = [abs, real];
  const hit = (c, pr, t) => within(c, t) ||
    (pr.prefix && normCase(path.dirname(c)) === normCase(path.dirname(t)) && normCase(path.basename(c)).indexOf(normCase(path.basename(t))) === 0);
  for (const pr of protectedPaths(env, mode)) {
    for (const t of [pr.path, realish(pr.path)]) {
      for (const c of cands) {
        if (hit(c, pr, t)) {
          throw new ToolError(label + ' ' + abs + ' is inside ' + pr.why + ' - ' + (mode === 'write' ? 'writing' : 'copying') +
            ' there is not allowed for VM file transfers (it protects this PC from what runs in the VMs). Use another folder.');
        }
        if (isDir && within(t, c)) {
          throw new ToolError(label + ' ' + abs + ' contains ' + pr.why + ', which ' + (mode === 'write' ? 'a download must not write into' : 'must not be copied into a VM') +
            ' - ' + (mode === 'write' ? 'download into an empty folder of its own' : 'upload the subfolder you need instead') + '.');
        }
      }
    }
  }
  const allow = (env.allow || []).filter(Boolean);
  if (allow.length && !cands.some((c) => allow.some((r) => within(c, path.resolve(r)) || within(c, realish(r))))) {
    throw new ToolError(label + ' ' + abs + ' is outside the folders allowed for VM file transfers (DEVBOX_MCP_FILES: ' + allow.join(path.delimiter) + ')');
  }
  return abs;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// exec: optional cd + exports, then the command itself, as one sh script.
function buildExecCommand(command, opts) {
  opts = opts || {};
  const lines = [];
  if (opts.workdir) lines.push('cd ' + remotePathExpr(checkRemotePath(opts.workdir, 'workdir')) + ' || exit 1');
  const env = opts.env || {};
  for (const k of Object.keys(env)) {
    if (!ENV_NAME.test(k)) throw new ToolError('bad environment variable name "' + k + '" - use letters, digits and _ (not starting with a digit)');
    lines.push('export ' + k + '=' + shq(String(env[k])));
  }
  lines.push(String(command));
  return lines.join('\n');
}

// {NAME: value} -> ["NAME=value"] (what the deploy API takes)
function envList(env) {
  return Object.keys(env || {}).map((k) => {
    if (!ENV_NAME.test(k)) throw new ToolError('bad environment variable name "' + k + '"');
    return k + '=' + String(env[k]);
  });
}

// read_file's remote output: first line = full size, then base64 of the bytes.
function parseReadOutput(stdout) {
  const s = String(stdout || '');
  const nl = s.indexOf('\n');
  const first = (nl === -1 ? s : s.slice(0, nl)).trim();
  if (!/^\d+$/.test(first)) throw new Error('unexpected output from the VM: ' + s.slice(0, 120));
  const b64 = nl === -1 ? '' : s.slice(nl + 1).replace(/[^A-Za-z0-9+/=]/g, '');
  return { size: parseInt(first, 10), bytes: Buffer.from(b64, 'base64') };
}

// Text when the bytes are valid UTF-8 without NULs, else base64. A file cut
// at max_bytes may end mid-character: `stream` keeps that partial character
// out instead of calling the whole file binary.
function decodeFileBytes(buf, truncated) {
  if (buf.indexOf(0) === -1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: !!truncated });
      return { encoding: 'utf-8', content: text };
    } catch (e) { /* binary */ }
  }
  return { encoding: 'base64', content: buf.toString('base64') };
}

// Host ports that must not be picked: the manager, the bake's SSH, every VM's
// SSH port and every existing forward (any bind address).
function reservedPorts(s) {
  const set = new Set([2222]);
  if (s && s.managerPort) set.add(s.managerPort);
  for (const v of (s && s.vms) || []) {
    if (v.port) set.add(v.port);
    for (const p of v.ports || []) set.add(p.host);
  }
  return set;
}

// A free host port for a guest port: the same number when it is >= 1024
// (3000 -> 3000), else 8000 + port (80 -> 8080, 443 -> 8443), then upwards.
async function pickHostPort(guest, reserved, isFree, tries) {
  let p = guest >= 1024 ? guest : guest + 8000;
  for (let i = 0; i < (tries || 200); i++, p++) {
    if (p > 65535) p = 20000;
    if (p < 1024 || reserved.has(p)) continue;
    if (await isFree(p)) return p;
  }
  return null;
}

function portUrl(host) { return 'http://127.0.0.1:' + host; }
// Windows PCs often have many virtual adapters (Hyper-V, WSL, VPNs): list the
// typical home/office ranges first and keep the list short.
function lanRank(a) {
  if (/^192\.168\./.test(a)) return 0;
  if (/^10\./.test(a)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
  return 3;
}
function lanUrls(host, addrs) {
  return (addrs || []).slice().sort((x, y) => lanRank(x) - lanRank(y)).slice(0, 4).map((a) => 'http://' + a + ':' + host);
}

function describeForward(p, addrs) {
  const o = { host_port: p.host, guest_port: p.guest, url: portUrl(p.host), lan: !!p.lan, reachable_from: p.lan ? 'this PC and the LAN' : 'this PC only' };
  if (p.lan && addrs) o.lan_urls = lanUrls(p.host, addrs);
  if (p.owner) o.owner = p.owner;
  if (p.container) o.container_port = p.container;
  return o;
}

function summarizeVm(v) {
  return {
    name: v.name,
    status: v.status,
    ssh_port: v.port,
    ssh: v.sshCommand,
    memory_mb: v.mem,
    cpus: v.cpus,
    template: v.template,
    accel: v.effectiveAccel || v.accel,
    ephemeral: !!v.ephemeral,
    created_by: v.createdBy || null,
    created_at: v.createdAt || null,
    started_at: v.startedAt || null,
    disk_mb: v.diskBytes ? Math.round(v.diskBytes / 1048576) : null,
    forwards: (v.ports || []).map((p) => describeForward(p)),
    shared_folders: (v.shares || []).map((s) => ({ host_path: s.hostPath, guest_path: s.guestPath, read_only: !!s.readOnly })),
    snapshots: v.snapshots || [],
    busy_task: v.busy || null,
    pending_restart: !!v.pendingRestart,
    last_error: v.lastError ? v.lastError.message : null,
    note: v.note || '',
    // started by version 1 of the manager: tell the user to restart it
    warning: v.legacy ? 'started by the old version 1 of the manager - its QEMU monitor is reachable from every VM and its ports from the network until it is restarted (stop_vm, then start_vm; ask the user first if Claude did not create it)' : undefined,
  };
}

function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : (ms || null); }

function summarizeTask(t, logLines) {
  const n = logLines === undefined ? 40 : logLines;
  const out = {
    task_id: t.id, kind: t.kind, title: t.title, vm: t.vm || null,
    container: t.ctr || undefined,
    status: t.status, step: t.step || null,
    started_at: iso(t.startedAt), ended_at: iso(t.endedAt),
    duration_s: t.startedAt ? secs((t.endedAt || Date.now()) - t.startedAt) : null,
  };
  if (t.status === 'error') out.error = t.error;
  if (t.status === 'done') out.result = t.result;
  if (n > 0 && Array.isArray(t.log)) out.log = t.log.slice(-n);
  return out;
}

function logTail(t, n) {
  const lines = t && Array.isArray(t.log) ? t.log.slice(-(n || 12)) : [];
  return lines.length ? '\nLast log lines:\n' + lines.join('\n') : '';
}

// Which VMs cleanup deletes: only VMs this server created (created_by
// "claude") - the temporary ones, or with ephemeral_only=false all of them.
// Never a VM the user made (the GUI marks its own "temporary" VMs too; the
// GUI's "Delete all temporary VMs" is for those).
// The same rule for containers (records from GET /api/containers).
function cleanupCandidates(vms, ephemeralOnly) {
  return (vms || []).filter((v) => CLAUDE_ORIGINS.indexOf(v.createdBy) !== -1 && (v.ephemeral || !ephemeralOnly));
}

// Readiness from /api/state: {ready, next_step, needs_user:[...]}
function readiness(s) {
  const pr = s.prereqs || {};
  const missing = Object.keys(pr).filter((k) => pr[k] && pr[k].required && !pr[k].ok);
  const running = ((s.tasks && s.tasks.running) || []).find((t) => /^(setup|build-base|install-qemu)$/.test(t.kind));
  if (!missing.length) return { ready: true, next_step: 'Ready: call create_vm for a Linux VM (run_image runs a single Docker image faster).', needs_user: [] };
  if (running) return { ready: false, next_step: '"' + running.title + '" is running (task_id ' + running.id + ') - follow it with get_task.', needs_user: [] };
  // setup builds the base image and, on Windows, installs QEMU - for which it
  // needs 7-Zip (listed as its own required item while QEMU is missing)
  const setupCan = (k) => k === 'base' || (k === 'qemu' && pr.qemu.action === 'install-qemu');
  const needsUser = missing.filter((k) => !setupCan(k)).map((k) => ({ item: pr[k].label || k, fix: pr[k].fix || null }));
  if (needsUser.length) {
    return {
      ready: false,
      next_step: 'The user must install something first (see needs_user - tell them the exact fix), then call setup.',
      needs_user: needsUser,
    };
  }
  return { ready: false, next_step: 'Call setup (one-time; downloads Alpine Linux and builds the base image, 5-20 minutes). If only Docker images are needed, setup(images_only=true) is enough (about a minute).', needs_user: [] };
}

// Can run_image work? From /api/state's microvm {ready, kver, accel,
// machine, reason, needsUpdate} and prereqs (qemu, microvm):
// {ready, next_step, needs_update, needs_user:[...]}
function imageReadiness(s) {
  const mv = s.microvm;
  const pr = s.prereqs || {};
  if (!mv && !pr.microvm) {
    return { ready: false, supported: false, next_step: 'This VM manager version cannot run Docker images as microVMs - use deploy_image with engine="docker-vm".', needs_user: [] };
  }
  const needsUpdate = !!((mv && mv.needsUpdate) || (pr.microvm && pr.microvm.needsUpdate));
  const running = ((s.tasks && s.tasks.running) || []).find((t) => /^(setup|install-kernel|install-qemu)$/.test(t.kind));
  if (mv && mv.ready) {
    return {
      ready: true, needs_update: needsUpdate, needs_user: [],
      next_step: needsUpdate
        ? 'Ready: run_image runs a Docker image in seconds. A kernel update is available (live shared folders in containers need it): setup(images_only=true) applies it in seconds, no download.'
        : 'Ready: run_image runs a Docker image in seconds.',
    };
  }
  if (running) return { ready: false, needs_update: needsUpdate, needs_user: [], next_step: '"' + running.title + '" is running (task_id ' + running.id + ') - follow it with get_task.' };
  // QEMU the user must install (Linux/macOS; 7-Zip on Windows to unpack it)
  const q = pr.qemu;
  const needsUser = [];
  if (q && !q.ok && q.action !== 'install-qemu') needsUser.push({ item: q.label || 'QEMU', fix: q.fix || null });
  if (pr.sevenzip && pr.sevenzip.required && !pr.sevenzip.ok) needsUser.push({ item: pr.sevenzip.label || '7-Zip', fix: pr.sevenzip.fix || null });
  if (needsUser.length) return { ready: false, needs_update: needsUpdate, needs_user: needsUser, next_step: 'The user must install something first (see needs_user - tell them the exact fix), then call setup(images_only=true).' };
  return {
    ready: false, needs_update: needsUpdate, needs_user: [],
    next_step: 'Call setup(images_only=true): about a minute (' + ((mv && mv.reason) || 'installs the ~43 MB microVM kernel') + ').',
  };
}

// An API error -> a ToolError the model can act on.
function apiFail(e, root) {
  if (e instanceof ToolError) return e;
  const code = e && e.code;
  let msg = (e && e.message) ? String(e.message) : String(e);
  const hint = e && e.body && typeof e.body.hint === 'string' && e.body.hint && msg.indexOf(e.body.hint) === -1 ? ' (' + e.body.hint + ')' : '';
  const fb = e && e.body && e.body.fallback;
  if (code === 'NO_BASE') msg += ' -> call setup first (one-time: downloads Alpine Linux and builds the base image, 5-20 minutes), then retry.';
  else if (code === 'NO_KERNEL') msg += ' -> call setup(images_only=true) first (about a minute: the ~43 MB microVM kernel), then retry.';
  else if (code === 'NOT_COMPATIBLE' || code === 'ZSTD_UNSUPPORTED' || code === 'NEEDS_DOCKER' || fb) {
    msg += hint + ' -> run it with Docker inside a full VM instead: deploy_image(image=..., engine="docker-vm") (about 2 GB of RAM, several minutes the first time).';
  } else if (code === 'HOST_FOLDER') msg += hint + ' -> give the folder as an absolute path on this PC ("C:\\dir:/path"), or use a named volume ("name:/path").';
  else if (code === 'MEMORY_BUDGET') msg += ' -> stop VMs or containers you no longer need (list_vms, list_containers), or pass a smaller memory_mb.';
  else if (code === 'MEMORY_TOO_SMALL') msg += ' -> pass a larger memory_mb (at least 96 MB for the default disk root, 128 for rootfs="ram"), or leave it out for the default.';
  else if (code === 'NO_SPACE') msg += ' -> the disk of the manager\'s data folder is nearly full: remove containers or images you no longer need (remove_container, remove_image) or ask the user to free space.';
  else if (code === 'IMAGE_GONE' || code === 'ROOT_DISK_MISSING') msg += ' -> remove the container (remove_container) and run the image again with run_image; its files outside volumes cannot be recovered.';
  else if (code === 'VOLUME_IN_USE') msg += ' -> a volume can be attached to one running container at a time: stop that container first, or use another volume name.';
  else if (code === 'NAME_IN_USE') msg += ' -> pick another name, or remove_container the old one (list_containers shows them).';
  else if (code === 'NO_SUCH_CONTAINER' || (code === 'NOT_FOUND' && /container/i.test(msg))) msg += ' -> list_containers shows the containers that exist.';
  else if (code === 'RATE_LIMITED') msg += (e.body && e.body.rateLimit && e.body.rateLimit.reset ? ' (the quota resets at ' + e.body.rateLimit.reset + ')' : '') + ' -> Docker Hub\'s anonymous pull limit was reached; cached images (list_images) still run - retry later.';
  else if (code === 'BAD_REFERENCE') msg += ' -> an image reference looks like "nginx:alpine" or "ghcr.io/owner/app:1.2".';
  else if (code === 'PREREQ_MISSING') msg += ' -> call status to see what is missing and how to fix it.';
  else if (code === 'BUSY') msg += (e.body && e.body.holder && e.body.holder.id ? ' (task_id ' + e.body.holder.id + ')' : '') + ' -> wait for it (get_task) and retry.';
  else if (code === 'NOT_IMPLEMENTED' || e.status === 501) msg = 'this version of the VM manager cannot do that yet: ' + msg;
  else if (code === 'NOT_FOUND' && /no VM called/i.test(msg)) msg += ' -> list_vms shows the VMs that exist.';
  // (a registry's "UNAUTHORIZED" - a private or missing repository - is not
  // a 401 from the manager, so only the status decides here)
  else if (e.status === 401) msg = 'the VM manager refused the access token' + (root ? ' in ' + path.join(root, 'manager-token') : '') + ' - it probably serves another data folder; restart it or set VM_MANAGER_ROOT for this MCP server to its data folder';
  else if (!e.status && /ECONNREFUSED|ECONNRESET|socket hang up|ETIMEDOUT/.test(String(code) + ' ' + msg)) msg = 'the VM manager stopped answering (' + msg + ') - call status to start it again';
  else if (hint) msg += hint;
  // the code travels along: deploy_image turns NO_KERNEL into Docker-in-VM
  return new ToolError(msg, { code: code || null, status: e && e.status });
}

const TIMEOUT = Symbol('timeout');
function withDeadline(promise, deadlineMs) {
  const left = deadlineMs - Date.now();
  if (left <= 0) return Promise.race([promise, Promise.resolve(TIMEOUT)]);
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), left); }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// local helpers for file transfer
// ---------------------------------------------------------------------------
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

// tar on this PC, for directory transfers. Windows 10 (1803+) ships bsdtar in
// System32; prefer it over Git's MSYS tar.
function findLocalTar() {
  const win = process.platform === 'win32';
  const c = [];
  if (win) c.push(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe'));
  else c.push('/usr/bin/tar', '/bin/tar', '/usr/local/bin/tar', '/opt/homebrew/bin/tar');
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) c.push(path.join(d, win ? 'tar.exe' : 'tar'));
  return c.find(isFile) || null;
}

// Collect a child's exit code and (bounded) stderr / stdout.
function watchChild(child, captureStdout) {
  const err = [], out = [];
  let errLen = 0, outLen = 0;
  if (child.stderr) child.stderr.on('data', (d) => { if (errLen < 65536) { err.push(d); errLen += d.length; } });
  if (captureStdout && child.stdout) child.stdout.on('data', (d) => { if (outLen < 65536) { out.push(d); outLen += d.length; } });
  return new Promise((resolve) => {
    let settled = false;
    const fin = (code, e) => {
      if (settled) return;
      settled = true;
      resolve({ code: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + (e ? '\n' + e.message : '') });
    };
    child.on('error', (e) => fin(127, e));
    child.on('close', (code) => fin(code === null ? 255 : code));
  });
}

function lastLines(text, n) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-(n || 4)).join(' | ');
}

// An ssh result that failed before the command ran (connection, key, host key).
function sshConnectFailure(r) {
  if (!r) return null;
  if (r.code === 127 && !r.durationMs) return r.stderr || 'ssh could not be started';
  if (r.code === 255 && !String(r.stdout || '').trim() &&
      /could not connect|connection (refused|closed|reset|timed out)|permission denied|host key verification failed|kex_exchange_identification|banner exchange|could not resolve|unprotected private key|load key|no route to host/i.test(r.stderr || '')) {
    return lastLines(r.stderr, 3);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------
function defaultDeps() {
  const client = require('../client');
  const config = require('../config');
  return {
    connect: () => client.connect({ start: true }),
    waitForTask: client.waitForTask,
    ssh: require('../ssh'),
    platform: require('../platform'),
    spawn: spawn,
    exit: (code) => process.exit(code),
    pollMs: 1500,
    version: config.version(),
    dataRoot: () => config.CFG.root,
    // what upload/download may touch (guardLocalPath)
    localEnv: () => ({
      dataRoot: config.CFG.root, appDir: config.APP_DIR, home: os.homedir(),
      appData: process.env.APPDATA || null, programData: process.env.ProgramData || process.env.PROGRAMDATA || null,
      allow: String(process.env.DEVBOX_MCP_FILES || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean),
    }),
    findLocalTar: findLocalTar,
  };
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function ann(o) { return Object.assign({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, o); }

const P = {
  vmName: { type: 'string', required: true, description: 'Name of the VM (as returned by create_vm / list_vms).' },
  wait: (what) => ({ type: 'boolean', default: true, description: 'Wait until ' + what + '. false returns at once with a task_id to follow with get_task.' }),
  timeout: (def, max, what) => ({ type: 'integer', default: def, minimum: 1, maximum: max, description: 'Seconds to wait' + (what ? ' ' + what : '') + ' before returning {status:"running", task_id} (the work continues in the background).' }),
};

function createTools(overrides) {
  const deps = Object.assign(defaultDeps(), overrides || {});
  const root = () => { try { return deps.dataRoot(); } catch (e) { return null; } };

  async function conn() {
    try { return await deps.connect(); }
    catch (e) { throw new ToolError('the VM manager is not available: ' + ((e && e.message) || e)); }
  }
  async function api(c, method, p, body, timeoutMs) {
    try { return method === 'GET' ? await c.get(p, timeoutMs) : await c.post(p, body, timeoutMs); }
    catch (e) { throw apiFail(e, root()); }
  }
  const getState = (c) => api(c, 'GET', '/api/state');

  async function findVm(c, name) {
    const s = await getState(c);
    const vm = (s.vms || []).find((v) => v.name === name);
    if (!vm) {
      const names = (s.vms || []).map((v) => v.name);
      throw new ToolError('no VM called "' + name + '"' + (names.length ? ' - existing VMs: ' + names.join(', ') : ' - there are no VMs yet (create_vm makes one)'));
    }
    return { vm: vm, state: s };
  }
  async function runningVm(c, name) {
    const r = await findVm(c, name);
    const v = r.vm;
    if (v.status === 'running') return r;
    const why = {
      stopped: 'is stopped - call start_vm first',
      booting: 'is still booting (SSH is not up yet) - call start_vm with wait=true to wait for it',
      stopping: 'is shutting down',
      missing: 'has lost its disk file (it cannot run; delete_vm removes the record)',
      error: 'is not running (last error: ' + (v.lastError ? v.lastError.message : 'unknown') + ') - start_vm retries, serial_log shows the console',
    }[v.status] || 'is ' + v.status;
    throw new ToolError('VM "' + name + '" ' + why);
  }

  async function waitTask(c, id, timeoutMs) {
    try { return await deps.waitForTask(c, id, { timeoutMs: timeoutMs, pollMs: deps.pollMs }); }
    catch (e) {
      if (e && e.code === 'TASK_GONE') throw new ToolError(e.message + ' - call list_vms to see the outcome');
      throw apiFail(e, root());
    }
  }

  // done -> {status:'done', task_id, result}; running -> {status:'running', ...};
  // error -> ToolError with the task's error and log tail
  function taskOutcome(t, what, waitedS) {
    if (!t || t.status === 'running') {
      return {
        status: 'running', task_id: t ? t.id : null, step: (t && t.step) || null,
        hint: 'still running' + (waitedS ? ' after ' + waitedS + ' s' : '') + ' - it continues in the background; call get_task with this task_id to follow it',
      };
    }
    if (t.status === 'error') throw new ToolError((what ? what + ' failed: ' : '') + t.error + logTail(t) + '\n(task_id ' + t.id + ')');
    return { status: 'done', task_id: t.id, result: t.result };
  }

  // POST a task route, then wait (or not).
  async function runTask(c, p, body, opts) {
    const r = await api(c, 'POST', p, body);
    const task = r.task;
    if (!opts.wait) {
      return { status: 'running', task_id: task.id, title: task.title, vm: task.vm || null, hint: 'started in the background - call get_task with this task_id to follow it' };
    }
    const t = await waitTask(c, task.id, opts.timeoutS * 1000);
    return taskOutcome(t, opts.what, opts.timeoutS);
  }

  const addrs = () => { try { return deps.platform.lanAddresses(); } catch (e) { return []; } };

  function sshTarget(v) { return { name: v.name, port: v.port }; }

  function sshChild(target, cmd, user) {
    const bin = deps.platform.findTool('ssh');
    if (!bin) throw new ToolError('the OpenSSH client (ssh) was not found - ' + deps.platform.installHints().ssh);
    const args = deps.ssh.sshArgs(target, { user: user, cmd: cmd, connectTimeout: 10 });
    return deps.spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // Run the processes of one transfer under one timeout.
  //   children: [{child, done}] (done = watchChild promise)
  //   opts: {sources: readable streams feeding a child (a local file),
  //          sinks: writable streams a child feeds (a local file), timeoutMs}
  // A side that fails ends the others at once - a pipe to a dead partner
  // would otherwise just stall until the timeout. Resolves
  // {results (in children order), streamErrors, timedOut}.
  async function supervise(children, opts) {
    const sources = opts.sources || [], sinks = opts.sinks || [];
    let timedOut = false;
    const errs = [];
    const killAll = () => {
      for (const ch of children) { try { ch.child.kill(); } catch (e) { /* gone */ } }
      for (const s of sources.concat(sinks)) { try { s.destroy(); } catch (e) { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, opts.timeoutMs);
    for (const s of sources) s.on('error', (e) => { errs.push(e); killAll(); });
    const sinksClosed = sinks.map((s) => new Promise((resolve) => {
      s.on('close', resolve);
      s.on('error', (e) => { errs.push(e); killAll(); resolve(); });
    }));
    for (const ch of children) ch.done.then((r) => { if (r.code !== 0) killAll(); });
    try {
      const results = await Promise.all(children.map((ch) => ch.done));
      // the processes are gone: a source still open has nobody to feed
      for (const s of sources) { try { s.destroy(); } catch (e) { /* gone */ } }
      await Promise.all(sinksClosed);
      return { results: results, streamErrors: errs, timedOut: timedOut };
    } finally { clearTimeout(timer); }
  }

  async function sshRun(v, cmd, opts) {
    opts = opts || {};
    if (!deps.platform.findTool('ssh')) throw new ToolError('the OpenSSH client (ssh) was not found - ' + deps.platform.installHints().ssh);
    const r = await deps.ssh.sshExec(sshTarget(v), cmd, Object.assign({ connectTimeout: 10 }, opts));
    const fail = sshConnectFailure(r);
    if (fail) throw new ToolError('could not reach VM "' + v.name + '" over SSH (port ' + v.port + '): ' + fail);
    return r;
  }

  // The body of POST /api/vm/quickdeploy (Docker inside a new VM).
  function quickDeployBody(a) {
    const body = { image: a.image.trim(), lan: a.lan, privileged: a.privileged, ephemeral: a.ephemeral, createdBy: CREATED_BY, keepOnFailure: false };
    if (a.name) body.name = a.name;
    // structured, LAN only through `lan` (sec-9: "0.0.0.0:8080:80" or
    // "lan:8080:80" must not publish to the network while lan is false)
    if (a.ports && a.ports.length) {
      body.ports = containerMod.portMappings(a.ports, !!a.lan).map((p) => Object.assign({ host: p.host, guest: p.guest, lan: p.lan }, p.proto === 'udp' ? { proto: 'udp' } : {}));
    }
    if (a.env) body.env = envList(a.env);
    if (a.volumes && a.volumes.length) body.volumes = a.volumes;
    // below a full VM's minimum the value was meant for a microVM (engine
    // "auto" falling back): the VM gets its default instead of a refusal
    if (a.memory_mb !== undefined && a.memory_mb >= FULL_VM_MIN_MEM_MB) body.mem = a.memory_mb;
    if (a.cpus !== undefined) body.cpus = a.cpus;
    return body;
  }

  // Follow a quick-deploy task (Docker inside a new VM) and shape its result.
  //   task: the started task's summary; a: {image, name, wait, timeout_s};
  //   deadline: ms since the epoch; extra: fields for every reply (engine,
  //   why this engine)
  async function followDeploy(c, task, a, deadline, extra) {
    extra = extra || {};
    const vmName = task.vm || a.name || null;
    if (a.wait === false) {
      return Object.assign({ status: 'running', task_id: task.id, vm: vmName, hint: 'deploying in the background - call get_task with this task_id to follow it' }, extra);
    }
    const waitedS = Math.max(1, Math.round((deadline - Date.now()) / 1000));
    const out = taskOutcome(await waitTask(c, task.id, Math.max(0, deadline - Date.now())), 'deploying ' + a.image, waitedS);
    if (out.status !== 'done') return Object.assign(out, { vm: vmName }, extra);
    const res = out.result || {};
    const lanAddrs = addrs();
    const urls = (res.urls || []).map((u) => {
      const o = { url: u.url, host_port: u.host, lan: !!u.lan, reachable_from: u.lan ? 'this PC and the LAN' : 'this PC only' };
      if (u.lan) o.lan_urls = lanUrls(u.host, lanAddrs);
      return o;
    });
    const vmn = res.sandbox || res.name || vmName;
    return Object.assign({
      status: 'done', task_id: out.task_id, vm: vmn, container: res.container, urls: urls,
      forwards: (res.ports || []).map((p) => describeForward(p)),
    }, extra, {
      next: 'Container logs: exec(name="' + vmn + '", command="docker logs --tail 100 ' + res.container + '"). Remove everything with delete_vm("' + vmn + '").',
    });
  }

  // A container reference (name, id or id prefix) -> its id, via the API
  // (which resolves all three); the reference itself when it cannot say.
  async function getContainerId(c, ref) {
    try {
      const r = await c.get('/api/container?id=' + encodeURIComponent(ref));
      const rec = r && r.container ? r.container : r;
      return (rec && rec.id) || ref;
    } catch (e) {
      if (e && e.status === 404) throw new ToolError('no container "' + ref + '" - list_containers shows the containers that exist');
      if (e && e.status === 501) return ref;
      throw apiFail(e, root());
    }
  }

  // The helpers lib/mcp/containers.js and lib/mcp/shares.js build on.
  const h = {
    deps: deps, conn: conn, api: api, apiFail: (e) => apiFail(e, root()), getState: getState, findVm: findVm,
    waitTask: waitTask, taskOutcome: taskOutcome, addrs: addrs, lanUrls: lanUrls, envList: envList,
    checkLocalPath: checkLocalPath, getContainerId: getContainerId, followDeploy: followDeploy,
    // guardLocalPath bound to this PC's protected paths
    guard: (abs, label, mode, isDir) => guardLocalPath(abs, label, mode, isDir, deps.localEnv()),
    OUTPUT_CAP: OUTPUT_CAP, OUTPUT_HEAD_SHARE: OUTPUT_HEAD_SHARE, CREATED_BY: CONTAINER_CREATED_BY, RO: RO, ann: ann,
  };

  const tools = [];
  const tool = (def) => tools.push(def);

  // ------------------------------------------------------------------ status
  tool({
    name: 'status',
    title: 'Sandbox system status',
    description: 'Check the sandbox system: whether full VMs can be created (ready: QEMU, SSH client, base image) and whether Docker images ' +
      'can run as microVMs (ready_for_images: QEMU and the microVM kernel), what is missing and how to fix it, hardware acceleration, ' +
      'available templates, host limits (memory/CPUs), the container defaults (root filesystem, memory), whether the light profile is on, the ' +
      'VMs, the containers and the running tasks; without hardware acceleration also accel_hint: how the user can enable it (nested ' +
      'virtualization in the outer hypervisor when this PC is itself a VM). Call this first in a session. If what ' +
      'you need is not ready, next_step (VMs) or next_step_for_images (run_image) says what to do - usually call setup. Starts the local VM ' +
      'manager in the background if it is not running (a few seconds the first time).',
    params: {},
    annotations: RO,
    handler: async () => {
      const c = await conn();
      const s = await getState(c);
      const rd = readiness(s);
      const ri = imageReadiness(s);
      const pr = s.prereqs || {};
      const mv = s.microvm || null;
      const set = s.settings || {};
      // the container defaults (the engine's, else the settings')
      const dd = (mv && mv.defaults) || null;
      const mvDefaults = (dd || set.microvmRootfs) ? {
        rootfs: (dd && dd.rootfs) || set.microvmRootfs || 'disk',
        memory_mb: (dd && dd.memMB) || set.microvmMemMB || null,
        min_memory_mb: (dd && dd.minMemMB) || 96,
        min_memory_mb_ram: (dd && dd.ramMinMemMB) || 128,
        tcg_cache_mb: dd && dd.tcgTbSizeMB !== undefined ? dd.tcgTbSizeMB : (set.tcgTbSizeMB !== undefined ? set.tcgTbSizeMB : null),
      } : undefined;
      // no hardware acceleration: the same steps the GUI shows
      const ah = s.accelHint || null;
      const accelHint = ah ? {
        summary: ah.summary, inside_vm: ah.insideVm, outer_hypervisor: ah.outerLabel || ah.outer || null,
        steps: Object.keys(ah.steps || {}).map((k) => ((ah.labels && ah.labels[k]) || k) + ': ' + (ah.steps[k] || []).join(' ')),
        then_on_this_pc: ah.inner || [], more: ah.readme || null,
        tell_the_user: 'these steps need the user (often on the OUTER host); suggest them, do not try them yourself',
      } : undefined;
      return {
        ready: rd.ready,
        next_step: rd.next_step,
        needs_user: rd.needs_user.length ? rd.needs_user : undefined,
        ready_for_images: ri.ready,
        next_step_for_images: ri.next_step,
        needs_user_for_images: ri.needs_user.length ? ri.needs_user : undefined,
        microvm: mv ? {
          ready: !!mv.ready, kernel: mv.kver || null, accel: mv.accel || null, machine: mv.machine || null,
          reason: mv.reason || undefined, kernel_update_available: !!mv.needsUpdate || undefined,
        } : null,
        microvm_defaults: mvDefaults,
        // lower defaults so everything fits inside another VM (the user turns it on in the GUI)
        light_profile: typeof set.lightProfile === 'boolean' ? set.lightProfile : undefined,
        accel_hint: accelHint,
        manager: { url: c.url, version: s.version || c.version, data_root: s.dataRoot || c.root, started_now: !!c.started, gui: 'the user can watch everything at ' + c.url },
        mcp_server: { pid: process.pid, version: deps.version },
        platform: s.platform ? { os: s.platform.os, arch: s.platform.arch, accel: s.platform.accel } : null,
        prereqs: Object.keys(pr).map((k) => ({ name: k, ok: !!pr[k].ok, required: !!pr[k].required, label: pr[k].label, detail: pr[k].detail, fix: pr[k].ok ? undefined : (pr[k].fix || undefined) })),
        templates: (s.bases || []).map((b) => ({ name: b.name, size_mb: b.size ? Math.round(b.size / 1048576) : null, used_by: b.usedBy || 0, default: !!b.isDefault })),
        limits: s.limits ? { max_memory_mb: s.limits.maxMem, default_memory_mb: s.limits.defaultMem, max_cpus: s.limits.maxCpus, default_cpus: s.limits.defaultCpus } : null,
        host: s.host ? { memory_free_mb: Math.round(s.host.memFree / 1048576), disk_free_gb: s.host.diskFree ? Math.round(s.host.diskFree / 1073741824) : null } : null,
        vms: (s.vms || []).map((v) => ({ name: v.name, status: v.status, ephemeral: !!v.ephemeral, created_by: v.createdBy || null, busy_task: v.busy || null })),
        containers: Array.isArray(s.containers)
          ? s.containers.map((r) => ({ id: r.id, name: r.name, image: r.image, status: r.status, exit_code: r.exitCode === undefined ? null : r.exitCode, rootfs: containerMod.rootfsOf(r), busy_task: r.busy || null }))
          : undefined,
        running_tasks: ((s.tasks && s.tasks.running) || []).map((t) => ({ task_id: t.id, title: t.title, vm: t.vm, container: t.ctr || undefined, step: t.step })),
        warning: s.stateWarning || undefined,
      };
    },
  });

  // ---------------------------------------------------------------- list_vms
  tool({
    name: 'list_vms',
    title: 'List VMs',
    description: 'List every VM with its status (stopped | booting | running | stopping | missing | error), SSH port and command, memory/CPUs, ' +
      'template, whether it is temporary (ephemeral) and who created it, its port forwards (URL and whether each is reachable from this PC only ' +
      'or from the LAN), snapshots, the task currently working on it (busy_task) and its last error.',
    params: {},
    annotations: RO,
    handler: async () => {
      const c = await conn();
      const s = await getState(c);
      const vms = (s.vms || []).map(summarizeVm);
      return { count: vms.length, vms: vms };
    },
  });

  // --------------------------------------------------------------- create_vm
  tool({
    name: 'create_vm',
    title: 'Create a VM',
    description: 'Create a new sandbox VM and boot it: Alpine Linux with root access, a thin copy of a template (created in seconds), waiting until ' +
      'SSH is up (usually 15-30 s; up to 2-3 minutes on a PC without hardware acceleration). Returns the VM name to use with exec, write_file, read_file, upload, download, forward_port and delete_vm. ' +
      'The default template has git, python3, gcc, make, bash and curl; install more with exec("apk add ..."). ' +
      'By default the VM is temporary (ephemeral=true): cleanup deletes it. docker=true gives a VM with Docker running (uses a "docker-ready" ' +
      'template when one exists, otherwise installs Docker after boot, adding 1-3 minutes). If the system is not set up yet this fails with a ' +
      'message telling you to call setup. If it takes longer than timeout_s it returns {status:"running", task_id} and the VM keeps booting ' +
      '(follow it with get_task).',
    params: {
      name: { type: 'string', description: 'Name for the new VM: 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit. Omit for an automatic name like claude-3fa9c1.' },
      template: { type: 'string', description: 'Template (base image) to clone. Omit for the default "devbox-base". status lists the templates.' },
      memory_mb: { type: 'integer', minimum: 256, maximum: 262144, description: 'Memory in MB. Default: the manager\'s default (status.limits.default_memory_mb: 1024, or 512 with the light profile), 2048 with docker=true; the maximum depends on this PC (status.limits).' },
      cpus: { type: 'integer', minimum: 1, maximum: 256, description: 'Virtual CPUs. Default 2 (at most the number of CPUs of this PC).' },
      docker: { type: 'boolean', default: false, description: 'Make sure Docker (and docker compose) is installed and running in the VM.' },
      ephemeral: { type: 'boolean', default: true, description: 'Mark the VM as temporary so cleanup removes it. Set false only when the user wants to keep the VM.' },
      wait: P.wait('SSH is up (and Docker, with docker=true)'),
      timeout_s: P.timeout(300, 3600, 'for the VM (and Docker) to be ready'),
    },
    annotations: ann({}),
    handler: async (a) => {
      const c = await conn();
      const t0 = Date.now();
      const s = await getState(c);
      const names = new Set((s.vms || []).map((v) => v.name));
      if (a.name && names.has(a.name)) throw new ToolError('a VM called "' + a.name + '" already exists - use it (list_vms), or pick another name');
      const bases = (s.bases || []).map((b) => b.name);
      if (!a.template && bases.indexOf('devbox-base') === -1) {
        const rd = readiness(s);
        throw new ToolError('the sandbox system is not set up yet (no base image). ' + rd.next_step +
          (rd.needs_user.length ? ' Needs the user: ' + rd.needs_user.map((n) => n.item + ' - ' + n.fix).join('; ') : ''));
      }
      if (a.template && bases.indexOf(a.template) === -1) {
        throw new ToolError('no template called "' + a.template + '" - available: ' + (bases.join(', ') || 'none (call setup)'));
      }
      let template = a.template || null;
      if (a.docker && !template && bases.indexOf('docker-ready') !== -1) template = 'docker-ready';
      // Docker is checked even on a docker-ready clone: its daemon starts
      // after sshd, and a template made from a VM whose Docker was not enabled
      // at boot would otherwise be reported as "docker: true" while nothing
      // answers. On such a clone the install task only starts/waits for the
      // daemon (no download) and returns the real version.
      const needDocker = !!a.docker;
      let mem = a.memory_mb;
      if (mem === undefined && a.docker) mem = Math.min(2048, (s.limits && s.limits.maxMem) || 2048);
      let name = a.name;
      while (!name || names.has(name)) name = 'claude-' + crypto.randomBytes(3).toString('hex');

      const body = { name: name, start: true, waitS: bootWaitS(a.timeout_s), ephemeral: a.ephemeral, createdBy: CREATED_BY, note: 'created by Claude (MCP)' };
      if (template) body.template = template;
      if (mem !== undefined) body.mem = mem;
      if (a.cpus !== undefined) body.cpus = a.cpus;
      const r = await api(c, 'POST', '/api/vm/create', body);
      const createId = r.task.id;
      let dockerTaskId = null;

      // create+boot, then (if needed) Docker. When Docker has to be installed
      // afterwards, this keeps going after the call returns (wait=false or a
      // timeout) so the VM still gets Docker; otherwise it stops polling at
      // the deadline - the manager's task runs on regardless.
      const deadline = t0 + a.timeout_s * 1000;
      const work = !a.wait && !needDocker ? null : (async () => {
        const created = await deps.waitForTask(c, createId, {
          timeoutMs: needDocker ? BACKGROUND_WAIT_MS : Math.max(0, deadline - Date.now()), pollMs: deps.pollMs,
        });
        if (created.status !== 'done' || !needDocker) return { created: created };
        const d = await c.post('/api/vm/docker/install', { name: name });
        dockerTaskId = d.task.id;
        const docker = await deps.waitForTask(c, dockerTaskId, { timeoutMs: BACKGROUND_WAIT_MS, pollMs: deps.pollMs });
        return { created: created, docker: docker };
      })();
      if (work) work.catch((e) => logErr('create_vm ' + name + ': ' + ((e && e.message) || e)));

      const base = { name: name, template: template || 'devbox-base', ephemeral: a.ephemeral };
      const pending = (hint) => Object.assign({ status: 'running', task_id: dockerTaskId || createId }, base,
        { docker_pending: needDocker && !dockerTaskId ? true : undefined, hint: hint });
      if (!a.wait) {
        return pending('the VM is being created and booted' + (needDocker ? ' (Docker is installed afterwards as a second task)' : '') +
          ' - call get_task with this task_id, or list_vms, until it is running');
      }
      let out;
      try { out = await withDeadline(work, deadline); }
      catch (e) { throw apiFail(e, root()); }
      if (out !== TIMEOUT && out.created.status === 'running') out = TIMEOUT;
      if (out === TIMEOUT) {
        return pending('not ready after ' + a.timeout_s + ' s - it continues in the background' +
          (needDocker && !dockerTaskId ? ' (Docker is installed after boot)' : '') + '; call get_task with this task_id to follow it');
      }
      if (out.created.status === 'error') {
        let exists = false;
        try { exists = ((await getState(c)).vms || []).some((v) => v.name === name); } catch (e) { /* unknown */ }
        throw new ToolError('creating VM "' + name + '" failed: ' + out.created.error + logTail(out.created, 8) +
          (exists ? '\nThe VM exists but is not usable: serial_log("' + name + '") shows its console; delete_vm("' + name + '") removes it.' : ''));
      }
      if (out.docker && out.docker.status === 'error') {
        throw new ToolError('VM "' + name + '" is running, but installing Docker failed: ' + out.docker.error + logTail(out.docker, 8) +
          '\nRetry with exec("' + name + '", "apk add docker docker-cli-compose && rc-update add docker default && service docker start").');
      }
      const res = out.created.result || {};
      let v = null;
      try { v = ((await getState(c)).vms || []).find((x) => x.name === name) || null; } catch (e) { /* reported below as unknown */ }
      return {
        status: 'done',
        name: name,
        vm_status: v ? v.status : 'running',
        ssh: (v && v.sshCommand) || res.ssh || null,
        ssh_port: (v && v.port) || res.port || null,
        template: base.template,
        memory_mb: v ? v.mem : mem,
        cpus: v ? v.cpus : a.cpus,
        accel: res.accel || (v && v.effectiveAccel) || null,
        ephemeral: a.ephemeral,
        docker: a.docker ? (out.docker && out.docker.result ? out.docker.result.version || true : true) : false,
        task_id: createId,
        next: 'Run commands with exec(name="' + name + '", command="..."). Delete it with delete_vm when you are done.',
      };
    },
  });

  // ------------------------------------------------------------------- setup
  tool({
    name: 'setup',
    title: 'One-time setup',
    description: 'One-time setup of the sandbox system. images_only=true sets up only what run_image needs - QEMU (installed automatically on ' +
      'Windows when missing) and the microVM kernel (about 43 MB, verified) - in about a minute. The default sets up everything: also the SSH ' +
      'key, the Alpine Linux cloud image (about 200 MB) and the base image every VM is cloned from (bake), about 5-20 minutes (network and ' +
      'CPU). Steps already done are skipped, so calling it again is safe; if what was asked for is ready it returns at once. Call it when ' +
      'status says ready=false (VMs) or ready_for_images=false (run_image). If it takes longer than timeout_s it returns {status:"running", ' +
      'task_id}: it keeps going in the background (follow it with get_task).',
    params: {
      images_only: { type: 'boolean', default: false, description: 'true = only QEMU and the microVM kernel (enough for run_image; about a minute). false = everything, including the base image for create_vm.' },
      wait: P.wait('setup has finished'),
      timeout_s: P.timeout(1800, 7200, 'for setup'),
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const s = await getState(c);
      const rd = readiness(s);
      const ri = imageReadiness(s);
      // a kernel update (no download) counts as not ready: live shared
      // folders in containers need it
      const imagesDone = ri.ready && !ri.needs_update;
      const supported = ri.supported !== false;
      if (a.images_only) {
        if (!supported) throw new ToolError(ri.next_step);
        if (imagesDone) return { status: 'done', already_set_up: true, next_step: ri.next_step };
        if (ri.needs_user.length) {
          throw new ToolError('setup cannot continue until the user installs: ' + ri.needs_user.map((n) => n.item + (n.fix ? ' (' + n.fix + ')' : '')).join('; '));
        }
        const out = await runTask(c, '/api/setup', { only: 'microvm' }, { wait: a.wait, timeoutS: a.timeout_s, what: 'setup for Docker images' });
        if (out.status === 'done') out.next_step = 'Ready: run_image runs a Docker image in seconds.' + (rd.ready ? '' : ' Full VMs (create_vm) still need setup() without images_only.');
        return out;
      }
      if (rd.ready && (imagesDone || !supported)) return { status: 'done', already_set_up: true, next_step: rd.next_step };
      if (rd.needs_user.length) {
        throw new ToolError('setup cannot continue until the user installs: ' + rd.needs_user.map((n) => n.item + (n.fix ? ' (' + n.fix + ')' : '')).join('; '));
      }
      // VMs ready, only the kernel missing: the short form does exactly that
      const body = rd.ready && supported ? { only: 'microvm' } : {};
      const out = await runTask(c, '/api/setup', body, { wait: a.wait, timeoutS: a.timeout_s, what: 'setup' });
      if (out.status === 'done') out.next_step = 'Ready: call create_vm for a Linux VM, or run_image to run a Docker image.';
      return out;
    },
  });

  // ---------------------------------------------------------------- start_vm
  tool({
    name: 'start_vm',
    title: 'Start a VM',
    description: 'Start (boot) an existing VM and wait until SSH is up (usually 15-30 s; up to 2-3 minutes without hardware acceleration). Calling it for a VM that is already running is fine: it ' +
      'returns at once (or waits for a VM that is still booting). If it takes longer than timeout_s it returns {status:"running", task_id}.',
    params: {
      name: P.vmName,
      wait: P.wait('SSH is up'),
      timeout_s: P.timeout(300, 1800, 'for SSH'),
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const t0 = Date.now();
      let r;
      try { r = await c.post('/api/vm/start', { name: a.name, waitS: bootWaitS(a.timeout_s) }); }
      catch (e) {
        if (e && e.code !== 'RUNNING') throw apiFail(e, root());
        // already running (or booting): wait for SSH if asked
        for (;;) {
          const { vm } = await findVm(c, a.name);
          if (vm.status === 'running' || !a.wait || Date.now() - t0 >= a.timeout_s * 1000 || vm.status !== 'booting') {
            return { status: vm.status === 'running' ? 'done' : 'running', name: a.name, vm_status: vm.status, already_running: true, ssh: vm.sshCommand, ssh_port: vm.port };
          }
          await new Promise((res) => setTimeout(res, Math.min(2000, deps.pollMs * 2)));
        }
      }
      if (!a.wait) return { status: 'running', task_id: r.task.id, name: a.name, hint: 'booting - call get_task with this task_id to follow it' };
      const out = taskOutcome(await waitTask(c, r.task.id, a.timeout_s * 1000), 'starting "' + a.name + '"', a.timeout_s);
      if (out.status !== 'done') return Object.assign(out, { name: a.name });
      const res = out.result || {};
      return { status: 'done', name: a.name, vm_status: 'running', ssh: res.ssh, ssh_port: res.port, accel: res.accel || null, task_id: out.task_id };
    },
  });

  // ----------------------------------------------------------------- stop_vm
  tool({
    name: 'stop_vm',
    title: 'Stop a VM',
    description: 'Shut a VM down cleanly (poweroff inside the guest, then ACPI power-off, then QEMU quit; about a minute at most). force=true ' +
      'pulls the plug at once (unsaved data inside the guest may be lost). The VM and its disk are kept; start_vm boots it again.',
    params: {
      name: P.vmName,
      force: { type: 'boolean', default: false, description: 'Stop immediately without a clean guest shutdown.' },
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const out = await runTask(c, '/api/vm/stop', { name: a.name, force: a.force }, { wait: true, timeoutS: 180, what: 'stopping "' + a.name + '"' });
      if (out.status !== 'done') return Object.assign(out, { name: a.name });
      return { status: 'done', name: a.name, stopped: true, how: out.result && out.result.how, task_id: out.task_id };
    },
  });

  // --------------------------------------------------------------- delete_vm
  tool({
    name: 'delete_vm',
    title: 'Delete a VM',
    description: 'Permanently delete a VM: stops it if it is running, then removes its disk, logs and record. Everything inside the VM is lost. ' +
      'Only delete VMs you created in this session, or VMs the user asked you to delete.',
    params: { name: P.vmName },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const out = await runTask(c, '/api/vm/delete', { name: a.name }, { wait: true, timeoutS: 180, what: 'deleting "' + a.name + '"' });
      if (out.status !== 'done') return Object.assign(out, { name: a.name });
      return { status: 'done', name: a.name, deleted: true, task_id: out.task_id };
    },
  });

  // ---------------------------------------------------------------- reset_vm
  tool({
    name: 'reset_vm',
    title: 'Reset a VM to its template',
    description: 'Reset a VM to a fresh copy of its template: every change made inside the VM is discarded (its settings and port forwards are ' +
      'kept); a running VM is restarted. Use it when an experiment left the VM in a bad state. Only for VMs you created or the user named.',
    params: {
      name: P.vmName,
      timeout_s: P.timeout(300, 1800, 'for the reset (and reboot)'),
    },
    annotations: ann({ destructiveHint: true }),
    handler: async (a) => {
      const c = await conn();
      const out = await runTask(c, '/api/vm/reset', { name: a.name }, { wait: true, timeoutS: a.timeout_s, what: 'resetting "' + a.name + '"' });
      return Object.assign(out, { name: a.name });
    },
  });

  // -------------------------------------------------------------------- exec
  tool({
    name: 'exec',
    title: 'Run a command in a VM',
    description: 'Run a shell command inside a running VM over SSH and return exit_code, stdout and stderr. The command runs with /bin/sh ' +
      '(BusyBox ash) as root (or as user "dev"), in the home directory unless workdir is set; use bash -c \'...\' for bash syntax. Install ' +
      'packages with apk add <package>. stdout and stderr are capped at 100 KB each (the first 20 KB and the last 80 KB are kept, with a ' +
      'marker; truncated says so). A non-zero exit_code is a normal result, not a tool failure. When timeout_s passes, the SSH session is ' +
      'closed and timed_out is true (a process that ignores the hang-up may keep running in the VM). To leave a server running, detach it ' +
      'AND redirect its output, e.g. nohup python3 -m http.server 8000 >/tmp/http.log 2>&1 & - otherwise the call waits for it to exit.',
    params: {
      name: P.vmName,
      command: { type: 'string', required: true, minLength: 1, description: 'Shell command(s) to run; several lines are allowed.' },
      timeout_s: { type: 'integer', default: 300, minimum: 1, maximum: 7200, description: 'Seconds before the command is abandoned (timed_out: true).' },
      user: { type: 'string', enum: ['root', 'dev'], default: 'root', description: 'Run as root or as the unprivileged user "dev".' },
      workdir: { type: 'string', description: 'Directory to run in (absolute, or ~/relative). Default: the user\'s home directory.' },
      env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables, e.g. {"NODE_ENV": "test"}.' },
      stdin: { type: 'string', description: 'Text fed to the command\'s standard input.' },
    },
    annotations: ann({ destructiveHint: true }),
    handler: async (a) => {
      const c = await conn();
      const { vm } = await runningVm(c, a.name);
      const cmd = buildExecCommand(a.command, { workdir: a.workdir, env: a.env });
      const r = await sshRun(vm, cmd, {
        user: a.user, timeoutMs: a.timeout_s * 1000, input: a.stdin,
        maxBytes: OUTPUT_CAP, headShare: OUTPUT_HEAD_SHARE,
      });
      const out = {
        exit_code: r.timedOut ? null : r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_s: secs(r.durationMs || 0),
        truncated: !!r.truncated,
        timed_out: !!r.timedOut,
      };
      if (r.timedOut) out.note = 'the command did not finish within ' + a.timeout_s + ' s and its SSH session was closed';
      return out;
    },
  });

  // -------------------------------------------------------------- write_file
  tool({
    name: 'write_file',
    title: 'Write a file in a VM',
    description: 'Write a file inside a running VM (as root), creating missing parent directories. content is UTF-8 text, or base64 when ' +
      'encoding is "base64". An existing file is overwritten and keeps its permissions unless mode is given. For directories or big files ' +
      'from this PC use upload.',
    params: {
      name: P.vmName,
      path: { type: 'string', required: true, minLength: 1, description: 'Destination path in the VM (absolute, or ~/relative to /root).' },
      content: { type: 'string', required: true, description: 'The file content (may be empty).' },
      encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8', description: 'How content is encoded.' },
      mode: { type: 'string', pattern: '^[0-7]{3,4}$', description: 'Octal permissions to set, e.g. "755" for a script. Default: unchanged (new files 644).' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      checkRemotePath(a.path, 'path');
      if (a.encoding === 'base64' && !/^[A-Za-z0-9+/=\s]*$/.test(a.content)) throw new ToolError('content is not valid base64');
      const buf = Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8');
      const c = await conn();
      const { vm } = await runningVm(c, a.name);
      const cmd = 'f=' + remotePathExpr(a.path) + '\n' +
        'mkdir -p "$(dirname "$f")" && cat > "$f"' + (a.mode ? ' && chmod ' + a.mode + ' "$f"' : '') + ' && wc -c < "$f"';
      const r = await sshRun(vm, cmd, { input: buf, timeoutMs: 120000 });
      if (r.code !== 0) throw new ToolError('could not write ' + a.path + ' in "' + a.name + '": ' + (lastLines(r.stderr) || 'exit code ' + r.code));
      const written = parseInt(String(r.stdout).trim().split(/\s+/).pop(), 10);
      if (written !== buf.length) throw new ToolError('wrote ' + written + ' bytes to ' + a.path + ' but expected ' + buf.length);
      return { name: a.name, path: a.path, bytes: buf.length, mode: a.mode || null };
    },
  });

  // --------------------------------------------------------------- read_file
  tool({
    name: 'read_file',
    title: 'Read a file from a VM',
    description: 'Read a file from a running VM. Returns UTF-8 text in content, or base64 (encoding: "base64") when the file is binary. At most ' +
      'max_bytes are returned; truncated is true when the file is longer and size gives its full size. For big files or directories use download.',
    params: {
      name: P.vmName,
      path: { type: 'string', required: true, minLength: 1, description: 'Path of the file in the VM (absolute, or ~/relative to /root).' },
      max_bytes: { type: 'integer', default: 200000, minimum: 1, maximum: 5000000, description: 'Return at most this many bytes from the start of the file.' },
    },
    annotations: RO,
    handler: async (a) => {
      checkRemotePath(a.path, 'path');
      const c = await conn();
      const { vm } = await runningVm(c, a.name);
      const cmd = 'f=' + remotePathExpr(a.path) + '\n' +
        'if [ -d "$f" ]; then echo "$f is a directory (list it with exec, or use download)" >&2; exit 3; fi\n' +
        'if [ ! -e "$f" ]; then echo "no such file: $f" >&2; exit 2; fi\n' +
        'wc -c < "$f" || exit 4\n' +
        'head -c ' + a.max_bytes + ' "$f" | base64';
      const r = await sshRun(vm, cmd, { timeoutMs: 120000, maxBytes: a.max_bytes * 2 + 65536 });
      if (r.code !== 0) throw new ToolError('could not read ' + a.path + ' in "' + a.name + '": ' + (lastLines(r.stderr) || 'exit code ' + r.code));
      let parsed;
      try { parsed = parseReadOutput(r.stdout); } catch (e) { throw new ToolError('could not read ' + a.path + ': ' + e.message); }
      const truncated = parsed.size > parsed.bytes.length;
      const d = decodeFileBytes(parsed.bytes, truncated);
      return { name: a.name, path: a.path, size: parsed.size, returned_bytes: parsed.bytes.length, truncated: truncated, encoding: d.encoding, content: d.content };
    },
  });

  // ------------------------------------------------------------------ upload
  tool({
    name: 'upload',
    title: 'Copy from this PC into a VM',
    description: 'Copy a file or a whole directory from this PC into a running VM (as root). local_path must be an absolute path on this PC. ' +
      'For a file, remote_path is the destination file, or an existing directory (or a path ending in /) to copy it into. For a directory, ' +
      'remote_path is the destination directory: it is created if needed and receives the directory\'s contents. Existing files are overwritten. ' +
      'The VM manager\'s own private files (its access token, SSH key, registry and disks) and ~/.ssh are never copied into a VM, nor a folder containing them.',
    params: {
      name: P.vmName,
      local_path: { type: 'string', required: true, minLength: 1, description: 'Absolute path of the file or directory on this PC.' },
      remote_path: { type: 'string', required: true, minLength: 1, description: 'Destination in the VM (absolute, or ~/relative to /root).' },
      timeout_s: { type: 'integer', default: 600, minimum: 5, maximum: 7200, description: 'Seconds before the transfer is abandoned.' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const local = checkLocalPath(a.local_path, 'local_path');
      checkRemotePath(a.remote_path, 'remote_path');
      let st;
      try { st = fs.statSync(local); } catch (e) { throw new ToolError('local_path does not exist: ' + local); }
      if (!st.isFile() && !st.isDirectory()) throw new ToolError('local_path is neither a file nor a directory: ' + local);
      guardLocalPath(local, 'local_path', 'read', st.isDirectory(), deps.localEnv());
      const c = await conn();
      const { vm } = await runningVm(c, a.name);
      const t0 = Date.now();
      const timeoutMs = a.timeout_s * 1000;
      if (st.isFile()) {
        const base = path.basename(local);
        const cmd = 'f=' + remotePathExpr(a.remote_path) + '\n' +
          'case "$f" in */) f="$f"' + shq(base) + ';; esac\n' +
          'if [ -d "$f" ]; then f="$f/"' + shq(base) + '; fi\n' +
          'mkdir -p "$(dirname "$f")" && cat > "$f" && printf "%s\\n" "$f" && wc -c < "$f"';
        const child = sshChild(sshTarget(vm), cmd);
        const done = watchChild(child, true);
        const src = fs.createReadStream(local);
        child.stdin.on('error', () => { /* the remote side failed first: reported by its exit code */ });
        src.pipe(child.stdin);
        const sup = await supervise([{ child: child, done: done }], { sources: [src], timeoutMs: timeoutMs });
        const r = sup.results[0];
        if (sup.timedOut) throw new ToolError('upload of ' + local + ' timed out after ' + a.timeout_s + ' s');
        if (sup.streamErrors.length) throw new ToolError('could not read ' + local + ': ' + sup.streamErrors[0].message);
        if (r.code !== 0) throw new ToolError('upload to "' + a.name + '" failed: ' + (lastLines(r.stderr) || 'exit code ' + r.code));
        const lines = r.stdout.trim().split(/\r?\n/);
        const bytes = parseInt(lines.pop(), 10);
        if (bytes !== st.size) throw new ToolError('the VM received ' + bytes + ' bytes but ' + local + ' has ' + st.size);
        return { name: a.name, kind: 'file', local_path: local, remote_path: lines.pop() || a.remote_path, bytes: bytes, duration_s: secs(Date.now() - t0) };
      }
      // a directory: tar on this PC -> ssh -> tar in the guest
      const tarBin = deps.findLocalTar();
      if (!tarBin) {
        const r = await deps.ssh.scp(sshTarget(vm), local, a.remote_path, { direction: 'up', recursive: true, timeoutMs: timeoutMs });
        if (r.code !== 0) throw new ToolError('upload (scp) to "' + a.name + '" failed: ' + (lastLines(r.stderr) || 'exit code ' + r.code));
        return { name: a.name, kind: 'directory', local_path: local, remote_path: a.remote_path, method: 'scp', duration_s: secs(Date.now() - t0),
          note: 'no tar on this PC: copied with scp -r (if remote_path already existed, the directory was placed inside it)' };
      }
      const tar = deps.spawn(tarBin, ['-c', '-f', '-', '-C', local, '.'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const tarDone = watchChild(tar, false);
      const child = sshChild(sshTarget(vm), 'd=' + remotePathExpr(a.remote_path) + '\nmkdir -p "$d" && tar -x -o -f - -C "$d" && printf "%s\\n" "$(cd "$d" && pwd)"');
      const sshDone = watchChild(child, true);
      child.stdin.on('error', () => { /* reported by the exit codes */ });
      let sent = 0;
      tar.stdout.on('data', (d) => { sent += d.length; });
      tar.stdout.pipe(child.stdin);
      const sup = await supervise([{ child: tar, done: tarDone }, { child: child, done: sshDone }], { timeoutMs: timeoutMs });
      if (sup.timedOut) throw new ToolError('upload of ' + local + ' timed out after ' + a.timeout_s + ' s');
      const [lt, rs] = sup.results;
      if (rs.code !== 0) throw new ToolError('upload to "' + a.name + '" failed in the VM: ' + (lastLines(rs.stderr) || 'exit code ' + rs.code));
      if (lt.code !== 0) throw new ToolError('packing ' + local + ' failed: ' + (lastLines(lt.stderr) || 'exit code ' + lt.code));
      return { name: a.name, kind: 'directory', local_path: local, remote_path: rs.stdout.trim() || a.remote_path, bytes_sent: sent, duration_s: secs(Date.now() - t0) };
    },
  });

  // ---------------------------------------------------------------- download
  tool({
    name: 'download',
    title: 'Copy from a VM to this PC',
    description: 'Copy a file or a whole directory from a running VM to this PC. local_path must be an absolute path on this PC. For a file, ' +
      'local_path is the destination file, or an existing directory to copy it into. For a directory, local_path is the destination directory: ' +
      'it is created if needed and receives the directory\'s contents. Existing files are overwritten. Downloads never write into the VM ' +
      'manager\'s data or program folders, ~/.ssh or a Windows Startup folder (a directory goes into a folder of its own).',
    params: {
      name: P.vmName,
      remote_path: { type: 'string', required: true, minLength: 1, description: 'File or directory in the VM (absolute, or ~/relative to /root).' },
      local_path: { type: 'string', required: true, minLength: 1, description: 'Absolute destination path on this PC.' },
      timeout_s: { type: 'integer', default: 600, minimum: 5, maximum: 7200, description: 'Seconds before the transfer is abandoned.' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      let local = checkLocalPath(a.local_path, 'local_path');
      checkRemotePath(a.remote_path, 'remote_path');
      const env = deps.localEnv();
      guardLocalPath(local, 'local_path', 'write', false, env);
      const c = await conn();
      const { vm } = await runningVm(c, a.name);
      const t0 = Date.now();
      const timeoutMs = a.timeout_s * 1000;
      const expr = remotePathExpr(a.remote_path);
      const probe = await sshRun(vm, 'f=' + expr + '\nif [ -d "$f" ]; then echo dir; elif [ -f "$f" ]; then echo file; elif [ -e "$f" ]; then echo other; else echo missing; fi', { timeoutMs: 30000 });
      const kind = String(probe.stdout).trim();
      if (kind === 'missing') throw new ToolError('no such file or directory in "' + a.name + '": ' + a.remote_path);
      if (kind === 'other') throw new ToolError(a.remote_path + ' is not a regular file or directory');
      if (kind !== 'file' && kind !== 'dir') throw new ToolError('could not inspect ' + a.remote_path + ': ' + (lastLines(probe.stderr) || kind || 'no answer'));
      if (kind === 'file') {
        let isDir = false;
        try { isDir = fs.statSync(local).isDirectory(); } catch (e) { /* new file */ }
        if (isDir) local = guardLocalPath(path.join(local, path.posix.basename(a.remote_path.replace(/\/+$/, ''))), 'local_path', 'write', false, env);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        const tmp = local + '.part';
        const child = sshChild(sshTarget(vm), 'exec cat ' + expr);
        const done = watchChild(child, false);
        const sink = fs.createWriteStream(tmp);
        child.stdout.pipe(sink);
        const sup = await supervise([{ child: child, done: done }], { sinks: [sink], timeoutMs: timeoutMs });
        const r = sup.results[0];
        const fail = sup.timedOut ? 'timed out after ' + a.timeout_s + ' s'
          : (sup.streamErrors.length ? 'could not write ' + tmp + ': ' + sup.streamErrors[0].message
            : (r.code !== 0 ? (lastLines(r.stderr) || 'exit code ' + r.code) : null));
        if (fail) { try { fs.rmSync(tmp, { force: true }); } catch (e) { /* best effort */ } throw new ToolError('download of ' + a.remote_path + ' failed: ' + fail); }
        try { fs.renameSync(tmp, local); }
        catch (e) {
          try { fs.rmSync(local, { force: true }); fs.renameSync(tmp, local); }
          catch (e2) { try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ } throw new ToolError('could not save ' + local + ': ' + e2.message); }
        }
        return { name: a.name, kind: 'file', remote_path: a.remote_path, local_path: local, bytes: fs.statSync(local).size, duration_s: secs(Date.now() - t0) };
      }
      // a directory: tar in the guest -> ssh -> tar on this PC (the archive's
      // names come from the guest, so the target must hold nothing protected)
      guardLocalPath(local, 'local_path', 'write', true, env);
      const tarBin = deps.findLocalTar();
      if (!tarBin) {
        const r = await deps.ssh.scp(sshTarget(vm), local, a.remote_path, { direction: 'down', recursive: true, timeoutMs: timeoutMs });
        if (r.code !== 0) throw new ToolError('download (scp) from "' + a.name + '" failed: ' + (lastLines(r.stderr) || 'exit code ' + r.code));
        return { name: a.name, kind: 'directory', remote_path: a.remote_path, local_path: local, method: 'scp', duration_s: secs(Date.now() - t0),
          note: 'no tar on this PC: copied with scp -r (if local_path already existed, the directory was placed inside it)' };
      }
      try { fs.mkdirSync(local, { recursive: true }); } catch (e) { throw new ToolError('cannot create ' + local + ': ' + e.message); }
      const child = sshChild(sshTarget(vm), 'cd ' + expr + ' && exec tar -c -f - .');
      const sshDone = watchChild(child, false);
      const tar = deps.spawn(tarBin, ['-x', '-f', '-', '-C', local], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      const tarDone = watchChild(tar, false);
      tar.stdin.on('error', () => { /* reported by the exit codes */ });
      let got = 0;
      child.stdout.on('data', (d) => { got += d.length; });
      child.stdout.pipe(tar.stdin);
      const sup = await supervise([{ child: child, done: sshDone }, { child: tar, done: tarDone }], { timeoutMs: timeoutMs });
      if (sup.timedOut) throw new ToolError('download of ' + a.remote_path + ' timed out after ' + a.timeout_s + ' s');
      const [rs, lt] = sup.results;
      if (rs.code !== 0) throw new ToolError('download from "' + a.name + '" failed in the VM: ' + (lastLines(rs.stderr) || 'exit code ' + rs.code));
      if (lt.code !== 0) throw new ToolError('unpacking into ' + local + ' failed (some files may be missing): ' + (lastLines(lt.stderr) || 'exit code ' + lt.code));
      return { name: a.name, kind: 'directory', remote_path: a.remote_path, local_path: local, bytes_received: got, duration_s: secs(Date.now() - t0) };
    },
  });

  // ------------------------------------------------------------ forward_port
  tool({
    name: 'forward_port',
    title: 'Forward a port to a VM',
    description: 'Make a TCP port inside a VM reachable from this PC: forwards host_port on this PC to guest_port in the VM and returns the URL ' +
      '(http://127.0.0.1:<host_port>). Applied live on a running VM (a stopped VM gets it when it starts). By default the forward is ' +
      'reachable from THIS PC ONLY; set lan=true only when the user explicitly asks for other devices on their network to reach it (Windows ' +
      'Firewall may ask them once). Calling it again for the same guest port returns the existing forward, or switches its exposure when lan ' +
      'differs. host_port defaults to guest_port (ports below 1024 map to 8000+port, e.g. 80 -> 8080), moving up to the next free port if taken.',
    params: {
      name: P.vmName,
      guest_port: { type: 'integer', required: true, minimum: 1, maximum: 65535, description: 'Port the service listens on inside the VM.' },
      host_port: { type: 'integer', minimum: 1024, maximum: 65535, description: 'Port on this PC. Omit to pick one automatically.' },
      lan: { type: 'boolean', default: false, description: 'true = also reachable from other devices on the network (only when the user asks). false = this PC only.' },
    },
    annotations: ann({ idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const { vm, state: s } = await findVm(c, a.name);
      const rows = (vm.ports || []).map((p) => {
        const o = { host: p.host, guest: p.guest, lan: !!p.lan };
        if (p.container) o.container = p.container;
        if (p.owner) o.owner = p.owner;
        return o;
      });
      const reply = (row, applied, extra) => {
        const o = Object.assign({ name: a.name }, describeForward(row, row.lan ? addrs() : null), { applied: applied });
        if (applied === 'saved') o.note = 'the VM is not running - the forward is active once it starts';
        else if (applied === 'restart') o.note = 'saved, but it could not be applied live - restart the VM (stop_vm, then start_vm) to activate it';
        else if (applied === 'unchanged') o.note = 'this forward already existed';
        if (row.lan && applied !== 'unchanged') o.firewall = 'Windows Firewall may ask the user once to allow QEMU on the network';
        return Object.assign(o, extra || {});
      };
      // {add: [row]}: the manager applies it to the VM's CURRENT forwards under
      // its lock - sending the whole list read a moment ago would silently
      // close a forward added meanwhile (a parallel forward_port, a deploy)
      // Another port change on this VM (e.g. Claude calling forward_port for
      // two ports at once) holds the VM's lock for a moment: wait for it
      // instead of failing with "busy". Any other task (a boot, a deploy)
      // is reported as before.
      const postPorts = async (body) => {
        const t0 = Date.now();
        for (;;) {
          try { return await c.post('/api/vm/ports', body); }
          catch (e) {
            const h = e && e.body && e.body.holder;
            if (e && e.status === 409 && e.code === 'BUSY' && h && h.kind === 'ports' && Date.now() - t0 < 15000) {
              await new Promise((r) => setTimeout(r, 250));
              continue;
            }
            throw e;
          }
        }
      };
      const post = async (row) => {
        try { return await postPorts({ name: a.name, add: [row] }); } catch (e) { throw apiFail(e, root()); }
      };
      const same = rows.find((p) => p.guest === a.guest_port && (a.host_port === undefined || p.host === a.host_port));
      if (same) {
        if (same.lan === a.lan) return reply(same, 'unchanged');
        const row = Object.assign({}, same, { lan: a.lan });
        const r = await post(row);
        return reply(row, r.applied, { warnings: r.warnings && r.warnings.length ? r.warnings : undefined });
      }
      if (a.host_port !== undefined) {
        const row = { host: a.host_port, guest: a.guest_port, lan: a.lan };
        const r = await post(row);
        return reply(row, r.applied, { warnings: r.warnings && r.warnings.length ? r.warnings : undefined });
      }
      const reserved = reservedPorts(s);
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const host = await pickHostPort(a.guest_port, reserved, (p) => deps.platform.isPortFree(p));
        if (!host) break;
        const row = { host: host, guest: a.guest_port, lan: a.lan };
        try {
          const r = await postPorts({ name: a.name, add: [row] });
          return reply(row, r.applied, { warnings: r.warnings && r.warnings.length ? r.warnings : undefined });
        } catch (e) {
          // taken between our check and the manager's: try the next one
          if (e && e.status === 409 && /PORT/.test(String(e.code))) { reserved.add(host); lastErr = e; continue; }
          throw apiFail(e, root());
        }
      }
      throw new ToolError('could not find a free port on this PC for guest port ' + a.guest_port + (lastErr ? ': ' + lastErr.message : '') + ' - pass host_port explicitly');
    },
  });

  // -------------------------------------- live shared folders (lib/mcp/shares.js)
  for (const t of shareMod.shareTools(h)) tool(t);

  // ------------------------- Docker images as microVMs (lib/mcp/containers.js)
  for (const t of containerMod.containerTools(h)) tool(t);

  // ------------------------------------------------------------ deploy_image
  // engine "auto" (spec 13): a microVM when the image can run that way,
  // otherwise Docker inside a new VM - followed automatically, never
  // silently: the result names the engine and why.
  tool({
    name: 'deploy_image',
    title: 'Run a Docker image in one step',
    description: 'Run a Docker image as a server in one step and get its URLs (http://127.0.0.1:<port>). engine="auto" (default) runs it as a ' +
      'microVM (its own small VM, no Docker Engine; seconds - like run_image) when it can, and otherwise - or when privileged=true - ' +
      'automatically with Docker inside a brand-new full VM (creates the VM, installs Docker, pulls the image; 2-10 minutes, about 2 GB of ' +
      'RAM); the result says which (engine, fallback_reason). engine="microvm" never falls back; engine="docker-vm" always uses a full VM with ' +
      'Docker - for images that need a real Docker Engine (privileged, docker.sock) or when the user wants a VM around the container (docker ' +
      'compose stacks: create_vm with docker=true, then exec "docker compose up -d"). ports are "host:container" entries such as "8080:80" ' +
      '(default: the ports the image declares). Ports are reachable from this PC only unless lan=true (only when the user asks). As a microVM ' +
      'it uses the disk root by default (about 128 MB of RAM, more for the databases and Java apps it recognises - pass memory_mb for other ' +
      'memory-hungry apps; files kept until the container is removed); rootfs="ram" only when the user asks. For a one-shot ' +
      'command, its output or a custom command line use run_image. If it fails in a full VM, the half-built VM is deleted. If it takes longer ' +
      'than timeout_s it returns {status:"running", task_id} (follow it with get_task). What it creates is temporary by default (cleanup removes it).',
    params: {
      image: { type: 'string', required: true, minLength: 1, description: 'Image reference, e.g. "nginx:alpine", "ghcr.io/owner/app:1.2".' },
      engine: { type: 'string', enum: ['auto', 'microvm', 'docker-vm'], default: 'auto', description: '"auto": a microVM when possible, else Docker in a new VM. "microvm": only a microVM. "docker-vm": Docker inside a new full VM.' },
      name: { type: 'string', description: 'Name for the new container (microVM) or VM (docker-vm). Default: derived from the image (made unique).' },
      ports: { type: 'array', items: { type: 'string' }, description: 'Published ports as "host:container" (e.g. ["8080:80"]) or a single port "3000" (same on both sides).' },
      env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables for the container, e.g. {"POSTGRES_PASSWORD": "secret"}.' },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Named volumes "volume-name:/path" (both engines). An absolute path on the left is a folder of THIS PC shared live with a microVM ("C:\\dir:/path"), but a folder INSIDE the VM with engine="docker-vm" ("/srv/data:/path").' },
      lan: { type: 'boolean', default: false, description: 'true = the app is also reachable from other devices on the network (only when the user asks).' },
      privileged: { type: 'boolean', default: false, description: 'Run the container privileged (only if the image needs it). Needs Docker in a full VM: with engine "auto" it selects docker-vm.' },
      ephemeral: { type: 'boolean', default: true, description: 'Mark the container or VM as temporary so cleanup removes it.' },
      // 96: the manager's floor for a disk-root microVM (it checks 128 for
      // rootfs "ram"). A full VM needs at least 256: engine "docker-vm" is
      // refused below that, and an "auto" fallback to a full VM drops a
      // smaller value (it was meant for the microVM) - the VM gets its default
      memory_mb: { type: 'integer', minimum: 96, maximum: 262144, description: 'Memory in MB: of the microVM (default: 128 MB with the disk root whatever the image size, more for apps known to need it - PostgreSQL 256, MySQL/MariaDB/MongoDB/Java apps 512, Elasticsearch 1024; at least 96, or 128 with rootfs="ram", whose default is computed from the image size) or of the full VM (default 2048, at least 256; a value below 256 with engine="auto" applies to the microVM only). Leave it out unless the app needs more - other databases and JVM apps want 512 or more.' },
      cpus: { type: 'integer', minimum: 1, maximum: 256, description: 'Virtual CPUs of a full VM (default 2). microVMs use 1.' },
      // microVM only: a full VM with Docker has its own disk anyway
      rootfs: Object.assign({}, containerMod.ROOTFS_PARAM, { description: containerMod.ROOTFS_PARAM.description + ' microVM only: ignored when it runs with Docker inside a full VM.' }),
      wait: P.wait('the app is running'),
      timeout_s: P.timeout(900, 3600, 'for the deployment'),
    },
    annotations: ann({}),
    handler: async (a) => {
      const engine = a.engine || 'auto';
      const deadline = Date.now() + a.timeout_s * 1000;
      if (a.privileged && engine === 'microvm') throw new ToolError('privileged containers need a real Docker Engine: use engine="docker-vm" (or "auto")');
      if ((engine === 'docker-vm' || a.privileged) && a.memory_mb !== undefined && a.memory_mb < FULL_VM_MIN_MEM_MB) {
        throw new ToolError('memory_mb ' + a.memory_mb + ' is too small for a full VM with Docker (at least ' + FULL_VM_MIN_MEM_MB + ' MB; leave it out for the default)');
      }
      const viaDocker = async (c, why) => {
        const r = await api(c, 'POST', '/api/vm/quickdeploy', quickDeployBody(a));
        return followDeploy(c, r.task, a, deadline, { engine: 'docker-vm', fallback_reason: why || undefined });
      };
      if (engine === 'docker-vm' || a.privileged) {
        const c = await conn();
        return viaDocker(c, engine === 'docker-vm' ? null : 'privileged=true needs Docker inside a full VM');
      }
      // microVM (or auto): folders of this PC are checked before anything starts
      const mounts = containerMod.prepareMounts(a.volumes, [], h.guard);
      const body = containerMod.runBody({
        image: a.image, name: a.name, env: a.env, ports: a.ports && a.ports.length ? a.ports : undefined, lan: a.lan,
        ephemeral: a.ephemeral, memory_mb: a.memory_mb, rootfs: a.rootfs, engine: engine, wait_for: 'ready',
      }, mounts, envList, CONTAINER_CREATED_BY);
      const c = await conn();
      // auto, after the microVM route said no: Docker-in-VM - but a live
      // folder of this PC means something else there (a VM path), so that
      // case is explained instead of guessed
      const fallBack = async (why) => {
        if (mounts.hostFolders.length) {
          throw new ToolError('this image needs Docker inside a full VM (' + why + '), but folders of this PC in volumes are shared live only with ' +
            'microVMs. Deploy it with engine="docker-vm" and named volumes, then share the folder with that VM (share_folder) if it is still needed.');
        }
        try { return await viaDocker(c, why); }
        catch (e) {
          if (e && e.code === 'NO_BASE') {
            throw new ToolError('this image needs Docker inside a full VM (' + why + '), and full VMs are not set up yet -> call setup (5-20 minutes, builds the base image), then retry with engine="docker-vm"');
          }
          throw e;
        }
      };
      const noKernel = async () => {
        try { return await fallBack('the microVM kernel is not installed - setup(images_only=true) installs it in about a minute'); }
        catch (e) {
          if (/full VMs are not set up yet/.test(String(e && e.message))) {
            throw new ToolError('the system is not set up for Docker images yet -> call setup(images_only=true) (about a minute: QEMU if missing, and the ~43 MB microVM kernel), then retry');
          }
          throw e;
        }
      };
      if (!a.wait) {
        let start;
        try { start = await api(c, 'POST', '/api/container/run', body); }
        catch (e) { if (engine === 'auto' && e && e.code === 'NO_KERNEL') return noKernel(); throw e; }
        if (start.engine === 'docker-vm') return followDeploy(c, start.task, a, deadline, { engine: 'docker-vm', fallback_reason: start.reason || undefined });
        const id = containerMod.containerIdOf(start, null);
        return {
          status: 'running', task_id: start.task.id, engine: 'microvm', container: id ? { id: id } : undefined,
          hint: 'starting in the background - call get_task with this task_id (or list_containers) to follow it' +
            (engine === 'auto' ? '; if the image turns out to need Docker, the task says so and deploy_image with engine="docker-vm" runs it' : ''),
        };
      }
      let flow;
      try {
        flow = await containerMod.runImageFlow(h, c, body, {
          image: body.image, waitFor: 'ready', deadline: deadline, timeoutS: a.timeout_s, removeOnExit: false,
          onFallback: engine === 'auto' ? 'return' : 'report',
        });
      } catch (e) {
        if (engine === 'auto' && e && e.code === 'NO_KERNEL') return noKernel();
        throw e;
      }
      if (flow.dockerVm) {
        if (flow.dockerVm.start) return followDeploy(c, flow.dockerVm.start.task, a, deadline, { engine: 'docker-vm', fallback_reason: flow.dockerVm.reason || undefined });
        return fallBack(flow.dockerVm.reason);
      }
      const res = Object.assign({}, flow.result);
      // "running" with a task_id = still starting; without = the app runs
      if (res.status === 'running' && !res.task_id) { res.status = 'done'; res.container_status = 'running'; }
      res.engine = 'microvm';
      return res;
    },
  });

  // ---------------------------------------------------------------- get_task
  tool({
    name: 'get_task',
    title: 'Follow a long operation',
    description: 'Follow a long operation that returned {status:"running", task_id}: returns its status (running | done | error), current step, ' +
      'result (when done), error (when it failed) and the last log lines. Poll every 10-30 s. The manager keeps the last 50 tasks until it restarts.',
    params: {
      task_id: { type: 'string', required: true, minLength: 1, description: 'The task_id returned by the long operation.' },
      log_lines: { type: 'integer', default: 30, minimum: 0, maximum: 2000, description: 'How many of the latest log lines to include.' },
    },
    annotations: RO,
    handler: async (a) => {
      const c = await conn();
      let r;
      try { r = await c.get('/api/task?id=' + encodeURIComponent(a.task_id)); }
      catch (e) {
        if (e && e.status === 404) throw new ToolError('no task with id ' + a.task_id + ' - the manager keeps only the last 50 tasks and forgets them when it restarts; list_vms shows the current state');
        throw apiFail(e, root());
      }
      if (!r.task) throw new ToolError('no task with id ' + a.task_id);
      return summarizeTask(r.task, a.log_lines);
    },
  });

  // -------------------------------------------------------------- serial_log
  tool({
    name: 'serial_log',
    title: 'VM console output',
    description: 'The last lines of a VM\'s serial console: kernel and boot messages, service start-up, the login prompt. Use it to find out why a ' +
      'VM did not boot or why SSH does not come up.',
    params: {
      name: P.vmName,
      lines: { type: 'integer', default: 100, minimum: 1, maximum: 5000, description: 'How many of the last lines to return.' },
    },
    annotations: RO,
    handler: async (a) => {
      const c = await conn();
      const r = await api(c, 'GET', '/api/log?name=' + encodeURIComponent(a.name) + '&tail=' + a.lines);
      return { name: a.name, lines: r.lines, truncated: !!r.truncated, text: r.text };
    },
  });

  // ---------------------------------------------------------------- snapshot
  tool({
    name: 'snapshot',
    title: 'VM disk snapshots',
    description: 'Manage disk snapshots of a VM. action "list" shows them; "create" saves the current disk state under a name; "revert" returns ' +
      'the disk to a snapshot (everything done since is lost); "delete" removes a snapshot. create/revert/delete need the VM to be stopped ' +
      '(stop_vm first). Take a snapshot before a risky experiment and revert to undo it.',
    params: {
      name: P.vmName,
      action: { type: 'string', required: true, enum: ['list', 'create', 'revert', 'delete'], description: 'What to do.' },
      snapshot: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$', description: 'Snapshot name (required for create, revert and delete): letters, digits, ".", "_", "-".' },
    },
    annotations: ann({ destructiveHint: true }),
    handler: async (a) => {
      const c = await conn();
      if (a.action === 'list') {
        const { vm } = await findVm(c, a.name);
        // A 'list' task reads the disk now (qemu-img -U, fine while running);
        // /api/state's copy is refreshed in the background and can lag just
        // after a create. Fall back to it when the VM is busy with a task.
        try {
          const out = await runTask(c, '/api/vm/snapshot', { name: a.name, action: 'list' }, { wait: true, timeoutS: 60, what: 'listing the snapshots of "' + a.name + '"' });
          if (out.status === 'done' && out.result && Array.isArray(out.result.snapshots)) {
            return { name: a.name, vm_status: vm.status, snapshots: out.result.snapshots.map((x) => ({ name: x.name, date: x.date })) };
          }
        } catch (e) { /* busy or unreadable: the state's copy below */ }
        return { name: a.name, vm_status: vm.status, snapshots: vm.snapshots || [], note: 'from the last background read (may lag a few seconds)' };
      }
      if (!a.snapshot) throw new ToolError('snapshot (the snapshot name) is required for ' + a.action);
      const out = await runTask(c, '/api/vm/snapshot', { name: a.name, action: a.action, snapshot: a.snapshot },
        { wait: true, timeoutS: 600, what: a.action + ' snapshot "' + a.snapshot + '" of "' + a.name + '"' });
      return Object.assign(out, { name: a.name, action: a.action, snapshot: a.snapshot });
    },
  });

  // ----------------------------------------------------------------- cleanup
  tool({
    name: 'cleanup',
    title: 'Delete temporary VMs and containers',
    description: 'Delete the temporary VMs and containers Claude created through this server (created_by "claude" or "mcp", and ephemeral - ' +
      'the default for create_vm, run_image and deploy_image): containers are stopped and removed (named volumes are kept), VMs deleted. With ' +
      'ephemeral_only=false it deletes everything Claude created, even what was marked to keep. What the user created (in the GUI or ' +
      'otherwise) is never touched, even when it is marked temporary. dry_run=true only lists what would be deleted. Use it when the user no ' +
      'longer needs them.',
    params: {
      ephemeral_only: { type: 'boolean', default: true, description: 'true = only the temporary VMs and containers Claude created; false = everything Claude created.' },
      dry_run: { type: 'boolean', default: false, description: 'Only list what would be deleted.' },
    },
    annotations: ann({ destructiveHint: true, idempotentHint: true }),
    handler: async (a) => {
      const c = await conn();
      const s = await getState(c);
      const victims = cleanupCandidates(s.vms, a.ephemeral_only);
      const kept = (s.vms || []).filter((v) => victims.indexOf(v) === -1).map((v) => v.name);
      // containers: full records (createdBy, ephemeral) come from
      // /api/containers; a manager without them has no containers to clean
      let ctrs = null;
      try { ctrs = (await c.get('/api/containers?all=1')).containers || []; }
      catch (e) { if (!(e && (e.status === 404 || e.status === 501))) throw apiFail(e, root()); }
      const ctrVictims = ctrs ? cleanupCandidates(ctrs, a.ephemeral_only) : [];
      const ctrKept = ctrs ? ctrs.filter((r) => ctrVictims.indexOf(r) === -1).map((r) => r.name || r.id) : undefined;
      const label = (r) => r.name || r.id;
      if (a.dry_run) {
        return {
          dry_run: true,
          would_delete: victims.map((v) => ({ name: v.name, status: v.status, created_by: v.createdBy || null })), kept: kept,
          would_remove_containers: ctrs ? ctrVictims.map((r) => ({ name: label(r), id: r.id, image: r.image, status: r.status, created_by: r.createdBy || null })) : undefined,
          containers_kept: ctrKept,
        };
      }
      const ctrRemoved = [], ctrFailed = [];
      for (const r of ctrVictims) {
        try {
          const rr = await c.post('/api/container/remove', { id: r.id, force: true }, 120000);
          if (rr && rr.task && rr.task.id && rr.task.status === 'running') {
            const out = taskOutcome(await waitTask(c, rr.task.id, 120000), 'removing container ' + label(r), 120);
            if (out.status !== 'done') { ctrFailed.push({ name: label(r), error: 'still removing (task_id ' + out.task_id + ')' }); continue; }
          }
          ctrRemoved.push(label(r));
        } catch (e) {
          if (e && e.status === 404) ctrRemoved.push(label(r));
          else ctrFailed.push({ name: label(r), error: (e && e.message) || String(e) });
        }
      }
      const deleted = [], failed = [];
      for (const v of victims) {
        try {
          const out = await runTask(c, '/api/vm/delete', { name: v.name }, { wait: true, timeoutS: 180, what: 'deleting "' + v.name + '"' });
          if (out.status === 'done') deleted.push(v.name);
          else failed.push({ name: v.name, error: 'still deleting (task_id ' + out.task_id + ')' });
        } catch (e) { failed.push({ name: v.name, error: (e && e.message) || String(e) }); }
      }
      const res = { deleted: deleted, failed: failed, kept: kept };
      if (ctrs) Object.assign(res, { containers_removed: ctrRemoved, containers_failed: ctrFailed, containers_kept: ctrKept });
      return res;
    },
  });

  // ---------------------------------------------------------- restart_server
  tool({
    name: 'restart_server',
    title: 'Restart this MCP server',
    description: 'Restart this MCP server process so edited code takes effect. It exits about half a second after replying; the MCP host starts ' +
      'a fresh copy on the next tool call - call status afterwards to confirm (mcp_server.pid changes). Running VMs and the VM manager are ' +
      'not affected.',
    params: {},
    annotations: ann({ idempotentHint: true }),
    handler: (a, ctx) => {
      // The whole reply is built BEFORE the exit is scheduled, and the exit
      // waits for the reply to be written plus ~0.5 s: exiting inline would
      // reach the host as a crash mid-request.
      const reply = {
        ok: true, exiting: true, pid: process.pid,
        next: 'call status - it should answer with a different mcp_server.pid; only if it errors does the MCP host need a restart',
      };
      const bye = () => setTimeout(() => deps.exit(0), 500);
      if (ctx && typeof ctx.afterReply === 'function') ctx.afterReply(bye);
      else bye();
      return reply;
    },
  });

  return tools;
}

const TOOL_NAMES = ['status', 'list_vms', 'create_vm', 'setup', 'start_vm', 'stop_vm', 'delete_vm', 'reset_vm', 'exec', 'write_file', 'read_file',
  'upload', 'download', 'forward_port',
  'share_folder', 'unshare_folder', 'list_shares',
  'run_image', 'stop_image', 'image_logs', 'list_containers', 'remove_container', 'pull_image', 'list_images', 'remove_image',
  'deploy_image', 'get_task', 'serial_log', 'snapshot', 'cleanup', 'restart_server'];

module.exports = {
  INSTRUCTIONS, TOOL_NAMES, CREATED_BY, CONTAINER_CREATED_BY, CLAUDE_ORIGINS, OUTPUT_CAP,
  createTools,
  // pure helpers (tests)
  remotePathExpr, checkRemotePath, checkLocalPath, guardLocalPath, protectedPaths, buildExecCommand, envList, parseReadOutput, decodeFileBytes,
  reservedPorts, pickHostPort, describeForward, summarizeVm, summarizeTask, cleanupCandidates, readiness, imageReadiness, apiFail,
  withDeadline, findLocalTar, sshConnectFailure, TIMEOUT,
};
