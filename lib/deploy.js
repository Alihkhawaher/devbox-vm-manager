'use strict';
/*
 * Deploying a Docker image (spec section 11).
 *
 * opDeploy - into an existing, running VM (the Docker tab's "Deploy"):
 *   1. make sure Docker runs (installed when missing) and pull the image
 *      unless it is present (always, with pull:true - e.g. to update ":latest")
 *   2. inspect it: exposed TCP ports and declared volumes
 *   3. plan the forwards host -> guest -> container with lib/ports rules:
 *      reserved ports and ports another program holds are skipped (BUG-5);
 *      each forward is "this PC only" or LAN as the request says, else the
 *      global default (settings.defaultExpose) - the user's choice, spec 7
 *   4. open them on the running VM through the QEMU monitor; only when that
 *      is impossible is the VM restarted - as a step of the SAME task, with
 *      one log (BUG-19, MNT-7). A port another program holds is a clear
 *      error, never a restart that would leave the VM unable to boot (BUG-5).
 *   5. start the container as a SAFE REDEPLOY (XTR-9): an existing container
 *      of that name is renamed <name>-prev and stopped; the new one is
 *      started and watched for a few seconds; on any failure the new one is
 *      removed and the old one renamed back (and started if it was running);
 *      on success the old one is removed.
 *   A failure after step 3 puts the forwards back exactly as they were
 *   (XTR-10), live and in vms.json.
 *
 * opQuickDeploy - image reference -> new VM -> running container, ONE task:
 *   everything (image, ports, env, volumes, template, QEMU) is validated
 *   BEFORE the VM is created (BUG-16); the ports the caller named are part of
 *   the VM from its first boot; a failure once the VM exists deletes it unless
 *   keepOnFailure (XTR-4); the task always ends, with
 *   {sandbox, container, urls:[{url, lan}]} or an error - tasks.start()
 *   always finalises, so BUG-1 cannot recur.
 *
 * A forward for a container has THREE ports (planDeployPorts):
 *   container - what the process listens on inside the container
 *   guest     - where docker publishes it inside the VM (-p guest:container)
 *   host      - the port on this PC that QEMU forwards to `guest`
 * With host networking there is no -p: the container listens in the VM
 * itself, so guest == container (BUG-18).
 *
 * Containers get TZ=<host time zone> unless the caller set TZ, and
 * /etc/localtime in the guest is made a real file first (XTR-17).
 *
 * Pure helpers exported for tests: planDeployPorts, planPortMappings,
 * parseRunResult, parseDeployOutput, volumeMounts, buildRunCommand,
 * redeployScript, containerNameFor.
 *
 *   validateDeploy(body)      -> opDeploy(t, a)
 *        result {name, container, image, urls:[{url, lan, host}], ports, replaced}
 *   validateQuickDeploy(body) -> opQuickDeploy(t, a)
 *        result adds {sandbox, ssh}
 */
const { CFG } = require('./config');
const st = require('./state');
const { state } = st;
const platform = require('./platform');
const ports = require('./ports');
const tasks = require('./tasks');
const monitor = require('./monitor');
const vmMod = require('./vm');
const docker = require('./docker');
const ssh = require('./ssh');
const {
  shq, safeName, badRequest, conflict, isContainerName, toBool, intInRange, exists, errMsg,
} = require('./util');

// Seconds a new container is watched before the deploy calls it good.
const SETTLE_S = 4;
// How long a host port claimed for a deploy stays reserved if nothing
// releases it: the pull before the forwards are opened can take many minutes.
// Every path releases it explicitly (deployInto's finally, http.js when the
// task cannot start), so this only bounds a bug.
const CLAIM_MS = 60 * 60000;

const clone = (list) => (list || []).map((q) => Object.assign({}, q));
// What QEMU cares about: a forward is (protocol, host, guest, bind address).
const fwdKey = (q) => ports.protoOf(q) + ':' + q.host + '/' + q.guest + '/' + (q.lan ? 'lan' : 'local');
const cport = (q) => q.container || q.guest;
// A port number per protocol: a TCP and a UDP forward may share a number
// (DNS publishes 53/tcp and 53/udp), two of one protocol may not.
const pkey = (q, n) => ports.protoOf(q) + ':' + n;
// Rows keep the protocol only when it is UDP, so TCP rows (and every record
// written before UDP existed) keep their exact shape.
function withProto(row, q) {
  if (ports.protoOf(q) === 'udp') row.proto = 'udp';
  return row;
}

