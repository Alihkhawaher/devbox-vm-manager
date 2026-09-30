#!/usr/bin/env node
/*
 * devbox VM Manager - a local control panel for disposable QEMU sandbox VMs.
 *
 * What it does: builds a golden Alpine base image once (cloud-init bake),
 * then creates thin copy-on-write clones of it (or of templates frozen from
 * VMs) in seconds; starts/stops/deletes them; gives each an in-browser root
 * terminal; forwards host ports into them (each forward reachable from THIS
 * PC only by default, or from the LAN when the user says so); runs Docker
 * inside them (install, pull, run, compose, one-click deploy of any image,
 * including "image -> new VM -> running app" in one step); resizes, grows and
 * freezes disks into templates. An MCP server (mcp-server.js) lets Claude
 * create VMs on demand and run tests in them through this manager.
 *
 * Node standard library only: no npm install, no admin rights, no Hyper-V or
 * WSL. Runs on Windows 10/11 (primary), Linux and macOS with QEMU installed.
 * The GUI + JSON API listen on http://127.0.0.1:<port> (default 8777, next
 * free port if taken) and require the access token in <data>/manager-token;
 * a console window shows the full link (http://127.0.0.1:<port>/#token=...),
 * a headless start (no terminal: MCP server, logs) only the plain address.
 *
 * This file is only the entry point, and does its work ONLY when run directly
 * (`node server.js`); requiring it has no side effects. It: parses the
 * command line, resolves the data folder, refuses to start a second copy for
 * the same data folder (opens the running one instead), loads the VM
 * registry, listens (falling back to the next free port), writes
 * <data>/run/manager.json for the MCP server, opens the browser, re-adopts
 * VMs that kept running while the manager was down, runs autostart as tasks,
 * and shuts down cleanly on Ctrl+C, SIGTERM and closing the console window
 * (SIGHUP on Windows). The work lives in lib/:
 *
 *   lib/config.js    data root, settings precedence, paths, limits, token, CLI
 *   lib/platform.js  OS abstraction: tools, processes, sockets, accel, browser
 *   lib/util.js      run(), validators, shq, atomic writes, log tails, logging
 *   lib/state.js     vms.json v2: atomic save-on-change, migration, recovery
 *   lib/tasks.js     background tasks with locks, history and tasks.log
 *   lib/ports.js     port-forward parsing/validation/reservation/allocation
 *   lib/ssh.js       ssh/scp with per-VM known_hosts, the SSH key
 *   lib/monitor.js   QEMU monitor client: live forwards, power-off, quit
 *   lib/download.js  HTTPS downloads (.part, timeouts, sha512)
 *   lib/install.js   prerequisites, QEMU install, base-image bake
 *   lib/vm.js        VM lifecycle, status, templates, settings, disks, network
 *   lib/sessions.js  in-browser terminals over ssh (SSE)
 *   lib/docker.js    Docker inside a guest
 *   lib/deploy.js    deploy an image, one-shot quick deploy
 *   lib/http.js      HTTP security, static GUI files, the API route table
 *   lib/route.js     route-table helpers (task routes, 202 replies)
 *   lib/client.js    API client for the MCP server and tools
 *   lib/oci/         registry client, layer flattening, cpio, image cache
 *   lib/microvm/     microVM engine: kernel, init, plan, run, containers
 *   lib/ninep/       the 9P2000.L file server for live shared folders
 *   lib/shares.js    shared-folder service (+ lib/shares-routes.js)
 *
 * Usage: node server.js [--port <n>] [--data <dir>] [--no-open] [--help]
 * Environment: VM_MANAGER_ROOT (data folder), VM_MANAGER_PORT (port).
 * Other ports: each VM's SSH + app forwards (from 2223 up), a free port on
 * 127.0.0.1 for the cloud-init seed while baking, 2222 for the bake's SSH,
 * per VM and per microVM container a private monitor + serial socket (a
 * random 127.x.y.z on Windows, unix sockets elsewhere - unreachable from the
 * guests), the containers' published ports, and the shared-folder 9P server
 * on 127.0.0.1:5640 (config.json ninepPort) once a folder is shared.
 *
 * Docker images also run WITHOUT Docker: each image as its own headless
 * microVM (lib/microvm/, lib/oci/); containers.json is loaded next to
 * vms.json, running containers are re-adopted at start and keep running
 * when the manager exits, like VMs.
 */
'use strict';

// FIRST, before anything uses the libuv thread pool: the 9P file server
// (live shared folders) runs its file I/O and directory listings on it, and
// the default 4 threads were measured to be the bottleneck (NINEP-REPORT.md).
// A value the user set is kept.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const fs = require('fs');
const config = require('./lib/config');
const { CFG, parseArgs, USAGE, version, rootId } = config;
const util = require('./lib/util');
const { log, logError, exists, sizeOf, fmtBytes, atomicWriteFileSync, errMsg } = util;
const platform = require('./lib/platform');
const client = require('./lib/client');
const state = require('./lib/state');
const install = require('./lib/install');
const vm = require('./lib/vm');
const sessions = require('./lib/sessions');
const ssh = require('./lib/ssh');
const shares = require('./lib/shares');
const containers = require('./lib/microvm/containers');
const { createServer } = require('./lib/http');

