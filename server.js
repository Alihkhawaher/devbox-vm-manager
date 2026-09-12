#!/usr/bin/env node
/*
 * devbox VM Manager - local control panel for the QEMU sandboxes.
 *
 * Node standard library only: no npm install, no admin rights, no daemons.
 * Serves a browser GUI on http://127.0.0.1:8777
 *
 * Capabilities:
 *   - prerequisite checks + one-click install of QEMU and the guest base image
 *   - create / start / stop / delete sandbox VMs (instant copy-on-write clones)
 *   - live monitoring: VM status, SSH readiness, host RAM/disk, per-VM serial log
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');

// --------------------------------------------------------------------------
// configuration
// --------------------------------------------------------------------------
// Data root. Defaults to the user's home directory (so on the machine this was
// written on it resolves to the original layout) and can be overridden with
// VM_MANAGER_ROOT for a different layout.
const ROOT = (process.env.VM_MANAGER_ROOT || os.homedir()).replace(/\\/g, '/').replace(/\/+$/, '');
// Same location in MSYS/git-bash form (/c/Users/... on Windows), used by the
// generated launcher scripts.
const POSIX_ROOT = '/' + ROOT.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase());
const CFG = {
  qemuDir: ROOT + '/qemu',
  base: ROOT + '/devbox-base.qcow2',
  alpine: ROOT + '/vm-alpine.qcow2',
  sandboxDir: ROOT + '/sandboxes',
  basesDir: ROOT + '/vm-bases',
  seedDir: ROOT + '/seed',
  sshKey: ROOT + '/seed/id_dev',
  sshPub: ROOT + '/seed/id_dev.pub',
  // Do NOT use the Windows NUL device as UserKnownHostsFile: MSYS ssh treats it
  // as a literal filename and recreates a junk 'NUL' file in the working dir.
  sshKnownHosts: ROOT + '/seed/known_hosts',
  serverPort: 8777,
  seedPort: 8000,
  stateFile: path.join(__dirname, 'vms.json'),
  firstPort: 2223,
  defaultMem: 1024,
  defaultCpus: 2,
  maxMem: 6144,
};
const QEMU = CFG.qemuDir + '/qemu-system-x86_64.exe';
const QEMU_IMG = CFG.qemuDir + '/qemu-img.exe';
const SEVENZIP = 'C:/Program Files/7-Zip/7z.exe';
const SSH = 'C:/Windows/System32/OpenSSH/ssh.exe';
const KEYGEN = 'C:/Windows/System32/OpenSSH/ssh-keygen.exe';

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
const nowIso = () => new Date().toISOString();

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, opts || {}),
      (err, stdout, stderr) => resolve({
        code: err ? (err.code === undefined ? 1 : err.code) : 0,
        stdout: String(stdout || ''), stderr: String(stderr || ''), error: err || null,
      }));
  });
}

function runSync(cmd, args) {
  try {
    const r = require('child_process').execFileSync(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(r).trim();
  } catch (e) { return ''; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Probe a forwarded port: only a real sshd banner means the guest is usable.
function probeSsh(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false, buf = '';
    const done = (v) => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) {} resolve(v); };
    const sock = net.connect({ host: '127.0.0.1', port: port });
    sock.setTimeout(timeoutMs || 1500);
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.indexOf('SSH-') === 0 || buf.indexOf('SSH-') > -1) done(true); });
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
    sock.on('close', () => done(false));
  });
}

// Is anything at all listening on the forwarded port (i.e. QEMU is up)?
function portListening(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: port });
    const done = (v) => { try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(timeoutMs || 1200);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

// Map every listening TCP port to its owning pid, from one netstat call.
function portPidMap() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const map = {};
      if (!err && stdout) {
        for (const line of String(stdout).split('\n')) {
          const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
          if (m) map[parseInt(m[1], 10)] = parseInt(m[2], 10);
        }
      }
      resolve(map);
    });
  });
}

// A VM is identified by the port it listens on rather than a remembered pid,
// so a visible-console launch (where `start` hides the real pid) still works.
async function pidForPort(port) {
  const m = await portPidMap();
  return m[port] || null;
}

// --------------------------------------------------------------------------
// persistent state
// --------------------------------------------------------------------------
let state = { vms: {}, nextPort: CFG.firstPort };

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    state.vms = raw.vms || {};
    state.nextPort = raw.nextPort || CFG.firstPort;
  } catch (e) { /* first run */ }
  for (const name of listDisks()) ensureVm(name);
  pruneMissing();
  saveState();
}
function saveState() {
  try { fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2)); } catch (e) {}
}
function pruneMissing() {
  for (const n of Object.keys(state.vms)) if (!exists(diskPath(n))) delete state.vms[n];
}
function diskPath(name) { return path.join(CFG.sandboxDir, safeName(name) + '.qcow2'); }
function logPath(name) { return path.join(CFG.sandboxDir, safeName(name) + '-serial.log'); }
function safeName(n) { return String(n).replace(/[^A-Za-z0-9._-]/g, '_'); }
function listDisks() {
  try { return fs.readdirSync(CFG.sandboxDir).filter((f) => f.endsWith('.qcow2')).map((f) => f.replace(/\.qcow2$/, '')); }
  catch (e) { return []; }
}
function ensureVm(name) {
  name = safeName(name);
  if (!state.vms[name]) {
    let p = state.nextPort || CFG.firstPort;
    const used = new Set(Object.values(state.vms).map((v) => v.port));
    while (used.has(p)) p++;
    state.vms[name] = { port: p, mem: CFG.defaultMem, cpus: CFG.defaultCpus, pid: null, startedAt: null, createdAt: nowIso(), ports: [] };
    state.nextPort = p + 1;
  }
  return state.vms[name];
}
function allocPort() {
  const used = new Set(Object.values(state.vms).map((v) => v.port));
  let p = CFG.firstPort;
  while (used.has(p) || p === CFG.serverPort) p++;
  return p;
}

// --------------------------------------------------------------------------
// tasks (one long-running operation at a time, with a live log)
// --------------------------------------------------------------------------
let task = { name: null, status: 'idle', log: [], startedAt: null, endedAt: null, error: null };
// While a composite operation (one-shot deploy) runs its sub-operations, keep a
// single continuous task log instead of letting each sub-op reset it.
let KEEP_TASK = false;

function beginTask(name) {
  if (KEEP_TASK) return;
  task = { name: name, status: 'running', log: [], startedAt: Date.now(), endedAt: null, error: null };
}
function tlog(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  task.log.push('[' + t + '] ' + msg);
  if (task.log.length > 800) task.log.splice(0, task.log.length - 800);
}
function endTask(err) {
  if (KEEP_TASK) { if (err) tlog('ERROR: ' + String((err && err.message) || err)); return; }
  task.status = err ? 'error' : 'done';
  task.endedAt = Date.now();
  if (err) { task.error = String((err && err.message) || err); tlog('ERROR: ' + task.error); }
}

// --------------------------------------------------------------------------
// downloads with progress
// --------------------------------------------------------------------------
function download(url, dest, label) {
  return new Promise((resolve, reject) => {
    const go = (u, depth) => {
      if (depth > 8) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'vm-manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0, lastPct = -5;
        const ws = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          const pct = total ? Math.floor((got / total) * 100) : 0;
          if (pct >= lastPct + 5) { lastPct = pct; tlog(label + ': ' + pct + '% (' + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : '') + ')'); }
        });
        res.pipe(ws);
        ws.on('finish', () => { tlog(label + ': download complete (' + fmtBytes(got) + ')'); resolve(dest); });
        ws.on('error', reject);
      }).on('error', reject);
    };
    go(url, 0);
  });
}