// ---------------------------------------------------------------------------
// port planning (pure)
// ---------------------------------------------------------------------------
// o: {vmPorts: the VM's mappings, sshPort, cname: the container,
//     explicit: [{host, guest (= the CONTAINER port), lan}],
//     imagePorts: [tcp ports the image exposes], taken: host ports that are
//     unavailable (reserved elsewhere or in use), defaultLan, hostNetwork,
//     unprivileged: derived host ports start at 1024+ (see lowPortsRestricted)}
// Returns {cname, rows, added, removed, kept}:
//   rows    - every forward the container owns after the deploy
//   added   - forwards QEMU must open; removed - forwards QEMU must close
//   kept    - forwards that stay open as they are
// Rules:
//   - no explicit ports: the container keeps the forwards it already owns
//     (a plain redeploy never loses a port), plus one per new image port;
//     explicit ports: exactly those, plus the image ports they do not cover.
//   - a forward the container already owns is reused when it fits.
//   - host networking: guest == container, and a guest port another forward
//     already uses is a clear 409 instead of a dead URL (BUG-18).
//   - an explicit host port that is taken is a 409; a derived one moves up.
function planDeployPorts(o) {
  const cname = o.cname;
  const list = o.vmPorts || [];
  const own = list.filter((q) => q.owner === cname);
  const others = list.filter((q) => q.owner !== cname);
  // host ports held elsewhere (other VMs, containers, programs) count for
  // both protocols: the registry keeps numbers only
  const hostTakenNum = new Set(o.taken || []);
  if (o.sshPort) hostTakenNum.add(o.sshPort);
  const hostTakenKey = new Set(others.map((q) => pkey(q, q.host)));
  const guestTaken = new Set(others.map((q) => pkey(q, q.guest)));
  guestTaken.add('tcp:22');
  const ownHosts = new Set(own.map((q) => pkey(q, q.host)));

  const want = [];
  const explicit = o.explicit || [];
  for (const w of explicit) want.push(withProto({ host: w.host, container: w.guest, lan: !!w.lan }, w));
  if (!explicit.length) for (const q of own) want.push(withProto({ host: q.host, container: cport(q), lan: !!q.lan, prev: q }, q));
  // image ports are TCP (docker inspect's "80/tcp"; UDP ones are never derived)
  for (const cp of o.imagePorts || []) {
    if (!want.some((w) => w.container === cp && ports.protoOf(w) === 'tcp')) want.push({ host: null, container: cp, lan: !!o.defaultLan });
  }

  const rows = [];
  const usedOwn = new Set(), hostUsed = new Set(), guestUsed = new Set();
  for (const w of want) {
    const hostBusy = (n) => hostTakenNum.has(n) || hostTakenKey.has(pkey(w, n)) || hostUsed.has(pkey(w, n));
    const guestBusy = (n) => guestTaken.has(pkey(w, n)) || guestUsed.has(pkey(w, n));
    // a forward this container already owns for the same container port and
    // protocol (and the same host port, when one was asked for)
    const prev = w.prev || own.find((q) => !usedOwn.has(q) && cport(q) === w.container && ports.protoOf(q) === ports.protoOf(w) && (w.host === null || q.host === w.host));
    if (prev) usedOwn.add(prev);
    let gp;
    if (o.hostNetwork) {
      gp = w.container;
      const clash = others.find((q) => q.guest === gp && ports.protoOf(q) === ports.protoOf(w));
      if (clash || (gp === 22 && ports.protoOf(w) === 'tcp')) {
        throw new ports.PortConflict('port ' + gp + ' inside the VM is already used by ' + (clash ? 'the forward ' + ports.describe(clash) : 'SSH') +
          ' - with host networking the container listens on that port itself, so it must be free');
      }
    } else if (prev && !guestBusy(prev.guest)) {
      gp = prev.guest;
    } else {
      gp = w.host || w.container;
      while (guestBusy(gp) && gp < 65535) gp++;
    }
    let hp;
    if (w.host !== null) {
      hp = w.host;
      if (hostBusy(hp)) throw new ports.PortConflict('host port ' + hp + (ports.protoOf(w) === 'udp' ? '/udp' : '') + ' is already taken - pick another one');
    } else if (prev && !hostBusy(prev.host)) {
      hp = prev.host;
    } else {
      // derived: never one of the container's current host ports, which may
      // be reused by a later row of this same plan. Where a normal user may
      // not open ports below 1024 (Linux), 80 becomes 8080, 443 8443...
      hp = o.unprivileged && gp < 1024 ? gp + 8000 : gp;
      while ((hostBusy(hp) || ownHosts.has(pkey(w, hp))) && hp < 65535) hp++;
    }
    if (!ports.validPort(hp) || !ports.validPort(gp) || hostBusy(hp) || (!o.hostNetwork && guestBusy(gp))) {
      throw new ports.PortConflict('ran out of ports while mapping container port ' + w.container);
    }
    hostUsed.add(pkey(w, hp));
    if (!o.hostNetwork) guestUsed.add(pkey(w, gp));
    rows.push(withProto({ host: hp, guest: gp, container: w.container, owner: cname, lan: w.lan }, w));
  }
  const oldKeys = new Set(own.map(fwdKey));
  const newKeys = new Set(rows.map(fwdKey));
  return {
    cname: cname,
    rows: rows,
    added: rows.filter((q) => !oldKeys.has(fwdKey(q))),
    removed: own.filter((q) => !newKeys.has(fwdKey(q))).map((q) => Object.assign({}, q)),
    kept: rows.filter((q) => oldKeys.has(fwdKey(q))),
  };
}
// The NEW forwards only (the v2.0 core API; tests pin it).
function planPortMappings(o) { return planDeployPorts(o).added; }

// ---------------------------------------------------------------------------
// guest output parsing (pure)
// ---------------------------------------------------------------------------
// "<output>\n__RC=<n>" -> {rc, body}. A missing marker is NOT success (MNT-8):
// rc is null and the caller treats it as a failure.
function parseRunResult(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).replace(/\s+$/, '');
  const m = s.match(/(?:^|\n)__RC=(\d+)$/);
  if (!m) return { rc: null, body: s.trim() };
  return { rc: parseInt(m[1], 10), body: s.slice(0, m.index).trim() };
}

