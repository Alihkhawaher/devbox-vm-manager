'use strict';
/*
 * lib/tasks.js: locks, guaranteed finalisation (BUG-1, BUG-2, MNT-2), one
 * log for composite operations (MNT-7, BUG-19), history and log caps, and
 * the persistent tasks.log (OPS-17).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const tasks = require('../lib/tasks');
const { CFG } = require('../lib/config');
const { useTempRoot, resetConfig, rm } = require('./helpers');

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

test('start returns at once; the task ends done with its result, and locks are released', async () => {
  tasks._reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = tasks.start({ kind: 'start', title: 'Start web', vm: 'web', locks: ['vm:web'] }, async (t) => {
    t.step('booting');
    await gate;
    t.log('up');
    return { ssh: 'ssh ...' };
  });
  assert.equal(s.status, 'running');
  assert.equal(s.vm, 'web');
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  assert.equal(tasks.vmBusy('web'), s.id);
  assert.equal(tasks.get(s.id).step, 'booting');
  release();
  const done = await tasks.wait(s.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { ssh: 'ssh ...' });
  assert.equal(done.step, null);
  assert.ok(done.endedAt >= done.startedAt);
  assert.equal(tasks.vmBusy('web'), null);
  const full = tasks.get(s.id);
  assert.ok(full.log.some((l) => /booting$/.test(l)));
  assert.ok(full.log.some((l) => /up$/.test(l)));
});

test('a held lock gives BusyError (409) naming the holder; other locks run in parallel', async () => {
  tasks._reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = tasks.start({ kind: 'stop', title: 'Stop web', vm: 'web', locks: ['vm:web'] }, () => gate);
  assert.throws(() => tasks.start({ kind: 'start', title: 'Start web', vm: 'web', locks: ['vm:web'] }, async () => {}),
    (e) => e instanceof tasks.BusyError && e.status === 409 && e.code === 'BUSY' && e.holder.id === a.id && /"Stop web" on web/.test(e.message));
  const b = tasks.start({ kind: 'start', title: 'Start db', vm: 'db', locks: ['vm:db'] }, async () => 'ok');
  assert.equal((await tasks.wait(b.id)).status, 'done');
  assert.throws(() => tasks.assertFree('vm:web'), (e) => e.status === 409);
  release();
  await tasks.wait(a.id);
  tasks.assertFree('vm:web');
});

test('ALWAYS finalised: async throw, sync throw and a non-Error rejection all end as error and free the lock', async () => {
  tasks._reset();
  const a = tasks.start({ kind: 'x', title: 'async', locks: ['vm:a'] }, async () => { await tick(); throw new Error('boom'); });
  const b = tasks.start({ kind: 'x', title: 'sync', locks: ['vm:b'] }, () => { throw new Error('sync boom'); });
  const c = tasks.start({ kind: 'x', title: 'weird', locks: ['vm:c'] }, () => Promise.reject('plain string')); // eslint-disable-line prefer-promise-reject-errors
  for (const [s, msg] of [[a, 'boom'], [b, 'sync boom'], [c, 'plain string']]) {
    const d = await tasks.wait(s.id);
    assert.equal(d.status, 'error');
    assert.equal(d.error, msg);
    assert.ok(tasks.get(s.id).log.some((l) => l.indexOf('ERROR: ' + msg) !== -1));
  }
  for (const l of ['vm:a', 'vm:b', 'vm:c']) assert.equal(tasks.holder(l), null);
});

test('composite operations share ONE task and one log (no nested tasks, no lost lines)', async () => {
  tasks._reset();
  const opStop = async (t) => { t.step('stopping'); t.log('stopped'); };
  const opStart = async (t) => { t.step('starting'); t.log('started'); };
  const opDeploy = async (t) => {
    t.step('Step 1/2: pulling');
    t.log('could not apply live - restarting');
    await opStop(t);
    await opStart(t);
    t.step('Step 2/2: running');
    return { urls: ['http://127.0.0.1:8080'] };
  };
  const s = tasks.start({ kind: 'deploy', title: 'Deploy', vm: 'web', locks: ['vm:web'] }, opDeploy);
  const d = await tasks.wait(s.id);
  assert.equal(d.status, 'done');
  const lines = tasks.get(s.id).log.map((l) => l.replace(/^\[\d\d:\d\d:\d\d\] /, ''));
  assert.deepEqual(lines.filter((l) => !/^(started: |finished in )/.test(l)), [
    'Step 1/2: pulling', 'could not apply live - restarting', 'stopping', 'stopped', 'starting', 'started', 'Step 2/2: running',
  ]);
  assert.equal(tasks.list().length, 1, 'still exactly one task');
});

test('runAndWait returns the result or rethrows the original error (status intact)', async () => {
  tasks._reset();
  assert.equal(await tasks.runAndWait({ kind: 'ports', locks: ['vm:x'] }, async () => 42), 42);
  const { badRequest } = require('../lib/util');
  await assert.rejects(tasks.runAndWait({ kind: 'ports', locks: ['vm:x'] }, async () => { throw badRequest('nope'); }), (e) => e.status === 400 && e.message === 'nope');
  assert.equal(tasks.holder('vm:x'), null);
});

test('history keeps the last 50 finished tasks; running ones are never dropped', async () => {
  tasks._reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  const long = tasks.start({ kind: 'long', title: 'long', locks: ['global'] }, () => gate);
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(tasks.start({ kind: 'k', title: 't' + i }, async () => i).id);
  await Promise.all(ids.map((id) => tasks.wait(id)));
  assert.ok(tasks.list().length <= tasks.MAX_TASKS);
  assert.ok(tasks.get(long.id), 'the running task survives trimming');
  assert.equal(tasks.get(ids[0]), null, 'the oldest finished task is gone');
  assert.ok(tasks.get(ids[59]));
  const o = tasks.overview();
  assert.equal(o.running.length, 1);
  assert.equal(o.recent.length, 10);
  assert.equal(o.recent[0].title, 't59', 'newest first');
  release();
  await tasks.wait(long.id);
});

test('a task log is capped at 2000 lines with a note about the dropped ones', async () => {
  tasks._reset();
  const s = tasks.start({ kind: 'chatty', title: 'chatty' }, async (t) => { for (let i = 0; i < 2500; i++) t.log('line ' + i); });
  await tasks.wait(s.id);
  const log = tasks.get(s.id).log;
  assert.ok(log.length <= tasks.MAX_LINES);
  assert.match(log[0], /earlier line\(s\) dropped/);
  assert.ok(log.some((l) => /line 2499$/.test(l)));
});

test('every log line is appended to <root>/logs/tasks.log', async () => {
  const root = useTempRoot('tasklog');
  try {
    tasks._reset();
    const s = tasks.start({ kind: 'start', title: 'Start web', vm: 'web' }, async (t) => { t.log('hello\nworld'); throw new Error('bad'); });
    await tasks.wait(s.id);
    const txt = fs.readFileSync(CFG.tasksLog, 'utf8');
    assert.match(txt, /\[start [0-9a-f]{8} web\] hello/);
    assert.match(txt, /\[start [0-9a-f]{8} web\] world/);
    assert.match(txt, /ERROR: bad/);
  } finally { tasks._reset(); resetConfig(); rm(root); }
});