const PORT_TRIES = 20;

function nodeTooOld() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 18) return 'Node.js 18.17 or newer is required (this is ' + process.versions.node + ') - get it from https://nodejs.org';
  if (maj === 18 && min < 17) console.warn('  warning: Node.js 18.17+ is recommended (this is ' + process.versions.node + ')');
  return null;
}

// Try to listen on port; resolves the port, or null when it is taken (or a
// port Windows reserves, EACCES), rejects on other errors.
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onListening);
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve(null);
      else reject(e);
    };
    const onListening = () => { server.removeListener('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function tokenUrl(port, token) { return 'http://127.0.0.1:' + port + '/#token=' + token; }

// The link to print. The full one (with #token=) only goes to a console
// window a person looks at: started headless (by the MCP server, a service,
// a pipe), stdout is a log file, and a token there can leak into error
// messages and transcripts (security-4). The browser still gets the full
// link when it is opened.
function printedUrl(port, token) {
  return process.stdout.isTTY ? tokenUrl(port, token) : 'http://127.0.0.1:' + port + '/';
}
function tokenHint() {
  return process.stdout.isTTY ? null : 'access token: in ' + CFG.tokenFile + ' - a browser the launcher opens gets it automatically';
}

function writeManagerFile(port) {
  const info = { pid: process.pid, port: port, url: 'http://127.0.0.1:' + port + '/', startedAt: new Date().toISOString(), version: version(), root: CFG.root };
  try { atomicWriteFileSync(CFG.managerFile, JSON.stringify(info, null, 2) + '\n'); }
  catch (e) { logError('could not write ' + CFG.managerFile, e); }
}
function removeManagerFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG.managerFile, 'utf8'));
    if (j && j.pid === process.pid) fs.rmSync(CFG.managerFile, { force: true });
  } catch (e) { /* not ours or already gone */ }
}

// Another manager already serves this data folder (it proved it knows the
// token - client.findManager / ping with a nonce): point the user at it.
function reuseRunning(m, token, opts) {
  console.log('');
  console.log('  devbox VM Manager is already running for this data folder (pid ' + (m.pid || '?') + ').');
  console.log('  Open: ' + printedUrl(m.port, token));
  if (tokenHint()) console.log('  ' + tokenHint());
  console.log('');
  if (!opts.noOpen) platform.openBrowser(tokenUrl(m.port, token));
  return { reused: true, port: m.port };
}

