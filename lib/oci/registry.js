'use strict';
/*
 * Docker Registry HTTP API v2 client (Node standard library only).
 *
 * Pulls an image straight from a registry (Docker Hub, ghcr.io, quay.io, a
 * local registry) into a content-addressed blob cache, without Docker:
 *
 *   const reg = require('./registry');
 *   const img = await reg.pullImage('nginx:alpine', { root: 'data/images' });
 *   img.layers  -> [{ digest, size, mediaType, diffId, path }]  (bottom first)
 *   img.config  -> the image config JSON (verified against its digest)
 *   reg.runtimeConfig(img.config) -> { entrypoint, cmd, env, workingDir, user, ... }
 *
 * Cache layout under `root` (CFG.imagesDir, <data>/images):
 *   blobs/sha256/<hex>   manifests, configs and layers, named by sha256; a
 *                        file only ever appears there after its bytes were
 *                        hashed and matched (written as
 *                        <hex>.<pid>.<random>.part, then renamed - one .part
 *                        per writer, so two pulls of the same layer at once
 *                        never write into each other's file: bug V4c. When
 *                        the target already exists after the download, the
 *                        other writer won and its copy is used)
 *   refs.json            "docker.io/library/nginx:alpine" -> which manifest
 *                        digest it resolved to, so a re-run needs no network
 *                        (when an image was last USED lives in index.json,
 *                        which lib/oci/images.js owns - not here)
 *
 * What the client does:
 *  - parses references like Docker does: "alpine" = docker.io/library/alpine
 *    :latest, "user/app", "ghcr.io/o/r:tag", "localhost:5000/x",
 *    "img@sha256:<hex>" (a digest wins over a tag);
 *  - anonymous (or Basic-credentialed) Bearer token flow from the
 *    WWW-Authenticate challenge (realm / service / scope), tokens cached per
 *    host+scope until they expire;
 *  - resolves a tag with HEAD first (a HEAD does not count against Docker
 *    Hub's pull limit) and reuses cached manifests, so repeated pulls of an
 *    unchanged image cost nothing;
 *  - accepts OCI index, Docker manifest list, Docker v2 and OCI manifests and
 *    picks linux/amd64 (configurable) from an index, skipping attestation
 *    entries; every manifest and blob is verified against its sha256;
 *  - streams blobs to a .part with sha256 + size checks, resumes its own
 *    partial .part with a Range request on a retry, retries transient
 *    failures, removes .part files left by writers that are gone, follows
 *    redirects (blobs usually redirect to a CDN) and NEVER forwards the
 *    Authorization header to a different host or downgrades https to http;
 *  - idle timeouts on every request, an overall deadline on small ones;
 *  - reports Docker Hub rate-limit headers (ratelimit-limit / -remaining);
 *  - fails early and clearly on zstd layers when this Node has no zstd
 *    (zlib.createZstdDecompress arrived in Node 23.8 / 22.15), on a missing
 *    platform, on schema-1 manifests and on unknown layer media types;
 *  - opts.signal (an AbortSignal) stops a pull between steps and mid-blob:
 *    a container stopped while its image is still downloading must not keep
 *    the network busy (microVM spec section 7.4). The error has code ABORTED.
 *
 * Plain http is used only for localhost / 127.0.0.1 / [::1] registries or
 * hosts listed in opts.insecureRegistries (tests use a local mock registry).
 *
 * Errors are RegistryError with .code one of: BAD_REFERENCE, NOT_FOUND,
 * UNAUTHORIZED, RATE_LIMITED, DIGEST_MISMATCH, SIZE_MISMATCH, NO_PLATFORM,
 * UNSUPPORTED_MEDIA_TYPE, ZSTD_UNSUPPORTED, NOT_PRESENT, HTTP_ERROR, TIMEOUT,
 * BAD_REDIRECT, BAD_MANIFEST, ABORTED. Registry error bodies ({errors:[...]})
 * are folded into the message. .status carries the HTTP status when there
 * was one.
 *
 * Exports: parseImageRef, pullImage, loadImage, runtimeConfig, RegistryClient,
 * RegistryError, selectPlatform, parseWwwAuthenticate, parseRateLimit,
 * blobPath, hasBlob, readRefs, httpRequest, downloadBlob, blobPartName,
 * removeStaleParts, layerCompression, zstdSupported, MEDIA_TYPES, MANIFEST_ACCEPT.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const UA = 'devbox-vm-manager-oci/1';
const DEFAULT_REGISTRY = 'docker.io';
const DOCKER_HUB_API = 'registry-1.docker.io';
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);

const MEDIA_TYPES = {
  OCI_INDEX: 'application/vnd.oci.image.index.v1+json',
  OCI_MANIFEST: 'application/vnd.oci.image.manifest.v1+json',
  DOCKER_LIST: 'application/vnd.docker.distribution.manifest.list.v2+json',
  DOCKER_MANIFEST: 'application/vnd.docker.distribution.manifest.v2+json',
  DOCKER_V1: 'application/vnd.docker.distribution.manifest.v1+json',
  DOCKER_V1_SIGNED: 'application/vnd.docker.distribution.manifest.v1+prettyjws',
  OCI_CONFIG: 'application/vnd.oci.image.config.v1+json',
  DOCKER_CONFIG: 'application/vnd.docker.container.image.v1+json',
};
const MANIFEST_ACCEPT = [
  MEDIA_TYPES.OCI_INDEX, MEDIA_TYPES.DOCKER_LIST, MEDIA_TYPES.DOCKER_MANIFEST, MEDIA_TYPES.OCI_MANIFEST,
].join(', ');
const INDEX_TYPES = new Set([MEDIA_TYPES.OCI_INDEX, MEDIA_TYPES.DOCKER_LIST]);
const IMAGE_MANIFEST_TYPES = new Set([MEDIA_TYPES.OCI_MANIFEST, MEDIA_TYPES.DOCKER_MANIFEST]);
// Layer media types we can unpack; "gzip"/"zstd"/"tar" is what layers.js sniffs anyway.
const LAYER_TYPES = {
  'application/vnd.oci.image.layer.v1.tar': 'tar',
  'application/vnd.oci.image.layer.v1.tar+gzip': 'gzip',
  'application/vnd.oci.image.layer.v1.tar+zstd': 'zstd',
  'application/vnd.docker.image.rootfs.diff.tar.gzip': 'gzip',
  'application/vnd.docker.image.rootfs.diff.tar': 'tar',
  'application/vnd.docker.image.rootfs.diff.tar.zstd': 'zstd',
  'application/vnd.oci.image.layer.nondistributable.v1.tar': 'tar',
  'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip': 'gzip',
  'application/vnd.oci.image.layer.nondistributable.v1.tar+zstd': 'zstd',
  'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip': 'gzip',
};

const MANIFEST_LIMIT = 4 * 1024 * 1024;
const CONFIG_LIMIT = 16 * 1024 * 1024;

class RegistryError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const zstdSupported = () => typeof zlib.createZstdDecompress === 'function';

function abortedError() { return new RegistryError('ABORTED', 'the pull was cancelled'); }
function checkAbort(signal) { if (signal && signal.aborted) throw abortedError(); }

// ---------------------------------------------------------------- references

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/;
const PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

// Only the literal loopback names: "*.localhost" is resolved through DNS on
// Windows, so it may point anywhere (sec-8).
function isLocalHost(host) {
  const h = host.replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/**
 * Parse an image reference the way the Docker CLI does.
 * @param {string} input  e.g. "alpine", "nginx:alpine", "ghcr.io/o/r@sha256:..."
 * @param {{insecureRegistries?: string[]}} [opts]
 * @returns {{input, registry, repository, tag, digest, reference, apiHost, scheme,
 *            canonical, familiar}}
 */