// The redeploy script's output -> {rc, body, logs, state, rollback, replaced}
//   state    {status, exitCode, restarts} of the new container after settling
//   rollback 'started' | 'restored' | 'failed' | null (nothing to restore)
//   logs     the new container's last log lines when it failed
function parseDeployOutput(raw) {
  const r = parseRunResult(String(raw === undefined || raw === null ? '' : raw).replace(/\r/g, ''));
  let body = r.body;
  let logs = '';
  const li = body.indexOf('__LOGS__');
  if (li !== -1) {
    const le = body.indexOf('__ENDLOGS__', li);
    logs = body.slice(li + '__LOGS__'.length, le === -1 ? undefined : le).replace(/^\n/, '').replace(/\s+$/, '');
    body = body.slice(0, li) + (le === -1 ? '' : body.slice(le + '__ENDLOGS__'.length));
  }
  const sm = body.match(/__STATE=(\S*) (\S*) (\S*)/);
  const rb = body.match(/__ROLLBACK=(\w+)/);
  const replaced = /__HAD=1/.test(body);
  body = body.split('\n').filter((l) => !/^__[A-Z]+(=|__)/.test(l.trim())).join('\n').trim();
  return {
    rc: r.rc, body: body, logs: logs,
    state: sm ? { status: sm[1], exitCode: parseInt(sm[2], 10), restarts: parseInt(sm[3], 10) } : null,
    rollback: rb ? rb[1] : null,
    replaced: replaced,
  };
}

// ---------------------------------------------------------------------------
// the container command (pure)
// ---------------------------------------------------------------------------
// One VM directory per image-declared volume: /opt/<container>/<path with
// "/" as "_">. A volume the caller mapped themselves (same container path)
// is left to them - two mounts on one path is a docker error.
function volumeMounts(cname, imageVolumes, userVolumes) {
  const covered = new Set((userVolumes || []).map((v) => String(v).split(':')[1]));
  const seen = new Set();
  const out = [];
  for (const p of imageVolumes || []) {
    if (p === '/' || covered.has(p) || !docker.isSafeVolumePath(p)) continue;
    let dir = '/opt/' + cname + '/' + p.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
    while (seen.has(dir)) dir += '_';
    seen.add(dir);
    out.push({ dir: dir, path: p });
  }
  return out;
}

// docker run for a deploy. Every value is quoted; "--" ends the options
// before the image; each forward row is published as guest:container unless
// the container uses the VM's network directly.
//   opts.redact: env values replaced by *** (the line shown in the task log)
function buildRunCommand(a, rows, mounts, tz, opts) {
  const show = opts && opts.redact ? docker.redactEnv : (e) => e;
  const args = ['docker', 'run', '-d', '--name', shq(a.containerName), '--restart', shq(a.restartPolicy || 'unless-stopped')];
  if (a.privileged) args.push('--privileged');
  if (a.hostNetwork) args.push('--network', 'host');
  else {
    const seen = new Set();
    for (const q of rows || []) {
      const p = q.guest + ':' + cport(q) + (ports.protoOf(q) === 'udp' ? '/udp' : '');
      if (!seen.has(p)) { seen.add(p); args.push('-p', shq(p)); }
    }
  }
  if (!(a.env || []).some((e) => /^TZ=/.test(e))) args.push('-e', shq('TZ=' + docker.zoneName(tz)));
  for (const e of a.env || []) args.push('-e', shq(show(e)));
  for (const m of mounts || []) args.push('-v', shq(m.dir + ':' + m.path));
  for (const v of a.volumes || []) args.push('-v', shq(v));
  args.push('--', shq(a.image));
  return args.join(' ');
}

