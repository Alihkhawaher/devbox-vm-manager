'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const layers = require('../lib/oci/layers');
const fx = require('./oci-fixtures');

const { readTar, buildTree, emitTree, LayerError } = layers;

async function* chunked(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const readAll = (buf, chunk) => fx.collectTar(readTar(chunked(buf, chunk || 7777)));

let tmp;
test.before(() => { tmp = fx.tmpDir('layers'); });
test.after(() => fx.rmrf(tmp));

let layerSeq = 0;
async function flatten(specs, opts) {
  const ls = specs.map((entries) => {
    const o = Array.isArray(entries) ? {} : entries.opts;
    return fx.writeLayer(path.join(tmp, 'L' + (layerSeq++)), Array.isArray(entries) ? entries : entries.entries, o);
  });
  const tree = await buildTree(ls.map((l) => ({ path: l.path, diffId: l.diffId })), opts);
  return { tree, ls };
}

/** Run pass 2 and return {order: [...], byPath: {path: {entry, data}}}. */
async function materialize(tree, opts) {
  const order = [];
  const byPath = {};
  await emitTree(tree, async (entry, data) => {
    let buf = null;
    if (data != null) {
      if (Buffer.isBuffer(data)) buf = data;
      else { const parts = []; for await (const c of data) parts.push(Buffer.from(c)); buf = Buffer.concat(parts); }
    }
    order.push(entry.path);
    byPath[entry.path] = { entry, data: buf };
  }, opts);
  return { order, byPath };
}

const txt = (m, p) => (m.byPath[p] && m.byPath[p].data ? m.byPath[p].data.toString() : null);

// ---------------------------------------------------------------- readTar

test('readTar: ustar files, dirs, symlinks, hardlinks, fifos, devices', async () => {
  const tar = fx.buildTar([
    { path: 'etc', type: 'dir', mode: 0o755 },
    { path: 'etc/hosts', data: '127.0.0.1 localhost\n', mode: 0o644, uid: 1, gid: 2, mtime: 1234567890 },
    { path: 'etc/hosts.lnk', type: 'hardlink', linkpath: 'etc/hosts' },
    { path: 'bin/sh', type: 'symlink', linkpath: '/bin/busybox' },
    { path: 'run/fifo', type: 'fifo', mode: 0o600 },
    { path: 'dev/null', type: 'char', devmajor: 1, devminor: 3, mode: 0o666 },
    { path: 'suid', data: 'x', mode: 0o4755 },
  ]);
  const es = await readAll(tar, 100);
  assert.deepEqual(es.map((e) => [e.path, e.type]), [
    ['etc/', 'dir'], ['etc/hosts', 'file'], ['etc/hosts.lnk', 'hardlink'], ['bin/sh', 'symlink'],
    ['run/fifo', 'fifo'], ['dev/null', 'char'], ['suid', 'file'],
  ]);
  assert.equal(es[1].data.toString(), '127.0.0.1 localhost\n');
  assert.equal(es[1].uid, 1);
  assert.equal(es[1].gid, 2);
  assert.equal(es[1].mtime, 1234567890);
  assert.equal(es[1].size, 20);
  assert.equal(es[2].linkpath, 'etc/hosts');
  assert.equal(es[3].linkpath, '/bin/busybox');
  assert.equal(es[5].devmajor, 1);
  assert.equal(es[5].devminor, 3);
  assert.equal(es[6].mode, 0o4755);
  assert.deepEqual(es.map((e) => e.ordinal), [0, 1, 2, 3, 4, 5, 6]);
});

test('readTar: ustar prefix field, GNU longname (L) and longlink (K)', async () => {
  const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(70) + '/file.txt';
  const longTarget = '/' + 'd'.repeat(150) + '/' + 'target-of-a-very-long-symlink';
  const tar = fx.buildTar([
    { path: deep, data: 'prefix', long: 'prefix' },
    { path: deep + '.gnu', data: 'gnu', long: 'gnu' },
    { path: 'short-link', type: 'symlink', linkpath: longTarget, long: 'gnu' },
    { path: deep + '.both', type: 'symlink', linkpath: longTarget, long: 'gnu' },
    { path: 'after', data: 'ok' },
  ]);
  const es = await readAll(tar, 513);
  assert.equal(es.length, 5);
  assert.equal(es[0].path, deep);
  assert.equal(es[0].data.toString(), 'prefix');
  assert.equal(es[1].path, deep + '.gnu');
  assert.equal(es[1].data.toString(), 'gnu');
  assert.equal(es[2].path, 'short-link');
  assert.equal(es[2].linkpath, longTarget);
  assert.equal(es[3].path, deep + '.both');
  assert.equal(es[3].linkpath, longTarget);
  assert.equal(es[4].path, 'after', 'long-name state must not leak to the next entry');
});

test('readTar: PAX path, linkpath, size, mtime, uid/gid, names, xattrs', async () => {
  const uni = 'données/naïve-文件-' + 'x'.repeat(120) + '.txt';
  const big = Buffer.alloc(3000, 0x61);
  const tar = fx.buildTar([
    { path: uni, data: 'unicode', long: 'pax' },
    { path: 'link', type: 'symlink', linkpath: 'z'.repeat(300), long: 'pax' },
    // The header's size field says 0; the PAX size record is the truth.
    { path: 'sized', type: 'file', sizeField: 0, extraData: big, pax: { size: String(big.length) } },
    { path: 'times', data: 't', pax: { mtime: '1700000123.987654321', uid: '3000000', gid: '4000000', uname: 'ünï', gname: 'grp' } },
    { path: 'cap', data: 'c', pax: { 'SCHILY.xattr.security.capability': Buffer.from([1, 0, 0, 2, 0x20, 0, 0, 0]), 'SCHILY.xattr.user.k': 'v' } },
    { path: 'next', data: 'n' },
  ]);
  const es = await readAll(tar, 1000);
  assert.equal(es[0].path, uni);
  assert.equal(es[0].data.toString(), 'unicode');
  assert.equal(es[1].linkpath, 'z'.repeat(300));
  assert.equal(es[2].size, 3000);
  assert.ok(es[2].data.equals(big));
  assert.equal(es[3].mtime, 1700000123);
  assert.equal(es[3].uid, 3000000);
  assert.equal(es[3].gid, 4000000);
  assert.equal(es[3].uname, 'ünï');
  assert.deepEqual(Object.keys(es[4].xattrs).sort(), ['security.capability', 'user.k']);
  assert.equal(es[4].xattrs['user.k'].toString(), 'v');
  assert.equal(es[5].path, 'next');
  assert.equal(es[5].xattrs, null, 'per-entry PAX must not leak');
});

test('readTar: global PAX header applies onward, per-entry PAX overrides it', async () => {
  const tar = fx.buildTar([
    { path: 'a', data: 'a', globalPax: { mtime: '1600000000', uname: 'global' } },
    { path: 'b', data: 'b', pax: { mtime: '1500000000' } },
    { path: 'c', data: 'c' },
  ]);
  const es = await readAll(tar);
  assert.deepEqual(es.map((e) => e.mtime), [1600000000, 1500000000, 1600000000]);
  assert.deepEqual(es.map((e) => e.uname), ['global', 'global', 'global']);
});

test('readTar caps (sec-2): names and link targets over 4096 bytes, PAX headers over 1 MiB, global PAX keys', async () => {
  const long = 'd/' + 'x'.repeat(5000);
  for (const how of ['pax', 'gnu']) {
    // (a GNU long-name record that big is refused before it is even read)
    await assert.rejects(readAll(fx.buildTar([{ path: long, data: 'x', long: how }])), (e) => e.code === 'LIMIT' && /longer than 4096 bytes|long name header/.test(e.message), how);
    await assert.rejects(readAll(fx.buildTar([{ path: 'l', type: 'symlink', linkpath: long, long: how }])), (e) => e.code === 'LIMIT' && /link target|long name header/.test(e.message), how);
  }
  // 4096 bytes exactly is fine (PATH_MAX, what the cpio writer takes)
  const ok = 'd/' + 'y'.repeat(4094);
  assert.equal((await readAll(fx.buildTar([{ path: ok, data: 'x', long: 'pax' }])))[0].path, ok);
  // one PAX header of 2 MiB (a 4 MiB path was the proof of concept)
  await assert.rejects(readAll(fx.buildTar([{ path: 'a', data: 'x', pax: { comment: 'c'.repeat(2 * 1048576) } }])), (e) => e.code === 'LIMIT' && /PAX header/.test(e.message));
  // global PAX: unused keys are not kept for every later entry; too many used ones are refused
  const junk = {};
  for (let i = 0; i < 500; i++) junk['junk.key' + i] = 'v';
  const es = await readAll(fx.buildTar([{ path: 'a', data: 'a', globalPax: Object.assign({ uname: 'g' }, junk) }, { path: 'b', data: 'b' }]));
  assert.deepEqual(es.map((e) => e.uname), ['g', 'g'], 'the keys it uses still apply onward');
  const many = {};
  for (let i = 0; i < 70; i++) many['SCHILY.xattr.user.k' + i] = 'v';
  await assert.rejects(readAll(fx.buildTar([{ path: 'a', data: 'a', globalPax: many }])), (e) => e.code === 'LIMIT' && /global PAX/.test(e.message));
});

test('buildTree: the path characters kept for a whole image are capped (maxMetaBytes, sec-2)', async () => {
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push({ path: 'dir' + i + '/' + 'n'.repeat(2000), data: 'x', long: 'pax' });
  await assert.rejects(flatten([entries], { limits: { maxMetaBytes: 50000 } }), (e) => e.code === 'LIMIT' && /file names add up/.test(e.message));
  const { tree } = await flatten([entries]);
  assert.equal(tree.summary().files, 40, 'the default budget lets real images through');
});

test('image entries under /.devbox are dropped with a warning: an image cannot ship the engine\'s spec or init (sec-7)', async () => {
  const { tree } = await flatten([[
    { path: '.devbox', type: 'dir' }, { path: '.devbox/spec.sh', data: 'DEVBOX_USER=root\n' }, { path: '.devbox/run/stopping', data: '' },
    { path: 'app/main', data: 'ok' }, { path: '.devboxx/keep', data: 'a lookalike name is not reserved' },
  ]]);
  const m = await materialize(tree);
  assert.equal(m.byPath['.devbox/spec.sh'], undefined);
  assert.equal(m.byPath['.devbox/run/stopping'], undefined);
  assert.equal(m.byPath['.devbox'], undefined);
  assert.equal(txt(m, 'app/main'), 'ok');
  assert.equal(txt(m, '.devboxx/keep'), 'a lookalike name is not reserved');
  assert.ok(tree.warnings.some((w) => /\/\.devbox is reserved/.test(w)), tree.warnings.join('\n'));
});

test('readTar: GNU base-256 numbers', async () => {
  const tar = fx.buildTar([
    { path: 'big-ids', data: 'x', uid: 0o7777777 + 5, gid: 2 ** 33, base256: ['uid', 'gid'] },
    { path: 'big-size', data: Buffer.alloc(700, 1), base256: ['size'] },
  ]);
  const es = await readAll(tar);
  assert.equal(es[0].uid, 0o7777777 + 5);
  assert.equal(es[0].gid, 2 ** 33);
  assert.equal(es[1].size, 700);
  assert.equal(es[1].data.length, 700);
});

test('readTar: header-only types never carry data, whatever the size field says', async () => {
  const tar = fx.buildTar([
    { path: 'd', type: 'dir', sizeField: 4096 },
    { path: 's', type: 'symlink', linkpath: 't', sizeField: 99 },
    { path: 'f', data: 'after' },
  ]);
  const es = await readAll(tar);
  assert.deepEqual(es.map((e) => e.path), ['d/', 's', 'f']);
  assert.equal(es[2].data.toString(), 'after');
});

test('readTar: bad checksum, truncation, unread bodies, missing end marker', async () => {
  await assert.rejects(readAll(fx.buildTar([{ path: 'x', data: 'y', badChecksum: true }])), (e) => e instanceof LayerError && e.code === 'TAR_CHECKSUM');
  const full = fx.buildTar([{ path: 'x', data: Buffer.alloc(2000, 7) }], { noEnd: true });
  await assert.rejects(readAll(full.subarray(0, 1200)), (e) => e.code === 'TAR_TRUNCATED');
  // Skip bodies without reading them.
  const tar = fx.buildTar([{ path: 'one', data: Buffer.alloc(5000, 1) }, { path: 'two', data: 'second' }], { noEnd: true });
  const names = [];
  let second = null;
  for await (const e of readTar(chunked(tar, 333))) {
    names.push(e.path);
    if (e.path === 'two') { const p = []; for await (const c of e.body()) p.push(c); second = Buffer.concat(p).toString(); }
  }
  assert.deepEqual(names, ['one', 'two']);
  assert.equal(second, 'second');
});

test('readTar: parses archives written by GNU tar and bsdtar (optional cross-check)', async (t) => {
  const tools = [
    ['gnu', fx.findTool(['C:/Program Files/Git/usr/bin/tar.exe', '/usr/bin/tar', '/bin/tar'])],
    ['bsd', fx.findTool(['C:/Windows/System32/tar.exe', '/usr/bin/bsdtar'])],
  ].filter(([, p]) => p);
  if (!tools.length) { t.skip('no tar tool found'); return; }
  const src = path.join(tmp, 'xsrc');
  const long = 'dir-' + 'L'.repeat(90) + '/sub-' + 'M'.repeat(90);
  fs.mkdirSync(path.join(src, long), { recursive: true });
  fs.writeFileSync(path.join(src, long, 'file-' + 'N'.repeat(110) + '.txt'), 'deep');
  fs.writeFileSync(path.join(src, 'plain.txt'), 'plain');
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(100000, 3));
  const checked = [];
  t.after(() => t.diagnostic(`checked: ${checked.join(', ')}`));
  for (const [kind, tool] of tools) {
    const formats = kind === 'gnu' ? ['gnu', 'pax', 'ustar'] : ['pax', 'gnutar', 'ustar'];
    for (const format of formats) {
      const out = path.join(tmp, `x-${kind}-${format}.tar`);
      const args = kind === 'gnu'
        ? ['--force-local', '--format=' + format, '-cf', out.replace(/\\/g, '/'), '-C', src.replace(/\\/g, '/'), '.']
        : ['--format', format, '-cf', out, '-C', src, '.'];
      try { execFileSync(tool, args, { stdio: 'pipe' }); } catch (e) {
        if (format === 'ustar') continue; // ustar cannot hold these names: expected to fail
        throw e;
      }
      const es = await readAll(fs.readFileSync(out));
      const files = Object.fromEntries(es.filter((e) => e.type === 'file').map((e) => [layers.normalizePath(e.path), e.data.length]));
      assert.equal(files['plain.txt'], 5, `${kind}/${format}`);
      assert.equal(files['big.bin'], 100000, `${kind}/${format}`);
      if (format !== 'ustar') assert.equal(files[`${long}/file-${'N'.repeat(110)}.txt`], 4, `${kind}/${format}: long name`);
      checked.push(`${kind}/${format}`);
    }
  }
});