function parseImageRef(input, opts) {
  opts = opts || {};
  if (typeof input !== 'string') throw new RegistryError('BAD_REFERENCE', 'image reference must be a string');
  let s = input.trim();
  if (s.startsWith('docker://')) s = s.slice('docker://'.length);
  if (!s || /\s/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    throw new RegistryError('BAD_REFERENCE', `invalid image reference "${input}"`);
  }
  let digest = null;
  const at = s.indexOf('@');
  if (at >= 0) {
    digest = s.slice(at + 1);
    s = s.slice(0, at);
    if (!DIGEST_RE.test(digest)) throw new RegistryError('BAD_REFERENCE', `invalid digest "${digest}" in "${input}"`);
  }
  let tag = null;
  const lastColon = s.lastIndexOf(':');
  const lastSlash = s.lastIndexOf('/');
  if (lastColon > lastSlash) {
    tag = s.slice(lastColon + 1);
    s = s.slice(0, lastColon);
    if (!TAG_RE.test(tag)) throw new RegistryError('BAD_REFERENCE', `invalid tag "${tag}" in "${input}"`);
  }
  let registry = DEFAULT_REGISTRY;
  let repository = s;
  const slash = s.indexOf('/');
  if (slash > 0) {
    const first = s.slice(0, slash);
    if (/[.:]/.test(first) || first === 'localhost' || first !== first.toLowerCase()) {
      registry = first.toLowerCase();
      repository = s.slice(slash + 1);
    }
  }
  if (DOCKER_HUB_ALIASES.has(registry)) registry = DEFAULT_REGISTRY;
  if (registry === DEFAULT_REGISTRY && !repository.includes('/')) repository = 'library/' + repository;
  if (!repository || repository.length > 255 || !repository.split('/').every((c) => PATH_COMPONENT_RE.test(c))) {
    throw new RegistryError('BAD_REFERENCE', `invalid repository name "${repository}" in "${input}" (lowercase letters, digits and . _ - only)`);
  }
  if (!tag && !digest) tag = 'latest';
  const apiHost = registry === DEFAULT_REGISTRY ? DOCKER_HUB_API : registry;
  const insecure = (opts.insecureRegistries || []).map((h) => h.toLowerCase());
  const scheme = isLocalHost(registry) || insecure.includes(registry) ? 'http' : 'https';
  const name = `${registry}/${repository}`;
  const canonical = name + (tag ? ':' + tag : '') + (digest ? '@' + digest : '');
  let familiar = registry === DEFAULT_REGISTRY ? repository.replace(/^library\//, '') : name;
  familiar += (tag ? ':' + tag : '') + (digest ? '@' + digest : '');
  return { input, registry, repository, tag, digest, reference: digest || tag, apiHost, scheme, canonical, familiar };
}

// ---------------------------------------------------------------- HTTP

function timeoutError(what, ms) {
  return new RegistryError('TIMEOUT', `${what}: no data for ${Math.round(ms / 1000)} s`);
}

/**
 * One HTTP(S) request with redirects. Resolves the final IncomingMessage
 * (body unread) with .finalUrl. Redirects: at most maxRedirects; the
 * Authorization header is dropped as soon as the origin changes; https ->
 * http downgrades are refused unless allowHttp.
 * opts: {method, headers, idleTimeoutMs (30000), deadlineMs, maxRedirects (5),
 *        allowHttp, agentKeepAlive}
 */
function httpRequest(url, opts) {
  opts = opts || {};
  const idleMs = opts.idleTimeoutMs || 30000;
  const maxRedirects = opts.maxRedirects == null ? 5 : opts.maxRedirects;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    let currentReq = null;
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) {
        try { if (currentReq) currentReq.destroy(); } catch (e) { /* ignore */ }
        reject(err);
      } else resolve(res);
    };
    if (opts.deadlineMs) {
      deadline = setTimeout(() => done(new RegistryError('TIMEOUT', `request to ${new URL(url).host} took longer than ${Math.round(opts.deadlineMs / 1000)} s`)), opts.deadlineMs);
    }
    const origin0 = new URL(url).origin;
    const go = (u, method, headers, depth) => {
      let target;
      try { target = new URL(u); } catch (e) { return done(new RegistryError('BAD_REDIRECT', `bad URL ${u}`)); }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return done(new RegistryError('BAD_REDIRECT', `unsupported URL scheme ${target.protocol}`));
      const mod = target.protocol === 'http:' ? http : https;
      const req = mod.request(target, { method, headers });
      currentReq = req;
      let res0 = null;
      req.setTimeout(idleMs, () => {
        const e = timeoutError(`${method} ${target.host}`, idleMs);
        if (res0) res0.destroy(e);
        req.destroy(e);
        done(e);
      });
      req.on('error', (e) => done(e));
      req.on('response', (res) => {
        res0 = res;
        const st = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(st) && res.headers.location) {
          res.resume();
          if (depth >= maxRedirects) return done(new RegistryError('BAD_REDIRECT', `too many redirects fetching ${url}`));
          let next;
          try { next = new URL(res.headers.location, target); } catch (e) { return done(new RegistryError('BAD_REDIRECT', `bad redirect location ${res.headers.location}`)); }
          if (target.protocol === 'https:' && next.protocol === 'http:' && !opts.allowHttp) {
            return done(new RegistryError('BAD_REDIRECT', `refusing redirect from https to http (${next.host})`));
          }
          const h = Object.assign({}, headers);
          if (next.origin !== origin0) {
            // Never leak registry credentials to a CDN or any other host.
            for (const k of Object.keys(h)) if (k.toLowerCase() === 'authorization') delete h[k];
          }
          const m = st === 303 ? 'GET' : method;
          return go(next.toString(), m, h, depth + 1);
        }
        res.finalUrl = target.toString();
        // Keep the idle timeout active while the caller reads the body.
        res.on('error', () => { /* surfaced to the reader */ });
        clearTimeout(deadline);
        if (settled) { res.resume(); return; }
        settled = true;
        resolve(res);
      });
      req.end();
    };
    go(url, opts.method || 'GET', Object.assign({ 'User-Agent': UA }, opts.headers || {}), 0);
  });
}