// The guest script of step 5 (XTR-9). o: {cname, run (the docker run line),
// dirs (VM directories to create), fix (localtime fix), settleS}.
// Prints the command output plus markers: __HAD=1 when a container was
// replaced, __STATE=<status> <exit code> <restarts> after settling,
// __LOGS__...__ENDLOGS__ when the new container failed, __ROLLBACK=started|
// restored|failed, and always __RC=<n> LAST (0 = success, 96 = the rollback
// name is taken, 97 = could not move the old container aside, 98 = the new
// container stopped right away, else docker run's / mkdir's exit code).
// HUP and PIPE are ignored: a dropped SSH connection must not stop the
// script half-way, with the old container renamed and stopped.
function redeployScript(o) {
  const settle = o.settleS === undefined ? SETTLE_S : o.settleS;
  const mk = (o.dirs || []).length ? 'mkdir -p ' + o.dirs.map(shq).join(' ') + ' 2>&1 && ' : '';
  return docker.oneLine([
    "trap '' HUP PIPE",
    o.fix || '',
    'c=' + shq(o.cname) + '; p=' + shq(o.cname + '-prev'),
    // never touch a <name>-prev we did not make: it may be the user's own
    'if docker container inspect -- "$p" >/dev/null 2>&1; then echo "a container named $p already exists (left over from an interrupted redeploy?) - remove it, or rename it back to $c, then deploy again"; echo __RC=96; exit 0; fi',
    'had=0; was=0',
    'if docker container inspect -- "$c" >/dev/null 2>&1; then had=1; echo __HAD=1; ' +
      'if [ "$(docker container inspect --format "{{.State.Running}}" -- "$c" 2>/dev/null)" = true ]; then was=1; fi; ' +
      'if ! docker rename -- "$c" "$p" 2>&1; then echo "could not move the existing container $c aside"; echo __RC=97; exit 0; fi; ' +
      'docker stop -- "$p" >/dev/null 2>&1; echo "The existing container $c is kept as $p until the new one runs"; fi',
    mk + o.run + ' 2>&1; rc=$?',
    // After settling, a deployed service must be running and must not have
    // restarted. A command that ends at once - even with exit code 0 - is
    // looped by the restart policy ("Restarting (0)"): that is a failure too.
    // Only "exited 0, never restarted" (restart policy no/on-failure) is a
    // one-shot job that finished as asked.
    'if [ $rc -eq 0 ]; then sleep ' + settle + '; ' +
      'set -- $(docker container inspect --format "{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}" -- "$c" 2>/dev/null); ' +
      's=${1:-gone}; ec=${2:-0}; rs=${3:-0}; echo "__STATE=$s $ec $rs"; bad=0; ' +
      'case "$s" in running) [ "$rs" = 0 ] || bad=1 ;; exited) if [ "$ec" != 0 ] || [ "$rs" != 0 ]; then bad=1; fi ;; *) bad=1 ;; esac; ' +
      'if [ $bad = 1 ]; then echo __LOGS__; docker logs --tail 40 -- "$c" 2>&1; echo __ENDLOGS__; rc=98; fi; fi',
    'if [ $rc -ne 0 ]; then docker rm -f -- "$c" >/dev/null 2>&1; ' +
      'if [ $had = 1 ]; then if docker rename -- "$p" "$c" >/dev/null 2>&1; then ' +
        'if [ $was = 1 ]; then if docker start -- "$c" >/dev/null 2>&1; then echo __ROLLBACK=started; else echo __ROLLBACK=failed; fi; ' +
        'else echo __ROLLBACK=restored; fi; ' +
      'else echo __ROLLBACK=failed; fi; fi; ' +
    'elif [ $had = 1 ]; then docker rm -f -- "$p" >/dev/null 2>&1; fi',
    'echo "__RC=$rc"',
  ]);
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
// Linux lets only root open ports below 1024 (QEMU runs as the user), so a
// derived forward for container port 80 starts at 8080 there. Windows and
// macOS allow them.
function lowPortsRestricted() {
  return process.platform === 'linux' && !(typeof process.getuid === 'function' && process.getuid() === 0);
}
// Why a host port the caller named cannot be used (the OS said "not free").
function portUnavailable(port) {
  if (port < 1024 && lowPortsRestricted()) {
    return new ports.PortConflict('host port ' + port + ' needs root on Linux (ports below 1024) - use 1024 or higher, e.g. ' + (port + 8000) + ':' + port);
  }
  return new ports.PortConflict('host port ' + port + ' is in use by another program on this PC - pick another one');
}

// The container name: given, or derived from the image ("ghcr.io/x/app:1" -> "app").
function containerNameFor(image, explicit) {
  if (explicit) return explicit;
  const tail = String(image).split('/').pop().split('@')[0].split(':')[0];
  const n = safeName(tail).replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return isContainerName(n) ? n : 'app';
}

function commonDeployFields(body, image) {
  const containerName = body.containerName ? docker.requireContainer(String(body.containerName), 'containerName') : null;
  const env = docker.checkEnv(docker.listOf(body.env, 'env'));
  const volumes = docker.checkVolumes(docker.listOf(body.volumes, 'volumes'));
  docker.checkTotal([env, volumes]);
  const restartPolicy = body.restartPolicy ? String(body.restartPolicy) : 'unless-stopped';
  if (!docker.RESTART_RE.test(restartPolicy)) throw badRequest('restartPolicy must be no, always, unless-stopped or on-failure[:N]');
  // the exposure of NEW forwards: the request's choice, else the global default
  const lan = body.lan === undefined || body.lan === null ? state.settings.defaultExpose === 'lan' : toBool(body.lan, false);
  // "host:container" - for a deploy the second number is the CONTAINER port;
  // a "lan:" / "local:" prefix overrides the lan flag for that one entry
  const explicit = ports.parsePortSpec(body.ports === undefined || body.ports === null ? [] : body.ports, { defaultLan: lan })
    .map((m) => withProto({ host: m.host, guest: m.container || m.guest, lan: !!m.lan }, m));
  return {
    image: image,
    containerName: containerNameFor(image, containerName),
    env: env, volumes: volumes, restartPolicy: restartPolicy,
    privileged: toBool(body.privileged, false), hostNetwork: toBool(body.hostNetwork, false),
    pull: toBool(body.pull, false),
    lan: lan,
    explicit: explicit,
  };
}

async function validateDeploy(body) {
  body = body || {};
  const name = vmMod.requireVmName(body.name);
  const vm = await vmMod.requireSshReady(name);
  const a = commonDeployFields(body, docker.requireImage(body.image));
  a.name = name;
  const reserved = ports.reservedPorts({ exceptVm: name });
  // registry checks for every named port first, then CLAIM the new ones for
  // this VM in the same breath (no await in between: a deploy or port change
  // on another VM cannot take them meanwhile), then ask the OS; deployInto
  // releases them once the forwards are saved (or on failure)
  const fresh = [];
  for (const m of a.explicit) {
    if (m.host === vm.port) throw badRequest('host port ' + m.host + ' is the SSH port of this VM');
    const mine = (vm.ports || []).find((q) => q.host === m.host);
    if (mine && mine.owner !== a.containerName) {
      throw new ports.PortConflict('host port ' + m.host + ' is already forwarded for ' + (mine.owner ? 'the container "' + mine.owner + '"' : 'this VM') + ' - pick another one');
    }
    const why = reserved.get(m.host);
    if (why) throw new ports.PortConflict('host port ' + m.host + ' is already used by ' + why);
    if (!mine) fresh.push(m.host);
  }
  for (const p of fresh) ports.claim(p, CLAIM_MS, name);
  try {
    for (const p of fresh) if (!(await platform.isPortFree(p))) throw portUnavailable(p);
    // the planner's own conflicts (e.g. host networking on a used port) are a
    // 409 now rather than a failure half-way through the deploy
    planDeployPorts({
      vmPorts: vm.ports, sshPort: vm.port, cname: a.containerName, explicit: a.explicit, imagePorts: [],
      taken: new Set(reserved.keys()), hostNetwork: a.hostNetwork,
    });
  } catch (e) {
    for (const p of fresh) ports.release(p, name);
    throw e;
  }
  a.claimed = fresh;
  return a;
}

async function validateQuickDeploy(body) {
  body = body || {};
  const image = docker.requireImage(body.image);
  const a = commonDeployFields(body, image);
  // the VM: the given name, or one derived from the image, made unique
  let base = body.name ? vmMod.requireVmName(body.name) : null;
  if (!base) {
    base = image.split('/').pop().split('@')[0].split(':')[0].replace(/[^A-Za-z0-9.-]+/g, '-').slice(0, 50)
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!safeVmName(base)) base = 'app'; // e.g. "con" is a Windows device name
  }
  let name = base, n = 1;
  const taken = (x) => state.vms[x] || exists(st.diskPath(x)) || tasks.vmBusy(x);
  if (body.name && taken(name)) throw conflict('a VM called "' + name + '" already exists', 'EXISTS');
  while (taken(name)) name = base + '-' + (++n);
  vmMod.requireVmName(name);
  a.name = name;
  // template: the given one, else a Docker-ready one when there is one
  a.template = body.template === undefined || body.template === null || body.template === '' ? null : String(body.template);
  if (a.template !== null) {
    if (a.template !== 'devbox-base') vmMod.requireVmName(a.template, 'template');
    if (!vmMod.findTemplate(a.template)) throw badRequest('no template called "' + a.template + '"');
  } else {
    a.template = vmMod.findTemplate('docker-ready') ? 'docker-ready' : 'devbox-base';
    if (!vmMod.findTemplate(a.template)) throw conflict('the base image is not built yet - run the one-click setup first', 'NO_BASE');
  }
  tasks.assertFree('template:' + a.template);
  tasks.assertFree('qemu');
  if (!platform.findTool('qemu') || !platform.findTool('qemu-img')) throw conflict('QEMU is not installed - ' + platform.installHints().qemu, 'PREREQ_MISSING');
  a.mem = intInRange(body.mem, CFG.minMem, CFG.maxMem, Math.min(Math.max(CFG.defaultMem, 2048), CFG.maxMem), 'Memory (MB)');
  a.cpus = intInRange(body.cpus, 1, CFG.maxCpus, Math.min(CFG.defaultCpus, CFG.maxCpus), 'vCPUs');
  // null = the manager's default for the accelerator (240 s, 600 s under TCG)
  a.waitS = intInRange(body.waitS, 30, 1800, null, 'waitS');
  a.keepOnFailure = toBool(body.keepOnFailure, false);
  a.ephemeral = toBool(body.ephemeral, false);
  a.createdBy = typeof body.createdBy === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(body.createdBy) ? body.createdBy : 'api';
  // the ports the caller named are checked NOW, before any VM exists, and
  // claimed for the new VM at once (released when its record holds them)
  const reserved = ports.reservedPorts({ exceptVm: name });
  for (const m of a.explicit) {
    const why = reserved.get(m.host);
    if (why) throw new ports.PortConflict('host port ' + m.host + ' is already used by ' + why);
  }
  const held = a.explicit.map((m) => m.host);
  for (const p of held) ports.claim(p, CLAIM_MS, name);
  try {
    for (const p of held) if (!(await platform.isPortFree(p))) throw portUnavailable(p);
    // ...and become the new VM's forwards from its first boot
    a.pre = planDeployPorts({
      vmPorts: [], cname: a.containerName, explicit: a.explicit, imagePorts: [],
      taken: new Set(reserved.keys()), hostNetwork: a.hostNetwork,
    }).rows;
  } catch (e) {
    for (const p of held) ports.release(p, name);
    throw e;
  }
  a.claimed = held;
  return a;
}
function safeVmName(n) { try { vmMod.requireVmName(n); return true; } catch (e) { return false; } }

