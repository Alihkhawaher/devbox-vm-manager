'use strict';
/*
 * The image cache API of lib/oci/images.js (GET /api/images, image remove,
 * prune): listing with references, sizes, users and compat verdicts;
 * index.json built from refs.json on the first scan (caches of earlier
 * versions have none); Docker "rmi" rules (IMAGE_IN_USE unless forced; a
 * reference of an image with other references only untags it); blobs shared
 * by two images survive the removal of one; prune never deletes an initrd a
 * live container booted or anything younger than 10 minutes (bug V4b).
 * Local images only (tests/oci-mkimage.js): no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CFG } = require('../lib/config');
const images = require('../lib/oci/images');
const registry = require('../lib/oci/registry');
const { tarBuffer, putLocalImage } = require('./oci-mkimage');
const { useTempRoot, resetConfig, rm } = require('./helpers');

function cache() {
  fs.mkdirSync(CFG.imagesDir, { recursive: true });
  fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), '{}');
  const shared = { tar: tarBuffer([{ path: 'shared.txt', type: 'file', data: 'same layer' }]) };
  const a = putLocalImage(CFG.imagesDir, 'alpha', { layers: [shared, { tar: tarBuffer([{ path: 'a', type: 'file', data: 'A' }]) }], config: { Cmd: ['/a'], ExposedPorts: { '80/tcp': {} } } });
  const b = putLocalImage(CFG.imagesDir, 'beta', { layers: [shared], config: { Cmd: ['/lib/systemd/systemd'] } });
  return { a, b };
}

function initrd(cd, key, ageMs) {
  const f = path.join(CFG.imagesDir, 'initrd', cd.slice(7, 19) + '-' + key + '.initrd');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(1024));
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); }
  return f;
}

test('listImages: one row per image with references, sizes, users and the engine it needs; index.json built on the way', async () => {
  const root = useTempRoot('imgs-list');
  try {
    const { a, b } = cache();
    assert.equal(fs.existsSync(images.indexFile()), false);
    const recs = [{ id: 'aaaaaaaaaaaa', name: 'web', configDigest: a.config }];
    const r = await images.listImages({ records: recs });
    assert.equal(r.images.length, 2);
    const A = r.images.find((x) => x.configDigest === a.config);
    const B = r.images.find((x) => x.configDigest === b.config);
    assert.deepEqual(A.references, ['docker.io/library/alpha:latest']);
    assert.ok(A.compressedBytes > 0 && A.complete);
    assert.deepEqual(A.usedBy, ['aaaaaaaaaaaa']);
    assert.deepEqual(A.runtime.exposedPorts, ['80/tcp']);
    assert.equal(A.compat.engine, 'microvm');
    assert.equal(B.compat.engine, 'docker-vm', 'systemd needs PID 1');
    assert.ok(r.cacheBytes > 0);
    assert.ok(fs.existsSync(images.indexFile()), 'index.json built from refs.json');
    images.noteRateLimit({ limit: 100, remaining: 99, windowSeconds: 21600, at: 'now' });
    assert.deepEqual((await images.listImages({ records: [] })).rateLimit, { limit: 100, remaining: 99, window: 21600, source: null, at: 'now' });
    assert.equal((await images.imageInfo('alpha', { records: [] })).configDigest, a.config);
    await assert.rejects(images.imageInfo('nosuch'), (e) => e.status === 404);
  } finally { resetConfig(); rm(root); }
});

test('removeImage: IMAGE_IN_USE unless forced; untag when other references remain; shared blobs survive', async () => {
  const root = useTempRoot('imgs-rm');
  try {
    const { a, b } = cache();
    const recs = [{ id: 'aaaaaaaaaaaa', name: 'web', configDigest: a.config }];
    await assert.rejects(images.removeImage({ image: 'alpha' }, { records: recs }), (e) => e.code === 'IMAGE_IN_USE' && e.status === 409 && /"web"/.test(e.message));
    // a second tag of alpha: removing one tag only untags
    const refs = registry.readRefs(CFG.imagesDir);
    refs['docker.io/library/alpha:v2'] = Object.assign({}, refs['docker.io/library/alpha:latest']);
    fs.writeFileSync(path.join(CFG.imagesDir, 'refs.json'), JSON.stringify(refs));
    const u = await images.removeImage({ image: 'alpha:v2' }, { records: recs });
    assert.deepEqual([u.untagged, u.removed], [['docker.io/library/alpha:v2'], false]);
    assert.ok(!registry.readRefs(CFG.imagesDir)['docker.io/library/alpha:v2']);
    // beta shares its only layer with alpha: removing beta keeps that blob
    const betaManifest = JSON.parse(fs.readFileSync(registry.blobPath(CFG.imagesDir, b.manifest), 'utf8'));
    const sharedLayer = betaManifest.layers[0].digest;
    const ir = initrd(b.config, '1111111111111111');
    const r = await images.removeImage({ configDigest: b.config }, { records: recs });
    assert.equal(r.removed, true);
    assert.ok(!fs.existsSync(ir), 'its initrd went');
    assert.ok(!fs.existsSync(registry.blobPath(CFG.imagesDir, b.config)), 'its config went');
    assert.ok(fs.existsSync(registry.blobPath(CFG.imagesDir, sharedLayer)), 'the layer alpha needs stays');
    assert.ok(!registry.readRefs(CFG.imagesDir)['docker.io/library/beta:latest']);
    // forced removal of an image a (stopped) container uses
    const f = await images.removeImage({ image: 'alpha', force: true }, { records: recs, inUse: [] });
    assert.equal(f.removed, true);
    assert.ok(!fs.existsSync(registry.blobPath(CFG.imagesDir, sharedLayer)), 'now nobody needs the shared layer');
  } finally { resetConfig(); rm(root); }
});

test('pruneImages: unused images go; initrds in use or younger than 10 min stay (V4b); orphan blobs only when old', async () => {
  const root = useTempRoot('imgs-prune');
  try {
    const { a, b } = cache();
    const recs = [{ id: 'aaaaaaaaaaaa', name: 'web', configDigest: a.config }];
    images.updateIndex(a.config, { references: ['docker.io/library/alpha:latest'], initrd: { file: path.basename(initrd(a.config, 'cccccccccccccccc')) } });
    const staleOld = initrd(a.config, 'dddddddddddddddd', 3600e3);     // an older init/kernel: unreferenced, old
    const staleYoung = initrd(a.config, 'eeeeeeeeeeeeeeee');          // unreferenced but just built
    const staleInUse = initrd(a.config, 'ffffffffffffffff', 3600e3);  // unreferenced, old, but a live container booted it
    const orphanYoung = path.join(CFG.imagesDir, 'blobs', 'sha256', '9'.repeat(64));
    fs.writeFileSync(orphanYoung, 'x');
    const orphanOld = path.join(CFG.imagesDir, 'blobs', 'sha256', '8'.repeat(64));
    fs.writeFileSync(orphanOld, 'x');
    const t = (Date.now() - 3600e3) / 1000; fs.utimesSync(orphanOld, t, t);
    const out = await images.pruneImages({ records: recs, inUse: [staleInUse] });
    assert.ok(out.images.includes('docker.io/library/beta:latest'));
    assert.ok(!registry.readRefs(CFG.imagesDir)['docker.io/library/beta:latest']);
    assert.ok(registry.readRefs(CFG.imagesDir)['docker.io/library/alpha:latest'], 'used by a container: kept');
    assert.ok(!fs.existsSync(staleOld));
    assert.ok(fs.existsSync(staleYoung), 'a run may be about to boot it');
    assert.ok(fs.existsSync(staleInUse), 'a live container booted it');
    assert.ok(!fs.existsSync(orphanOld));
    assert.ok(fs.existsSync(orphanYoung), 'a pull in flight may be about to reference it');
    assert.ok(fs.existsSync(registry.blobPath(CFG.imagesDir, a.config)));
    assert.ok(images.usage().total > 0);
  } finally { resetConfig(); rm(root); }
});
