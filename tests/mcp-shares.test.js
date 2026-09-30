'use strict';
/*
 * lib/mcp/shares.js (SPEC-shares.md section 7): share_folder, unshare_folder
 * and list_shares against a FAKE manager speaking the shares API of
 * lib/shares-routes.js (POST /api/vm/shares, GET /api/shares?owner=), plus
 * the pure helpers. What matters most: a folder of this PC is guarded
 * BEFORE the manager is asked (a live share is a two-way door into this
 * PC), the model is told the caveats, and nothing ever carries a secret.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./helpers'); // points CFG at a scratch root before lib/ is used
const { ToolError, createServer } = require('../lib/mcp/protocol');
const T = require('../lib/mcp/tools');
const S = require('../lib/mcp/shares');

function apiErr(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.body = { ok: false, error: message, code: code };
  return e;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// vms: [{name, status, shares: [public shares]}]; live: owner -> live
// fields per guestPath. Replies have the shapes of lib/shares.js:
//   GET /api/shares?owner= -> {owner, name, kind, running, port, problem,
//     shares: [{id, hostPath, guestPath, readOnly, status (a word), mounted,
//     connections, openFiles, bytesRead, bytesWritten, lastClose}], caveat}
//   POST /api/vm/shares add -> {name, share, applied, mounted, pending,
//     warnings, shares, caveat}; remove -> {name, removed, applied,
//     unmounted, warnings, shares}; a missing share -> 404
// The manager side keeps secrets to itself.
function fakeManager(opts) {
  opts = opts || {};
  const m = {
    calls: [],
    vms: opts.vms || [{ name: 'dev', status: 'running', port: 2230, shares: [] }],
    containers: opts.containers || [],
    live: opts.live || {},
    problem: opts.problem || null,
    applied: opts.applied || null,
    posts: {}, gets: {},
  };
  const vm = (n) => m.vms.find((v) => v.name === n);
  m.client = {
    url: 'http://127.0.0.1:8777/', root: '/data', port: 8777, version: '2.0.0', started: false,
    get: async (p) => {
      m.calls.push(['GET', p]);
      const u = new URL('http://x' + p);
      if (m.gets[u.pathname]) return m.gets[u.pathname](u.searchParams, m);
      if (u.pathname === '/api/state') return { version: '2.0.0', prereqs: {}, bases: [], vms: clone(m.vms), tasks: { running: [], recent: [] } };
      if (u.pathname === '/api/shares') {
        const owner = u.searchParams.get('owner');
        const v = vm(owner);
        const c = m.containers.find((x) => x.id === owner || x.name === owner);
        if (!v && !c) throw apiErr(404, 'NOT_FOUND', 'no VM or container called "' + owner + '"');
        const running = v ? v.status === 'running' : true;
        const id = v ? v.name : c.id;
        const list = v ? v.shares : c.shares;
        return {
          ok: true, owner: id, name: v ? v.name : c.name, kind: v ? 'vm' : 'container', running: running, port: 5640, problem: m.problem,
          shares: list.map((s) => {
            const L = (m.live[id] || {})[s.guestPath] || null;
            const word = !running ? 'stopped' : (L && L.mounted ? 'mounted' : 'not-mounted');
            return Object.assign({ id: s.id, hostPath: s.hostPath, guestPath: s.guestPath, readOnly: !!s.readOnly, status: word, mounted: word === 'mounted' }, L || {});
          }),
          caveat: S.CAVEAT,
        };
      }
      if (u.pathname === '/api/container') {
        const ref = u.searchParams.get('id');
        const c = m.containers.find((x) => x.id === ref || x.name === ref);
        if (!c) throw apiErr(404, 'NO_SUCH_CONTAINER', 'no container "' + ref + '"');
        return { ok: true, container: clone(c) };
      }
      throw apiErr(404, 'NOT_FOUND', 'no route ' + p);
    },
    post: async (p, body, timeoutMs) => {
      m.calls.push(['POST', p, body, timeoutMs]);
      if (m.posts[p]) return m.posts[p](body, m);
      if (p === '/api/vm/shares') {
        const v = vm(body.name);
        if (!v) throw apiErr(404, 'NOT_FOUND', 'no VM called "' + body.name + '"');
        const applied = m.applied || (v.status === 'running' ? 'live' : 'next-start');
        if (body.action === 'add') {
          const sh = { id: v.name + '-' + (v.shares.length + 1), hostPath: body.hostPath, guestPath: body.guestPath, readOnly: !!body.readOnly };
          v.shares.push(sh);
          if (v.status === 'running') {
            m.live[v.name] = m.live[v.name] || {};
            m.live[v.name][body.guestPath] = { mounted: true, connections: 1, openFiles: 0, bytesRead: 2097152, bytesWritten: 0, lastClose: null };
          }
          return { ok: true, name: v.name, share: clone(sh), applied: applied, mounted: v.status === 'running', pending: false, warnings: [], shares: clone(v.shares), caveat: S.CAVEAT };
        }
        const had = v.shares.find((s) => s.guestPath === body.guestPath);
        if (!had) throw apiErr(404, 'NOT_FOUND', '"' + v.name + '" has no shared folder at ' + body.guestPath);
        v.shares = v.shares.filter((s) => s !== had);
        return { ok: true, name: v.name, removed: clone(had), applied: applied, unmounted: v.status === 'running', warnings: [], shares: clone(v.shares) };
      }
      throw apiErr(404, 'NOT_FOUND', 'no route ' + p);
    },
  };
  return m;
}

function toolsFor(m, localEnv) {
  const list = T.createTools({
    connect: async () => m.client,
    waitForTask: require('../lib/client').waitForTask,
    pollMs: 5, exit: () => {}, version: '2.0.0', dataRoot: () => '/data',
    platform: { findTool: () => 'ssh', isPortFree: async () => true, lanAddresses: () => [], installHints: () => ({}) },
    localEnv: localEnv || (() => ({ dataRoot: path.join(os.tmpdir(), 'devbox-mcp-nodata'), appDir: path.join(os.tmpdir(), 'devbox-mcp-noapp'), home: path.join(os.tmpdir(), 'devbox-mcp-nohome'), allow: [] })),
  });
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

// ---------------------------------------------------------------------------
test('the caveat text of SPEC-shares section 8 is used as written, in the tool descriptions and the instructions', () => {
  assert.match(S.CAVEAT, /^Edits you make on Windows appear in the VM within a few tens of milliseconds/);
  assert.match(S.CAVEAT, /CHOKIDAR_USEPOLLING=1, WATCHPACK_POLLING=true, vite server\.watch\.usePolling/);
  assert.match(S.CAVEAT, /chmod \+x are not stored/);
  assert.match(S.CAVEAT, /symlinks must stay inside the shared folder\.$/);
  const s = createServer({ name: 'x', version: '1' });
  for (const t of T.createTools({ connect: async () => { throw new Error('unused'); } })) s.addTool(t);
  const d = (n) => s.listTools().find((t) => t.name === n).description;
  assert.ok(d('share_folder').indexOf(S.CAVEAT) !== -1);
  assert.match(d('run_image'), /file-watch/);
  assert.match(d('run_image'), /chmod \+x is not stored/);
  assert.ok(T.INSTRUCTIONS.indexOf(S.CAVEAT) !== -1);
  const schema = s.listTools().find((t) => t.name === 'share_folder').inputSchema;
  assert.deepEqual(schema.required, ['vm', 'host_path', 'guest_path']);
  assert.equal(schema.properties.read_only.default, false);
});

test('guest paths: absolute Linux paths only; same-folder comparison ignores case and slashes on Windows', () => {
  assert.equal(S.checkGuestPath('/root/project/'), '/root/project');
  assert.throws(() => S.checkGuestPath('project'), /absolute path inside the VM/);
  assert.throws(() => S.checkGuestPath('/'), /cannot be \//);
  assert.throws(() => S.checkGuestPath('/a\nb'), /newlines/);
  assert.throws(() => S.checkGuestPath('C:\\x'), /absolute path inside the VM/);
  assert.throws(() => S.checkGuestPath('/a\\b'), /use \/ not \\/);
  assert.equal(S.samePath('C:\\Users\\Me\\P\\', 'c:/users/me/p', 'win32'), true);
  assert.equal(S.samePath('/home/Me/p', '/home/me/p', 'linux'), false);
});

test('share status summaries: flat or nested live status, last disconnect reason, never a secret', () => {
  const s = S.summarizeShare({ id: 'dev-1', hostPath: 'C:\\p', guestPath: '/p', readOnly: true, secret: 'nope', status: { mounted: true, connections: 1, openFiles: 3, bytesRead: 1048576, bytesWritten: 0, recentCloses: [{ reason: 'guest rebooted' }] } });
  assert.deepEqual(s, { host_path: 'C:\\p', guest_path: '/p', read_only: true, mounted: true, connections: 1, open_files: 3, read_mb: 1, written_mb: 0, last_disconnect: 'guest rebooted' });
  // the shape GET /api/shares really has: flat live fields + a status word
  const flat = S.summarizeShare({ id: 'dev-2', hostPath: 'C:\\p', guestPath: '/p', readOnly: false, status: 'not-mounted', mounted: false, connections: 0, openFiles: 0, bytesRead: 0, bytesWritten: 0, lastClose: { reason: 'the guest rebooted', at: 'x' } });
  assert.deepEqual(flat, { host_path: 'C:\\p', guest_path: '/p', read_only: false, state: 'not-mounted', mounted: false, connections: 0, open_files: 0, read_mb: 0, written_mb: 0, last_disconnect: 'the guest rebooted' });
});

test('share_folder: guarded BEFORE the manager is asked (keys, data folder, a folder holding them, files, relative paths)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-share-'));
  try {
    const dataRoot = path.join(base, 'data'), home = path.join(base, 'home'), app = path.join(base, 'app');
    for (const d of [path.join(dataRoot, 'seed'), path.join(home, '.ssh'), path.join(home, 'proj'), app]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, 'proj', 'a.txt'), 'x');
    const env = () => ({ dataRoot: dataRoot, appDir: app, home: home, allow: [] });
    const m = fakeManager();
    const tl = toolsFor(m, env);
    const share = (host, extra) => tl.call('share_folder', Object.assign({ vm: 'dev', host_path: host, guest_path: '/mnt/x' }, extra || {}));
    await assert.rejects(share(path.join(home, '.ssh')), /SSH keys/);
    await assert.rejects(share(path.join(home, '.ssh'), { read_only: true }), /SSH keys/, 'read-only does not make keys shareable');
    await assert.rejects(share(dataRoot), /private files|contains/);
    await assert.rejects(share(home), /contains .*SSH keys/);
    await assert.rejects(share(app), /program folder/, 'a writable share of the manager\'s code would let the guest change it');
    await assert.rejects(share(path.join(home, 'proj', 'a.txt')), /is a file, not a folder/);
    await assert.rejects(share('proj'), /must be an absolute path/);
    await assert.rejects(share(path.join(home, 'nope')), /does not exist/);
    await assert.rejects(tl.call('share_folder', { vm: 'dev', host_path: path.join(home, 'proj'), guest_path: 'rel' }), /absolute path inside the VM/);
    assert.equal(m.calls.length, 0, 'the manager was not even asked');
    // the program folder may be shared read-only (it is public code), like upload may read it
    await share(app, { read_only: true, guest_path: '/opt/app' });
    assert.equal(m.calls.filter((c) => c[0] === 'POST').length, 1);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('share_folder: a running VM mounts it live and reports the mount; the same share again is "unchanged"; a clash explains itself', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-share2-'));
  try {
    const m = fakeManager();
    const tl = toolsFor(m);
    const r = await tl.call('share_folder', { vm: 'dev', host_path: dir, guest_path: '/root/project/' });
    const post = m.calls.find((c) => c[0] === 'POST');
    assert.deepEqual(post[2], { name: 'dev', action: 'add', hostPath: path.resolve(dir), guestPath: '/root/project', readOnly: false });
    assert.ok(post[3] >= 120000, 'room for a first-time guest service install over SSH');
    assert.equal(r.status, 'done');
    assert.equal(r.applied, 'live');
    assert.equal(r.mounted, true);
    assert.equal(r.connections, 1);
    assert.equal(r.read_mb, 2);
    assert.equal(r.note, S.CAVEAT);
    assert.match(r.next, /exec\(name="dev", command="ls \/root\/project"\)/);
    assert.ok(!JSON.stringify(r).includes('secret'));
    const again = await tl.call('share_folder', { vm: 'dev', host_path: dir, guest_path: '/root/project' });
    assert.equal(again.applied, 'unchanged');
    assert.equal(m.calls.filter((c) => c[0] === 'POST').length, 1, 'nothing re-sent');
    await assert.rejects(tl.call('share_folder', { vm: 'dev', host_path: dir, guest_path: '/root/project', read_only: true }), /already shows .*unshare_folder\(vm="dev", guest_path="\/root\/project"\) first/);
    await assert.rejects(tl.call('share_folder', { vm: 'ghost', host_path: dir, guest_path: '/x' }), /no VM called "ghost"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('share_folder on a stopped VM: saved for its next start, and said so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-mcp-share3-'));
  try {
    const m = fakeManager({ vms: [{ name: 'off', status: 'stopped', shares: [] }] });
    const r = await toolsFor(m).call('share_folder', { vm: 'off', host_path: dir, guest_path: '/srv', read_only: true });
    assert.equal(r.applied, 'next-start');
    assert.equal(r.read_only, true);
    assert.match(r.when, /mounted when it starts/);
    // a 501 from an older manager reads well
    const m2 = fakeManager();
    m2.posts['/api/vm/shares'] = () => { throw apiErr(501, 'NOT_IMPLEMENTED', 'changing shared folders is not implemented yet'); };
    await assert.rejects(toolsFor(m2).call('share_folder', { vm: 'dev', host_path: dir, guest_path: '/srv' }), /cannot do that yet: changing shared folders/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unshare_folder removes it (idempotent: a missing share is removed:false with the list); list_shares for a VM or a container', async () => {
  const m = fakeManager({
    vms: [{ name: 'dev', status: 'running', shares: [{ id: 'dev-1', hostPath: 'C:\\p', guestPath: '/p', readOnly: false }] }],
    containers: [{ id: 'abcabcabcabc', name: 'web', shares: [{ id: 'abcabcabcabc-1', hostPath: 'C:\\site', guestPath: '/usr/share/nginx/html', readOnly: true }] }],
    live: { dev: { '/p': { mounted: true, connections: 2, lastClose: { reason: 'boot-id takeover', at: 'x' } } } },
    problem: 'could not reach "dev" over SSH to mount its shared folders',
  });
  const tl = toolsFor(m);
  let l = await tl.call('list_shares', { vm: 'dev' });
  assert.equal(l.count, 1);
  assert.deepEqual(l.shared_folders[0], { host_path: 'C:\\p', guest_path: '/p', read_only: false, state: 'mounted', mounted: true, connections: 2, last_disconnect: 'boot-id takeover' });
  assert.equal(l.caveat, S.CAVEAT);
  assert.match(l.problem, /could not reach "dev" over SSH/, 'the owner-level problem reaches the model');
  l = await tl.call('list_shares', { container: 'web' });
  assert.ok(m.calls.some((c) => c[1] === '/api/shares?owner=abcabcabcabc'), 'a container name is resolved to its id');
  assert.equal(l.shared_folders[0].guest_path, '/usr/share/nginx/html');
  assert.equal(l.shared_folders[0].state, 'not-mounted');
  // an engine that cannot resolve containers yet (501): the manager's
  // /api/shares takes the name itself
  const m2 = fakeManager({ containers: [{ id: 'abcabcabcabc', name: 'web', shares: [] }] });
  m2.gets['/api/container'] = () => { throw apiErr(501, 'NOT_IMPLEMENTED', 'container details is not implemented yet'); };
  assert.equal((await toolsFor(m2).call('list_shares', { container: 'web' })).count, 0);
  assert.ok(m2.calls.some((c) => c[1] === '/api/shares?owner=web'));
  await assert.rejects(tl.call('list_shares', {}), /exactly one of vm and container/);
  await assert.rejects(tl.call('list_shares', { vm: 'dev', container: 'web' }), /exactly one/);
  await assert.rejects(tl.call('list_shares', { container: 'ghost' }), /no container "ghost"/);

  const u = await tl.call('unshare_folder', { vm: 'dev', guest_path: '/p' });
  assert.equal(u.removed, true);
  assert.equal(u.applied, 'live');
  assert.match(u.note, /unmounted in the running VM; the files on this PC are untouched/);
  assert.deepEqual(m.calls.filter((c) => c[0] === 'POST').pop()[2], { name: 'dev', action: 'remove', guestPath: '/p' });
  const again = await tl.call('unshare_folder', { vm: 'dev', guest_path: '/p' });
  assert.equal(again.removed, false);
  assert.deepEqual(again.shared_folders, []);
  // removed by someone else between the state read and the POST: still fine
  m.vms[0].shares = [{ id: 'dev-9', hostPath: 'C:\\z', guestPath: '/gone', readOnly: false }];
  m.posts['/api/vm/shares'] = () => { throw apiErr(404, 'NOT_FOUND', '"dev" has no shared folder at /gone'); };
  assert.equal((await tl.call('unshare_folder', { vm: 'dev', guest_path: '/gone' })).removed, false);
  delete m.posts['/api/vm/shares'];
  // an older manager without live status: the VM's settings
  m.gets['/api/shares'] = () => { throw apiErr(501, 'NOT_IMPLEMENTED', 'listing shared folders is not implemented yet'); };
  m.vms[0].shares = [{ id: 'dev-2', hostPath: 'C:\\q', guestPath: '/q', readOnly: true }];
  l = await tl.call('list_shares', { vm: 'dev' });
  assert.equal(l.shared_folders[0].guest_path, '/q');
  assert.match(l.note, /settings only/);
});

test('list_vms shows each VM\'s shared folders (public fields only)', async () => {
  const m = fakeManager({ vms: [{ name: 'dev', status: 'running', port: 2230, shares: [{ id: 'dev-1', hostPath: 'C:\\p', guestPath: '/p', readOnly: true }] }] });
  const r = await toolsFor(m).call('list_vms');
  assert.deepEqual(r.vms[0].shared_folders, [{ host_path: 'C:\\p', guest_path: '/p', read_only: true }]);
});