// ---------------------------------------------------------------------------
// forwards on the running VM
// ---------------------------------------------------------------------------
// Plan, skipping DERIVED host ports another program holds (explicit ones were
// checked by the validator; the container's own ones are held by QEMU itself).
// The new host ports of the plan are CLAIMED for this VM as soon as they are
// planned (before anything is awaited): two deploys at once on different VMs
// would otherwise both pick the same derived port (e.g. 80 -> 80), and the
// second would fail half-way (BUG-5). The caller releases plan.claimed.
async function planWithFreePorts(vm, name, a, imagePorts) {
  const taken = new Set(ports.reservedPorts({ exceptVm: name }).keys());
  const ownHosts = new Set((vm.ports || []).filter((q) => q.owner === a.containerName).map((q) => q.host));
  const explicitHosts = new Set(a.explicit.map((w) => w.host));
  for (let round = 0; round < 50; round++) {
    const plan = planDeployPorts({
      vmPorts: vm.ports, sshPort: vm.port, cname: a.containerName, explicit: a.explicit, imagePorts: imagePorts,
      taken: taken, defaultLan: a.lan, hostNetwork: a.hostNetwork, unprivileged: lowPortsRestricted(),
    });
    // (re-read each round: a claim another deploy made while we awaited counts)
    const now = ports.reservedPorts({ exceptVm: name });
    const clash = plan.added.find((m) => now.has(m.host));
    if (clash) { taken.add(clash.host); continue; }
    const derived = plan.added.filter((m) => !explicitHosts.has(m.host) && !ownHosts.has(m.host)).map((m) => m.host);
    for (const p of derived) ports.claim(p, CLAIM_MS, name);
    let busy = null;
    for (const p of derived) {
      if (!(await platform.isPortFree(p))) { busy = p; break; }
    }
    if (busy === null) { plan.claimed = derived; return plan; }
    for (const p of derived) ports.release(p, name);
    taken.add(busy);
  }
  throw new ports.PortConflict('could not find free host ports for this image');
}