function readBody(res, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    res.on('data', (c) => {
      n += c.length;
      if (limit && n > limit) {
        res.destroy();
        reject(new RegistryError('HTTP_ERROR', `response larger than ${limit} bytes`));
        return;
      }
      parts.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(parts, n)));
    res.on('error', reject);
    res.on('aborted', () => reject(new RegistryError('HTTP_ERROR', 'connection closed early')));
  });
}

function registryErrorText(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    if (Array.isArray(j.errors) && j.errors.length) {
      return j.errors.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; ');
    }
    if (j.details || j.message) return String(j.details || j.message);
  } catch (e) { /* not JSON */ }
  const t = body.toString('utf8').trim();
  return t.length > 200 ? t.slice(0, 200) + '...' : t;
}

// ---------------------------------------------------------------- auth + rate limit

/**
 * Parse a WWW-Authenticate header: 'Bearer realm="...",service="...",scope="..."'.
 * @returns {{scheme: string, params: Object<string,string>}|null}
 */
function parseWwwAuthenticate(header) {
  if (!header) return null;
  const h = Array.isArray(header) ? header[0] : String(header);
  const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(h);
  if (!m) return null;
  const params = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let p;
  while ((p = re.exec(m[2]))) params[p[1].toLowerCase()] = p[2] != null ? p[2].replace(/\\(.)/g, '$1') : p[3];
  return { scheme: m[1].toLowerCase(), params };
}

