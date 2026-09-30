'use strict';
/*
 * Tasks and locks (spec section 6).
 *
 * Anything that takes more than a moment runs as a TASK: the HTTP request
 * returns 202 at once and the GUI/MCP follow the task's live log.
 *
 *   const summary = tasks.start({kind, title, vm, locks}, async (t) => result);
 *
 * - start() throws BusyError (HTTP 409, naming the holder) when any requested
 *   lock is already held. Locks are plain strings: 'global' (QEMU install,
 *   base build), 'qemu' (the QEMU binaries are being replaced), 'vm:<name>',
 *   'template:<name>', 'ctr:<id>' (a microVM container's run/start) and
 *   'ctr-stop:<id>' (its stop - deliberately a different lock, so a stop is
 *   accepted while the run task is still pulling or booting). spec.ctr names
 *   the container a task works on (summary().ctr, ctrBusy(id)). Several
 *   tasks run at once when their locks differ.
 * - The runner ALWAYS finalises (try/finally): status done|error, endedAt,
 *   error, result, locks released. Nothing can leave a task stuck "running"
 *   (BUG-1, BUG-2, OPS-3, MNT-2).
 * - The context `t` is passed down: composite operations call sub-operations
 *   as plain functions with the same `t`, giving ONE task and one log (MNT-7,
 *   BUG-19). t.log(msg), t.step(text) (current step, logged once), t.warn(msg).
 * - The last 50 tasks are kept in memory (logs capped at 2000 lines each) and
 *   every log line is appended to <root>/logs/tasks.log (OPS-17).
 * - Validation belongs BEFORE start(), so bad input is a 400 straight away.
 */
const crypto = require('crypto');
const { CFG } = require('./config');
const { ApiError, appendRotating, errMsg } = require('./util');

const MAX_TASKS = 50;
const MAX_LINES = 2000;

const history = [];          // oldest first
const byId = new Map();
const lockHolders = new Map(); // lock -> task

class BusyError extends ApiError {
  constructor(holder, lock) {
    const what = holder ? '"' + holder.title + '"' + (holder.vm ? ' on ' + holder.vm : '') : 'another operation';
    super(409, 'BUSY', 'busy: ' + what + ' is still running - wait for it to finish');
    this.lock = lock;
    this.holder = holder ? summary(holder) : null;
  }
}

function summary(task) {
  return {
    id: task.id, kind: task.kind, title: task.title, vm: task.vm, ctr: task.ctr,
    status: task.status, step: task.step,
    startedAt: task.startedAt, endedAt: task.endedAt,
    error: task.error, result: task.result,
  };
}

function hhmmss(ms) { return new Date(ms).toTimeString().slice(0, 8); }

function addLine(task, msg) {
  const text = String(msg === undefined || msg === null ? '' : msg).replace(/\r\n/g, '\n');
  const ts = hhmmss(Date.now());
  const lines = text.split('\n');
  let file = '';
  for (const l of lines) {
    task.log.push('[' + ts + '] ' + l);
    file += new Date().toISOString() + ' [' + task.kind + ' ' + task.id.slice(0, 8) + (task.vm ? ' ' + task.vm : '') + '] ' + l + '\n';
  }
  if (task.log.length > MAX_LINES) {
    const drop = task.log.length - MAX_LINES + 1;
    task.dropped = (task.dropped || 0) + drop;
    task.log.splice(0, drop, '[' + ts + '] ... ' + task.dropped + ' earlier line(s) dropped (see logs/tasks.log)');
  }
  try { if (CFG.tasksLog) appendRotating(CFG.tasksLog, file); } catch (e) { /* logging must never break a task */ }
}

function makeContext(task) {
  return {
    id: task.id,
    log(msg) { addLine(task, msg); },
    step(text) { task.step = String(text); addLine(task, text); },
    warn(msg) { addLine(task, 'WARNING: ' + msg); },
    get status() { return task.status; },
  };
}

function trimHistory() {
  while (history.length > MAX_TASKS) {
    const i = history.findIndex((t) => t.status !== 'running');
    if (i === -1) break;
    const [old] = history.splice(i, 1);
    byId.delete(old.id);
  }
}

