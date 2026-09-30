'use strict';
/*
 * The API tables in README.md must list exactly the routes lib/http.js
 * serves (MNT-15): a route added, removed or renamed in the ROUTES table
 * without the README (or the other way round) fails `npm test`, so the
 * documentation cannot drift from the code again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./helpers'); // points CFG at a scratch root before lib/ is used
const { ROUTES } = require('../lib/http');

// "| `GET /api/task?id=` | ..." rows of the "## API" section -> "GET /api/task"
function readmeRoutes(text) {
  const start = text.search(/^## API\s*$/m);
  assert.ok(start >= 0, 'README.md has an "## API" section');
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`(GET|POST|PUT|DELETE|PATCH) (\/api\/[^`?\s]*)/);
    if (m) out.push(m[1] + ' ' + m[2]);
  }
  return out;
}

test('README API tables == the route table in lib/http.js, both ways', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const documented = readmeRoutes(text);
  const served = ROUTES.map((r) => r.method + ' ' + r.path);
  const dupes = documented.filter((r, i) => documented.indexOf(r) !== i);
  assert.deepEqual(dupes, [], 'a route is documented twice');
  const missing = served.filter((r) => documented.indexOf(r) === -1);
  const stale = documented.filter((r) => served.indexOf(r) === -1);
  assert.deepEqual(missing, [], 'served but not in the README API section');
  assert.deepEqual(stale, [], 'in the README but not served');
});

test('readmeRoutes reads only the API section and strips query strings', () => {
  const md = '# x\n| `GET /api/nope` | outside |\n## API\n| `GET /api/ping` | public |\n| `GET /api/log?name=&tail=` | x |\n| `POST /api/vm/start` | {name} |\n## Development\n| `POST /api/later` | x |\n';
  assert.deepEqual(readmeRoutes(md), ['GET /api/ping', 'GET /api/log', 'POST /api/vm/start']);
});
