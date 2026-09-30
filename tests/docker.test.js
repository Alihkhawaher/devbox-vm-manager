'use strict';
/*
 * Tests for lib/docker.js: validation and quoting of everything that reaches
 * a guest shell, the one-call Docker state, the compose and localtime scripts
 * (run through a real POSIX sh when one is available: /bin/sh, or Git's sh
 * on Windows), exit-code checks, and "rm" releasing the port forwards the
 * container owned (XTR-10).
 *
 * No VM and no ssh are needed: docker.js calls ssh.sshExec (and vm/monitor
 * helpers) through their module objects, so each test puts a fake guest in
 * their place and restores the real ones afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const helpers = require('./helpers');
const docker = require('../lib/docker');
const ssh = require('../lib/ssh');
const vmMod = require('../lib/vm');
const monitor = require('../lib/monitor');
const platform = require('../lib/platform');
const st = require('../lib/state');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const SH = (() => {
  for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
  }
  return null;
})();
// Run a script in sh; returns {code, stdout, stderr}.
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

// Replace properties for one test; restore() puts the originals back.
function stubs() {
  const saved = [];
  return {
    set(obj, key, val) { saved.push([obj, key, obj[key]]); obj[key] = val; },
    restore() { while (saved.length) { const [o, k, v] = saved.pop(); o[k] = v; } },
  };
}

// A task context that records its log.
function fakeTask() {
  const lines = [];
  return {
    id: 'test-task', lines: lines,
    log: (m) => lines.push(String(m)), step: (m) => lines.push('STEP ' + m), warn: (m) => lines.push('WARNING: ' + m),
    text: () => lines.join('\n'),
  };
}

// A temp data root whose registry holds `vms`; returns cleanup().
function useRegistry(vms) {
  const dir = helpers.useTempRoot('docker');
  for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
  for (const k of Object.keys(vms)) st.state.vms[k] = st.newVmRecord(vms[k]);
  return () => {
    for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
    helpers.resetConfig();
    helpers.rm(dir);
  };
}

// A fake guest: each call is matched against rules [regex, result]; unmatched
// commands fail loudly. Records every call.
function fakeGuest(s, rules) {
  const calls = [];
  s.set(ssh, 'sshExec', async (tg, cmd, opts) => {
    calls.push({ tg: tg, cmd: cmd, opts: opts || {} });
    for (const [re, res] of rules) {
      if (re.test(cmd)) {
        const r = typeof res === 'function' ? res(cmd, opts || {}) : res;
        return Object.assign({ code: 0, stdout: '', stderr: '', ok: true, timedOut: false, truncated: false }, r, { ok: (r.code || 0) === 0 });
      }
    }
    return { code: 99, stdout: '', stderr: 'fake guest: unexpected command: ' + cmd.slice(0, 200), ok: false, timedOut: false };
  });
  return calls;
}
// The VM is running and SSH answers.
function vmReady(s) {
  s.set(vmMod, 'requireSshReady', async (name) => st.getVm(name));
  s.set(vmMod, 'isRunning', async () => true);
}

// ---------------------------------------------------------------------------
// error lines (what a failed docker command reports)
// ---------------------------------------------------------------------------
test('errorLine / lastLine: docker\'s cause, never its "--help" trailer; long daemon errors keep their end', () => {
  // real docker 29 output of a failed `docker run` (bind mount of a missing file)
  const long = 'docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: ' +
    'runc create failed: unable to start container process: error during container init: error mounting "/opt/x/nginx.conf" to rootfs at ' +
    '"/etc/nginx/nginx.conf": not a directory: Are you trying to mount a directory onto a file (or vice-versa)? Check if the specified host path exists and is the expected type';
  const out = '0123abcd\n' + long + '\n\nRun \'docker run --help\' for more information\n__RC=125\n';
  assert.equal(docker.errorLine(out), long);
  const l = docker.lastLine({ code: 125, stdout: out, stderr: '' });
  assert.ok(!/--help/.test(l), l);
  assert.ok(l.length <= 300, l.length);
  assert.ok(l.startsWith('docker: Error response from daemon'), l);
  assert.ok(l.endsWith('is the expected type'), 'the cause at the end survives: ' + l);
  assert.equal(docker.lastLine({ code: 1, stdout: 'x\nSee \'docker run --help\'.\n', stderr: '' }), 'x');
  assert.equal(docker.errorLine('pulling\nwarning: slow\ndone'), 'done');
  assert.equal(docker.shorten('short'), 'short');
  assert.deepEqual(docker.meaningfulLines('a\n__RC=1\n\n  b  \nRun \'docker compose --help\' for more information'), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// time zone + /etc/localtime (XTR-17)
// ---------------------------------------------------------------------------
test('zoneName: plain IANA names pass, anything else (injection, "..", odd types) becomes UTC', () => {
  for (const z of ['America/New_York', 'America/Argentina/Buenos_Aires', 'Etc/GMT+4', 'Etc/GMT-14', 'UTC', 'EST5EDT', 'America/Port-au-Prince']) {
    assert.equal(docker.zoneName(z), z);
  }
  for (const z of ['x; rm -rf /', '../../etc/passwd', 'Asia/../../x', '/etc/passwd', 'a b', "it's", '$(id)', '', null, undefined, 42, 'A/'.repeat(40)]) {
    assert.equal(docker.zoneName(z), 'UTC', String(z));
  }
});

test('localtimeFix: the zone path is quoted and an injection attempt never reaches the command', () => {
  const s = docker.localtimeFix('America/New_York');
  assert.ok(s.includes("cp '/usr/share/zoneinfo/America/New_York' /etc/localtime"));
  assert.ok(s.includes('cp /usr/share/zoneinfo/UTC /etc/localtime'), 'UTC fallback');
  const bad = docker.localtimeFix('x; rm -rf /');
  assert.ok(!bad.includes('rm -rf /;') && !bad.includes('x;'), bad);
  assert.ok(bad.includes("'/usr/share/zoneinfo/UTC'"));
  // the v1 export is the fix for the host's zone
  assert.equal(docker.LOCALTIME_FIX, docker.localtimeFix(platform.hostTimezone()));
});

test('localtimeFix in a real sh: missing -> host zone; a directory docker made -> file; a valid file is kept; no zoneinfo -> empty file', { skip: !SH && 'no POSIX sh on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-lt-'));
  try {
    const root = slash(dir);
    const zi = root + '/zoneinfo';
    fs.mkdirSync(path.join(dir, 'zoneinfo', 'America'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'zoneinfo', 'America', 'New_York'), 'TZif-newyork');
    fs.writeFileSync(path.join(dir, 'zoneinfo', 'UTC'), 'TZif-utc');
    const script = (tz) => docker.localtimeFix(tz).split('/usr/share/zoneinfo').join(zi).split('/etc/localtime').join(root + '/localtime');
    const lt = path.join(dir, 'localtime');
    // missing -> the host zone
    assert.equal(sh(script('America/New_York')).code, 0);
    assert.equal(fs.readFileSync(lt, 'utf8'), 'TZif-newyork');
    // already a file -> untouched
    fs.writeFileSync(lt, 'mine');
    sh(script('America/New_York'));
    assert.equal(fs.readFileSync(lt, 'utf8'), 'mine');
    // an (empty) directory docker created -> replaced by a file
    fs.rmSync(lt);
    fs.mkdirSync(lt);
    sh(script('America/New_York'));
    assert.ok(fs.statSync(lt).isFile());
    // unknown zone -> UTC
    fs.rmSync(lt);
    sh(script('Mars/Olympus'));
    assert.equal(fs.readFileSync(lt, 'utf8'), 'TZif-utc');
    // no tzdata at all -> an empty regular file (read as UTC)
    fs.rmSync(lt);
    fs.rmSync(path.join(dir, 'zoneinfo'), { recursive: true });
    sh(script('America/New_York'));
    assert.ok(fs.statSync(lt).isFile());
    assert.equal(fs.readFileSync(lt, 'utf8'), '');
  } finally { helpers.rm(dir); }
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
test('volumes: VM paths and named volumes pass; Windows paths, relative paths and ".." are refused with a clear reason (XTR-9, SEC-6)', () => {
  for (const v of ['/opt/data:/data', '/opt/ha/config:/config:ro', 'pgdata:/var/lib/postgresql/data', '/srv/x@1+2:/y:rw']) {
    assert.equal(docker.volumeError(v), null, v);
  }
  assert.match(docker.volumeError('C:\\HA\\config:/config'), /Windows path/);
  assert.match(docker.volumeError('C:/HA/config:/config'), /Windows path/);
  assert.match(docker.volumeError('D:'), /Windows path/);
  for (const v of ['./data:/data', 'data', '/a:/b:/c', '/a/../etc:/x', '/ok:relative', '/ok:/', '/a b:/c', 'x;rm -rf /:/y', '$(id):/y', '-v:/x', '.:/x', '..:/x', '/ok:/a/../b', '/ok:/y:rx']) {
    assert.notEqual(docker.volumeError(v), null, v);
  }
  assert.throws(() => docker.checkVolumes(['/ok:/ok', 'C:\\x:/y']), (e) => e.status === 400 && /Windows path/.test(e.message));
});

test('env: one entry per line, commas inside values kept (XTR-11); entries without NAME= are refused', () => {
  const env = docker.checkEnv(docker.listOf('ALLOWED_HOSTS=a.example,b.example\nJAVA_OPTS=-Xms1g,-Xmx2g\n\n  EMPTY=  \r\n', 'env'));
  assert.deepEqual(env, ['ALLOWED_HOSTS=a.example,b.example', 'JAVA_OPTS=-Xms1g,-Xmx2g', 'EMPTY=']);
  assert.deepEqual(docker.checkEnv(['A=1,2', 'B=x=y']), ['A=1,2', 'B=x=y']);
  for (const bad of [['b.example'], ['1X=y'], ['=v'], ['A B=c']]) {
    assert.throws(() => docker.checkEnv(bad), (e) => e.status === 400 && /NAME=value/.test(e.message), bad[0]);
  }
});

test('listOf: arrays or newline text (never commas); limits on count, length and NUL', () => {
  assert.deepEqual(docker.listOf(undefined, 'x'), []);
  assert.deepEqual(docker.listOf('', 'x'), []);
  assert.deepEqual(docker.listOf(['a,b', 8080, ' c '], 'x'), ['a,b', '8080', 'c']);
  assert.deepEqual(docker.listOf('a,b\nc', 'x'), ['a,b', 'c']);
  assert.throws(() => docker.listOf([{}], 'x'), (e) => e.status === 400);
  assert.throws(() => docker.listOf(5, 'x'), (e) => e.status === 400);
  assert.throws(() => docker.listOf(new Array(101).fill('A=1'), 'env'), (e) => e.status === 400 && /too many/.test(e.message));
  assert.throws(() => docker.listOf(['A=' + 'x'.repeat(5000)], 'env'), (e) => e.status === 400 && /too long/.test(e.message));
  assert.throws(() => docker.listOf(['A=\0'], 'env'), (e) => e.status === 400 && /NUL/.test(e.message));
  assert.throws(() => docker.checkTotal([new Array(90).fill('A=' + 'x'.repeat(300))]), (e) => e.status === 400 && /too much data/.test(e.message));
});

test('guest ports for docker run: [ip:]guest:container[/proto], ranges; out-of-range and junk refused', () => {
  assert.deepEqual(docker.checkGuestPorts(['8080:80', '80', '53:53/udp', '127.0.0.1:8081:81', '8000-8010:8000-8010']), ['8080:80', '80', '53:53/udp', '127.0.0.1:8081:81', '8000-8010:8000-8010']);
  for (const p of ['0:80', '8080:70000', '80a', '8080:80/sctp', '8010-8000:80', '-p 80', '8080:80;id']) {
    assert.throws(() => docker.checkGuestPorts([p]), (e) => e.status === 400, p);
  }
});

test('parseArgs: an array keeps each argument whole; text is split on whitespace; other types are refused (SEC-13)', () => {
  assert.deepEqual(docker.parseArgs({ args: ['sh', '-c', 'echo a; echo b'] }), ['sh', '-c', 'echo a; echo b']);
  assert.deepEqual(docker.parseArgs({ cmd: '  nginx -g   daemon ' }), ['nginx', '-g', 'daemon']);
  assert.deepEqual(docker.parseArgs({ cmd: ['a b', 1] }), ['a b', '1']);
  assert.deepEqual(docker.parseArgs({}), []);
  assert.throws(() => docker.parseArgs({ args: { a: 1 } }), (e) => e.status === 400);
  assert.throws(() => docker.parseArgs({ args: [null] }), (e) => e.status === 400);
});

test('requireImage / requireContainer: nothing that could be read as an option or path trick', () => {
  assert.equal(docker.requireImage(' nginx:alpine '), 'nginx:alpine');
  assert.equal(docker.requireImage('ghcr.io/home-assistant/home-assistant:stable'), 'ghcr.io/home-assistant/home-assistant:stable');
  assert.equal(docker.requireImage('nginx@sha256:0123abcd'), 'nginx@sha256:0123abcd');
  for (const bad of ['', '-v', '--help', 'nginx; rm -rf /', 'a b', '$(id)', "it's", null, 5]) {
    assert.throws(() => docker.requireImage(bad), (e) => e.status === 400, String(bad));
  }
  assert.equal(docker.requireContainer('web-1.a_b'), 'web-1.a_b');
  for (const bad of ['.', '..', '-f', '--help', 'a/b', 'a b', '', undefined, 'x'.repeat(129)]) {
    assert.throws(() => docker.requireContainer(bad), (e) => e.status === 400, String(bad));
  }
});

// ---------------------------------------------------------------------------
// command construction
// ---------------------------------------------------------------------------
test('runCommand: every value quoted, "--" before the image, host TZ unless the caller set one', () => {
  const a = { containerName: 'web', restart: 'unless-stopped', image: 'nginx:alpine', ports: ['8080:80'], volumes: ['/opt/w:/usr/share/nginx/html:ro'], env: ['A=1,2'], args: [] };
  const cmd = docker.runCommand(a, 'America/New_York');
  assert.equal(cmd, "docker run -d --name 'web' --restart 'unless-stopped' -e 'TZ=America/New_York' -p '8080:80' -v '/opt/w:/usr/share/nginx/html:ro' -e 'A=1,2' -- 'nginx:alpine'");
  const own = docker.runCommand(Object.assign({}, a, { env: ['TZ=Europe/Paris'] }), 'America/New_York');
  assert.ok(!own.includes('America/New_York') && own.includes("-e 'TZ=Europe/Paris'"));
  assert.ok(docker.runCommand(a, 'x; reboot').includes("'TZ=UTC'"));
});

test('runCommand in a real sh: hostile values reach docker as exact single arguments', { skip: !SH && 'no POSIX sh on this machine' }, () => {
  const hostile = ["A=$(touch pwned)", 'B=`id`', "C=it's; rm -rf /", 'D=a b  c', 'E="q"\\n', 'F=x\ny'];
  const args = ['sh', '-c', 'echo $HOME; exit 3', "--it's", '*'];
  const a = { containerName: 'c1', restart: null, image: 'alpine:3', ports: [], volumes: [], env: hostile, args: args };
  const prelude = 'docker() { for x in "$@"; do printf "<%s>\\n" "$x"; done; }\n';
  const r = sh(prelude + docker.runCommand(a, 'UTC'));
  assert.equal(r.code, 0, r.stderr);
  const got = r.stdout.split('>\n<').map((x) => x.replace(/^</, '').replace(/>\n?$/, ''));
  const want = ['run', '-d', '--name', 'c1', '-e', 'TZ=UTC'];
  for (const e of hostile) want.push('-e', e);
  want.push('--', 'alpine:3');
  assert.deepEqual(got, want.concat(args));
});

test('actionCommand: "--" before the id; rm prints the container name first so its forwards can be found', () => {
  assert.equal(docker.actionCommand('stop', 'web'), "docker stop -- 'web' 2>&1");
  const rm = docker.actionCommand('rm', 'abc123');
  assert.match(rm, /docker inspect --format "\{\{\.Name\}\}" -- 'abc123'/);
  assert.match(rm, /echo "__NAME=\$\{n#\/\}"/);
  assert.ok(rm.endsWith("docker rm -f -- 'abc123' 2>&1"));
});

test('STATE_CMD, DOCKER_CHECK, INSTALL_CMD and the compose script are valid POSIX sh', { skip: !SH && 'no POSIX sh on this machine' }, () => {
  const scripts = [docker.STATE_CMD, docker.DOCKER_CHECK, docker.INSTALL_CMD, docker.actionCommand('rm', 'x'),
    docker.composeScript({ project: 'app', bytes: 10, fix: docker.localtimeFix('UTC') })];
  for (const s of scripts) {
    assert.ok(!/[\r\n]/.test(s), 'one line, like the commands v1 proved with Windows ssh.exe: ' + s.slice(0, 80));
    const r = sh('set -n\n' + s);
    assert.equal(r.code, 0, s + '\n' + r.stderr);
  }
});

test('oneLine: complete statements joined with "; ", never an empty command', () => {
  assert.equal(docker.oneLine(['a', 'b;', ' c ; ', '', null, 'if x; then y; fi', docker.localtimeFix('UTC')]).split('; ').slice(0, 5).join('|'), 'a|b|c|if x|then y');
  assert.doesNotMatch(docker.oneLine(['a;', ';', docker.localtimeFix('UTC'), 'b']), /;\s*;/);
});

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------
test('parseDockerState: CLI present but daemon down, or no CLI at all', () => {
  assert.deepEqual(parseState('__NOCLI__\n'), { installed: false, cliInstalled: false });
  assert.deepEqual(parseState('__VER__\n'), { installed: false, cliInstalled: true });
  assert.deepEqual(parseState('__VER__27.3.1\n__PS__\n__IM__\n__NW__\n__VO__\n__END__\n'), { installed: true, cliInstalled: true });
  function parseState(s) { const r = docker.parseDockerState(s); return { installed: r.installed, cliInstalled: r.cliInstalled }; }
});

test('parseDockerCheck: up / missing / down (with the service log) / unknown', () => {
  assert.deepEqual(docker.parseDockerCheck('__DOCKER=27.3.1\n'), { state: 'up', version: '27.3.1', detail: '' });
  assert.equal(docker.parseDockerCheck('__DOCKER=MISSING').state, 'missing');
  const down = docker.parseDockerCheck('__DOCKER=DOWN\nlevel=error msg="failed to start daemon: overlay"\n');
  assert.equal(down.state, 'down');
  assert.match(down.detail, /failed to start daemon/);
  assert.equal(docker.parseDockerCheck('').state, 'unknown');
  assert.equal(docker.parseDockerCheck('__DOCKER=garbage').state, 'unknown');
});

test('failure(): says what failed, how (exit code / timeout / SSH) and the last meaningful line, never a marker', () => {
  assert.equal(docker.failure('docker pull x', { code: 1, stdout: 'Pulling\nError response from daemon: pull access denied for x\n__RC=1\n', stderr: '' }).message,
    'docker pull x failed (exit 1): Error response from daemon: pull access denied for x');
  assert.match(docker.failure('docker pull x', { code: 124, timedOut: true, stdout: '', stderr: '' }).message, /\(timed out\): timed out/);
  assert.match(docker.failure('x', { code: 255, stdout: '', stderr: 'ssh could not connect to the VM on port 2223' }).message, /SSH connection failed.*could not connect/);
  assert.match(docker.failure('x', { code: 127, stdout: 'sh: docker: not found\n', stderr: '' }).message, /Docker is not installed in this VM/);
  assert.match(docker.failure('x', { code: 127, stdout: '', stderr: '' }).message, /command was not found/);
});

// ---------------------------------------------------------------------------
// compose (stdin, base64, size check)
// ---------------------------------------------------------------------------
test('composeScript in a real sh: YAML arrives byte-exact (even through a CRLF translation), is size-checked, and the exit code is up\'s', { skip: !SH && 'no POSIX sh on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'devbox-compose-'));
  try {
    const yaml = 'services:\n  web:\n    image: "nginx:alpine"   # ünïcödé ✓\n    environment:\n      - A=1,2\n' + 'x: y\n'.repeat(3000);
    const bytes = Buffer.byteLength(yaml, 'utf8');
    const prelude = 'docker() { echo "docker $*"; if [ "$6" = up ]; then return ${FAKE_UP_RC:-0}; fi; return 0; }\n';
    const script = prelude + docker.composeScript({ project: 'my-app', bytes: bytes, dir: slash(dir) + '/my-app' });
    const file = path.join(dir, 'my-app', 'docker-compose.yml');
    // plain
    let r = sh(script, { input: docker.b64Lines(yaml) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), yaml);
    assert.match(r.stdout, /docker compose -p my-app -f docker-compose.yml up -d/);
    assert.match(r.stdout, /__PS__\ndocker compose -p my-app -f docker-compose.yml ps/);
    // a pipe that turned LF into CRLF on the way
    fs.rmSync(file);
    r = sh(script, { input: docker.b64Lines(yaml).replace(/\n/g, '\r\n') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), yaml);
    // cut short: refused, the previous file is kept, nothing is started
    r = sh(script, { input: docker.b64Lines(yaml).slice(0, 400) });
    assert.equal(r.code, 90);
    assert.match(r.stdout, /arrived incomplete/);
    assert.doesNotMatch(r.stdout, /up -d/);
    assert.equal(fs.readFileSync(file, 'utf8'), yaml);
    // "up" fails -> the script fails with up's code even though ps ran after it
    r = sh(script, { input: docker.b64Lines(yaml), env: { FAKE_UP_RC: '17' } });
    assert.equal(r.code, 17);
    assert.match(r.stdout, /__PS__/);
  } finally { helpers.rm(dir); }
});

test('opCompose: YAML goes over stdin, the command line stays small; a failed "up" is an error quoting up, not ps (BUG-15)', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    const yaml = 'services:\n' + '  # padding\n'.repeat(40000); // ~480 KB: far over the Windows command-line cap
    const calls = fakeGuest(s, [[/docker compose/, { code: 0, stdout: 'Container app-web-1 Started\n__PS__\nNAME STATUS\napp-web-1 running\n' }]]);
    const a = await docker.validateCompose({ name: 'box', project: 'app', yaml: yaml });
    const t = fakeTask();
    const res = await docker.opCompose(t, a);
    assert.deepEqual(res, { name: 'box', project: 'app', dir: '/opt/app' });
    assert.ok(calls[0].cmd.length < 4000, 'command line ' + calls[0].cmd.length);
    assert.equal(Buffer.from(calls[0].opts.input.replace(/\n/g, ''), 'base64').toString('utf8'), yaml);
    assert.ok(calls[0].cmd.includes('[ "$n" != ' + Buffer.byteLength(yaml) + ' ]'));

    s.set(ssh, 'sshExec', async () => ({ code: 1, stdout: 'service "web" refers to undefined volume data\n__PS__\nNAME STATUS\n', stderr: '', ok: false }));
    await assert.rejects(docker.opCompose(fakeTask(), a), /docker compose up failed \(exit 1\): service "web" refers to undefined volume data/);
  } finally { s.restore(); done(); }
});

test('validateCompose: project names that could leave /opt are refused (SEC-16); YAML required and capped', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    for (const p of ['..', '.', '../x', 'App', '-x', 'a b', 'x'.repeat(64)]) {
      await assert.rejects(docker.validateCompose({ name: 'box', project: p, yaml: 'a: 1' }), (e) => e.status === 400, p);
    }
    assert.equal((await docker.validateCompose({ name: 'box', yaml: 'a: 1' })).project, 'app');
    await assert.rejects(docker.validateCompose({ name: 'box', project: 'x', yaml: '  ' }), (e) => e.status === 400);
    await assert.rejects(docker.validateCompose({ name: 'box', project: 'x', yaml: 'a'.repeat(512 * 1024 + 1) }), (e) => e.status === 400 && /too large/.test(e.message));
    await assert.rejects(docker.validateCompose({ name: '../x', project: 'x', yaml: 'a: 1' }), (e) => e.status === 400);
  } finally { s.restore(); done(); }
});

// ---------------------------------------------------------------------------
// ops: exit codes (BUG-15, MNT-8)
// ---------------------------------------------------------------------------
test('pull / rmi / action / run fail when the guest command fails, with docker\'s own message; succeed otherwise', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    const guestCalls = fakeGuest(s, [
      [/docker pull -- 'nginx:alpin'/, { code: 1, stdout: 'Error response from daemon: manifest for nginx:alpin not found: manifest unknown\n' }],
      [/docker pull -- 'nginx:alpine'/, { code: 0, stdout: 'alpine: Pulling from library/nginx\nStatus: Downloaded newer image for nginx:alpine\n' }],
      [/docker rmi -- 'busy:1'/, { code: 1, stdout: 'Error response from daemon: conflict: unable to remove repository reference "busy:1" (must force) - container abc is using its referenced image\n' }],
      [/docker stop -- 'gone'/, { code: 1, stdout: 'Error response from daemon: No such container: gone\n' }],
      [/docker run .*'bad:1'/, { code: 125, stdout: 'docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated.\n' }],
      [/docker run .*'good:1'/, { code: 0, stdout: 'Unable to find image locally\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n' }],
      [/docker pull -- 'slow:1'/, { code: 124, timedOut: true, stdout: 'Downloading\n' }],
    ]);
    const t = fakeTask();
    await assert.rejects(docker.opDockerPull(t, { name: 'box', image: 'nginx:alpin' }), /docker pull nginx:alpin failed \(exit 1\): .*manifest unknown/);
    assert.deepEqual(await docker.opDockerPull(t, { name: 'box', image: 'nginx:alpine' }), { name: 'box', image: 'nginx:alpine' });
    await assert.rejects(docker.opDockerPull(t, { name: 'box', image: 'slow:1' }), /timed out/);
    await assert.rejects(docker.opDockerRmi(t, { name: 'box', image: 'busy:1' }), /docker rmi failed \(exit 1\): .*must force/);
    await assert.rejects(docker.opDockerAction(t, { name: 'box', id: 'gone', action: 'stop' }), /docker stop failed \(exit 1\): .*No such container/);
    const base = { name: 'box', containerName: null, restart: null, ports: ['8080:80'], volumes: [], env: [], args: [] };
    await assert.rejects(docker.opDockerRun(t, Object.assign({}, base, { image: 'bad:1' })), /docker run failed \(exit 125\): .*port is already allocated/);
    assert.deepEqual(await docker.opDockerRun(t, Object.assign({}, base, { image: 'good:1' })), { name: 'box', image: 'good:1', container: '0123456789ab' });
    // container secrets reach the guest, never the task log (tasks.log, GUI, get_task - security-3)
    const t2 = fakeTask();
    await docker.opDockerRun(t2, Object.assign({}, base, { image: 'good:1', env: ['DB_PASSWORD=s3cr3t=x', 'PLAIN'] }));
    assert.ok(guestCalls[guestCalls.length - 1].cmd.includes("-e 'DB_PASSWORD=s3cr3t=x'"), 'the real value goes to the guest');
    assert.equal(t2.text().indexOf('s3cr3t'), -1, t2.text());
    assert.match(t2.text(), /-e 'DB_PASSWORD=\*\*\*' -e 'PLAIN'/);
    assert.equal(docker.redactEnv('A=b=c'), 'A=***');
    assert.equal(docker.redactEnv('NOVALUE'), 'NOVALUE');
  } finally { s.restore(); done(); }
});

test('validateRun / validateAction: bad input is a 400 before anything runs', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    const calls = fakeGuest(s, []);
    const ok = await docker.validateRun({ name: 'box', image: 'nginx', containerName: 'web', env: 'A=1,2\nB=3', volumes: ['/opt/x:/x'], ports: '8080:80', cmd: 'nginx -g daemon' });
    assert.deepEqual(ok.env, ['A=1,2', 'B=3']);
    assert.deepEqual(ok.args, ['nginx', '-g', 'daemon']);
    for (const body of [
      { image: '-v' }, { image: 'nginx', containerName: '..' }, { image: 'nginx', env: 'NOEQUALS' },
      { image: 'nginx', volumes: 'C:\\data:/data' }, { image: 'nginx', ports: '99999:80' }, { image: 'nginx', restart: 'sometimes' },
    ]) {
      await assert.rejects(docker.validateRun(Object.assign({ name: 'box' }, body)), (e) => e.status === 400, JSON.stringify(body));
    }
    for (const body of [{ action: 'kill', id: 'web' }, { action: 'toString', id: 'web' }, { action: 'rm', id: '-f' }, { action: 'rm', id: '..' }]) {
      await assert.rejects(docker.validateAction(Object.assign({ name: 'box' }, body)), (e) => e.status === 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  } finally { s.restore(); done(); }
});

// ---------------------------------------------------------------------------
// rm releases the container's forwards (XTR-10)
// ---------------------------------------------------------------------------
test('rm removes the forwards the container owned - closed live with their bind address and dropped from vms.json', async () => {
  const s = stubs();
  const done = useRegistry({
    box: {
      port: 2230,
      ports: [
        { host: 8080, guest: 8080, container: 80, owner: 'web', lan: false },
        { host: 8443, guest: 8443, container: 443, owner: 'web', lan: true },
        { host: 3000, guest: 3000, lan: true },
        { host: 9000, guest: 9000, container: 9000, owner: 'other', lan: false },
      ],
      runtime: { pid: 4242, startedAt: new Date().toISOString(), accel: 'tcg', monitor: { host: '127.0.0.2', port: 50001 }, serial: null },
    },
  });
  try {
    vmReady(s);
    const closed = [];
    s.set(monitor, 'removeForwardLive', async (vm, m) => { closed.push(m); return { ok: true, why: null }; });
    // the caller passes an id; the guest reports the name
    fakeGuest(s, [[/docker rm -f -- 'abc123'/, { code: 0, stdout: '__NAME=web\nabc123\n' }]]);
    const t = fakeTask();
    const res = await docker.opDockerAction(t, { name: 'box', id: 'abc123', action: 'rm' });
    assert.deepEqual(res.forwardsRemoved.map((m) => m.host), [8080, 8443]);
    assert.deepEqual(closed.map((m) => [m.host, m.lan]), [[8080, false], [8443, true]]);
    assert.deepEqual(st.state.vms.box.ports.map((m) => m.host), [3000, 9000]);
    assert.equal(st.state.vms.box.pendingRestart, false);
    const saved = JSON.parse(fs.readFileSync(require('../lib/config').CFG.stateFile, 'utf8'));
    assert.deepEqual(saved.vms.box.ports.map((m) => m.host), [3000, 9000]);
  } finally { s.restore(); done(); }
});

test('rm: a container that is already gone still releases its forwards; the monitor failing flags pendingRestart; other errors change nothing', async () => {
  const s = stubs();
  const done = useRegistry({
    box: { port: 2230, ports: [{ host: 8080, guest: 8080, container: 80, owner: 'web', lan: false }, { host: 9000, guest: 9000, owner: 'db', lan: false }],
      runtime: { pid: 4242, startedAt: new Date().toISOString(), accel: 'tcg', monitor: { host: '127.0.0.2', port: 50001 }, serial: null } },
  });
  try {
    vmReady(s);
    s.set(monitor, 'removeForwardLive', async () => ({ ok: false, why: 'the QEMU monitor did not answer' }));
    fakeGuest(s, [
      [/'web'/, { code: 1, stdout: '__NAME=\nError response from daemon: No such container: web\n' }],
      [/'db'/, { code: 1, stdout: '__NAME=db\nError response from daemon: removal of container db is already in progress\n' }],
    ]);
    const t = fakeTask();
    const res = await docker.opDockerAction(t, { name: 'box', id: 'web', action: 'rm' });
    assert.deepEqual(res.forwardsRemoved.map((m) => m.host), [8080]);
    assert.deepEqual(st.state.vms.box.ports.map((m) => m.host), [9000]);
    assert.equal(st.state.vms.box.pendingRestart, true);
    assert.match(t.text(), /WARNING: could not close 8080 -> 8080/);
    await assert.rejects(docker.opDockerAction(fakeTask(), { name: 'box', id: 'db', action: 'rm' }), /docker rm failed \(exit 1\): .*already in progress/);
    assert.deepEqual(st.state.vms.box.ports.map((m) => m.host), [9000]);
  } finally { s.restore(); done(); }
});

// ---------------------------------------------------------------------------
// Docker state + ensureDocker
// ---------------------------------------------------------------------------
test('getDockerState: ONE ssh call (OPS-13); containers carry the URLs of the forwards they own', async () => {
  const s = stubs();
  // a fake sshd, so the real banner probe says "up"
  const srv = net.createServer((c) => { c.end('SSH-2.0-OpenSSH_fake\r\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const done = useRegistry({ box: { port: port, ports: [{ host: 8080, guest: 8080, container: 80, owner: 'web', lan: true }] } });
  try {
    s.set(vmMod, 'isRunning', async () => true);
    const calls = fakeGuest(s, [[/__PS__/, {
      code: 0,
      stdout: '__VER__27.3.1\n__PS__\n{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up","Ports":"","CreatedAt":"x"}\n' +
        '{"ID":"c2","Names":"tmp","Image":"alpine","State":"exited","Status":"Exited (0)","Ports":"","CreatedAt":"x"}\n__IM__\n__NW__\n__VO__\n__END__\n',
    }]]);
    const r = await docker.getDockerState('box');
    assert.equal(calls.length, 1);
    assert.equal(r.installed, true);
    assert.equal(r.note, null);
    assert.deepEqual(r.containers[0].urls, [{ url: 'http://127.0.0.1:8080', lan: true, host: 8080 }]);
    assert.deepEqual(r.containers[1].urls, []);
    // installed but the daemon is not up: say so
    s.set(ssh, 'sshExec', async () => ({ code: 0, stdout: '__VER__\n', stderr: '', ok: true }));
    const down = await docker.getDockerState('box');
    assert.equal(down.installed, false);
    assert.equal(down.cliInstalled, true);
    assert.match(down.note, /installed but not running/);
  } finally { s.restore(); done(); srv.close(); }
});

test('ensureDocker: running -> version; missing -> installs; installed but down -> clear error; SSH failure -> error', async () => {
  const s = stubs();
  try {
    const tg = { name: 'box', port: 2230 };
    let installs = 0;
    const rules = [
      [/apk add/, () => { installs++; return { code: 0, stdout: '(1/9) Installing docker\n * Starting Docker Daemon ... [ ok ]\n__DOCKER=27.3.1\n' }; }],
    ];
    const setCheck = (res) => fakeGuest(s, [[/__DOCKER=MISSING/, res]].concat(rules));
    setCheck({ code: 0, stdout: '__DOCKER=26.1.5\n' });
    assert.equal(await docker.ensureDocker(fakeTask(), tg), '26.1.5');
    assert.equal(installs, 0);
    setCheck({ code: 0, stdout: '__DOCKER=MISSING\n' });
    assert.equal(await docker.ensureDocker(fakeTask(), tg), '27.3.1');
    assert.equal(installs, 1);
    setCheck({ code: 0, stdout: '__DOCKER=DOWN\ntime="x" level=fatal msg="failed to start daemon: iptables not found"\n' });
    await assert.rejects(docker.ensureDocker(fakeTask(), tg), /service did not start: .*iptables not found/);
    setCheck({ code: 255, stdout: '', stderr: 'ssh could not connect to the VM on port 2230' });
    await assert.rejects(docker.ensureDocker(fakeTask(), tg), /checking for Docker failed \(SSH connection failed\)/);
  } finally { s.restore(); }
});

test('opDockerInstall: apk failure is reported with apk\'s message', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    fakeGuest(s, [[/apk add/, { code: 1, stdout: 'fetch https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/APKINDEX.tar.gz\nERROR: unable to select packages:\n  docker (no such package):\n' }]]);
    await assert.rejects(docker.opDockerInstall(fakeTask(), { name: 'box' }), /installing Docker failed \(exit 1\): docker \(no such package\):/);
  } finally { s.restore(); done(); }
});

test('getDockerLogs: the container name is validated before anything runs; a failure is a 409 with docker\'s message', async () => {
  const s = stubs();
  const done = useRegistry({ box: { port: 2230 } });
  try {
    vmReady(s);
    const calls = fakeGuest(s, [
      [/'web'/, { code: 0, stdout: 'hello\n' }],
      [/'nope'/, { code: 1, stdout: 'Error response from daemon: No such container: nope\n' }],
    ]);
    await assert.rejects(docker.getDockerLogs({ name: 'box', container: '-f' }), (e) => e.status === 400);
    assert.equal(calls.length, 0);
    assert.deepEqual(await docker.getDockerLogs({ name: 'box', container: 'web', tail: 'abc' }), { text: 'hello\n', truncated: false });
    assert.match(calls[0].cmd, /^docker logs --tail 250 -- 'web' 2>&1$/);
    await assert.rejects(docker.getDockerLogs({ name: 'box', container: 'nope' }), (e) => e.status === 409 && /No such container/.test(e.message));
  } finally { s.restore(); done(); }
});

test('inspectImage: reads the JSON line even after a warning; unsafe VOLUME paths never survive (SEC-6)', async () => {
  const s = stubs();
  try {
    fakeGuest(s, [[/image inspect --format/, { code: 0, stdout: 'WARNING: something\n' + JSON.stringify({ ExposedPorts: { '80/tcp': {} }, Volumes: { '/data': {}, 'x;reboot': {} } }) + '\n' }]]);
    const info = await docker.inspectImage({ name: 'box', port: 2230 }, 'nginx');
    assert.deepEqual(info.ports, [{ port: 80, proto: 'tcp' }]);
    assert.deepEqual(info.volumes, ['/data']);
    assert.deepEqual(info.ignoredVolumes, ['x;reboot']);
    fakeGuest(s, [[/image inspect/, { code: 1, stdout: 'Error: No such image: nginx\n' }]]);
    await assert.rejects(docker.inspectImage({ name: 'box', port: 2230 }, 'nginx'), /inspecting nginx \(is it pulled\?\) failed \(exit 1\): Error: No such image/);
  } finally { s.restore(); }
});
