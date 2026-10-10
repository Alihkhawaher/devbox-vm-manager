'use strict';
/*
 * mcp-server.js end to end, spawned exactly as an MCP host does (stdio
 * pipes) with a temporary data root and a free port:
 *   initialize -> the negotiated version and serverInfo
 *   notifications/initialized -> no reply
 *   tools/list -> the 37 tools (VMs, shared folders, microVM containers)
 *   tools/call status -> starts a REAL headless manager for that data root on
 *                        that port (VM_MANAGER_PORT), and reports on it
 *   stdout carries nothing but JSON-RPC; closing stdin ends the server
 * The manager it started is stopped at the end (after its start-up
 * acceleration probe has finished, so no probe QEMU is orphaned on Windows).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { rm } = require('./helpers');
const client = require('../lib/client');
const { version } = require('../lib/config');

const SERVER = path.resolve(__dirname, '..', 'mcp-server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Stop a manager this test started: wait for its acceleration probe to end
// (a hard kill during the probe would orphan a paused QEMU on Windows), then
// terminate it and wait for the process to go away.
async function stopManager(root) {
  const info = client.readManagerInfo(root);
  if (!info || !info.pid) return;
  const started = Date.parse(info.startedAt || '') || Date.now();
  try {
    const c = await client.connect({ root: root, start: false });
    for (let i = 0; i < 60; i++) {
      const s = await c.get('/api/state');
      if (!(s.platform && s.platform.accel && s.platform.accel.detecting)) break;
      await sleep(250);
    }
  } catch (e) { /* not answering: just stop it */ }
  const wait = 3500 - (Date.now() - started);
  if (wait > 0) await sleep(wait);
  try { process.kill(info.pid); } catch (e) { /* already gone */ }
  for (let i = 0; i < 40 && pidAlive(info.pid); i++) await sleep(100);
}

test('requiring mcp-server.js and lib/mcp/* does nothing: no output, stdout untouched, nothing written', () => {
  const { spawnSync } = require('child_process');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-noside-'));
  try {
    const files = ['mcp-server.js', 'lib/mcp/protocol.js', 'lib/mcp/tools.js', 'lib/client.js', 'tools/mcp-probe.js', 'lib/mcp/containers.js', 'lib/mcp/shares.js'].map((f) => path.resolve(__dirname, '..', f));
    const code = 'const w = process.stdout.write;' + files.map((f) => 'require(' + JSON.stringify(f) + ');').join('') +
      'if (process.stdout.write !== w) throw new Error("stdout was taken over");' +
      'if (typeof require(' + JSON.stringify(files[0]) + ').main !== "function") throw new Error("no main export");' +
      'require(' + JSON.stringify(files[2]) + ').createTools();';
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: os.tmpdir(), timeout: 15000, encoding: 'utf8', windowsHide: true,
      env: Object.assign({}, process.env, { VM_MANAGER_ROOT: scratch }),
    });
    assert.equal(r.error, undefined, 'exited by itself (nothing listening or reading stdin)');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.deepEqual(fs.readdirSync(scratch), [], 'nothing was written to the data root');
  } finally { rm(scratch); }
});

test('mcp-probe --expect: names the tools a server must list', () => {
  const probe = require('../tools/mcp-probe');
  const o = probe.parseCli(['mcp-server.js', 'status', '--expect', 'run_image, share_folder,,list_shares']);
  assert.deepEqual(o.expect, ['run_image', 'share_folder', 'list_shares']);
  assert.equal(o.tool, 'status');
  assert.deepEqual(probe.missingTools([{ name: 'run_image' }, { name: 'status' }], ['run_image', 'share_folder']), ['share_folder']);
  assert.deepEqual(probe.missingTools([{ name: 'a' }], []), []);
});

test('mcp-probe parameters: run_image / deploy_image must offer rootfs disk|ram; --expect-params names more', () => {
  const probe = require('../tools/mcp-probe');
  const tool = (name, props) => ({ name: name, inputSchema: { type: 'object', properties: props } });
  const rootfs = { type: 'string', enum: ['disk', 'ram'], description: 'x' };
  // the real tools pass
  const T = require('../lib/mcp/tools');
  const { createServer } = require('../lib/mcp/protocol');
  const s = createServer({ name: 'devbox-vms', version: '2.0.0' });
  for (const t of T.createTools({ connect: async () => { throw new Error('unused'); } })) s.addTool(t);
  assert.deepEqual(probe.missingParams(s.listTools(), []), []);
  // an old server: run_image without rootfs fails; tools that are not listed are not required
  assert.deepEqual(probe.missingParams([tool('run_image', { image: { type: 'string' } })], []), ['run_image.rootfs (not a parameter)']);
  assert.deepEqual(probe.missingParams([tool('status', {})], []), []);
  assert.deepEqual(probe.missingParams([tool('run_image', { rootfs: { type: 'string', enum: ['disk'] } })], []), ['run_image.rootfs (enum lacks disk/ram)']);
  assert.deepEqual(probe.missingParams([tool('run_image', { rootfs: rootfs })], []), []);
  const o = probe.parseCli(['mcp-server.js', '--expect-params', 'run_image.rootfs, status.verbose']);
  assert.deepEqual(o.expectParams, [{ tool: 'run_image', param: 'rootfs' }, { tool: 'status', param: 'verbose' }]);
  assert.deepEqual(probe.missingParams([tool('run_image', { rootfs: rootfs }), tool('status', {})], o.expectParams), ['status.verbose (not a parameter)']);
  assert.deepEqual(probe.missingParams([], [{ tool: 'x', param: 'y' }]), ['x.y (no tool x)']);
});

