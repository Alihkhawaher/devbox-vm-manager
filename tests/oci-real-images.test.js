'use strict';
/*
 * Real images, cache only (no network): every image already pulled into the
 * cache (pull the images with the manager first: GUI, POST /api/image/pull or the pull_image MCP tool) is flattened again into a temp cpio, read back
 * and checked. Skips when the cache is absent.
 *   OCI_IMAGES_ROOT=<dir> node --test tests/oci-real-images.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const reg = require('../lib/oci/registry');
const cpio = require('../lib/oci/cpio');
const fx = require('./oci-fixtures');

// the app's default data root (read only: loadImage never touches the network)
const ROOT = process.env.OCI_IMAGES_ROOT || path.join(__dirname, '..', 'data', 'images');
const refs = reg.readRefs(ROOT);

// Files each image must contain, and how they must look.
const EXPECT = {
  'docker.io/library/hello-world:latest': { files: ['hello'], argv: ['/hello'] },
  'docker.io/library/alpine:latest': { files: ['bin/busybox', 'etc/alpine-release', 'lib/ld-musl-x86_64.so.1'], links: { 'bin/sh': '/bin/busybox' } },
  'docker.io/library/busybox:latest': { files: ['bin/busybox'], hardlinkGroupMin: 300 },
  'docker.io/library/nginx:alpine': { files: ['usr/sbin/nginx', 'etc/nginx/nginx.conf', 'docker-entrypoint.sh'], ports: ['80/tcp'] },
  'docker.io/library/python:3-alpine': { files: ['usr/local/bin/python3', 'usr/local/lib'], argv: ['python3'] },
  'docker.io/nginxinc/nginx-unprivileged:alpine': { files: ['usr/sbin/nginx'], user: '101', ports: ['8080/tcp'] },
};

let tmp;
test.before(() => { tmp = fx.tmpDir('real'); });
test.after(() => fx.rmrf(tmp));

const names = Object.keys(refs);
if (!names.length) test('real images (cache empty: pull hello-world, alpine, busybox, nginx:alpine, python:3-alpine with the manager first)', (t) => t.skip('no cached images'));

for (const canonical of names) {
  test(`real image ${canonical}: cache -> cpio -> checked`, async () => {
    const img = await reg.loadImage(canonical, { root: ROOT });
    for (const l of img.layers) assert.ok(reg.hasBlob(ROOT, l.digest, l.size), `layer ${l.digest} cached with the right size`);
    const out = path.join(tmp, img.manifestDigest.slice(7, 19) + '.cpio');
    const r = await cpio.flattenToCpio(canonical, out, { image: img });
    const listed = await cpio.listCpio(out, { keepData: 256 });
    const chk = cpio.checkInitramfs(listed.entries);
    assert.deepEqual(chk.errors, []);
    assert.equal(listed.entries.length, r.entries);
    assert.equal(Math.ceil(listed.bytes / 512) * 512, r.cpioBytes, 'archive + zero padding to 512');
    assert.equal(r.stats.hardlinksDangling, 0);
    assert.equal(r.stats.rejected, 0);
    // Reproducible: a second flatten gives the same bytes, and so does the
    // engine's cached archive when one is there. Read only: this test must
    // never write into the data root (the engine deletes rootfs archives once
    // their initrd exists; rebuilding them here re-inflated data/images).
    const again = await cpio.flattenToCpio(canonical, out + '.2', { image: img });
    assert.equal(again.cpioBytes, r.cpioBytes);
    assert.equal(fx.sha256(fs.readFileSync(out)), fx.sha256(fs.readFileSync(out + '.2')), 'deterministic output');
    const cachedPath = cpio.rootfsPaths(ROOT, img.configDigest).archive;
    if (fs.existsSync(cachedPath)) assert.equal(fx.sha256(fs.readFileSync(out)), fx.sha256(fs.readFileSync(cachedPath)), 'same as the cached archive');
    const by = new Map(listed.entries.map((e) => [e.name, e]));
    const x = EXPECT[canonical];
    if (x) {
      for (const f of x.files) assert.ok(by.has(f), `${canonical} has ${f}`);
      for (const [l, target] of Object.entries(x.links || {})) assert.equal(by.get(l).data.toString(), target);
      if (x.argv) assert.deepEqual(r.runtime.argv, x.argv);
      if (x.user) assert.equal(r.runtime.user, x.user);
      if (x.ports) assert.deepEqual(r.runtime.exposedPorts, x.ports);
      if (x.hardlinkGroupMin) assert.ok(Math.max(...listed.entries.map((e) => e.nlink)) >= x.hardlinkGroupMin);
    }
    assert.equal(by.get('.').perm, 0o755);
    assert.equal(by.get('dev/console').type, 'char');
  });
}
