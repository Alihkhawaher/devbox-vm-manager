'use strict';
/*
 * Screen to text: Windows' own OCR engine (Windows.Media.Ocr, built into
 * Windows 10/11 - nothing is installed) for the screen of an appliance VM, so
 * Claude can read a menu, a dialog or a console message as text instead of
 * looking at a picture, and wait for a phrase to appear instead of waiting for
 * the picture to stop changing (lib/mcp/tools.js: screen_text, wait_for_text,
 * send_keys wait_for). An extra method next to the screenshot, which stays.
 * Other systems have no such engine: available() says so and the routes
 * answer 501 OCR_UNAVAILABLE.
 *
 * One helper process (lib/assets/ocr-helper.ps1, Windows PowerShell 5.1:
 * PowerShell 7 cannot load WinRT types) keeps the engine loaded: about 1.3 s
 * to start once, then 0.06-0.6 s per screen. Requests go one at a time over its
 * stdin/stdout, one JSON line each; it is stopped after IDLE_MS without use,
 * replaced after a crash or a timeout, and ended by shutdown().
 *
 * Screens up to 2000 pixels wide are enlarged 2x first (nearest neighbour, so
 * pixel fonts stay sharp): measured on a UEFI boot menu, 1x read "LIEFI" and
 * "LISB", 2x read "UEFI" and "USB", for ~40 ms more. Positions in the result
 * are in the screen's own pixels.
 *
 * OCR makes small, typical slips ("deuice" for device, "IZ.z.1" for 12.2.1,
 * "@" for 0). findPhrase() looks for a phrase with an approximate substring
 * search (edit distance; case, spaces and punctuation ignored; the usual
 * look-alikes folded together), so "Please select a device" still matches.
 *
 * Exports: available(), recognize({width, height, pixels}, {scale}) ->
 * {text, lines: [{text, x, y, w, h}], width, height, scale, ms, language},
 * shutdown(), and the pure helpers canon(s), findPhrase(text, phrase, opts),
 * maxErrorsFor(n), upscale(img, k), chooseScale(width, requested),
 * joinText(lines), splitPhrases(s).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const png = require('./png');

const HELPER = path.join(__dirname, 'assets', 'ocr-helper.ps1');
const START_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 20000;
const IDLE_MS = 5 * 60 * 1000;
const UNAVAILABLE_RETRY_MS = 5 * 60 * 1000;
const MAX_DIMENSION = 10000;   // Windows.Media.Ocr.OcrEngine.MaxImageDimension

let helper = null;      // {proc, ready, pending: Map(id -> {resolve, reject, timer}), buf, info, stderr}
let seq = 0;
let chain = Promise.resolve();
let idleTimer = null;
let unavailable = null; // {why, at}: the engine refused to load (no OCR language) - not retried for a while

function available() {
  if (process.platform !== 'win32') {
    return { ok: false, why: 'reading the screen as text uses the OCR engine built into Windows 10/11, which ' + process.platform + ' does not have - use the screenshot instead' };
  }
  if (unavailable && Date.now() - unavailable.at < UNAVAILABLE_RETRY_MS) return { ok: false, why: unavailable.why };
  return { ok: true };
}

function unavailableError(why) {
  const e = new Error(why);
  e.status = 501;
  e.code = 'OCR_UNAVAILABLE';
  return e;
}

// Windows PowerShell 5.1 at its fixed place (a PATH without System32 still works)
function powershellExe() {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not there */ }
  return 'powershell.exe';
}