// Undo live changes: close what was opened, reopen what was closed. Returns
// the number of forwards that could not be restored live (then the VM is
// flagged pendingRestart: the registry is right, QEMU catches up on restart).
async function undoLive(t, vm, done) {
  let bad = 0;
  for (const q of done.added || []) {
    const r = await monitor.removeForwardLive(vm, q);
    if (!r.ok) { bad++; t.warn('could not close ' + ports.describe(q) + ' again: ' + r.why); }
  }
  for (const q of done.removed || []) {
    const r = await monitor.addForwardLive(vm, q);
    if (!r.ok) { bad++; t.warn('could not reopen ' + ports.describe(q) + ': ' + r.why); }
  }
  if (bad) vm.pendingRestart = true;
  return bad;
}

// Step 4: make QEMU match the plan. Resolves 'none' | 'live' | 'restart'.
// The registry is written only once the forwards are live, or right before
// the restart that applies them (BUG-5); nothing is left half-applied.
async function applyForwards(t, name, before, plan) {
  const vm = st.getVm(name);
  const next = before.filter((q) => q.owner !== plan.cname).concat(clone(plan.rows));
  if (!plan.added.length && !plan.removed.length) {
    vm.ports = next;
    st.saveState();
    t.log('The port forwards are already in place.');
    return 'none';
  }
  const done = { added: [], removed: [] };
  let live = !!monitor.monitorFor(vm) && !(vm.runtime && vm.runtime.legacy);
  let why = live ? '' : 'the VM was started by an older version of the manager';
  if (live) {
    for (const q of plan.removed) {
      const r = await monitor.removeForwardLive(vm, q);
      if (!r.ok) { live = false; why = 'could not close ' + ports.describe(q) + ': ' + r.why; break; }
      done.removed.push(q);
      t.log('  closed ' + ports.describe(q));
    }
  }
  if (live) {
    for (const q of plan.added) {
      const r = await monitor.addForwardLive(vm, q);
      if (r.ok) { done.added.push(q); t.log('  ' + ports.describe(q) + ' is live'); continue; }
      if (!(await platform.isPortFree(q.host))) {
        // someone holds the port (or the OS refuses it): a restart could not
        // bind it either and would leave the VM unable to boot (BUG-5).
        // Name the holder when it is one of ours (another VM's forward).
        await undoLive(t, vm, done);
        st.saveState();
        const who = ports.reservedPorts({ exceptVm: name }).get(q.host);
        const why = who ? 'it is already used by ' + who + ' - pick another port'
          : (q.host < 1024 && lowPortsRestricted() ? 'ports below 1024 need root on Linux - use 1024 or higher'
            : 'another program on this PC is using it - pick another port');
        throw new ports.PortConflict('host port ' + q.host + ' could not be opened: ' + why + ', then deploy again');
      }
      live = false;
      why = r.why;
      break;
    }
  }
  if (live) {
    vm.ports = next;
    st.saveState();
    t.log('Applied live through the QEMU monitor - no restart needed.');
    return 'live';
  }
  t.log('Could not apply the forwards live (' + why + ') - restarting the VM to apply them...');
  vm.ports = next;
  st.saveState();
  try {
    await vmMod.opRestart(t, { name: name, force: false, timeoutS: null, waitS: null });
  } catch (e) {
    t.warn('the restart failed (' + errMsg(e).split('\n')[0] + ') - putting the previous forwards back');
    vm.ports = clone(before);
    st.saveState();
    try {
      if (!(await vmMod.isRunning(name))) await vmMod.opStart(t, { name: name, waitS: 300 });
    } catch (e2) { t.warn('"' + name + '" could not be started again: ' + errMsg(e2).split('\n')[0]); }
    throw new Error('applying the port forwards needed a VM restart, and it failed: ' + errMsg(e));
  }
  return 'restart';
}

