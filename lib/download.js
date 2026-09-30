'use strict';
/*
 * HTTPS downloads with progress written to the task log, and small text
 * fetches (directory listings, .sha512 sidecars) used to discover the newest
 * QEMU / Alpine builds.
 *
 * download() never leaves a truncated file at the final path (BUG-3, OPS-2,
 * SEC-10): it writes <dest>.part, checks the byte count against
 * Content-Length and (when given) the sha512, and only then renames. A
 * connect timeout (30 s), an idle timeout (60 s), a dropped or early-closed
 * connection and a bad redirect all reject cleanly and remove the .part file;
 * nothing can throw inside a response callback and crash the manager.
 *
 * Only https:// URLs are followed (redirects to http:// are refused). The
 * `allowHttp` option exists for the unit tests' local server and is never
 * used by the manager itself.
 *
 * The .part name is unique per writer (<dest>.<pid>.<random>.part, see
 * partName): two downloads of the same file at once (a setup and a direct
 * kernel install, two manager processes on one data root) must never write
 * into each other's half-finished file (microVM spec bug V4). Whoever
 * renames last wins; both renamed complete, verified copies of the same
 * content. `verify(partFile)` (optional, async) checks the finished .part
 * BEFORE it is renamed - a file that fails it never appears at `dest`.
 *
 * Exports: download(url, dest, opts), fetchText(url, opts),
 * fetchSha512(url, opts), sha512File(file), headInfo(url, opts), partName(dest).
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fmtBytes, errMsg } = require('./util');

const UA = 'devbox-vm-manager';

function checkedUrl(u, base, allowHttp) {
  const url = base ? new URL(u, base) : new URL(u);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('refusing a non-HTTPS URL: ' + url.toString());
  }
  return url;
}
const transport = (url) => (url.protocol === 'http:' ? http : https);

// A temporary name no other writer uses: pid + random. Still ends in .part,
// so .gitignore and "delete leftovers" rules keep matching.
function partName(dest) {
  return dest + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.part';
}

// opts: {t (task context, for progress), label, sha512 (hex), connectTimeoutMs
// (30 s), idleTimeoutMs (60 s), maxBytes, verify(partFile) (async, throws when
// the content is not acceptable), allowHttp (tests only)}.
// Resolves {path, bytes, sha512}.
function download(url, dest, opts) {
  opts = opts || {};
  const label = opts.label || 'download';
  const say = (m) => { if (opts.t) opts.t.log(m); };
  const part = partName(dest);
  const connectMs = opts.connectTimeoutMs || 30000;
  const idleMs = opts.idleTimeoutMs || 60000;
  return new Promise((resolve, reject) => {
    let settled = false, ws = null, req = null, connectTimer = null;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      try { if (req) req.destroy(); } catch (x) {}
      const cleanup = () => { try { fs.rmSync(part, { force: true }); } catch (x) {} };
      if (ws) { ws.once('close', cleanup); try { ws.destroy(); } catch (x) {} setTimeout(cleanup, 200); } else cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const go = (u, depth) => {
      if (depth > 8) return fail(new Error('too many redirects for ' + url));
      let target;
      try { target = checkedUrl(u, null, opts.allowHttp); } catch (e) { return fail(e); }
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => fail(new Error(label + ': no response from ' + target.host + ' within ' + Math.round(connectMs / 1000) + ' s')), connectMs);
      try {
        req = transport(target).get(target, { headers: { 'User-Agent': UA } }, (res) => {
          clearTimeout(connectTimer);
          if (settled) { res.resume(); return; }
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next;
            try { next = checkedUrl(res.headers.location, target, opts.allowHttp).toString(); } catch (e) { return fail(e); }
            return go(next, depth + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return fail(new Error(label + ': HTTP ' + res.statusCode + ' for ' + target.toString())); }
          const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
          const hash = crypto.createHash('sha512');
          let got = 0, lastPct = -5, lastLogged = 0;
          try { fs.mkdirSync(path.dirname(part), { recursive: true }); ws = fs.createWriteStream(part); } catch (e) { res.resume(); return fail(e); }
          ws.on('error', fail);
          res.on('error', fail);
          res.on('aborted', () => fail(new Error(label + ': the connection was dropped (' + fmtBytes(got) + ' received)')));
          res.on('close', () => { if (!res.complete) fail(new Error(label + ': the connection closed early (' + fmtBytes(got) + ' received)')); });
          res.setTimeout(idleMs, () => fail(new Error(label + ': stalled - nothing received for ' + Math.round(idleMs / 1000) + ' s')));
          res.on('data', (c) => {
            got += c.length;
            if (opts.maxBytes && got > opts.maxBytes) return fail(new Error(label + ': larger than the expected ' + fmtBytes(opts.maxBytes)));
            hash.update(c);
            const pct = total ? Math.floor((got / total) * 100) : 0;
            const now = Date.now();
            if ((total && pct >= lastPct + 5) || (!total && now - lastLogged > 5000)) {
              lastPct = pct;
              lastLogged = now;
              say(label + ': ' + (total ? pct + '% (' : '') + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) + ')' : ''));
            }
          });
          res.pipe(ws);
          ws.on('finish', () => {
            if (settled) return;
            if (total && got !== total) return fail(new Error(label + ': incomplete (' + got + ' of ' + total + ' bytes)'));
            const digest = hash.digest('hex');
            if (opts.sha512 && digest.toLowerCase() !== String(opts.sha512).toLowerCase()) {
              return fail(new Error(label + ': checksum mismatch - the file is damaged or was tampered with'));
            }
            ws.close(async () => {
              if (settled) return;
              if (opts.verify) {
                try { await opts.verify(part); }
                catch (e) { return fail(new Error(label + ': ' + errMsg(e))); }
                if (settled) return;
              }
              try { fs.renameSync(part, dest); }
              catch (e) { return fail(e); }
              settled = true;
              say(label + ': complete (' + fmtBytes(got) + (opts.sha512 ? ', sha512 verified' : '') + (opts.verify ? ', verified' : '') + ')');
              resolve({ path: dest, bytes: got, sha512: digest });
            });
          });
        });
        req.on('error', (e) => fail(new Error(label + ': ' + errMsg(e))));
      } catch (e) { fail(e); }
    };
    go(url, 0);
  });
}

// Small text resource (<= 8 MB). opts: {timeoutMs (30 s), allowHttp (tests)}.
// Rejects on HTTP errors, timeouts and connections that close mid-body.
function fetchText(url, opts) {
  opts = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const limit = 8 * 1024 * 1024;
  const ms = opts.timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    let settled = false, req = null;
    const done = (e, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (e && req) req.destroy(); } catch (x) {}
      if (e) reject(e); else resolve(v);
    };
    const timer = setTimeout(() => done(new Error('timed out fetching ' + url)), ms);
    const go = (u, depth) => {
      if (depth > 8) return done(new Error('too many redirects for ' + url));
      let target;
      try { target = checkedUrl(u, null, opts.allowHttp); } catch (e) { return done(e); }
      try {
        req = transport(target).get(target, { headers: { 'User-Agent': UA } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            let next;
            try { next = checkedUrl(res.headers.location, target, opts.allowHttp).toString(); } catch (e) { return done(e); }
            return go(next, depth + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return done(new Error('HTTP ' + res.statusCode + ' for ' + target.toString())); }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => { size += c.length; if (size > limit) return done(new Error('response too large: ' + target.toString())); chunks.push(c); });
          res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
          res.on('error', (e) => done(e));
          res.on('close', () => { if (!res.complete) done(new Error('the connection closed early while fetching ' + target.toString())); });
        });
        req.on('error', (e) => done(e));
      } catch (e) { done(e); }
    };
    go(url, 0);
  });
}

// Pick the checksum for `fileName` out of a sidecar text: either a bare hash,
// or "<hash>  <file>" lines (sha512sum format, "*file" for binary mode). Pure.
function parseSha512Sidecar(text, fileName) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/\b([0-9a-fA-F]{128})\b(?:\s+\*?(\S+))?/);
    if (m) rows.push({ hash: m[1].toLowerCase(), file: m[2] ? path.posix.basename(m[2].replace(/\\/g, '/')) : null });
  }
  if (!rows.length) return null;
  if (fileName) {
    const hit = rows.find((r) => r.file === fileName);
    if (hit) return hit.hash;
    // a single unnamed hash belongs to the file it sits next to
    if (rows.length === 1 && !rows[0].file) return rows[0].hash;
    return null;
  }
  return rows.length === 1 ? rows[0].hash : null;
}

// The sha512 published beside a file, or null if there is none. Alpine uses
// "<file>.sha512"; QEMU for Windows uses "<name>.sha512" without ".exe", so
// callers can pass opts.sidecarUrl. opts: {sidecarUrl, fileName, timeoutMs}.
async function fetchSha512(url, opts) {
  opts = opts || {};
  const sidecar = opts.sidecarUrl || url + '.sha512';
  const fileName = opts.fileName || path.posix.basename(new URL(url).pathname);
  try {
    const txt = await fetchText(sidecar, { timeoutMs: opts.timeoutMs || 20000, allowHttp: opts.allowHttp });
    return parseSha512Sidecar(txt, fileName);
  } catch (e) { return null; }
}

// sha512 (hex) of a local file, streamed (images are hundreds of MB).
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// HEAD request (following redirects): {status, length, url}. Never rejects;
// status is null when the host could not be reached. For tools/check-sources.js.
function headInfo(url, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let settled = false, req = null;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { if (req) req.destroy(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => done({ status: null, length: null, url: url, error: 'timed out' }), opts.timeoutMs || 20000);
    const go = (u, depth) => {
      let target;
      try { target = checkedUrl(u, null, opts.allowHttp); } catch (e) { return done({ status: null, length: null, url: u, error: errMsg(e) }); }
      try {
        req = transport(target).request(target, { method: 'HEAD', headers: { 'User-Agent': UA } }, (res) => {
          res.resume();
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 8) {
            let next;
            try { next = checkedUrl(res.headers.location, target, opts.allowHttp).toString(); } catch (e) { return done({ status: res.statusCode, length: null, url: target.toString(), error: errMsg(e) }); }
            return go(next, depth + 1);
          }
          const len = parseInt(res.headers['content-length'] || '', 10);
          done({ status: res.statusCode, length: len >= 0 ? len : null, url: target.toString(), error: null });
        });
        req.on('error', (e) => done({ status: null, length: null, url: target.toString(), error: errMsg(e) }));
        req.end();
      } catch (e) { done({ status: null, length: null, url: u, error: errMsg(e) }); }
    };
    go(url, 0);
  });
}

module.exports = { download, fetchText, fetchSha512, parseSha512Sidecar, sha512File, headInfo, partName };