// Start a task. Returns its summary immediately; fn(t) runs in the background.
function start(spec, fn) {
  spec = spec || {};
  const locks = (spec.locks || []).filter(Boolean).map(String);
  for (const l of locks) {
    const h = lockHolders.get(l);
    if (h) throw new BusyError(h, l);
  }
  const task = {
    id: crypto.randomUUID(),
    kind: String(spec.kind || 'task'),
    title: String(spec.title || spec.kind || 'task'),
    vm: spec.vm || null,
    // the microVM container the task works on (its id): the GUI marks a busy
    // container the way it marks a busy VM
    ctr: spec.ctr || null,
    status: 'running',
    step: null,
    log: [],
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    result: null,
    locks: locks,
    promise: null,
  };
  for (const l of locks) lockHolders.set(l, task);
  history.push(task);
  byId.set(task.id, task);
  trimHistory();
  addLine(task, 'started: ' + task.title);

  const t = makeContext(task);
  task.promise = (async () => {
    try {
      const r = await fn(t);
      task.result = r === undefined ? null : r;
      task.status = 'done';
    } catch (e) {
      task.status = 'error';
      task.error = errMsg(e);
      task.errorObj = e; // kept for runAndWait(); never serialised
      addLine(task, 'ERROR: ' + task.error);
    } finally {
      task.endedAt = Date.now();
      task.step = null;
      for (const l of task.locks) if (lockHolders.get(l) === task) lockHolders.delete(l);
      if (task.status === 'done') addLine(task, 'finished in ' + Math.round((task.endedAt - task.startedAt) / 1000) + ' s');
      trimHistory();
    }
    return summary(task);
  })();
  return summary(task);
}

// Full task (with log) by id, or null.
function get(id) {
  const task = byId.get(String(id || ''));
  if (!task) return null;
  return Object.assign(summary(task), { log: task.log.slice(), locks: task.locks.slice() });
}

// Summaries, newest first.
function list() { return history.slice().reverse().map(summary); }
function latest() { return history.length ? get(history[history.length - 1].id) : null; }
function running() { return history.filter((t) => t.status === 'running').map(summary); }

// {running:[...], recent:[last 10 finished]} for /api/state
function overview() {
  const all = history.slice().reverse();
  return {
    running: all.filter((t) => t.status === 'running').map(summary),
    recent: all.filter((t) => t.status !== 'running').slice(0, 10).map(summary),
  };
}

// Resolves with the final summary once the task has finished.
function wait(id) {
  const task = byId.get(String(id || ''));
  if (!task) return Promise.resolve(null);
  return task.promise.then(() => summary(task));
}

// Run a short operation under its locks and wait for it: resolves with the
// result or rejects with the operation's own error (status codes intact).
// For quick "sync" API calls that must not overlap a task on the same VM
// (e.g. live port-forward changes); they still appear in the task history.
async function runAndWait(spec, fn) {
  const s = start(spec, fn);
  const done = await wait(s.id);
  if (done && done.status === 'error') {
    const task = byId.get(s.id);
    throw (task && task.errorObj) || new Error(done.error);
  }
  return done ? done.result : null;
}

// Who holds a lock (summary) or null.
function holder(lock) {
  const h = lockHolders.get(lock);
  return h ? summary(h) : null;
}
// Throw BusyError if the lock is held (for checks without taking the lock).
function assertFree(lock) {
  const h = lockHolders.get(lock);
  if (h) throw new BusyError(h, lock);
}
// The id of the task holding vm:<name>, or null.
function vmBusy(name) {
  const h = lockHolders.get('vm:' + name);
  return h ? h.id : null;
}
// The id of a running task working on container `id` (holding ctr:<id> or
// ctr-stop:<id>), or null.
function ctrBusy(id) {
  const h = lockHolders.get('ctr:' + id) || lockHolders.get('ctr-stop:' + id);
  return h ? h.id : null;
}

// Tests only: forget everything.
function _reset() { history.length = 0; byId.clear(); lockHolders.clear(); }

module.exports = {
  BusyError, start, runAndWait, get, list, latest, running, overview, wait, holder, assertFree, vmBusy, ctrBusy,
  MAX_TASKS, MAX_LINES, _reset,
};