function fetchText(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vm-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 8) {
        res.resume(); return resolve(fetchText(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

// --------------------------------------------------------------------------
// cloud-init seed server (used only while baking a fresh base image)
// --------------------------------------------------------------------------
let seedServer = null;

function pubKey() {
  try { return fs.readFileSync(CFG.sshPub, 'utf8').trim().split('\n')[0]; }
  catch (e) { return null; }
}

function buildSeed() {
  const key = pubKey();
  if (!key) throw new Error('SSH public key missing: ' + CFG.sshPub);
  const meta = 'instance-id: devbox-manager-1\nlocal-hostname: devbox\n';
  const user = [
    '#cloud-config',
    'hostname: devbox',
    'manage_etc_hosts: true',
    'ssh_pwauth: false',
    'disable_root: false',
    'users:',
    '  - name: dev',
    '    gecos: Dev User',
    '    groups: wheel',
    '    shell: /bin/ash',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    '      - ' + key,
    'runcmd:',
    '  - [ sh, -c, "echo \'=== BAKE START ===\' >> /dev/ttyS0" ]',
    '  - [ sh, -c, "mkdir -p /root/.ssh /home/dev/.ssh;',
    '      printf \'%s\\\\n\' \'' + key + '\' >> /root/.ssh/authorized_keys;',
    '      printf \'%s\\\\n\' \'' + key + '\' >> /home/dev/.ssh/authorized_keys;',
    '      chmod 700 /root/.ssh /home/dev/.ssh; chmod 600 /root/.ssh/authorized_keys /home/dev/.ssh/authorized_keys;',
    '      chown -R dev:dev /home/dev/.ssh 2>/dev/null || true" ]',
    // Locked shadow entries block pubkey auth (sshd here has no PAM): force to "*".
    '  - [ sh, -c, "sed -i \'s|^dev:[^:]*:|dev:*:|\' /etc/shadow; sed -i \'s|^root:[^:]*:|root:*:|\' /etc/shadow;',
    '      grep -E \'^(dev|root):\' /etc/shadow >> /dev/ttyS0 2>&1" ]',
    '  - [ sh, -c, "if grep -q \'^ttyS0::respawn\' /etc/inittab; then',
    '      sed -i \'s|^ttyS0::respawn:.*|ttyS0::respawn:/bin/login -f root|\' /etc/inittab;',
    '      else echo \'ttyS0::respawn:/bin/login -f root\' >> /etc/inittab; fi;',
    '      rc-update add sshd default >/dev/null 2>&1 || true" ]',
    '  - [ sh, -c, "echo \'--- toolchain ---\' >> /dev/ttyS0; apk update >> /dev/ttyS0 2>&1;',
    '      apk add --no-cache bash git curl jq make gcc musl-dev python3 py3-pip vim nano tree htop strace coreutils >> /dev/ttyS0 2>&1;',
    '      python3 -V >> /dev/ttyS0 2>&1; git --version >> /dev/ttyS0 2>&1" ]',
    // Make clones self-contained: no datasource needed on later boots.
    '  - [ sh, -c, "touch /etc/cloud/cloud-init.disabled;',
    '      rc-update del cloud-init default >/dev/null 2>&1 || true;',
    '      rc-update del cloud-init-local default >/dev/null 2>&1 || true;',
    '      rc-update del cloud-final default >/dev/null 2>&1 || true" ]',
    '  - [ sh, -c, "echo \'=== BAKE END ===\' >> /dev/ttyS0" ]',
    'final_message: "base baked after $UPTIME seconds"',
    ''
  ].join('\n');
  return { meta: meta, user: user };
}

function startSeedServer() {
  if (seedServer) return Promise.resolve();
  const seed = buildSeed();
  return new Promise((resolve, reject) => {
    seedServer = http.createServer((req, res) => {
      const u = (req.url || '').split('?')[0];
      if (u === '/meta-data') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(seed.meta); }
      if (u === '/user-data') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(seed.user); }
      res.writeHead(404); res.end();
    });
    seedServer.on('error', reject);
    seedServer.listen(CFG.seedPort, '127.0.0.1', () => resolve());
  });
}
function stopSeedServer() {
  if (seedServer) { try { seedServer.close(); } catch (e) {} seedServer = null; }
}

// --------------------------------------------------------------------------
// prerequisites
// --------------------------------------------------------------------------
let qemuVersionCache = null;
function qemuVersion() {
  if (qemuVersionCache !== null) return qemuVersionCache;
  qemuVersionCache = exists(QEMU) ? (runSync(QEMU, ['--version']).split('\n')[0] || 'unknown') : '';
  return qemuVersionCache;
}

function prereqs() {
  return {
    qemu: { ok: exists(QEMU), label: 'QEMU emulator', detail: exists(QEMU) ? qemuVersion() : 'not installed', action: 'install-qemu' },
    sevenzip: { ok: exists(SEVENZIP), label: '7-Zip (needed to unpack QEMU)', detail: exists(SEVENZIP) ? 'present' : 'missing - install 7-Zip manually', action: null },
    sshkey: { ok: exists(CFG.sshKey), label: 'SSH key', detail: exists(CFG.sshKey) ? CFG.sshKey : 'will be generated', action: null },
    alpine: { ok: exists(CFG.alpine), label: 'Alpine guest image', detail: exists(CFG.alpine) ? fmtBytes(sizeOf(CFG.alpine)) : 'not downloaded', action: null },
    base: { ok: exists(CFG.base), label: 'Golden base image (template for clones)', detail: exists(CFG.base) ? fmtBytes(sizeOf(CFG.base)) : 'not built', action: 'build-base' },
  };
}

// --------------------------------------------------------------------------
// long-running operations
// --------------------------------------------------------------------------
async function opInstallQemu() {
  beginTask('install-qemu');
  if (!exists(SEVENZIP)) throw new Error('7-Zip not found at ' + SEVENZIP + ' - install it first');
  tlog('Looking up the latest QEMU Windows build...');
  const listing = await fetchText('https://qemu.weilnetz.de/w64/');
  const hits = listing.match(/qemu-w64-setup-\d{8}\.exe/g) || [];
  if (!hits.length) throw new Error('could not find any qemu-w64-setup-*.exe in the build listing');
  const file = hits.sort().pop();
  const year = file.slice('qemu-w64-setup-'.length, 'qemu-w64-setup-'.length + 4);
  const url = 'https://qemu.weilnetz.de/w64/' + year + '/' + file;
  tlog('Latest build: ' + file);
  const dlDir = ROOT + '/qemu-dl';
  fs.mkdirSync(dlDir, { recursive: true });
  const setup = path.join(dlDir, file);
  if (!exists(setup)) await download(url, setup, 'QEMU installer');
  else tlog('Installer already downloaded: ' + file);
  tlog('Extracting to ' + CFG.qemuDir + ' (this replaces any existing copy)...');
  fs.mkdirSync(CFG.qemuDir, { recursive: true });
  const r = await run(SEVENZIP, ['x', setup, '-o' + CFG.qemuDir, '-y']);
  if (r.code !== 0) throw new Error('7-Zip extraction failed: ' + (r.stderr || r.stdout).slice(0, 400));
  if (!exists(QEMU)) throw new Error('extraction finished but qemu-system-x86_64.exe was not found');
  qemuVersionCache = null;
  tlog('QEMU installed: ' + qemuVersion());
  tlog('Removing the installer to free space...');
  try { fs.unlinkSync(setup); } catch (e) {}
  endTask(null);
}

async function pickAlpineUrl() {
  tlog('Finding the latest Alpine cloud image...');
  for (const branch of ['v3.21', 'v3.20', 'v3.22']) {
    try {
      const list = await fetchText('https://dl-cdn.alpinelinux.org/alpine/' + branch + '/releases/cloud/');
      const hits = list.match(/nocloud_alpine-[\d.]+-x86_64-bios-cloudinit-r0\.qcow2/g) || [];
      if (hits.length) {
        const pick = hits.sort((a, b) => {
          const pa = a.match(/alpine-([\d.]+)-/)[1].split('.').map(Number);
          const pb = b.match(/alpine-([\d.]+)-/)[1].split('.').map(Number);
          for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
          return 0;
        }).pop();
        return 'https://dl-cdn.alpinelinux.org/alpine/' + branch + '/releases/cloud/' + pick;
      }
    } catch (e) { /* try next branch */ }
  }
  throw new Error('could not locate an Alpine nocloud cloud image');
}

async function waitForMarker(file, marker, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exists(file)) {
      try {
        const txt = fs.readFileSync(file, 'utf8');
        if (txt.indexOf(marker) !== -1) return true;
      } catch (e) {}
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function opBuildBase() {
  beginTask('build-base');
  if (!exists(QEMU) || !exists(QEMU_IMG)) throw new Error('QEMU is not installed yet - install it first');
  fs.mkdirSync(CFG.seedDir, { recursive: true });
  fs.mkdirSync(CFG.sandboxDir, { recursive: true });

  // 1. SSH key (needed inside the guest)
  if (!exists(CFG.sshKey)) {
    tlog('Generating an SSH keypair for the VMs...');
    const kg = exists(KEYGEN) ? KEYGEN : 'ssh-keygen';
    const r = await run(kg, ['-t', 'ed25519', '-N', '', '-C', 'vm-manager', '-f', CFG.sshKey]);
    if (r.code !== 0 || !exists(CFG.sshKey)) throw new Error('ssh-keygen failed: ' + (r.stderr || r.stdout).slice(0, 300));
    tlog('Key created: ' + CFG.sshKey);
  } else tlog('SSH key already present');

  // 2. Guest image
  if (!exists(CFG.alpine)) {
    const url = await pickAlpineUrl();
    tlog('Image: ' + url.split('/').pop());
    await download(url, CFG.alpine, 'Alpine image');
    tlog('Growing the disk by 8G...');
    await run(QEMU_IMG, ['resize', CFG.alpine, '+8G']);
  } else tlog('Guest image already present: ' + fmtBytes(sizeOf(CFG.alpine)));

  // 3. Serve the cloud-init seed and boot once to configure the guest
  tlog('Starting the local cloud-init seed server on port ' + CFG.seedPort + '...');
  await startSeedServer();
  try {
    tlog('Booting the guest to install the toolchain (this takes several minutes)...');
    const log = path.join(CFG.sandboxDir, 'base-bake.log');
    try { fs.unlinkSync(log); } catch (e) {}
    const fd = fs.openSync(log, 'w');
    const child = spawn(QEMU, [
      '-accel', 'tcg', '-m', '2048', '-smp', '2', '-cpu', 'max',
      '-drive', 'file=' + CFG.alpine + ',if=virtio,format=qcow2',
      '-netdev', 'user,id=n0,hostfwd=tcp::2222-:22',
      '-device', 'virtio-net-pci,netdev=n0',
      '-smbios', 'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:' + CFG.seedPort + '/',
      '-nographic', '-no-reboot',
    ], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    tlog('QEMU pid ' + child.pid + ' - waiting for the bake to finish (up to 20 min)...');
    const ok = await waitForMarker(log, '=== BAKE END ===', 20 * 60 * 1000);
    if (!ok) {
      try { process.kill(child.pid); } catch (e) {}
      throw new Error('bake timed out - see ' + log);
    }
    tlog('Bake finished. Shutting the guest down cleanly...');
    await run(SSH, ['-i', CFG.sshKey, '-p', '2222', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + CFG.sshKnownHosts,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'root@127.0.0.1', 'sync; poweroff']);
    for (let i = 0; i < 30; i++) {
      if (!pidAlive(child.pid)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (pidAlive(child.pid)) { try { process.kill(child.pid); } catch (e) {} }
    tlog('Freezing the golden base image...');
    fs.copyFileSync(CFG.alpine, CFG.base);
    tlog('Base ready: ' + fmtBytes(sizeOf(CFG.base)) + ' - sandboxes can now be created instantly');
  } finally {
    stopSeedServer();
  }
  endTask(null);
}

// --------------------------------------------------------------------------
// VM lifecycle
// --------------------------------------------------------------------------
function macForPort(port) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return '52:54:00:00:' + h(Math.floor(port / 256) % 256) + ':' + h(port % 256);
}

// SSH is always forwarded; any extra host->guest ports live in vm.ports so a
// sandbox can serve web apps (Immich on 2283, Gitea on 3000, ...).
function netdevFor(vm) {
  let nd = 'user,id=n0,hostfwd=tcp::' + vm.port + '-:22';
  for (const p of (vm.ports || [])) {
    if (p && p.host && p.guest) nd += ',hostfwd=tcp::' + p.host + '-:' + p.guest;
  }
  return nd;
}

// QEMU fixes host forwards at launch, so adding one used to mean restarting the
// VM (~90s). Its monitor can add them to a RUNNING vm instead, which removes that
// cost entirely. The monitor listens on loopback only, on a port derived from the
// SSH port so each VM gets its own.
const monitorPortFor = (vm) => 25000 + (vm.port - 2222);

function monitorCmd(port, cmd, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '', settled = false;
    let s;
    const done = (v) => { if (settled) return; settled = true; try { s.destroy(); } catch (e) {} resolve(v); };
    s = net.connect({ host: '127.0.0.1', port: port });
    s.setTimeout(timeoutMs || 6000, () => done(buf || 'TIMEOUT'));
    s.on('error', (e) => done('ERROR: ' + e.message));
    s.on('connect', () => setTimeout(() => s.write(cmd + '\n'), 150));
    s.on('data', (d) => {
      buf += d.toString();
      // the monitor answers with a "(qemu) " prompt once the command is done
      if (buf.length > cmd.length && /\(qemu\)/.test(buf)) setTimeout(() => done(buf), 250);
    });
  });
}

async function addForwardLive(vm, host, guest) {
  const mp = monitorPortFor(vm);
  if (!(await portListening(mp, 900))) return { ok: false, why: 'no monitor listening on ' + mp };
  const raw = await monitorCmd(mp, 'hostfwd_add n0 tcp::' + host + '-:' + guest);
  const body = String(raw).replace(/\(qemu\)/g, '').trim();
  if (/could not|error|invalid|unknown|not found|failed/i.test(body)) {
    return { ok: false, why: body.slice(0, 160) || 'monitor rejected the command' };
  }
  for (let i = 0; i < 12; i++) {
    if (await portListening(host, 500)) return { ok: true };
    await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: false, why: 'accepted but port ' + host + ' never began listening' };
}

function parsePortSpec(spec, sshPort) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d{1,5})(?::(\d{1,5}))?$/);
    if (!m) throw new Error('bad port mapping "' + t + '" - use host:guest, e.g. 2283:2283');
    const host = parseInt(m[1], 10);
    const guest = parseInt(m[2] || m[1], 10);
    if (host < 1 || host > 65535 || guest < 1 || guest > 65535) throw new Error('port out of range: ' + t);
    if (host === sshPort) throw new Error('port ' + host + ' is reserved for SSH');
    if (out.some((p) => p.host === host)) throw new Error('duplicate host port ' + host);
    out.push({ host: host, guest: guest });
  }
  return out;
}

