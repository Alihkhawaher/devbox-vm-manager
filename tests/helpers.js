'use strict';
/*
 * Shared test helpers (not a test file: tests/index.js only loads *.test.js).
 *
 * All test files may run in ONE process (Node 22+ via tests/index.js), and
 * CFG is a single shared object, so every test that touches the data root
 * calls useTempRoot() INSIDE the test body - never at file top level.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../lib/config');

let seq = 0;

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows may hold a file briefly */ }
}

// Loading this file points CFG at a private scratch root at once, so no test
// can ever write into the real data folder (on Node 18/20 every test file is
// its own process and would otherwise start on the default <app>/data).
// The folder is removed when the process exits.
const IDLE = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-test-idle-'));
config.configure({ data: IDLE });
process.on('exit', () => rm(IDLE));

// A fresh, empty data root for one test; CFG is pointed at it.
function useTempRoot(label, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-test-' + (label || 'x') + '-' + (++seq) + '-'));
  config.configure(Object.assign({ data: dir }, opts || {}));
  return dir;
}

// Put CFG back on the scratch root after a test that used its own.
function resetConfig() {
  config.configure({ data: IDLE });
}

// Plain HTTP request helper. opts: {method, path, headers, body (string|Buffer|object)}
function request(port, opts) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let payload = opts.body;
    const headers = Object.assign({}, opts.headers || {});
    if (payload !== undefined && typeof payload === 'object' && !Buffer.isBuffer(payload)) payload = JSON.stringify(payload);
    if (payload !== undefined && headers['Content-Length'] === undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: port, method: opts.method || 'GET', path: opts.path || '/', headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

module.exports = { useTempRoot, resetConfig, rm, request };
