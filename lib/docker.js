'use strict';
/*
 * Docker inside a guest, driven over SSH (spec sections 8 and 11): the Docker
 * tab's state listing, install, pull, run, container actions, image removal,
 * compose, logs, and image inspection (which deploy.js uses to learn an
 * image's ports and volumes).
 *
 * Rules:
 *  - Every value that goes into a guest command is VALIDATED (container,
 *    volume and compose project names, image refs, env entries, volume specs)
 *    AND quoted with shq(); "--" ends the options before positional ids where
 *    docker accepts it, so an id can never be read as an option (SEC-13,
 *    SEC-16).
 *  - Every operation checks the exit code of what it ran and fails with the
 *    last meaningful output line (BUG-15, MNT-8). Output is captured whole and
 *    trimmed in JS - never "| tail", which would hide the exit code.
 *  - Lists (ports, volumes, env, args) are arrays in the API, or text with one
 *    entry per line; commas inside values are kept (XTR-11).
 *  - The Docker tab's state is ONE ssh call with markers (OPS-13).
 *  - Removing a container also removes the host port forwards it owned, live
 *    and in vms.json (XTR-10).
 *  - Containers get the host's time zone (-e TZ=..., unless the caller set
 *    TZ) and /etc/localtime in the guest is made a real file (XTR-17).
 *  - Large payloads (compose files) go over ssh's stdin, never the command
 *    line: Windows caps a command line at 32 767 characters (BUG-15).
 *
 * The guest is reached through ssh.sshExec, called through the module object
 * (not destructured) so tests can put a fake guest in its place.
 *
 * Exported for http.js (task ops take the task context t first):
 *   getDockerState(name)                      GET /api/vm/docker
 *   getDockerLogs({name, container, tail})    GET /api/vm/docker/logs
 *   validateDockerVm   -> opDockerInstall(t, a)   result {name, version}
 *   validatePull       -> opDockerPull(t, a)      result {name, image}
 *   validateRun        -> opDockerRun(t, a)       result {name, image, container}
 *   validateAction     -> opDockerAction(t, a)    result {name, id, action, forwardsRemoved?}
 *   validateRmi        -> opDockerRmi(t, a)       result {name, image}
 *   validateCompose    -> opCompose(t, a)         result {name, project, dir}
 *   validateInspect    -> opImageInspect(t, a)    result {info}
 * and for deploy.js: ensureDocker, pullIfMissing, inspectImage, localtimeFix,
 * releaseOwnedForwards, the validators (requireImage, checkEnv, checkVolumes,
 * listOf) and the output helpers (lastLine, failure).
 */
const st = require('./state');
const platform = require('./platform');
const ports = require('./ports');
const monitor = require('./monitor');
const vmMod = require('./vm');
const ssh = require('./ssh');
const {
  shq, badRequest, conflict, isContainerName, isImageRef, isComposeProject, toList, clampInt,
} = require('./util');

// ---------------------------------------------------------------------------
// time zone
// ---------------------------------------------------------------------------
// An IANA zone name that is safe as a path below /usr/share/zoneinfo: plain
// segments only - no "." at all, so no ".." - else UTC.
function zoneName(tz) {
  return typeof tz === 'string' && tz.length <= 64 && /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) ? tz : 'UTC';
}
function hostZone() { return zoneName(platform.hostTimezone()); }

// Docker creates a missing bind-mount source as a DIRECTORY, which then breaks
// every container that bind-mounts /etc/localtime (runc mount error). Run this
// before every container-creating command (run, deploy, compose) so they are
// repeatable. It makes /etc/localtime a regular file - the host's zone when
// the guest has its zoneinfo file (tzdata), else UTC, else an empty file
// (read as UTC) - and never replaces an /etc/localtime that is already valid.
function localtimeFix(tz) {
  const zone = zoneName(tz);
  return '[ -d /etc/localtime ] && rmdir /etc/localtime 2>/dev/null; ' +
    '[ -L /etc/localtime ] && [ ! -e /etc/localtime ] && rm -f /etc/localtime; ' +
    '[ -f /etc/localtime ] || cp ' + shq('/usr/share/zoneinfo/' + zone) + ' /etc/localtime 2>/dev/null || ' +
    'cp /usr/share/zoneinfo/UTC /etc/localtime 2>/dev/null || : > /etc/localtime; ';
}

