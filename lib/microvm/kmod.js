'use strict';
/*
 * Kernel config + module helpers for the microVM engine.
 *
 *   parseKconfig(text)            -> Map CONFIG_X -> 'y' | 'm' | string
 *                                     ("# CONFIG_X is not set" -> 'n')
 *   kconfigState(map, sym)        -> 'y' | 'm' | 'n' (missing counts as 'n')
 *   parseModulesDep(text)         -> Map relpath -> [dep relpaths]
 *   parseModulesBuiltin(text)     -> Set of module names built in
 *   moduleNameOf(relpath)         -> 'virtio_net'  (dashes -> underscores)
 *   resolveModules(names, dep, builtin)
 *        -> { order: [relpath...] (dependencies first, each once),
 *             builtin: [names built in], missing: [names not found] }
 *   decompressModule(relpath, buf) -> { name: 'x.ko', data }  (.ko, .ko.gz;
 *        .ko.xz / .ko.zst throw: Node < 22.15 has no zstd and no xz at all)
 *
 * Names accept either dashes or underscores (the kernel treats them alike).
 */
const zlib = require('zlib');

function parseKconfig(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let m = /^(CONFIG_[A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m) { map.set(m[1], m[2].replace(/^"(.*)"$/, '$1')); continue; }
    m = /^# (CONFIG_[A-Za-z0-9_]+) is not set$/.exec(line);
    if (m) map.set(m[1], 'n');
  }
  return map;
}

function kconfigState(map, sym) {
  const k = sym.startsWith('CONFIG_') ? sym : 'CONFIG_' + sym;
  const v = map.get(k);
  if (v === undefined) return 'n';
  return v;
}

const moduleNameOf = (rel) => String(rel).split('/').pop().replace(/\.ko(\.[a-z0-9]+)?$/, '').replace(/-/g, '_');
const normName = (n) => String(n).replace(/-/g, '_');

function parseModulesDep(text) {
  const dep = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const deps = line.slice(i + 1).trim().split(/\s+/).filter(Boolean);
    dep.set(key, deps);
  }
  return dep;
}

function parseModulesBuiltin(text) {
  const set = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) set.add(moduleNameOf(line.trim()));
  }
  return set;
}

// Dependency-first order (post-order DFS) over modules.dep.
function resolveModules(names, dep, builtin) {
  const byName = new Map();
  for (const rel of dep.keys()) byName.set(moduleNameOf(rel), rel);
  const order = [];
  const seen = new Set();
  const builtinHit = [];
  const missing = [];
  const visit = (rel, stack) => {
    if (seen.has(rel)) return;
    if (stack.includes(rel)) throw new Error('module dependency cycle at ' + rel);
    for (const d of dep.get(rel) || []) visit(d, stack.concat(rel));
    seen.add(rel);
    order.push(rel);
  };
  for (const raw of names) {
    const n = normName(raw);
    const rel = byName.get(n);
    if (rel) visit(rel, []);
    else if (builtin && builtin.has(n)) builtinHit.push(n);
    else missing.push(n);
  }
  return { order, builtin: builtinHit, missing };
}

function decompressModule(rel, buf) {
  const base = String(rel).split('/').pop();
  if (/\.ko$/.test(base)) return { name: base, data: buf };
  if (/\.ko\.gz$/.test(base)) return { name: base.replace(/\.gz$/, ''), data: zlib.gunzipSync(buf) };
  if (/\.ko\.zst$/.test(base)) {
    if (typeof zlib.zstdDecompressSync === 'function') return { name: base.replace(/\.zst$/, ''), data: zlib.zstdDecompressSync(buf) };
    throw new Error(base + ': zstd modules need Node >= 22.15 (zlib.zstdDecompressSync)');
  }
  throw new Error(base + ': unsupported module compression');
}

module.exports = {
  parseKconfig,
  kconfigState,
  parseModulesDep,
  parseModulesBuiltin,
  moduleNameOf,
  resolveModules,
  decompressModule,
};