function startHelper() {
  const proc = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { proc: proc, pending: new Map(), buf: '', info: null, stderr: '' };
  h.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the OCR helper did not start within ' + START_TIMEOUT_MS / 1000 + ' s')); stopHelper(h); }, START_TIMEOUT_MS);
    h.onReady = (info) => { clearTimeout(timer); resolve(info); };
    h.onFail = (e) => { clearTimeout(timer); reject(e); };
  });
  h.ready.catch(() => {});   // handled by the caller that awaits it
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    h.buf += d;
    let i;
    while ((i = h.buf.indexOf('\n')) >= 0) {
      const line = h.buf.slice(0, i).trim();
      h.buf = h.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }   // never trust the helper's output blindly
      if (!h.info) {
        h.info = msg;
        if (msg.ready) h.onReady(msg);
        else {
          unavailable = { why: String(msg.error || 'the Windows OCR engine is not available'), at: Date.now() };
          h.onFail(unavailableError(unavailable.why));
        }
        continue;
      }
      const p = h.pending.get(msg.id);
      if (!p) continue;
      h.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok && Array.isArray(msg.lines)) p.resolve(msg);
      else p.reject(new Error('OCR failed: ' + String(msg.error || 'no result')));
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { h.stderr = (h.stderr + d).slice(-2000); });
  const gone = (why) => {
    if (helper === h) helper = null;
    h.onFail(new Error(why));   // a no-op once it is ready
    for (const p of h.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    h.pending.clear();
  };
  proc.on('error', (e) => gone('the OCR helper could not start: ' + e.message));
  proc.on('exit', (code) => {
    const last = h.stderr.trim().split(/\r?\n/).pop();
    gone('the OCR helper stopped (exit code ' + code + ')' + (last ? ': ' + last : ''));
  });
  return h;
}

function stopHelper(h) {
  if (!h) return;
  if (helper === h) helper = null;
  try { h.proc.stdin.end('\n'); } catch (e) { /* already closed */ }
  const t = setTimeout(() => { try { h.proc.kill(); } catch (e) { /* gone */ } }, 2000);
  if (t.unref) t.unref();
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { const h = helper; helper = null; stopHelper(h); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function ask(file) {
  if (!helper) helper = startHelper();
  const h = helper;
  await h.ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      reject(new Error('OCR took longer than ' + REQUEST_TIMEOUT_MS / 1000 + ' s'));
      stopHelper(h);   // a stuck engine is replaced on the next request
    }, REQUEST_TIMEOUT_MS);
    h.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    try { h.proc.stdin.write(JSON.stringify({ id: id, path: file }) + '\n'); }
    catch (e) { clearTimeout(timer); h.pending.delete(id); reject(e); }
  });
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
// 2 for screens up to 2000 px wide (console and firmware fonts), else 1; a
// requested 1-3 is honoured unless the result would pass the engine's limit.
function chooseScale(width, requested) {
  let k = parseInt(requested, 10);
  if (!(k >= 1 && k <= 3)) k = width <= 2000 ? 2 : 1;
  while (k > 1 && width * k > MAX_DIMENSION) k--;
  return k;
}

// Nearest-neighbour enlargement of an RGB image {width, height, pixels}.
function upscale(img, k) {
  if (k === 1) return img;
  const W = img.width * k, H = img.height * k;
  const out = Buffer.alloc(W * H * 3);
  const row = Buffer.alloc(W * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 3;
      for (let i = 0; i < k; i++) img.pixels.copy(row, (x * k + i) * 3, s, s + 3);
    }
    for (let i = 0; i < k; i++) row.copy(out, (y * k + i) * W * 3);
  }
  return { width: W, height: H, pixels: out };
}

// The lines as text: lines whose vertical centres are close share a row
// (a dialog's "<Ok>   <Close>", a menu's "2" and "View installation log"),
// rows top to bottom, each row left to right.
function joinText(lines) {
  const ls = (lines || []).filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ text: l.text.trim(), x: l.x | 0, cy: (l.y | 0) + (l.h | 0) / 2, h: Math.max(1, l.h | 0) }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x);
  const rows = [];
  for (const l of ls) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(l.cy - r.cy) <= 0.6 * Math.max(l.h, r.h)) r.items.push(l);
    else rows.push({ cy: l.cy, h: l.h, items: [l] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join('  ')).join('\n');
}

// Canonical form for matching, with a map back to the original positions:
// lower case, letters and digits only, OCR look-alikes folded together.
const FOLD = { '0': 'o', '@': 'o', '€': 'o', '°': 'o', '1': 'l', 'i': 'l', '|': 'l', '!': 'l', 'ı': 'l', 'í': 'l', '2': 'z', '5': 's', '8': 'b', 'u': 'v' };
function canon(s) {
  const src = String(s || '').replace(/rn/g, 'm');   // "rn" is the classic OCR "m"
  let out = '';
  const map = [];
  const lower = src.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    let c = lower[i];
    if (FOLD[c]) c = FOLD[c];
    if (!/[a-z0-9]/.test(c)) continue;
    out += c;
    map.push(i);
  }
  return { text: out, map: map, source: src };
}

