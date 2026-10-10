'use strict';
/*
 * Talking to guests over the system OpenSSH client (ssh / scp), plus the SSH
 * key every VM trusts.
 *
 * One place builds the ssh options (MNT-16), with the security rules of spec
 * section 8 (SEC-12):
 *   BatchMode=yes IdentitiesOnly=yes StrictHostKeyChecking=accept-new
 *   UserKnownHostsFile=<root>/run/known_hosts/<vm>   (one file per VM, deleted
 *   when the VM is deleted or reset, so a new VM on a reused port never trips
 *   over an old key, yet an impostor on a KNOWN VM's port is refused; each
 *   clone makes its own host keys on its first boot - vm.personalize - so
 *   one guest's root cannot pose as a sibling VM)
 *   ConnectTimeout=8 ServerAliveInterval=15 ServerAliveCountMax=3 LogLevel=ERROR
 *
 * A target is {name, port} (the MCP server passes this; it has no registry)
 * or a VM name, looked up in the registry.
 *
 * Appliance guests (lib/appliance.js) run their OWN SSH server with their own
 * accounts: guestArgs() offers the manager's key first (a guest that has it in
 * its authorized_keys needs nothing else), then keyboard-interactive/password,
 * answered by the SSH_ASKPASS helper with a password typed in the GUI
 * (askpassEnv: a one-time file the helper prints and deletes) - never read
 * from a console. Without a password: BatchMode=yes, the key only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { CFG } = require('./config');
const platform = require('./platform');
const { exists, run, OutputCapture, errMsg } = require('./util');

function knownHostsFile(name) { return path.posix.join(CFG.knownHostsDir, String(name)); }

// Forget a VM's host key (VM deleted or reset to its template).
function forgetHostKey(name) {
  try { fs.rmSync(knownHostsFile(name), { force: true }); } catch (e) { /* nothing to forget */ }
}

// ssh_config values are whitespace-separated lists: a path with a space must
// be quoted or it is read as two files.
function cfgPath(p) { return /\s/.test(p) ? '"' + p + '"' : p; }

function resolveTarget(target) {
  if (target && typeof target === 'object') {
    const port = parseInt(target.port, 10);
    if (!target.name || !(port >= 1 && port <= 65535)) throw new Error('bad ssh target');
    return { name: String(target.name), port: port };
  }
  const { state } = require('./state');
  const vm = state.vms[target];
  if (!vm) throw new Error('no VM called "' + target + '"');
  return { name: String(target), port: vm.port };
}

// The common options (without the destination).
function sshOptions(name, opts) {
  opts = opts || {};
  try { fs.mkdirSync(CFG.knownHostsDir, { recursive: true }); } catch (e) { /* ssh reports it */ }
  return [
    '-i', CFG.sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + cfgPath(knownHostsFile(name)),
    '-o', 'ConnectTimeout=' + (opts.connectTimeout || 8),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
  ];
}

// Full ssh argv: options, -p, [-tt], user@127.0.0.1, [command]
//   opts: {user: 'root'|'dev', tty, cmd, connectTimeout}
function sshArgs(target, opts) {
  opts = opts || {};
  const tgt = resolveTarget(target);
  const a = sshOptions(tgt.name, opts).concat(['-p', String(tgt.port)]);
  if (opts.tty) a.push('-tt');
  a.push((opts.user === 'dev' ? 'dev' : 'root') + '@127.0.0.1');
  if (opts.cmd !== undefined && opts.cmd !== null) a.push(String(opts.cmd));
  return a;
}

// What a person would type to get the same shell.
function sshCommandText(port, user) {
  const key = CFG.sshKey;
  return 'ssh -i ' + (/\s/.test(key) ? '"' + key + '"' : key) + ' -p ' + port + ' ' + (user === 'dev' ? 'dev' : 'root') + '@127.0.0.1';
}

