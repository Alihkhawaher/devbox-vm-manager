'use strict';
/*
 * The container registry file: <root>/containers.json (CFG.containersFile),
 * schema version 1 (microVM spec section 6). Kept apart from vms.json: no
 * vms.json schema bump, and a downgrade to an app without microVMs simply
 * ignores it. Only the manager writes it (MCP and GUI go through the API;
 * the second-instance check guarantees one manager per data root).
 *
 *   { "version": 1,
 *     "containers": { "<id>": { id, name, image, reference, ..., status,
 *                               runtime: {...} | null } } }
 *
 * The same rules as vms.json (lib/state.js, spec SPEC.md section 4):
 *  - save() writes ONLY when the serialised registry changed, atomically
 *    (tmp + fsync + rename), keeping the previous file as .bak;
 *  - a file that cannot be parsed is renamed to containers.json.corrupt-<time>
 *    (never overwritten), the .bak is tried, and a warning is surfaced
 *    (/api/state stateWarning); a file that cannot be READ blocks all writes;
 *  - write errors are logged and surfaced, never swallowed;
 *  - fields this version does not know are KEPT (a newer app's records
 *    survive a round trip through this one).
 * The record shape itself (validation, defaults) belongs to containers.js;
 * this module only needs every record to be an object with a valid id - and
 * normalises the two root-file-system fields on load: a record without
 * rootfs (made by v2.0.0, whose RAM root reset at every start) gets 'disk' -
 * a fresh disk root is the same starting state; a rootDisk that does not
 * name a .qcow2 under images/disks/ (relative, no '..') is dropped.
 *
 * `store.data` is the single shared registry object; load() replaces its
 * containers in place, so `const { data } = require('./store')` stays live.
 * Nothing touches the disk until load() is called.
 *
 * Exports: data, load(), save(), warnings(), warning(), get(id), put(rec),
 *   remove(id), list(), isId(s), newId(), normalize(raw), _meta.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CFG } = require('../config');
const { atomicWriteFileSync, logError, log, errMsg } = require('../util');

const VERSION = 1;
const ID_RE = /^[0-9a-f]{12}$/;

const data = { version: VERSION, containers: {} };
const meta = { lastWritten: null, noWrite: null, warnings: [], writeError: null, loaded: false };

function warn(msg) {
  if (meta.warnings.indexOf(msg) === -1) meta.warnings.push(msg);
  logError(msg);
}
function warnings() {
  const all = meta.warnings.slice();
  if (meta.writeError) all.push(meta.writeError);
  return all;
}
function warning() { const w = warnings(); return w.length ? w.join(' | ') : null; }

const isId = (s) => typeof s === 'string' && ID_RE.test(s);
const newId = () => crypto.randomBytes(6).toString('hex');

// rootDisk: {configDigest, disk: 'images/disks/<name>.qcow2', createdAt, virtualBytes}
function validRootDisk(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (typeof d.configDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(d.configDigest)) return false;
  return typeof d.disk === 'string' && /^images\/disks\/[A-Za-z0-9_.-]{1,120}\.qcow2$/.test(d.disk) && d.disk.indexOf('..') === -1;
}

// Keep every record that is an object with a valid id (its key must match).
// Pure: returns {containers, dropped: [keys]}.
function normalize(raw) {
  const out = {};
  const dropped = [];
  const src = raw && typeof raw === 'object' && raw.containers && typeof raw.containers === 'object' ? raw.containers : {};
  for (const key of Object.keys(src)) {
    const rec = src[key];
    if (!isId(key) || !rec || typeof rec !== 'object' || Array.isArray(rec)) { dropped.push(key); continue; }
    const r = Object.assign({}, rec, { id: key });
    if (r.rootfs !== 'disk' && r.rootfs !== 'ram') {
      // a v2.0 record (it has no rootfs: it ran from RAM) becomes a disk
      // root; with automatic memory it was sized to hold its image, so its
      // first disk-root start keeps that much (containers.js, cr-3)
      if (r.rootfs === undefined && (r.mem === null || r.mem === undefined) && r.reference) r.autoMemFromRam = true;
      r.rootfs = 'disk';
    }
    if (r.rootDisk !== undefined && r.rootDisk !== null && !validRootDisk(r.rootDisk)) r.rootDisk = null;
    out[key] = r;
  }
  return { containers: out, dropped };
}

function readText(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), error: null }; }
  catch (e) { return { text: null, error: e }; }
}
function parse(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the top level is not a JSON object');
  if (raw.version !== undefined && raw.version > VERSION) {
    // a newer app wrote it: read what we understand, but never write it back
    meta.noWrite = 'containers.json was written by a newer version of the manager (format ' + raw.version + ') - changes to containers are NOT being saved';
  }
  return raw;
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Load (or start empty). Never overwrites a file it could not parse.
function load() {
  const file = CFG.containersFile;
  meta.warnings = [];
  meta.noWrite = null;
  meta.writeError = null;
  meta.lastWritten = null;
  let r = readText(file);
  if (r.error && r.error.code === 'ENOENT' && fs.existsSync(file + '.bak')) {
    // a crash between the backup copy and the rename leaves only .bak
    r = readText(file + '.bak');
    if (!r.error) warn('containers.json was missing; restored it from containers.json.bak');
  }
  let raw = null;
  if (r.error && r.error.code !== 'ENOENT') {
    meta.noWrite = 'containers.json exists but cannot be read (' + errMsg(r.error) + ') - changes to containers are NOT being saved';
    warn(meta.noWrite);
  } else if (r.text !== null) {
    try { raw = parse(r.text); meta.lastWritten = r.text; }
    catch (e) {
      const aside = file + '.corrupt-' + stamp();
      try { fs.renameSync(file, aside); } catch (e2) { /* noWrite below protects it */ }
      if (fs.existsSync(file)) meta.noWrite = 'containers.json is damaged and could not be moved aside - changes to containers are NOT being saved';
      warn('containers.json could not be parsed (' + errMsg(e) + '); it was kept as ' + path.basename(aside));
      const bak = readText(file + '.bak');
      if (!bak.error && bak.text) {
        try { raw = parse(bak.text); warn('restored the container list from containers.json.bak'); }
        catch (e3) { /* the backup is damaged too: start empty */ }
      }
    }
    if (meta.noWrite && raw) warn(meta.noWrite);
  }
  const n = normalize(raw || {});
  for (const k of Object.keys(data.containers)) delete data.containers[k];
  Object.assign(data.containers, n.containers);
  data.version = VERSION;
  for (const k of n.dropped) warn('containers.json: the record "' + String(k).slice(0, 40) + '" is not valid and was not loaded');
  meta.loaded = true;
  return data;
}

