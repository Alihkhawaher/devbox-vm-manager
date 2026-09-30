'use strict';
/*
 * Spawn a microVM and watch it from THIS process - used for the one-off TSC
 * calibration boot of the kernel setup (plan.calibrateTscKhz) and the
 * opt-in boot tests. Containers are NOT run this way: they are spawned
 * detached by run.js and followed through the files QEMU writes, so they
 * survive a manager restart.
 *
 * startVm(opts) -> handle {pid, t0, args, done: Promise<result>, output(),
 *                          writeConsole(s), stop(), signal(SIG), kill()}
 *   opts: {qemu, args (plan.planRun().args), console: {host, port} | {path}
 *          (the console endpoint the args make QEMU listen on), timeoutMs,
 *          onLine(line, tMs), onMarker(name, value, tMs), onData(buf, tMs),
 *          cwd, connectTimeoutMs}
 *   result: {exitCode (from __DEVBOX_EXIT, null when there was none),
 *            qemuCode, signal, timings, stderr (QEMU's own messages, the
 *            "accelerator is operational" notice removed), output (console)}
 *
 * consoleWatcher(t0, opts, timings) turns console bytes into timestamped
 * markers and lines (lines capped at 64 KB: guest output is untrusted).
 *
 * Only the QEMU process this module spawned is ever killed.
 */
const net = require('net');
const { spawn } = require('child_process');

const MARKER_RE = /__DEVBOX_([A-Z_]+)(?:=(\S*))?/;
const MAX_LINE = 64 * 1024;

// Console bytes -> timestamped markers/lines.
function consoleWatcher(t0, opts, timings) {
  const chunks = [];
  let lineBuf = '';
  const emit = (line, t) => {
    const m = MARKER_RE.exec(line);
    if (m) {
      if (!(m[1] in timings.marks)) timings.marks[m[1]] = t;
      if (m[1] === 'INIT' && timings.initMs === null) timings.initMs = t;
      if (m[1] === 'EXIT') { w.exitCode = parseInt(m[2], 10); timings.exitMarkerMs = t; }
      if (opts.onMarker) opts.onMarker(m[1], m[2], t);
    }
    if (opts.onLine) opts.onLine(line, t);
  };
  const w = {
    exitCode: null,
    chunks,
    feed(d) {
      const t = Date.now() - t0;
      if (timings.firstByteMs === null) timings.firstByteMs = t;
      chunks.push(d);
      if (opts.onData) opts.onData(d, t);
      lineBuf += d.toString('utf8');
      let i;
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, i).replace(/\r$/, '');
        lineBuf = lineBuf.slice(i + 1);
        emit(line, t);
      }
      if (lineBuf.length > MAX_LINE) { emit(lineBuf.slice(0, MAX_LINE), t); lineBuf = ''; }
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
  return w;
}

// Filter QEMU's informational lines out of its output (bug V9): with WHPX
// the last line QEMU prints is "Windows Hypervisor Platform accelerator is
// operational", which the prototype reported as the reason a VM failed.
function qemuErrorLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/accelerator is operational/i.test(l));
}

async function startVm(opts) {
  const t0 = Date.now();
  const timings = { spawnMs: null, consoleConnectedMs: null, firstByteMs: null, initMs: null, exitMarkerMs: null, qemuExitMs: null, marks: {} };
  const watch = consoleWatcher(t0, opts, timings);
  const child = spawn(opts.qemu, opts.args, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  timings.spawnMs = Date.now() - t0;
  let stderr = '';
  const keep = (d) => { if (stderr.length < 65536) stderr += d; };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  let conn = null;
  let timer = null;
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true;
      timings.qemuExitMs = Date.now() - t0;
      clearTimeout(timer);
      // let the last console bytes arrive
      setTimeout(() => {
        try { if (conn) conn.destroy(); } catch (e) { /* closed */ }
        resolve({
          exitCode: watch.exitCode, qemuCode: code, signal, timings,
          stderr: qemuErrorLines(stderr).join('\n'),
          output: watch.text(),
        });
      }, 100);
    });
    child.on('error', (e) => { keep(String(e)); });
  });
  if (opts.timeoutMs) timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, opts.timeoutMs);
  // connect to the console (QEMU listens once it has initialised the chardev)
  const ep = opts.console;
  if (ep && (ep.path || (ep.host && ep.port))) {
    const deadline = Date.now() + (opts.connectTimeoutMs || 20000);
    await new Promise((resolve) => {
      const attempt = () => {
        if (exited) return resolve();
        const s = ep.path ? net.connect({ path: ep.path }) : net.connect({ host: ep.host, port: ep.port });
        s.once('connect', () => { conn = s; timings.consoleConnectedMs = Date.now() - t0; resolve(); });
        s.on('data', (d) => watch.feed(d));
        s.on('error', () => {
          s.destroy();
          if (!conn && Date.now() < deadline && !exited) setTimeout(attempt, 20);
          else if (!conn) resolve();
        });
      };
      attempt();
    });
  }
  const writeConsole = (s) => { if (conn && !conn.destroyed) conn.write(s); };
  return {
    pid: child.pid,
    t0,
    args: opts.args,
    done,
    output: () => watch.text(),
    writeConsole,
    stop: () => writeConsole('__DEVBOX_STOP\n'),
    signal: (sig) => writeConsole('__DEVBOX_KILL ' + String(sig).replace(/^SIG/i, '').toUpperCase() + '\n'),
    kill: () => { try { child.kill(); } catch (e) { /* gone */ } },
  };
}

module.exports = { startVm, consoleWatcher, qemuErrorLines, MARKER_RE };