// ---------------------------------------------------------------------------
// guest scripts
// ---------------------------------------------------------------------------
// Scripts are written as lists of COMPLETE statements and sent as ONE line
// ("a; b; c"): the command travels as a single ssh argument, and one-line
// commands are the form v1 proved with Windows' ssh.exe. Trailing ";" and
// blanks are dropped so the pieces join without an empty command (";;").
function oneLine(statements) {
  return statements.map((s) => String(s === undefined || s === null ? '' : s).replace(/[\s;]+$/, '').replace(/^\s+/, ''))
    .filter(Boolean).join('; ');
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
// Marker lines our scripts print (__RC=0, __PS__, __DOCKER=27.3.1, ...) are
// plumbing, never "the error".
const MARKER_LINE = /^__[A-Z]+(__|=.*)$/;
// docker's usage trailer after an error - "Run 'docker run --help' for more
// information" (older: "See 'docker run --help'.") - is never the cause, yet
// it is the LAST line, so it used to be all a failed deploy reported.
const NOISE_LINE = /^(Run|See) '[^']*--help'( for more information)?\.?$/i;

function meaningfulLines(s) {
  return String(s || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter((x) => x && !MARKER_LINE.test(x) && !NOISE_LINE.test(x));
}
// Daemon errors nest their causes left to right ("failed to create task: ...:
// not a directory: Are you trying to mount a directory onto a file?"), so a
// long one keeps its start and its END, where the actual cause is. Pure.
function shorten(s, max) {
  const m = max || 300;
  const t = String(s === undefined || s === null ? '' : s);
  if (t.length <= m) return t;
  const head = Math.floor(m * 0.3);
  return t.slice(0, head) + ' ... ' + t.slice(t.length - (m - head - 5));
}
// The line of docker's output that states the error: the last one saying
// "error" (progress and warnings surround it), else the last line. Pure.
function errorLine(text) {
  const lines = meaningfulLines(text);
  for (let i = lines.length - 1; i >= 0; i--) if (/\berror\b|^docker: /i.test(lines[i])) return lines[i];
  return lines.length ? lines[lines.length - 1] : '';
}
// Last meaningful line of a command's output: the part of an error worth showing.
function lastLine(r) {
  const lines = meaningfulLines((r.stdout || '') + '\n' + (r.stderr || ''));
  // docker writes its own errors to the combined stdout (2>&1); prefer them
  // over ssh's stderr unless stdout is empty
  const out = meaningfulLines(r.stdout);
  const pick = out.length ? out[out.length - 1] : lines[lines.length - 1];
  return shorten(pick || (r.timedOut ? 'timed out' : 'no output'), 300);
}
// Last `n` meaningful lines of text (for the task log).
function tailLines(s, n) { return meaningfulLines(s).slice(-n).join('\n'); }

// A readable Error for a failed guest command: what failed, how, and why.
function failure(what, r) {
  const all = String(r.stdout || '') + '\n' + String(r.stderr || '');
  let why = lastLine(r);
  if (/\bdocker: (not found|command not found)/i.test(all)) why = 'Docker is not installed in this VM - install it first (Docker tab > Install Docker)';
  // a command not found whose message went to /dev/null with the rest
  else if (r.code === 127 && why === 'no output') why = 'a command was not found in the VM (is Docker installed?)';
  const how = r.timedOut || r.code === 124 ? 'timed out' : (r.code === 255 ? 'SSH connection failed' : 'exit ' + r.code);
  return new Error(what + ' failed (' + how + '): ' + why);
}
function check(r, what) {
  if (r.code !== 0) throw failure(what, r);
  return r;
}

// Parse `--format "{{json .}}"` output: one JSON object per line; anything
// else (warnings, blank lines, broken lines) is skipped.
function ndjson(txt) {
  const out = [];
  for (const line of String(txt || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* not a JSON line */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// state (ONE ssh call, four listings between markers - OPS-13)
// ---------------------------------------------------------------------------
const STATE_CMD = oneLine([
  'command -v docker >/dev/null 2>&1 || { echo __NOCLI__; exit 0; }',
  'v=$(docker version --format "{{.Server.Version}}" 2>/dev/null)',
  'echo "__VER__$v"',
  '[ -n "$v" ] || exit 0',
  'echo __PS__; docker ps -a --format "{{json .}}" 2>/dev/null',
  'echo __IM__; docker images --format "{{json .}}" 2>/dev/null',
  'echo __NW__; docker network ls --format "{{json .}}" 2>/dev/null',
  'echo __VO__; docker volume ls --format "{{json .}}" 2>/dev/null',
  'echo __END__',
]);

// Pure: the marker-separated output of STATE_CMD -> the API object.
//   installed    - the Docker daemon answered (what the Docker tab needs)
//   cliInstalled - the docker program exists (installed but not running =
//                  cliInstalled true, installed false: "Install Docker" starts it)
function parseDockerState(out) {
  const s = String(out || '');
  const ver = ((s.match(/__VER__([^\r\n]*)/) || [])[1] || '').trim();
  const cli = !/__NOCLI__/.test(s) && /__VER__/.test(s);
  const empty = { installed: false, cliInstalled: cli, version: null, containers: [], images: [], networks: [], volumes: [] };
  if (!/^\d/.test(ver)) return empty;
  const section = (a, b) => {
    const i = s.indexOf(a), k = s.indexOf(b, i + 1);
    return i === -1 ? '' : s.slice(i + a.length, k === -1 ? undefined : k);
  };
  return {
    installed: true,
    cliInstalled: true,
    version: ver,
    containers: ndjson(section('__PS__', '__IM__')).map((c) => ({
      id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status,
      ports: c.Ports, created: c.CreatedAt, running: String(c.State || '').toLowerCase() === 'running',
    })),
    images: ndjson(section('__IM__', '__NW__')).map((i) => ({
      id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size,
      created: i.CreatedSince || i.CreatedAt, dangling: i.Repository === '<none>',
    })),
    networks: ndjson(section('__NW__', '__VO__')).map((n) => ({ id: n.ID, name: n.Name, driver: n.Driver, scope: n.Scope })),
    volumes: ndjson(section('__VO__', '__END__')).map((x) => ({ name: x.Name, driver: x.Driver })),
  };
}

// GET /api/vm/docker?name=
// Each container also lists the host forwards it owns ({url, lan, host}), so
// the GUI can link straight to a deployed app.
async function getDockerState(name) {
  vmMod.requireVmName(name);
  const vm = st.getVm(name);
  const running = await vmMod.isRunning(name);
  // the status poll's cached, tolerant check (then one direct probe): a single
  // slow banner under TCG must not report "booting" and hide the forms the
  // user may be typing in (UI-8)
  const sshOk = running && (await vmMod.sshReady(name));
  if (!sshOk) {
    return {
      running: running, installed: false, cliInstalled: null, version: null,
      containers: [], images: [], networks: [], volumes: [], note: running ? 'booting' : 'stopped',
    };
  }
  const r = await ssh.sshExec({ name: name, port: vm.port }, STATE_CMD, { timeoutMs: 30000 });
  if (r.code !== 0 && !/__VER__|__NOCLI__/.test(r.stdout)) throw conflict('could not read the Docker state: ' + lastLine(r), 'SSH_FAILED');
  const s = parseDockerState(r.stdout);
  for (const c of s.containers) {
    c.urls = (vm.ports || []).filter((p) => p.owner && p.owner === c.name).map(ports.urlFor);
  }
  let note = null;
  if (!s.installed) note = s.cliInstalled ? 'Docker is installed but not running - "Install Docker" starts it' : 'Docker is not installed';
  return Object.assign({ running: true, note: note }, s);
}

// GET /api/vm/docker/logs?name=&container=&tail=
async function getDockerLogs(q) {
  q = q || {};
  const name = vmMod.requireVmName(q.name);
  requireContainer(q.container);
  const tail = clampInt(q.tail, 1, 5000, 250);
  const vm = await vmMod.requireSshReady(name);
  const r = await ssh.sshExec({ name: name, port: vm.port }, 'docker logs --tail ' + tail + ' -- ' + shq(q.container) + ' 2>&1',
    { timeoutMs: 60000, maxBytes: 4 * 1024 * 1024 });
  if (r.code !== 0) throw conflict(failure('docker logs', r).message);
  return { text: r.stdout || '(no output)', truncated: !!r.truncated };
}

// ---------------------------------------------------------------------------
// validation (shared with deploy.js)
// ---------------------------------------------------------------------------
// Caps keep one command well under Windows' 32 767-character command line.
const LIMITS = { entries: 100, entryChars: 4096, totalChars: 20000 };

function requireImage(v) {
  const image = typeof v === 'string' ? v.trim() : '';
  if (!image) throw badRequest('an image reference is required (e.g. nginx:alpine)');
  if (!isImageRef(image)) throw badRequest('that does not look like an image reference: "' + image.slice(0, 100) + '" (e.g. nginx:alpine, ghcr.io/owner/app:1.2)');
  return image;
}
function requireContainer(v, label) {
  if (!isContainerName(v)) {
    throw badRequest((label || 'container') + ' must be a container name or id: letters, digits, ".", "_" or "-", starting with a letter or digit');
  }
  return v;
}

// A list from the API (array, or text with one entry per line) with limits.
function listOf(v, label) {
  const list = toList(v, label);
  if (list.length > LIMITS.entries) throw badRequest('too many ' + label + ' entries (max ' + LIMITS.entries + ')');
  for (const x of list) {
    if (x.length > LIMITS.entryChars) throw badRequest(label + ' entry too long (max ' + LIMITS.entryChars + ' characters): ' + x.slice(0, 40) + '...');
    if (x.indexOf('\0') !== -1) throw badRequest(label + ' entries cannot contain NUL characters');
  }
  return list;
}
function checkTotal(lists) {
  let n = 0;
  for (const l of lists) for (const x of l) n += x.length + 8;
  if (n > LIMITS.totalChars) throw badRequest('too much data for one command (' + n + ' characters, max ' + LIMITS.totalChars + ') - move large settings into a compose file');
}

// NAME=value; commas and anything else in the value are kept (XTR-11). A bare
// "NAME" would make docker pass the variable through from the SSH session,
// where it is unset - silently dropped - so it is refused.
function checkEnv(list) {
  for (const e of list) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) throw badRequest('bad environment entry "' + e.slice(0, 60) + '" - use NAME=value, one per line');
  }
  return list;
}

// A path a volume may use: absolute, plain characters, no "." or ".."
// segments. Image-declared VOLUME paths go through the same test (SEC-6).
const isSafeVolumePath = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._@+\-/]{0,255}$/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p);
const isVolumeName = (s) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s);