// ---------------------------------------------------------------- overlay semantics

test('whiteouts remove a lower file and a whole lower subtree', async () => {
  const { tree } = await flatten([
    [
      { path: 'etc', type: 'dir' }, { path: 'etc/keep', data: 'k' }, { path: 'etc/gone', data: 'g' },
      { path: 'var', type: 'dir' }, { path: 'var/cache', type: 'dir' }, { path: 'var/cache/a/b/c', data: 'deep' },
    ],
    [{ path: 'etc/.wh.gone', data: '' }, { path: 'var/.wh.cache', data: '' }, { path: '.wh.not-there', data: '' }],
  ]);
  assert.ok(tree.lookup('etc/keep'));
  assert.equal(tree.lookup('etc/gone'), null);
  assert.equal(tree.lookup('var/cache'), null);
  assert.equal(tree.lookup('var/cache/a/b/c'), null);
  assert.ok(tree.lookup('var'));
  assert.equal(tree.stats.whiteouts, 3);
  const m = await materialize(tree);
  assert.ok(!m.order.some((p) => p.includes('.wh.')), 'whiteout markers must never be emitted');
});

test('a whiteout hides lower entries only: a same-layer entry survives in either order', async () => {
  const { tree } = await flatten([
    [{ path: 'a', data: 'lower-a' }, { path: 'b', data: 'lower-b' }, { path: 'd', type: 'dir' }, { path: 'd/old', data: 'o' }],
    [
      { path: 'a', data: 'upper-a' }, { path: '.wh.a', data: '' }, // marker AFTER the new file
      { path: '.wh.b', data: '' }, { path: 'b', type: 'dir' }, // file replaced by a dir
      { path: '.wh.d', data: '' }, { path: 'd', type: 'dir' }, { path: 'd/new', data: 'n' }, // dir recreated
    ],
  ]);
  const m = await materialize(tree);
  assert.equal(txt(m, 'a'), 'upper-a');
  assert.equal(m.byPath.b.entry.type, 'dir');
  assert.ok(m.byPath['d/new']);
  assert.equal(m.byPath['d/old'], undefined);
});