/** Parse Docker Hub rate-limit headers. Returns null when absent. */
function parseRateLimit(headers) {
  const lim = headers['ratelimit-limit'];
  const rem = headers['ratelimit-remaining'];
  if (lim == null && rem == null) return null;
  const parse = (v) => {
    if (v == null) return { n: null, w: null };
    const m = /^\s*(\d+)(?:\s*;\s*w=(\d+))?/.exec(String(v));
    return m ? { n: Number(m[1]), w: m[2] ? Number(m[2]) : null } : { n: null, w: null };
  };
  const a = parse(lim);
  const b = parse(rem);
  return {
    limit: a.n,
    remaining: b.n,
    windowSeconds: a.w || b.w,
    source: headers['docker-ratelimit-source'] || null,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- client

/**
 * Registry client with a token cache.
 * opts: {credentials(registry) -> {username, password}|null, idleTimeoutMs (30000),
 *        manifestDeadlineMs (60000), onRateLimit(info, ref), insecureRegistries}
 */
class RegistryClient {
  constructor(opts) {
    this.opts = Object.assign({ idleTimeoutMs: 30000, manifestDeadlineMs: 60000 }, opts || {});
    this.tokens = new Map(); // `${apiHost}|${scope}` -> {auth, expiresAt}
    this.rateLimit = null;
  }

  _scope(ref) { return `repository:${ref.repository}:pull`; }

  _noteRateLimit(res, ref) {
    const rl = parseRateLimit(res.headers);
    if (rl) {
      this.rateLimit = rl;
      if (this.opts.onRateLimit) { try { this.opts.onRateLimit(rl, ref); } catch (e) { /* ignore */ } }
    }
  }

  async _authenticate(ref, challenge) {
    const creds = this.opts.credentials ? await this.opts.credentials(ref.registry) : null;
    const key = `${ref.apiHost}|${this._scope(ref)}`;
    if (challenge.scheme === 'basic') {
      if (!creds) throw new RegistryError('UNAUTHORIZED', `${ref.registry} requires a username and password for ${ref.repository}`, { status: 401 });
      const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
      this.tokens.set(key, { auth, expiresAt: Infinity });
      return auth;
    }
    if (challenge.scheme !== 'bearer' || !challenge.params.realm) {
      throw new RegistryError('UNAUTHORIZED', `unsupported auth challenge from ${ref.registry}: ${challenge.scheme}`, { status: 401 });
    }
    const realm = new URL(challenge.params.realm);
    // A plain-http realm only for a registry that is itself plain http (a
    // local test registry). An https registry naming an http realm - e.g.
    // http://127.0.0.1:<port>/ - would make the manager GET a service on
    // this PC and echo its answer into the error text (sec-8).
    if (realm.protocol !== 'https:' && !(realm.protocol === 'http:' && ref.scheme === 'http')) {
      throw new RegistryError('UNAUTHORIZED', `refusing non-HTTPS token realm ${realm.protocol}//${realm.host} from ${ref.registry}`);
    }
    if (challenge.params.service) realm.searchParams.set('service', challenge.params.service);
    // Always ask for exactly pull on this repository (a challenge may carry a
    // different or broader scope; we only ever read).
    realm.searchParams.set('scope', this._scope(ref));
    const headers = { Accept: 'application/json' };
    if (creds) headers.Authorization = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    const res = await httpRequest(realm.toString(), {
      headers, idleTimeoutMs: this.opts.idleTimeoutMs, deadlineMs: this.opts.manifestDeadlineMs, allowHttp: realm.protocol === 'http:',
    });
    const body = await readBody(res, 1024 * 1024);
    if (res.statusCode !== 200) {
      // the body is shown from an https realm, or from a plain-http one of
      // a plain-http registry the user chose (a local test registry) -
      // never from a plain-http service an https registry pointed us at
      const shown = realm.protocol === 'https:' || ref.scheme === 'http';
      throw new RegistryError(res.statusCode === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED',
        `token request to ${realm.host} failed (HTTP ${res.statusCode})` + (shown ? ': ' + registryErrorText(body) : ''), { status: res.statusCode });
    }
    let j;
    try { j = JSON.parse(body.toString('utf8')); } catch (e) { throw new RegistryError('UNAUTHORIZED', `token endpoint ${realm.host} returned invalid JSON`); }
    const token = j.token || j.access_token;
    if (!token) throw new RegistryError('UNAUTHORIZED', `token endpoint ${realm.host} returned no token`);
    const ttl = Math.max(30, Number(j.expires_in) || 60);
    const auth = 'Bearer ' + token;
    this.tokens.set(key, { auth, expiresAt: Date.now() + (ttl - 10) * 1000 });
    return auth;
  }

  /**
   * Request /v2/<repo>/<suffix> with auth. Resolves the response (body unread).
   * opts: {method, headers, deadlineMs, idleTimeoutMs}
   */
  async request(ref, suffix, opts) {
    opts = opts || {};
    const url = `${ref.scheme}://${ref.apiHost}/v2/${ref.repository}/${suffix}`;
    const key = `${ref.apiHost}|${this._scope(ref)}`;
    const cached = this.tokens.get(key);
    let auth = cached && cached.expiresAt > Date.now() ? cached.auth : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = Object.assign({}, opts.headers || {});
      if (auth) headers.Authorization = auth;
      const res = await httpRequest(url, {
        method: opts.method || 'GET',
        headers,
        idleTimeoutMs: opts.idleTimeoutMs || this.opts.idleTimeoutMs,
        deadlineMs: opts.deadlineMs,
        allowHttp: ref.scheme === 'http',
      });
      this._noteRateLimit(res, ref);
      if (res.statusCode === 401 && attempt === 0) {
        const ch = parseWwwAuthenticate(res.headers['www-authenticate']);
        res.resume();
        if (!ch) throw new RegistryError('UNAUTHORIZED', `${ref.registry} answered 401 without an auth challenge`, { status: 401 });
        auth = await this._authenticate(ref, ch);
        continue;
      }
      return res;
    }
    throw new RegistryError('UNAUTHORIZED', 'unreachable');
  }

  async _statusError(ref, res, what) {
    let text = '';
    if (res.statusCode !== 204 && (!res.req || res.req.method !== 'HEAD')) {
      try { text = registryErrorText(await readBody(res, 64 * 1024)); } catch (e) { /* ignore */ }
    } else res.resume();
    const st = res.statusCode;
    const tail = text ? ` (${text})` : '';
    if (st === 404) return new RegistryError('NOT_FOUND', `${what} not found: ${ref.familiar}${tail}`, { status: st });
    if (st === 401 || st === 403) {
      return new RegistryError('UNAUTHORIZED', `${ref.familiar}: the repository does not exist or needs a login (HTTP ${st})${tail}`, { status: st });
    }
    if (st === 429) {
      const rl = parseRateLimit(res.headers) || this.rateLimit;
      const extra = rl && rl.limit != null ? ` Limit ${rl.limit} pulls per ${Math.round((rl.windowSeconds || 21600) / 3600)} h, remaining ${rl.remaining}.` : '';
      return new RegistryError('RATE_LIMITED', `${ref.registry} rate limit reached while fetching ${what} for ${ref.familiar}.${extra} Wait, or log in to raise the limit.${tail}`, { status: st, rateLimit: rl });
    }
    return new RegistryError('HTTP_ERROR', `${what} for ${ref.familiar}: HTTP ${st}${tail}`, { status: st });
  }

  /** HEAD a manifest. Resolves {digest|null, mediaType, size} (no pull counted on Docker Hub). */
  async headManifest(ref, reference) {
    const res = await this.request(ref, `manifests/${reference}`, {
      method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT }, deadlineMs: this.opts.manifestDeadlineMs,
    });
    if (res.statusCode !== 200) throw await this._statusError(ref, res, `manifest ${reference}`);
    res.resume();
    const dcd = res.headers['docker-content-digest'];
    return {
      digest: dcd && DIGEST_RE.test(dcd) ? dcd : null,
      mediaType: String(res.headers['content-type'] || '').split(';')[0].trim(),
      size: Number(res.headers['content-length']) || null,
    };
  }

  /**
   * GET a manifest by tag or digest; verifies the sha256 (against the digest
   * asked for, else the Docker-Content-Digest header). Resolves
   * {digest, mediaType, body: Buffer, json}.
   */
  async getManifest(ref, reference) {
    const res = await this.request(ref, `manifests/${reference}`, {
      headers: { Accept: MANIFEST_ACCEPT }, deadlineMs: this.opts.manifestDeadlineMs,
    });
    if (res.statusCode !== 200) throw await this._statusError(ref, res, `manifest ${reference}`);
    const body = await readBody(res, MANIFEST_LIMIT);
    const digest = 'sha256:' + sha256hex(body);
    const expect = DIGEST_RE.test(reference) ? reference : res.headers['docker-content-digest'];
    if (expect && expect.startsWith('sha256:') && expect !== digest) {
      throw new RegistryError('DIGEST_MISMATCH', `manifest for ${ref.familiar} has digest ${digest}, expected ${expect}`);
    }
    if (expect && expect.startsWith('sha512:')) {
      const d512 = 'sha512:' + crypto.createHash('sha512').update(body).digest('hex');
      if (d512 !== expect) throw new RegistryError('DIGEST_MISMATCH', `manifest for ${ref.familiar} does not match ${expect}`);
    }
    const json = parseManifest(body, res.headers['content-type'], ref);
    return { digest, mediaType: json.mediaType, body, json };
  }
}

