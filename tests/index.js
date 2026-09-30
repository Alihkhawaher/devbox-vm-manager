'use strict';
/*
 * Makes `node --test tests/` (the npm test script) work on every supported
 * Node version.
 *
 * Node 18 and 20 treat a directory argument as "search this folder for
 * *.test.js files" and never run this file. Node 22+ treat the argument as a
 * file pattern instead; the folder itself matches, and running a folder
 * resolves to its index.js - this file - so it loads every test file itself.
 * Without it, `node --test tests/` fails on Node 22+ with "Cannot find module".
 */
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (/\.test\.js$/.test(f)) require(path.join(__dirname, f));
}