// null when `v` is a valid -v spec, else why not. Volumes live in the VM, not
// on this PC: a Windows path is the classic mistake (XTR-9), so say so.
function volumeError(v) {
  if (/^[A-Za-z]:([\\/]|$)/.test(v) || v.indexOf('\\') !== -1) {
    return 'is a Windows path - volumes are folders INSIDE the VM, e.g. /opt/data:/data';
  }
  const m = String(v).match(/^([^:]+):([^:]+)(?::(ro|rw))?$/);
  if (!m) return 'must be /path/in/vm:/path/in/container (optionally :ro), or volume-name:/path/in/container';
  if (!isSafeVolumePath(m[1]) && !isVolumeName(m[1])) return 'the VM side must be an absolute path (letters, digits, . _ - @ +, no ".." parts) or a volume name';
  if (!isSafeVolumePath(m[2]) || m[2] === '/') return 'the container side must be an absolute path such as /data';
  return null;
}
function checkVolumes(list) {
  for (const v of list) {
    const why = volumeError(v);
    if (why) throw badRequest('volume "' + v.slice(0, 80) + '" ' + why);
  }
  return list;
}

// docker run -p inside the guest: [ip:]guestPort:containerPort[/proto], or a
// bare container port (docker picks the guest port). Ranges allowed.
function checkGuestPorts(list) {
  const range = (s) => {
    const [a, b] = s.split('-').map(Number);
    return a >= 1 && a <= 65535 && (b === undefined || (b >= a && b <= 65535));
  };
  for (const p of list) {
    const m = p.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(?:(\d{1,5}(?:-\d{1,5})?):)?(\d{1,5}(?:-\d{1,5})?)(?:\/(tcp|udp))?$/);
    if (!m || (m[2] && !range(m[2])) || !range(m[3])) throw badRequest('bad port "' + p.slice(0, 40) + '" - use guestPort:containerPort, e.g. 8080:80');
  }
  return list;
}