test('opaque directory hides lower children of that dir only', async () => {
  const { tree } = await flatten([
    [
      { path: 'app', type: 'dir', mode: 0o700 }, { path: 'app/x', data: 'x' }, { path: 'app/sub', type: 'dir' },
      { path: 'app/sub/y', data: 'y' }, { path: 'other', type: 'dir' }, { path: 'other/z', data: 'z' },
      { path: 'nest', type: 'dir' }, { path: 'nest/inner', type: 'dir' }, { path: 'nest/inner/lower', data: 'l' },
      { path: 'nest/keep', data: 'k' },
    ],
    [
      { path: 'app', type: 'dir', mode: 0o750, uid: 5 }, { path: 'app/.wh..wh..opq', data: '' },
      { path: 'app/new', data: 'new' }, { path: 'app/sub', type: 'dir' }, { path: 'app/sub/fresh', data: 'f' },
      { path: 'nest/inner/.wh..wh..opq', data: '' }, { path: 'nest/inner/upper', data: 'u' },
    ],
  ]);
  const m = await materialize(tree);
  const under = (d) => m.order.filter((p) => p.startsWith(d + '/')).sort();
  assert.deepEqual(under('app'), ['app/new', 'app/sub', 'app/sub/fresh']);
  assert.equal(m.byPath.app.entry.mode, 0o750);
  assert.equal(m.byPath.app.entry.uid, 5);
  assert.deepEqual(under('other'), ['other/z']);
  assert.deepEqual(under('nest'), ['nest/inner', 'nest/inner/upper', 'nest/keep']);
  assert.equal(tree.stats.opaque, 2);
});

