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
 */
const fs = require('fs');
const path = require('path');
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
      child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
};