// Container command arguments: an array (each element one argument), or text
// split on whitespace. Every argument is quoted on its own, so ";", "|" and
// "$(...)" reach the container literally instead of the guest shell (SEC-13).
function parseArgs(body) {
  const v = body.args !== undefined ? body.args : body.cmd;
  if (v === undefined || v === null || v === '') return [];
  let list;
  if (Array.isArray(v)) {
    list = v.map((x) => {
      if (typeof x !== 'string' && typeof x !== 'number') throw badRequest('command arguments must be text');
      return String(x);
    });
  } else if (typeof v === 'string') {
    list = v.trim() ? v.trim().split(/\s+/) : [];
  } else {
    throw badRequest('args must be an array of arguments or a command line');
  }
  if (list.length > LIMITS.entries) throw badRequest('too many command arguments (max ' + LIMITS.entries + ')');
  for (const x of list) {
    if (x.length > LIMITS.entryChars || x.indexOf('\0') !== -1) throw badRequest('a command argument is too long or contains NUL');
  }
  return list;
}

const RESTART_RE = /^(no|always|unless-stopped|on-failure(:\d{1,3})?)$/;

async function validateDockerVm(body) {
  body = body || {};
  const name = vmMod.requireVmName(body.name);
  await vmMod.requireSshReady(name);
  return { name: name };
}

// ---------------------------------------------------------------------------
// Docker itself: check, install
// ---------------------------------------------------------------------------
async function target(name) {
  const vm = await vmMod.requireSshReady(name);
  return { name: name, port: vm.port };
}

// Is Docker there and running? Right after a boot sshd answers before the
// Docker service is up, so wait for the daemon (and nudge the service once)
// instead of mistaking "not up yet" for "not installed".
const DOCKER_CHECK = oneLine([
  'command -v docker >/dev/null 2>&1 || { echo __DOCKER=MISSING; exit 0; }',
  'i=0',
  'while [ $i -lt 20 ]; do v=$(docker version --format "{{.Server.Version}}" 2>/dev/null); if [ -n "$v" ]; then echo "__DOCKER=$v"; exit 0; fi; if [ $i -eq 2 ]; then service docker start >/dev/null 2>&1; fi; i=$((i+1)); sleep 2; done',
  'echo __DOCKER=DOWN',
  'tail -n 5 /var/log/docker.log 2>/dev/null',
]);

