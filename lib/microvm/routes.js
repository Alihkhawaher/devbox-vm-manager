'use strict';
/*
 * HTTP routes of the microVM engine (microVM spec section 11). lib/http.js
 * appends ROUTES to its table, so every route gets the same security checks
 * as the rest of the API (Host/Origin, token, JSON body rules). Route
 * formats: lib/route.js. Locks: 'ctr:<id>' for run/start, 'ctr-stop:<id>'
 * for stop (so a stop is accepted while a run is still pulling or booting),
 * the image mutex inside images.js for pulls and prunes.
 *
 * ROUTE -> FUNCTION (lib/microvm/containers.js unless noted)
 *   GET  /api/containers                         -> listContainers({all})
 *   GET  /api/container?id=&reveal=              -> getContainer({id, reveal})
 *   GET  /api/container/logs?id=&stream=&tail=&prev= -> getLogs({...})
 *   GET  /api/container/logs/stream?id=&stream=&since=&token=
 *                                                -> streamLogs(req, res, {...}) (SSE, raw)
 *   GET  /api/images                             -> images.listImages() (lib/oci/images.js)
 *   GET  /api/volumes                            -> listVolumes()
 *   POST /api/container/run      {image, ...}    -> runRoute(body): validates,
 *        picks the engine (auto|microvm|docker-vm), starts the ctr-run task
 *        or the quick-deploy task, answers 202 {ok, task, engine, reason?}
 *   POST /api/container/start    {id, fresh?} task -> validateStart / opStart (ctr-start, ctr:<id>);
 *        fresh: true drops the writable layer of a disk-root container first
 *   POST /api/container/stop     {id, timeoutS?, force?} task
 *                                                -> validateStop / opStop     (ctr-stop, ctr-stop:<id>)
 *   POST /api/container/kill     {id, signal}    -> kill(body)
 *   POST /api/container/remove   {id, force?}    -> removeRoute(body) (sync, or a task when forced)
 *   POST /api/container/settings {id, ...}       -> updateSettings(body)
 *   POST /api/container/fallback {id, keepOnFailure?} -> fallbackRoute(body) (quick-deploy task)
 *   POST /api/image/pull         {image}   task  -> validatePull / opPull     (image-pull)
 *   POST /api/image/remove       {image | configDigest, force?} -> removeImageRoute(body)
 *   POST /api/images/prune       {}        task  -> validatePrune / opPrune   (image-prune)
 *   POST /api/volume/create      {name, sizeGB?} -> createVolume(body)
 *   POST /api/volume/remove      {name}          -> removeVolume(body)
 * (POST /api/install/kernel is in lib/http.js: install.opInstallKernel.)
 *
 * Handlers are looked up at CALL time (C() below), so the engine work can
 * replace a function in containers.js without touching this table, and
 * requiring this file loads nothing heavy.
 */
const { taskRoute } = require('../route');

const C = () => require('./containers');
const images = () => require('../oci/images');
const flag = (v) => v === '1' || v === 'true';

const ROUTES = [
  { method: 'GET', path: '/api/containers', handler: (c) => C().listContainers({ all: c.q('all') === null ? true : flag(c.q('all')) }) },
  { method: 'GET', path: '/api/container', handler: (c) => C().getContainer({ id: c.q('id'), reveal: flag(c.q('reveal')) }) },
  { method: 'GET', path: '/api/container/logs', handler: (c) => C().getLogs({ id: c.q('id'), stream: c.q('stream'), tail: c.q('tail'), prev: flag(c.q('prev')) }) },
  {
    method: 'GET', path: '/api/container/logs/stream', queryToken: true, raw: true,
    handler: (c) => C().streamLogs(c.req, c.res, { id: c.q('id'), stream: c.q('stream'), since: c.q('since') }),
  },
  { method: 'GET', path: '/api/images', handler: () => images().listImages() },
  { method: 'GET', path: '/api/volumes', handler: () => C().listVolumes() },

  { method: 'POST', path: '/api/container/run', handler: (c) => C().runRoute(c.body) },
  taskRoute({
    path: '/api/container/start', kind: 'ctr-start', title: (a) => 'Start container ' + (a.name || a.id),
    locks: (a) => ['ctr:' + a.id], vm: () => null, ctr: (a) => a.id,
    validate: (b) => C().validateStart(b), run: (t, a) => C().opStart(t, a),
  }),
  taskRoute({
    path: '/api/container/stop', kind: 'ctr-stop', title: (a) => (a.force ? 'Force stop container ' : 'Stop container ') + (a.name || a.id),
    locks: (a) => ['ctr-stop:' + a.id], vm: () => null, ctr: (a) => a.id,
    validate: (b) => C().validateStop(b), run: (t, a) => C().opStop(t, a),
  }),
  { method: 'POST', path: '/api/container/kill', handler: (c) => C().kill(c.body) },
  { method: 'POST', path: '/api/container/remove', handler: (c) => C().removeRoute(c.body) },
  { method: 'POST', path: '/api/container/settings', handler: (c) => C().updateSettings(c.body) },
  { method: 'POST', path: '/api/container/fallback', handler: (c) => C().fallbackRoute(c.body) },
  taskRoute({
    path: '/api/image/pull', kind: 'image-pull', title: (a) => 'Pull ' + a.image,
    locks: () => [], vm: () => null, validate: (b) => C().validatePull(b), run: (t, a) => C().opPull(t, a),
  }),
  { method: 'POST', path: '/api/image/remove', handler: (c) => C().removeImageRoute(c.body) },
  taskRoute({
    path: '/api/images/prune', kind: 'image-prune', title: () => 'Prune unused images',
    locks: () => [], vm: () => null, validate: (b) => C().validatePrune(b), run: (t, a) => C().opPrune(t, a),
  }),
  { method: 'POST', path: '/api/volume/create', handler: (c) => C().createVolume(c.body) },
  { method: 'POST', path: '/api/volume/remove', handler: (c) => C().removeVolume(c.body) },
];

module.exports = { ROUTES };