function parseManifest(body, contentType, ref) {
  let json;
  try { json = JSON.parse(body.toString('utf8')); } catch (e) {
    throw new RegistryError('BAD_MANIFEST', `manifest for ${ref.familiar} is not valid JSON`);
  }
  const ct = String(contentType || '').split(';')[0].trim();
  if (json.schemaVersion === 1 || ct === MEDIA_TYPES.DOCKER_V1 || ct === MEDIA_TYPES.DOCKER_V1_SIGNED) {
    throw new RegistryError('UNSUPPORTED_MEDIA_TYPE', `${ref.familiar} only has a schema-1 manifest (deprecated since 2017); it cannot be pulled without Docker`);
  }
  let mt = json.mediaType || ct;
  if (!mt) mt = Array.isArray(json.manifests) ? MEDIA_TYPES.OCI_INDEX : MEDIA_TYPES.OCI_MANIFEST;
  if (!INDEX_TYPES.has(mt) && !IMAGE_MANIFEST_TYPES.has(mt)) {
    // Some registries send application/json; decide by shape.
    if (Array.isArray(json.manifests)) mt = MEDIA_TYPES.OCI_INDEX;
    else if (json.config && Array.isArray(json.layers)) mt = MEDIA_TYPES.OCI_MANIFEST;
    else throw new RegistryError('UNSUPPORTED_MEDIA_TYPE', `unsupported manifest type "${mt}" for ${ref.familiar}`);
  }
  json.mediaType = mt;
  return json;
}

// ---------------------------------------------------------------- platform

const ARCH_ALIASES = { x86_64: 'amd64', x64: 'amd64', aarch64: 'arm64', armhf: 'arm', i386: '386', i686: '386' };
const normArch = (a) => ARCH_ALIASES[String(a || '').toLowerCase()] || String(a || '').toLowerCase();

/**
 * Pick one manifest descriptor out of an index for {os, architecture, variant}.
 * Attestation / unknown-platform entries are ignored. Throws NO_PLATFORM with
 * the list of what the index offers.
 */
function selectPlatform(index, want, familiar) {
  want = want || {};
  const os = want.os || 'linux';
  const arch = normArch(want.architecture || 'amd64');
  const all = (index.manifests || []).filter((m) => m && m.platform &&
    !(m.annotations && m.annotations['vnd.docker.reference.type']) &&
    m.platform.os !== 'unknown');
  const cands = all.filter((m) => m.platform.os === os && normArch(m.platform.architecture) === arch);
  let pick = null;
  if (want.variant) pick = cands.find((m) => m.platform.variant === want.variant) || null;
  if (!pick) pick = cands.find((m) => !m.platform.variant) || cands.find((m) => m.platform.variant === 'v1') || cands[0] || null;
  if (!pick) {
    const avail = [...new Set(all.map((m) => [m.platform.os, m.platform.architecture, m.platform.variant].filter(Boolean).join('/')))];
    throw new RegistryError('NO_PLATFORM',
      `${familiar || 'image'} has no ${os}/${arch}${want.variant ? '/' + want.variant : ''} variant; it offers: ${avail.join(', ') || 'nothing usable'}`,
      { available: avail });
  }
  return pick;
}

// ---------------------------------------------------------------- blob cache

function blobPath(root, digest) {
  const [alg, hex] = String(digest).split(':');
  if (alg !== 'sha256' || !/^[a-f0-9]{64}$/.test(hex || '')) throw new RegistryError('UNSUPPORTED_MEDIA_TYPE', `unsupported digest ${digest} (only sha256)`);
  return path.join(root, 'blobs', 'sha256', hex);
}

/** True when the blob is cached (and, when size is given, has that size). */
function hasBlob(root, digest, size) {
  try {
    const st = fs.statSync(blobPath(root, digest));
    return st.isFile() && (size == null || st.size === size);
  } catch (e) { return false; }
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, file); } catch (e) {
    if (fs.existsSync(file)) { try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ } } else throw e;
  }
}

/** Store a small verified blob (manifest/config) held in memory. */
function putBlob(root, digest, buf) {
  const hex = sha256hex(buf);
  if ('sha256:' + hex !== digest) throw new RegistryError('DIGEST_MISMATCH', `blob ${digest} content hashes to sha256:${hex}`);
  const file = blobPath(root, digest);
  if (!hasBlob(root, digest, buf.length)) writeFileAtomic(file, buf);
  return file;
}

/** Read a small cached blob and re-verify it. Returns Buffer or null. */
function readCachedBlob(root, digest) {
  let buf;
  try { buf = fs.readFileSync(blobPath(root, digest)); } catch (e) { return null; }
  if ('sha256:' + sha256hex(buf) !== digest) return null;
  return buf;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => h.update(c)).on('end', () => resolve(h)).on('error', reject);
  });
}

const RETRYABLE = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'TIMEOUT', 'HTTP_5XX', 'EARLY_CLOSE', 'ECONNABORTED', 'ENETUNREACH']);

// The temporary file of ONE writer: <blob>.<pid>.<random>.part. A fixed
// "<blob>.part" let two concurrent pulls of the same layer append to (and
// then rename) each other's half-written file (bug V4c).
function blobPartName(final) {
  return final + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
}

// the app's one process check (bug F: no private copies)
const pidAlive = (pid) => pid > 0 && require('../platform').pidAlive(pid);

// Remove .part files of `final` whose writer process is gone (a crashed or
// killed pull). A part of a live writer - this process included - is left
// alone: it may be downloading right now. Returns the number removed.
function removeStaleParts(final) {
  const dir = path.dirname(final);
  const base = path.basename(final) + '.';
  let n = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const f of names) {
    if (!f.startsWith(base) || !f.endsWith('.part')) continue;
    const m = /^(\d+)\.[0-9a-f]+\.part$/.exec(f.slice(base.length));
    // a part of the first layout (<hex>.part) has no writer pid: stale
    if (m && pidAlive(parseInt(m[1], 10))) continue;
    try { fs.rmSync(path.join(dir, f), { force: true }); n++; } catch (e) { /* in use */ }
  }
  return n;
}

/**
 * Download one blob into the cache, verifying size and sha256. A retry after
 * a dropped connection resumes this writer's own .part with a Range request.
 * Resolves {path, bytes (downloaded now), cached (true when nothing had to be
 * fetched)}.
 * opts: {onProgress({digest, received, total}), retries (4), idleTimeoutMs, signal}
 */