// Pure: DOCKER_CHECK output -> {state: 'up'|'missing'|'down'|'unknown', version, detail}
function parseDockerCheck(out) {
  const s = String(out || '');
  const m = s.match(/__DOCKER=([^\r\n]*)/);
  if (!m) return { state: 'unknown', version: null, detail: '' };
  const v = m[1].trim();
  if (v === 'MISSING') return { state: 'missing', version: null, detail: '' };
  if (v === 'DOWN') return { state: 'down', version: null, detail: tailLines(s.slice(m.index + m[0].length), 3) };
  return /^\d/.test(v) ? { state: 'up', version: v, detail: '' } : { state: 'unknown', version: null, detail: v };
}

const INSTALL_CMD = oneLine([
  // apk only when something is missing: with --no-cache apk needs the network
  // even for packages that are already installed
  'if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then apk add --no-cache docker docker-cli-compose 2>&1 || exit $?; fi',
  'rc-update add docker default >/dev/null 2>&1',
  // the dev user may use docker too (sessions and MCP can run as dev)
  'addgroup dev docker >/dev/null 2>&1',
  'service docker start 2>&1',
  'i=0',
  'while [ $i -lt 30 ]; do docker version --format "{{.Server.Version}}" >/dev/null 2>&1 && break; i=$((i+1)); sleep 2; done',
  'v=$(docker version --format "{{.Server.Version}}" 2>&1) || { echo "$v"; tail -n 5 /var/log/docker.log 2>/dev/null; echo "the Docker service did not start"; exit 1; }',
  'echo "__DOCKER=$v"',
]);

async function installDocker(t, tg) {
  const r = await ssh.sshExec(tg, INSTALL_CMD, { timeoutMs: 600000 });
  const out = tailLines(r.stdout, 6);
  if (out) t.log(out);
  check(r, 'installing Docker');
  const c = parseDockerCheck(r.stdout);
  if (c.state !== 'up') throw new Error('Docker did not come up: ' + lastLine(r));
  t.log('Docker ' + c.version + ' is running');
  return { name: tg.name, version: c.version };
}

async function opDockerInstall(t, a) {
  const tg = await target(a.name);
  t.step('Installing Docker + compose in "' + a.name + '" (downloads packages)...');
  return installDocker(t, tg);
}