// ---------------------------------------------------------------------------
// appliance guests: their own SSH server and accounts
// ---------------------------------------------------------------------------
const GUEST_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;   // = state.SSH_USER_RE
const guestUser = (u) => (GUEST_USER_RE.test(String(u || '')) ? String(u) : 'root');

// opts: {password: bool (a password will be supplied), connectTimeout}
function guestOptions(name, opts) {
  opts = opts || {};
  try { fs.mkdirSync(CFG.knownHostsDir, { recursive: true }); } catch (e) { /* ssh reports it */ }
  const a = exists(CFG.sshKey) ? ['-i', CFG.sshKey, '-o', 'IdentitiesOnly=yes'] : ['-o', 'PubkeyAuthentication=no'];
  return a.concat([
    // no password: the key only, never a prompt (there is no console to answer it)
    '-o', 'BatchMode=' + (opts.password ? 'no' : 'yes'),
    '-o', 'PreferredAuthentications=publickey,keyboard-interactive,password',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=' + cfgPath(knownHostsFile(name)),
    '-o', 'ConnectTimeout=' + (opts.connectTimeout || 8),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
  ]);
}

// Full ssh argv for an appliance guest: opts {user, password: bool, tty, cmd, connectTimeout}
function guestArgs(target, opts) {
  opts = opts || {};
  const tgt = resolveTarget(target);
  const a = guestOptions(tgt.name, opts).concat(['-p', String(tgt.port)]);
  if (opts.tty) a.push('-tt');
  a.push(guestUser(opts.user) + '@127.0.0.1');
  if (opts.cmd !== undefined && opts.cmd !== null) a.push(String(opts.cmd));
  return a;
}

// What a person types to reach an appliance guest (its own password).
function guestCommandText(port, user) {
  return 'ssh -p ' + port + ' ' + guestUser(user) + '@127.0.0.1';
}

// SSH_ASKPASS: ssh runs the helper instead of reading a console. The password
// sits in a one-time file in the manager's private run folder; the helper
// (lib/assets/askpass.js) prints it and deletes it, so a second prompt (a
// wrong password) gets nothing and ssh gives up. Deleted after ASKPASS_TTL_MS
// in any case. The wrapper is a .cmd on Windows (ssh starts a program, and
// node needs its script), a shell script elsewhere.
const ASKPASS_TTL_MS = 60000;
function askpassHelper() {
  const dir = path.join(CFG.runDir, 'askpass');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const js = path.join(__dirname, 'assets', 'askpass.js');
  let f, body;
  if (process.platform === 'win32') {
    f = path.join(dir, 'askpass.cmd');
    const bq = (x) => '"' + String(x).replace(/%/g, '%%') + '"';
    body = '@' + bq(process.execPath) + ' ' + bq(js) + '\r\n';
  } else {
    f = path.join(dir, 'askpass.sh');
    const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
    body = '#!/bin/sh\nexec ' + q(process.execPath) + ' ' + q(js) + '\n';
  }
  let cur = null;
  try { cur = fs.readFileSync(f, 'utf8'); } catch (e) { /* first use */ }
  if (cur !== body) fs.writeFileSync(f, body, { mode: 0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(f, 0o700); } catch (e) { /* checked by ssh */ } }
  return f;
}
// -> {env (merge into ssh's environment), cleanup()}
function askpassEnv(password) {
  const helper = askpassHelper();
  const file = path.join(path.dirname(helper), crypto.randomBytes(12).toString('hex') + '.pw');
  fs.writeFileSync(file, String(password), { mode: 0o600 });
  const drop = () => { try { fs.rmSync(file, { force: true }); } catch (e) { /* gone */ } };
  const timer = setTimeout(drop, ASKPASS_TTL_MS);
  if (timer.unref) timer.unref();
  return {
    file: file,
    env: { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'devbox:0', DEVBOX_ASKPASS_FILE: file },
    cleanup: () => { clearTimeout(timer); drop(); },
  };
}