test('opaque marker listed after same-layer children still keeps them', async () => {
  const { tree } = await flatten([
    [{ path: 'd', type: 'dir' }, { path: 'd/lower', data: 'l' }],
    [{ path: 'd', type: 'dir' }, { path: 'd/upper', data: 'u' }, { path: 'd/.wh..wh..opq', data: '' }],
  ]);
  const m = await materialize(tree);
  assert.ok(m.byPath['d/upper']);
  assert.equal(m.byPath['d/lower'], undefined);
});

test('hard links across layers survive removal/replacement of the original path', async () => {
  const { tree } = await flatten([
    [{ path: 'bin', type: 'dir' }, { path: 'bin/a', data: 'AAAA', mode: 0o755 }, { path: 'bin/b', type: 'hardlink', linkpath: 'bin/a' }],
    [{ path: 'bin/.wh.a', data: '' }, { path: 'bin/a', data: 'A2' }], // original path replaced
    [{ path: 'bin/c', type: 'hardlink', linkpath: 'bin/b' }, { path: 'sbin/d', type: 'hardlink', linkpath: 'bin/b' }], // links to a LOWER-layer file
  ]);
  assert.equal(tree.stats.hardlinksResolved, 3);
  const m = await materialize(tree);
  assert.equal(txt(m, 'bin/a'), 'A2');
  assert.equal(m.byPath['bin/a'].entry.nlink, 1);
  const group = ['bin/b', 'bin/c', 'sbin/d'];
  const inos = new Set(group.map((p) => m.byPath[p].entry.ino));
  assert.equal(inos.size, 1, 'one inode for the whole group');
  assert.ok(!inos.has(m.byPath['bin/a'].entry.ino));
  for (const p of group) {
    assert.equal(m.byPath[p].entry.nlink, 3);
    assert.equal(m.byPath[p].entry.mode, 0o755);
  }
  // Consecutive, data on the LAST member only.
  const idx = group.map((p) => m.order.indexOf(p)).sort((x, y) => x - y);
  assert.deepEqual(idx, [idx[0], idx[0] + 1, idx[0] + 2]);
  const last = m.order[idx[2]];
  assert.equal(txt(m, last), 'AAAA');
  for (const p of group) if (p !== last) { assert.equal(m.byPath[p].entry.size, 0); assert.equal(m.byPath[p].data, null); }
});