// Make sure Docker runs in the guest: install it when missing (used by deploy).
// Resolves the server version.
async function ensureDocker(t, tg) {
  const r = await ssh.sshExec(tg, DOCKER_CHECK, { timeoutMs: 90000 });
  const c = parseDockerCheck(r.stdout);
  if (c.state === 'up') { t.log('Docker ' + c.version + ' is running'); return c.version; }
  if (c.state === 'missing') {
    t.log('Docker is not installed in "' + tg.name + '" - installing it (downloads packages, takes a few minutes)...');
    return (await installDocker(t, tg)).version;
  }
  if (c.state === 'down') throw new Error('Docker is installed in "' + tg.name + '" but its service did not start' + (c.detail ? ': ' + c.detail : ''));
  throw failure('checking for Docker', r);
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------
async function validatePull(body) {
  const a = await validateDockerVm(body);
  a.image = requireImage((body || {}).image);
  return a;
}
async function pull(t, tg, image) {
  t.log('Pulling ' + image + ' (large images take a while)...');
  const r = await ssh.sshExec(tg, 'docker pull -- ' + shq(image) + ' 2>&1', { timeoutMs: 1800000 });
  const tail = tailLines(r.stdout, 6);
  if (tail) t.log(tail);
  check(r, 'docker pull ' + image);
}
// Pull an image unless it is already present (always = pull anyway, e.g. to
// update a "latest" tag). Shared by inspect and deploy. Resolves true if pulled.
async function pullIfMissing(t, tg, image, always) {
  if (!always) {
    const has = await ssh.sshExec(tg, 'docker image inspect -- ' + shq(image) + ' >/dev/null 2>&1', { timeoutMs: 60000 });
    if (has.code === 0) { t.log(image + ' is already present'); return false; }
    if (has.code === 255 || has.code === 124 || has.code === 127) throw failure('checking for the image ' + image, has);
  }
  await pull(t, tg, image);
  return true;
}
async function opDockerPull(t, a) {
  const tg = await target(a.name);
  t.step('Pulling ' + a.image + ' into "' + a.name + '"...');
  await pull(t, tg, a.image);
  return { name: a.name, image: a.image };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function validateRun(body) {
  body = body || {};
  const a = await validateDockerVm(body);
  a.image = requireImage(body.image);
  a.containerName = body.containerName ? requireContainer(String(body.containerName), 'containerName') : null;
  a.restart = body.restart ? String(body.restart) : null;
  if (a.restart && !RESTART_RE.test(a.restart)) throw badRequest('restart must be no, always, unless-stopped or on-failure[:N]');
  a.ports = checkGuestPorts(listOf(body.ports, 'ports'));
  a.volumes = checkVolumes(listOf(body.volumes, 'volumes'));
  a.env = checkEnv(listOf(body.env, 'env'));
  a.args = parseArgs(body);
  checkTotal([a.ports, a.volumes, a.env, a.args]);
  return a;
}

// An environment entry as it may be SHOWN: the value hidden. Container
// variables are where passwords and API keys go (POSTGRES_PASSWORD=...), and
// task logs are kept in logs/tasks.log, shown in the GUI and returned to
// Claude (get_task) - the real value only goes into the ssh command. Pure.
function redactEnv(e) {
  const s = String(e);
  const i = s.indexOf('=');
  return i < 0 ? s : s.slice(0, i + 1) + '***';
}

// Pure: the docker run command line for opDockerRun (every value quoted, "--"
// before the image, TZ from the host unless the caller set it).
//   opts.redact: env values replaced by *** (for the task log)
function runCommand(a, tz, opts) {
  const show = opts && opts.redact ? redactEnv : (e) => e;
  const parts = ['docker', 'run', '-d'];
  if (a.containerName) parts.push('--name', shq(a.containerName));
  if (a.restart) parts.push('--restart', shq(a.restart));
  if (!(a.env || []).some((e) => /^TZ=/.test(e))) parts.push('-e', shq('TZ=' + zoneName(tz)));
  for (const p of a.ports || []) parts.push('-p', shq(p));
  for (const v of a.volumes || []) parts.push('-v', shq(v));
  for (const e of a.env || []) parts.push('-e', shq(show(e)));
  parts.push('--', shq(a.image));
  for (const x of a.args || []) parts.push(shq(x));
  return parts.join(' ');
}

async function opDockerRun(t, a) {
  const tg = await target(a.name);
  const tz = hostZone();
  const cmd = runCommand(a, tz);
  t.step('Starting a container from ' + a.image + ' in "' + a.name + '"...');
  t.log('$ ' + runCommand(a, tz, { redact: true }));
  const r = await ssh.sshExec(tg, oneLine([localtimeFix(tz), cmd + ' 2>&1']), { timeoutMs: 600000 });
  const tail = tailLines(r.stdout, 5);
  if (tail) t.log(tail);
  check(r, 'docker run');
  const id = (meaningfulLines(r.stdout).pop() || '').slice(0, 12);
  if (a.ports.length) t.log('The ports are published inside the VM only - use Deploy (or a port forward) to reach them from this PC.');
  return { name: a.name, image: a.image, container: a.containerName || id };
}

// ---------------------------------------------------------------------------
// container actions
// ---------------------------------------------------------------------------
const ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', rm: 'rm -f', pause: 'pause', unpause: 'unpause' };

async function validateAction(body) {
  body = body || {};
  const a = await validateDockerVm(body);
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, body.action)) throw badRequest('action must be one of ' + Object.keys(ACTIONS).join(', '));
  a.action = body.action;
  a.id = requireContainer(body.id, 'id');
  return a;
}

// Pure: the command for an action. For rm the container's NAME is printed
// first (the caller may pass an id), so the forwards it owns can be found.
function actionCommand(action, id) {
  const cmd = 'docker ' + ACTIONS[action] + ' -- ' + shq(id) + ' 2>&1';
  if (action !== 'rm') return cmd;
  return oneLine(['n=$(docker inspect --format "{{.Name}}" -- ' + shq(id) + ' 2>/dev/null)', 'echo "__NAME=${n#/}"', cmd]);
}

// Drop the host forwards owned by a container: closed live on a running VM
// (with the bind address they were opened with) and removed from vms.json.
// If the monitor cannot close them they stay open until the next restart
// (pendingRestart). Returns the removed mappings (XTR-10).
async function releaseOwnedForwards(t, vmName, owner) {
  const vm = st.state.vms[vmName];
  if (!vm || !owner) return [];
  const mine = (vm.ports || []).filter((p) => p.owner === owner);
  if (!mine.length) return [];
  const running = await vmMod.isRunning(vmName);
  let stuck = 0;
  if (running) {
    for (const m of mine) {
      const r = await monitor.removeForwardLive(vm, m);
      if (!r.ok) { stuck++; t.warn('could not close ' + ports.describe(m) + ' live (' + r.why + ') - it closes when the VM restarts'); }
    }
  }
  vm.ports = (vm.ports || []).filter((p) => p.owner !== owner);
  if (stuck) vm.pendingRestart = true;
  st.saveState();
  t.log('Removed the port forwards of "' + owner + '": ' + mine.map(ports.describe).join(', '));
  return mine.map((m) => Object.assign({}, m));
}