// A failed deploy puts the forwards back as they were (XTR-10).
async function rollbackForwards(t, name, before, plan, how) {
  const vm = state.vms[name];
  if (!vm) return;
  if (how !== 'none' && (await vmMod.isRunning(name))) {
    await undoLive(t, vm, { added: plan.added, removed: plan.removed });
  }
  vm.ports = clone(before);
  st.saveState();
  if (how !== 'none') t.log('The port forwards were put back as they were.');
}

// ---------------------------------------------------------------------------
// deploy into a running VM
// ---------------------------------------------------------------------------
// sp: {base, total} - step numbering, so quick deploy shows one sequence.
async function deployInto(t, a, sp) {
  const step = (n, text) => t.step('Step ' + (sp.base + n) + '/' + sp.total + ': ' + text);
  const name = a.name, cname = a.containerName;
  let vm = await vmMod.requireSshReady(name);
  const tg = { name: name, port: vm.port };

  step(1, 'checking Docker in "' + name + '" and pulling ' + a.image + (a.pull ? '' : ' if needed') + '...');
  await docker.ensureDocker(t, tg);
  await docker.pullIfMissing(t, tg, a.image, a.pull);

  step(2, 'inspecting ' + a.image + ' for ports and volumes...');
  const info = await docker.inspectImage(tg, a.image);
  const tcpPorts = info.ports.filter((x) => x.proto === 'tcp').map((x) => x.port);
  t.log('Exposed TCP ports: ' + (tcpPorts.join(', ') || '(none)'));
  t.log('Declared volumes : ' + (info.volumes.join(', ') || '(none)'));
  if (info.ignoredVolumes.length) t.warn('ignored unsafe volume paths declared by the image: ' + info.ignoredVolumes.join(', '));

  step(3, 'planning the port forwards...');
  const before = clone(vm.ports);
  let plan, how;
  try {
    plan = await planWithFreePorts(vm, name, a, tcpPorts);
    for (const q of plan.kept) t.log('  keep   ' + ports.describe(q));
    for (const q of plan.added) t.log('  add    ' + ports.describe(q));
    for (const q of plan.removed) t.log('  remove ' + ports.describe(q));
    if (!plan.rows.length) t.log('  (none - the image declares no ports and none were given)');

    step(4, plan.added.length || plan.removed.length ? 'opening the port forwards on the running VM...' : 'port forwards: nothing to change');
    how = await applyForwards(t, name, before, plan);
  } finally {
    // the forwards are in the registry now (or were rolled back): the claims
    // made while planning (and by the validator) are no longer needed
    for (const p of (plan && plan.claimed) || []) ports.release(p, name);
    for (const p of a.claimed || []) ports.release(p, name);
  }
  vm = st.getVm(name);
  tg.port = vm.port;

  step(5, 'starting the container "' + cname + '"...');
  const tz = platform.hostTimezone();
  const mounts = volumeMounts(cname, info.volumes, a.volumes);
  const run = buildRunCommand(a, plan.rows, mounts, tz);
  t.log('$ ' + buildRunCommand(a, plan.rows, mounts, tz, { redact: true }));
  const script = redeployScript({ cname: cname, run: run, dirs: mounts.map((m) => m.dir), fix: docker.localtimeFix(tz), settleS: a.settleS });
  let r;
  try {
    r = await ssh.sshExec(tg, script, { timeoutMs: 900000 });
  } catch (e) {
    r = { code: 127, stdout: '', stderr: errMsg(e) };
  }
  const res = parseDeployOutput(r.stdout);
  if (res.body) t.log(res.body.slice(-2000));
  if (res.logs) t.log('Last lines the container printed:\n' + res.logs.slice(-3000));

  if (res.rc !== 0) {
    if (res.rc === null) {
      // the outcome in the guest is unknown: leave the forwards (a retry
      // reuses them) rather than cutting off a container that may be running
      throw new Error('the SSH connection failed while starting the container (' + docker.lastLine(r) +
        ') - the result is unknown; check the Docker tab, or deploy again');
    }
    await rollbackForwards(t, name, before, plan, how);
    let why;
    if (res.rc === 96 || res.rc === 97) why = res.body.split('\n').pop();
    else if (res.rc === 98) {
      why = 'the container stopped right after starting (' + (res.state ? res.state.status + ', exit code ' + res.state.exitCode : 'gone') +
        ') - its last output is in the task log';
      if (res.state && res.state.exitCode === 0) {
        why += '. Its command finished at once: a deploy runs a long-lived service (a web server, a database...) - use "Run" for a one-off command';
      }
    } else {
      // docker's own error, not its "Run 'docker run --help'" trailer
      why = 'docker run failed (exit ' + res.rc + '): ' + docker.shorten(docker.errorLine(res.body) || docker.lastLine(r));
    }
    let rb = '';
    if (res.rollback === 'started') rb = ' The previous container "' + cname + '" was restored and is running again.';
    else if (res.rollback === 'restored') rb = ' The previous container "' + cname + '" was restored (it was stopped before).';
    else if (res.rollback === 'failed') rb = ' WARNING: the previous container could not be restored - it is kept as "' + cname + '-prev".';
    throw new Error(why + '.' + rb);
  }

  // only TCP forwards are web addresses
  const urls = plan.rows.filter((q) => ports.protoOf(q) === 'tcp').map(ports.urlFor);
  t.log('Container "' + cname + '" ' + (res.replaced ? 'replaced' : 'started') + ' from ' + a.image);
  if (urls.length) t.log('Reachable at: ' + urls.map((u) => u.url + (u.lan ? ' (also from the LAN)' : ' (this PC only)')).join('  '));
  else t.log('No ports exposed - this image declares none and none were given.');
  return { name: name, container: cname, image: a.image, urls: urls, ports: clone(vm.ports), replaced: res.replaced };
}

