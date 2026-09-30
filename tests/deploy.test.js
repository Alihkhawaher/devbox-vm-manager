'use strict';
/*
 * Tests for lib/deploy.js: port planning (reserved ports, LAN choice, host
 * networking, redeploys), the docker run line, the safe-redeploy script with
 * its rollback (run through a real POSIX sh against a stateful fake `docker`
 * when a sh is available), forward rollback, and quick deploy (validation
 * before any VM exists, cleanup unless keepOnFailure, the task always ends).
 *
 * No VM, QEMU or ssh is needed: deploy.js reaches them through module
 * objects (ssh.sshExec, vm.*, monitor.*, platform.*), which each test
 * replaces and restores.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const helpers = require('./helpers');
const deploy = require('../lib/deploy');
const docker = require('../lib/docker');
const ssh = require('../lib/ssh');
const vmMod = require('../lib/vm');
const monitor = require('../lib/monitor');
const platform = require('../lib/platform');
const ports = require('../lib/ports');
const tasks = require('../lib/tasks');
const st = require('../lib/state');
const { CFG } = require('../lib/config');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const SH = (() => {
  for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
  }
  return null;
})();
const NO_SH = !SH && 'no POSIX sh on this machine';
function sh(script, opts) {
  opts = opts || {};
  try {
    const out = execFileSync(SH, ['-c', script], { input: opts.input, env: Object.assign({}, process.env, opts.env || {}), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const slash = (p) => p.replace(/\\/g, '/');

function stubs() {
  const saved = [];
  return {
    set(obj, key, val) { saved.push([obj, key, obj[key]]); obj[key] = val; },
    restore() { while (saved.length) { const [o, k, v] = saved.pop(); o[k] = v; } },
  };
}
function fakeTask() {
  const lines = [];
  return {
    id: 'test-task', lines: lines,
    log: (m) => lines.push(String(m)), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARNING: ' + m),
    text: () => lines.join('\n'),
  };
}
function useRegistry(vms) {
  const dir = helpers.useTempRoot('deploy');
  // validators claim host ports for the task that follows; tests that only
  // validate never run it, so start every test with no claims
  ports._resetClaims();
  for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
  for (const k of Object.keys(vms)) st.state.vms[k] = st.newVmRecord(vms[k]);
  st.state.settings.defaultExpose = 'local';
  return () => {
    for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
    st.state.settings.defaultExpose = 'local';
    helpers.resetConfig();
    helpers.rm(dir);
  };
}
const RUNTIME = () => ({ pid: 4242, startedAt: new Date().toISOString(), accel: 'tcg', monitor: { host: '127.0.0.2', port: 50001 }, serial: null });

// The VM is running with SSH up; the monitor accepts everything and records
// it; every host port is free. Returns the live-forward log.
function runningVm(s) {
  const live = { added: [], removed: [], restarts: 0 };
  s.set(vmMod, 'requireSshReady', async (name) => st.getVm(name));
  s.set(vmMod, 'isRunning', async () => true);
  s.set(vmMod, 'opRestart', async () => { live.restarts++; return {}; });
  s.set(monitor, 'addForwardLive', async (vm, m) => { live.added.push(m.lan ? m.host + '/lan' : m.host); return { ok: true, why: null }; });
  s.set(monitor, 'removeForwardLive', async (vm, m) => { live.removed.push(m.lan ? m.host + '/lan' : m.host); return { ok: true, why: null }; });
  s.set(platform, 'isPortFree', async () => true);
  s.set(platform, 'hostTimezone', () => 'America/New_York');
  return live;
}

// A JS fake guest: [regex, result] rules, first match wins.
function fakeGuest(s, rules) {
  const calls = [];
  s.set(ssh, 'sshExec', async (tg, cmd, opts) => {
    calls.push(cmd);
    for (const [re, res] of rules) {
      if (re.test(cmd)) {
        const r = typeof res === 'function' ? res(cmd, opts || {}) : res;
        return Object.assign({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }, r, { ok: (r.code || 0) === 0 });
      }
    }
    return { code: 99, stdout: '', stderr: 'fake guest: unexpected command', ok: false, timedOut: false };
  });
  return calls;
}
const NGINX_CONFIG = JSON.stringify({ ExposedPorts: { '80/tcp': {} }, Volumes: { '/usr/share/nginx/html': {} }, Env: ['PATH=/usr/bin'] });
function guestRules(extra) {
  return (extra || []).concat([
    [/__DOCKER=MISSING/, { stdout: '__DOCKER=27.3.1\n' }],
    [/image inspect --format/, { stdout: NGINX_CONFIG + '\n' }],
    [/docker image inspect -- /, { code: 0 }],
    [/__RC=/, { stdout: 'abc\n__STATE=running 0 0\n__RC=0\n' }],
  ]);
}

// A stateful fake `docker` for a real sh: containers are folders under
// $FD/c/<name> holding st (status), ec (exit code), rs (restarts).
// FAKE_RUN = ok | fail | crash | oneshot | loop; FAKE_RENAME = ok | fail.
const FAKE_DOCKER = [
  'docker() {',
  '  printf "%s\\n" "docker $*" >> "$FD/calls"',
  '  op=$1; shift',
  '  case "$op" in container|image) op="$op-$1"; shift ;; esac',
  "  fmt=''; name=''",
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in --format) fmt=$2; shift 2; continue ;; --name) name=$2; shift 2; continue ;; --) shift; break ;; esac',
  '    shift',
  '  done',
  '  C="$FD/c"',
  '  case "$op" in',
  '    version) echo "${FAKE_VERSION:-27.3.1}"; return 0 ;;',
  '    image-inspect) case "$fmt" in *Config*) printf "%s\\n" "$FAKE_CONFIG"; return 0 ;; esac; [ -n "$FAKE_HAS_IMAGE" ]; return $? ;;',
  '    pull) echo "Pulled $1"; return ${FAKE_PULL_RC:-0} ;;',
  '    container-inspect|inspect)',
  '      [ -d "$C/$1" ] || { echo "Error: No such container: $1" >&2; return 1; }',
  '      case "$fmt" in',
  '        *State.Running*) if [ "$(cat "$C/$1/st")" = running ]; then echo true; else echo false; fi ;;',
  '        *State.Status*) echo "$(cat "$C/$1/st") $(cat "$C/$1/ec") $(cat "$C/$1/rs")" ;;',
  '        *Name*) echo "/$1" ;;',
  '      esac; return 0 ;;',
  '    rename)',
  '      if [ "${FAKE_RENAME:-ok}" = fail ]; then echo "Error response from daemon: rename refused"; return 1; fi',
  '      [ -d "$C/$1" ] || { echo "Error: No such container: $1"; return 1; }',
  '      [ -d "$C/$2" ] && { echo "Error: the name $2 is in use"; return 1; }',
  '      mv "$C/$1" "$C/$2"; return 0 ;;',
  '    stop) [ -d "$C/$1" ] || return 1; echo exited > "$C/$1/st"; echo 0 > "$C/$1/ec"; return 0 ;;',
  '    start) [ -d "$C/$1" ] || return 1; echo running > "$C/$1/st"; return 0 ;;',
  '    rm) [ -d "$C/$1" ] || { echo "Error: No such container: $1"; return 1; }; rm -rf "$C/$1"; return 0 ;;',
  '    logs) echo "fake log: $1 could not bind its port"; return 0 ;;',
  '    run)',
  '      [ -d "$C/$name" ] && { echo "docker: Error response from daemon: Conflict. The container name /$name is already in use."; return 125; }',
  '      mkdir -p "$C/$name"; echo "$1" > "$C/$name/img"; echo 0 > "$C/$name/ec"; echo 0 > "$C/$name/rs"',
  '      case "${FAKE_RUN:-ok}" in',
  // (docker prints its usage trailer after the error, as the real one does)
  '        fail) echo created > "$C/$name/st"; echo "docker: Error response from daemon: port is already allocated."; echo; echo "Run \'docker run --help\' for more information"; return 125 ;;',
  '        crash) echo exited > "$C/$name/st"; echo 1 > "$C/$name/ec" ;;',
  '        oneshot) echo exited > "$C/$name/st" ;;',
  '        loop) echo restarting > "$C/$name/st"; echo 2 > "$C/$name/ec"; echo 3 > "$C/$name/rs" ;;',
  '        loop0) echo restarting > "$C/$name/st"; echo 2 > "$C/$name/rs" ;;',
  '        flap) echo running > "$C/$name/st"; echo 1 > "$C/$name/rs" ;;',
  '        *) echo running > "$C/$name/st" ;;',
  '      esac',
  '      echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; return 0 ;;',
  '  esac',
  '  echo "fake docker: unsupported: $op $*" >&2; return 2',
  '}',
].join('\n');

// A fake guest that RUNS each command in a real sh with the fake docker.
// Guest paths are moved into the scratch folder, so nothing outside it is
// touched. env is read at call time (tests change FAKE_RUN between deploys).
function shGuest(s, fd, env) {
  const root = slash(fd);
  fs.mkdirSync(path.join(fd, 'c'), { recursive: true });
  const calls = [];
  s.set(ssh, 'sshExec', async (tg, cmd, opts) => {
    calls.push(cmd);
    const script = cmd.split('/etc/localtime').join(root + '/localtime')
      .split('/usr/share/zoneinfo/').join(root + '/zoneinfo/')
      .split('/opt/').join(root + '/opt/');
    const r = sh(FAKE_DOCKER + '\n' + script, { input: opts && opts.input, env: Object.assign({ FD: root }, env) });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, ok: r.code === 0, timedOut: false, truncated: false };
  });
  return calls;
}
function container(fd, name) {
  const d = path.join(fd, 'c', name);
  if (!fs.existsSync(d)) return null;
  const rd = (f) => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch (e) { return null; } };
  return { st: rd('st'), ec: rd('ec'), img: rd('img'), marker: rd('marker') };
}

// ---------------------------------------------------------------------------
// port planning
// ---------------------------------------------------------------------------
test('planDeployPorts: a plain redeploy keeps every forward the container owns (and their LAN choice), adds new image ports', () => {
  const own = [
    { host: 8080, guest: 8080, container: 80, owner: 'web', lan: true },
    { host: 9001, guest: 9001, container: 9000, owner: 'web', lan: false },
  ];
  const p = deploy.planDeployPorts({ vmPorts: own.concat([{ host: 3000, guest: 3000, lan: false }]), sshPort: 2223, cname: 'web', explicit: [], imagePorts: [80, 443], taken: new Set() });
  assert.deepEqual(p.rows, [
    { host: 8080, guest: 8080, container: 80, owner: 'web', lan: true },
    { host: 9001, guest: 9001, container: 9000, owner: 'web', lan: false },
    { host: 443, guest: 443, container: 443, owner: 'web', lan: false },
  ]);
  assert.deepEqual(p.added.map((q) => q.host), [443]);
  assert.deepEqual(p.removed, []);
  assert.deepEqual(p.kept.map((q) => q.host), [8080, 9001]);
});

test('planDeployPorts: explicit ports replace the old ones; same host port with a new container port is retargeted, not re-opened', () => {
  const own = [{ host: 8080, guest: 8080, container: 80, owner: 'web', lan: false }, { host: 9443, guest: 9443, container: 443, owner: 'web', lan: false }];
  // 8080 now goes to container port 8000 (same QEMU forward), 443 is dropped
  const p = deploy.planDeployPorts({ vmPorts: own, sshPort: 2223, cname: 'web', explicit: [{ host: 8080, guest: 8000, lan: false }], imagePorts: [], taken: new Set() });
  assert.deepEqual(p.rows, [{ host: 8080, guest: 8080, container: 8000, owner: 'web', lan: false }]);
  assert.deepEqual(p.added, []);
  assert.deepEqual(p.removed.map((q) => q.host), [9443]);
  // switching an existing forward to the LAN re-opens it with the other bind address
  const q = deploy.planDeployPorts({ vmPorts: own, sshPort: 2223, cname: 'web', explicit: [{ host: 8080, guest: 80, lan: true }], imagePorts: [80], taken: new Set() });
  assert.deepEqual(q.added, [{ host: 8080, guest: 8080, container: 80, owner: 'web', lan: true }]);
  assert.deepEqual(q.removed.map((x) => x.host + (x.lan ? '/lan' : '')).sort(), ['8080', '9443']);
});

test('planDeployPorts: derived host ports skip reserved, other VMs\' and the SSH port; the LAN default applies to image ports', () => {
  const p = deploy.planDeployPorts({
    vmPorts: [{ host: 8081, guest: 80, container: 80, owner: 'other', lan: false }], sshPort: 8082, cname: 'web',
    explicit: [], imagePorts: [80, 8081], taken: new Set([80, 81]), defaultLan: true,
  });
  // container 80: guest 80 is published by "other" -> 81; host 81 is taken, 8081/8082 too -> first free above
  assert.deepEqual(p.rows[0], { host: 82, guest: 81, container: 80, owner: 'web', lan: true });
  assert.equal(p.rows[1].container, 8081);
  assert.ok(![8081, 8082, 80, 81, 82].includes(p.rows[1].host), JSON.stringify(p.rows[1]));
  assert.equal(p.rows[1].lan, true);
});

test('planDeployPorts: where low ports need root (Linux), derived host ports for 80/443 become 8080/8443; explicit ones are kept', () => {
  const p = deploy.planDeployPorts({ vmPorts: [], cname: 'web', explicit: [], imagePorts: [80, 443, 3000], taken: new Set([8080]), unprivileged: true });
  assert.deepEqual(p.rows.map((q) => [q.host, q.guest]), [[8081, 80], [8443, 443], [3000, 3000]]);
  const e = deploy.planDeployPorts({ vmPorts: [], cname: 'web', explicit: [{ host: 80, guest: 80 }], imagePorts: [], taken: new Set(), unprivileged: true });
  assert.equal(e.rows[0].host, 80);
  // without the restriction the container port is the first choice (as in v1)
  assert.equal(deploy.planDeployPorts({ vmPorts: [], cname: 'web', explicit: [], imagePorts: [80], taken: new Set() }).rows[0].host, 80);
});

test('planDeployPorts: host networking forwards host -> the container port itself and refuses a guest port in use (BUG-18)', () => {
  const p = deploy.planDeployPorts({ vmPorts: [], cname: 'ha', explicit: [{ host: 8124, guest: 8123, lan: false }], imagePorts: [8123], taken: new Set(), hostNetwork: true });
  assert.deepEqual(p.rows, [{ host: 8124, guest: 8123, container: 8123, owner: 'ha', lan: false }]);
  // two host ports to the same container port are fine with host networking
  const two = deploy.planDeployPorts({ vmPorts: [], cname: 'ha', explicit: [{ host: 8124, guest: 8123 }, { host: 8125, guest: 8123 }], imagePorts: [], taken: new Set(), hostNetwork: true });
  assert.deepEqual(two.rows.map((q) => q.guest), [8123, 8123]);
  // guest 8123 already forwarded for someone else: a clear 409, not a dead URL
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [{ host: 9000, guest: 8123, owner: 'x' }], cname: 'ha', explicit: [], imagePorts: [8123], taken: new Set(), hostNetwork: true }),
    (e) => e.status === 409 && /8123 inside the VM/.test(e.message));
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [], cname: 'ssh', explicit: [], imagePorts: [22], taken: new Set(), hostNetwork: true }), (e) => e.status === 409 && /SSH/.test(e.message));
  // a bridge-mode forward reused under host networking is moved to guest == container
  const moved = deploy.planDeployPorts({ vmPorts: [{ host: 8080, guest: 8081, container: 80, owner: 'w' }], cname: 'w', explicit: [], imagePorts: [], taken: new Set(), hostNetwork: true });
  assert.deepEqual(moved.rows, [{ host: 8080, guest: 80, container: 80, owner: 'w', lan: false }]);
  assert.equal(moved.added.length, 1);
  assert.equal(moved.removed.length, 1);
});

test('planDeployPorts: an explicit host port that is taken is a 409; running out of ports is a 409', () => {
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [{ host: 8080, guest: 80, owner: 'db' }], cname: 'web', explicit: [{ host: 8080, guest: 80 }], taken: new Set() }), (e) => e.status === 409);
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [], cname: 'web', explicit: [{ host: 8080, guest: 80 }, { host: 8080, guest: 81 }], taken: new Set() }), (e) => e.status === 409);
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [], cname: 'web', explicit: [], imagePorts: [65535], taken: new Set([65535]) }), (e) => e.status === 409 && /ran out/.test(e.message));
  // the v2.0 API returns only the new forwards
  assert.deepEqual(deploy.planPortMappings({ vmPorts: [], cname: 'x', explicit: [], imagePorts: [5000], taken: new Set() }),
    [{ host: 5000, guest: 5000, container: 5000, owner: 'x', lan: false }]);
});

test('planDeployPorts: a UDP publish stays UDP (rows, docker -p, keys); TCP and UDP may share a number; image ports are TCP', () => {
  // the GUI sends "lan:53:53/udp" rows; the microVM fallback sends {proto:'udp'}
  const p = deploy.planDeployPorts({
    vmPorts: [], cname: 'dns', explicit: [{ host: 5353, guest: 53, lan: true, proto: 'udp' }, { host: 5353, guest: 53, lan: true }],
    imagePorts: [53], taken: new Set(),
  });
  assert.deepEqual(p.rows, [
    { host: 5353, guest: 5353, container: 53, owner: 'dns', lan: true, proto: 'udp' },
    { host: 5353, guest: 5353, container: 53, owner: 'dns', lan: true },
  ]);
  // the TCP image port 53 is covered by the TCP row only - no third forward
  assert.equal(p.added.length, 2);
  const cmd = deploy.buildRunCommand({ containerName: 'dns', image: 'x', env: [], volumes: [] }, p.rows, [], 'UTC');
  assert.ok(cmd.includes("-p '5353:53/udp'") && cmd.includes("-p '5353:53' "), cmd);
  // a UDP image port is not "covered" by a TCP explicit row with that number
  const q = deploy.planDeployPorts({ vmPorts: [], cname: 'x', explicit: [{ host: 9000, guest: 80, proto: 'udp' }], imagePorts: [80], taken: new Set() });
  assert.deepEqual(q.rows.map((r) => [r.host, r.container, r.proto || 'tcp']), [[9000, 80, 'udp'], [80, 80, 'tcp']]);
  // turning 5353/tcp into 5353/udp is a close plus an open (fwdKey has the protocol)
  const own = [{ host: 5353, guest: 5353, container: 53, owner: 'dns', lan: false }];
  const r = deploy.planDeployPorts({ vmPorts: own, cname: 'dns', explicit: [{ host: 5353, guest: 53, proto: 'udp' }], imagePorts: [], taken: new Set() });
  assert.deepEqual(r.added.map((x) => x.proto), ['udp']);
  assert.deepEqual(r.removed.map((x) => x.proto || 'tcp'), ['tcp']);
  // two UDP rows on one host port are still a conflict; a number another VM holds counts for both
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [], cname: 'x', explicit: [{ host: 7, guest: 7, proto: 'udp' }, { host: 7, guest: 8, proto: 'udp' }], taken: new Set() }), (e) => e.status === 409);
  assert.throws(() => deploy.planDeployPorts({ vmPorts: [], cname: 'x', explicit: [{ host: 7, guest: 7, proto: 'udp' }], taken: new Set([7]) }), (e) => e.status === 409);
});

test('the microVM fallback body keeps UDP ports (quickDeployBody)', () => {
  const containers = require('../lib/microvm/containers');
  const q = containers.quickDeployBody({ image: 'x', ports: [{ host: 5353, guest: 53, proto: 'udp', lan: true, auto: false }, { host: 8080, guest: 80, lan: false, auto: false }], env: [] }, { mounts: { volumes: [], shares: [], copyIn: [] } });
  assert.deepEqual(q.body.ports, [{ host: 5353, guest: 53, lan: true, proto: 'udp' }, { host: 8080, guest: 80, lan: false }]);
});

// ---------------------------------------------------------------------------
// the container command
// ---------------------------------------------------------------------------
test('volumeMounts: one VM folder per safe image volume; volumes the caller mapped are left to them', () => {
  assert.deepEqual(deploy.volumeMounts('pg', ['/var/lib/postgresql/data', '/etc/conf/', '/', 'bad;x', '/a/../b'], ['/srv/pg:/var/lib/postgresql/data']), [
    { dir: '/opt/pg/etc_conf', path: '/etc/conf/' },
  ]);
  assert.deepEqual(deploy.volumeMounts('x', ['/a_b', '/a/b']).map((m) => m.dir), ['/opt/x/a_b', '/opt/x/a_b_']);
});

test('buildRunCommand: -p guest:container per forward (none with host networking), host TZ, quoted values, "--" before the image', () => {
  const a = { containerName: 'web', restartPolicy: 'unless-stopped', image: 'nginx:alpine', env: ['A=1,2'], volumes: ['/srv/x:/x:ro'], privileged: true };
  const rows = [{ host: 8080, guest: 8081, container: 80 }, { host: 8443, guest: 443 }];
  assert.equal(deploy.buildRunCommand(a, rows, [{ dir: '/opt/web/data', path: '/data' }], 'America/New_York'),
    "docker run -d --name 'web' --restart 'unless-stopped' --privileged -p '8081:80' -p '443:443' -e 'TZ=America/New_York' -e 'A=1,2' " +
    "-v '/opt/web/data:/data' -v '/srv/x:/x:ro' -- 'nginx:alpine'");
  const hn = deploy.buildRunCommand(Object.assign({}, a, { hostNetwork: true, privileged: false, env: ['TZ=UTC'] }), rows, [], 'America/New_York');
  assert.ok(hn.includes('--network host') && !hn.includes('-p ') && !hn.includes('America/New_York'), hn);
  assert.ok(deploy.buildRunCommand(a, [], [], '$(reboot)').includes("'TZ=UTC'"));
});

test('buildRunCommand in a real sh: hostile env and volume values reach docker as exact single arguments', { skip: NO_SH }, () => {
  const env = ['X=$(touch /tmp/pwned)', "Y=it's;id", 'Z=`reboot`', 'W=a,b c'];
  const cmd = deploy.buildRunCommand({ containerName: 'c', image: 'img', env: env, volumes: [] }, [], [], 'UTC');
  const r = sh('docker() { for x in "$@"; do printf "<%s>\\n" "$x"; done; }\n' + cmd);
  assert.equal(r.code, 0, r.stderr);
  const got = r.stdout.trim().split('\n').map((l) => l.slice(1, -1));
  assert.deepEqual(got, ['run', '-d', '--name', 'c', '--restart', 'unless-stopped', '-e', 'TZ=UTC'].concat(...env.map((e) => ['-e', e]), ['--', 'img']));
});

test('parseDeployOutput: markers, container log block, rollback; a missing __RC is not success (MNT-8)', () => {
  const out = 'The existing container web is kept as web-prev until the new one runs\n__HAD=1\n0123abc\n__STATE=exited 1 0\n__LOGS__\nError: listen EADDRINUSE :80\n__RC=0 printed by the app\n__ENDLOGS__\n__ROLLBACK=started\n__RC=98\n';
  const r = deploy.parseDeployOutput(out);
  assert.equal(r.rc, 98);
  assert.equal(r.replaced, true);
  assert.deepEqual(r.state, { status: 'exited', exitCode: 1, restarts: 0 });
  assert.equal(r.rollback, 'started');
  assert.equal(r.logs, 'Error: listen EADDRINUSE :80\n__RC=0 printed by the app');
  assert.equal(r.body, 'The existing container web is kept as web-prev until the new one runs\n0123abc');
  assert.equal(deploy.parseDeployOutput('abc\r\n__RC=0\r\n').rc, 0);
  assert.equal(deploy.parseDeployOutput('abc').rc, null);
  assert.equal(deploy.parseDeployOutput('').rc, null);
});

// ---------------------------------------------------------------------------
// the safe-redeploy script (XTR-9) in a real sh
// ---------------------------------------------------------------------------
function runScript(fd, env, opts) {
  const root = slash(fd);
  const run = deploy.buildRunCommand({ containerName: 'web', image: opts && opts.image || 'nginx:2', env: [], volumes: [] }, [{ host: 8080, guest: 8080, container: 80 }], [], 'UTC');
  const script = deploy.redeployScript({ cname: 'web', run: run, dirs: [root + '/opt/web/data'], fix: '', settleS: 0 });
  const r = sh(FAKE_DOCKER + '\n' + script, { env: Object.assign({ FD: root }, env || {}) });
  return Object.assign(deploy.parseDeployOutput(r.stdout), { raw: r });
}
function makeContainer(fd, name, stt, marker) {
  const d = path.join(fd, 'c', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'st'), stt + '\n');
  fs.writeFileSync(path.join(d, 'ec'), '0\n');
  fs.writeFileSync(path.join(d, 'rs'), '0\n');
  fs.writeFileSync(path.join(d, 'img'), 'nginx:1\n');
  if (marker) fs.writeFileSync(path.join(d, 'marker'), marker);
}
function withFd(fn) {
  const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-redeploy-'));
  fs.mkdirSync(path.join(fd, 'c'));
  try { return fn(fd); } finally { helpers.rm(fd); }
}

test('redeployScript is valid POSIX sh', { skip: NO_SH }, () => {
  const s = deploy.redeployScript({ cname: 'web', run: "docker run -d --name 'web' -- 'x'", dirs: ['/opt/web/a b'], fix: docker.localtimeFix('UTC') });
  const r = sh('set -n\n' + s);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!/[\r\n]/.test(s), 'one line');
  assert.ok(s.startsWith("trap '' HUP PIPE"), 'survives a dropped SSH connection');
  assert.ok(s.includes('sleep ' + deploy.SETTLE_S));
});

test('redeploy script: a fresh deploy runs the container and creates its volume folders', { skip: NO_SH }, () => withFd((fd) => {
  const r = runScript(fd);
  assert.equal(r.rc, 0, r.raw.stdout + r.raw.stderr);
  assert.equal(r.replaced, false);
  assert.deepEqual(r.state, { status: 'running', exitCode: 0, restarts: 0 });
  assert.equal(r.rollback, null);
  assert.equal(container(fd, 'web').st, 'running');
  assert.ok(fs.statSync(path.join(fd, 'opt', 'web', 'data')).isDirectory());
}));

test('redeploy script: success replaces the old container and removes the rollback copy', { skip: NO_SH }, () => withFd((fd) => {
  makeContainer(fd, 'web', 'running', 'old');
  const r = runScript(fd);
  assert.equal(r.rc, 0, r.raw.stdout);
  assert.equal(r.replaced, true);
  const c = container(fd, 'web');
  assert.equal(c.st, 'running');
  assert.equal(c.img, 'nginx:2');
  assert.equal(c.marker, null, 'the new container, not the old one');
  assert.equal(container(fd, 'web-prev'), null);
  // the old one was stopped BEFORE the new one ran (its ports were free)
  const calls = fs.readFileSync(path.join(fd, 'calls'), 'utf8');
  assert.ok(calls.indexOf('docker stop -- web-prev') < calls.indexOf('docker run'), calls);
}));

test('redeploy script: docker run fails -> the new one is removed and the old one is back and running', { skip: NO_SH }, () => withFd((fd) => {
  makeContainer(fd, 'web', 'running', 'old');
  const r = runScript(fd, { FAKE_RUN: 'fail' });
  assert.equal(r.rc, 125);
  assert.equal(r.rollback, 'started');
  assert.match(r.body, /port is already allocated/);
  const c = container(fd, 'web');
  assert.equal(c.marker, 'old');
  assert.equal(c.st, 'running');
  assert.equal(container(fd, 'web-prev'), null);
}));

test('redeploy script: the new container crashes on start -> its log is captured, the old one is restored', { skip: NO_SH }, () => withFd((fd) => {
  makeContainer(fd, 'web', 'running', 'old');
  const r = runScript(fd, { FAKE_RUN: 'crash' });
  assert.equal(r.rc, 98);
  assert.deepEqual(r.state, { status: 'exited', exitCode: 1, restarts: 0 });
  assert.match(r.logs, /fake log: web could not bind its port/);
  assert.equal(r.rollback, 'started');
  assert.equal(container(fd, 'web').marker, 'old');
  // a crash loop (restarting, non-zero exit) is a failure too
  const loop = runScript(fd, { FAKE_RUN: 'loop' });
  assert.equal(loop.rc, 98);
  assert.equal(container(fd, 'web').marker, 'old');
  // found on a real guest: a command that ends at once with exit code 0 is
  // looped by the restart policy ("Restarting (0)") - not a running service
  const loop0 = runScript(fd, { FAKE_RUN: 'loop0' });
  assert.equal(loop0.rc, 98);
  assert.deepEqual(loop0.state, { status: 'restarting', exitCode: 0, restarts: 2 });
  assert.equal(container(fd, 'web').marker, 'old');
  // running again, but it already restarted within the settle time
  assert.equal(runScript(fd, { FAKE_RUN: 'flap' }).rc, 98);
  assert.equal(container(fd, 'web').marker, 'old');
}));

test('redeploy script: an old container that was stopped is restored but not started', { skip: NO_SH }, () => withFd((fd) => {
  makeContainer(fd, 'web', 'exited', 'old');
  const r = runScript(fd, { FAKE_RUN: 'fail' });
  assert.equal(r.rollback, 'restored');
  assert.equal(container(fd, 'web').st, 'exited');
  assert.equal(container(fd, 'web').marker, 'old');
}));

test('redeploy script: a one-shot container that exits 0 is fine; a fresh failure leaves nothing behind', { skip: NO_SH }, () => withFd((fd) => {
  assert.equal(runScript(fd, { FAKE_RUN: 'oneshot' }).rc, 0);
  fs.rmSync(path.join(fd, 'c', 'web'), { recursive: true });
  const r = runScript(fd, { FAKE_RUN: 'fail' });
  assert.equal(r.rc, 125);
  assert.equal(r.rollback, null);
  assert.equal(container(fd, 'web'), null, 'the half-created container is removed');
}));

test('redeploy script: never touches a "<name>-prev" it did not make; a failed rename changes nothing', { skip: NO_SH }, () => withFd((fd) => {
  makeContainer(fd, 'web', 'running', 'old');
  makeContainer(fd, 'web-prev', 'running', 'users-own');
  const r = runScript(fd);
  assert.equal(r.rc, 96);
  assert.match(r.body, /web-prev already exists/);
  assert.equal(container(fd, 'web-prev').marker, 'users-own');
  assert.equal(container(fd, 'web').marker, 'old');
  assert.doesNotMatch(fs.readFileSync(path.join(fd, 'calls'), 'utf8'), /docker (run|rm|rename)/);
  fs.rmSync(path.join(fd, 'c', 'web-prev'), { recursive: true });
  const r2 = runScript(fd, { FAKE_RENAME: 'fail' });
  assert.equal(r2.rc, 97);
  assert.equal(container(fd, 'web').st, 'running');
  assert.equal(container(fd, 'web').marker, 'old');
}));

// ---------------------------------------------------------------------------
// opDeploy end to end, the guest being a real sh with the fake docker
// ---------------------------------------------------------------------------
test('opDeploy (sh guest): deploy, redeploy, failed redeploy with new ports -> container AND forwards rolled back', { skip: NO_SH }, async () => {
  const s = stubs();
  const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-deploy-'));
  const done = useRegistry({ box: { port: 2230, runtime: RUNTIME(), ports: [{ host: 3000, guest: 3000, lan: true }] } });
  try {
    const live = runningVm(s);
    const env = { FAKE_CONFIG: NGINX_CONFIG, FAKE_HAS_IMAGE: '' };
    shGuest(s, fd, env);
    const body = { name: 'box', image: 'nginx:alpine', ports: '8080:80', env: 'GREETING=hi,there' };
    const a = await deploy.validateDeploy(body);
    a.settleS = 0;
    const t = fakeTask();
    const res = await deploy.opDeploy(t, a);
    // env values stay out of the task log (security-3)
    assert.match(t.text(), /-e 'GREETING=\*\*\*'/);
    assert.equal(t.text().indexOf('hi,there'), -1);
    assert.equal(ports.reservedPorts({ exceptVm: 'other' }).get(8080), 'a port forward of VM "box"', 'the deploy\'s claim became the record');
    assert.equal(res.container, 'nginx');
    assert.deepEqual(res.urls, [{ url: 'http://127.0.0.1:8080', lan: false, host: 8080 }]);
    assert.equal(res.replaced, false);
    assert.deepEqual(st.state.vms.box.ports, [
      { host: 3000, guest: 3000, lan: true },
      { host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false },
    ]);
    assert.deepEqual(live.added, [8080]);
    assert.equal(live.restarts, 0);
    const calls = fs.readFileSync(path.join(fd, 'calls'), 'utf8');
    assert.match(calls, /docker pull -- nginx:alpine/, 'pulled because it was missing');
    assert.match(calls, /-p 8080:80 -e TZ=America\/New_York -e GREETING=hi,there -v .*\/opt\/nginx\/usr_share_nginx_html:\/usr\/share\/nginx\/html -- nginx:alpine/);
    assert.equal(container(fd, 'nginx').st, 'running');
    assert.ok(fs.existsSync(path.join(fd, 'localtime')), '/etc/localtime made a file first');
    assert.match(t.text(), /STEP Step 5\/5: starting the container "nginx"/);

    // a plain redeploy (no ports given): same forwards, nothing re-opened
    fs.writeFileSync(path.join(fd, 'c', 'nginx', 'marker'), 'v1');
    const a2 = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine' });
    a2.settleS = 0;
    const res2 = await deploy.opDeploy(fakeTask(), a2);
    assert.equal(res2.replaced, true);
    assert.deepEqual(res2.urls.map((u) => u.host), [8080]);
    assert.deepEqual(live.added, [8080]);
    assert.equal(container(fd, 'nginx').marker, null);
    fs.writeFileSync(path.join(fd, 'c', 'nginx', 'marker'), 'v2');

    // a redeploy on new ports whose container crashes: the old container
    // comes back AND 8080 is reopened while 9090 is closed again
    env.FAKE_RUN = 'crash';
    const a3 = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine', ports: ['lan:9090:80'] });
    a3.settleS = 0;
    const t3 = fakeTask();
    await assert.rejects(deploy.opDeploy(t3, a3), /stopped right after starting \(exited, exit code 1\).*restored and is running again/);
    assert.equal(container(fd, 'nginx').marker, 'v2');
    assert.equal(container(fd, 'nginx').st, 'running');
    assert.deepEqual(live.removed, [8080, '9090/lan']);
    assert.deepEqual(live.added, [8080, '9090/lan', 8080]);
    assert.deepEqual(st.state.vms.box.ports.map((q) => q.host), [3000, 8080]);
    assert.match(t3.text(), /fake log: nginx could not bind/);
    assert.match(t3.text(), /put back as they were/);
    const saved = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    assert.deepEqual(saved.vms.box.ports.map((q) => q.host), [3000, 8080]);

    // docker run itself fails: the error names docker's reason, not its
    // "Run 'docker run --help'" trailer (found on a real guest)
    env.FAKE_RUN = 'fail';
    const a4 = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine' });
    a4.settleS = 0;
    await assert.rejects(deploy.opDeploy(fakeTask(), a4), (e) => /docker run failed \(exit 125\): docker: Error response from daemon: port is already allocated\./.test(e.message) && !/--help/.test(e.message));
    assert.equal(container(fd, 'nginx').marker, 'v2');
    // a command that ends at once (exit 0) is looped by the restart policy
    env.FAKE_RUN = 'loop0';
    await assert.rejects(deploy.opDeploy(fakeTask(), a4), /restarting, exit code 0\).*finished at once: a deploy runs a long-lived service.*restored and is running again/);
    assert.equal(container(fd, 'nginx').marker, 'v2');
  } finally { s.restore(); done(); helpers.rm(fd); }
});

// ---------------------------------------------------------------------------
// opDeploy with a scripted guest (runs everywhere)
// ---------------------------------------------------------------------------
test('opDeploy: a host port another program grabbed is a clear 409 - no restart that would leave the VM unbootable (BUG-5)', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230, runtime: RUNTIME(), ports: [{ host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false }] } });
  try {
    const live = runningVm(s);
    fakeGuest(s, guestRules());
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine', ports: '9090:80' });
    // after validation someone else takes 9090; the monitor then fails to bind it
    s.set(monitor, 'addForwardLive', async (vm, m) => { live.added.push(m.host); return m.host === 9090 ? { ok: false, why: 'Could not set up host forwarding rule' } : { ok: true }; });
    s.set(platform, 'isPortFree', async (p) => p !== 9090);
    await assert.rejects(deploy.opDeploy(fakeTask(), a), (e) => e.status === 409 && /9090 could not be opened: another program on this PC is using it/.test(e.message));
    assert.equal(live.restarts, 0);
    // 8080 was closed first (the forward moved); it is reopened
    assert.deepEqual(live.removed, [8080]);
    assert.deepEqual(live.added, [9090, 8080]);
    assert.deepEqual(st.state.vms.box.ports, [{ host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false }]);
  } finally { s.restore(); done(); }
});

test('opDeploy: no usable monitor -> the forwards are saved and the VM restarts as a step of the same task', async () => {
  const s = stubs();
  const legacy = Object.assign(RUNTIME(), { legacy: true });
  const done = useRegistry({ box: { port: 2230, runtime: legacy } });
  try {
    const live = runningVm(s);
    let portsAtRestart = null;
    s.set(vmMod, 'opRestart', async (t, a) => { live.restarts++; portsAtRestart = st.state.vms.box.ports.map((q) => q.host); t.log('restarted ' + a.name); return {}; });
    const calls = fakeGuest(s, guestRules());
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine' });
    const t = fakeTask();
    const res = await deploy.opDeploy(t, a);
    assert.equal(live.restarts, 1);
    assert.deepEqual(portsAtRestart, [80], 'saved BEFORE the restart, so QEMU starts with them');
    assert.deepEqual(res.urls.map((u) => u.host), [80]);
    assert.match(t.text(), /older version of the manager\) - restarting the VM/);
    assert.match(t.text(), /restarted box/);
    assert.ok(calls.some((c) => /__RC=/.test(c)));
  } finally { s.restore(); done(); }
});

test('opDeploy: a failed restart puts the old forwards back and tries to start the VM again', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230, runtime: Object.assign(RUNTIME(), { legacy: true }) } });
  try {
    runningVm(s);
    s.set(vmMod, 'opRestart', async () => { throw new Error('host port 80 (forward 80 -> 80) is in use by another program'); });
    let started = 0;
    s.set(vmMod, 'isRunning', async () => false);
    s.set(vmMod, 'opStart', async () => { started++; return {}; });
    fakeGuest(s, guestRules());
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine' });
    await assert.rejects(deploy.opDeploy(fakeTask(), a), /needed a VM restart, and it failed: host port 80/);
    assert.deepEqual(st.state.vms.box.ports, []);
    assert.equal(started, 1);
  } finally { s.restore(); done(); }
});

test('opDeploy: SSH breaking during the run is an error with an unknown outcome - the forwards are kept for a retry', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230, runtime: RUNTIME() } });
  try {
    runningVm(s);
    fakeGuest(s, guestRules([[/__RC=/, { code: 255, stdout: 'abc\n', stderr: 'Connection reset by peer' }]]));
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpine', ports: '8080:80' });
    await assert.rejects(deploy.opDeploy(fakeTask(), a), /SSH connection failed while starting the container.*result is unknown/);
    assert.deepEqual(st.state.vms.box.ports.map((q) => q.host), [8080]);
  } finally { s.restore(); done(); }
});

test('opDeploy: Docker missing in the VM is installed first; an image that cannot be pulled fails before any port changes', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230, runtime: RUNTIME() } });
  try {
    const live = runningVm(s);
    const calls = fakeGuest(s, [
      [/__DOCKER=MISSING/, { stdout: '__DOCKER=MISSING\n' }],
      [/apk add/, { stdout: '__DOCKER=27.3.1\n' }],
      [/docker image inspect -- /, { code: 1 }],
      [/docker pull/, { code: 1, stdout: 'Error response from daemon: pull access denied for nginx, repository does not exist\n' }],
    ]);
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx:alpin', ports: '8080:80' });
    await assert.rejects(deploy.opDeploy(fakeTask(), a), /docker pull nginx:alpin failed \(exit 1\): .*pull access denied/);
    assert.ok(calls.some((c) => /apk add/.test(c)), 'installed Docker first');
    assert.deepEqual(live.added, []);
    assert.deepEqual(st.state.vms.box.ports, []);
  } finally { s.restore(); done(); }
});

test('validateDeploy: SSH port, another container\'s port, a port in use and host-network clashes are refused up front', async () => {
  const s = stubs();
  const done = useRegistry({
    box: { port: 2230, runtime: RUNTIME(), ports: [{ host: 8080, guest: 8080, container: 80, owner: 'db', lan: false }, { host: 9000, guest: 8123, owner: 'x', lan: false }] },
    other: { port: 2231, ports: [{ host: 7000, guest: 7000, lan: false }] },
  });
  try {
    runningVm(s);
    s.set(platform, 'isPortFree', async (p) => p !== 6000);
    const bad = async (body, status, re) => {
      await assert.rejects(deploy.validateDeploy(Object.assign({ name: 'box', image: 'nginx' }, body)), (e) => e.status === status && re.test(e.message), JSON.stringify(body));
    };
    await bad({ ports: '2230:80' }, 400, /SSH port of this VM/);
    await bad({ ports: '8080:80' }, 409, /the container "db"/);
    await bad({ ports: '7000:80' }, 409, /VM "other"/);
    await bad({ ports: '6000:80' }, 409, /in use by another program/);
    await bad({ ports: String(CFG.serverPort) + ':80' }, 409, /manager/);
    await bad({ ports: '80a' }, 400, /bad port mapping/);
    await bad({ ports: '70000:80' }, 400, /out of range/);
    await bad({ ports: '6001:8123', hostNetwork: true }, 409, /8123 inside the VM/);
    await bad({ env: 'b.example' }, 400, /NAME=value/);
    await bad({ volumes: 'C:\\HA\\config:/config' }, 400, /Windows path/);
    await bad({ image: 'nginx; reboot' }, 400, /image reference/);
    await bad({ containerName: '..' }, 400, /containerName/);
    await bad({ restartPolicy: 'sometimes' }, 400, /restartPolicy/);
    // the same container's own port is fine (a redeploy), and LAN is per request / per entry
    const a = await deploy.validateDeploy({ name: 'box', image: 'nginx', containerName: 'db', ports: ['8080:80', 'lan:8443:443'] });
    assert.deepEqual(a.explicit, [{ host: 8080, guest: 80, lan: false }, { host: 8443, guest: 443, lan: true }]);
    assert.equal((await deploy.validateDeploy({ name: 'box', image: 'nginx', lan: true, ports: '5000' })).explicit[0].lan, true);
    st.state.settings.defaultExpose = 'lan';
    assert.equal((await deploy.validateDeploy({ name: 'box', image: 'nginx', ports: '5000' })).lan, true);
    assert.equal((await deploy.validateDeploy({ name: 'box', image: 'nginx', ports: 'local:5000' })).explicit[0].lan, false);
  } finally { s.restore(); done(); }
});

test('two deploys at once on different VMs never plan the same derived host port (their plans are claimed at once - BUG-5)', async () => {
  const s = stubs();
  const done = useRegistry({ a: { port: 2230 }, b: { port: 2231 } });
  try {
    // the OS check is slow, as it is on a busy PC: both plans overlap in time
    s.set(platform, 'isPortFree', async () => { await new Promise((r) => setTimeout(r, 30)); return true; });
    const args = (name) => ({ name: name, containerName: 'web', explicit: [], lan: false, hostNetwork: false });
    const [pa, pb] = await Promise.all([
      deploy._internal.planWithFreePorts(st.state.vms.a, 'a', args('a'), [80]),
      deploy._internal.planWithFreePorts(st.state.vms.b, 'b', args('b'), [80]),
    ]);
    const ha = pa.added[0].host, hb = pb.added[0].host;
    assert.notEqual(ha, hb, 'both wanted ' + ha);
    assert.deepEqual(pa.claimed, [ha]);
    assert.match(ports.reservedPorts({ exceptVm: 'b' }).get(ha), /VM "a"/);
    for (const p of pa.claimed) ports.release(p, 'a');
    for (const p of pb.claimed) ports.release(p, 'b');
    assert.equal(ports.reservedPorts().has(ha), false);
  } finally { s.restore(); done(); }
});

// ---------------------------------------------------------------------------
// quick deploy
// ---------------------------------------------------------------------------
function quickEnv(s, opts) {
  opts = opts || {};
  const log = { created: [], deleted: [], started: [], stopped: [], claimedDuringCreate: null };
  runningVm(s);
  s.set(vmMod, 'findTemplate', (n) => (n === 'devbox-base' || (opts.dockerReady && n === 'docker-ready') ? '/fake/' + n + '.qcow2' : null));
  s.set(platform, 'findTool', (n) => '/fake/bin/' + n);
  s.set(vmMod, 'opCreate', async (t, a) => {
    log.created.push(a);
    log.claimedDuringCreate = a.ports.map((q) => ports.reservedPorts().has(q.host));
    st.state.vms[a.name] = st.newVmRecord({ port: 2240, mem: a.mem, cpus: a.cpus, ports: a.ports, template: a.template, ephemeral: a.ephemeral, createdBy: a.createdBy });
    st.saveState();
    return { name: a.name };
  });
  s.set(vmMod, 'opStart', async (t, a) => {
    log.started.push(a.name);
    if (opts.bootFails) throw new Error('SSH did not come up within 300 s');
    st.state.vms[a.name].runtime = RUNTIME();
    return {};
  });
  s.set(vmMod, 'opStop', async (t, a) => { log.stopped.push(a.name + (a.force ? ':force' : '')); st.state.vms[a.name].runtime = null; return { stopped: true }; });
  s.set(vmMod, 'opDelete', async (t, a) => { log.deleted.push(a.name); delete st.state.vms[a.name]; return { deleted: true }; });
  return log;
}

test('quick deploy: validation happens before any VM exists (BUG-16)', async () => {
  const s = stubs();
  const done = useRegistry({ web: { port: 2230, ports: [{ host: 7000, guest: 7000, lan: false }] } });
  try {
    const log = quickEnv(s);
    s.set(platform, 'isPortFree', async (p) => p !== 6000);
    const bad = async (body, status, re) => {
      await assert.rejects(deploy.validateQuickDeploy(Object.assign({ image: 'nginx' }, body)), (e) => e.status === status && re.test(e.message), JSON.stringify(body));
    };
    await bad({ ports: '8080:80, 80a' }, 400, /bad port mapping "80a"/);
    await bad({ ports: '8080:99999' }, 400, /out of range/);
    await bad({ image: 'nginx:alpin e' }, 400, /image reference/);
    await bad({ image: '' }, 400, /image reference is required/);
    await bad({ ports: '6000:80' }, 409, /in use by another program/);
    await bad({ ports: '7000:80' }, 409, /VM "web"/);
    await bad({ ports: '2230' }, 409, /SSH port of VM "web"/);
    await bad({ env: ['OK=1', 'NOPE'] }, 400, /NAME=value/);
    await bad({ volumes: 'C:/data:/data' }, 400, /Windows path/);
    await bad({ name: 'web' }, 409, /already exists/);
    await bad({ name: '../x' }, 400, /name/);
    await bad({ template: 'nope' }, 400, /no template called "nope"/);
    await bad({ mem: 1 }, 400, /Memory/);
    await bad({ ports: '6001:22', hostNetwork: true }, 409, /SSH/);
    assert.equal(log.created.length, 0, 'nothing was created');
  } finally { s.restore(); done(); }
});

test('quick deploy: names, template choice and the forwards of the first boot', async () => {
  const s = stubs();
  const done = useRegistry({ 'home-assistant': { port: 2230 } });
  try {
    quickEnv(s, { dockerReady: true });
    const a = await deploy.validateQuickDeploy({ image: 'ghcr.io/home-assistant/home-assistant:stable', ports: '8124:8123', hostNetwork: true, lan: true });
    assert.equal(a.name, 'home-assistant-2');
    assert.equal(a.containerName, 'home-assistant');
    assert.equal(a.template, 'docker-ready');
    assert.equal(a.mem, Math.min(2048, CFG.maxMem));
    assert.deepEqual(a.pre, [{ host: 8124, guest: 8123, container: 8123, owner: 'home-assistant', lan: true }]);
    const b = await deploy.validateQuickDeploy({ image: 'library/con:1', ports: '8080:80' });
    assert.equal(b.name, 'app', 'a Windows device name is never used');
    assert.deepEqual(b.pre, [{ host: 8080, guest: 8080, container: 80, owner: 'con', lan: false }]);
    assert.equal(b.template, 'docker-ready');
    const c = await deploy.validateQuickDeploy({ image: 'nginx', template: 'devbox-base', ephemeral: true, createdBy: 'mcp', keepOnFailure: 'true' });
    assert.deepEqual([c.template, c.ephemeral, c.createdBy, c.keepOnFailure], ['devbox-base', true, 'mcp', true]);
  } finally { s.restore(); done(); }
});

test('quick deploy: success is ONE task that ends with {sandbox, container, urls:[{url, lan}]} (BUG-1, MNT-7)', async () => {
  const s = stubs();
  const done = useRegistry({});
  try {
    const log = quickEnv(s);
    fakeGuest(s, guestRules());
    const a = await deploy.validateQuickDeploy({ image: 'nginx:alpine', ports: '8080:80', ephemeral: true, createdBy: 'mcp' });
    const task = tasks.start({ kind: 'quickdeploy', title: 'New VM ' + a.name, vm: a.name, locks: ['vm:' + a.name] }, (t) => deploy.opQuickDeploy(t, a));
    const end = await tasks.wait(task.id);
    assert.equal(end.status, 'done', end.error);
    assert.equal(tasks.holder('vm:nginx'), null, 'the lock is released');
    const r = end.result;
    assert.equal(r.sandbox, 'nginx');
    assert.equal(r.container, 'nginx');
    assert.deepEqual(r.urls, [{ url: 'http://127.0.0.1:8080', lan: false, host: 8080 }]);
    assert.match(r.ssh, /-p 2240 root@127\.0\.0\.1/);
    // the named forward was part of the VM from its first boot, claimed so the
    // SSH port could not take it, and not opened a second time
    assert.deepEqual(log.created[0].ports, [{ host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false }]);
    assert.deepEqual(log.claimedDuringCreate, [true]);
    assert.equal(ports.reservedPorts().get(8080), 'a port forward of VM "nginx"');
    assert.equal(log.created[0].ephemeral, true);
    assert.deepEqual(st.state.vms.nginx.ports.map((q) => q.host), [8080]);
    // each step is logged once, numbered as one sequence
    const full = tasks.get(task.id).log.join('\n');
    for (let i = 1; i <= 7; i++) assert.equal((full.match(new RegExp('Step ' + i + '/7:', 'g')) || []).length, 1, 'step ' + i);
    assert.equal((full.match(/Image {4}:/g) || []).length, 1);
  } finally { s.restore(); done(); }
});

test('quick deploy: a failure after the VM exists deletes it (XTR-4) unless keepOnFailure; the task still ends', async () => {
  const s = stubs();
  const done = useRegistry({});
  try {
    const log = quickEnv(s);
    fakeGuest(s, guestRules([[/docker image inspect -- /, { code: 1 }], [/docker pull/, { code: 1, stdout: 'Error response from daemon: manifest for nginx:alpin not found: manifest unknown\n' }]]));
    const a = await deploy.validateQuickDeploy({ image: 'nginx:alpin' });
    const task = tasks.start({ kind: 'quickdeploy', title: 'x', vm: a.name, locks: ['vm:' + a.name] }, (t) => deploy.opQuickDeploy(t, a));
    const end = await tasks.wait(task.id);
    assert.equal(end.status, 'error');
    // what happened to the VM first, then the cause
    assert.match(end.error, /^Quick deploy failed, so the VM "nginx" it created was deleted \(pass keepOnFailure to keep it\): docker pull nginx:alpin failed \(exit 1\): .*manifest unknown/);
    assert.deepEqual(log.deleted, ['nginx']);
    assert.deepEqual(log.stopped, ['nginx:force'], 'no graceful-shutdown wait for a VM made moments ago');
    assert.equal(tasks.holder('vm:nginx'), null);
    // a retry gets the same name again (nothing piles up)
    const again = await deploy.validateQuickDeploy({ image: 'nginx:alpine' });
    assert.equal(again.name, 'nginx');

    const k = await deploy.validateQuickDeploy({ image: 'nginx:alpin', keepOnFailure: true });
    await assert.rejects(deploy.opQuickDeploy(fakeTask(), k), /Quick deploy failed; the VM "nginx" was kept for inspection \(keepOnFailure\): docker pull/);
    assert.deepEqual(log.deleted, ['nginx']);
    assert.deepEqual(log.stopped, ['nginx:force'], 'kept running');
    assert.ok(st.state.vms.nginx);
  } finally { s.restore(); done(); }
});

test('quick deploy: a boot failure deletes the half-made VM; a failure before creation deletes nothing', async () => {
  const s = stubs();
  const done = useRegistry({});
  try {
    const log = quickEnv(s, { bootFails: true });
    fakeGuest(s, guestRules());
    const a = await deploy.validateQuickDeploy({ image: 'nginx' });
    await assert.rejects(deploy.opQuickDeploy(fakeTask(), a), /was deleted .*: SSH did not come up/);
    assert.deepEqual(log.deleted, ['nginx']);
    s.set(vmMod, 'opCreate', async () => { throw new Error('qemu-img create failed: disk full'); });
    const b = await deploy.validateQuickDeploy({ image: 'nginx' });
    await assert.rejects(deploy.opQuickDeploy(fakeTask(), b), (e) => /disk full/.test(e.message) && !/deleted/.test(e.message));
    assert.deepEqual(log.deleted, ['nginx']);
    assert.equal(ports.reservedPorts().has(8080), false);
  } finally { s.restore(); done(); }
});
