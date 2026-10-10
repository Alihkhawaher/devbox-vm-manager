'use strict';
/*
 * The QEMU window of an appliance VM shown in a window on this PC (Windows;
 * lib/appliance.js, display "window"): its picture, and its size.
 *
 * capture(pid): such a VM has no VNC server, and QEMU's screendump cannot
 * read a 3D screen ("no surface"). The helper
 * lib/assets/window-helper.ps1 asks Windows for the window's content
 * (PrintWindow with PW_RENDERFULLCONTENT: GL and Direct3D included, also when
 * other windows cover it) and writes it as PPM - what screendump writes - so
 * lib/screen.js makes the PNG and the OCR text the same way for both views.
 * Windows only: elsewhere available() says why and capture() throws 501
 * WINDOW_CAPTURE_UNAVAILABLE.
 *
 *
 * fit(pid, width, height): QEMU's GTK window opens at the firmware's 640x480
 * and, zooming the guest to fit, stays that small; fit() gives it a client
 * area of width x height (the guest picture plus QEMU's menu bar), at most 90 %
 * of the screen, centred, without taking the focus.
 *
 * One PowerShell per call (about half a second: the helper's C# part is
 * compiled once into <root>/run/wincap/ and loaded from there).
 *
 * Exports: available(), capture(pid) -> Buffer (PPM), fit(pid, w, h) ->
 * {width, height} | {minimized}, parseReply(text).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('./config');
const { run } = require('./util');
const ocr = require('./ocr');

const SCRIPT = path.join(__dirname, 'assets', 'window-helper.ps1');
const TIMEOUT_MS = 30000;

function available() {
  if (process.platform !== 'win32') {
    return { ok: false, why: 'a VM window can only be captured on Windows - switch the VM to the browser view for screenshots' };
  }
  return { ok: true };
}

// The helper's answer: its last JSON line. Pure.
function parseReply(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.charAt(0) === '{').pop();
  if (!line) return { ok: false, error: 'the window capture helper gave no answer' };
  try { return JSON.parse(line); } catch (e) { return { ok: false, error: 'the window capture helper gave a bad answer' }; }
}

// The window of QEMU process `pid` as PPM.
async function capture(pid) {
  const a = available();
  if (!a.ok) { const e = new Error(a.why); e.status = 501; e.code = 'WINDOW_CAPTURE_UNAVAILABLE'; throw e; }
  const n = parseInt(pid, 10);
  if (!(n > 0)) throw new Error('the VM has no QEMU process to capture');
  const file = path.join(os.tmpdir(), 'devbox-window-' + crypto.randomBytes(6).toString('hex') + '.ppm');
  try {
    const r = await run(ocr.powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Action', 'capture', '-ProcessId', String(n), '-Out', file, '-CacheDir', path.join(CFG.runDir, 'wincap')], { timeout: TIMEOUT_MS });
    const reply = parseReply(r.stdout);
    if (!reply.ok) throw new Error('could not capture the VM window: ' + (reply.error || String(r.stderr || '').trim().slice(0, 300) || 'no answer'));
    return fs.readFileSync(file);
  } finally {
    try { fs.rmSync(file, { force: true }); } catch (e) { /* not written */ }
  }
}

// Size the window of QEMU process `pid` (see above). Resolves {width,
// height} of the client area, or {minimized: true} (left alone).
async function fit(pid, width, height) {
  const a = available();
  if (!a.ok) { const e = new Error(a.why); e.status = 501; e.code = 'WINDOW_CAPTURE_UNAVAILABLE'; throw e; }
  const n = parseInt(pid, 10);
  if (!(n > 0)) throw new Error('the VM has no QEMU process');
  const w = Math.max(320, Math.min(8192, parseInt(width, 10) || 1280));
  const h = Math.max(240, Math.min(8192, parseInt(height, 10) || 800));
  const r = await run(ocr.powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-Action', 'fit', '-ProcessId', String(n), '-Width', String(w), '-Height', String(h), '-CacheDir', path.join(CFG.runDir, 'wincap')], { timeout: TIMEOUT_MS });
  const reply = parseReply(r.stdout);
  if (!reply.ok) throw new Error('could not size the VM window: ' + (reply.error || String(r.stderr || '').trim().slice(0, 300) || 'no answer'));
  return reply.minimized ? { minimized: true } : { width: reply.width, height: reply.height };
}

module.exports = { available, capture, fit, parseReply };