test('modifying one path of a hard-link pair in a later layer breaks the link (copy-up)', async () => {
  const { tree } = await flatten([
    [{ path: 'x', data: 'old' }, { path: 'y', type: 'hardlink', linkpath: 'x' }],
    [{ path: 'y', data: 'new-y' }],
  ]);
  const m = await materialize(tree);
  assert.equal(txt(m, 'x'), 'old');
  assert.equal(txt(m, 'y'), 'new-y');
  assert.equal(m.byPath.x.entry.nlink, 1);
  assert.notEqual(m.byPath.x.entry.ino, m.byPath.y.entry.ino);
});

test('hard link to a symlink copies the symlink; dangling links are dropped with a warning', async () => {
  const { tree } = await flatten([[
    { path: 's', type: 'symlink', linkpath: 'target' },
    { path: 'hs', type: 'hardlink', linkpath: 's' },
    { path: 'dangling', type: 'hardlink', linkpath: 'nowhere' },
    { path: 'dir', type: 'dir' },
    { path: 'todir', type: 'hardlink', linkpath: 'dir' },
  ]]);
  assert.equal(tree.lookup('hs').type, 'symlink');
  assert.equal(tree.lookup('hs').linkpath, 'target');
  assert.equal(tree.lookup('dangling'), null);
  assert.equal(tree.lookup('todir'), null);
  assert.equal(tree.stats.hardlinksDangling, 2);
  assert.ok(tree.warnings.some((w) => w.includes('dangling')));
});

