'use strict';
/*
 * HTTP routes of the live shared folders (spec SPEC-shares.md section 5).
 * lib/http.js adds ROUTES to its table; every route gets the same security
 * checks as the rest of the API (Host/Origin, token, JSON body rules).
 *
 * Route format (see lib/route.js): {method, path, handler(ctx) -> object}
 * for synchronous calls; ctx = {req, res, url, body, token, q(name)}.
 *
 *   GET  /api/shares?owner=<VM name | container id or name>
 *                                                    -> shares.listShares({owner})
 *        {owner, name, kind: 'vm'|'container', running, port, problem,
 *         shares: [{id, hostPath, guestPath, readOnly, status: 'mounted' |
 *         'not-mounted' | 'pending' | 'unavailable' | 'stopped', mounted,
 *         connections, openFiles, bytesRead, bytesWritten, lastClose:
 *         {reason, at} | null}], caveat}
 *        without owner: {port, shares: [...every share, with owner and kind], caveat}
 *        - never a secret
 *   POST /api/vm/shares {name, action: 'add', hostPath, guestPath, readOnly?}
 *                     | {name, action: 'remove', guestPath | id}
 *                                                    -> shares.vmSharesAction(body)
 *        runs under the VM's lock (409 BUSY while a start/stop runs); a
 *        stopped VM: saved (applied 'next-start'); a running VM: mounted or
 *        unmounted at once over SSH -> {name, share | removed, applied:
 *        'live' | 'next-start', mounted | unmounted, pending, warnings,
 *        shares, caveat}
 *   GET  /api/fs/dirs?path=                          -> shares.listDirs({path})
 *        the GUI folder picker: sub-folders only (never files), {path,
 *        parent, sep, home, roots (drives), readable, error, dirs: [{name,
 *        path, readable, link?, hidden?, refused?}], truncated}; starts at
 *        the user profile
 */
const shares = require('./shares');

const ROUTES = [
  { method: 'GET', path: '/api/shares', handler: (c) => shares.listShares({ owner: c.q('owner') }) },
  { method: 'POST', path: '/api/vm/shares', handler: (c) => shares.vmSharesAction(c.body) },
  { method: 'GET', path: '/api/fs/dirs', handler: (c) => shares.listDirs({ path: c.q('path') }) },
];

module.exports = { ROUTES };
