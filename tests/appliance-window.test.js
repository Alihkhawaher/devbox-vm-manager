'use strict';
/*
 * Appliance VMs, part 2 (2.3.0): the screen in a window on this PC with 3D
 * graphics (lib/appliance.js windowDisplay/qemuArgs), SSH to the guest's own
 * server with its own account (lib/ssh.js guestArgs/askpassEnv,
 * lib/sessions.js), the settings, and the window capture (lib/wincap.js).
 * The real window capture runs with WINCAP_E2E=1 on Windows (it opens a small
 * red window for a few seconds).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const st = require('../lib/state');
const tasks = require('../lib/tasks');
const ports = require('../lib/ports');
const appliance = require('../lib/appliance');
const vm = require('../lib/vm');
const ssh = require('../lib/ssh');
const sessions = require('../lib/sessions');
const wincap = require('../lib/wincap');
const png = require('../lib/png');
const ocr = require('../lib/ocr');
const { useTempRoot, resetConfig, rm } = require('./helpers');

function withRoot(label, fn) {
  const root = useTempRoot(label);
  tasks._reset();
  ports._resetClaims();
  st.loadState();
  return Promise.resolve().then(() => fn(root)).finally(() => {
    sessions.closeAllSessions();
    for (const k of Object.keys(st.state.vms)) delete st.state.vms[k];
    tasks._reset();
    resetConfig();
    rm(root);
  });
}

const DEVICE_HELP = 'Display devices:\nname "VGA", bus PCI\nname "virtio-vga", bus PCI\nname "virtio-vga-gl", bus PCI, desc "Virtio VGA"\n';
const DISPLAY_HELP = 'Available display backend types:\nnone\ngtk\nsdl\negl-headless\n\nSome display backends support suboptions, which can be set with\n';
const caps = (dev, disp) => ({ devices: new Set(dev), displays: new Set(disp) });

test('parseCaps: devices by name; the display list ends at the blank line', () => {
  const c = appliance.parseCaps(DEVICE_HELP, DISPLAY_HELP);
  assert.ok(c.devices.has('virtio-vga-gl'));
  assert.ok(c.devices.has('VGA'));
  assert.deepEqual([...c.displays], ['none', 'gtk', 'sdl', 'egl-headless']);
  assert.deepEqual([...appliance.parseCaps('', '').displays], []);
});

test('windowDisplay: GTK + OpenGL ES on Windows, plain SDL fallback, Cocoa on macOS, elsewhere only in a desktop session', () => {
  assert.deepEqual(appliance.windowDisplay(caps(['virtio-vga-gl'], ['gtk', 'sdl']), 'win32', {}),
    { display: 'gtk,gl=es,zoom-to-fit=on,window-close=off', gl: true, ui: 'gtk' });
  assert.equal(appliance.windowDisplay(caps([], ['gtk']), 'win32', {}).display, 'gtk,gl=off,zoom-to-fit=on,window-close=off');
  assert.deepEqual(appliance.windowDisplay(caps(['virtio-vga-gl'], ['sdl']), 'win32', {}), { display: 'sdl,window-close=off', gl: false, ui: 'sdl' });
  assert.match(appliance.windowDisplay(caps([], ['none']), 'win32', {}).error, /no window display/);
  assert.deepEqual(appliance.windowDisplay(caps(['virtio-vga-gl'], ['cocoa']), 'darwin', {}), { display: 'cocoa,zoom-to-fit=on', gl: false, ui: 'cocoa' });
  assert.match(appliance.windowDisplay(caps(['virtio-vga-gl'], ['gtk']), 'linux', {}).error, /desktop session/);
  assert.deepEqual(appliance.windowDisplay(caps(['virtio-vga-gl'], ['gtk']), 'linux', { DISPLAY: ':0' }),
    { display: 'gtk,gl=on,zoom-to-fit=on,window-close=off', gl: true, ui: 'gtk' });
  assert.equal(appliance.windowDisplay(caps([], ['sdl']), 'linux', { WAYLAND_DISPLAY: 'wayland-0' }).display, 'sdl,gl=off,window-close=off');
});

test('qemuArgs: the window view gets the 3D GPU and the window, no VNC; plain VGA stays plain; the browser view keeps VNC', () => {
  const base = { disk: 'D:/d/k.qcow2', media: null, firmware: null, vars: null, sound: null };
  const win = { display: 'gtk,gl=es,zoom-to-fit=on,window-close=off', gl: true };
  const rec = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'bios', display: 'window' } });
  const a = appliance.qemuArgs(rec, Object.assign({ display: null, window: win }, base));
  assert.equal(a.display, win.display);
  assert.equal(a.extra[a.extra.indexOf('virtio-vga-gl') - 1], '-device');
  assert.ok(!a.extra.includes('-vnc'));
  // a QEMU without 3D: a plain window
  const b = appliance.qemuArgs(rec, Object.assign({ display: null, window: { display: 'gtk,gl=off', gl: false } }, base));
  assert.ok(b.extra.includes('virtio-vga') && !b.extra.includes('virtio-vga-gl'));
  // an OS without a virtio-gpu driver keeps plain VGA, 3D or not
  const std = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'bios', display: 'window', vga: 'std' } });
  assert.ok(appliance.qemuArgs(std, Object.assign({ display: null, window: win }, base)).extra.includes('VGA,vgamem_mb=32'));
  // set to "window" but started without one (no window setting): the browser view, never a VM without a screen
  const nowin = appliance.qemuArgs(rec, Object.assign({ display: { host: '127.9.8.7', port: 5923 }, window: null }, base));
  assert.ok(nowin.extra.includes('-vnc'));
  assert.equal(nowin.display, 'none');
  // the browser view
  const br = st.newVmRecord({ kind: 'appliance', appliance: { firmware: 'bios' } });
  const c = appliance.qemuArgs(br, Object.assign({ display: { host: '127.9.8.7', port: 5923 }, window: null }, base));
  assert.equal(c.display, 'none');
  const i = c.extra.indexOf('-vnc');
  assert.deepEqual(c.extra.slice(i, i + 2), ['-vnc', '127.9.8.7:23,lossy=on']);
  assert.ok(c.extra.includes('virtio-vga'));
});

test('vm.qemuArgs: -display comes from the caller, none by default', () => {
  const o = { name: 'x', mem: 512, cpus: 1, accel: 'tcg', disk: 'd.qcow2', netdev: 'user,id=n0', mac: '52:54:00:00:00:01',
    monitor: { host: '127.0.0.1', port: 1 }, serial: { host: '127.0.0.1', port: 2 } };
  const disp = (args) => args.filter((x, i) => args[i - 1] === '-display');
  assert.deepEqual(disp(vm.qemuArgs(o)), ['none']);
  assert.deepEqual(disp(vm.qemuArgs(Object.assign({ display: 'gtk,gl=es' }, o))), ['gtk,gl=es']);
});

test('record: display and sshUser defaults and cleaning; the window flag survives the runtime cleaning', () => {
  const a = st.newVmRecord({ kind: 'appliance', appliance: {} });
  assert.equal(a.appliance.display, 'browser');
  assert.equal(a.appliance.sshUser, 'root');
  const b = st.newVmRecord({ kind: 'appliance', appliance: { display: 'window', sshUser: 'osmc' } });
  assert.equal(b.appliance.display, 'window');
  assert.equal(b.appliance.sshUser, 'osmc');
  const c = st.newVmRecord({ kind: 'appliance', appliance: { display: 'tv', sshUser: 'root; reboot' } });
  assert.equal(c.appliance.display, 'browser');
  assert.equal(c.appliance.sshUser, 'root');
  assert.equal(st.newVmRecord({ runtime: { pid: 5, monitor: { host: '127.1.2.3', port: 4 }, window: true } }).runtime.window, true);
  assert.equal(st.newVmRecord({ runtime: { pid: 5, monitor: { host: '127.1.2.3', port: 4 } } }).runtime.window, undefined);
});

test('validateCreate: display and sshUser are checked before anything else', () => withRoot('appl-win', async (root) => {
  const img = path.join(root, 'tiny.img');
  fs.writeFileSync(img, Buffer.alloc(4096));
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img, display: 'tv' }), (e) => e.status === 400 && /display/.test(e.message));
  await assert.rejects(appliance.validateCreate({ name: 'k', source: img, sshUser: 'a b' }), (e) => e.status === 400 && /sshUser/.test(e.message));
}));

test('updateSettings: display and sshUser belong to appliances and are checked; a stopped VM just saves them', () => withRoot('appl-set', async () => {
  st.state.vms.k = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2370, template: '' });
  st.state.vms.n = st.newVmRecord({ port: 2371, template: '' });
  await assert.rejects(vm.updateSettings({ name: 'n', display: 'window' }), (e) => e.status === 400);
  await assert.rejects(vm.updateSettings({ name: 'n', sshUser: 'osmc' }), (e) => e.status === 400);
  await assert.rejects(vm.updateSettings({ name: 'k', display: 'tv' }), (e) => e.status === 400);
  await assert.rejects(vm.updateSettings({ name: 'k', sshUser: 'a b' }), (e) => e.status === 400);
  const r = await vm.updateSettings({ name: 'k', display: 'window', sshUser: 'osmc' });
  assert.equal(r.vm.appliance.display, 'window');
  assert.equal(r.vm.appliance.sshUser, 'osmc');
  assert.equal(r.vm.sshCommand, 'ssh -p 2370 osmc@127.0.0.1');
  assert.equal(r.pendingRestart, false);
  assert.equal(st.state.vms.k.appliance.display, 'window');
  // the display waits for the VM to be free (a start reads it); the account does not
  let release;
  const gate = new Promise((res) => { release = res; });
  const holder = tasks.start({ kind: 'start', title: 'Start k', vm: 'k', locks: ['vm:k'] }, () => gate);
  try {
    await assert.rejects(vm.updateSettings({ name: 'k', display: 'browser' }), (e) => e.status === 409 && e.code === 'BUSY');
    assert.equal((await vm.updateSettings({ name: 'k', sshUser: 'root' })).vm.appliance.sshUser, 'root');
  } finally { release(); await tasks.wait(holder.id); }
}));

test('guest SSH: the manager key first, a password only through SSH_ASKPASS, BatchMode without one, a safe user name', () => withRoot('appl-ssh', async () => {
  const withPw = ssh.guestArgs({ name: 'k', port: 2370 }, { user: 'root', password: true, tty: true, cmd: 'id' });
  assert.ok(withPw.includes('BatchMode=no'));
  assert.ok(withPw.includes('PreferredAuthentications=publickey,keyboard-interactive,password'));
  assert.ok(withPw.includes('NumberOfPasswordPrompts=1'));
  assert.ok(withPw.includes('StrictHostKeyChecking=accept-new'));
  assert.deepEqual(withPw.slice(-5), ['-p', '2370', '-tt', 'root@127.0.0.1', 'id']);
  const noPw = ssh.guestArgs({ name: 'k', port: 2370 }, { user: 'osmc' });
  assert.ok(noPw.includes('BatchMode=yes'));
  assert.equal(noPw[noPw.length - 1], 'osmc@127.0.0.1');
  // what is not a plain user name never reaches the command line
  assert.equal(ssh.guestArgs({ name: 'k', port: 2370 }, { user: '-oProxyCommand=x' }).slice(-1)[0], 'root@127.0.0.1');
  assert.equal(ssh.guestCommandText(2370, 'osmc'), 'ssh -p 2370 osmc@127.0.0.1');
  assert.equal(ssh.guestCommandText(2370, 'a b'), 'ssh -p 2370 root@127.0.0.1');
}));

test('askpass: the helper prints the one-time password once and deletes it; cleanup removes an unused one', () => withRoot('appl-askpass', async () => {
  const runHelper = (env) => (process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', env.SSH_ASKPASS], { env: Object.assign({}, process.env, env), encoding: 'utf8', windowsHide: true })
    : spawnSync(env.SSH_ASKPASS, [], { env: Object.assign({}, process.env, env), encoding: 'utf8' }));
  const ap = ssh.askpassEnv('s3cret pass!');
  try {
    assert.equal(fs.readFileSync(ap.file, 'utf8'), 's3cret pass!');
    assert.equal(ap.env.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(ap.env.DEVBOX_ASKPASS_FILE, ap.file);
    const first = runHelper(ap.env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, 's3cret pass!\n');
    assert.equal(fs.existsSync(ap.file), false);
    const second = runHelper(ap.env);
    assert.notEqual(second.status, 0);
    assert.equal(second.stdout, '');
  } finally { ap.cleanup(); }
  const unused = ssh.askpassEnv('x');
  unused.cleanup();
  assert.equal(fs.existsSync(unused.file), false);
}));

test('sessions.open: an appliance takes its guest account and a password; other VMs refuse a password', () => withRoot('appl-sess', async () => {
  st.state.vms.k = st.newVmRecord({ kind: 'appliance', appliance: { sshUser: 'osmc' }, port: 2372, template: '' });
  st.state.vms.n = st.newVmRecord({ port: 2373, template: '' });
  await assert.rejects(sessions.open({ name: 'n', kind: 'ssh', password: 'x' }), (e) => e.status === 400 && /password/.test(e.message));
  await assert.rejects(sessions.open({ name: 'k', kind: 'ssh', user: 'a b' }), (e) => e.status === 400);
  await assert.rejects(sessions.open({ name: 'k', kind: 'ssh', password: 'two\nlines' }), (e) => e.status === 400);
  await assert.rejects(sessions.open({ name: 'k', kind: 'ssh', password: 5 }), (e) => e.status === 400);
  // good input; the VM is not running
  await assert.rejects(sessions.open({ name: 'k', kind: 'ssh', user: 'admin', password: 'x' }), (e) => e.status === 409 && e.code === 'NOT_RUNNING');
}));

test('screen: a VM shown in a window refuses the browser relay but still takes keys; a stopped one is NOT_RUNNING', () => withRoot('appl-scr', async () => {
  const screen = require('../lib/screen');
  st.state.vms.w = st.newVmRecord({ kind: 'appliance', appliance: { display: 'window' }, port: 2374, template: '',
    runtime: { pid: 4242, monitor: { host: '127.0.0.1', port: 1 }, window: true } });
  assert.deepEqual(screen.screenOf('w').window, true);
  assert.throws(() => screen.displayOf('w'), (e) => e.status === 409 && e.code === 'IN_WINDOW');
  st.state.vms.s = st.newVmRecord({ kind: 'appliance', appliance: {}, port: 2375, template: '' });
  assert.throws(() => screen.screenOf('s'), (e) => e.status === 409 && e.code === 'NOT_RUNNING');
  await assert.rejects(screen.sendKeys('w', 'nokey!'), (e) => e.status === 400);
}));

test('wincap.parseReply: the last JSON line; anything else is a failure', () => {
  assert.deepEqual(wincap.parseReply('noise\r\n{"ok":true,"width":640,"height":480}\r\n'), { ok: true, width: 640, height: 480 });
  assert.equal(wincap.parseReply('').ok, false);
  assert.equal(wincap.parseReply('{bad').ok, false);
  if (process.platform !== 'win32') assert.equal(wincap.available().ok, false);
});

test('wincap.capture and fit: a real window, its client area as PPM, then sized (WINCAP_E2E=1, Windows)', { skip: process.platform !== 'win32' || process.env.WINCAP_E2E !== '1' }, () => withRoot('appl-wincap', async () => {
  const script = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'devbox-wincap-test'; " +
    "$f.BackColor = [Drawing.Color]::FromArgb(255, 0, 0); $f.Width = 420; $f.Height = 300; $f.StartPosition = 'CenterScreen'; [void]$f.ShowDialog()";
  const ps = spawn(ocr.powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  try {
    let img = null, last = null;
    for (let i = 0; i < 30 && !img; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { img = png.parsePpm(await wincap.capture(ps.pid)); } catch (e) { last = e; img = null; }
    }
    assert.ok(img, 'captured: ' + (last && last.message));
    assert.ok(img.width >= 300 && img.height >= 180, img.width + 'x' + img.height);
    const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 3;
    assert.deepEqual([...img.pixels.subarray(mid, mid + 3)], [255, 0, 0]);
    // the C# part was compiled once into the run folder
    assert.ok(fs.readdirSync(path.join(require('../lib/config').CFG.runDir, 'wincap')).some((f) => /^devbox-wincap-[0-9A-F]{16}\.dll$/.test(f)));
    // fit: the client area becomes 500x300 (in the window's units; the capture is in
    // physical pixels, so only the proportions are compared - a scaled display differs)
    const f = await wincap.fit(ps.pid, 500, 300);
    assert.equal(f.width, 500);
    assert.equal(f.height, 300);
    await new Promise((r) => setTimeout(r, 400));
    const after = png.parsePpm(await wincap.capture(ps.pid));
    assert.ok(Math.abs(after.width / after.height - 500 / 300) < 0.05, after.width + 'x' + after.height);
  } finally { try { ps.kill(); } catch (e) { /* gone */ } }
}));