test('mcp-server.js --help and bad arguments: usage on stderr, stdout stays empty', () => {
  const { spawnSync } = require('child_process');
  const help = spawnSync(process.execPath, [SERVER, '--help'], { encoding: 'utf8', timeout: 15000, windowsHide: true, input: '' });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, '');
  assert.match(help.stderr, /Usage: node mcp-server\.js/);
  const bad = spawnSync(process.execPath, [SERVER, '--data'], { encoding: 'utf8', timeout: 15000, windowsHide: true, input: '' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /--data needs a folder path/);
  const parse = require(SERVER).parseArgs;
  assert.deepEqual(parse(['--data', '/x']), { data: '/x', help: false });
  assert.deepEqual(parse(['--data=/y']), { data: '/y', help: false });
});

test('mcp-server.js: handshake, tools, and a status call that starts a manager', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-it-'));
  const port = await freePort();
  const env = Object.assign({}, process.env, { VM_MANAGER_ROOT: root, VM_MANAGER_PORT: String(port) });
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: env, windowsHide: true });
  const lines = [];
  let stderr = '';
  let buf = '';
  let exit = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = { code: code }; });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const reply = async (id, ms) => {
    const end = Date.now() + (ms || 15000);
    while (Date.now() < end) {
      for (const l of lines) { try { const j = JSON.parse(l); if (j.id === id) return j; } catch (e) { /* checked below */ } }
      if (exit) break;
      await sleep(20);
    }
    return null;
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const init = await reply(1);
    assert.ok(init, 'initialize answered; stderr: ' + stderr);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.serverInfo, { name: 'devbox-vms', version: version() });
    assert.match(init.result.instructions, /create_vm/);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tl = await reply(2);
    assert.equal(tl.result.tools.length, 37);
    for (const n of ['create_vm', 'run_image', 'stop_image', 'image_logs', 'list_containers', 'list_images', 'share_folder', 'unshare_folder', 'list_shares']) {
      assert.ok(tl.result.tools.some((t) => t.name === n), n + ' is listed');
    }
    assert.match(init.result.instructions, /run_image/);

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
    const st = await reply(3, 45000);
    assert.ok(st, 'status answered; stderr: ' + stderr);
    assert.equal(st.result.isError, false, st.result.content[0].text);
    const s = JSON.parse(st.result.content[0].text);
    assert.equal(s.manager.url, 'http://127.0.0.1:' + port + '/');
    assert.equal(s.manager.started_now, true);
    assert.equal(path.resolve(s.manager.data_root), path.resolve(root));
    assert.equal(s.ready, false, 'an empty data root has no base image');
    assert.ok(s.prereqs.some((p) => p.name === 'base' && p.ok === false));
    assert.equal(s.mcp_server.pid, child.pid);
    // the real manager's /api/state carries the microVM readiness
    assert.equal(s.ready_for_images, false, 'an empty data root has no microVM kernel');
    assert.match(s.next_step_for_images, /setup\(images_only=true\)|install/);
    assert.equal(s.microvm.ready, false);
    assert.deepEqual(s.containers, []);

    // the manager really runs for that data root, headless
    const info = client.readManagerInfo(root);
    assert.equal(info.port, port);
    assert.ok(fs.existsSync(path.join(root, 'logs', 'manager-console.log')));
    const m = await client.findManager(root);
    assert.equal(m.port, port);

    // a second call reuses it
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_vms', arguments: {} } });
    const lv = await reply(4);
    assert.deepEqual(JSON.parse(lv.result.content[0].text), { count: 0, vms: [] });

    assert.equal(lines.filter((l) => { try { const j = JSON.parse(l); return !j.id; } catch (e) { return true; } }).length, 0,
      'stdout carried only replies (no notification answers, no stray output): ' + JSON.stringify(lines.slice(0, 5)));

    child.stdin.end();
    for (let i = 0; i < 100 && !exit; i++) await sleep(50);
    assert.deepEqual(exit, { code: 0 }, 'exits by itself when stdin closes');
  } finally {
    if (!exit) { try { child.kill(); } catch (e) { /* gone */ } }
    await stopManager(root);
    await sleep(200);
    rm(root);
  }
});