// Errors allowed for a phrase of n canonical characters: none up to 3
// ("ok"), 1 up to 7, then a fifth of the length.
function maxErrorsFor(n) {
  if (n <= 3) return 0;
  if (n <= 7) return 1;
  return Math.floor(n * 0.2);
}

// Is `phrase` on the screen `text`? Approximate substring search (Sellers):
// the fewest edits that turn some part of the text into the phrase.
// -> {found, errors, maxErrors, match (the original text matched, or null)}
function findPhrase(text, phrase, opts) {
  opts = opts || {};
  const P = canon(phrase).text;
  const T = canon(text);
  const m = P.length;
  if (!m) return { found: false, errors: null, maxErrors: 0, match: null };
  const max = Number.isInteger(opts.maxErrors) ? opts.maxErrors : maxErrorsFor(m);
  // col[j] = fewest edits for P[0..j) ending at the current text position;
  // start[j] = where in T that best match starts
  let col = new Array(m + 1), start = new Array(m + 1);
  for (let j = 0; j <= m; j++) { col[j] = j; start[j] = 0; }
  let best = m + 1, bestEnd = -1, bestStart = 0;
  for (let i = 1; i <= T.text.length; i++) {
    const c = T.text[i - 1];
    const next = new Array(m + 1), ns = new Array(m + 1);
    next[0] = 0; ns[0] = i;   // a match may start anywhere
    for (let j = 1; j <= m; j++) {
      const sub = col[j - 1] + (P[j - 1] === c ? 0 : 1);
      const del = col[j] + 1;          // skip a text character
      const ins = next[j - 1] + 1;     // a phrase character missing from the text
      if (sub <= del && sub <= ins) { next[j] = sub; ns[j] = start[j - 1]; }
      else if (del <= ins) { next[j] = del; ns[j] = start[j]; }
      else { next[j] = ins; ns[j] = ns[j - 1]; }
    }
    col = next; start = ns;
    if (col[m] < best) { best = col[m]; bestEnd = i; bestStart = start[m]; }
  }
  if (best > max) return { found: false, errors: best, maxErrors: max, match: null };
  const from = T.map[bestStart] !== undefined ? T.map[bestStart] : 0;
  const to = bestEnd > 0 ? T.map[bestEnd - 1] + 1 : from;
  return { found: true, errors: best, maxErrors: max, match: T.source.slice(from, to) };
}

// "Install Complete | No devices were found" -> ['Install Complete', 'No devices were found']
function splitPhrases(s) {
  return String(s || '').split('|').map((x) => x.trim()).filter(Boolean).slice(0, 10);
}

// ---------------------------------------------------------------------------
// recognize
// ---------------------------------------------------------------------------
// img: {width, height, pixels (RGB)} - e.g. png.parsePpm(<QEMU screendump>).
async function recognize(img, opts) {
  opts = opts || {};
  const a = available();
  if (!a.ok) throw unavailableError(a.why);
  const scale = chooseScale(img.width, opts.scale);
  const src = upscale(img, scale);
  const file = path.join(os.tmpdir(), 'devbox-ocr-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.png');
  fs.writeFileSync(file, png.encodePng(src.width, src.height, src.pixels, { level: 1 }));
  const t0 = Date.now();
  try {
    const job = chain.then(() => ask(file));
    chain = job.catch(() => {});
    const r = await job;
    touchIdle();
    const lines = r.lines.map((l) => ({
      text: String(l.text || ''),
      x: Math.round((l.x | 0) / scale), y: Math.round((l.y | 0) / scale),
      w: Math.round((l.w | 0) / scale), h: Math.round((l.h | 0) / scale),
    }));
    return {
      text: joinText(lines), lines: lines, width: img.width, height: img.height, scale: scale,
      ms: Date.now() - t0, language: helper && helper.info ? helper.info.language || null : null,
    };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch (e) { /* the temp folder is cleaned anyway */ }
  }
}

function shutdown() {
  clearTimeout(idleTimer);
  const h = helper;
  helper = null;
  stopHelper(h);
}

module.exports = {
  available, recognize, shutdown,
  canon, findPhrase, maxErrorsFor, upscale, chooseScale, joinText, splitPhrases,
  HELPER, powershellExe,
};