async function opCreate(name, mem, cpus, port, baseName) {
  beginTask('create');
  name = safeName(name);
  if (!name) throw new Error('a name is required');
  const baseFile = findBase(baseName);
  if (!exists(baseFile)) throw new Error('base image not found: ' + (baseName || CFG.base));
  if (exists(diskPath(name))) throw new Error('a sandbox called "' + name + '" already exists');
  const vm = ensureVm(name);
  vm.mem = Math.min(Math.max(parseInt(mem, 10) || CFG.defaultMem, 256), CFG.maxMem);
  vm.cpus = Math.min(Math.max(parseInt(cpus, 10) || CFG.defaultCpus, 1), 8);
  if (port) vm.port = parseInt(port, 10);
  vm.base = baseFile;
  tlog('Creating linked clone "' + name + '" from ' + path.basename(baseFile) + ' ...');
  const r = await run(QEMU_IMG, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', baseFile, diskPath(name)]);
  if (r.code !== 0) throw new Error('qemu-img create failed: ' + (r.stderr || r.stdout).slice(0, 300));
  vm.createdAt = nowIso();
  saveState();
  tlog('Created "' + name + '"  port ' + vm.port + '  ' + vm.mem + 'MB  ' + vm.cpus + ' vCPU  (' + fmtBytes(sizeOf(diskPath(name))) + ' on disk)');
  endTask(null);
  return vm;
}

// A just-stopped QEMU can hold its listening socket for a moment after the
// process dies. Starting a replacement immediately then fails the "port in use"
// check, so wait for the socket to actually clear first.
async function waitPortFree(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    if (!(await portListening(port, 600))) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return !(await portListening(port, 600));
}

async function opStart(name, showConsole) {
  beginTask('start');
  name = safeName(name);
  const vm = state.vms[name];
  if (!vm) throw new Error('no such sandbox: ' + name);
  if (!exists(diskPath(name))) throw new Error('disk image is missing');
  if (pidAlive(vm.pid)) throw new Error('already running (pid ' + vm.pid + ')');
  if (!exists(QEMU)) throw new Error('QEMU is not installed');
  if (await portListening(vm.port, 800)) throw new Error('port ' + vm.port + ' is already in use by something else');
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < vm.mem + 256) {
    tlog('WARNING: only ' + freeMB + ' MB free on the host but this VM wants ' + vm.mem + ' MB - it may be slow or fail to boot.');
  } else {
    tlog('Host memory free: ' + freeMB + ' MB - request fits.');
  }
  const qargs = [
    '-accel', 'tcg', '-m', String(vm.mem), '-smp', String(vm.cpus), '-cpu', 'max',
    '-drive', 'file=' + diskPath(name) + ',if=virtio,format=qcow2',
    '-netdev', netdevFor(vm),
    '-device', 'virtio-net-pci,netdev=n0,mac=' + macForPort(vm.port),
    '-nographic', '-no-reboot',
    // keep the monitor off stdio (so the serial console stays readable) and put
    // it on loopback where the manager can add port forwards at runtime
    '-monitor', 'tcp:127.0.0.1:' + monitorPortFor(vm) + ',server,nowait',
  ];

  if (showConsole) {
    // A visible console window IS the live serial console (passwordless root
    // shell) and you can type into it - but closing it kills the VM, because
    // a console close sends CTRL_CLOSE_EVENT to everything attached. Opt-in.
    tlog('Opening a visible console window - note: closing that window KILLS this VM.');
    const bat = path.join(CFG.sandboxDir, safeName(name) + '-boot.cmd');
    const bashCmd = 'cd ' + POSIX_ROOT + '/qemu && ./qemu-system-x86_64.exe ' + qargs.join(' ') +
      ' 2>&1 | tee ' + POSIX_ROOT + '/sandboxes/' + safeName(name) + '-serial.log';
    fs.writeFileSync(bat, [
      '@echo off', 'setlocal',
      'title ' + name + ' (port ' + vm.port + ') started %TIME:~0,8%',
      'echo ============================================================',
      'echo   ' + name + '  -  closing THIS WINDOW KILLS THE VM',
      'echo   SSH: ssh -i ' + CFG.sshKey + ' -p ' + vm.port + ' root@127.0.0.1',
      'echo ============================================================',
      '"C:\\Program Files\\Git\\bin\\bash.exe" -lc "' + bashCmd + '"',
      'title [ENDED] ' + name + ' (port ' + vm.port + ')',
      'echo.', 'echo   VM HAS EXITED - THIS WINDOW IS NOW STALE',
      'timeout /t 20 /nobreak >nul', 'exit /b 0', '',
    ].join('\r\n'));
    spawn('cmd', ['/c', 'start', '', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    vm.pid = null;
  } else {
    const fd = fs.openSync(logPath(name), 'w');
    const child = spawn(QEMU, qargs, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    vm.pid = child.pid;
  }
  vm.startedAt = nowIso();
  saveState();
  tlog('Booting - expect SSH-ready in ~85s. Tracked by port ' + vm.port + '.');
  tlog('SSH: ssh -i ' + CFG.sshKey + ' -p ' + vm.port + ' root@127.0.0.1');
  endTask(null);
}

async function opStop(name, force) {
  beginTask('stop');
  name = safeName(name);
  const vm = state.vms[name];
  if (!vm) throw new Error('no such sandbox: ' + name);
  const pid = await pidForPort(vm.port);
  if (!pid) { vm.pid = null; vm.startedAt = null; saveState(); tlog(name + ' is not running'); endTask(null); return; }
  tlog(name + ' is pid ' + pid + ' (port ' + vm.port + ')');

  if (!force && await probeSsh(vm.port)) {
    tlog('Asking the guest to power off cleanly over SSH...');
    await run(SSH, ['-i', CFG.sshKey, '-p', String(vm.port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + CFG.sshKnownHosts,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', 'root@127.0.0.1', 'sync; sync; poweroff']);
    for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 1000));
  } else if (!force) {
    tlog('Guest is not SSH-ready; sending a hard stop.');
  }
  if (pidAlive(pid)) {
    tlog('Force-killing pid ' + pid + '...');
    try { process.kill(pid); } catch (e) {}
    for (let i = 0; i < 10 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 500));
  }
  const stillUp = pidAlive(pid);
  vm.pid = null; vm.startedAt = null; saveState();
  tlog(stillUp ? 'Warning: process may still be alive' : name + ' stopped');
  endTask(null);
}

async function opDelete(name) {
  beginTask('delete');
  name = safeName(name);
  const vm = state.vms[name];
  if (!vm) throw new Error('no such sandbox: ' + name);
  if (pidAlive(vm.pid)) {
    tlog('Stopping "' + name + '" before deleting...');
    await opStop(name, false);
    beginTask('delete');
  }
  for (const f of [diskPath(name), logPath(name)]) {
    if (exists(f)) { fs.unlinkSync(f); tlog('Deleted ' + path.basename(f)); }
  }
  delete state.vms[name];
  saveState();
  tlog('Sandbox "' + name + '" removed');
  endTask(null);
}

// --------------------------------------------------------------------------
// in-browser terminal sessions
//
// The system ssh.exe is the transport (so still no npm dependencies) and its
// stdio is bridged to the browser: output as Server-Sent Events, input as POST.
// Closing the tab just ends the ssh client - the VM is never affected, which is
// exactly why this is safer than driving the QEMU console window.
// --------------------------------------------------------------------------
const sessions = new Map();
let sessionSeq = 1;
const SSH_MAX_BUF = 200000;

async function openTerminal(name, user) {
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (!(await pidForPort(vm.port))) throw new Error('"' + nm + '" is not running - start it first');
  if (!(await probeSsh(vm.port, 3000))) throw new Error('the guest is still booting - SSH is not ready yet');
  const u = (user === 'dev') ? 'dev' : 'root';

  const child = spawn(SSH, [
    '-tt',
    '-i', CFG.sshKey,
    '-p', String(vm.port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=' + CFG.sshKnownHosts,
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    u + '@127.0.0.1',
  ], { windowsHide: true });

  const id = 't' + (sessionSeq++);
  const sess = { id: id, name: nm, user: u, child: child, res: null, buf: '', closed: false };
  sessions.set(id, sess);

  const push = (text) => {
    if (!text) return;
    sess.buf = (sess.buf + text).slice(-SSH_MAX_BUF);
    if (sess.res) { try { sess.res.write('data: ' + JSON.stringify({ t: text }) + '\n\n'); } catch (e) {} }
  };
  child.stdout.on('data', (d) => push(d.toString('utf8')));
  child.stderr.on('data', (d) => push(d.toString('utf8')));
  child.on('error', (e) => push('\r\n[manager] could not start ssh: ' + e.message + '\r\n'));
  child.on('exit', (code) => {
    sess.closed = true;
    if (sess.res) {
      try { sess.res.write('data: ' + JSON.stringify({ exit: code === null ? 0 : code }) + '\n\n'); sess.res.end(); } catch (e) {}
      sess.res = null;
    }
    sessions.delete(id);
  });
  return { id: id, command: 'ssh -i ' + CFG.sshKey + ' -p ' + vm.port + ' ' + u + '@127.0.0.1' };
}

function sseStream(req, res, id) {
  const sess = sessions.get(id);
  if (!sess) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'session not found' }));
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  if (sess.buf) res.write('data: ' + JSON.stringify({ t: sess.buf }) + '\n\n');
  sess.res = res;
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  req.on('close', () => { clearInterval(ping); if (sess.res === res) sess.res = null; });
}

function closeAllSessions() {
  for (const s of sessions.values()) { try { s.child.kill(); } catch (e) {} }
  sessions.clear();
}

// --------------------------------------------------------------------------
// state gathering
// --------------------------------------------------------------------------
async function vmState() {
  pruneMissing();
  const out = [];
  const pmap = await portPidMap();
  for (const name of Object.keys(state.vms)) {
    const vm = state.vms[name];
    const livePid = pmap[vm.port] || null;
    const alive = !!livePid;
    vm.pid = livePid;
    if (!alive) vm.startedAt = null;
    let status = 'stopped';
    if (alive) status = (await probeSsh(vm.port, 900)) ? 'running' : 'booting';
    out.push({
      name: name, port: vm.port, mem: vm.mem, cpus: vm.cpus, pid: vm.pid,
      status: status, startedAt: vm.startedAt, createdAt: vm.createdAt,
      diskBytes: sizeOf(diskPath(name)), mac: macForPort(vm.port),
      ports: vm.ports || [],
      base: vm.base || CFG.base,
      autostart: !!vm.autostart,
      note: vm.note || '',
      pendingFsResize: !!vm.pendingFsResize,
      hasLog: exists(logPath(name)),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  saveState();
  return out;
}

function hostState() {
  const memTotal = os.totalmem(), memFree = os.freemem();
  let diskTotal = 0, diskFree = 0;
  try { const s = fs.statfsSync('C:/'); diskTotal = s.blocks * s.bsize; diskFree = s.bfree * s.bsize; } catch (e) {}
  return {
    hostname: os.hostname(), platform: os.platform(), cpus: os.cpus().length,
    memTotal: memTotal, memFree: memFree, memUsed: memTotal - memFree,
    diskTotal: diskTotal, diskFree: diskFree, diskUsed: diskTotal - diskFree,
  };
}

// --------------------------------------------------------------------------
// guest access + docker introspection
// --------------------------------------------------------------------------
function sshExec(port, cmd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(SSH, ['-i', CFG.sshKey, '-p', String(port),
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + CFG.sshKnownHosts,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
      'root@127.0.0.1', cmd],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs || 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

function ndjson(txt) {
  const out = [];
  for (const line of String(txt || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { out.push(JSON.parse(t)); } catch (e) {}
  }
  return out;
}

async function dockerState(vm) {
  const v = await sshExec(vm.port, 'docker version --format "{{.Server.Version}}" 2>/dev/null', 15000);
  const ver = (v.out || '').trim();
  if (!ver || !/^\d/.test(ver)) return { installed: false, version: null, containers: [], images: [], networks: [], volumes: [] };
  const [ps, im, nw, vo] = await Promise.all([
    sshExec(vm.port, 'docker ps -a --format "{{json .}}" 2>/dev/null'),
    sshExec(vm.port, 'docker images --format "{{json .}}" 2>/dev/null'),
    sshExec(vm.port, 'docker network ls --format "{{json .}}" 2>/dev/null'),
    sshExec(vm.port, 'docker volume ls --format "{{json .}}" 2>/dev/null'),
  ]);
  return {
    installed: true,
    version: ver,
    containers: ndjson(ps.out).map((c) => ({
      id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status,
      ports: c.Ports, created: c.CreatedAt, running: String(c.State || '').toLowerCase() === 'running',
    })),
    images: ndjson(im.out).map((i) => ({
      id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size,
      created: i.CreatedSince || i.CreatedAt, dangling: i.Repository === '<none>',
    })),
    networks: ndjson(nw.out).map((n) => ({ id: n.ID, name: n.Name, driver: n.Driver, scope: n.Scope })),
    volumes: ndjson(vo.out).map((x) => ({ name: x.Name, driver: x.Driver })),
  };
}

// --------------------------------------------------------------------------
// base images (VM templates)
// --------------------------------------------------------------------------
function listBases() {
  const out = [];
  if (exists(CFG.base)) {
    out.push({ name: 'devbox-base', file: CFG.base, size: sizeOf(CFG.base), isDefault: true });
  }
  try {
    for (const f of fs.readdirSync(CFG.basesDir)) {
      if (!f.endsWith('.qcow2')) continue;
      const p = path.join(CFG.basesDir, f);
      out.push({ name: f.replace(/\.qcow2$/, ''), file: p, size: sizeOf(p), isDefault: false });
    }
  } catch (e) {}
  const usedBy = {};
  for (const [n, vm] of Object.entries(state.vms)) usedBy[vm.base || CFG.base] = (usedBy[vm.base || CFG.base] || 0) + 1;
  for (const b of out) b.usedBy = usedBy[b.file] || 0;
  return out;
}

function findBase(name) {
  if (!name) return CFG.base;
  const hit = listBases().find((b) => b.name === name);
  return hit ? hit.file : CFG.base;
}

// --------------------------------------------------------------------------
// network overview across all VMs
// --------------------------------------------------------------------------
async function networkOverview() {
  const pmap = await portPidMap();
  const rows = [];
  const seen = {};
  for (const [name, vm] of Object.entries(state.vms)) {
    rows.push({ vm: name, kind: 'ssh', host: vm.port, guest: 22, listening: !!pmap[vm.port], pid: pmap[vm.port] || null });
    for (const p of (vm.ports || [])) {
      rows.push({ vm: name, kind: 'app', host: p.host, guest: p.guest, listening: !!pmap[p.host], pid: pmap[p.host] || null });
    }
  }
  for (const r of rows) {
    const key = String(r.host);
    seen[key] = (seen[key] || 0) + 1;
  }
  for (const r of rows) r.conflict = seen[String(r.host)] > 1;
  rows.sort((a, b) => a.host - b.host);
  return rows;
}

// --------------------------------------------------------------------------
// per-VM settings, disk, templates
// --------------------------------------------------------------------------
const shq = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
// Docker creates a missing bind-mount source as a DIRECTORY, which then breaks
// any container bind-mounting /etc/localtime. Normalise it before every compose
// deploy so rebuilds are idempotent and never hit that runc mount error.
const LOCALTIME_FIX = '[ -d /etc/localtime ] && rmdir /etc/localtime 2>/dev/null; [ -f /etc/localtime ] || cp /usr/share/zoneinfo/UTC /etc/localtime; ';

async function opSettings(name, s) {
  beginTask('settings');
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  const running = !!(await pidForPort(vm.port));
  const wantsRestart = s.mem !== undefined || s.cpus !== undefined || s.ports !== undefined;
  if (wantsRestart && running) throw new Error('stop the VM before changing memory, vCPUs or port mappings');
  if (s.mem !== undefined) vm.mem = Math.min(Math.max(parseInt(s.mem, 10) || CFG.defaultMem, 256), CFG.maxMem);
  if (s.cpus !== undefined) vm.cpus = Math.min(Math.max(parseInt(s.cpus, 10) || CFG.defaultCpus, 1), 8);
  if (s.ports !== undefined) vm.ports = parsePortSpec(s.ports, vm.port);
  if (s.autostart !== undefined) vm.autostart = !!s.autostart;
  if (s.note !== undefined) vm.note = String(s.note).slice(0, 200);
  saveState();
  tlog('Saved settings for ' + nm + '  (mem ' + vm.mem + 'MB, ' + vm.cpus + ' vCPU, autostart ' + (vm.autostart ? 'on' : 'off') + ')');
  if (vm.ports && vm.ports.length) tlog('Ports: ' + vm.ports.map((p) => p.host + '->' + p.guest).join(', '));
  endTask(null);
}

async function opResize(name, sizeGB) {
  beginTask('resize');
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (await pidForPort(vm.port)) throw new Error('stop the VM before resizing its disk');
  const sz = parseInt(sizeGB, 10);
  if (!sz || sz < 2 || sz > 512) throw new Error('pick a size between 2 and 512 GB');
  tlog('Resizing the disk of ' + nm + ' to ' + sz + 'G...');
  const r = await run(QEMU_IMG, ['resize', diskPath(nm), sz + 'G']);
  if (r.code !== 0) throw new Error('qemu-img resize failed: ' + (r.stderr || r.stdout).slice(0, 200));
  vm.pendingFsResize = true;
  saveState();
  tlog('Virtual disk is now ' + sz + 'G. Start the VM, then use "Grow filesystem" to expand the filesystem into it.');
  endTask(null);
}

async function opGrowFs(name) {
  beginTask('growfs');
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (!(await pidForPort(vm.port))) throw new Error('the VM must be running');
  if (!(await probeSsh(vm.port, 3000))) throw new Error('SSH is not ready yet');
  tlog('Expanding the root filesystem inside ' + nm + '...');
  const r = await sshExec(vm.port, 'resize2fs /dev/vda 2>&1 | tail -3; echo "--"; df -h / | tail -1', 180000);
  tlog(r.out.trim());
  vm.pendingFsResize = false;
  saveState();
  endTask(null);
}

async function opFreeze(name, asName) {
  beginTask('freeze');
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (await pidForPort(vm.port)) throw new Error('stop the VM before freezing it into a template');
  if (!exists(diskPath(nm))) throw new Error('disk image is missing');
  const target = safeName(asName || (nm + '-base'));
  fs.mkdirSync(CFG.basesDir, { recursive: true });
  const dest = path.join(CFG.basesDir, target + '.qcow2');
  if (exists(dest)) throw new Error('a template called "' + target + '" already exists');
  tlog('Freezing "' + nm + '" into a reusable template (flattening the backing chain)...');
  const r = await run(QEMU_IMG, ['convert', '-O', 'qcow2', diskPath(nm), dest], { maxBuffer: 64 * 1024 * 1024 });
  if (r.code !== 0) throw new Error('qemu-img convert failed: ' + (r.stderr || r.stdout).slice(0, 200));
  tlog('Template "' + target + '" created: ' + fmtBytes(sizeOf(dest)));
  tlog('Create new sandboxes from it by picking that base.');
  endTask(null);
}

// --------------------------------------------------------------------------
// docker operations
// --------------------------------------------------------------------------
async function dockerVm(name) {
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (!(await pidForPort(vm.port))) throw new Error('"' + nm + '" is not running - start it first');
  if (!(await probeSsh(vm.port, 3000))) throw new Error('the guest is still booting - SSH is not ready yet');
  return vm;
}

async function opDockerInstall(name) {
  beginTask('docker-install');
  const vm = await dockerVm(name);
  tlog('Installing Docker + compose in the guest (downloads packages)...');
  const r = await sshExec(vm.port,
    'apk add --no-cache docker docker-cli-compose >/dev/null 2>&1; rc-update add docker default >/dev/null 2>&1; ' +
    'service docker start >/dev/null 2>&1; sleep 3; docker version --format "{{.Server.Version}}" 2>&1', 600000);
  const v = r.out.trim();
  if (!/^\d/.test(v)) throw new Error('docker did not come up: ' + (v || r.err).slice(0, 200));
  tlog('Docker server ' + v + ' is running');
  endTask(null);
}

async function opDockerPull(name, image) {
  beginTask('docker-pull');
  if (!image) throw new Error('an image reference is required');
  const vm = await dockerVm(name);
  tlog('Pulling ' + image + ' (large images are slow under emulation)...');
  const r = await sshExec(vm.port, 'docker pull ' + shq(image) + ' 2>&1 | tail -6', 1800000);
  tlog(r.out.trim());
  endTask(null);
}

async function opDockerRun(name, o) {
  beginTask('docker-run');
  if (!o.image) throw new Error('an image reference is required');
  const vm = await dockerVm(name);
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const parts = ['docker', 'run', '-d'];
  if (o.containerName) parts.push('--name', shq(o.containerName));
  if (o.restart) parts.push('--restart', shq(o.restart));
  for (const p of list(o.ports)) parts.push('-p', shq(p));
  for (const v of list(o.volumes)) parts.push('-v', shq(v));
  for (const e of list(o.env)) parts.push('-e', shq(e));
  parts.push(shq(o.image));
  if (o.cmd) parts.push(String(o.cmd));
  const cmd = parts.join(' ');
  tlog('$ ' + cmd);
  const r = await sshExec(vm.port, LOCALTIME_FIX + cmd + ' 2>&1 | tail -5', 600000);
  tlog(r.out.trim());
  endTask(null);
}

async function opDockerAction(name, id, action) {
  beginTask('docker-' + action);
  const ACT = { start: 'start', stop: 'stop', restart: 'restart', rm: 'rm -f', pause: 'pause', unpause: 'unpause' };
  const a = ACT[action];
  if (!a) throw new Error('unsupported action: ' + action);
  if (!id) throw new Error('container required');
  const vm = await dockerVm(name);
  tlog('docker ' + a + ' ' + id);
  const r = await sshExec(vm.port, 'docker ' + a + ' ' + shq(id) + ' 2>&1 | tail -3', 300000);
  tlog(r.out.trim() || 'ok');
  endTask(null);
}

async function opDockerRmi(name, image) {
  beginTask('docker-rmi');
  if (!image) throw new Error('image required');
  const vm = await dockerVm(name);
  tlog('docker rmi ' + image);
  const r = await sshExec(vm.port, 'docker rmi ' + shq(image) + ' 2>&1 | tail -3', 300000);
  tlog(r.out.trim() || 'ok');
  endTask(null);
}

async function opCompose(name, project, yaml) {
  beginTask('compose');
  if (!yaml || !String(yaml).trim()) throw new Error('paste a compose file first');
  const vm = await dockerVm(name);
  const proj = safeName(project || 'app');
  const dir = '/opt/' + proj;
  const b64 = Buffer.from(String(yaml), 'utf8').toString('base64');
  tlog('Deploying project "' + proj + '" into ' + dir);
  tlog('(applying the /etc/localtime normalisation first, so this is repeatable)');
  const cmd = 'mkdir -p ' + dir + ' && echo ' + shq(b64) + ' | base64 -d > ' + dir + '/docker-compose.yml && cd ' + dir +
    ' && docker compose up -d 2>&1 | tail -30 && echo "--PS--" && docker compose ps 2>&1 | tail -15';
  const r = await sshExec(vm.port, LOCALTIME_FIX + cmd, 1800000);
  tlog(r.out.trim());
  endTask(null);
}

async function opDockerLogs(name, container) {
  const vm = state.vms[safeName(name)];
  if (!vm) throw new Error('no such sandbox');
  const r = await sshExec(vm.port, 'docker logs --tail 250 ' + shq(container) + ' 2>&1', 60000);
  return r.out || '(no output)';
}

// --------------------------------------------------------------------------
// deploy an image automatically
//
// Instead of making the user read an image's docs, inspect it: the image's
// ExposedPorts and Volumes say what it needs. We then map every exposed TCP
// port host->guest (so it is reachable from Windows), create a volume dir per
// declared volume, and run it. QEMU fixes port forwards at launch, so if new
// mappings are needed the VM is restarted automatically as part of the deploy.
// --------------------------------------------------------------------------
function parseInspect(out) {
  const parts = String(out).split('|');
  const j = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  const ports = Object.keys(j(parts[0]) || {}).map((k) => {
    const m = k.match(/^(\d+)\/(tcp|udp)$/);
    return m ? { port: parseInt(m[1], 10), proto: m[2] } : null;
  }).filter(Boolean);
  const volumes = Object.keys(j(parts[1]) || {});
  const env = (j(parts[2]) || []).filter((e) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(e));
  return { ports: ports, volumes: volumes, env: env, cmd: j(parts[3]), entrypoint: j(parts[4]) };
}

async function inspectImage(vm, image) {
  const ins = await sshExec(vm.port,
    'docker image inspect ' + shq(image) +
    ' --format "{{json .Config.ExposedPorts}}|{{json .Config.Volumes}}|{{json .Config.Env}}|{{json .Config.Cmd}}|{{json .Config.Entrypoint}}"', 60000);
  if (!ins.ok || !ins.out.trim()) throw new Error('could not inspect the image (is it pulled?)');
  return parseInspect(ins.out.trim());
}

async function opImageInspect(name, image) {
  beginTask('image-inspect');
  if (!image) throw new Error('an image reference is required');
  const vm = await dockerVm(name);
  tlog('Checking for ' + image + ' ...');
  const p = await sshExec(vm.port,
    'docker image inspect ' + shq(image) + ' >/dev/null 2>&1 && echo ALREADY_PRESENT || (echo PULLING && docker pull ' + shq(image) + ' 2>&1 | tail -4)', 1800000);
  tlog(p.out.trim());
  const info = await inspectImage(vm, image);
  tlog('Declared TCP ports: ' + (info.ports.filter((x) => x.proto === 'tcp').map((x) => x.port).join(', ') || '(none)'));
  tlog('Declared volumes  : ' + (info.volumes.join(', ') || '(none)'));
  endTask(null);
  return info;
}

async function opDeploy(name, o) {
  beginTask('deploy');
  const nm = safeName(name);
  const vm = state.vms[nm];
  if (!vm) throw new Error('no such sandbox: ' + nm);
  if (!o.image) throw new Error('an image reference is required');
  if (!(await pidForPort(vm.port))) throw new Error('"' + nm + '" is not running - start it first');
  if (!(await probeSsh(vm.port, 3000))) throw new Error('the guest is still booting');

  const cname = safeName(o.containerName || o.image.split('/').pop().split(':')[0]);

  // 1. make sure the image is local
  tlog('Step 1/5: pulling ' + o.image + ' if needed...');
  const p = await sshExec(vm.port,
    'docker image inspect ' + shq(o.image) + ' >/dev/null 2>&1 && echo ALREADY_PRESENT || (echo PULLING && docker pull ' + shq(o.image) + ' 2>&1 | tail -4)', 1800000);
  tlog(p.out.trim());

  // 2. ask the image what it needs
  tlog('Step 2/5: inspecting the image for ports and volumes...');
  const info = await inspectImage(vm, o.image);
  const tcpPorts = info.ports.filter((x) => x.proto === 'tcp').map((x) => x.port);
  tlog('Exposed TCP ports: ' + (tcpPorts.join(', ') || '(none)'));
  tlog('Declared volumes : ' + (info.volumes.join(', ') || '(none)'));

  // 3. work out the host->guest mappings, avoiding ports already claimed.
  // Some images (Home Assistant is the classic case) declare NOTHING - no
  // EXPOSE, no VOLUME - so the caller can pass explicit ports to supplement
  // what inspection found.
  const explicit = [];
  for (const part of String(o.ports || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?::(\d{1,5}))?$/);
    if (!m) throw new Error('bad port spec "' + part + '" - use host:guest, e.g. 8123:8123');
    explicit.push({ host: parseInt(m[1], 10), guest: parseInt(m[2] || m[1], 10) });
  }
  if (explicit.length && !tcpPorts.length) tlog('Image declares no ports - using the ports you supplied: ' + explicit.map((q) => q.host + '->' + q.guest).join(', '));

  // A port mapping really has THREE ports, and conflating them was a bug:
  //   container - what the process listens on inside the container
  //   guest     - the port it is published on inside the VM
  //   host      - the Windows port that QEMU forwards to `guest`
  // An explicit "8080:80" means host 8080 -> container 80; the guest port is
  // picked free, because two containers in one VM cannot both publish port 80.
  const hostTaken = new Set();
  for (const [n2, v2] of Object.entries(state.vms)) {
    hostTaken.add(v2.port);
    for (const q of (v2.ports || [])) hostTaken.add(q.host);
  }
  const guestTaken = new Set((vm.ports || []).map((q) => q.guest));
  const added = [];
  const want = explicit.slice();
  for (const gp of tcpPorts) if (!want.some((w) => w.guest === gp)) want.push({ host: null, guest: gp });
  for (const w of want) {
    // re-deploying this same container must reuse the ports it already owns,
    // otherwise every deploy would pile up another mapping
    if ((vm.ports || []).some((q) => q.owner === cname && (q.container || q.guest) === w.guest)) continue;
    let gp = w.host || w.guest;
    while (guestTaken.has(gp) || gp === 22) gp++;
    let hp = w.host || gp;
    while (hostTaken.has(hp) || hp === vm.port) hp++;
    added.push({ host: hp, guest: gp, container: w.guest, owner: cname });
    hostTaken.add(hp);
    guestTaken.add(gp);
  }
  if (added.length) {
    vm.ports = (vm.ports || []).concat(added);
    saveState();
    tlog('Step 3/5: new port mappings -> ' + added.map((q) =>
      q.host + '->' + q.guest + (q.container !== q.guest ? ' (container ' + q.container + ')' : '')).join(', '));
  } else {
    tlog('Step 3/5: no new port mappings needed');
  }

  // 4. Try to add the forwards to the RUNNING vm via the monitor; only pay for a
  //    restart if that is not possible.
  if (added.length && !o.noRestart) {
    tlog('Step 4/5: adding the new forwards to the running VM...');
    let allLive = true, why = '';
    for (const q of added) {
      const r = await addForwardLive(vm, q.host, q.guest);
      if (!r.ok) { allLive = false; why = r.why || 'unknown'; break; }
      tlog('  ' + q.host + ' -> ' + q.guest + ' is live');
    }
    if (allLive) {
      tlog('Step 4/5: applied live through the QEMU monitor - no restart needed.');
    } else {
      tlog('Step 4/5: could not apply live (' + why + ') - restarting the VM instead (~90s)...');
      await opStop(nm, false);
      beginTask('deploy');
      if (!(await waitPortFree(vm.port, 25000))) tlog('Warning: port ' + vm.port + ' still busy; trying anyway');
      await opStart(nm, false);
      beginTask('deploy');
      let up = false;
      for (let i = 0; i < 30; i++) {
        if (await probeSsh(vm.port, 2000)) { up = true; break; }
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (!up) throw new Error('the VM did not come back after the restart');
      tlog('VM is back up');
    }
  } else if (added.length) {
    tlog('Step 4/5: skipped restart - ports will work after you restart the VM yourself');
  } else {
    tlog('Step 4/5: no restart needed');
  }

  // 5. run it (idempotent: replace a container of the same name)
  const volDir = '/opt/' + cname;
  // which mappings belong to THIS container: the ones we just created, or, for
  // containers deployed before owner tracking existed, the ones matching the image
  let pubs = (vm.ports || []).filter((q) => q.owner === cname);
  if (!pubs.length) pubs = (vm.ports || []).filter((q) =>
    tcpPorts.includes(q.container || q.guest) || explicit.some((w) => w.guest === (q.container || q.guest)));
  const args = ['docker', 'run', '-d', '--name', shq(cname), '--restart', shq(o.restartPolicy || 'unless-stopped')];
  if (o.privileged) args.push('--privileged');
  if (o.hostNetwork) args.push('--network', 'host');
  else for (const q of pubs) args.push('-p', shq(q.guest + ':' + (q.container || q.guest)));
  for (const env of String(o.env || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-e', shq(env));
  for (const v of info.volumes) args.push('-v', shq(volDir + v.replace(/\//g, '_') + ':' + v));
  for (const v of String(o.volumes || '').split(',').map((s) => s.trim()).filter(Boolean)) args.push('-v', shq(v));
  args.push(shq(o.image));

  tlog('Step 5/5: creating volume dirs and starting the container...');
  const mk = info.volumes.map((v) => volDir + v.replace(/\//g, '_')).join(' ');
  tlog('$ docker rm -f ' + cname + ' (ignore if absent)');
  tlog('$ ' + args.join(' '));
  const r = await sshExec(vm.port,
    LOCALTIME_FIX + 'docker rm -f ' + shq(cname) + ' >/dev/null 2>&1; ' +
    (mk ? 'mkdir -p ' + mk + ' && ' : '') + args.join(' ') + ' 2>&1; echo "__RC=$?"', 900000);
  // A failed `docker run` still prints a 64-hex line, so the old code reported
  // success after a real failure (e.g. "port is already allocated"). Check the
  // exit code rather than trusting the output shape.
  const rawOut = r.out.trim();
  const rcMatch = rawOut.match(/__RC=(\d+)\s*$/);
  const rc = rcMatch ? parseInt(rcMatch[1], 10) : 0;
  const body = rawOut.replace(/__RC=\d+\s*$/, '').trim();
  tlog(body.slice(-1500) || '(no output)');
  if (rc !== 0) {
    const last = body.split('\n').map((x) => x.trim()).filter(Boolean).pop() || 'no output';
    throw new Error('docker run failed (exit ' + rc + '): ' + last.slice(0, 240));
  }

  // report the URLs the user can actually click
  const urls = [];
  for (const q of pubs) urls.push('http://127.0.0.1:' + q.host);
  tlog('Container "' + cname + '" started from ' + o.image);
  if (urls.length) tlog('Reachable at: ' + urls.join('  '));
  else tlog('No ports exposed - this image declares none and none were supplied.');
  endTask(null);
  return { container: cname, urls: urls, ports: vm.ports || [] };
}

// --------------------------------------------------------------------------
// one-shot: image reference -> running sandbox
//
// Creates a Docker-capable sandbox, boots it, then deploys the image into it.
// Reuses opCreate/opStart/opDeploy instead of duplicating them, so this path
// gets the same port derivation, /etc/localtime fix and volume handling.
//
// Ports the caller names up front are written to the VM record BEFORE the first
// boot, so QEMU applies those forwards at launch and no restart is needed.
// Ports that can only be learned by inspecting the image still cost one restart.
// --------------------------------------------------------------------------
async function opQuickDeploy(o) {
  const steps = [];
  const phase = (msg) => { if (msg) steps.push(msg); beginTask('sandbox from image'); for (const s of steps) tlog(s); };
  phase(null);
  KEEP_TASK = true;
  try {

  const image = String(o.image || '').trim();
  if (!image) throw new Error('an image reference is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(image)) throw new Error('that does not look like an image reference: ' + image);

  let name = safeName(o.name || '');
  if (!name) {
    const tail = image.split('/').pop().split(':')[0].replace(/[^A-Za-z0-9._-]/g, '-');
    name = safeName(tail.replace(/-+/g, '-').replace(/^-+|-+$/g, ''));
  }
  if (!name) throw new Error('could not derive a sandbox name from "' + image + '" - give one explicitly');
  let uniq = name, n = 1;
  while (state.vms[uniq] || exists(diskPath(uniq))) uniq = name + '-' + (++n);
  name = uniq;

  const bases = listBases();
  const wanted = (o.template && bases.some((b) => b.name === o.template)) ? o.template
    : bases.some((b) => b.name === 'docker-ready') ? 'docker-ready' : null;
  const tplFile = wanted ? findBase(wanted) : CFG.base;
  if (!exists(tplFile)) throw new Error('no usable template found - build one first');

  const mem = Math.min(Math.max(parseInt(o.mem, 10) || CFG.defaultMem, 256), CFG.maxMem);
  const cpus = Math.min(Math.max(parseInt(o.cpus, 10) || CFG.defaultCpus, 1), 8);

  phase('Image    : ' + image);
  phase('Sandbox  : ' + name + '   (' + mem + ' MB, ' + cpus + ' vCPU)');
  phase('Template : ' + path.basename(tplFile) + (wanted === 'docker-ready' ? '   (Docker preinstalled)' : ''));

  // 1. create the sandbox
  phase('Step 1/4: creating the sandbox...');
  await opCreate(name, mem, cpus, null, wanted);
  const vm = state.vms[name];

  // ports the user named go in BEFORE the first boot so the forwards exist
  // from launch and we never have to restart to add them
  const explicit = [];
  for (const part of String(o.ports || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,5})(?::(\d{1,5}))?$/);
    if (!m) throw new Error('bad port spec "' + part + '" - use host:guest, e.g. 8123:8123');
    explicit.push({ host: parseInt(m[1], 10), guest: parseInt(m[2] || m[1], 10) });
  }
  const taken = new Set();
  for (const [n2, v2] of Object.entries(state.vms)) {
    if (n2 === name) continue;
    taken.add(v2.port);
    for (const q of (v2.ports || [])) taken.add(q.host);
  }
  const qcname = safeName(o.containerName || name);
  const pre = [];
  const preGuests = new Set();
  for (const w of explicit) {
    // "host:container" - the guest port is chosen free, and the container port is
    // what the image actually listens on
    let gp = w.host;
    while (preGuests.has(gp) || gp === 22) gp++;
    let hp = w.host;
    while (taken.has(hp) || hp === vm.port) hp++;
    taken.add(hp);
    preGuests.add(gp);
    pre.push({ host: hp, guest: gp, container: w.guest, owner: qcname });
  }
  if (pre.length) { vm.ports = pre; saveState(); }
  phase(pre.length
    ? 'Pre-set port forwards: ' + pre.map((q) => q.host + '->' + q.guest).join(', ') + '   (applied at boot, no restart needed)'
    : 'No ports named up front - they will be derived from the image after it is pulled.');

  // 2. boot it
  phase('Step 2/4: booting - a fresh clone takes ~85s...');
  await opStart(name, !!o.showConsole);
  let up = false;
  for (let i = 0; i < 40; i++) {
    if (await probeSsh(vm.port, 2500)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!up) throw new Error('the sandbox never finished booting - open its log, then deploy the image from its Docker tab');
  phase('Sandbox is up: ssh -i <key> -p ' + vm.port + ' root@127.0.0.1');

  // 3. is Docker in this template?
  phase('Step 3/4: checking for Docker in the guest...');
  const dv = await sshExec(vm.port, 'docker version --format "{{.Server.Version}}" 2>/dev/null || echo MISSING', 60000);
  if (/MISSING/.test(dv.out)) {
    phase('Not present in this template - installing it (several minutes)...');
    await opDockerInstall(name);
    phase('Docker installed.');
  } else {
    phase('Docker server ' + dv.out.trim() + ' already present.');
  }

  // 4. pull, inspect, map any remaining ports, run
  phase('Step 4/4: pulling the image and starting it...');
  const res = await opDeploy(name, {
    image: image,
    containerName: o.containerName || name,
    env: o.env,
    volumes: o.volumes,
    ports: o.ports,
    privileged: !!o.privileged,
    hostNetwork: !!o.hostNetwork,
  });
  phase('Done. Sandbox "' + name + '"' + (res.urls && res.urls.length ? ' -> ' + res.urls.join('  ') : ''));
  return Object.assign({ sandbox: name }, res);
  } finally { KEEP_TASK = false; }
}

// --------------------------------------------------------------------------
// HTTP API
// --------------------------------------------------------------------------
function send(res, code, body, type) {
  const b = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

function guard(res) {
  if (task.status === 'running') {
    send(res, 409, { ok: false, error: 'another operation is running: ' + task.name });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    // ---- static ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const f = path.join(__dirname, 'public', 'index.html');
      if (!exists(f)) return send(res, 500, 'GUI file missing', 'text/plain');
      return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p.indexOf('/vendor/') === 0) {
      const pubDir = path.join(__dirname, 'public');
      const f = path.normalize(path.join(pubDir, p.replace(/^\/+/, '')));
      if (f.indexOf(pubDir) !== 0) return send(res, 403, 'forbidden', 'text/plain');
      if (!exists(f)) return send(res, 404, 'not found', 'text/plain');
      const t = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(f)] || 'application/octet-stream';
      return send(res, 200, fs.readFileSync(f), t);
    }
    if (req.method === 'GET' && p === '/api/vm/console/stream') {
      return sseStream(req, res, url.searchParams.get('id'));
    }
    if (req.method === 'GET' && p === '/api/state') {
      return send(res, 200, {
        ok: true, vms: await vmState(), host: hostState(), prereqs: prereqs(),
        bases: listBases(),
        task: { name: task.name, status: task.status }, sshKey: CFG.sshKey,
        limits: { maxMem: CFG.maxMem, defaultMem: CFG.defaultMem, defaultCpus: CFG.defaultCpus },
      });
    }
    if (req.method === 'GET' && p === '/api/network') return send(res, 200, { ok: true, rows: await networkOverview() });
    if (req.method === 'GET' && p === '/api/vm/docker') {
      const nm = safeName(url.searchParams.get('name') || '');
      const vm = state.vms[nm];
      if (!vm) return send(res, 404, { ok: false, error: 'no such sandbox: ' + nm });
      const running = !!(await pidForPort(vm.port));
      const sshOk = running && (await probeSsh(vm.port, 1500));
      if (!sshOk) return send(res, 200, { ok: true, running: running, installed: false, version: null, containers: [], images: [], networks: [], volumes: [], note: running ? 'booting' : 'stopped' });
      return send(res, 200, Object.assign({ ok: true, running: true }, await dockerState(vm)));
    }
    if (req.method === 'GET' && p === '/api/vm/docker/logs') {
      const nm = safeName(url.searchParams.get('name') || '');
      const cn = url.searchParams.get('container') || '';
      return send(res, 200, { ok: true, text: await opDockerLogs(nm, cn) });
    }
    if (req.method === 'GET' && p === '/api/task') return send(res, 200, { ok: true, task: task });
    if (req.method === 'GET' && p === '/api/log') {
      const name = safeName(url.searchParams.get('name') || '');
      const f = logPath(name);
      if (!exists(f)) return send(res, 200, { ok: true, text: '(no log for ' + name + ')' });
      const txt = fs.readFileSync(f, 'utf8');
      const lines = txt.split('\n');
      const tail = parseInt(url.searchParams.get('tail') || '300', 10);
      return send(res, 200, { ok: true, text: lines.slice(-tail).join('\n'), total: lines.length });
    }

    // ---- actions ----
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (p === '/api/install/qemu') { if (!guard(res)) return; opInstallQemu().catch(endTask); return send(res, 202, { ok: true, started: 'install-qemu' }); }
      if (p === '/api/install/base') { if (!guard(res)) return; opBuildBase().catch(endTask); return send(res, 202, { ok: true, started: 'build-base' }); }
      if (p === '/api/vm/create') {
        if (!guard(res)) return;
        try { const vm = await opCreate(body.name, body.mem, body.cpus, body.port, body.base); return send(res, 200, { ok: true, vm: vm }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/start') {
        if (!guard(res)) return;
        try { await opStart(body.name, !!body.showConsole); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/ports') {
        const nm = safeName(body.name);
        const vm = state.vms[nm];
        if (!vm) return send(res, 400, { ok: false, error: 'no such sandbox: ' + nm });
        if (await pidForPort(vm.port)) return send(res, 400, { ok: false, error: 'stop the VM before changing port mappings' });
        try {
          vm.ports = parsePortSpec(body.ports, vm.port);
          saveState();
          return send(res, 200, { ok: true, ports: vm.ports });
        } catch (e) { return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/settings') {
        if (!guard(res)) return;
        try { await opSettings(body.name, body); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/resize') {
        if (!guard(res)) return;
        try { await opResize(body.name, body.size); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/growfs') {
        if (!guard(res)) return;
        try { await opGrowFs(body.name); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/freeze') {
        if (!guard(res)) return;
        try { await opFreeze(body.name, body.as); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/inspect') {
        if (!guard(res)) return;
        try { const info = await opImageInspect(body.name, body.image); return send(res, 200, { ok: true, info: info }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/deploy') {
        if (!guard(res)) return;
        try { const r = await opDeploy(body.name, body); return send(res, 200, { ok: true, result: r }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/quickdeploy') {
        if (!guard(res)) return;
        try { const r = await opQuickDeploy(body); return send(res, 200, { ok: true, result: r }); }
        catch (e) { endTask(e); return send(res, 500, { ok: false, error: e.message }); }
      }
      if (p === '/api/vm/docker/install') {
        if (!guard(res)) return;
        try { await opDockerInstall(body.name); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/pull') {
        if (!guard(res)) return;
        try { await opDockerPull(body.name, body.image); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/run') {
        if (!guard(res)) return;
        try { await opDockerRun(body.name, body); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/action') {
        if (!guard(res)) return;
        try { await opDockerAction(body.name, body.id, body.action); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/docker/rmi') {
        if (!guard(res)) return;
        try { await opDockerRmi(body.name, body.image); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/compose') {
        if (!guard(res)) return;
        try { await opCompose(body.name, body.project, body.yaml); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/console') {
        try { const r = await openTerminal(body.name, body.user); return send(res, 200, { ok: true, session: r.id, command: r.command }); }
        catch (e) { return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/console/input') {
        const s = sessions.get(body.id);
        if (!s) return send(res, 404, { ok: false, error: 'session not found' });
        try { s.child.stdin.write(String(body.data || '')); } catch (e) {}
        return send(res, 200, { ok: true });
      }
      if (p === '/api/vm/console/close') {
        const s = sessions.get(body.id);
        if (s) { try { s.child.stdin.end(); } catch (e) {} try { s.child.kill(); } catch (e) {} sessions.delete(body.id); }
        return send(res, 200, { ok: true });
      }
      if (p === '/api/vm/stop') {
        if (!guard(res)) return;
        try { await opStop(body.name, !!body.force); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
      if (p === '/api/vm/delete') {
        if (!guard(res)) return;
        try { await opDelete(body.name); return send(res, 200, { ok: true }); }
        catch (e) { endTask(e); return send(res, 400, { ok: false, error: String(e.message || e) }); }
      }
    }
    return send(res, 404, { ok: false, error: 'not found: ' + p });
  } catch (e) {
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

loadState();
server.listen(CFG.serverPort, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + CFG.serverPort + '/';
  console.log('');
  console.log('  devbox VM Manager');
  console.log('  --------------------------------------------------');
  console.log('  GUI:      ' + url);
  console.log('  QEMU:     ' + (exists(QEMU) ? qemuVersion() : 'NOT INSTALLED'));
  console.log('  Base:     ' + (exists(CFG.base) ? fmtBytes(sizeOf(CFG.base)) : 'NOT BUILT'));
  console.log('  Sandboxes:' + ' ' + listDisks().length + ' found');
  console.log('  --------------------------------------------------');
  console.log('  Close this window to stop the manager.');
  console.log('');
  if (process.argv.indexOf('--no-open') === -1) {
    try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
  }
  // Honour per-VM autostart flags.
  setTimeout(async () => {
    for (const [name, vm] of Object.entries(state.vms)) {
      if (!vm.autostart) continue;
      if (await pidForPort(vm.port)) continue;
      try { console.log('  autostart: ' + name); await opStart(name, false); } catch (e) {}
    }
  }, 1500);
});

process.on('SIGINT', () => { stopSeedServer(); closeAllSessions(); process.exit(0); });
process.on('SIGTERM', () => { stopSeedServer(); closeAllSessions(); process.exit(0); });