// Write if (and only if) the registry changed. Returns true when the file on
// disk now matches memory.
function save() {
  if (meta.noWrite) return false;
  const text = JSON.stringify({ version: VERSION, containers: data.containers }, null, 2) + '\n';
  if (text === meta.lastWritten) return true;
  const file = CFG.containersFile;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // env values and share secrets are in here: both files are written
    // private (sec-5 - a plain copy or write would inherit the data
    // folder's ACL, which lets every account of this PC read it)
    const platform = require('../platform');
    if (fs.existsSync(file)) {
      try { platform.writePrivateFileSync(file + '.bak', fs.readFileSync(file), { atomic: true, tmpDir: CFG.runDir }); }
      catch (e) { /* the atomic write still protects us */ }
    }
    platform.writePrivateFileSync(file, text, { atomic: true, tmpDir: CFG.runDir });
    meta.lastWritten = text;
    if (meta.writeError) { log('containers.json is being saved again'); meta.writeError = null; }
    return true;
  } catch (e) {
    const msg = 'could not save containers.json: ' + errMsg(e);
    if (meta.writeError !== msg) logError(msg);
    meta.writeError = msg;
    return false;
  }
}

function get(id) { return isId(id) ? data.containers[id] || null : null; }
function put(rec) {
  if (!rec || !isId(rec.id)) throw new Error('a container record needs a 12-hex id');
  data.containers[rec.id] = rec;
  return rec;
}
function remove(id) {
  if (!data.containers[id]) return false;
  delete data.containers[id];
  return true;
}
// Records sorted by creation time (oldest first), then id.
function list() {
  return Object.values(data.containers).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
}

module.exports = {
  data, VERSION, load, save, warnings, warning, get, put, remove, list, isId, newId, normalize, validRootDisk,
  _meta: meta,
};