// Returns a promise of {server, port} | {reused, port} | null (help / error).
async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) {
    console.error('  ' + e.message);
    console.error('');
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }
  if (opts.help) { console.log(USAGE); return null; }
  const old = nodeTooOld();
  if (old) { console.error('  ' + old); process.exitCode = 1; return null; }
  for (const u of opts.unknown) console.warn('  ignoring unknown argument: ' + u);

  config.configure({ data: opts.data, port: opts.port });
  try { config.ensureDirs(); }
  catch (e) {
    console.error('  cannot use the data folder ' + CFG.root + ': ' + e.message);
    console.error('  Pick another one with --data <dir> or VM_MANAGER_ROOT.');
    process.exitCode = 1;
    return null;
  }
  util.setLogFile(CFG.managerLog);
  const token = config.ensureToken();
  // every start, like the SSH key below: a moved or copied data folder gives
  // the file the new folder's (possibly shared) permissions
  const tp = config.protectToken();
  if (!tp.ok) log('warning: could not restrict the permissions of ' + CFG.tokenFile + ': ' + tp.error);

  // One manager per data folder: a second launch opens the first one.
  const running = await client.findManager(CFG.root, { token: token });
  if (running) return reuseRunning(running, token, opts);

  // Last line of defence: log and keep serving (BUG-14). Registered only
  // here, never at require time.
  process.on('uncaughtException', (e) => logError('unexpected error (the manager keeps running)', e));
  process.on('unhandledRejection', (e) => logError('unhandled promise rejection (the manager keeps running)', e));

  // The manager's own runtime folders are locked to this user (sec-5): the
  // shared-folder lists, known_hosts and every temp file of a registry save
  // (vms.json and containers.json hold share secrets and env values) live in
  // run/, the containers' run specs and logs in microvms/. A registry file
  // written from a temp file in run/ keeps run/'s private ACL. Files from
  // before this version are made private once, in the background.
  for (const d of [CFG.runDir, CFG.microvmsDir]) {
    const r = platform.protectPrivateDir(d);
    if (!r.ok) log('warning: could not restrict ' + d + ' to this user (' + r.error + ') - secrets written there are protected file by file');
  }
  state.loadState();
  // operations on containers that kept running wait for adoptAll (correct-4)
  containers.load({ pendingAdoption: true });
  ssh.protectKey();

  const server = createServer({ token: token });
  let port = null;
  const wanted = CFG.serverPort;
  for (let p = wanted; p < wanted + PORT_TRIES && p <= 65535; p++) {
    port = await tryListen(server, p);
    if (port) break;
    // maybe a copy for THIS folder started a moment ago (race with a double
    // click) - only if it proves it knows the token
    const other = await client.ping(p, 1500, token);
    if (other && other.verified && other.rootId === rootId()) return reuseRunning({ port: p, pid: null }, token, opts);
  }
  if (!port) {
    console.error('  ports ' + wanted + '-' + (wanted + PORT_TRIES - 1) + ' are all in use - start with --port <n>');
    process.exitCode = 1;
    return null;
  }
  CFG.serverPort = port;
  writeManagerFile(port);
  server.on('error', (e) => logError('HTTP server error', e));

  const url = tokenUrl(port, token);
  const q = platform.findTool('qemu');
  console.log('');
  console.log('  devbox VM Manager ' + version());
  console.log('  --------------------------------------------------');
  console.log('  Open:      ' + printedUrl(port, token));
  if (tokenHint()) console.log('             (' + tokenHint() + ')');
  if (port !== wanted) console.log('             (port ' + wanted + ' was taken, using ' + port + ')');
  console.log('  Data:      ' + CFG.root + (CFG.rootSource !== 'default' ? '  (' + CFG.rootSource + ')' : ''));
  console.log('  QEMU:      ' + (q ? install.qemuVersion(q) : 'NOT INSTALLED'));
  console.log('  Base:      ' + (exists(CFG.base) ? fmtBytes(sizeOf(CFG.base)) : 'NOT BUILT'));
  console.log('  VMs:       ' + Object.keys(state.state.vms).length);
  const warning = state.stateWarning();
  if (warning) console.log('  WARNING:   ' + warning);
  console.log('  --------------------------------------------------');
  console.log('  Close this window (or press Ctrl+C) to stop the manager.');
  console.log('  Running VMs keep running; they are picked up again next time.');
  console.log('');
  log('manager started on port ' + port + ' (pid ' + process.pid + ', data ' + CFG.root + ')');
  if (!opts.noOpen) platform.openBrowser(url);

  // Background start-up work: accel detection (a 2.5 s probe on Windows;
  // under WHPX also the host CPU flags for the VMs' CPU model), re-adopting
  // VMs and microVM containers that kept running, the shared folders of the
  // running VMs (the 9P transport never reconnects: they are re-registered
  // and re-mounted), then autostart - each VM and container as a task.
  if (q) {
    platform.detectAccel(q).then((a) => { if (a && a.recommended === 'whpx') vm.whpxCpuModel().catch(() => {}); }).catch(() => {});
  }
  (async () => {
    // registries and their backups written by an earlier version inherited
    // the data folder's ACL: rewritten once through the locked run/ folder
    // (same bytes; a file renamed from there keeps its private ACL)
    for (const f of [CFG.stateFile, CFG.stateFile + '.bak', CFG.containersFile, CFG.containersFile + '.bak']) {
      if (!exists(f)) continue;
      await new Promise((r) => setImmediate(r));
      try { platform.writePrivateFileSync(f, fs.readFileSync(f), { atomic: true, tmpDir: CFG.runDir }); }
      catch (e) { log('warning: could not restrict ' + f + ' to this user: ' + errMsg(e)); }
    }
    try { await vm.adoptRunning(); } catch (e) { logError('could not check running VMs', e); }
    try { await containers.adoptAll(); } catch (e) { logError('could not check running containers', e); }
    try { await shares.restoreRunning(); } catch (e) { logError('could not restore the shared folders of running VMs', e); }
    try { await vm.fillUnknownTemplates(); } catch (e) { /* best effort */ }
    await new Promise((r) => setTimeout(r, 1500));
    try { await vm.autostartAll(); } catch (e) { logError('autostart failed', e); }
    try { await containers.autostartAll(); } catch (e) { logError('container autostart failed', e); }
  })();

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    try { log('manager stopping (' + sig + ')'); } catch (e) {}
    try { sessions.shutdown(); } catch (e) {}
    try { install.shutdown(); } catch (e) {}
    // containers keep running (like VMs); only their watchers stop. The 9P
    // server closes: the guests' mounts die with it and are re-mounted when
    // the manager starts again.
    try { containers.shutdown(); } catch (e) {}
    try { shares.shutdown(); } catch (e) {}
    removeManagerFile();
    try { server.close(); } catch (e) {}
    process.exit(0);
  };
  // Windows sends SIGHUP when the console window is closed (about 10 s to
  // clean up), SIGBREAK on Ctrl+Break.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => shutdown(sig)); } catch (e) { /* signal not supported here */ }
  }
  process.on('exit', removeManagerFile);
  return { server: server, port: port };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('  the manager could not start: ' + errMsg(e));
    process.exitCode = 1;
  });
}

module.exports = { main };
