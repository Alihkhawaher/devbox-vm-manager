'use strict';
/*
 * An in-process Docker Registry v2 look-alike for tests: a token server, the
 * registry, and a "CDN" on a third port (a different origin) that blobs
 * redirect to - so the tests can prove credentials never leave the registry.
 * All three listen on 127.0.0.1 on OS-assigned ports.
 */
const http = require('http');
const zlib = require('zlib');
const fx = require('./oci-fixtures');

const MT = {
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  DOCKER_MANIFEST: 'application/vnd.docker.distribution.manifest.v2+json',
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  OCI_LAYER_GZ: 'application/vnd.oci.image.layer.v1.tar+gzip',
};

class MockRegistry {
  constructor() {
    this.repos = new Map(); // repo -> {manifests: Map(ref -> {body, mediaType}), rateLimited}
    this.blobs = new Map(); // hex -> Buffer
    this.corrupt = new Set(); // hex served with a flipped byte
    this.dropOnce = new Set(); // hex: the next full GET sends half the bytes, then drops the connection
    this.slow = new Map(); // hex -> ms: wait this long before the body (keeps concurrent pulls overlapping)
    this.log = []; // {server, method, path, headers}
    this.cdnAuthLeaks = 0;
    this.tokenRequests = 0;
    this.remaining = 100;
  }

  repo(name) {
    if (!this.repos.has(name)) this.repos.set(name, { manifests: new Map(), rateLimited: false });
    return this.repos.get(name);
  }

  putBlob(buf) {
    const hex = fx.sha256(buf);
    this.blobs.set(hex, buf);
    return { digest: 'sha256:' + hex, size: buf.length };
  }

  putManifest(repoName, obj, mediaType, tags) {
    const body = Buffer.from(JSON.stringify(obj, null, 2));
    const d = this.putBlob(body);
    const r = this.repo(repoName);
    r.manifests.set(d.digest, { body, mediaType });
    for (const t of tags || []) r.manifests.set(t, { body, mediaType });
    return Object.assign(d, { mediaType });
  }

  /**
   * Build one platform image: layers = [[tar entries], ...].
   * spec: {os, architecture, variant, layers, config, layerMediaType, manifestType: 'oci'|'docker'}
   * Returns {manifest descriptor, layers: [{digest, size, diffId}], configDigest}.
   */
  buildPlatform(repoName, spec, tags) {
    const layerDescs = [];
    const diffIds = [];
    for (const entries of spec.layers) {
      const tar = fx.buildTar(entries);
      const blob = spec.layerMediaType && /zstd/.test(spec.layerMediaType) ? tar : zlib.gzipSync(tar);
      const d = this.putBlob(blob);
      layerDescs.push({ mediaType: spec.layerMediaType || MT.OCI_LAYER_GZ, digest: d.digest, size: d.size });
      diffIds.push('sha256:' + fx.sha256(tar));
    }
    const config = {
      architecture: spec.architecture || 'amd64', os: spec.os || 'linux',
      config: Object.assign({ Env: ['PATH=/usr/bin:/bin'], Cmd: ['/bin/sh'] }, spec.config || {}),
      rootfs: { type: 'layers', diff_ids: diffIds },
    };
    if (spec.variant) config.variant = spec.variant;
    const cd = this.putBlob(Buffer.from(JSON.stringify(config)));
    const docker = spec.manifestType === 'docker';
    const manifest = {
      schemaVersion: 2,
      mediaType: docker ? MT.DOCKER_MANIFEST : MT.OCI_MANIFEST,
      config: { mediaType: docker ? 'application/vnd.docker.container.image.v1+json' : MT.OCI_CONFIG, digest: cd.digest, size: cd.size },
      layers: layerDescs,
    };
    const md = this.putManifest(repoName, manifest, manifest.mediaType, tags);
    return { manifest: md, layers: layerDescs.map((l, i) => Object.assign({ diffId: diffIds[i] }, l)), configDigest: cd.digest };
  }

  /** Multi-platform image behind an OCI index (plus an attestation entry). */
  addIndexImage(repoName, tag, platforms, opts) {
    opts = opts || {};
    const built = platforms.map((p) => this.buildPlatform(repoName, p));
    const manifests = built.map((b, i) => ({
      mediaType: b.manifest.mediaType, digest: b.manifest.digest, size: b.manifest.size,
      platform: Object.assign({ os: platforms[i].os || 'linux', architecture: platforms[i].architecture || 'amd64' }, platforms[i].variant ? { variant: platforms[i].variant } : {}),
    }));
    if (opts.attestation !== false) {
      const att = this.putManifest(repoName, { schemaVersion: 2, mediaType: MT.OCI_MANIFEST, config: { mediaType: MT.OCI_CONFIG, digest: built[0].configDigest, size: 1 }, layers: [] }, MT.OCI_MANIFEST);
      manifests.push({
        mediaType: MT.OCI_MANIFEST, digest: att.digest, size: att.size, platform: { os: 'unknown', architecture: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': built[0].manifest.digest },
      });
    }
    const index = this.putManifest(repoName, { schemaVersion: 2, mediaType: MT.OCI_INDEX, manifests }, MT.OCI_INDEX, [tag]);
    return { index, platforms: built };
  }

  _authOk(req, repoName) {
    return req.headers.authorization === `Bearer tok:repository:${repoName}:pull`;
  }

  _challenge(res, repoName) {
    res.writeHead(401, {
      'WWW-Authenticate': `Bearer realm="http://127.0.0.1:${this.authPort}/token",service="mock-registry",scope="repository:${repoName}:pull"`,
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }));
  }

