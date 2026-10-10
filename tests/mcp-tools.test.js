'use strict';
/*
 * lib/mcp/tools.js: the tool list and its schemas, the pure helpers, and
 * every handler against a FAKE manager (no HTTP, no QEMU). The file tools
 * (exec, write_file, read_file, upload, download) also run for real against
 * a local POSIX sh standing in for the guest, when one exists (Git's sh on
 * Windows, /bin/sh elsewhere) - that proves the generated shell scripts and
 * the tar/ssh plumbing, byte for byte.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./helpers'); // points CFG at a scratch root before lib/ is used
const { schemaProblems, ToolError, createServer } = require('../lib/mcp/protocol');
const T = require('../lib/mcp/tools');
const sshMod = require('../lib/ssh');

// ---------------------------------------------------------------------------
// a fake manager
// ---------------------------------------------------------------------------
function vmRow(name, extra) {
  return Object.assign({
    name: name, status: 'running', port: 2230, sshLan: false, sshCommand: 'ssh -i key -p 2230 root@127.0.0.1',
    mem: 1024, cpus: 2, accel: 'auto', effectiveAccel: 'whpx', template: 'devbox-base', ports: [], ephemeral: false,
    createdBy: 'gui', createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, diskBytes: 1048576 * 3, snapshots: [], busy: null,
    pendingRestart: false, lastError: null, note: '',
  }, extra || {});
}

function apiErr(status, code, message, body) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.body = Object.assign({ ok: false, error: message, code: code }, body || {});
  return e;
}

function fakeManager(opts) {
  opts = opts || {};
  const m = {
    calls: [],
    state: Object.assign({
      version: '2.0.0', dataRoot: '/data', managerPort: 8777,
      platform: { os: 'win32', arch: 'x64', accel: { available: ['whpx', 'tcg'], recommended: 'whpx' }, lanAddresses: ['172.20.0.1', '192.168.1.9'] },
      prereqs: {
        qemu: { ok: true, required: true, label: 'QEMU emulator', detail: 'v10', fix: null, action: 'install-qemu' },
        ssh: { ok: true, required: true, label: 'OpenSSH client', detail: 'x', fix: null },
        base: { ok: true, required: true, label: 'Golden base image', detail: '1 GB', fix: null, action: 'build-base' },
      },
      bases: [{ name: 'devbox-base', size: 1073741824, isDefault: true, usedBy: 0 }],
      vms: [], tasks: { running: [], recent: [] },
      limits: { maxMem: 12288, defaultMem: 1024, maxCpus: 8, defaultCpus: 2 },
      host: { memFree: 8 * 1073741824, diskFree: 100 * 1073741824 },
    }, opts.state || {}),
    tasks: new Map(),
    seq: 0,
    // route -> fn(body) returning a value or throwing; default: start a task
    posts: opts.posts || {},
    // task behaviour: fn(path, body) -> {status, result, error, log} (final) or 'running'
    taskEnd: opts.taskEnd || (() => ({ status: 'done', result: {} })),
  };
  m.client = {
    url: 'http://127.0.0.1:8777/', root: '/data', port: 8777, version: '2.0.0', started: !!opts.started,
    get: async (p) => {
      m.calls.push(['GET', p]);
      // route prefix -> fn(path, m): extra GET routes a test answers itself
      for (const k of Object.keys(opts.gets || {})) if (p.indexOf(k) === 0) return opts.gets[k](p, m);
      if (p === '/api/state') return JSON.parse(JSON.stringify(m.state));
      if (p.indexOf('/api/task?id=') === 0) {
        const id = decodeURIComponent(p.slice('/api/task?id='.length));
        const t = m.tasks.get(id);
        if (!t) throw apiErr(404, 'NOT_FOUND', 'no task with id ' + id);
        return { ok: true, task: JSON.parse(JSON.stringify(t)) };
      }
      if (p.indexOf('/api/log?') === 0) return { ok: true, name: 'x', text: 'boot\nlogin:', lines: 2, truncated: false };
      throw apiErr(404, 'NOT_FOUND', 'no route ' + p);
    },
    post: async (p, body) => {
      m.calls.push(['POST', p, body]);
      if (m.posts[p]) return m.posts[p](body, m);
      const id = 'task-' + (++m.seq);
      const end = m.taskEnd(p, body, m);
      const t = { id: id, kind: p.split('/').pop(), title: p, vm: body && body.name, status: 'running', step: 'working', log: ['[00:00:00] started: ' + p], startedAt: Date.now(), endedAt: null };
      if (end !== 'running') Object.assign(t, { endedAt: Date.now(), step: null }, end, { log: t.log.concat(end.log || []) });
      m.tasks.set(id, t);
      return { ok: true, task: { id: id, kind: t.kind, title: t.title, vm: t.vm, status: 'running' } };
    },
  };
  return m;
}

function toolsFor(m, extra) {
  const deps = Object.assign({
    connect: async () => m.client,
    waitForTask: require('../lib/client').waitForTask,
    pollMs: 5,
    exit: () => {},
    version: '2.0.0',
    dataRoot: () => '/data',
    platform: { findTool: () => 'ssh', isPortFree: async () => true, lanAddresses: () => ['172.20.0.1', '192.168.1.9'], installHints: () => ({ ssh: 'install OpenSSH' }) },
    ssh: { sshExec: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 5 }), sshArgs: sshMod.sshArgs, scp: async () => ({ code: 0 }) },
  }, extra || {});
  const list = T.createTools(deps);
  const by = {};
  for (const t of list) by[t.name] = t;
  // call through the real protocol so argument checking and defaults apply
  const server = createServer({ name: 't', version: '1' });
  for (const t of list) server.addTool(t);
  by.call = async (name, args, ctx) => {
    const r = await server.callTool({ name: name, arguments: args || {} }, ctx || { afterReply: () => {} });
    const text = r.content[0].text;
    if (r.isError) { const e = new ToolError(text); e.isError = true; throw e; }
    return JSON.parse(text);
  };
  return by;
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------
test('the 37 tools (spec section 13 + microVM spec 13 + shares spec 7 + appliance VMs and their screen + the host probe), each with a healthy schema and honest annotations', () => {
  const s = createServer({ name: 'devbox-vms', version: '2.0.0' });
  for (const t of T.createTools({ connect: async () => { throw new Error('unused'); } })) s.addTool(t);
  const listed = s.listTools();
  assert.equal(listed.length, 37);
  assert.deepEqual(listed.map((t) => t.name), T.TOOL_NAMES);
  for (const t of listed) {
    assert.deepEqual(schemaProblems(t), [], t.name);
    assert.ok(t.description.length >= 120, t.name + ' has a real description for the model');
    assert.equal(t.annotations.openWorldHint, false, t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.title, t.name + ' has a title');
  }
  const ro = listed.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ['get_task', 'image_logs', 'list_containers', 'list_images', 'list_shares', 'list_vms', 'read_file', 'screen_text', 'screenshot_vm', 'serial_log', 'status', 'wait_for_text']);
  const destructive = listed.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  // stop_image: the app is killed after its timeout, and a rootfs="ram"
  // container's files are gone after a stop
  assert.deepEqual(destructive, ['cleanup', 'delete_vm', 'download', 'exec', 'remove_container', 'remove_image', 'reset_vm', 'snapshot', 'stop_image', 'upload', 'write_file']);
  const get = (n) => listed.find((t) => t.name === n).inputSchema;
  assert.deepEqual(get('exec').required, ['name', 'command']);
  assert.equal(get('exec').properties.timeout_s.default, 300);
  assert.deepEqual(get('exec').properties.user.enum, ['root', 'dev']);
  assert.equal(get('create_vm').properties.ephemeral.default, true);
  assert.equal(get('create_vm').properties.timeout_s.default, 300);
  assert.equal(get('setup').properties.timeout_s.default, 1800);
  assert.equal(get('deploy_image').properties.timeout_s.default, 900);
  assert.equal(get('forward_port').properties.lan.default, false, 'this PC only unless asked');
  assert.equal(get('deploy_image').properties.lan.default, false);
  assert.equal(get('read_file').properties.max_bytes.default, 200000);
  assert.equal(get('serial_log').properties.lines.default, 100);
  assert.deepEqual(get('snapshot').properties.action.enum, ['list', 'create', 'revert', 'delete']);
  assert.equal(get('cleanup').properties.ephemeral_only.default, true);
  assert.equal(get('setup').properties.images_only.default, false);
  assert.match(T.INSTRUCTIONS, /status first/);
  assert.match(T.INSTRUCTIONS, /lan=true only when the user explicitly asks/);
  // when to use which sandbox
  assert.match(T.INSTRUCTIONS, /ONE Docker image[^\n]*run_image[^\n]*microVM/);
  assert.match(T.INSTRUCTIONS, /interactive Linux box[^\n]*create_vm/);
  assert.match(T.INSTRUCTIONS, /compose[^\n]*engine="docker-vm"/);
  assert.match(T.INSTRUCTIONS, /project folder[^\n]*share_folder[^\n]*run_image's volumes/);
  assert.match(T.INSTRUCTIONS, /inotify/);
  assert.match(T.INSTRUCTIONS, /setup\(images_only=true\)/);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('exec scripts: cd + exports quoted for sh; bad names and paths refused', () => {
  assert.equal(T.buildExecCommand('ls -la'), 'ls -la');
  assert.equal(T.buildExecCommand('make test', { workdir: '/src/my app', env: { CI: '1', MSG: "it's $x" } }),
    "cd '/src/my app' || exit 1\nexport CI='1'\nexport MSG='it'\\''s $x'\nmake test");
  assert.equal(T.buildExecCommand('pwd', { workdir: '~/proj' }), 'cd "$HOME"/\'proj\' || exit 1\npwd');
  assert.throws(() => T.buildExecCommand('x', { env: { '1BAD': 'x' } }), /bad environment variable name "1BAD"/);
  assert.throws(() => T.buildExecCommand('x', { env: { 'A-B': 'x' } }), ToolError);
  assert.throws(() => T.buildExecCommand('x', { workdir: '-rf' }), /must not start with "-"/);
  assert.throws(() => T.buildExecCommand('x', { workdir: '/a\nb' }), /newlines/);
  assert.equal(T.remotePathExpr('~'), '"$HOME"');
  assert.equal(T.remotePathExpr('/etc/x y'), "'/etc/x y'");
  assert.throws(() => T.checkLocalPath('relative/file', 'local_path'), /must be an absolute path/);
  assert.equal(T.checkLocalPath(path.resolve('/tmp/x'), 'local_path'), path.resolve('/tmp/x'));
  assert.deepEqual(T.envList({ A: '1', B: 'x=y,z' }), ['A=1', 'B=x=y,z']);
  assert.throws(() => T.envList({ 'bad name': '1' }), ToolError);
});

test('read_file decoding: size line + base64; text, binary, and a cut multi-byte character', () => {
  const b64 = Buffer.from('héllo\n').toString('base64');
  assert.deepEqual(T.parseReadOutput('7\n' + b64.slice(0, 4) + '\n' + b64.slice(4) + '\n'), { size: 7, bytes: Buffer.from('héllo\n') });
  assert.deepEqual(T.parseReadOutput('0\n'), { size: 0, bytes: Buffer.alloc(0) });
  assert.throws(() => T.parseReadOutput('oops'), /unexpected output/);
  assert.deepEqual(T.decodeFileBytes(Buffer.from('héllo'), false), { encoding: 'utf-8', content: 'héllo' });
  assert.deepEqual(T.decodeFileBytes(Buffer.from([0x68, 0xc3]), true), { encoding: 'utf-8', content: 'h' }, 'the half character is left out');
  assert.equal(T.decodeFileBytes(Buffer.from([0x68, 0xc3]), false).encoding, 'base64', 'invalid UTF-8 at the real end = binary');
  assert.deepEqual(T.decodeFileBytes(Buffer.from([1, 0, 2]), false), { encoding: 'base64', content: 'AQAC' });
});

test('host port choice: same number from 1024 up, 8000+port below, skipping reserved and busy ports', async () => {
  const free = async () => true;
  assert.equal(await T.pickHostPort(80, new Set(), free), 8080);
  assert.equal(await T.pickHostPort(443, new Set(), free), 8443);
  assert.equal(await T.pickHostPort(3000, new Set(), free), 3000);
  assert.equal(await T.pickHostPort(3000, new Set([3000, 3001]), free), 3002);
  assert.equal(await T.pickHostPort(3000, new Set(), async (p) => p > 3004), 3005);
  assert.equal(await T.pickHostPort(65535, new Set([65535]), free), 20000, 'wraps below the top');
  assert.equal(await T.pickHostPort(5000, new Set(), async () => false, 10), null);
  const reserved = T.reservedPorts({ managerPort: 8777, vms: [{ port: 2223, ports: [{ host: 8080 }] }, { port: 2224, ports: [] }] });
  assert.deepEqual(Array.from(reserved).sort(), [2222, 2223, 2224, 8080, 8777]);
});

test('readiness: ready, needs setup, needs the user, setup already running', () => {
  const pr = (o) => Object.assign({
    qemu: { ok: true, required: true, label: 'QEMU', action: 'install-qemu' },
    ssh: { ok: true, required: true, label: 'OpenSSH', fix: 'Settings > Optional features' },
    base: { ok: true, required: true, label: 'Base' },
  }, o);
  assert.equal(T.readiness({ prereqs: pr() }).ready, true);
  let r = T.readiness({ prereqs: pr({ base: { ok: false, required: true } }) });
  assert.equal(r.ready, false);
  assert.match(r.next_step, /Call setup/);
  r = T.readiness({ prereqs: pr({ ssh: { ok: false, required: true, label: 'OpenSSH', fix: 'Settings > Optional features' } }) });
  assert.deepEqual(r.needs_user, [{ item: 'OpenSSH', fix: 'Settings > Optional features' }]);
  // Windows, no QEMU, no 7-Zip: the user installs 7-Zip, setup does the rest
  r = T.readiness({ prereqs: pr({ qemu: { ok: false, required: true, action: 'install-qemu' }, sevenzip: { ok: false, required: true, label: '7-Zip', fix: 'winget install 7zip.7zip' } }) });
  assert.deepEqual(r.needs_user, [{ item: '7-Zip', fix: 'winget install 7zip.7zip' }]);
  // Linux, no QEMU: no automatic install
  r = T.readiness({ prereqs: pr({ qemu: { ok: false, required: true, label: 'QEMU', fix: 'sudo apt install qemu-system-x86', action: null } }) });
  assert.equal(r.needs_user[0].fix, 'sudo apt install qemu-system-x86');
  r = T.readiness({ prereqs: pr({ base: { ok: false, required: true } }), tasks: { running: [{ id: 'T1', kind: 'setup', title: 'Set up everything' }] } });
  assert.match(r.next_step, /task_id T1/);
});

test('API errors become messages that say what to do next', () => {
  assert.match(T.apiFail(apiErr(409, 'NO_BASE', 'the base image is not built yet')).message, /call setup first/);
  assert.match(T.apiFail(apiErr(409, 'BUSY', 'busy: "Start a"', { holder: { id: 'T9' } })).message, /task_id T9.*get_task/);
  assert.match(T.apiFail(apiErr(501, 'NOT_IMPLEMENTED', 'Snapshots is not implemented yet')).message, /cannot do that yet: Snapshots/);
  assert.match(T.apiFail(apiErr(404, 'NOT_FOUND', 'no VM called "x"')).message, /list_vms/);
  assert.match(T.apiFail(apiErr(401, 'UNAUTHORIZED', 'bad token'), '/data').message, /refused the access token in .*manager-token/);
  const net = new Error('connect ECONNREFUSED 127.0.0.1:8777'); net.code = 'ECONNREFUSED';
  assert.match(T.apiFail(net).message, /stopped answering.*call status/);
  const te = new ToolError('as is');
  assert.equal(T.apiFail(te), te);
});

test('upload/download never touch the manager\'s private files, ~/.ssh, its code or a Startup folder (security-2)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-guard-'));
  try {
    const root = path.join(base, 'data'), app = path.join(base, 'app'), home = path.join(base, 'home');
    for (const d of [path.join(root, 'seed'), path.join(app, 'lib'), path.join(home, '.ssh'), path.join(home, 'proj')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(root, 'manager-token'), 'x');
    const env = { dataRoot: root, appDir: app, home: home, appData: path.join(home, 'AppData', 'Roaming'), programData: null, allow: [] };
    const g = (p, mode, isDir, e) => T.guardLocalPath(p, 'local_path', mode, !!isDir, e || env);
    // copying INTO a VM (read)
    assert.throws(() => g(path.join(root, 'manager-token'), 'read'), /private files/);
    assert.throws(() => g(path.join(root, 'seed', 'id_dev'), 'read'), /private files/);
    assert.throws(() => g(path.join(root, 'vms.json.bak'), 'read'), /private files/);
    assert.throws(() => g(path.join(home, '.ssh', 'id_ed25519'), 'read'), /SSH keys/);
    assert.throws(() => g(base, 'read', true), /contains .*private files/, 'a folder holding them would copy them along');
    assert.equal(g(path.join(home, 'proj'), 'read', true), path.join(home, 'proj'));
    assert.equal(g(path.join(app, 'lib', 'vm.js'), 'read'), path.join(app, 'lib', 'vm.js'), 'reading the (public) code is fine');
    // copying OUT of a VM (write)
    assert.throws(() => g(path.join(root, 'config.json'), 'write'), /private files/);
    assert.throws(() => g(path.join(app, 'lib', 'vm.js'), 'write'), /program folder/);
    assert.throws(() => g(path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.cmd'), 'write'), /Startup/);
    assert.throws(() => g(home, 'write', true), /contains/, 'the guest\'s archive decides the names inside a directory download');
    assert.equal(g(path.join(home, 'proj', 'out.txt'), 'write'), path.join(home, 'proj', 'out.txt'));
    if (process.platform === 'win32') assert.throws(() => g(path.join(root, 'MANAGER-TOKEN'), 'read'), /private files/, 'NTFS ignores case');
    // a symlink / junction into a protected folder is resolved first
    const link = path.join(home, 'proj', 'sneaky');
    let linked = true;
    try { fs.symlinkSync(path.join(root, 'seed'), link, 'junction'); } catch (e) { linked = false; }
    if (linked) assert.throws(() => g(path.join(link, 'id_dev'), 'read'), /private files/);
    // DEVBOX_MCP_FILES narrows every transfer
    const narrow = Object.assign({}, env, { allow: [path.join(home, 'proj')] });
    assert.throws(() => g(path.join(home, 'other.txt'), 'write', false, narrow), /DEVBOX_MCP_FILES/);
    assert.equal(g(path.join(home, 'proj', 'a.txt'), 'write', false, narrow), path.join(home, 'proj', 'a.txt'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('upload / download refuse a protected path before touching the VM', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-guard2-'));
  try {
    fs.writeFileSync(path.join(base, 'manager-token'), 'x');
    const m = fakeManager({ state: { vms: [vmRow('a')] } });
    const tl = toolsFor(m, { localEnv: () => ({ dataRoot: base, appDir: path.join(base, 'app'), home: path.join(base, 'home'), allow: [] }) });
    await assert.rejects(tl.call('upload', { name: 'a', local_path: path.join(base, 'manager-token'), remote_path: '/tmp/x' }), /private files/);
    await assert.rejects(tl.call('download', { name: 'a', remote_path: '/etc/passwd', local_path: path.join(base, 'config.json') }), /private files/);
    assert.equal(m.calls.length, 0, 'the manager was not even asked');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('cleanup picks only Claude\'s VMs: the temporary ones, with ephemeral_only=false all of them - never the user\'s, even temporary ones', () => {
  const vms = [vmRow('a', { ephemeral: true, createdBy: 'claude' }), vmRow('b', { createdBy: 'claude' }), vmRow('c', { createdBy: 'gui' }),
    vmRow('d', { ephemeral: true, createdBy: 'gui' }), vmRow('e', { ephemeral: true, createdBy: 'api' }),
    // a Docker-in-VM VM the manager started for one of Claude's containers
    vmRow('f', { ephemeral: true, createdBy: 'mcp' })];
  assert.deepEqual(T.cleanupCandidates(vms, true).map((v) => v.name), ['a', 'f']);
  assert.deepEqual(T.cleanupCandidates(vms, false).map((v) => v.name), ['a', 'b', 'f']);
  assert.deepEqual(T.CLAUDE_ORIGINS, ['claude', 'mcp']);
});

// ---------------------------------------------------------------------------
// handlers against the fake manager
// ---------------------------------------------------------------------------
test('status: readiness, manager, templates, VMs and running tasks', async () => {
  const m = fakeManager({ started: true, state: { vms: [vmRow('web', { ephemeral: true, createdBy: 'claude', busy: 'T1' })], tasks: { running: [{ id: 'T1', title: 'Start web', vm: 'web', step: 'booting' }], recent: [] } } });
  const s = await toolsFor(m).call('status');
  assert.equal(s.ready, true);
  assert.equal(s.manager.url, 'http://127.0.0.1:8777/');
  assert.equal(s.manager.started_now, true);
  assert.equal(s.mcp_server.pid, process.pid);
  assert.deepEqual(s.templates, [{ name: 'devbox-base', size_mb: 1024, used_by: 0, default: true }]);
  assert.deepEqual(s.vms, [{ name: 'web', status: 'running', ephemeral: true, created_by: 'claude', busy_task: 'T1' }]);
  assert.deepEqual(s.running_tasks, [{ task_id: 'T1', title: 'Start web', vm: 'web', step: 'booting' }]);
  assert.equal(s.limits.max_memory_mb, 12288);
  assert.equal(s.needs_user, undefined);
});

test('create_vm: auto name, temporary, created by claude, waits for SSH', async () => {
  const m = fakeManager({ taskEnd: () => ({ status: 'done', result: { name: 'x', port: 2231, ssh: 'ssh ... -p 2231', accel: 'whpx' } }) });
  m.posts['/api/vm/create'] = (body, mm) => {
    const r = { ok: true, task: { id: 'C1', vm: body.name } };
    mm.tasks.set('C1', { id: 'C1', status: 'done', result: { name: body.name, port: 2231, ssh: 'ssh -p 2231', accel: 'whpx' }, log: [] });
    mm.state.vms.push(vmRow(body.name, { port: 2231, sshCommand: 'ssh -p 2231', ephemeral: true, createdBy: 'claude' }));
    return r;
  };
  const r = await toolsFor(m).call('create_vm', {});
  const post = m.calls.find((c) => c[0] === 'POST');
  assert.equal(post[1], '/api/vm/create');
  assert.match(post[2].name, /^claude-[0-9a-f]{6}$/);
  assert.equal(post[2].ephemeral, true);
  assert.equal(post[2].createdBy, 'claude');
  assert.equal(post[2].start, true);
  assert.equal(post[2].waitS, undefined, 'the manager decides the boot wait (240 s, 600 s under TCG)');
  assert.equal(post[2].template, undefined, 'the manager picks devbox-base');
  assert.equal(r.status, 'done');
  assert.equal(r.name, post[2].name);
  assert.equal(r.ssh_port, 2231);
  assert.equal(r.accel, 'whpx');
  assert.equal(r.docker, false);
});

test('create_vm: not set up -> tells the model to call setup; unknown template and taken names refused', async () => {
  const m = fakeManager({ state: { bases: [], prereqs: { base: { ok: false, required: true, label: 'Base' } } } });
  await assert.rejects(toolsFor(m).call('create_vm', { name: 'a' }), /not set up yet.*Call setup/);
  const m2 = fakeManager({ state: { vms: [vmRow('taken')] } });
  await assert.rejects(toolsFor(m2).call('create_vm', { name: 'taken' }), /already exists/);
  await assert.rejects(toolsFor(m2).call('create_vm', { template: 'nope' }), /no template called "nope" - available: devbox-base/);
  assert.equal(m2.calls.filter((c) => c[0] === 'POST').length, 0, 'nothing was started');
});

test('create_vm: still booting at timeout_s -> {status:"running", task_id}; a failed boot -> the error and log', async () => {
  const m = fakeManager({ taskEnd: () => 'running' });
  const r = await toolsFor(m).call('create_vm', { name: 'slow', timeout_s: 1 });
  assert.equal(r.status, 'running');
  assert.equal(r.task_id, 'task-1');
  assert.match(r.hint, /get_task/);
  // a short timeout_s never shortens the boot itself (found on a real run: a
  // TCG boot on a busy PC needs more than 300 s); a long one extends it
  assert.equal(m.calls.find((c) => c[0] === 'POST')[2].waitS, undefined);
  const mLong = fakeManager({ taskEnd: () => 'running' });
  await toolsFor(mLong).call('create_vm', { name: 'slow2', timeout_s: 900, wait: false });
  assert.equal(mLong.calls.find((c) => c[0] === 'POST')[2].waitS, 900);

  const m2 = fakeManager({ taskEnd: () => ({ status: 'error', error: 'SSH did not come up within 300 s', log: ['[00:00:01] still booting'] }) });
  m2.state.vms = [];
  await assert.rejects(toolsFor(m2).call('create_vm', { name: 'bad' }), (e) => /creating VM "bad" failed: SSH did not come up/.test(e.message) && /still booting/.test(e.message));
});

test('create_vm docker=true: the docker-ready template when present, else Docker installed after boot', async () => {
  const m = fakeManager({ taskEnd: (p) => ({ status: 'done', result: p === '/api/vm/docker/install' ? { version: '27.3.1' } : { port: 2232 } }) });
  m.state.bases.push({ name: 'docker-ready', size: 1, usedBy: 0 });
  let r = await toolsFor(m).call('create_vm', { name: 'd1', docker: true });
  let posts = m.calls.filter((c) => c[0] === 'POST');
  // the docker-ready clone is still checked (found on a real run: the tool
  // said docker: true without knowing whether the daemon answered)
  assert.deepEqual(posts.map((p) => p[1]), ['/api/vm/create', '/api/vm/docker/install']);
  assert.equal(posts[0][2].template, 'docker-ready');
  assert.equal(posts[0][2].mem, 2048);
  assert.equal(r.template, 'docker-ready');
  assert.equal(r.docker, '27.3.1');

  const m2 = fakeManager({ taskEnd: (p) => ({ status: 'done', result: p === '/api/vm/docker/install' ? { version: '27.3.1' } : { port: 2232 } }) });
  r = await toolsFor(m2).call('create_vm', { name: 'd2', docker: true, memory_mb: 3072 });
  posts = m2.calls.filter((c) => c[0] === 'POST');
  assert.deepEqual(posts.map((p) => p[1]), ['/api/vm/create', '/api/vm/docker/install']);
  assert.equal(posts[0][2].mem, 3072);
  assert.deepEqual(posts[1][2], { name: 'd2' });
  assert.equal(r.docker, '27.3.1');
});

test('start_vm: waits for the task; an already running VM returns at once', async () => {
  const m = fakeManager({ taskEnd: () => ({ status: 'done', result: { name: 'a', port: 2240, ssh: 'ssh -p 2240', accel: 'tcg' } }) });
  const r = await toolsFor(m).call('start_vm', { name: 'a' });
  assert.deepEqual(r, { status: 'done', name: 'a', vm_status: 'running', ssh: 'ssh -p 2240', ssh_port: 2240, accel: 'tcg', task_id: 'task-1' });
  const m2 = fakeManager({ state: { vms: [vmRow('a')] } });
  m2.posts['/api/vm/start'] = () => { throw apiErr(409, 'RUNNING', '"a" is already running'); };
  const r2 = await toolsFor(m2).call('start_vm', { name: 'a' });
  assert.equal(r2.already_running, true);
  assert.equal(r2.status, 'done');
});

test('stop, delete, reset, snapshot and setup go through tasks; 501s and 404s read well', async () => {
  const m = fakeManager({ taskEnd: (p) => ({ status: 'done', result: p === '/api/vm/stop' ? { how: 'poweroff' } : {} }) });
  const tl = toolsFor(m);
  assert.equal((await tl.call('stop_vm', { name: 'a', force: 'true' })).how, 'poweroff');
  assert.deepEqual(m.calls.find((c) => c[1] === '/api/vm/stop')[2], { name: 'a', force: true });
  assert.equal((await tl.call('delete_vm', { name: 'a' })).deleted, true);
  m.posts['/api/vm/reset'] = () => { throw apiErr(501, 'NOT_IMPLEMENTED', 'Reset to template is not implemented yet'); };
  await assert.rejects(tl.call('reset_vm', { name: 'a' }), /cannot do that yet/);
  await assert.rejects(tl.call('snapshot', { name: 'a', action: 'create' }), /snapshot \(the snapshot name\) is required/);
  const snap = await tl.call('snapshot', { name: 'a', action: 'create', snapshot: 'before-upgrade' });
  assert.equal(snap.status, 'done');
  assert.deepEqual(m.calls.find((c) => c[1] === '/api/vm/snapshot')[2], { name: 'a', action: 'create', snapshot: 'before-upgrade' });
  m.state.vms = [vmRow('a', { snapshots: [{ name: 's1', date: 'd' }] })];
  // no fresh list from the task: the state's (background) copy
  assert.deepEqual((await tl.call('snapshot', { name: 'a', action: 'list' })).snapshots, [{ name: 's1', date: 'd' }]);
  // the 'list' task's fresh read wins when it has one
  const endBefore = m.taskEnd;
  m.taskEnd = (p, body) => (p === '/api/vm/snapshot' && body.action === 'list'
    ? { status: 'done', result: { snapshots: [{ id: '1', name: 's2', date: 'd2', vmStateBytes: 0 }] } } : endBefore(p, body));
  assert.deepEqual((await tl.call('snapshot', { name: 'a', action: 'list' })).snapshots, [{ name: 's2', date: 'd2' }]);
  m.taskEnd = endBefore;
  // setup: returns at once when ready, runs the task otherwise
  assert.equal((await tl.call('setup')).already_set_up, true);
  m.state.prereqs.base = { ok: false, required: true, label: 'Base' };
  const s = await tl.call('setup', { wait: false });
  assert.equal(s.status, 'running');
  assert.ok(m.calls.some((c) => c[1] === '/api/setup'));
  await assert.rejects(tl.call('get_task', { task_id: 'nope' }), /no task with id nope/);
  const gt = await tl.call('get_task', { task_id: s.task_id, log_lines: 1 });
  assert.equal(gt.task_id, s.task_id);
  assert.equal(gt.log.length, 1);
});

test('exec: needs a running VM; passes the script, caps and timeout to ssh; maps the result', async () => {
  const m = fakeManager({ state: { vms: [vmRow('up'), vmRow('down', { status: 'stopped' }), vmRow('boot', { status: 'booting' })] } });
  let seen = null;
  const tl = toolsFor(m, {
    ssh: {
      sshArgs: sshMod.sshArgs,
      sshExec: async (target, cmd, opts) => { seen = { target, cmd, opts }; return { code: 3, stdout: 'out', stderr: 'err', durationMs: 1234, truncated: false, timedOut: false }; },
    },
  });
  await assert.rejects(tl.call('exec', { name: 'down', command: 'true' }), /is stopped - call start_vm first/);
  await assert.rejects(tl.call('exec', { name: 'boot', command: 'true' }), /still booting/);
  await assert.rejects(tl.call('exec', { name: 'ghost', command: 'true' }), /no VM called "ghost" - existing VMs: up, down, boot/);
  const r = await tl.call('exec', { name: 'up', command: 'make', workdir: '/src', env: { A: 'b' }, stdin: 'in', user: 'dev', timeout_s: 7 });
  assert.deepEqual(r, { exit_code: 3, stdout: 'out', stderr: 'err', duration_s: 1.2, truncated: false, timed_out: false });
  assert.deepEqual(seen.target, { name: 'up', port: 2230 });
  assert.equal(seen.cmd, "cd '/src' || exit 1\nexport A='b'\nmake");
  assert.equal(seen.opts.user, 'dev');
  assert.equal(seen.opts.input, 'in');
  assert.equal(seen.opts.timeoutMs, 7000);
  assert.equal(seen.opts.maxBytes, 100 * 1024);
  assert.equal(seen.opts.headShare, 0.2);

  const tl2 = toolsFor(m, { ssh: { sshArgs: sshMod.sshArgs, sshExec: async () => ({ code: 124, stdout: 'partial', stderr: '', durationMs: 7000, timedOut: true, truncated: false }) } });
  const t = await tl2.call('exec', { name: 'up', command: 'sleep 99', timeout_s: 7 });
  assert.equal(t.exit_code, null);
  assert.equal(t.timed_out, true);
  assert.match(t.note, /did not finish within 7 s/);

  const tl3 = toolsFor(m, { ssh: { sshArgs: sshMod.sshArgs, sshExec: async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host 127.0.0.1 port 2230: Connection refused', durationMs: 20 }) } });
  await assert.rejects(tl3.call('exec', { name: 'up', command: 'true' }), /could not reach VM "up" over SSH \(port 2230\): .*Connection refused/);
  // a command that itself exits 255 with output is a normal result
  const tl4 = toolsFor(m, { ssh: { sshArgs: sshMod.sshArgs, sshExec: async () => ({ code: 255, stdout: 'x', stderr: 'Connection refused by app', durationMs: 20 }) } });
  assert.equal((await tl4.call('exec', { name: 'up', command: 'app' })).exit_code, 255);
});

test('forward_port: this PC only by default, picks a free port, sends ONE change (add) not a stale full list, switches exposure', async () => {
  const deployed = { host: 9000, guest: 9000, container: 80, owner: 'nginx', lan: false };
  const m = fakeManager({ state: { vms: [vmRow('a', { ports: [deployed] }), vmRow('b', { port: 2231, ports: [{ host: 8080, guest: 80, lan: false }] })] } });
  m.posts['/api/vm/ports'] = (body) => ({ ok: true, name: body.name, ports: body.add, applied: 'live', warnings: [], pendingRestart: false });
  const tl = toolsFor(m);
  let r = await tl.call('forward_port', { name: 'a', guest_port: 80 });
  assert.equal(r.host_port, 8081, '8080 belongs to VM b');
  assert.equal(r.url, 'http://127.0.0.1:8081');
  assert.equal(r.lan, false);
  assert.equal(r.reachable_from, 'this PC only');
  assert.equal(r.applied, 'live');
  let body = m.calls.filter((c) => c[1] === '/api/vm/ports').pop()[2];
  // only the new forward: the manager adds it to the VM's CURRENT list under
  // its lock, so a forward added meanwhile (a parallel call) is never lost
  assert.deepEqual(body, { name: 'a', add: [{ host: 8081, guest: 80, lan: false }] });
  assert.equal(body.ports, undefined);

  // same guest port again, same exposure: nothing to do
  m.state.vms[0].ports = [deployed, { host: 8081, guest: 80, lan: false }];
  const before = m.calls.length;
  r = await tl.call('forward_port', { name: 'a', guest_port: 80 });
  assert.equal(r.applied, 'unchanged');
  assert.equal(m.calls.slice(before).filter((c) => c[0] === 'POST').length, 0);

  // switch that forward to the LAN (same host + guest port: replaced)
  r = await tl.call('forward_port', { name: 'a', guest_port: 80, lan: true });
  assert.equal(r.lan, true);
  assert.deepEqual(r.lan_urls, ['http://192.168.1.9:8081', 'http://172.20.0.1:8081'], 'home/office ranges first');
  body = m.calls.filter((c) => c[1] === '/api/vm/ports').pop()[2];
  assert.deepEqual(body, { name: 'a', add: [{ host: 8081, guest: 80, lan: true }] });
  // ...and a deployed row keeps its metadata when its exposure changes
  r = await tl.call('forward_port', { name: 'a', guest_port: 9000, lan: true });
  body = m.calls.filter((c) => c[1] === '/api/vm/ports').pop()[2];
  assert.deepEqual(body.add, [Object.assign({}, deployed, { lan: true })]);

  // a port taken between our check and the manager's: try the next
  let n = 0;
  m.posts['/api/vm/ports'] = (b) => {
    if (n++ === 0) throw apiErr(409, 'PORT_CONFLICT', 'port 5000 is in use by another program');
    return { ok: true, ports: b.add, applied: 'saved', warnings: [] };
  };
  r = await tl.call('forward_port', { name: 'b', guest_port: 5000 });
  assert.equal(r.host_port, 5001);
  assert.equal(r.applied, 'saved');
  assert.match(r.note, /not running/);

  // two forward_port calls at once: the second waits for the first's port
  // change (a moment) instead of failing "busy"; any other task is reported
  let busy = 0;
  m.posts['/api/vm/ports'] = (b) => {
    if (busy++ < 2) throw apiErr(409, 'BUSY', 'busy: "Change port forwards of b" on b is still running', { holder: { id: 'P1', kind: 'ports' } });
    return { ok: true, ports: b.add, applied: 'live', warnings: [] };
  };
  r = await tl.call('forward_port', { name: 'b', guest_port: 6000, host_port: 6000 });
  assert.equal(r.applied, 'live');
  assert.equal(busy, 3);
  m.posts['/api/vm/ports'] = () => { throw apiErr(409, 'BUSY', 'busy: "Start b" on b is still running', { holder: { id: 'S1', kind: 'start' } }); };
  await assert.rejects(tl.call('forward_port', { name: 'b', guest_port: 6001, host_port: 6001 }), /Start b.*task_id S1/);
});

test('deploy_image engine="docker-vm": request body (env map -> list, lan explicit, temporary), URLs in the result', async () => {
  const m = fakeManager({ taskEnd: () => ({ status: 'done', result: { sandbox: 'nginx', name: 'nginx', container: 'nginx', urls: [{ url: 'http://127.0.0.1:8080', lan: false, host: 8080 }], ports: [{ host: 8080, guest: 8080, container: 80, owner: 'nginx', lan: false }] } }) });
  const r = await toolsFor(m).call('deploy_image', { image: ' nginx:alpine ', engine: 'docker-vm', ports: ['8080:80'], env: { A: '1' }, volumes: ['data:/data'] });
  const body = m.calls.find((c) => c[1] === '/api/vm/quickdeploy')[2];
  assert.deepEqual(body, { image: 'nginx:alpine', lan: false, privileged: false, ephemeral: true, createdBy: 'claude', keepOnFailure: false, ports: [{ host: 8080, guest: 80, lan: false }], env: ['A=1'], volumes: ['data:/data'] });
  assert.equal(m.calls.filter((c) => c[1] === '/api/container/run').length, 0, 'docker-vm never tries a microVM');
  assert.equal(r.status, 'done');
  assert.equal(r.engine, 'docker-vm');
  assert.equal(r.fallback_reason, undefined, 'chosen, not fallen back to');
  assert.equal(r.vm, 'nginx');
  assert.deepEqual(r.urls, [{ url: 'http://127.0.0.1:8080', host_port: 8080, lan: false, reachable_from: 'this PC only' }]);
  assert.match(r.next, /docker logs/);
});

test('write_file / read_file: scripts sent over ssh, byte counts checked, text vs base64', async () => {
  const m = fakeManager({ state: { vms: [vmRow('a')] } });
  const sent = [];
  const tl = toolsFor(m, {
    ssh: {
      sshArgs: sshMod.sshArgs,
      sshExec: async (target, cmd, opts) => {
        sent.push({ cmd, opts });
        if (/cat > "\$f"/.test(cmd)) return { code: 0, stdout: String(opts.input.length) + '\n', stderr: '', durationMs: 1 };
        return { code: 0, stdout: '3\n' + Buffer.from([0, 1, 2]).toString('base64') + '\n', stderr: '', durationMs: 1 };
      },
    },
  });
  const w = await tl.call('write_file', { name: 'a', path: '/opt/run.sh', content: 'echo hi\n', mode: '755' });
  assert.deepEqual(w, { name: 'a', path: '/opt/run.sh', bytes: 8, mode: '755' });
  assert.match(sent[0].cmd, /^f='\/opt\/run.sh'\nmkdir -p "\$\(dirname "\$f"\)" && cat > "\$f" && chmod 755 "\$f" && wc -c < "\$f"$/);
  assert.equal(sent[0].opts.input.toString(), 'echo hi\n');
  await tl.call('write_file', { name: 'a', path: '/bin.dat', content: 'AAEC', encoding: 'base64' });
  assert.deepEqual([...sent[1].opts.input], [0, 1, 2]);
  await assert.rejects(tl.call('write_file', { name: 'a', path: '/x', content: 'not base64!', encoding: 'base64' }), /not valid base64/);
  await assert.rejects(tl.call('write_file', { name: 'a', path: '/x', content: '', mode: '999' }), /mode has an invalid format/);
  const rf = await tl.call('read_file', { name: 'a', path: '/bin.dat', max_bytes: 10 });
  assert.deepEqual(rf, { name: 'a', path: '/bin.dat', size: 3, returned_bytes: 3, truncated: false, encoding: 'base64', content: 'AAEC' });
  assert.match(sent[2].cmd, /head -c 10 "\$f" \| base64$/);
});

test('cleanup deletes only what it should and reports failures; dry_run changes nothing', async () => {
  const m = fakeManager({ state: { vms: [vmRow('tmp1', { ephemeral: true, createdBy: 'claude' }), vmRow('mine', { createdBy: 'gui' }),
    vmRow('tmp2', { ephemeral: true, createdBy: 'claude' }), vmRow('guitmp', { ephemeral: true, createdBy: 'gui' })] } });
  m.posts['/api/vm/delete'] = (body, mm) => {
    if (body.name === 'tmp2') throw apiErr(409, 'BUSY', 'busy: "Start tmp2"');
    mm.tasks.set('D-' + body.name, { id: 'D-' + body.name, status: 'done', result: {}, log: [] });
    return { ok: true, task: { id: 'D-' + body.name } };
  };
  const tl = toolsFor(m);
  const dry = await tl.call('cleanup', { dry_run: true });
  assert.deepEqual(dry.would_delete.map((v) => v.name), ['tmp1', 'tmp2']);
  assert.deepEqual(dry.kept, ['mine', 'guitmp'], 'a temporary VM the user made in the GUI is not Claude\'s to delete');
  assert.equal(m.calls.filter((c) => c[0] === 'POST').length, 0);
  const r = await tl.call('cleanup');
  assert.deepEqual(r.deleted, ['tmp1']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, 'tmp2');
  assert.match(r.failed[0].error, /busy/);
  assert.deepEqual(r.kept, ['mine', 'guitmp']);
});

test('restart_server: the reply is complete first; the exit comes ~0.5 s after it was written', async () => {
  let exitCode = null;
  const m = fakeManager();
  const tl = toolsFor(m, { exit: (c) => { exitCode = c; } });
  const after = [];
  const r = await tl.call('restart_server', {}, { afterReply: (fn) => after.push(fn) });
  assert.equal(r.exiting, true);
  assert.equal(r.pid, process.pid);
  assert.equal(after.length, 1, 'nothing scheduled until the reply is written');
  assert.equal(exitCode, null);
  const t0 = Date.now();
  after[0]();
  while (exitCode === null && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 20));
  assert.equal(exitCode, 0);
  assert.ok(Date.now() - t0 >= 450, 'deferred about half a second');
});

test('the manager being unavailable is a readable tool error', async () => {
  const tl = T.createTools({ connect: async () => { throw new Error('the VM manager did not start within 20 s'); } });
  const s = createServer({ name: 'x', version: '1' });
  for (const t of tl) s.addTool(t);
  const r = await s.callTool({ name: 'list_vms', arguments: {} }, {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Error executing tool list_vms: the VM manager is not available: the VM manager did not start within 20 s');
});

// ---------------------------------------------------------------------------
// the file tools for real, with a local sh standing in for the guest
// ---------------------------------------------------------------------------
let SH = null;
for (const c of ['/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe']) { if (fs.existsSync(c)) { SH = c; break; } }

test('exec, write_file, read_file, upload and download end to end over a local sh', { skip: !SH || !T.findLocalTar() ? 'needs a POSIX sh and tar' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-files-'));
  const g = (p) => path.join(dir, 'guest', p).replace(/\\/g, '/');   // "guest" paths
  const h = (p) => path.join(dir, 'host', p);                         // "this PC" paths
  fs.mkdirSync(path.join(dir, 'guest'), { recursive: true });
  try {
    const m = fakeManager({ state: { vms: [vmRow('vm')] } });
    const tl = toolsFor(m, {
      platform: { findTool: () => SH, isPortFree: async () => true, lanAddresses: () => [], installHints: () => ({}) },
      ssh: {
        sshArgs: (target, o) => ['-c', o.cmd],
        sshExec: (target, cmd, o) => sshMod.spawnCapture(SH, ['-c', cmd], o),
        scp: async () => { throw new Error('scp must not be needed when tar exists'); },
      },
    });
    // exec: workdir, env, stdin, exit codes, stderr
    fs.mkdirSync(g('w d'), { recursive: true });
    let r = await tl.call('exec', { name: 'vm', command: 'pwd; echo "$MSG"; cat; echo oops >&2; exit 4', workdir: g('w d'), env: { MSG: "it's \"quoted\" $HOME" }, stdin: 'from stdin' });
    assert.equal(r.exit_code, 4);
    const outLines = r.stdout.trim().split('\n');
    assert.match(outLines[0], /w d$/);
    assert.deepEqual(outLines.slice(1), ['it\'s "quoted" $HOME', 'from stdin']);
    assert.equal(r.stderr.trim(), 'oops');
    // big output: capped with head + tail kept
    r = await tl.call('exec', { name: 'vm', command: 'i=0; while [ $i -lt 3000 ]; do echo "line $i ................................................"; i=$((i+1)); done' });
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length < 110 * 1024);
    assert.match(r.stdout, /^line 0 /);
    assert.match(r.stdout, /bytes omitted/);
    assert.match(r.stdout, /line 2999 \.+\n$/);
    // timeout
    r = await tl.call('exec', { name: 'vm', command: 'sleep 5', timeout_s: 1 });
    assert.equal(r.timed_out, true);

    // write_file + read_file round trip (text, then binary)
    const text = 'héllo wörld\nline 2\n';
    await tl.call('write_file', { name: 'vm', path: g('a/b/c.txt'), content: text });
    assert.equal(fs.readFileSync(g('a/b/c.txt'), 'utf8'), text);
    let rf = await tl.call('read_file', { name: 'vm', path: g('a/b/c.txt') });
    assert.equal(rf.content, text);
    assert.equal(rf.size, Buffer.byteLength(text));
    rf = await tl.call('read_file', { name: 'vm', path: g('a/b/c.txt'), max_bytes: 2 });
    assert.equal(rf.truncated, true);
    assert.equal(rf.content, 'h', 'the half of "é" is not returned');
    const bin = Buffer.from([0, 255, 1, 128, 10, 13]);
    await tl.call('write_file', { name: 'vm', path: g('bin.dat'), content: bin.toString('base64'), encoding: 'base64' });
    rf = await tl.call('read_file', { name: 'vm', path: g('bin.dat') });
    assert.equal(rf.encoding, 'base64');
    assert.deepEqual(Buffer.from(rf.content, 'base64'), bin);
    await assert.rejects(tl.call('read_file', { name: 'vm', path: g('nope') }), /no such file/);
    await assert.rejects(tl.call('read_file', { name: 'vm', path: g('a') }), /is a directory/);

    // upload a file (to a path, and into an existing directory) and a directory
    fs.mkdirSync(h('proj/sub'), { recursive: true });
    fs.writeFileSync(h('proj/readme.md'), '# hi\n');
    fs.writeFileSync(h('proj/sub/data.bin'), bin);
    let u = await tl.call('upload', { name: 'vm', local_path: h('proj/readme.md'), remote_path: g('up/readme-copy.md') });
    assert.equal(u.kind, 'file');
    assert.equal(u.bytes, 5);
    assert.equal(fs.readFileSync(g('up/readme-copy.md'), 'utf8'), '# hi\n');
    u = await tl.call('upload', { name: 'vm', local_path: h('proj/readme.md'), remote_path: g('up') });
    assert.equal(fs.readFileSync(g('up/readme.md'), 'utf8'), '# hi\n', 'into the existing directory');
    u = await tl.call('upload', { name: 'vm', local_path: h('proj'), remote_path: g('proj-copy') });
    assert.equal(u.kind, 'directory');
    assert.equal(fs.readFileSync(g('proj-copy/readme.md'), 'utf8'), '# hi\n');
    assert.deepEqual(fs.readFileSync(g('proj-copy/sub/data.bin')), bin);
    await assert.rejects(tl.call('upload', { name: 'vm', local_path: h('missing'), remote_path: g('x') }), /does not exist/);
    // a guest side that fails ends the transfer at once (no stall on a dead pipe)
    fs.writeFileSync(h('big.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
    const tFail = Date.now();
    await assert.rejects(tl.call('upload', { name: 'vm', local_path: h('big.bin'), remote_path: g('a/b/c.txt/sub/big.bin'), timeout_s: 120 }), /upload to "vm" failed/);
    await assert.rejects(tl.call('upload', { name: 'vm', local_path: h('proj'), remote_path: g('a/b/c.txt/sub'), timeout_s: 120 }), /upload to "vm" failed in the VM/);
    assert.ok(Date.now() - tFail < 60000, 'failed fast, not at the timeout');

    // download a file and a directory
    let d = await tl.call('download', { name: 'vm', remote_path: g('bin.dat'), local_path: h('dl/bin.dat') });
    assert.equal(d.kind, 'file');
    assert.deepEqual(fs.readFileSync(h('dl/bin.dat')), bin);
    assert.equal(fs.existsSync(h('dl/bin.dat.part')), false);
    d = await tl.call('download', { name: 'vm', remote_path: g('a/b/c.txt'), local_path: h('dl') });
    assert.equal(fs.readFileSync(h('dl/c.txt'), 'utf8'), text, 'into the existing directory');
    d = await tl.call('download', { name: 'vm', remote_path: g('proj-copy'), local_path: h('back') });
    assert.equal(d.kind, 'directory');
    assert.equal(fs.readFileSync(h('back/readme.md'), 'utf8'), '# hi\n');
    assert.deepEqual(fs.readFileSync(h('back/sub/data.bin')), bin);
    await assert.rejects(tl.call('download', { name: 'vm', remote_path: g('nothing-here'), local_path: h('x') }), /no such file or directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the screen as text: screen_text, wait_for_text, send_keys wait_for
// ---------------------------------------------------------------------------
// A fake manager whose screen shows `screens` one after another (the last one stays).
function screenManager(screens) {
  let n = 0;
  return fakeManager({
    gets: {
      '/api/vm/screen-text?name=': () => {
        const text = screens[Math.min(n, screens.length - 1)];
        n++;
        return { ok: true, name: 'kodi', text: text, lines: text.split('\n').map((t, i) => ({ text: t, x: 10, y: 20 * i, w: 100, h: 13 })), width: 1280, height: 800, scale: 2, ms: 120 };
      },
    },
    posts: { '/api/vm/keys': (body) => ({ ok: true, name: body.name, sent: String(body.keys).split(/\s+/).length, delayMs: body.delayMs || 150 }) },
  });
}

test('screen_text: the text and each line with its position, read through GET /api/vm/screen-text', async () => {
  const m = screenManager(['QUICK INSTALL MENU\nPlease select a deuice:']);
  const tl = toolsFor(m);
  const r = await tl.call('screen_text', { name: 'kodi', scale: 1 });
  assert.equal(r.text, 'QUICK INSTALL MENU\nPlease select a deuice:');
  assert.deepEqual(r.lines[1], { text: 'Please select a deuice:', x: 10, y: 20, w: 100, h: 13 });
  assert.equal(r.screen, '1280x800');
  assert.deepEqual(m.calls.find((c) => c[0] === 'GET' && /screen-text/.test(c[1])), ['GET', '/api/vm/screen-text?name=kodi&scale=1']);
});

test('wait_for_text: polls until a phrase shows (OCR slips tolerated, any of several), or answers found=false at the timeout', async () => {
  const m = screenManager(['LibreELEC (official): 12.2.1', 'Installing...', 'LibreELEC Install Complete\nYou may now remoue the install media and reboot .']);
  const tl = toolsFor(m);
  const r = await tl.call('wait_for_text', { name: 'kodi', text: 'No devices were found | remove the install media', timeout_s: 10, interval_ms: 100 });
  assert.equal(r.found, true);
  assert.equal(r.phrase, 'remove the install media');
  assert.equal(r.matched, 'remoue the install media');
  assert.equal(r.reads, 3);
  assert.match(r.text, /Install Complete/);
  // never there: found=false with the last screen, no error
  const m2 = screenManager(['Display output is not active.']);
  const t0 = Date.now();
  const r2 = await toolsFor(m2).call('wait_for_text', { name: 'kodi', text: 'Kodi', timeout_s: 1, interval_ms: 100 });
  assert.equal(r2.found, false);
  assert.equal(r2.text, 'Display output is not active.');
  assert.ok(r2.reads >= 2 && Date.now() - t0 < 3000, 'stops at the timeout');
  assert.match(r2.hint, /did not|none of/);
  await assert.rejects(toolsFor(m2).call('wait_for_text', { name: 'kodi', text: ' | ' }), /give a phrase/);
});

test('send_keys wait_for: the keys go first, then the screen is read until the next dialog shows', async () => {
  const m = screenManager(['MAIN MENU\n1 Install LibreELEC', 'QUICK INSTALL MENU\nPlease select a deuice:']);
  const tl = toolsFor(m);
  const r = await tl.call('send_keys', { name: 'kodi', keys: 'ret', delay_ms: 400, wait_for: 'select a device | No devices were found', wait_timeout_s: 10 });
  assert.equal(r.sent, 1);
  assert.equal(r.found, true);
  assert.equal(r.phrase, 'select a device');
  const order = m.calls.filter((c) => /keys|screen-text/.test(c[1])).map((c) => c[0] + ' ' + c[1].split('?')[0]);
  assert.equal(order[0], 'POST /api/vm/keys', 'keys before the first read');
  assert.deepEqual(m.calls.find((c) => c[1] === '/api/vm/keys')[2], { name: 'kodi', keys: 'ret', delayMs: 400 });
  // without wait_for: just the keys
  const m3 = screenManager(['x']);
  const r3 = await toolsFor(m3).call('send_keys', { name: 'kodi', keys: 'up up' });
  assert.equal(r3.sent, 2);
  assert.equal(r3.found, undefined);
  assert.ok(!m3.calls.some((c) => /screen-text/.test(c[1])), 'no screen reads without wait_for');
});