async function opDockerAction(t, a) {
  const tg = await target(a.name);
  t.step('docker ' + ACTIONS[a.action] + ' ' + a.id + ' in "' + a.name + '"');
  const r = await ssh.sshExec(tg, actionCommand(a.action, a.id), { timeoutMs: 300000 });
  const tail = tailLines(r.stdout, 3);
  if (tail) t.log(tail);
  const result = { name: a.name, id: a.id, action: a.action };
  if (a.action !== 'rm') {
    check(r, 'docker ' + a.action);
    return result;
  }
  // rm: a container that is already gone is fine - its forwards still go
  const gone = r.code !== 0 && /no such container/i.test(r.stdout + r.stderr);
  if (r.code !== 0 && !gone) throw failure('docker rm', r);
  if (gone) t.log('The container "' + a.id + '" no longer exists.');
  const nm = ((r.stdout.match(/__NAME=([^\r\n]*)/) || [])[1] || '').trim();
  const owner = isContainerName(nm) ? nm : a.id;
  result.forwardsRemoved = await releaseOwnedForwards(t, a.name, owner);
  return result;
}

// ---------------------------------------------------------------------------
// image removal
// ---------------------------------------------------------------------------
async function validateRmi(body) {
  const a = await validateDockerVm(body);
  a.image = requireImage((body || {}).image);
  return a;
}
async function opDockerRmi(t, a) {
  const tg = await target(a.name);
  t.step('docker rmi ' + a.image + ' in "' + a.name + '"');
  const r = await ssh.sshExec(tg, 'docker rmi -- ' + shq(a.image) + ' 2>&1', { timeoutMs: 300000 });
  const tail = tailLines(r.stdout, 3);
  if (tail) t.log(tail);
  check(r, 'docker rmi');
  return { name: a.name, image: a.image };
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------
const COMPOSE_MAX = 512 * 1024;

async function validateCompose(body) {
  body = body || {};
  const a = await validateDockerVm(body);
  const project = body.project === undefined || body.project === null || body.project === '' ? 'app' : body.project;
  // lowercase, starts with a letter or digit: never "." or ".." (SEC-16)
  if (!isComposeProject(project)) throw badRequest('project name: 1-63 lowercase letters, digits, "_" or "-", starting with a letter or digit');
  if (typeof body.yaml !== 'string' || !body.yaml.trim()) throw badRequest('paste a compose file first');
  if (Buffer.byteLength(body.yaml, 'utf8') > COMPOSE_MAX) throw badRequest('the compose file is too large (max 512 KB)');
  if (body.yaml.indexOf('\0') !== -1) throw badRequest('the compose file contains NUL characters');
  a.project = project;
  a.yaml = body.yaml;
  return a;
}

// Pure: the guest script for a compose deploy. The YAML arrives on stdin as
// base64 (so a CR/LF translation on the way cannot corrupt it: \r is
// stripped before decoding), is size-checked, written atomically, then
// `docker compose up -d` runs and `ps` shows the result.
//   o: {project, bytes (decoded size), dir (default /opt/<project>), fix}
function composeScript(o) {
  const dir = o.dir || '/opt/' + o.project;
  const p = shq(o.project);
  return oneLine([
    o.fix || '',
    'd=' + shq(dir) + '; f="$d/docker-compose.yml"',
    'mkdir -p "$d" || exit $?',
    'tr -d "\\r" | base64 -d > "$f.tmp"; b=$?',
    'n=$(wc -c < "$f.tmp" | tr -d " \\t")',
    'if [ $b -ne 0 ] || [ "$n" != ' + o.bytes + ' ]; then rm -f "$f.tmp"; echo "the compose file arrived incomplete or damaged (${n:-0} of ' + o.bytes + ' bytes)"; exit 90; fi',
    'mv -f "$f.tmp" "$f" && cd "$d" || exit $?',
    'docker compose -p ' + p + ' -f docker-compose.yml up -d 2>&1; rc=$?',
    'echo __PS__; docker compose -p ' + p + ' -f docker-compose.yml ps 2>&1',
    'exit $rc',
  ]);
}
// base64 in 76-character lines, as base64 -d expects.
function b64Lines(text) {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\n') + '\n';
}

async function opCompose(t, a) {
  const tg = await target(a.name);
  const dir = '/opt/' + a.project;
  t.step('Deploying the compose project "' + a.project + '" into ' + dir + ' in "' + a.name + '"...');
  const script = composeScript({ project: a.project, bytes: Buffer.byteLength(a.yaml, 'utf8'), dir: dir, fix: localtimeFix(hostZone()) });
  const r = await ssh.sshExec(tg, script, { timeoutMs: 1800000, input: b64Lines(a.yaml) });
  const tail = tailLines(String(r.stdout).replace('__PS__', ''), 40);
  if (tail) t.log(tail);
  if (r.code !== 0) {
    // the error is in the "up" part, not in the ps listing after the marker
    throw failure('docker compose up', { code: r.code, timedOut: r.timedOut, stdout: String(r.stdout).split('__PS__')[0], stderr: r.stderr });
  }
  return { name: a.name, project: a.project, dir: dir };
}

// ---------------------------------------------------------------------------
// image inspection
//
// Instead of making the user read an image's docs, inspect it: the image's
// ExposedPorts and Volumes say what it needs.
// ---------------------------------------------------------------------------
// Pure: `docker image inspect --format "{{json .Config}}"` output -> what the
// deploy needs. The whole Config is one JSON document, so values containing
// "|" (or anything else) cannot shift fields (MNT-10). Volume paths are
// image-controlled and later used in guest commands: only safe absolute
// paths survive, the rest are reported as ignoredVolumes (SEC-6).
function parseInspect(out) {
  let cfg = null;
  try { cfg = JSON.parse(String(out || '').trim() || 'null'); } catch (e) { cfg = null; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const exposed = Object.keys(obj(cfg.ExposedPorts)).map((k) => {
    const m = k.match(/^(\d+)\/(tcp|udp)$/);
    const port = m ? parseInt(m[1], 10) : 0;
    return port >= 1 && port <= 65535 ? { port: port, proto: m[2] } : null;
  }).filter(Boolean);
  const declared = Object.keys(obj(cfg.Volumes));
  const volumes = declared.filter(isSafeVolumePath);
  const env = (Array.isArray(cfg.Env) ? cfg.Env : []).filter((e) => typeof e === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(e));
  return {
    ports: exposed, volumes: volumes, ignoredVolumes: declared.filter((v) => !isSafeVolumePath(v)), env: env,
    cmd: Array.isArray(cfg.Cmd) ? cfg.Cmd : null, entrypoint: Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint : null,
  };
}

async function inspectImage(tg, image) {
  const r = await ssh.sshExec(tg, 'docker image inspect --format "{{json .Config}}" -- ' + shq(image) + ' 2>&1', { timeoutMs: 60000 });
  if (r.code !== 0 || !String(r.stdout).trim()) throw failure('inspecting ' + image + ' (is it pulled?)', r);
  // the JSON is the last line; anything before it would be a warning
  const lines = String(r.stdout).replace(/\r/g, '').split('\n').filter((x) => x.trim());
  return parseInspect(lines[lines.length - 1]);
}

async function validateInspect(body) {
  const a = await validateDockerVm(body);
  a.image = requireImage((body || {}).image);
  return a;
}
async function opImageInspect(t, a) {
  const tg = await target(a.name);
  t.step('Checking ' + a.image + ' in "' + a.name + '"...');
  await pullIfMissing(t, tg, a.image);
  const info = await inspectImage(tg, a.image);
  t.log('Declared TCP ports: ' + (info.ports.filter((x) => x.proto === 'tcp').map((x) => x.port).join(', ') || '(none)'));
  t.log('Declared volumes  : ' + (info.volumes.join(', ') || '(none)'));
  if (info.ignoredVolumes.length) t.warn('ignored unsafe volume paths declared by the image: ' + info.ignoredVolumes.join(', '));
  return { info: info };
}

module.exports = {
  // pure helpers (unit-tested)
  oneLine, zoneName, localtimeFix, ndjson, parseDockerState, parseDockerCheck, lastLine, tailLines, failure,
  meaningfulLines, errorLine, shorten,
  isSafeVolumePath, volumeError, parseInspect, runCommand, redactEnv, actionCommand, composeScript, b64Lines,
  STATE_CMD, DOCKER_CHECK, INSTALL_CMD, LIMITS,
  // validators shared with deploy.js
  requireImage, requireContainer, listOf, checkTotal, checkEnv, checkVolumes, checkGuestPorts, parseArgs, RESTART_RE,
  // HTTP GET handlers
  getDockerState, getDockerLogs,
  // task ops
  validateDockerVm, opDockerInstall, ensureDocker,
  validatePull, opDockerPull, pullIfMissing,
  validateRun, opDockerRun,
  validateAction, opDockerAction, releaseOwnedForwards,
  validateRmi, opDockerRmi,
  validateCompose, opCompose,
  inspectImage, validateInspect, opImageInspect,
};

// LOCALTIME_FIX (v1 name): the fix for the host's current time zone.
Object.defineProperty(module.exports, 'LOCALTIME_FIX', { enumerable: true, get: () => localtimeFix(hostZone()) });
