'use strict';
/*
 * lib/mcp/containers.js and the microVM parts of lib/mcp/tools.js
 * (microVM spec section 13): the pure helpers, and every container / image
 * tool - plus deploy_image's engine choice, status, setup and cleanup -
 * against a FAKE manager that speaks the container API of
 * lib/microvm/routes.js (no HTTP, no QEMU, no network).
 *
 * The fake follows the documented contracts: POST /api/container/run ->
 * 202 {task (with ctr), engine}; GET /api/container?id= (id, name or id
 * prefix) -> the record; GET /api/container/logs -> {text, size,
 * truncated}; container records carry env with values redacted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./helpers'); // points CFG at a scratch root before lib/ is used
const { ToolError, createServer } = require('../lib/mcp/protocol');
const T = require('../lib/mcp/tools');
const K = require('../lib/mcp/containers');
const sshMod = require('../lib/ssh');

// ---------------------------------------------------------------------------
// a fake manager with containers
// ---------------------------------------------------------------------------
function apiErr(status, code, message, body) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.body = Object.assign({ ok: false, error: message, code: code }, body || {});
  return e;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// opts.run: how the next POST /api/container/run behaves
//   {record: fields merged into the new record, task: final task fields or
//    'running', polls: [fields merged on each later GET /api/container],
//    logs: {stdout, stderr, console}, engine: 'docker-vm' (the manager chose
//    Docker-in-VM: a quick-deploy task is started instead), reason}
function fakeManager(opts) {
  opts = opts || {};
  const m = {
    calls: [], tasks: new Map(), seq: 0, containers: new Map(), logs: new Map(),
    run: opts.run || {},
    images: opts.images || { images: [], rateLimit: null, cacheBytes: 0 },
    shares: opts.shares || {},
    posts: opts.posts || {},
    gets: opts.gets || {},
    state: Object.assign({
      version: '2.0.0', dataRoot: '/data', managerPort: 8777,
      platform: { os: 'win32', arch: 'x64', accel: { available: ['whpx', 'tcg'], recommended: 'whpx' } },
      prereqs: {
        qemu: { ok: true, required: true, label: 'QEMU emulator', action: 'install-qemu' },
        ssh: { ok: true, required: true, label: 'OpenSSH client' },
        base: { ok: true, required: true, label: 'Golden base image', action: 'build-base' },
        microvm: { ok: true, required: false, label: 'microVM kernel', action: 'install-kernel', needsUpdate: false },
      },
      microvm: { ready: true, kver: '6.18.54-0-virt', accel: 'whpx', machine: 'microvm', reason: null, needsUpdate: false },
      bases: [{ name: 'devbox-base', size: 1073741824, isDefault: true, usedBy: 0 }],
      vms: [], tasks: { running: [], recent: [] },
      limits: { maxMem: 12288, defaultMem: 1024, maxCpus: 8, defaultCpus: 2 },
    }, opts.state || {}),
  };
  const newTask = (kind, extra, end) => {
    const id = 'task-' + (++m.seq);
    const t = Object.assign({ id: id, kind: kind, title: kind, status: 'running', step: 'working', log: ['[00:00:00] ' + kind], startedAt: Date.now(), endedAt: null }, extra || {});
    if (end && end !== 'running') Object.assign(t, { endedAt: Date.now(), step: null }, end, { log: t.log.concat(end.log || []) });
    m.tasks.set(id, t);
    return t;
  };
  m.newTask = newTask;
  const find = (ref) => {
    if (m.containers.has(ref)) return m.containers.get(ref);
    for (const r of m.containers.values()) if (r.name === ref) return r;
    const pre = Array.from(m.containers.values()).filter((r) => ref && ref.length >= 3 && r.id.indexOf(ref) === 0);
    return pre.length === 1 ? pre[0] : null;
  };
  m.find = find;
  const q = (p) => { const u = new URL('http://x' + p); const o = {}; for (const [k, v] of u.searchParams) o[k] = v; return { path: u.pathname, q: o }; };
  m.client = {
    url: 'http://127.0.0.1:8777/', root: '/data', port: 8777, version: '2.0.0', started: false,
    get: async (p) => {
      m.calls.push(['GET', p]);
      const { path: pth, q: qs } = q(p);
      if (m.gets[pth]) return m.gets[pth](qs, m);
      if (pth === '/api/state') {
        const s = clone(m.state);
        s.containers = Array.from(m.containers.values()).map((r) => ({ id: r.id, name: r.name, image: r.image, status: r.status, exitCode: r.exitCode, ports: r.ports, busy: null }));
        return s;
      }
      if (pth === '/api/task') {
        const t = m.tasks.get(qs.id);
        if (!t) throw apiErr(404, 'NOT_FOUND', 'no task with id ' + qs.id);
        return { ok: true, task: clone(t) };
      }
      if (pth === '/api/container') {
        const r = find(qs.id);
        if (!r) throw apiErr(404, 'NO_SUCH_CONTAINER', 'no container "' + qs.id + '"');
        if (r._polls && r._polls.length) Object.assign(r, r._polls.shift());
        const out = clone(r);
        delete out._polls;
        return { ok: true, container: out };
      }
      if (pth === '/api/containers') {
        return { ok: true, containers: Array.from(m.containers.values()).map((r) => { const o = clone(r); delete o._polls; return o; }) };
      }
      if (pth === '/api/container/logs') {
        const r = find(qs.id);
        if (!r) throw apiErr(404, 'NO_SUCH_CONTAINER', 'no container "' + qs.id + '"');
        const l = m.logs.get(r.id) || {};
        const text = l[qs.stream] || '';
        return { ok: true, text: text, size: Buffer.byteLength(text), truncated: !!l.truncated };
      }
      if (pth === '/api/images') return Object.assign({ ok: true }, clone(m.images));
      if (pth === '/api/shares') {
        if (!Object.prototype.hasOwnProperty.call(m.shares, qs.owner)) return { ok: true, shares: [] };
        return { ok: true, shares: clone(m.shares[qs.owner]) };
      }
      throw apiErr(404, 'NOT_FOUND', 'no route ' + p);
    },
    post: async (p, body) => {
      m.calls.push(['POST', p, body]);
      if (m.posts[p]) return m.posts[p](body, m);
      if (p === '/api/container/run') {
        const run = m.run;
        // as lib/microvm/validate.runFields: anything else is a 400
        if (body.createdBy !== undefined && ['gui', 'mcp', 'api'].indexOf(body.createdBy) === -1) throw apiErr(400, 'BAD_REQUEST', 'createdBy must be one of gui, mcp, api');
        if (run.engine === 'docker-vm') {
          const t = newTask('quick-deploy', { vm: 'nginx-vm' }, run.deployTask || { status: 'done', result: { sandbox: 'nginx-vm', container: 'nginx', urls: [{ url: 'http://127.0.0.1:8080', host: 8080, lan: false }], ports: [] } });
          return { ok: true, task: { id: t.id, vm: t.vm, status: 'running' }, engine: 'docker-vm', reason: run.reason || null };
        }
        const id = (0xabc000000000 + (++m.seq)).toString(16);
        const rec = Object.assign({
          id: id, name: body.name || 'img-' + id.slice(0, 4), image: body.image, status: 'running', exitCode: null,
          ports: [{ host: 8080, guest: 80, proto: 'tcp', lan: !!body.lan }],
          createdBy: body.createdBy, ephemeral: body.ephemeral, autoRemove: !!body.autoRemove,
          env: (body.env || []).map((e) => e.split('=')[0] + '=***'),
          runtime: { pid: 4242, memMB: 256, accel: 'whpx', effectiveAccel: 'whpx' },
          warnings: [], initMessages: [],
        }, run.record || {});
        if (run.polls) rec._polls = clone(run.polls);
        m.containers.set(id, rec);
        if (run.logs) m.logs.set(id, run.logs);
        const t = newTask('ctr-run', { ctr: id }, run.task === undefined ? { status: 'done', result: { id: id, name: rec.name } } : run.task);
        if (run.removeOnEnd) m.containers.delete(id);
        return { ok: true, task: { id: t.id, ctr: id, status: 'running', kind: 'ctr-run' }, engine: 'microvm' };
      }
      if (p === '/api/container/remove') {
        const r = find(body.id);
        if (!r) throw apiErr(404, 'NO_SUCH_CONTAINER', 'no container "' + body.id + '"');
        if (r.status === 'running' && !body.force) throw apiErr(409, 'RUNNING', 'container "' + r.name + '" is running');
        m.containers.delete(r.id);
        return { ok: true, removed: r.id };
      }
      if (p === '/api/container/stop') {
        const r = find(body.id);
        if (!r) throw apiErr(404, 'NO_SUCH_CONTAINER', 'no container "' + body.id + '"');
        if (r.status !== 'running') throw apiErr(409, 'NOT_RUNNING', 'container "' + r.name + '" is not running');
        const t = newTask('ctr-stop', { ctr: r.id }, { status: 'done', result: { id: r.id, exitCode: body.force ? 137 : 0, how: body.force ? 'killed (force)' : 'graceful', ms: 80 } });
        r.status = 'exited';
        r.exitCode = body.force ? 137 : 0;
        return { ok: true, task: { id: t.id, ctr: r.id, status: 'running' } };
      }
      if (p === '/api/vm/quickdeploy') {
        const t = newTask('quick-deploy', { vm: body.name || 'dep-vm' }, { status: 'done', result: { sandbox: body.name || 'dep-vm', container: 'app', urls: [{ url: 'http://127.0.0.1:8080', host: 8080, lan: false }], ports: [] } });
        return { ok: true, task: { id: t.id, vm: t.vm, status: 'running' } };
      }
      // any other task route
      const t = newTask(p.split('/').pop(), { vm: body && body.name }, { status: 'done', result: {} });
      return { ok: true, task: { id: t.id, vm: t.vm, status: 'running' } };
    },
  };
  return m;
}

// toolsFor(m, deps): the tools wired to the fake, called through the real
// protocol (argument checking and defaults apply)
function toolsFor(m, extra) {
  const deps = Object.assign({
    connect: async () => m.client,
    waitForTask: require('../lib/client').waitForTask,
    pollMs: 5, exit: () => {}, version: '2.0.0', dataRoot: () => '/data',
    platform: { findTool: () => 'ssh', isPortFree: async () => true, lanAddresses: () => ['192.168.1.9'], installHints: () => ({ ssh: 'install OpenSSH' }) },
    ssh: { sshExec: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 5 }), sshArgs: sshMod.sshArgs, scp: async () => ({ code: 0 }) },
    localEnv: () => ({ dataRoot: path.join(os.tmpdir(), 'devbox-mcp-nodata'), appDir: path.join(os.tmpdir(), 'devbox-mcp-noapp'), home: path.join(os.tmpdir(), 'devbox-mcp-nohome'), allow: [] }),
  }, extra || {});
  const list = T.createTools(deps);
  const server = createServer({ name: 't', version: '1' });
  for (const t of list) server.addTool(t);
  return {
    call: async (name, args) => {
      const r = await server.callTool({ name: name, arguments: args || {} }, { afterReply: () => {} });
      const text = r.content[0].text;
      if (r.isError) { const e = new ToolError(text); e.isError = true; throw e; }
      return JSON.parse(text);
    },
  };
}
const posts = (m, p) => m.calls.filter((c) => c[0] === 'POST' && c[1] === p);

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-' + tag + '-')); }

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('host folders: absolute on this PC only (Windows: a drive, never a UNC path; "/x" would land on the current drive)', () => {
  assert.equal(K.isHostAbsolute('C:\\Users\\me\\p', 'win32'), true);
  assert.equal(K.isHostAbsolute('d:/work', 'win32'), true);
  assert.equal(K.isHostAbsolute('\\\\?\\C:\\work', 'win32'), true, 'the long form of a local drive');
  // sec-1: another computer (and "\\localhost\C$\..." is this one's data folder in disguise)
  assert.equal(K.isHostAbsolute('\\\\server\\share', 'win32'), false);
  assert.equal(K.isHostAbsolute('\\\\localhost\\C$\\data', 'win32'), false);
  assert.equal(K.isHostAbsolute('/srv/x', 'win32'), false);
  assert.equal(K.isHostAbsolute('.\\x', 'win32'), false);
  assert.equal(K.isHostAbsolute('/srv/x', 'linux'), true);
  assert.equal(K.isHostAbsolute('~/x', 'linux'), false);
  assert.equal(K.isHostAbsolute('./x', 'darwin'), false);
});

test('ports: structured, LAN only through lan=true - a bind address or ",lan" in the text never publishes to the network (sec-9)', () => {
  assert.deepEqual(K.portMappings(['8080:80', '3000', '5353:53/udp'], false), [
    { host: 8080, guest: 80, proto: 'tcp', lan: false }, { host: 3000, guest: 3000, proto: 'tcp', lan: false }, { host: 5353, guest: 53, proto: 'udp', lan: false }]);
  for (const s of ['0.0.0.0:8080:80', 'lan:8081:80', '8082:80,lan']) {
    assert.throws(() => K.portMappings([s], false), (e) => /reachable from other devices/.test(e.message) && /lan=true/.test(e.message), s);
  }
  // with lan=true: LAN, unless the entry itself says this PC only
  assert.deepEqual(K.portMappings(['0.0.0.0:8080:80', '8081:80', '127.0.0.1:8082:80', 'local:8083:80', '8084:80,local'], true).map((p) => p.lan), [true, true, false, false, false]);
  assert.throws(() => K.portMappings(['8080:80,wat'], false), /ports:/);
});

test('host folders in volumes/copy_in: a UNC path is refused before anything opens it (sec-1)', () => {
  if (process.platform !== 'win32') return;
  const guard = () => { throw new Error('the guard must not even be reached'); };
  for (const p of ['\\\\localhost\\C$\\data', '\\\\127.0.0.1\\C\\x', '//attacker/x', '\\\\?\\UNC\\localhost\\C\\x', '\\\\host@SSL\\x']) {
    assert.throws(() => K.prepareMounts([p + ':/app'], [], guard), /network and UNC paths/, p);
    assert.throws(() => K.prepareMounts([], [p + ':/app'], guard), /network and UNC paths/, p);
  }
});

test('sizes in MB: one decimal, three below 1 MB (hello-world is a few KB, not 0)', () => {
  assert.equal(K.mb(25 * 1048576 + 104858), 25.1);
  assert.equal(K.mb(3584), 0.003);
  assert.equal(K.mb(0), 0);
  assert.equal(K.mb(undefined), null);
  assert.equal(K.mb(-1), null);
});

test('exit codes in words (Docker-compatible, spec 6.3)', () => {
  assert.equal(K.exitMeaning(0), undefined);
  assert.match(K.exitMeaning(125), /engine failed/);
  assert.match(K.exitMeaning(126), /not executable/);
  assert.match(K.exitMeaning(127), /command not found/);
  assert.match(K.exitMeaning(137), /SIGKILL/);
  assert.match(K.exitMeaning(143), /SIGTERM/);
  assert.match(K.exitMeaning(132), /SIGILL/);
  assert.match(K.exitMeaning(129), /signal 1$/);
  assert.match(K.exitMeaning(3), /exited with an error/);
  assert.match(K.exitMeaning(null), /no exit status/);
});

test('prepareMounts: named volumes pass through; host folders are checked, guarded and made absolute; copy_in is a read source', () => {
  const dir = tmpDir('mounts');
  try {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    const seen = [];
    const guard = (abs, label, mode, isDir) => { seen.push([abs, label, mode, isDir]); return abs; };
    const m = K.prepareMounts(['pgdata:/var/lib/postgresql/data', proj + ':/app', proj + ':/ro:ro'], [proj + ':/usr/share/nginx/html'], guard);
    assert.deepEqual(m.volumes, ['pgdata:/var/lib/postgresql/data', proj + ':/app', proj + ':/ro:ro']);
    assert.deepEqual(m.copyIn, [proj + ':/usr/share/nginx/html']);
    assert.deepEqual(m.hostFolders.map((f) => [f.target, f.readonly]), [['/app', false], ['/ro', true]]);
    assert.deepEqual(m.named.map((v) => v.name), ['pgdata']);
    // a read-write share lets the guest WRITE here: guarded as a write target
    assert.deepEqual(seen, [[proj, 'volumes', 'write', true], [proj, 'volumes', 'read', true], [proj, 'copy_in', 'read', true]]);
    assert.throws(() => K.prepareMounts(['./rel:/app'], [], guard), /must be an absolute path/);
    assert.throws(() => K.prepareMounts(['~/x:/app'], [], guard), /must be an absolute path/);
    assert.throws(() => K.prepareMounts([path.join(dir, 'missing') + ':/app'], [], guard), /there is no folder/);
    assert.throws(() => K.prepareMounts([path.join(dir, 'file.txt') + ':/app'], [], guard), /is a file/);
    assert.throws(() => K.prepareMounts(['bad name:/x'], [], guard), /volumes: bad volume name/);
    assert.throws(() => K.prepareMounts([], ['nocolon'], guard), /copy_in: bad copy-in/);
    // the guard's verdict stops everything
    assert.throws(() => K.prepareMounts([proj + ':/app'], [], () => { throw new ToolError('inside your SSH keys'); }), /SSH keys/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runBody: the API body; autoRemove only for detached runs (a waited-for run reads its output first)', () => {
  const envList = T.envList;
  const none = { volumes: [], copyIn: [] };
  const b = K.runBody({ image: ' alpine ', command: ['sh', '-c', 'exit 3'], env: { A: '1' }, ports: [], lan: false, wait_for: 'exit', remove_on_exit: true, ephemeral: true, engine: 'microvm', pull: 'missing' }, none, envList, 'claude');
  assert.deepEqual(b, { image: 'alpine', engine: 'microvm', createdBy: 'claude', ephemeral: true, lan: false, cmd: ['sh', '-c', 'exit 3'], env: ['A=1'], ports: [], pull: 'missing' });
  const d = K.runBody({ image: 'nginx:alpine', wait_for: 'ready', remove_on_exit: true, memory_mb: 512, name: 'web', user: '101', workdir: '/srv', entrypoint: [] }, { volumes: ['v:/d'], copyIn: ['C:\\s:/s'] }, envList, 'claude');
  assert.equal(d.autoRemove, true);
  assert.equal(d.mem, 512);
  assert.deepEqual(d.entrypoint, []);
  assert.deepEqual(d.volumes, ['v:/d']);
  assert.deepEqual(d.copyIn, ['C:\\s:/s']);
  assert.equal(d.ports, undefined, 'left out: the manager publishes the image\'s EXPOSE ports');
  assert.throws(() => K.runBody({ image: 'x', env: { 'bad-name': '1' } }, none, envList, 'claude'), /bad environment variable name/);
});

test('container summaries: URLs for tcp only, LAN URLs when exposed, env NAMES only, fallback and exit meaning', () => {
  const s = K.summarizeContainer({
    id: 'abc123abc123', name: 'web', image: 'nginx:alpine', status: 'exited', exitCode: 137, exitReason: 'killed after 10 s',
    ports: [{ host: 8080, guest: 80, proto: 'tcp', lan: true }, { host: 5353, guest: 53, proto: 'udp', lan: false }],
    volumes: [{ name: 'data', target: '/data', readonly: true }], shares: [{ hostPath: 'C:\\p', guestPath: '/app', readOnly: false, id: 'x-1' }],
    env: ['SECRET=***', 'MODE=***'], createdBy: 'claude', ephemeral: true, runtime: null, mem: 256,
    fallback: { engine: 'docker-vm', code: 'NEEDS_PID1', reason: 's6-overlay must be PID 1' },
  }, ['192.168.1.9'], (h, a) => a.map((x) => 'http://' + x + ':' + h));
  assert.deepEqual(s.urls, [{ url: 'http://127.0.0.1:8080', host_port: 8080, container_port: 80, lan: true, reachable_from: 'this PC and the LAN', lan_urls: ['http://192.168.1.9:8080'] }]);
  assert.deepEqual(s.udp_ports, [{ host_port: 5353, container_port: 53, lan: false }]);
  assert.deepEqual(s.env_names, ['SECRET', 'MODE']);
  assert.ok(!JSON.stringify(s).includes('***'), 'no env values, not even redacted ones');
  assert.deepEqual(s.volumes, ['data:/data:ro']);
  assert.deepEqual(s.shared_folders, [{ host_path: 'C:\\p', guest_path: '/app', read_only: false }]);
  assert.match(s.exit_meaning, /SIGKILL/);
  assert.deepEqual(s.fallback, { engine: 'docker-vm', reason: 's6-overlay must be PID 1' });
  assert.equal(s.memory_mb, 256);
  // an /api/state summary (fewer fields) works too
  const t = K.summarizeContainer({ id: 'x', name: 'y', image: 'z', status: 'running', exitCode: null, ports: [], busy: 'T1' });
  assert.equal(t.busy_task, 'T1');
  assert.equal(t.exit_code, null);
});

test('image readiness: ready, kernel update, a running setup, the user must install QEMU, an old manager', () => {
  const base = { prereqs: { qemu: { ok: true, required: true, action: 'install-qemu' }, microvm: { ok: true } } };
  let r = T.imageReadiness(Object.assign({}, base, { microvm: { ready: true } }));
  assert.equal(r.ready, true);
  assert.match(r.next_step, /run_image/);
  r = T.imageReadiness(Object.assign({}, base, { microvm: { ready: true, needsUpdate: true } }));
  assert.equal(r.ready, true);
  assert.equal(r.needs_update, true);
  assert.match(r.next_step, /setup\(images_only=true\)/);
  r = T.imageReadiness({ prereqs: base.prereqs, microvm: { ready: false, reason: 'the microVM kernel is not installed' } });
  assert.equal(r.ready, false);
  assert.match(r.next_step, /setup\(images_only=true\).*kernel is not installed/);
  r = T.imageReadiness({ prereqs: base.prereqs, microvm: { ready: false }, tasks: { running: [{ id: 'K1', kind: 'install-kernel', title: 'Install the microVM kernel' }] } });
  assert.match(r.next_step, /task_id K1/);
  r = T.imageReadiness({ prereqs: { qemu: { ok: false, required: true, label: 'QEMU', fix: 'sudo apt install qemu-system-x86', action: null }, microvm: { ok: false } }, microvm: { ready: false } });
  assert.deepEqual(r.needs_user, [{ item: 'QEMU', fix: 'sudo apt install qemu-system-x86' }]);
  r = T.imageReadiness({ prereqs: { qemu: { ok: true } } });
  assert.equal(r.supported, false);
  assert.match(r.next_step, /engine="docker-vm"/);
});

test('API errors of the container routes say what to do next (and keep their code)', () => {
  const f = (st, code, msg, body) => T.apiFail(apiErr(st, code, msg, body));
  assert.match(f(409, 'NO_KERNEL', 'the microVM kernel is not installed').message, /setup\(images_only=true\)/);
  assert.equal(f(409, 'NO_KERNEL', 'x').code, 'NO_KERNEL');
  assert.match(f(409, 'NOT_COMPATIBLE', 'needs PID 1', { fallback: { engine: 'docker-vm' }, hint: 's6-overlay' }).message, /\(s6-overlay\) -> run it with Docker inside a full VM.*engine="docker-vm"/);
  assert.match(f(409, 'ZSTD_UNSUPPORTED', 'zstd layers need Node 22.15').message, /engine="docker-vm"/);
  assert.match(f(409, 'MEMORY_BUDGET', 'not enough free memory').message, /smaller memory_mb/);
  assert.match(f(409, 'VOLUME_IN_USE', 'volume pgdata is used by db').message, /one running container at a time/);
  assert.match(f(409, 'NAME_IN_USE', 'name web is taken').message, /remove_container/);
  assert.match(f(404, 'NO_SUCH_CONTAINER', 'no container "x"').message, /list_containers/);
  assert.match(f(429, 'RATE_LIMITED', 'pull limit', { rateLimit: { reset: '2026-10-01T00:00:00Z' } }).message, /resets at 2026-10-01.*retry later/);
  assert.match(f(400, 'HOST_FOLDER', 'bad folder').message, /absolute path/);
  assert.match(f(400, 'BAD_REFERENCE', 'bad image').message, /nginx:alpine/);
  assert.match(f(400, 'SOMETHING', 'odd', { hint: 'try X' }).message, /odd \(try X\)$/, 'a manager hint is kept');
  // a registry "UNAUTHORIZED" (private repo) is not the manager refusing the token
  assert.match(f(409, 'UNAUTHORIZED', 'repository does not exist or needs a login').message, /repository does not exist/);
});

test('upload/download also protect the microVM parts of the data folder (container env secrets, volume disks, kernel, images)', () => {
  const env = { dataRoot: path.resolve('/d'), appDir: null, home: null, allow: [] };
  for (const p of ['containers.json', 'containers.json.bak', 'microvms/abc/spec.sh', 'volumes/pg.qcow2', 'kernel/host.json', 'images/refs.json']) {
    assert.throws(() => T.guardLocalPath(path.join(env.dataRoot, p), 'local_path', 'read', false, env), /private files/, p);
  }
});

// ---------------------------------------------------------------------------
// run_image
// ---------------------------------------------------------------------------
test('run_image (wait_for ready): a microVM by default, temporary, created by claude, this PC only; returns URLs', async () => {
  const m = fakeManager();
  const r = await toolsFor(m).call('run_image', { image: 'nginx:alpine', ports: ['8080:80'], env: { MODE: 'x' } });
  const body = posts(m, '/api/container/run')[0][2];
  // ports go structured, the exposure from `lan` alone (sec-9)
  assert.deepEqual(body, { image: 'nginx:alpine', engine: 'microvm', createdBy: 'mcp', ephemeral: true, lan: false, env: ['MODE=x'], ports: [{ host: 8080, guest: 80, proto: 'tcp', lan: false }], pull: 'missing' });
  assert.equal(r.status, 'running');
  assert.equal(r.engine, 'microvm');
  assert.match(r.container.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(r.urls, [{ url: 'http://127.0.0.1:8080', host_port: 8080, container_port: 80, lan: false, reachable_from: 'this PC only' }]);
  assert.equal(r.memory_mb, 256);
  assert.equal(r.accel, 'whpx');
  assert.match(r.note, /RAM/);
  assert.match(r.next, /image_logs.*stop_image.*remove_container/);
});

// the manager refuses less than 128 MB (validate.runFields): the schema must
// not advertise a smaller minimum that only fails later with a 400
test('run_image memory_mb: the schema minimum is the manager\'s (128 MB)', () => {
  const t = T.createTools({ connect: async () => null }).find((x) => x.name === 'run_image');
  assert.equal(t.params.memory_mb.minimum, 128);
});

test('run_image (wait_for exit): exit code + separate stdout/stderr; remove_on_exit removes AFTER reading the output', async () => {
  const m = fakeManager({
    run: {
      record: { name: 'once', status: 'running' },
      polls: [{ status: 'running' }, { status: 'exited', exitCode: 3, endedAt: 'now' }],
      logs: { stdout: 'hi\n', stderr: 'err\n' },
    },
  });
  const r = await toolsFor(m).call('run_image', { image: 'alpine', command: ['sh', '-c', 'echo hi; echo err >&2; exit 3'], wait_for: 'exit', remove_on_exit: true });
  const body = posts(m, '/api/container/run')[0][2];
  assert.equal(body.autoRemove, undefined, 'the manager would delete the logs with the container');
  assert.deepEqual(body.cmd, ['sh', '-c', 'echo hi; echo err >&2; exit 3']);
  assert.equal(r.status, 'exited');
  assert.equal(r.exit_code, 3);
  assert.match(r.exit_meaning, /error/);
  assert.equal(r.stdout, 'hi\n');
  assert.equal(r.stderr, 'err\n');
  assert.equal(r.truncated, false);
  assert.equal(r.removed, true);
  const order = m.calls.map((c) => c[0] + ' ' + c[1].split('?')[0]);
  assert.ok(order.lastIndexOf('GET /api/container/logs') < order.indexOf('POST /api/container/remove'), 'logs read before the remove');
  assert.equal(m.containers.size, 0);
});

test('run_image: big output is capped like exec (first 20 KB + last 80 KB with a marker)', async () => {
  const big = Array.from({ length: 6000 }, (_, i) => 'line ' + i + ' ' + '.'.repeat(40)).join('\n') + '\n';
  const m = fakeManager({ run: { record: { status: 'exited', exitCode: 0 }, logs: { stdout: big, stderr: '' } } });
  const r = await toolsFor(m).call('run_image', { image: 'alpine', wait_for: 'exit' });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 110 * 1024);
  assert.match(r.stdout, /^line 0 /);
  assert.match(r.stdout, /bytes omitted/);
  assert.match(r.stdout, /line 5999 \.+\n$/);
  assert.match(r.output_note, /first 20 KB/);
  assert.equal(r.exit_meaning, undefined);
});

test('run_image: a start still running at timeout_s -> {status:"running", task_id}; a server still up at wait_for=exit\'s deadline says so', async () => {
  const m = fakeManager({ run: { task: 'running' } });
  const r = await toolsFor(m).call('run_image', { image: 'python:3-alpine', timeout_s: 1 });
  assert.equal(r.status, 'running');
  assert.match(r.task_id, /^task-/);
  assert.match(r.hint, /get_task/);
  assert.ok(r.container && r.container.id);

  const m2 = fakeManager({ run: { polls: Array(2000).fill({ status: 'running' }) } });
  const t0 = Date.now();
  const r2 = await toolsFor(m2).call('run_image', { image: 'alpine', command: ['sleep', '999'], wait_for: 'exit', timeout_s: 1 });
  assert.ok(Date.now() - t0 >= 900, 'waited for the exit until timeout_s');
  assert.equal(r2.status, 'running');
  assert.equal(r2.task_id, undefined, 'the start is done; the app is what still runs');
  assert.match(r2.note, /still running after 1 s/);
});

test('run_image: a failure with a Docker-in-VM suggestion removes the attempt and names deploy_image(engine="docker-vm"); other failures keep it', async () => {
  const m = fakeManager({
    run: {
      record: { status: 'error', fallback: { engine: 'docker-vm', code: 'NEEDS_PID1', reason: 's6-overlay must run as PID 1' } },
      task: { status: 'error', error: 'not compatible with the microVM engine' },
    },
  });
  await assert.rejects(toolsFor(m).call('run_image', { image: 'lscr.io/linuxserver/x' }), (e) =>
    /as a microVM is not possible/.test(e.message) && /deploy_image\(image="lscr.io\/linuxserver\/x", engine="docker-vm"\)/.test(e.message) &&
    /s6-overlay/.test(e.message) && /ports are free/.test(e.message));
  assert.equal(m.containers.size, 0, 'removed: its reserved ports would block the Docker-in-VM run');

  const m2 = fakeManager({
    run: {
      record: { name: 'bad', status: 'error', exitCode: 125, exitReason: 'the VM did not boot', initMessages: ['devbox-init: volume pg: mount failed'] },
      task: { status: 'error', error: 'the VM did not boot', log: ['[00:00:01] booting'] },
    },
  });
  await assert.rejects(toolsFor(m2).call('run_image', { image: 'postgres:16-alpine', volumes: ['pg:/var/lib/postgresql/data'] }), (e) =>
    /failed: the VM did not boot/.test(e.message) && /devbox-init: volume pg: mount failed/.test(e.message) &&
    /image_logs\(container="bad", stream="console"\)/.test(e.message) && /\(task_id task-/.test(e.message));
  assert.equal(m2.containers.size, 1, 'kept for image_logs');
});

test('run_image: an app that ends before READY with its own code (127: command not found) is an exit result, not a tool failure; 125 stays a failure', async () => {
  const m = fakeManager({
    run: {
      record: { name: 'nocmd', status: 'exited', exitCode: 127, exitReason: 'command not found: sh: nope: not found', initMessages: ['devbox-init: nope: not found'] },
      task: { status: 'error', error: 'the container stopped before its app started (exit code 127): command not found' },
      logs: { stdout: '', stderr: 'sh: nope: not found\n' },
    },
  });
  const r = await toolsFor(m).call('run_image', { image: 'alpine', command: ['nope'], wait_for: 'exit' });
  assert.equal(r.status, 'exited');
  assert.equal(r.exit_code, 127);
  assert.equal(r.exit_meaning, 'command not found');
  assert.match(r.exit_reason, /command not found/);
  assert.deepEqual(r.init_messages, ['devbox-init: nope: not found']);
  assert.equal(r.stderr, 'sh: nope: not found\n');
  const m2 = fakeManager({ run: { record: { status: 'error', exitCode: 125, exitReason: 'the VM did not boot within 90 s' }, task: { status: 'error', error: 'the VM did not boot within 90 s' } } });
  await assert.rejects(toolsFor(m2).call('run_image', { image: 'alpine', wait_for: 'exit' }), /failed: the VM did not boot/);
});

test('run_image: folders of this PC are guarded BEFORE the manager is asked; a good one is sent as an absolute live share', async () => {
  const base = tmpDir('runguard');
  try {
    const dataRoot = path.join(base, 'data');
    const home = path.join(base, 'home');
    for (const d of [path.join(dataRoot, 'seed'), path.join(home, '.ssh'), path.join(home, 'proj')]) fs.mkdirSync(d, { recursive: true });
    const localEnv = () => ({ dataRoot: dataRoot, appDir: path.join(base, 'app'), home: home, allow: [] });
    const m = fakeManager();
    const tl = toolsFor(m, { localEnv: localEnv });
    await assert.rejects(tl.call('run_image', { image: 'alpine', volumes: [path.join(home, '.ssh') + ':/keys:ro'] }), /SSH keys/);
    await assert.rejects(tl.call('run_image', { image: 'alpine', volumes: [dataRoot + ':/d'] }), /private files|contains/);
    await assert.rejects(tl.call('run_image', { image: 'alpine', volumes: [home + ':/h'] }), /contains .*SSH keys/, 'a folder holding ~/.ssh');
    await assert.rejects(tl.call('run_image', { image: 'alpine', copy_in: [path.join(dataRoot, 'seed') + ':/x'] }), /private files/);
    await assert.rejects(tl.call('run_image', { image: 'alpine', volumes: ['proj:/app', 'rel/dir:/x'] }), /volumes/);
    assert.equal(m.calls.length, 0, 'the manager was not even asked');
    const proj = path.join(home, 'proj');
    await tl.call('run_image', { image: 'nginx:alpine', volumes: [proj + ':/usr/share/nginx/html:ro', 'cache:/cache'] });
    assert.deepEqual(posts(m, '/api/container/run')[0][2].volumes, [proj + ':/usr/share/nginx/html:ro', 'cache:/cache']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('run_image engine="auto": when the manager picks Docker-in-VM it follows that task and says why', async () => {
  const m = fakeManager({ run: { engine: 'docker-vm', reason: 'privileged images need Docker' } });
  const r = await toolsFor(m).call('run_image', { image: 'homeassistant/home-assistant', engine: 'auto' });
  assert.equal(posts(m, '/api/container/run')[0][2].engine, 'auto');
  assert.equal(r.status, 'done');
  assert.equal(r.engine, 'docker-vm');
  assert.equal(r.engine_reason, 'privileged images need Docker');
  assert.equal(r.vm, 'nginx-vm');
  assert.match(r.next, /docker logs/);
});

test('run_image: remove_on_exit on a detached run is the manager\'s autoRemove; a quick exit then reports what the task said', async () => {
  const m = fakeManager({ run: { removeOnEnd: true, task: { status: 'done', result: { exitCode: 0, stdout: 'Hello from Docker!\n' } } } });
  const r = await toolsFor(m).call('run_image', { image: 'hello-world', remove_on_exit: true });
  assert.equal(posts(m, '/api/container/run')[0][2].autoRemove, true);
  assert.equal(r.status, 'exited');
  assert.equal(r.exit_code, 0);
  assert.equal(r.removed, true);
  assert.equal(r.stdout, 'Hello from Docker!\n');
});

// ---------------------------------------------------------------------------
// the other container tools
// ---------------------------------------------------------------------------
test('stop_image: waits for the stop task, reports exit code and how; an exited container is "already exited" (idempotent)', async () => {
  const m = fakeManager();
  const tl = toolsFor(m);
  const run = await tl.call('run_image', { image: 'nginx:alpine', name: 'web' });
  let r = await tl.call('stop_image', { container: 'web', timeout_s: 3 });
  assert.deepEqual(posts(m, '/api/container/stop')[0][2], { id: 'web', force: false, timeoutS: 3 });
  assert.equal(r.status, 'done');
  assert.equal(r.exit_code, 0);
  assert.equal(r.how, 'graceful');
  assert.deepEqual(r.container, { id: run.container.id, name: 'web' });
  assert.match(r.next, /kept/);
  r = await tl.call('stop_image', { container: 'web' });
  assert.equal(r.already_stopped, true);
  assert.equal(r.how, 'already exited');
  await assert.rejects(tl.call('stop_image', { container: 'ghost' }), /no container "ghost".*list_containers/);
  // force: SIGKILL
  await tl.call('run_image', { image: 'nginx:alpine', name: 'web2' });
  r = await tl.call('stop_image', { container: 'web2', force: true });
  assert.equal(r.exit_code, 137);
  assert.match(r.exit_meaning, /SIGKILL/);
});

test('image_logs: both streams by default, tail and previous passed on, status included; an unknown container is a clear error', async () => {
  const m = fakeManager({ run: { record: { name: 'web', status: 'exited', exitCode: 1, exitReason: 'app crashed' }, logs: { stdout: 'out\n', stderr: 'boom\n', console: '__DEVBOX_READY\n' } } });
  const tl = toolsFor(m);
  await tl.call('run_image', { image: 'x' });
  let r = await tl.call('image_logs', { container: 'web', tail: 50 });
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'boom\n');
  assert.equal(r.status, 'exited');
  assert.equal(r.exit_code, 1);
  assert.equal(r.exit_reason, 'app crashed');
  const logGets = m.calls.filter((c) => c[0] === 'GET' && c[1].indexOf('/api/container/logs') === 0).slice(-2).map((c) => c[1]);
  assert.ok(logGets.every((p) => /&tail=50$/.test(p)), logGets.join(' '));
  r = await tl.call('image_logs', { container: 'web', stream: 'console', previous: true });
  assert.equal(r.console, '__DEVBOX_READY\n');
  assert.equal(r.stdout, undefined);
  assert.match(m.calls[m.calls.length - 1][1], /stream=console&tail=200&prev=1$/);
  await assert.rejects(tl.call('image_logs', { container: 'nope' }), /no container "nope"/);
  await assert.rejects(tl.call('image_logs', { container: 'web', stream: 'all' }), /stream must be one of/);
});

test('list_containers: records as summaries (no env values), all=false hides exited ones; an engine without the listing falls back to /api/state', async () => {
  const m = fakeManager();
  m.containers.set('aaaaaaaaaaaa', { id: 'aaaaaaaaaaaa', name: 'web', image: 'nginx:alpine', status: 'running', exitCode: null, ports: [{ host: 8080, guest: 80, proto: 'tcp', lan: false }], env: ['PASSWORD=***'], createdBy: 'claude', ephemeral: true });
  m.containers.set('bbbbbbbbbbbb', { id: 'bbbbbbbbbbbb', name: 'job', image: 'alpine', status: 'exited', exitCode: 0, ports: [], createdBy: 'gui', ephemeral: false });
  const tl = toolsFor(m);
  let r = await tl.call('list_containers');
  assert.equal(r.count, 2);
  assert.deepEqual(r.containers[0].env_names, ['PASSWORD']);
  assert.ok(!JSON.stringify(r).includes('***'));
  assert.equal(r.containers[0].urls[0].reachable_from, 'this PC only');
  r = await tl.call('list_containers', { all: false });
  assert.deepEqual(r.containers.map((c) => c.name), ['web']);
  m.gets['/api/containers'] = () => { throw apiErr(501, 'NOT_IMPLEMENTED', 'listing containers is not implemented yet'); };
  r = await tl.call('list_containers');
  assert.equal(r.count, 2);
  assert.match(r.note, /summaries only/);
});

test('remove_container: refuses a running one without force (says how), force removes it; a missing one is already_gone', async () => {
  const m = fakeManager();
  const tl = toolsFor(m);
  await tl.call('run_image', { image: 'nginx:alpine', name: 'web' });
  await assert.rejects(tl.call('remove_container', { container: 'web' }), /is running - stop it first \(stop_image\), or .*force=true/);
  const r = await tl.call('remove_container', { container: 'web', force: true });
  assert.equal(r.removed, true);
  assert.match(r.note, /named volumes are kept/);
  const again = await tl.call('remove_container', { container: 'web' });
  assert.equal(again.already_gone, true);
  // a manager that removes through a task (forced stop first) is followed
  m.posts['/api/container/remove'] = (b, mm) => { const t = mm.newTask('ctr-remove', { ctr: 'x' }, { status: 'done', result: {} }); return { ok: true, task: { id: t.id, status: 'running' } }; };
  assert.equal((await tl.call('remove_container', { container: 'x', force: true })).removed, true);
});

test('pull_image, list_images, remove_image: bodies, sizes in MB, quota, digest form, in-use refusal', async () => {
  const m = fakeManager({
    images: {
      images: [{ references: ['docker.io/library/nginx:alpine'], configDigest: 'sha256:' + 'a'.repeat(64), compressedBytes: 25 * 1048576, rootfsBytes: 60 * 1048576, initrdBytes: 70 * 1048576, lastUsed: '2026-09-30T10:00:00Z', usedBy: ['abc'], compat: { engine: 'microvm', reasons: [] } }],
      rateLimit: { limit: 100, remaining: 97, window: 21600, at: '2026-09-30T10:00:00Z' }, cacheBytes: 155 * 1048576,
    },
  });
  m.posts['/api/image/pull'] = (b, mm) => {
    const t = mm.newTask('image-pull', {}, { status: 'done', result: { reference: 'docker.io/library/nginx:alpine', configDigest: 'sha256:x', compressedBytes: 25 * 1048576, downloadedBytes: 0, cached: { image: true }, rateLimit: { limit: 100, remaining: 97 } } });
    return { ok: true, task: { id: t.id, status: 'running' } };
  };
  m.posts['/api/image/remove'] = (b) => {
    if (b.image === 'busy:1' && !b.force) throw apiErr(409, 'IMAGE_IN_USE', 'image busy:1 is used by container web');
    return { ok: true, removed: true, freedBytes: 10 * 1048576 };
  };
  const tl = toolsFor(m);
  const p = await tl.call('pull_image', { image: ' nginx:alpine ' });
  assert.deepEqual(posts(m, '/api/image/pull')[0][2], { image: 'nginx:alpine' });
  assert.equal(p.status, 'done');
  assert.equal(p.reference, 'docker.io/library/nginx:alpine');
  assert.equal(p.download_size_mb, 25);
  assert.equal(p.was_cached, true);
  assert.deepEqual(p.docker_hub_pull_quota, { limit: 100, remaining: 97 });
  const l = await tl.call('list_images');
  assert.equal(l.count, 1);
  assert.equal(l.cache_mb, 155);
  assert.equal(l.images[0].unpacked_mb, 60);
  assert.deepEqual(l.images[0].used_by, ['abc']);
  assert.equal(l.docker_hub_pull_quota.remaining, 97);
  let r = await tl.call('remove_image', { image: 'nginx:alpine' });
  assert.equal(r.freed_mb, 10);
  await tl.call('remove_image', { image: 'sha256:' + 'b'.repeat(64) });
  assert.deepEqual(posts(m, '/api/image/remove')[1][2], { configDigest: 'sha256:' + 'b'.repeat(64), force: false });
  await assert.rejects(tl.call('remove_image', { image: 'busy:1' }), /used by container web -> remove those containers first.*force=true/);
  r = await tl.call('remove_image', { image: 'busy:1', force: true });
  assert.equal(r.removed, true);
});

// ---------------------------------------------------------------------------
// deploy_image engines, status, setup, cleanup, get_task
// ---------------------------------------------------------------------------
test('deploy_image engine "auto" (default): a microVM when possible, status done with URLs', async () => {
  const m = fakeManager();
  const r = await toolsFor(m).call('deploy_image', { image: 'nginx:alpine', ports: ['8080:80'] });
  assert.equal(posts(m, '/api/vm/quickdeploy').length, 0);
  const body = posts(m, '/api/container/run')[0][2];
  assert.equal(body.engine, 'auto');
  assert.equal(body.createdBy, 'mcp', 'the container API takes gui | mcp | api');
  assert.deepEqual(body.ports, [{ host: 8080, guest: 80, proto: 'tcp', lan: false }]);
  assert.equal(r.status, 'done');
  assert.equal(r.container_status, 'running');
  assert.equal(r.engine, 'microvm');
  assert.equal(r.urls[0].url, 'http://127.0.0.1:8080');
});

test('deploy_image auto: a microVM refusal is followed by Docker-in-VM automatically (the attempt removed, the reason given)', async () => {
  const m = fakeManager({
    run: { record: { status: 'error', fallback: { engine: 'docker-vm', code: 'LARGE_IMAGE', reason: 'large image (about 900 MB unpacked)' } }, task: { status: 'error', error: 'not compatible' } },
  });
  const r = await toolsFor(m).call('deploy_image', { image: 'big/app', ports: ['3000'], env: { A: '1' }, volumes: ['data:/data'] });
  const qd = posts(m, '/api/vm/quickdeploy');
  assert.equal(qd.length, 1);
  assert.deepEqual(qd[0][2], { image: 'big/app', lan: false, privileged: false, ephemeral: true, createdBy: 'claude', keepOnFailure: false, ports: [{ host: 3000, guest: 3000, lan: false }], env: ['A=1'], volumes: ['data:/data'] });
  assert.equal(r.engine, 'docker-vm');
  assert.equal(r.fallback_reason, 'large image (about 900 MB unpacked)');
  assert.equal(r.status, 'done');
  assert.equal(m.containers.size, 0, 'the microVM attempt was removed first (its ports were reserved)');
  // engine "microvm" never falls back: it reports
  const m2 = fakeManager({ run: { record: { status: 'error', fallback: { engine: 'docker-vm', reason: 'needs PID 1' } }, task: { status: 'error', error: 'not compatible' } } });
  await assert.rejects(toolsFor(m2).call('deploy_image', { image: 'x/y', engine: 'microvm' }), /engine="docker-vm"/);
  assert.equal(posts(m2, '/api/vm/quickdeploy').length, 0);
});

test('deploy_image auto: the manager\'s own docker-vm choice, privileged, no kernel, and host folders that cannot follow', async () => {
  let m = fakeManager({ run: { engine: 'docker-vm', reason: 'compose-like request' } });
  let r = await toolsFor(m).call('deploy_image', { image: 'a/b' });
  assert.equal(r.engine, 'docker-vm');
  assert.equal(r.fallback_reason, 'compose-like request');
  // privileged: straight to Docker-in-VM (microvm refuses it up front)
  m = fakeManager();
  r = await toolsFor(m).call('deploy_image', { image: 'homeassistant/home-assistant', privileged: true });
  assert.equal(posts(m, '/api/container/run').length, 0);
  assert.equal(posts(m, '/api/vm/quickdeploy')[0][2].privileged, true);
  assert.match(r.fallback_reason, /privileged/);
  await assert.rejects(toolsFor(fakeManager()).call('deploy_image', { image: 'x', privileged: true, engine: 'microvm' }), /privileged containers need a real Docker Engine/);
  // no microVM kernel: Docker-in-VM when the base image exists...
  m = fakeManager();
  m.posts['/api/container/run'] = () => { throw apiErr(409, 'NO_KERNEL', 'the microVM kernel is not installed'); };
  r = await toolsFor(m).call('deploy_image', { image: 'nginx:alpine' });
  assert.equal(r.engine, 'docker-vm');
  assert.match(r.fallback_reason, /kernel is not installed/);
  // ...else the setup hint
  m.posts['/api/vm/quickdeploy'] = () => { throw apiErr(409, 'NO_BASE', 'the base image is not built yet'); };
  await assert.rejects(toolsFor(m).call('deploy_image', { image: 'nginx:alpine' }), /not set up for Docker images yet -> call setup\(images_only=true\)/);
  // a live folder of this PC cannot follow into a full VM: explained, not guessed
  const dir = tmpDir('deployhf');
  try {
    m = fakeManager({ run: { record: { status: 'error', fallback: { engine: 'docker-vm', reason: 'needs PID 1' } }, task: { status: 'error', error: 'x' } } });
    await assert.rejects(toolsFor(m).call('deploy_image', { image: 'x/y', volumes: [dir + ':/app'] }), /shared live only with microVMs.*share_folder/);
    assert.equal(posts(m, '/api/vm/quickdeploy').length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // wait=false: the task id at once
  m = fakeManager({ run: { task: 'running' } });
  r = await toolsFor(m).call('deploy_image', { image: 'nginx:alpine', wait: false });
  assert.equal(r.status, 'running');
  assert.equal(r.engine, 'microvm');
  assert.match(r.task_id, /^task-/);
});

test('status reports ready_for_images, the microVM facts and the containers; setup(images_only) runs the short setup', async () => {
  const m = fakeManager();
  const tl = toolsFor(m);
  await tl.call('run_image', { image: 'nginx:alpine', name: 'web' });
  let s = await tl.call('status');
  assert.equal(s.ready, true);
  assert.equal(s.ready_for_images, true);
  assert.match(s.next_step_for_images, /run_image/);
  assert.deepEqual(s.microvm, { ready: true, kernel: '6.18.54-0-virt', accel: 'whpx', machine: 'microvm' });
  assert.deepEqual(s.containers.map((c) => [c.name, c.status]), [['web', 'running']]);
  // images ready: nothing to do
  assert.equal((await tl.call('setup', { images_only: true })).already_set_up, true);
  // no kernel: the short setup (QEMU + kernel), not the bake
  m.state.microvm = { ready: false, reason: 'the microVM kernel is not installed' };
  m.state.prereqs.microvm.ok = false;
  s = await tl.call('status');
  assert.equal(s.ready_for_images, false);
  assert.match(s.next_step_for_images, /setup\(images_only=true\)/);
  let r = await tl.call('setup', { images_only: true });
  assert.deepEqual(posts(m, '/api/setup').pop()[2], { only: 'microvm' });
  assert.match(r.next_step, /run_image/);
  // plain setup with VMs ready but no kernel: also the short form
  r = await tl.call('setup');
  assert.deepEqual(posts(m, '/api/setup').pop()[2], { only: 'microvm' });
  // a kernel update counts as not done
  m.state.microvm = { ready: true, needsUpdate: true };
  m.state.prereqs.microvm = { ok: true, needsUpdate: true };
  await tl.call('setup', { images_only: true });
  assert.equal(posts(m, '/api/setup').length, 3);
  // nothing set up: the full setup
  m.state.prereqs.base.ok = false;
  m.state.microvm = { ready: false };
  await tl.call('setup');
  assert.deepEqual(posts(m, '/api/setup').pop()[2], {});
});

test('cleanup also removes Claude\'s temporary containers (never the user\'s); dry_run lists them', async () => {
  const m = fakeManager();
  m.containers.set('aaaaaaaaaaaa', { id: 'aaaaaaaaaaaa', name: 'tmp', image: 'x', status: 'running', createdBy: 'mcp', ephemeral: true });
  m.containers.set('bbbbbbbbbbbb', { id: 'bbbbbbbbbbbb', name: 'keep', image: 'x', status: 'exited', createdBy: 'claude', ephemeral: false });
  m.containers.set('cccccccccccc', { id: 'cccccccccccc', name: 'users', image: 'x', status: 'running', createdBy: 'gui', ephemeral: true });
  const tl = toolsFor(m);
  const dry = await tl.call('cleanup', { dry_run: true });
  assert.deepEqual(dry.would_remove_containers.map((c) => c.name), ['tmp']);
  assert.deepEqual(dry.containers_kept, ['keep', 'users']);
  assert.equal(m.containers.size, 3);
  const r = await tl.call('cleanup');
  assert.deepEqual(r.containers_removed, ['tmp']);
  assert.deepEqual(posts(m, '/api/container/remove')[0][2], { id: 'aaaaaaaaaaaa', force: true });
  assert.deepEqual(Array.from(m.containers.keys()).sort(), ['bbbbbbbbbbbb', 'cccccccccccc']);
  const all = await tl.call('cleanup', { ephemeral_only: false });
  assert.deepEqual(all.containers_removed, ['keep']);
});

test('get_task names the container a task works on', async () => {
  const m = fakeManager({ run: { task: 'running' } });
  const tl = toolsFor(m);
  const r = await tl.call('run_image', { image: 'alpine', timeout_s: 1 });
  const t = await tl.call('get_task', { task_id: r.task_id });
  assert.equal(t.container, r.container.id);
  assert.equal(t.kind, 'ctr-run');
});