function sshMissing() {
  const hint = platform.installHints().ssh;
  return 'the OpenSSH client (ssh) was not found - ' + hint;
}

// Spawn a program, capture stdout/stderr (bounded, head + tail kept), feed
// optional stdin, enforce a timeout. Resolves
//   {code, stdout, stderr, ok, timedOut, truncated, durationMs}
// and never rejects. code 124 = timed out, 127 = could not start.
function spawnCapture(file, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const out = new OutputCapture(opts.maxBytes || 16 * 1024 * 1024, opts.headShare);
    const err = new OutputCapture(Math.min(opts.maxBytes || 1024 * 1024, 1024 * 1024), opts.headShare);
    const t0 = Date.now();
    let child = null, settled = false, timedOut = false, timer = null, hardTimer = null;
    const finish = (code, extraErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (extraErr) err.push('\n' + extraErr);
      resolve({
        code: code, stdout: out.text(), stderr: err.text(), ok: code === 0, timedOut: timedOut,
        truncated: out.truncated || err.truncated, durationMs: Date.now() - t0,
      });
    };
    try {
      child = spawn(file, args, Object.assign({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, opts.env ? { env: opts.env } : {}));
    } catch (e) { return finish(127, errMsg(e)); }
    child.on('error', (e) => finish(127, errMsg(e)));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => { /* remote side closed early: not an error here (BUG-14) */ });
    child.on('close', (code) => finish(timedOut ? 124 : (code === null ? 255 : code)));
    const ms = opts.timeoutMs || 30000;
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (e) {}
      // if the process ignores the kill, still answer
      hardTimer = setTimeout(() => finish(124, 'timed out after ' + Math.round(ms / 1000) + ' s'), 5000);
    }, ms);
    try {
      if (opts.input !== undefined && opts.input !== null) child.stdin.end(opts.input);
      else child.stdin.end();
    } catch (e) { /* 'error' handler above reports it */ }
  });
}

// Run one command in the guest. opts: {user, timeoutMs (30 s), input,
// maxBytes, connectTimeout}. Resolves {code, stdout, stderr, ok, timedOut, ...}.
function sshExec(target, cmd, opts) {
  opts = opts || {};
  const ssh = platform.findTool('ssh');
  if (!ssh) return Promise.resolve({ code: 127, stdout: '', stderr: sshMissing(), ok: false, timedOut: false, truncated: false, durationMs: 0 });
  let args, tgt;
  try {
    tgt = resolveTarget(target);
    args = sshArgs(tgt, { user: opts.user, cmd: cmd, connectTimeout: opts.connectTimeout });
  } catch (e) { return Promise.resolve({ code: 127, stdout: '', stderr: errMsg(e), ok: false, timedOut: false, truncated: false, durationMs: 0 }); }
  return spawnCapture(ssh, args, opts).then((r) => {
    // With LogLevel=ERROR, OpenSSH reports a refused or dropped connection
    // at INFO level, i.e. not at all: say what exit 255 means. noStderr
    // keeps the fact that ssh itself said nothing (a dropped session, e.g.
    // after "poweroff"), which a real login failure never is.
    if (r.code === 255 && !r.stderr.trim()) {
      r.noStderr = true;
      r.stderr = 'ssh could not connect to the VM on port ' + tgt.port + ' (connection refused or closed - is it running and booted?)';
    }
    return r;
  });
}