  _registry(req, res) {
    this.log.push({ server: 'registry', method: req.method, path: req.url, headers: req.headers });
    const u = new URL(req.url, 'http://x');
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(u.pathname);
    if (!m) { res.writeHead(u.pathname === '/v2/' ? 401 : 404); res.end(); return; }
    const [, repoName, kind, ref] = m;
    if (!this._authOk(req, repoName)) { this._challenge(res, repoName); return; }
    const r = this.repos.get(repoName);
    const rl = { 'ratelimit-limit': '100;w=21600', 'ratelimit-remaining': `${this.remaining};w=21600`, 'docker-ratelimit-source': '127.0.0.1' };
    if (r && r.rateLimited) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, rl, { 'ratelimit-remaining': '0;w=21600' }));
      res.end(JSON.stringify({ errors: [{ code: 'TOOMANYREQUESTS', message: 'You have reached your pull rate limit.' }] }));
      return;
    }
    if (kind === 'manifests') {
      const man = r && r.manifests.get(ref);
      if (!man) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }));
        return;
      }
      if (req.method === 'GET') this.remaining--;
      res.writeHead(200, Object.assign({
        'Content-Type': man.mediaType, 'Content-Length': man.body.length, 'Docker-Content-Digest': 'sha256:' + fx.sha256(man.body),
      }, rl));
      res.end(req.method === 'HEAD' ? undefined : man.body);
      return;
    }
    const hex = ref.replace(/^sha256:/, '');
    if (!this.blobs.has(hex)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'BLOB_UNKNOWN', message: 'blob unknown to registry' }] }));
      return;
    }
    res.writeHead(307, { Location: `http://127.0.0.1:${this.cdnPort}/blobs/${hex}?sig=abc` });
    res.end();
  }

  _cdn(req, res) {
    this.log.push({ server: 'cdn', method: req.method, path: req.url, headers: req.headers });
    if (req.headers.authorization) this.cdnAuthLeaks++;
    const m = /^\/blobs\/([a-f0-9]{64})/.exec(req.url);
    const buf = m && this.blobs.get(m[1]);
    if (!buf) { res.writeHead(404); res.end(); return; }
    let body = buf;
    if (this.corrupt.has(m[1])) { body = Buffer.from(buf); body[body.length >> 1] ^= 0xff; }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const send = () => {
      if (range) {
        const start = Number(range[1]);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start });
        res.end(body.subarray(start));
        return;
      }
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
      if (this.dropOnce.has(m[1])) {
        this.dropOnce.delete(m[1]);
        res.write(body.subarray(0, body.length >> 1), () => setTimeout(() => res.socket.destroy(), 20));
        return;
      }
      res.end(body);
    };
    const wait = this.slow.get(m[1]);
    if (wait) setTimeout(send, wait); else send();
  }

  _auth(req, res) {
    this.log.push({ server: 'auth', method: req.method, path: req.url, headers: req.headers });
    this.tokenRequests++;
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('service') !== 'mock-registry' || !u.searchParams.get('scope')) {
      res.writeHead(400); res.end('bad token request'); return;
    }
    if (this.denyTokens) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ details: 'incorrect username or password' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'tok:' + u.searchParams.get('scope'), expires_in: 300 }));
  }

  async start() {
    this.servers = [http.createServer((q, s) => this._registry(q, s)), http.createServer((q, s) => this._auth(q, s)), http.createServer((q, s) => this._cdn(q, s))];
    this.registryPort = await fx.listenInRange(this.servers[0], 19470, 19489);
    this.authPort = await fx.listenInRange(this.servers[1], this.registryPort + 1, 19489);
    this.cdnPort = await fx.listenInRange(this.servers[2], this.authPort + 1, 19489);
    this.host = `127.0.0.1:${this.registryPort}`;
    return this;
  }

  count(filter) {
    return this.log.filter((l) => Object.entries(filter).every(([k, v]) => (v instanceof RegExp ? v.test(l[k]) : l[k] === v))).length;
  }

  async stop() {
    await Promise.all((this.servers || []).map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));
  }
}

module.exports = { MockRegistry, MT };
