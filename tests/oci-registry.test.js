'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const reg = require('../lib/oci/registry');
const cpio = require('../lib/oci/cpio');
const fx = require('./oci-fixtures');
const { MockRegistry } = require('./oci-mock-registry');

const { parseImageRef, parseWwwAuthenticate, parseRateLimit, selectPlatform, pullImage, loadImage, RegistryError } = reg;

// ---------------------------------------------------------------- pure functions

test('parseImageRef follows Docker CLI rules', () => {
  const H = 'sha256:' + 'a'.repeat(64);
  const cases = [
    ['alpine', 'docker.io', 'library/alpine', 'latest', null, 'registry-1.docker.io', 'https', 'alpine:latest'],
    ['nginx:alpine', 'docker.io', 'library/nginx', 'alpine', null, 'registry-1.docker.io', 'https', 'nginx:alpine'],
    ['nginxinc/nginx-unprivileged:alpine', 'docker.io', 'nginxinc/nginx-unprivileged', 'alpine', null, 'registry-1.docker.io', 'https', 'nginxinc/nginx-unprivileged:alpine'],
    ['docker.io/library/busybox', 'docker.io', 'library/busybox', 'latest', null, 'registry-1.docker.io', 'https', 'busybox:latest'],
    ['index.docker.io/python:3-alpine', 'docker.io', 'library/python', '3-alpine', null, 'registry-1.docker.io', 'https', 'python:3-alpine'],
    ['ghcr.io/owner/repo/sub:v1.2', 'ghcr.io', 'owner/repo/sub', 'v1.2', null, 'ghcr.io', 'https', 'ghcr.io/owner/repo/sub:v1.2'],
    [`quay.io/org/img@${H}`, 'quay.io', 'org/img', null, H, 'quay.io', 'https', `quay.io/org/img@${H}`],
    [`hello-world:linux@${H}`, 'docker.io', 'library/hello-world', 'linux', H, 'registry-1.docker.io', 'https', `hello-world:linux@${H}`],
    ['localhost:5000/team/app', 'localhost:5000', 'team/app', 'latest', null, 'localhost:5000', 'http', 'localhost:5000/team/app:latest'],
    ['localhost/app:1', 'localhost', 'app', '1', null, 'localhost', 'http', 'localhost/app:1'],
    ['127.0.0.1:19470/x/y:z', '127.0.0.1:19470', 'x/y', 'z', null, '127.0.0.1:19470', 'http', '127.0.0.1:19470/x/y:z'],
    ['docker://alpine:3.20', 'docker.io', 'library/alpine', '3.20', null, 'registry-1.docker.io', 'https', 'alpine:3.20'],
  ];
  for (const [input, registry, repository, tag, digest, apiHost, scheme, familiar] of cases) {
    const r = parseImageRef(input);
    assert.deepEqual([r.registry, r.repository, r.tag, r.digest, r.apiHost, r.scheme, r.familiar], [registry, repository, tag, digest, apiHost, scheme, familiar], input);
    assert.equal(r.reference, digest || tag);
  }
  assert.equal(parseImageRef('registry.local/app', { insecureRegistries: ['registry.local'] }).scheme, 'http');
  // Docker treats an upper-case first component as a registry host name.
  assert.equal(parseImageRef('MyRegistry/app').registry, 'myregistry');
  for (const bad of ['', 'library/Alpine', 'ghcr.io/Owner/repo', 'a b', 'alpine:', 'alpine@sha256:123', 'https://x/y', 'alpine:tag!', 'x//y', '-lead']) {
    assert.throws(() => parseImageRef(bad), (e) => e instanceof RegistryError && e.code === 'BAD_REFERENCE', bad);
  }
});