async function downloadBlob(client, ref, desc, root, opts) {
  opts = opts || {};
  const final = blobPath(root, desc.digest);
  if (hasBlob(root, desc.digest, desc.size)) return { path: final, bytes: 0, cached: true };
  fs.mkdirSync(path.dirname(final), { recursive: true });
  removeStaleParts(final);
  const part = blobPartName(final);
  const retries = opts.retries == null ? 4 : opts.retries;
  let downloaded = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      checkAbort(opts.signal);
      // another writer finished the same blob meanwhile: use its copy
      if (hasBlob(root, desc.digest, desc.size)) { fs.rmSync(part, { force: true }); return { path: final, bytes: downloaded, cached: downloaded === 0 }; }
      let offset = 0;
      let hash = crypto.createHash('sha256');
      try {
        const st = fs.statSync(part);
        if (desc.size != null && st.size > 0 && st.size < desc.size) {
          hash = await hashFile(part);
          offset = st.size;
        } else fs.rmSync(part, { force: true });
      } catch (e) { /* no part file */ }
      const headers = offset ? { Range: `bytes=${offset}-` } : {};
      const res = await client.request(ref, `blobs/${desc.digest}`, { headers, idleTimeoutMs: opts.idleTimeoutMs });
      if (res.statusCode === 200 && offset) {
        offset = 0; // server ignored the Range: start over
        hash = crypto.createHash('sha256');
      } else if (res.statusCode === 206) {
        const cr = /bytes\s+(\d+)-/.exec(String(res.headers['content-range'] || ''));
        if (!cr || Number(cr[1]) !== offset) {
          res.resume();
          fs.rmSync(part, { force: true });
          throw Object.assign(new Error('bad Content-Range on resume'), { code: 'EARLY_CLOSE' });
        }
      } else if (res.statusCode === 416) {
        res.resume();
        fs.rmSync(part, { force: true });
        throw Object.assign(new Error('range not satisfiable'), { code: 'EARLY_CLOSE' });
      } else if (res.statusCode !== 200) {
        const err = await client._statusError(ref, res, `blob ${desc.digest.slice(0, 19)}`);
        if (res.statusCode >= 500) err.code = 'HTTP_5XX';
        throw err;
      }
      let received = offset;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
        let failed = false;
        let waiting = false;
        const onAbort = () => fail(abortedError());
        const fail = (e) => {
          if (failed) return;
          failed = true;
          if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
          res.destroy();
          // reject only once the file is closed: the caller may delete it next,
          // and Windows cannot delete a file that is still open
          ws.once('close', () => reject(e));
          ws.destroy();
        };
        if (opts.signal) {
          if (opts.signal.aborted) { onAbort(); return; }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        ws.on('error', fail);
        res.on('error', fail);
        res.on('aborted', () => fail(Object.assign(new Error('connection closed early'), { code: 'EARLY_CLOSE' })));
        res.on('data', (c) => {
          if (failed) return;
          hash.update(c);
          received += c.length;
          downloaded += c.length;
          if (desc.size != null && received > desc.size) return fail(new RegistryError('SIZE_MISMATCH', `blob ${desc.digest} is larger than the ${desc.size} bytes its manifest says`));
          if (!ws.write(c) && !waiting) {
            waiting = true;
            res.pause();
            ws.once('drain', () => { waiting = false; res.resume(); });
          }
          if (opts.onProgress) { try { opts.onProgress({ digest: desc.digest, received, total: desc.size }); } catch (e) { /* ignore */ } }
        });
        // Wait for 'close' (fd released), not just 'finish': Windows cannot
        // rename a file that is still open.
        res.on('end', () => {
          if (failed) return;
          if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
          ws.once('close', () => resolve());
          ws.end();
        });
      });
      if (desc.size != null && received !== desc.size) {
        throw Object.assign(new Error(`blob ${desc.digest}: got ${received} of ${desc.size} bytes`), { code: 'EARLY_CLOSE' });
      }
      const got = 'sha256:' + hash.digest('hex');
      if (got !== desc.digest) {
        fs.rmSync(part, { force: true });
        throw new RegistryError('DIGEST_MISMATCH', `blob ${desc.digest} downloaded with digest ${got} (corrupt or tampered); removed`);
      }
      // "exists = success": another writer may have renamed the same verified
      // content into place first (Windows refuses to rename over a file some
      // process - e.g. a flatten - holds open); then this copy is dropped
      if (hasBlob(root, desc.digest, desc.size)) fs.rmSync(part, { force: true });
      else {
        try { fs.renameSync(part, final); } catch (e) {
          if (!hasBlob(root, desc.digest, desc.size)) throw e;
          fs.rmSync(part, { force: true });
        }
      }
      return { path: final, bytes: downloaded, cached: false };
    } catch (e) {
      const retryable = RETRYABLE.has(e.code) || (e.code === 'DIGEST_MISMATCH' && attempt === 1);
      if (!retryable || attempt > retries) {
        try { fs.rmSync(part, { force: true }); } catch (x) { /* busy: removeStaleParts gets it later */ }
        throw e;
      }
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    }
  }
}

// ---------------------------------------------------------------- refs store

function refsFile(root) { return path.join(root, 'refs.json'); }

/** Map canonical reference -> {manifestDigest, platformDigest, configDigest, platform, pulledAt}. */
function readRefs(root) {
  try { return JSON.parse(fs.readFileSync(refsFile(root), 'utf8')) || {}; } catch (e) { return {}; }
}

