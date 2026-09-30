'use strict';
/*
 * Building blocks for API route tables, shared by lib/http.js and the route
 * tables other modules export (lib/microvm/routes.js, lib/shares-routes.js),
 * so a module can add endpoints without editing http.js.
 *
 * A route is one of:
 *   {method, path, handler(ctx)}           synchronous; the handler's object
 *                                          is sent as 200 {ok: true, ...};
 *                                          accepted(...) makes it a 202
 *   {method: 'GET', path, raw: true, queryToken: true, handler(ctx)}
 *                                          the handler writes the response
 *                                          itself (SSE streams); queryToken
 *                                          lets EventSource pass ?token=
 *   taskRoute({path, kind, title, locks, vm, ctr, validate, run})
 *                                          validate(body) runs first (bad
 *                                          input is a 4xx and starts
 *                                          nothing), then run(t, args) as a
 *                                          task -> 202 {ok, task}
 *   {auth: false}                          no token (only GET /api/ping)
 * ctx = {req, res, url, body (POST: the parsed JSON object), token, q(name)
 *        (a query-string value or null)}
 *
 * Exports: taskRoute(o), accepted(task, extra), statusOf(out), startTask(spec,
 * fn, args), STATUS.
 */
const tasks = require('./tasks');
const ports = require('./ports');

const STATUS = Symbol.for('devbox.httpStatus');

// o: {path, kind, title(args) -> string, locks(args) -> [lock] (default
//     ['vm:' + args.name]), vm(args) -> VM name | null (default args.name),
//     ctr(args) -> container id | null, validate(body), run(t, args)}
function taskRoute(o) {
  return {
    method: 'POST', path: o.path,
    task: {
      kind: o.kind,
      title: o.title || (() => o.kind),
      locks: o.locks || ((a) => ['vm:' + a.name]),
      vm: o.vm || ((a) => (a && a.name ? a.name : null)),
      ctr: o.ctr || (() => null),
    },
    validate: o.validate, run: o.run,
  };
}

// A handler's reply for "a task was started" (202), e.g. when the handler
// itself decides WHICH task to start. extra: more fields for the body.
function accepted(task, extra) {
  const out = Object.assign({ task: task }, extra || {});
  Object.defineProperty(out, STATUS, { value: 202, enumerable: false });
  return out;
}
function statusOf(out) { return (out && out[STATUS]) || 200; }

// tasks.start that hands back host ports a validator claimed (args.claimed)
// when the task cannot start (409 BUSY), like http.js does for task routes.
function startTask(spec, fn, args) {
  try { return tasks.start(spec, fn); }
  catch (e) { ports.releaseClaims(args); throw e; }
}

module.exports = { taskRoute, accepted, statusOf, startTask, STATUS };