test('symlink chains are kept as links; parent paths resolve through them inside the rootfs', async () => {
  const { tree } = await flatten([
    [
      { path: 'usr/lib', type: 'dir' }, { path: 'usr/lib/real.so', data: 'real' },
      { path: 'lib', type: 'symlink', linkpath: 'usr/lib' }, // relative
      { path: 'lib64', type: 'symlink', linkpath: 'lib' }, // chain: lib64 -> lib -> usr/lib
      { path: 'abs', type: 'symlink', linkpath: '/usr/lib' }, // absolute = image root
      { path: 'etc', type: 'dir' },
      { path: 'usr/escape', type: 'symlink', linkpath: '../../../../etc' }, // ".." clamps at the image root
      { path: 'hop1', type: 'symlink', linkpath: 'hop2' }, { path: 'hop2', type: 'symlink', linkpath: 'hop3' },
      { path: 'hop3', type: 'symlink', linkpath: 'lib64' },
      { path: 'loop1', type: 'symlink', linkpath: 'loop2' }, { path: 'loop2', type: 'symlink', linkpath: 'loop1' },
    ],
    [
      { path: 'lib64/via-chain.so', data: 'chain' },
      { path: 'abs/via-abs.so', data: 'abs' },
      { path: 'usr/escape/passwd', data: 'root:x:0:0' },
      { path: 'hop1/via-hops.so', data: 'hops' },
      { path: 'loop1/x', data: 'never' },
      { path: 'lib64/.wh.real.so', data: '' }, // whiteout through a symlinked parent
    ],
  ]);
  const m = await materialize(tree);
  assert.equal(txt(m, 'usr/lib/via-chain.so'), 'chain');
  assert.equal(txt(m, 'usr/lib/via-abs.so'), 'abs');
  assert.equal(txt(m, 'usr/lib/via-hops.so'), 'hops');
  assert.equal(txt(m, 'etc/passwd'), 'root:x:0:0');
  assert.equal(m.byPath['usr/lib/real.so'], undefined, 'whiteout via symlinked parent');
  for (const [p, target] of [['lib', 'usr/lib'], ['lib64', 'lib'], ['abs', '/usr/lib'], ['hop1', 'hop2'], ['loop1', 'loop2']]) {
    assert.equal(m.byPath[p].entry.type, 'symlink', p);
    assert.equal(m.byPath[p].entry.linkpath, target, p);
    assert.equal(txt(m, p), target, 'symlink data is its target');
  }
  assert.ok(!m.order.some((p) => p.startsWith('lib64/') || p.startsWith('loop1/')));
  assert.ok(tree.warnings.some((w) => w.includes('too many levels')));
  assert.equal(tree.lookup('lib64/via-chain.so').type, 'file', 'lookup follows parent links');
});

