'use strict';
// lib/ninep/guest.js: the share list the manager hands a guest (fw_cfg / fstab / SSH).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/ninep/guest');

const share = (o) => Object.assign({ id: 'vm1-proj', secret: 'A'.repeat(20) + '_-x', guestPath: '/home/dev/project', readOnly: false }, o || {});

test('validateGuestPath: only plain absolute paths outside system directories', () => {
  for (const ok of ['/home/dev/project', '/mnt/src', '/work', '/srv/data-1', '/opt/app', '/home/a.b@c+d']) assert.equal(G.validateGuestPath(ok), null, ok);
  for (const bad of ['', 'relative', '/home/dev/my project', '/home/../etc', '/a/./b', '/', '/home', '/tmp', '/etc', '/etc/x', '/proc/1', '/usr/local/src',
    '/var/lib/x', '/dev/shm', '/sys', '/run/x', "/home/dev/it's", '/home/dev/$(reboot)', '/home/dev/a;b', '/home//dev', '/home/dev/', '/x/' + 'a'.repeat(250)]) {
    assert.notEqual(G.validateGuestPath(bad), null, JSON.stringify(bad));
  }
});

test('fwcfgContent: one line per share, validated, no duplicate guest paths', () => {
  const txt = G.fwcfgContent(5640, [share(), share({ id: 'vm1-docs', secret: 'b'.repeat(16), guestPath: '/mnt/docs', readOnly: true })]);
  assert.equal(txt, '5640 vm1-proj:' + share().secret + ' /home/dev/project rw\n5640 vm1-docs:' + 'b'.repeat(16) + ' /mnt/docs ro\n');
  assert.equal(G.fwcfgContent(5640, []), '');
  assert.throws(() => G.fwcfgContent(5640, [share(), share({ id: 'other' })]), /two shares/);
  assert.throws(() => G.fwcfgContent(0, [share()]), /port/);
  assert.throws(() => G.fwcfgContent(5640, [share({ secret: 'has space in it 12345' })]), /secret/);
  assert.throws(() => G.fwcfgContent(5640, [share({ guestPath: '/etc' })]), /system|under/);
});

test('qemuFwCfgArgs escapes commas for QEMU option parsing', () => {
  assert.deepEqual(G.qemuFwCfgArgs('C:\\data\\vm,1\\shares.cfg'), ['-fw_cfg', 'name=opt/devbox/shares,file=C:\\data\\vm,,1\\shares.cfg']);
});

test('fstabLine and sshMountScript', () => {
  assert.equal(G.fstabLine(5640, share({ readOnly: true })),
    '10.0.2.2 /home/dev/project 9p trans=tcp,port=5640,version=9p2000.L,msize=524288,cache=mmap,aname=vm1-proj:' + share().secret + ',ro,_netdev,nofail 0 0');
  const sh = G.sshMountScript(5640, [share()], { cache: 'none' });
  assert.match(sh, /modprobe -q 9pnet_fd/);
  // mount points come from /proc/mounts: a DEAD mount (manager restarted)
  // fails every stat, so mountpoint(1) would miss it and mount on top
  assert.match(sh, /ismnt\(\) \{ awk -v p="\$1" '\$2 == p \{ f = 1 \} END \{ exit !f \}' \/proc\/mounts; \}/);
  assert.doesNotMatch(sh, /mountpoint/);
  assert.match(sh, /\nunmnt '\/home\/dev\/project'\n/, 'default: whatever is mounted there is detached first');
  assert.match(sh, /b=\$\(cat \/proc\/sys\/kernel\/random\/boot_id 2>\/dev\/null\)/);
  assert.match(sh, /echo "DEVBOX-SHARES boot \$b"/);
  assert.match(sh, /mount -t 9p -o "trans=tcp,port=5640,version=9p2000\.L,msize=524288,cache=none,aname=vm1-proj:[A-Za-z0-9_-]+\$\{b:\+,uname=boot-\$b\}" 10\.0\.2\.2 '\/home\/dev\/project'; then echo 'DEVBOX-SHARES ok \/home\/dev\/project'; else echo 'DEVBOX-SHARES fail \/home\/dev\/project'; rc=1; fi/);
  assert.match(sh, /exit \$rc\n$/);
  assert.throws(() => G.sshMountScript(5640, [share({ guestPath: "/x/'; reboot; '" })]));
  // skipMounted: a live mount is kept (after a start or a reboot)
  const keep = G.sshMountScript(5640, [share({ readOnly: true })], { skipMounted: true });
  assert.match(keep, /if ismnt '\/home\/dev\/project' && alive '\/home\/dev\/project'; then echo 'DEVBOX-SHARES kept \/home\/dev\/project'; else unmnt '\/home\/dev\/project'; if mkdir -p .*,ro\$\{b:\+,uname=boot-\$b\}" 10\.0\.2\.2 '\/home\/dev\/project'; then .*; fi; fi\n/);
  const un = G.sshUnmountScript(['/mnt/docs']);
  assert.match(un, /unmnt '\/mnt\/docs'; if ismnt '\/mnt\/docs'; then echo 'DEVBOX-SHARES stuck \/mnt\/docs'; else echo 'DEVBOX-SHARES gone \/mnt\/docs'; fi\n$/);
  assert.throws(() => G.sshUnmountScript(['/etc']), /under/);
});

test('sshServiceScript installs the boot-time service idempotently; parseScriptOutput reads the markers', () => {
  const initd = '#!/sbin/openrc-run\r\necho "it\'s $x"\r\n';
  const s = G.sshServiceScript(initd);
  const b64 = /echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(s)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '#!/sbin/openrc-run\necho "it\'s $x"\n', 'LF line endings, any content safely quoted');
  assert.match(s, /if \[ -s "\$t" \] && ! cmp -s "\$t" "\$f"; then/, 'only replaced when different');
  assert.match(s, /rc-update add devbox-shares default/);
  assert.match(s, /grep -q '\^qemu_fw_cfg' \/etc\/modules 2>\/dev\/null \|\| echo qemu_fw_cfg >> \/etc\/modules/);
  assert.doesNotMatch(s, /\bexit\b/, 'never ends the script it is prepended to');
  assert.throws(() => G.sshServiceScript(''), /service/);
  const out = G.parseScriptOutput('noise\nDEVBOX-SHARES service installed\nDEVBOX-SHARES boot 0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6\r\n' +
    'DEVBOX-SHARES ok /mnt/a\nDEVBOX-SHARES kept /mnt/b\nDEVBOX-SHARES fail /mnt/c\nDEVBOX-SHARES gone /mnt/d\nDEVBOX-SHARES stuck /mnt/e\nDEVBOX-SHARES boot\n');
  assert.deepEqual(out, { boot: null, ok: ['/mnt/a'], kept: ['/mnt/b'], fail: ['/mnt/c'], gone: ['/mnt/d'], stuck: ['/mnt/e'], service: 'installed' });
  assert.equal(G.parseScriptOutput('DEVBOX-SHARES boot 0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6').boot, '0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6');
  assert.equal(G.parseScriptOutput('DEVBOX-SHARES boot $(reboot)').boot, null);
});
