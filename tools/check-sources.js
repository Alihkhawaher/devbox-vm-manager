#!/usr/bin/env node
'use strict';
/*
 * Check that the download sources the installer depends on still work, by
 * running the SAME discovery code the manager uses (lib/install.js:
 * findQemuInstaller for "Install QEMU", findAlpineImage for the base image
 * build - MNT-14, OPS-12). Nothing is downloaded: each file is only checked
 * with a HEAD request, plus its published sha512 sidecar.
 *
 * Usage: node tools/check-sources.js [report-file]
 *   Prints the report; writes it to report-file only when one is given.
 *   Exit code 1 when a source is broken.
 */
const fs = require('fs');
const install = require('../lib/install');
const { headInfo, fetchSha512 } = require('../lib/download');

async function check(label, find) {
  const out = [];
  let ok = true;
  try {
    const src = await find();
    const head = await headInfo(src.url);
    const sha = await fetchSha512(src.url, { sidecarUrl: src.sha512Url, fileName: src.file });
    const good = head.status === 200;
    ok = good;
    out.push(label + ' file    : ' + src.file + (src.verified === false ? '   (WARNING: untested image family)' : ''));
    out.push(label + ' url     : ' + src.url);
    out.push(label + ' HEAD    : ' + (head.status === null ? 'unreachable (' + head.error + ')' : 'HTTP ' + head.status) +
      (head.length ? ', ' + (head.length / 1048576).toFixed(1) + ' MB' : '') + (good ? '  OK - downloadable' : '  BROKEN'));
    out.push(label + ' sha512  : ' + (sha ? 'published (' + sha.slice(0, 16) + '...)' : 'not published - the download cannot be verified'));
  } catch (e) {
    ok = false;
    out.push(label + ' FAILED  : ' + (e && e.message ? e.message : e));
  }
  return { ok: ok, lines: out };
}

(async () => {
  const q = await check('QEMU  ', () => install.findQemuInstaller());
  const a = await check('ALPINE', () => install.findAlpineImage());
  const text = q.lines.concat(a.lines).join('\n') + '\n';
  process.stdout.write(text);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], text);
  process.exitCode = q.ok && a.ok ? 0 : 1;
})().catch((e) => { console.error('FATAL ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