async function opDeploy(t, a) { return deployInto(t, a, { base: 0, total: 5 }); }

// ---------------------------------------------------------------------------
// one-shot: image reference -> new VM -> running container
// ---------------------------------------------------------------------------
async function opQuickDeploy(t, a) {
  const name = a.name;
  const total = 7;
  const pre = clone(a.pre);
  t.log('Image    : ' + a.image);
  t.log('VM       : ' + name + '   (' + a.mem + ' MB, ' + a.cpus + ' vCPU, template ' + a.template + ')');
  let created = false;
  try {
    t.step('Step 1/' + total + ': creating the VM "' + name + '"...');
    // hold the named host ports until the VM record owns them, so the SSH
    // port allocation cannot pick one of them
    for (const q of pre) ports.claim(q.host, 300000, name);
    try {
      await vmMod.opCreate(t, {
        name: name, template: a.template, templateFile: vmMod.findTemplate(a.template), mem: a.mem, cpus: a.cpus,
        accel: 'auto', port: null, ports: pre, sshLan: false, start: false, waitS: 0,
        ephemeral: a.ephemeral, autostart: false, note: 'deployed from ' + a.image, createdBy: a.createdBy,
      });
    } finally {
      for (const q of pre) ports.release(q.host, name);
      for (const p of a.claimed || []) ports.release(p, name);
    }
    created = true;
    if (pre.length) t.log('Forwards from the first boot: ' + pre.map(ports.describe).join(', '));

    t.step('Step 2/' + total + ': booting "' + name + '" (usually under 30 s with hardware acceleration, a few minutes without)...');
    await vmMod.opStart(t, { name: name, waitS: a.waitS });

    const res = await deployInto(t, a, { base: 2, total: total });
    const vm = st.getVm(name);
    t.log('Done. VM "' + name + '"' + (res.urls.length ? ' -> ' + res.urls.map((u) => u.url).join('  ') : ''));
    return Object.assign({ sandbox: name }, res, { ssh: ssh.sshCommandText(vm.port) });
  } catch (e) {
    // What happened to the VM comes FIRST in the error, so the cause that
    // follows (which may say "the VM is still running") reads in context.
    let prefix = '';
    if (created && state.vms[name]) {
      if (a.keepOnFailure) {
        prefix = 'Quick deploy failed; the VM "' + name + '" was kept for inspection (keepOnFailure): ';
        t.log('The deploy failed - keeping the VM "' + name + '" as asked (keepOnFailure).');
      } else {
        t.log('The deploy failed (' + errMsg(e).split('\n')[0] + ') - deleting the VM "' + name + '" it created (pass keepOnFailure to keep it)...');
        try {
          // it was made moments ago and holds nothing: no graceful shutdown
          // wait (a guest that never booted would not answer one anyway)
          try { await vmMod.opStop(t, { name: name, force: true, timeoutS: 5 }); }
          catch (e3) { t.warn('force stop: ' + errMsg(e3).split('\n')[0]); }
          await vmMod.opDelete(t, { name: name });
          prefix = 'Quick deploy failed, so the VM "' + name + '" it created was deleted (pass keepOnFailure to keep it): ';
        } catch (e2) {
          t.warn('could not delete "' + name + '": ' + errMsg(e2));
          prefix = 'Quick deploy failed and the VM "' + name + '" it created could not be deleted (' + errMsg(e2).split('\n')[0] + '): ';
        }
      }
    }
    if (e && typeof e === 'object' && typeof e.message === 'string') { e.message = prefix + e.message; throw e; }
    throw new Error(prefix + errMsg(e));
  }
}

module.exports = {
  SETTLE_S,
  planDeployPorts, planPortMappings, parseRunResult, parseDeployOutput,
  volumeMounts, buildRunCommand, redeployScript, containerNameFor,
  validateDeploy, opDeploy,
  validateQuickDeploy, opQuickDeploy,
  // tests only
  _internal: { planWithFreePorts: planWithFreePorts },
};