// Run one command in an appliance guest as its own account. opts: {user,
// password, timeoutMs, input, connectTimeout}. Resolves like sshExec.
function sshExecGuest(target, cmd, opts) {
  opts = opts || {};
  const bin = platform.findTool('ssh');
  if (!bin) return Promise.resolve({ code: 127, stdout: '', stderr: sshMissing(), ok: false, timedOut: false, truncated: false, durationMs: 0 });
  let args;
  try { args = guestArgs(target, { user: opts.user, password: !!opts.password, cmd: cmd, connectTimeout: opts.connectTimeout }); }
  catch (e) { return Promise.resolve({ code: 127, stdout: '', stderr: errMsg(e), ok: false, timedOut: false, truncated: false, durationMs: 0 }); }
  const ap = opts.password ? askpassEnv(opts.password) : null;
  const env = Object.assign({}, process.env, ap ? ap.env : {});
  return spawnCapture(bin, args, Object.assign({}, opts, { env: env })).finally(() => { if (ap) ap.cleanup(); });
}

// Copy files with scp. opts: {direction: 'up'|'down', recursive, user, timeoutMs}
//   up:   local -> guest   down: guest -> local
function scp(target, localPath, remotePath, opts) {
  opts = opts || {};
  const bin = platform.findTool('scp');
  if (!bin) return Promise.resolve({ code: 127, stdout: '', stderr: 'scp was not found - ' + platform.installHints().ssh, ok: false, timedOut: false });
  let tgt;
  try { tgt = resolveTarget(target); } catch (e) { return Promise.resolve({ code: 127, stdout: '', stderr: errMsg(e), ok: false, timedOut: false }); }
  const remote = (opts.user === 'dev' ? 'dev' : 'root') + '@127.0.0.1:' + remotePath;
  const args = sshOptions(tgt.name, opts).concat(['-P', String(tgt.port)]);
  if (opts.recursive) args.push('-r');
  if (opts.direction === 'down') args.push(remote, localPath);
  else args.push(localPath, remote);
  return spawnCapture(bin, args, Object.assign({ timeoutMs: 600000 }, opts));
}

// ---------------------------------------------------------------------------
// the SSH key
// ---------------------------------------------------------------------------
// Re-apply "only me" permissions to the private key (Windows OpenSSH refuses a
// key readable by others). Safe to call often.
function protectKey() {
  if (!exists(CFG.sshKey)) return { ok: true, error: null };
  return platform.protectPrivateFile(CFG.sshKey);
}

// Create the key pair if missing. t (optional) is a task context for logging.
// Returns true when a key was created.
async function ensureSshKey(t) {
  const say = (m) => { if (t) t.log(m); };
  if (exists(CFG.sshKey) && exists(CFG.sshPub)) { protectKey(); say('SSH key already present'); return false; }
  const kg = platform.findTool('ssh-keygen');
  if (!kg) throw new Error('ssh-keygen was not found - ' + platform.installHints().ssh);
  fs.mkdirSync(CFG.seedDir, { recursive: true });
  if (exists(CFG.sshKey)) {
    // private key without its .pub: derive the public half, never replace a
    // key existing VMs already trust
    const r = await run(kg, ['-y', '-f', CFG.sshKey]);
    if (r.code !== 0 || !/^ssh-/.test(r.stdout)) throw new Error('could not read the existing SSH key: ' + (r.stderr || r.stdout).slice(0, 300));
    fs.writeFileSync(CFG.sshPub, r.stdout.trim() + '\n');
    protectKey();
    say('Recreated the missing public key');
    return false;
  }
  say('Generating the SSH key pair the VMs will trust...');
  const r = await run(kg, ['-q', '-t', 'ed25519', '-N', '', '-C', 'devbox-vm-manager', '-f', CFG.sshKey]);
  if (r.code !== 0 || !exists(CFG.sshKey)) throw new Error('ssh-keygen failed: ' + (r.stderr || r.stdout).slice(0, 300));
  const p = protectKey();
  if (!p.ok) say('WARNING: could not restrict the key file permissions: ' + p.error);
  say('Key created: ' + CFG.sshKey);
  return true;
}

module.exports = {
  knownHostsFile, forgetHostKey, sshOptions, sshArgs, sshCommandText,
  spawnCapture, sshExec, scp, protectKey, ensureSshKey,
  guestArgs, guestCommandText, askpassEnv, sshExecGuest,
};