test('parseWwwAuthenticate and parseRateLimit', () => {
  const c = parseWwwAuthenticate('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"');
  assert.equal(c.scheme, 'bearer');
  assert.deepEqual(c.params, { realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/alpine:pull' });
  assert.deepEqual(parseWwwAuthenticate('Basic realm="Registry Realm"'), { scheme: 'basic', params: { realm: 'Registry Realm' } });
  assert.equal(parseWwwAuthenticate('Bearer realm="a,b",error="x\\"y"').params.error, 'x"y');
  assert.equal(parseWwwAuthenticate(undefined), null);
  const rl = parseRateLimit({ 'ratelimit-limit': '100;w=21600', 'ratelimit-remaining': '76;w=21600', 'docker-ratelimit-source': '1.2.3.4' });
  assert.equal(rl.limit, 100);
  assert.equal(rl.remaining, 76);
  assert.equal(rl.windowSeconds, 21600);
  assert.equal(rl.source, '1.2.3.4');
  assert.equal(parseRateLimit({}), null);
});

test('selectPlatform picks linux/amd64, honours variants, skips attestations, explains misses', () => {
  const idx = {
    manifests: [
      { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
      { digest: 'sha256:arm7', platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
      { digest: 'sha256:arm64', platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
      { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
      { digest: 'sha256:win', platform: { os: 'windows', architecture: 'amd64' } },
    ],
  };
  assert.equal(selectPlatform(idx).digest, 'sha256:amd64');
  assert.equal(selectPlatform(idx, { architecture: 'x86_64' }).digest, 'sha256:amd64');
  assert.equal(selectPlatform(idx, { architecture: 'aarch64' }).digest, 'sha256:arm64');
  assert.equal(selectPlatform(idx, { architecture: 'arm', variant: 'v7' }).digest, 'sha256:arm7');
  assert.equal(selectPlatform(idx, { os: 'windows' }).digest, 'sha256:win');
  assert.throws(() => selectPlatform({ manifests: idx.manifests.slice(0, 3) }, null, 'img:1'),
    (e) => e.code === 'NO_PLATFORM' && /img:1 has no linux\/amd64/.test(e.message) && /linux\/arm64\/v8/.test(e.message) && !/unknown/.test(e.message));
});

// ---------------------------------------------------------------- against a mock registry

let mock;
let tmp;
test.before(async () => {
  tmp = fx.tmpDir('registry');
  mock = await new MockRegistry().start();
  const base = [
    { path: 'bin', type: 'dir' }, { path: 'bin/busybox', data: Buffer.alloc(40000, 0xb0), mode: 0o755 },
    { path: 'bin/sh', type: 'hardlink', linkpath: 'bin/busybox' }, { path: 'etc/os-release', data: 'ID=mock\n' },
  ];
  const app = [{ path: 'app/main', data: 'amd64 main\n', mode: 0o755 }, { path: 'etc/.wh.os-release', data: '' }];
  mock.addIndexImage('test/app', 'v1', [
    { architecture: 'amd64', layers: [base, app], config: { Entrypoint: ['/app/main'], Cmd: ['serve'], User: '1000:1000', WorkingDir: '/app', ExposedPorts: { '8080/tcp': {} } } },
    { architecture: 'arm64', variant: 'v8', layers: [[{ path: 'arm', data: 'arm' }]] },
  ]);
  mock.addIndexImage('test/armonly', 'latest', [{ architecture: 'arm64', variant: 'v8', layers: [[{ path: 'a', data: 'a' }]] }]);
  mock.buildPlatform('test/single', { manifestType: 'docker', layers: [[{ path: 'single', data: 'one layer, no index' }]] }, ['latest']);
  mock.buildPlatform('test/zstd', { layerMediaType: 'application/vnd.oci.image.layer.v1.tar+zstd', layers: [[{ path: 'z', data: 'z' }]] }, ['latest']);
  const bad = mock.buildPlatform('test/corrupt', { layers: [[{ path: 'c', data: Buffer.alloc(9000, 7) }]] }, ['latest']);
  mock.corrupt.add(bad.layers[0].digest.slice(7));
  mock.addIndexImage('test/limited', 'latest', [{ layers: [[{ path: 'l', data: 'l' }]] }]);
  mock.repo('test/limited').rateLimited = true;
});
test.after(async () => { await mock.stop(); fx.rmrf(tmp); });

const cacheDir = (name) => path.join(tmp, name);

test('pull: token flow, index -> linux/amd64, verified blobs, no credential leak to the CDN', async () => {
  const root = cacheDir('c1');
  const events = [];
  const img = await pullImage(`${mock.host}/test/app:v1`, { root, onProgress: (e) => events.push(e.phase) });
  assert.equal(mock.cdnAuthLeaks, 0, 'Authorization must not be forwarded to another origin');
  assert.ok(mock.count({ server: 'cdn' }) >= 3, 'blobs came via the CDN redirect');
  assert.equal(mock.tokenRequests, 1, 'one token for the repository, then cached');
  assert.equal(img.platform.architecture, 'amd64');
  assert.ok(img.indexDigest && img.indexDigest !== img.manifestDigest);
  assert.equal(img.layers.length, 2);
  for (const l of img.layers) {
    assert.equal('sha256:' + fx.sha256(fs.readFileSync(l.path)), l.digest);
    assert.ok(l.diffId.startsWith('sha256:'));
    assert.equal(l.compression, 'gzip');
  }
  assert.equal(img.downloadedBytes, img.totalCompressed);
  assert.equal(img.rateLimit.limit, 100);
  assert.equal(img.resolvedFrom, 'head');
  const rt = reg.runtimeConfig(img.config);
  assert.deepEqual(rt.argv, ['/app/main', 'serve']);
  assert.equal(rt.user, '1000:1000');
  assert.equal(rt.workingDir, '/app');
  assert.deepEqual(rt.exposedPorts, ['8080/tcp']);
  assert.ok(events.includes('manifest') && events.includes('blob-done') && events.includes('done'));
  const refs = reg.readRefs(root);
  assert.equal(refs[`${mock.host}/test/app:v1`].manifestDigest, img.indexDigest);
  assert.ok(!fs.readdirSync(path.join(root, 'blobs', 'sha256')).some((f) => f.endsWith('.part')));
});

test('pull again: cached tag costs no requests; "always" costs one HEAD; "never" works offline', async () => {
  const root = cacheDir('c2');
  await pullImage(`${mock.host}/test/app:v1`, { root });
  const before = mock.log.length;
  const again = await pullImage(`${mock.host}/test/app:v1`, { root });
  assert.equal(mock.log.length, before, 'no network at all');
  assert.equal(again.resolvedFrom, 'cache');
  assert.equal(again.downloadedBytes, 0);
  assert.equal(again.cachedBytes, again.totalCompressed);
  const b2 = mock.log.length;
  const always = await pullImage(`${mock.host}/test/app:v1`, { root, pullPolicy: 'always' });
  const newReqs = mock.log.slice(b2).filter((l) => l.server === 'registry');
  // A fresh client: HEAD -> 401 -> token -> HEAD. No GET, no blob traffic.
  assert.deepEqual(newReqs.map((l) => l.method), ['HEAD', 'HEAD']);
  assert.ok(newReqs.every((l) => /\/manifests\/v1$/.test(l.path)));
  assert.equal(mock.log.slice(b2).filter((l) => l.server === 'cdn').length, 0);
  assert.equal(always.manifestDigest, again.manifestDigest);
  const b3 = mock.log.length;
  // a cache-only read is not a pull: refs.json (and its pulledAt) is left
  // alone - the real-images test used to rewrite the data root's refs.json
  const refsFile = path.join(root, 'refs.json');
  const refsBefore = fs.readFileSync(refsFile, 'utf8');
  const offline = await loadImage(`${mock.host}/test/app:v1`, { root });
  assert.equal(mock.log.length, b3);
  assert.equal(offline.manifestDigest, again.manifestDigest);
  assert.equal(fs.readFileSync(refsFile, 'utf8'), refsBefore, 'refs.json not rewritten by a cache-only load');
  assert.equal(offline.platform.architecture, 'amd64');
  const cachedAgain = await pullImage(`${mock.host}/test/app:v1`, { root });
  assert.equal(cachedAgain.resolvedFrom, 'cache');
  assert.equal(fs.readFileSync(refsFile, 'utf8'), refsBefore, '...nor by a cached "missing" pull');
  await assert.rejects(loadImage(`${mock.host}/test/single:latest`, { root }), (e) => e.code === 'NOT_PRESENT');
  // A digest reference also resolves with no request once cached.
  const byDigest = await pullImage(`${mock.host}/test/app@${again.indexDigest}`, { root });
  assert.equal(byDigest.manifestDigest, again.manifestDigest);
  assert.equal(mock.log.length, b3);
});

test('pull: a moved tag is noticed with "always"', async () => {
  const root = cacheDir('c3');
  mock.addIndexImage('test/moving', 'latest', [{ layers: [[{ path: 'v', data: 'one' }]] }]);
  const a = await pullImage(`${mock.host}/test/moving`, { root });
  mock.addIndexImage('test/moving', 'latest', [{ layers: [[{ path: 'v', data: 'two' }]] }]);
  const stale = await pullImage(`${mock.host}/test/moving`, { root });
  assert.equal(stale.manifestDigest, a.manifestDigest, '"missing" keeps what is cached');
  const fresh = await pullImage(`${mock.host}/test/moving`, { root, pullPolicy: 'always' });
  assert.notEqual(fresh.manifestDigest, a.manifestDigest);
});

test('pull: a connection dropped mid-blob resumes the same writer\'s .part with a Range request', async () => {
  const root = cacheDir('c4');
  const probe = await pullImage(`${mock.host}/test/app:v1`, { root: cacheDir('c4probe') });
  const big = probe.layers[0];
  const full = fs.readFileSync(big.path);
  mock.dropOnce.add(big.digest.slice(7));
  const before = mock.log.length;
  const img = await pullImage(`${mock.host}/test/app:v1`, { root });
  const ranged = mock.log.slice(before).filter((l) => l.server === 'cdn' && l.headers.range);
  assert.equal(ranged.length, 1, 'one resumed request');
  assert.match(ranged[0].headers.range, /^bytes=\d+-$/);
  assert.ok(fs.readFileSync(img.layers[0].path).equals(full));
  assert.ok(!fs.readdirSync(path.dirname(reg.blobPath(root, big.digest))).some((f) => f.endsWith('.part')), 'no .part left');
});

// bug V4c: the prototype wrote every blob to a fixed "<hex>.part", so two
// pulls of one layer at once appended to and renamed each other's file
test('pull: .part names are per writer; stale parts of dead writers go, live ones stay (bug V4c)', () => {
  const root = cacheDir('c4parts');
  const final = reg.blobPath(root, 'sha256:' + 'a'.repeat(64));
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const a = reg.blobPartName(final), b = reg.blobPartName(final);
  assert.notEqual(a, b);
  assert.match(path.basename(a), new RegExp('^a{64}\\.' + process.pid + '\\.[0-9a-f]{8}\\.part$'));
  const oldLayout = final + '.part';
  const dead = final + '.999999999.0badf00d.part';
  const live = final + '.' + process.pid + '.0ddba11a.part';
  for (const f of [oldLayout, dead, live]) fs.writeFileSync(f, 'x');
  assert.equal(reg.removeStaleParts(final), 2);
  assert.ok(!fs.existsSync(oldLayout) && !fs.existsSync(dead));
  assert.ok(fs.existsSync(live), 'a live writer\'s part is left alone');
});

test('pull: three concurrent pulls of one image into one cache all succeed (bug V4c)', async () => {
  const root = cacheDir('c4race');
  mock.buildPlatform('test/race', { layers: [[{ path: 'big', data: Buffer.alloc(300000, 3) }], [{ path: 'b2', data: Buffer.alloc(200000, 4) }]] }, ['latest']);
  const probe = await pullImage(`${mock.host}/test/race`, { root: cacheDir('c4raceprobe') });
  for (const l of probe.layers) mock.slow.set(l.digest.slice(7), 150);
  try {
    const rs = await Promise.allSettled([0, 1, 2].map(() => pullImage(`${mock.host}/test/race`, { root })));
    assert.deepEqual(rs.filter((r) => r.status === 'rejected').map((r) => r.reason.code + ' ' + r.reason.message), []);
    for (const l of probe.layers) assert.ok(reg.hasBlob(root, l.digest, l.size));
    assert.ok(!fs.readdirSync(path.join(root, 'blobs', 'sha256')).some((f) => f.endsWith('.part')), 'no .part left');
  } finally { mock.slow.clear(); }
});

test('pull: an AbortSignal cancels the pull (ABORTED) and leaves no .part', async () => {
  const root = cacheDir('c4abort');
  mock.buildPlatform('test/abort', { layers: [[{ path: 'x', data: Buffer.alloc(100000, 5) }]] }, ['latest']);
  const probe = await pullImage(`${mock.host}/test/abort`, { root: cacheDir('c4abortprobe') });
  mock.slow.set(probe.layers[0].digest.slice(7), 1500);
  try {
    const ac = new AbortController();
    const p = pullImage(`${mock.host}/test/abort`, { root, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(p, (e) => e.code === 'ABORTED');
    const dir = path.join(root, 'blobs', 'sha256');
    assert.ok(!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.part')));
    await assert.rejects(pullImage(`${mock.host}/test/abort`, { root, signal: AbortSignal.abort() }), (e) => e.code === 'ABORTED');
  } finally { mock.slow.clear(); }
});

test('pull: corrupt blob -> DIGEST_MISMATCH and nothing left in the cache', async () => {
  const root = cacheDir('c5');
  await assert.rejects(pullImage(`${mock.host}/test/corrupt`, { root }), (e) => e.code === 'DIGEST_MISMATCH' && /corrupt or tampered/.test(e.message));
  const files = fs.readdirSync(path.join(root, 'blobs', 'sha256'));
  const bad = [...mock.corrupt][0];
  assert.ok(!files.includes(bad) && !files.includes(bad + '.part'));
});

test('pull errors: missing platform, zstd, unknown tag, rate limit, bad credentials', async () => {
  const root = cacheDir('c6');
  await assert.rejects(pullImage(`${mock.host}/test/armonly`, { root }),
    (e) => e.code === 'NO_PLATFORM' && /linux\/arm64\/v8/.test(e.message) && Array.isArray(e.available));
  if (!reg.zstdSupported()) {
    await assert.rejects(pullImage(`${mock.host}/test/zstd`, { root }),
      (e) => e.code === 'ZSTD_UNSUPPORTED' && /Node >= 23\.8/.test(e.message) && e.message.includes(process.versions.node));
    const zl = mock.log.filter((l) => l.server === 'cdn' && l.path.includes('?sig')).length;
    assert.ok(zl >= 0);
  }
  await assert.rejects(pullImage(`${mock.host}/test/app:nope`, { root }), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  await assert.rejects(pullImage(`${mock.host}/test/limited`, { root }),
    (e) => e.code === 'RATE_LIMITED' && e.status === 429 && /Limit 100 pulls per 6 h, remaining 0/.test(e.message) && e.rateLimit.remaining === 0);
  // A GET (digest reference, no HEAD) also folds the registry's error body in.
  await assert.rejects(pullImage(`${mock.host}/test/limited@sha256:${'0'.repeat(64)}`, { root }),
    (e) => e.code === 'RATE_LIMITED' && /TOOMANYREQUESTS/.test(e.message));
  mock.denyTokens = true;
  try {
    await assert.rejects(pullImage(`${mock.host}/test/single`, { root: cacheDir('c7') }), (e) => e.code === 'UNAUTHORIZED' && /incorrect username/.test(e.message));
  } finally { mock.denyTokens = false; }
});

test('pull: single-arch Docker v2 manifest (no index)', async () => {
  const img = await pullImage(`${mock.host}/test/single`, { root: cacheDir('c8') });
  assert.equal(img.indexDigest, null);
  assert.equal(img.manifest.mediaType, 'application/vnd.docker.distribution.manifest.v2+json');
  assert.equal(img.layers.length, 1);
});

test('httpRequest: same-origin redirects keep auth, cross-origin drops it, loops are cut', async () => {
  const seen = [];
  const a = http.createServer((q, s) => {
    seen.push({ srv: 'a', url: q.url, auth: q.headers.authorization || null });
    if (q.url === '/same') { s.writeHead(302, { Location: '/final' }); s.end(); return; }
    if (q.url === '/cross') { s.writeHead(307, { Location: `http://127.0.0.1:${bPort}/final` }); s.end(); return; }
    if (q.url === '/loop') { s.writeHead(302, { Location: '/loop' }); s.end(); return; }
    s.writeHead(200); s.end('ok-a');
  });
  const b = http.createServer((q, s) => { seen.push({ srv: 'b', url: q.url, auth: q.headers.authorization || null }); s.writeHead(200); s.end('ok-b'); });
  const aPort = await fx.listenInRange(a, 19490, 19499);
  const bPort = await fx.listenInRange(b, aPort + 1, 19499);
  try {
    const headers = { Authorization: 'Bearer secret' };
    const r1 = await reg.httpRequest(`http://127.0.0.1:${aPort}/same`, { headers, allowHttp: true });
    r1.resume();
    assert.equal(seen[1].auth, 'Bearer secret');
    const r2 = await reg.httpRequest(`http://127.0.0.1:${aPort}/cross`, { headers, allowHttp: true });
    r2.resume();
    assert.equal(seen[3].srv, 'b');
    assert.equal(seen[3].auth, null);
    await assert.rejects(reg.httpRequest(`http://127.0.0.1:${aPort}/loop`, { maxRedirects: 3 }), (e) => e.code === 'BAD_REDIRECT');
  } finally {
    a.close(); b.close();
  }
});

test('beforeLayers: called with the declared sizes BEFORE any layer is downloaded; a throw there downloads nothing (sec-3)', async () => {
  const root = cacheDir('c10');
  const seen = [];
  const log0 = mock.log.length; // the log is shared with the tests before
  await assert.rejects(pullImage(`${mock.host}/test/single:latest`, {
    root, beforeLayers: (info) => { seen.push(info); throw Object.assign(new Error('not enough free disk space'), { code: 'NO_SPACE' }); },
  }), (e) => e.code === 'NO_SPACE');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].missingBytes > 0 && seen[0].missingBytes === seen[0].totalCompressed, JSON.stringify(seen[0]));
  assert.ok(seen[0].config && seen[0].configDigest && seen[0].layers.length === 1);
  // the config was needed for the rules; the layer itself was never asked for
  const layerHex = seen[0].layers[0].digest.slice(7);
  assert.equal(mock.log.slice(log0).filter((l) => l.path.indexOf(layerHex) !== -1).length, 0, 'no layer was fetched');
  // a full pull, then a cached one: nothing is missing any more
  await pullImage(`${mock.host}/test/single:latest`, { root });
  const again = [];
  await pullImage(`${mock.host}/test/single:latest`, { root, beforeLayers: (info) => { again.push(info.missingBytes); } });
  assert.deepEqual(again, [0]);
});

test('token realm: an https registry cannot send the token request to plain http, and *.localhost is not "local" (sec-8)', async () => {
  const c = new reg.RegistryClient();
  const ref = parseImageRef('ghcr.io/o/r:1');
  let hit = 0;
  const srv = http.createServer((q, s) => { hit++; s.end('{"token":"x"}'); });
  const port = await fx.listenInRange(srv, 19490, 19499);
  try {
    await assert.rejects(c._authenticate(ref, { scheme: 'bearer', params: { realm: 'http://127.0.0.1:' + port + '/token' } }),
      (e) => e.code === 'UNAUTHORIZED' && /non-HTTPS token realm/.test(e.message));
    assert.equal(hit, 0, 'no request was made');
  } finally { srv.close(); }
  // resolved through DNS on Windows: never trusted as this PC
  assert.equal(parseImageRef('dev.localhost:5000/app').scheme, 'https');
});

test('end to end: mock registry -> flattenToCpio -> valid initramfs', async () => {
  const root = cacheDir('c9');
  const out = path.join(tmp, 'app.cpio');
  const r = await cpio.flattenToCpio(`${mock.host}/test/app:v1`, out, { root });
  assert.equal(r.layers, 2);
  assert.deepEqual(r.runtime.argv, ['/app/main', 'serve']);
  const listed = await cpio.listCpio(out);
  assert.deepEqual(cpio.checkInitramfs(listed.entries).errors, []);
  const by = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
  assert.equal(by['app/main'].data.toString(), 'amd64 main\n');
  assert.equal(by['etc/os-release'], undefined, 'whiteout applied');
  assert.equal(by['bin/sh'].ino, by['bin/busybox'].ino);
  assert.equal(by.arm, undefined, 'only the amd64 image');
});