test('type changes: file over dir, dir over file, dir over symlink, symlink over dir', async () => {
  const { tree } = await flatten([
    [
      { path: 'fd', type: 'dir' }, { path: 'fd/child', data: 'c' },
      { path: 'df', data: 'file' },
      { path: 'ds', type: 'symlink', linkpath: 'elsewhere' },
      { path: 'sd', type: 'dir' }, { path: 'sd/inner', data: 'i' },
      { path: 'merge', type: 'dir', mode: 0o700 }, { path: 'merge/lower', data: 'l' },
    ],
    [
      { path: 'fd', data: 'now a file' },
      { path: 'df', type: 'dir' }, { path: 'df/x', data: 'x' },
      { path: 'ds', type: 'dir' }, { path: 'ds/y', data: 'y' },
      { path: 'sd', type: 'symlink', linkpath: 'fd' },
      { path: 'merge', type: 'dir', mode: 0o711 }, { path: 'merge/upper', data: 'u' },
    ],
  ]);
  const m = await materialize(tree);
  assert.equal(txt(m, 'fd'), 'now a file');
  assert.equal(m.byPath['fd/child'], undefined);
  assert.equal(m.byPath.df.entry.type, 'dir');
  assert.equal(txt(m, 'df/x'), 'x');
  assert.equal(m.byPath.ds.entry.type, 'dir');
  assert.equal(txt(m, 'ds/y'), 'y');
  assert.equal(m.byPath.sd.entry.type, 'symlink');
  assert.equal(m.byPath['sd/inner'], undefined);
  assert.equal(m.byPath.merge.entry.mode, 0o711);
  assert.ok(m.byPath['merge/lower'] && m.byPath['merge/upper'], 'dir over dir merges');
});

test('devices skipped, ".." refused, parents synthesized, root metadata, aufs metadata ignored', async () => {
  const { tree } = await flatten([[
    { path: './', type: 'dir', mode: 0o755, mtime: 1111 },
    { path: 'dev/sda', type: 'block', devmajor: 8, devminor: 0 },
    { path: 'dev/tty', type: 'char', devmajor: 5, devminor: 0 },
    { path: '../../evil', data: 'x' },
    { path: 'a/../../evil2', data: 'x' },
    { path: 'deep/missing/parents/file', data: 'f' },
    { path: '.wh..wh.plnk', type: 'dir' }, { path: '.wh..wh.plnk/123.456', data: 'aufs' },
    { path: '/abs/path', data: 'abs' },
    { path: 'fifo', type: 'fifo', mode: 0o640 },
  ]]);
  assert.equal(tree.stats.devicesSkipped, 2);
  assert.equal(tree.stats.rejected, 2);
  assert.equal(tree.root.mtime, 1111);
  const m = await materialize(tree);
  assert.equal(m.order[0], '.');
  assert.equal(m.byPath['.'].entry.mtime, 1111);
  assert.equal(m.byPath.deep.entry.mode, 0o755);
  assert.equal(txt(m, 'deep/missing/parents/file'), 'f');
  assert.equal(txt(m, 'abs/path'), 'abs');
  assert.equal(m.byPath.fifo.entry.type, 'fifo');
  assert.equal(m.byPath.fifo.entry.mode, 0o640);
  assert.ok(!m.order.some((p) => p.includes('evil') || p.includes('.wh.') || p.startsWith('dev/')));
});

test('diff_id is verified; gzip and uncompressed layers both work', async () => {
  const good = fx.writeLayer(path.join(tmp, 'd1'), [{ path: 'f', data: 'hello' }]);
  const raw = fx.writeLayer(path.join(tmp, 'd2'), [{ path: 'g', data: 'raw' }], { compress: 'none' });
  const tree = await buildTree([{ path: good.path, diffId: good.diffId }, { path: raw.path, diffId: raw.diffId }]);
  assert.ok(tree.lookup('f') && tree.lookup('g'));
  assert.equal(tree.stats.uncompressedBytes, good.tar.length + raw.tar.length);
  await assert.rejects(buildTree([{ path: good.path, diffId: raw.diffId }]), (e) => e.code === 'DIFFID_MISMATCH');
  // A gzip member with trailing garbage-free multi-member stream (pigz style) also works.
  const tar = fx.buildTar([{ path: 'm1', data: 'one' }, { path: 'm2', data: 'two' }]);
  const multi = Buffer.concat([zlib.gzipSync(tar.subarray(0, 1024)), zlib.gzipSync(tar.subarray(1024))]);
  const mf = path.join(tmp, 'multi.tar.gz');
  fs.writeFileSync(mf, multi);
  const t2 = await buildTree([{ path: mf, diffId: 'sha256:' + fx.sha256(tar) }]);
  assert.ok(t2.lookup('m1') && t2.lookup('m2'));
});