function recordRef(root, canonical, rec) {
  const all = readRefs(root);
  all[canonical] = rec;
  writeFileAtomic(refsFile(root), JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------- pull

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Layer compression by media type: 'gzip' | 'zstd' | 'tar'; throws on unknown types. */
function layerCompression(mediaType, familiar) {
  const c = LAYER_TYPES[mediaType];
  if (c) return c;
  if (/zstd/.test(mediaType || '')) return 'zstd';
  if (/gzip/.test(mediaType || '')) return 'gzip';
  throw new RegistryError('UNSUPPORTED_MEDIA_TYPE', `${familiar}: layer media type "${mediaType}" is not a filesystem layer this tool can unpack`);
}

async function getManifestCached(client, root, ref, digest, offline) {
  const cached = readCachedBlob(root, digest);
  if (cached) return { digest, body: cached, json: parseManifest(cached, null, ref), cached: true };
  if (offline) throw new RegistryError('NOT_PRESENT', `${ref.familiar}: manifest ${digest} is not in the local cache`);
  const m = await client.getManifest(ref, digest);
  putBlob(root, digest, m.body);
  return Object.assign(m, { cached: false });
}

/**
 * Pull an image into the cache (or load it from the cache).
 * @param {string|object} refInput  reference string or parseImageRef() result
 * @param {object} opts
 *   root            cache directory (required), e.g. <data>/images
 *   platform        {os:'linux', architecture:'amd64', variant?}
 *   pullPolicy      'missing' (default: network only for what is not cached),
 *                   'always' (re-resolve the tag with a HEAD), 'never' (cache only)
 *   concurrency     parallel layer downloads (3)
 *   onProgress(ev)  ev.phase: 'resolve'|'manifest'|'blob'|'blob-done'|'done'
 *   signal          AbortSignal: cancel the pull (RegistryError ABORTED)
 *   beforeLayers(info) async; called once the manifest and config are known
 *                   and BEFORE any layer is downloaded (also when all are
 *                   cached): info {reference, manifestDigest, configDigest,
 *                   config, layers, totalCompressed, missingBytes (declared
 *                   bytes still to download)}. Throw to stop the pull - size
 *                   rules and disk-space checks go here (sec-3).
 *   client          a RegistryClient to reuse (token + rate-limit state)
 *   credentials, insecureRegistries, idleTimeoutMs: passed to a new client
 * @returns {Promise<{ref, reference, indexDigest, manifestDigest, manifest,
 *   configDigest, config, platform, layers:[{digest,size,mediaType,compression,diffId,path}],
 *   totalCompressed, downloadedBytes, cachedBytes, rateLimit, timings}>}
 */
async function pullImage(refInput, opts) {
  opts = opts || {};
  if (!opts.root) throw new TypeError('pullImage: opts.root (cache directory) is required');
  const root = opts.root;
  const t0 = Date.now();
  const ref = typeof refInput === 'string' ? parseImageRef(refInput, opts) : refInput;
  const policy = opts.pullPolicy || 'missing';
  const offline = policy === 'never';
  const client = opts.client || new RegistryClient({
    credentials: opts.credentials, idleTimeoutMs: opts.idleTimeoutMs, onRateLimit: opts.onRateLimit, insecureRegistries: opts.insecureRegistries,
  });
  const progress = (ev) => { if (opts.onProgress) { try { opts.onProgress(ev); } catch (e) { /* ignore */ } } };
  const want = Object.assign({ os: 'linux', architecture: 'amd64' }, opts.platform || {});

  // 1. Resolve the top-level digest (index or manifest).
  checkAbort(opts.signal);
  progress({ phase: 'resolve', ref: ref.familiar });
  let topDigest = ref.digest;
  let resolvedFrom = 'digest';
  if (!topDigest) {
    const rec = readRefs(root)[ref.canonical];
    if (rec && policy !== 'always' && readCachedBlob(root, rec.manifestDigest)) {
      topDigest = rec.manifestDigest;
      resolvedFrom = 'cache';
    } else if (offline) {
      throw new RegistryError('NOT_PRESENT', `${ref.familiar} is not in the local image cache (pull policy "never")`);
    } else {
      try {
        const head = await client.headManifest(ref, ref.tag);
        topDigest = head.digest;
        resolvedFrom = 'head';
      } catch (e) {
        // Some registries reject HEAD (405) or fail it oddly; GET still works.
        if (e.code !== 'HTTP_ERROR') throw e;
        topDigest = null;
      }
    }
  }
  let top;
  if (topDigest) {
    top = await getManifestCached(client, root, ref, topDigest, offline);
  } else {
    // Registry gave no digest on HEAD: GET by tag (verified by hashing).
    const m = await client.getManifest(ref, ref.tag);
    putBlob(root, m.digest, m.body);
    top = Object.assign(m, { cached: false });
    topDigest = m.digest;
    resolvedFrom = 'get';
  }
  const tManifest0 = Date.now();

  // 2. Index -> platform manifest.
  checkAbort(opts.signal);
  let indexDigest = null;
  let manifestDigest = topDigest;
  let manifest = top.json;
  let platform = null;
  if (INDEX_TYPES.has(manifest.mediaType)) {
    indexDigest = topDigest;
    const desc = selectPlatform(manifest, want, ref.familiar);
    platform = desc.platform;
    const m = await getManifestCached(client, root, ref, desc.digest, offline);
    manifestDigest = desc.digest;
    manifest = m.json;
    if (INDEX_TYPES.has(manifest.mediaType)) throw new RegistryError('BAD_MANIFEST', `${ref.familiar}: nested indexes are not supported`);
  }
  if (!manifest.config || !manifest.config.digest || !Array.isArray(manifest.layers)) {
    throw new RegistryError('BAD_MANIFEST', `${ref.familiar}: manifest ${manifestDigest} has no config or layers`);
  }
  progress({ phase: 'manifest', digest: manifestDigest, layers: manifest.layers.length });

  // 3. Check the layers before spending bandwidth on them.
  const layers = manifest.layers.map((l) => {
    const compression = layerCompression(l.mediaType, ref.familiar);
    if (compression === 'zstd' && !zstdSupported()) {
      throw new RegistryError('ZSTD_UNSUPPORTED',
        `${ref.familiar} uses zstd-compressed layers (${l.mediaType}); unpacking them needs Node >= 23.8 or 22.15 ` +
        `(zlib.createZstdDecompress), this is Node ${process.versions.node}. Upgrade Node or use a gzip-layered tag of the image.`);
    }
    if (typeof l.size !== 'number' || l.size < 0) throw new RegistryError('BAD_MANIFEST', `${ref.familiar}: layer ${l.digest} has no size`);
    blobPath(root, l.digest); // validates the digest format
    return { digest: l.digest, size: l.size, mediaType: l.mediaType, compression, urls: l.urls };
  });

  // 4. Config.
  checkAbort(opts.signal);
  let configBuf = readCachedBlob(root, manifest.config.digest);
  if (!configBuf) {
    if (offline) throw new RegistryError('NOT_PRESENT', `${ref.familiar}: config ${manifest.config.digest} not cached`);
    const res = await client.request(ref, `blobs/${manifest.config.digest}`, { deadlineMs: client.opts.manifestDeadlineMs });
    if (res.statusCode !== 200) throw await client._statusError(ref, res, 'image config');
    configBuf = await readBody(res, CONFIG_LIMIT);
    putBlob(root, manifest.config.digest, configBuf);
  }
  let config;
  try { config = JSON.parse(configBuf.toString('utf8')); } catch (e) { throw new RegistryError('BAD_MANIFEST', `${ref.familiar}: image config is not JSON`); }
  if (config.os && config.os !== want.os) throw new RegistryError('NO_PLATFORM', `${ref.familiar} is a ${config.os} image, not ${want.os}`);
  if (config.architecture && normArch(config.architecture) !== normArch(want.architecture)) {
    throw new RegistryError('NO_PLATFORM', `${ref.familiar} is built for ${config.architecture}, not ${want.architecture}`);
  }
  const diffIds = (config.rootfs && config.rootfs.diff_ids) || [];
  if (diffIds.length !== layers.length) {
    throw new RegistryError('BAD_MANIFEST', `${ref.familiar}: ${layers.length} layers but ${diffIds.length} diff_ids in the config`);
  }
  layers.forEach((l, i) => { l.diffId = diffIds[i]; });

  // 4b. The caller's say BEFORE any layer is fetched (sec-3, spec 15.6): a
  // manifest can declare gigabytes of layers, and a gzip bomb is small
  // until it is unpacked - the size rules and the disk-space check run
  // here, on the declared sizes, not after the download. Throw to stop.
  if (opts.beforeLayers) {
    let missingBytes = 0;
    const seen = new Set();
    for (const l of layers) {
      if (seen.has(l.digest)) continue;
      seen.add(l.digest);
      if (!hasBlob(root, l.digest, l.size)) missingBytes += l.size;
    }
    await opts.beforeLayers({
      reference: ref.canonical, manifestDigest, configDigest: manifest.config.digest, config, layers,
      totalCompressed: layers.reduce((a, l) => a + l.size, 0), missingBytes,
    });
    checkAbort(opts.signal);
  }

  // 5. Layers (parallel, deduplicated by digest).
  const tBlobs0 = Date.now();
  let downloadedBytes = 0;
  let cachedBytes = 0;
  const inflight = new Map();
  await mapLimit(layers, opts.concurrency || 3, async (l) => {
    if (!inflight.has(l.digest)) {
      if (offline && !hasBlob(root, l.digest, l.size)) {
        inflight.set(l.digest, Promise.reject(new RegistryError('NOT_PRESENT', `${ref.familiar}: layer ${l.digest} not cached`)));
      } else {
        inflight.set(l.digest, downloadBlob(client, ref, l, root, {
          idleTimeoutMs: opts.idleTimeoutMs, signal: opts.signal,
          onProgress: (p) => progress(Object.assign({ phase: 'blob' }, p)),
        }));
      }
    }
    const r = await inflight.get(l.digest);
    l.path = r.path;
    if (r.cached) cachedBytes += l.size; else downloadedBytes += r.bytes;
    progress({ phase: 'blob-done', digest: l.digest, size: l.size, cached: r.cached });
  });

  // 6. Remember what the tag resolved to.
  checkAbort(opts.signal);
  const rec = {
    manifestDigest: topDigest, platformDigest: manifestDigest, configDigest: manifest.config.digest,
    platform: platform || { os: config.os, architecture: config.architecture }, pulledAt: new Date().toISOString(),
  };
  // A tag answered from the cache is not a pull: its record (and pulledAt)
  // stays as it is, and a cache-only read never writes to the cache dir.
  if (ref.tag && !ref.digest) {
    const had = resolvedFrom === 'cache' ? readRefs(root)[ref.canonical] : null;
    const same = had && had.manifestDigest === rec.manifestDigest && had.platformDigest === rec.platformDigest && had.configDigest === rec.configDigest;
    if (!same) recordRef(root, ref.canonical, rec);
    else rec.pulledAt = had.pulledAt || rec.pulledAt;
  }
  const tEnd = Date.now();
  const result = {
    ref,
    reference: ref.canonical,
    indexDigest,
    manifestDigest,
    manifest,
    configDigest: manifest.config.digest,
    config,
    platform: rec.platform,
    layers,
    totalCompressed: layers.reduce((a, l) => a + l.size, 0),
    downloadedBytes,
    cachedBytes,
    resolvedFrom,
    rateLimit: client.rateLimit,
    timings: { resolveMs: tManifest0 - t0, manifestMs: tBlobs0 - tManifest0, blobsMs: tEnd - tBlobs0, totalMs: tEnd - t0 },
  };
  progress({ phase: 'done', reference: ref.canonical, manifestDigest });
  return result;
}

/** Load an image from the cache only (no network). Same result shape as pullImage. */
function loadImage(refInput, opts) {
  return pullImage(refInput, Object.assign({}, opts, { pullPolicy: 'never' }));
}

/**
 * The parts of an image config that decide how to run it.
 * @returns {{entrypoint: string[], cmd: string[], argv: string[], env: string[],
 *   workingDir: string, user: string, exposedPorts: string[], stopSignal: string|null,
 *   volumes: string[], labels: object}}
 */
function runtimeConfig(config) {
  const c = (config && config.config) || {};
  const entrypoint = Array.isArray(c.Entrypoint) ? c.Entrypoint.slice() : (c.Entrypoint ? [String(c.Entrypoint)] : []);
  const cmd = Array.isArray(c.Cmd) ? c.Cmd.slice() : (c.Cmd ? [String(c.Cmd)] : []);
  return {
    entrypoint,
    cmd,
    argv: entrypoint.concat(cmd),
    env: Array.isArray(c.Env) ? c.Env.slice() : [],
    workingDir: c.WorkingDir || '/',
    user: c.User || '',
    exposedPorts: Object.keys(c.ExposedPorts || {}),
    stopSignal: c.StopSignal || null,
    volumes: Object.keys(c.Volumes || {}),
    labels: Object.assign({}, c.Labels || {}),
  };
}

module.exports = {
  parseImageRef,
  pullImage,
  loadImage,
  runtimeConfig,
  RegistryClient,
  RegistryError,
  selectPlatform,
  parseWwwAuthenticate,
  parseRateLimit,
  blobPath,
  hasBlob,
  readRefs,
  httpRequest,
  downloadBlob,
  blobPartName,
  removeStaleParts,
  layerCompression,
  zstdSupported,
  MEDIA_TYPES,
  MANIFEST_ACCEPT,
};