test('zstd layers unpack when this Node has zstd, otherwise fail with ZSTD_UNSUPPORTED', async () => {
  const tar = fx.buildTar([{ path: 'etc/z', data: 'zstd layer' }]);
  const file = path.join(tmp, 'layer.tar.zst');
  if (typeof zlib.zstdCompressSync === 'function') {
    fs.writeFileSync(file, zlib.zstdCompressSync(tar));
    const tree = await buildTree([{ path: file, diffId: 'sha256:' + fx.sha256(tar) }]);
    const m = await materialize(tree);
    assert.equal(txt(m, 'etc/z'), 'zstd layer');
  } else {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(100)]));
    await assert.rejects(buildTree([file]), (e) => e.code === 'ZSTD_UNSUPPORTED' && e.message.includes(process.versions.node));
  }
});

test('GNU sparse entries are rejected instead of silently corrupting', async () => {
  const tar = fx.buildTar([{ path: 'sparse', typeflag: 'S', data: '' }]);
  const l = fx.writeLayer(path.join(tmp, 'sp'), tar);
  await assert.rejects(buildTree([l.path]), (e) => e.code === 'TAR_FORMAT' && /sparse/.test(e.message));
});

// ---------------------------------------------------------------- emit order + extras

test('emitTree order: "." then parents before children, links before files, files in layer order', async () => {
  const { tree } = await flatten([
    [{ path: 'z', type: 'dir' }, { path: 'z/2', data: 'z2' }, { path: 'a', type: 'dir' }, { path: 'a/1', data: 'a1' }, { path: 'ln', type: 'symlink', linkpath: 'a/1' }],
    [{ path: 'b/3', data: 'b3' }],
  ]);
  const m = await materialize(tree);
  assert.deepEqual(m.order, ['.', 'a', 'b', 'ln', 'z', 'z/2', 'a/1', 'b/3']);
  const seen = new Set(['.']);
  for (const p of m.order) {
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
    assert.ok(p === '.' || seen.has(parent), `${p} after its parent`);
    seen.add(p);
  }
  assert.equal(m.byPath['.'].entry.nlink, 5); // 2 + a, b, z
  const noRoot = await materialize(tree, { includeRoot: false });
  assert.equal(noRoot.order[0], 'a');
});

test('addExtra adds files (data or host source), devices and dirs, replacing layer entries', async () => {
  const { tree } = await flatten([[{ path: 'sbin/init', data: 'layer-init' }, { path: 'keep', data: 'k' }]]);
  const src = path.join(tmp, 'host-file');
  fs.writeFileSync(src, Buffer.alloc(70000, 9));
  tree.addExtra({ path: '/sbin/init', type: 'file', data: '#!/bin/sh\n', mode: 0o755, mtime: 0 });
  tree.addExtra({ path: 'opt/blob', type: 'file', source: src, mode: 0o600 });
  tree.addExtra({ path: 'dev/console', type: 'char', rdevmajor: 5, rdevminor: 1, mode: 0o600 });
  tree.addExtra({ path: 'tmp', type: 'dir', mode: 0o1777 });
  assert.throws(() => tree.addExtra({ path: '../x', type: 'file', data: '' }), (e) => e.code === 'BAD_EXTRA');
  const m = await materialize(tree);
  assert.equal(txt(m, 'sbin/init'), '#!/bin/sh\n');
  assert.equal(m.byPath['sbin/init'].entry.mode, 0o755);
  assert.equal(m.byPath['opt/blob'].data.length, 70000);
  assert.equal(m.byPath['dev/console'].entry.rdevmajor, 5);
  assert.equal(m.byPath.tmp.entry.mode, 0o1777);
  assert.equal(txt(m, 'keep'), 'k');
  const s = tree.summary();
  assert.equal(s.extras, 2);
  assert.equal(s.devices, 1);
});
