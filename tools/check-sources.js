// Verify the manager's source-discovery logic (the same code paths used by
// POST /api/install/qemu and POST /api/install/base).
const https = require('https');

function fetchText(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vm-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 8) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}
function head(url) {
  return new Promise((resolve) => {
    https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'vm-manager' } }, r => resolve(r.statusCode))
      .on('error', () => resolve('ERR')).end();
  });
}

(async () => {
  const out = [];
  try {
    // --- QEMU: exactly what opInstallQemu does ---
    const listing = await fetchText('https://qemu.weilnetz.de/w64/');
    const hits = listing.match(/qemu-w64-setup-\d{8}\.exe/g) || [];
    if (!hits.length) throw new Error('no qemu-w64-setup-*.exe found in listing');
    const file = hits.sort().pop();
    const year = file.slice('qemu-w64-setup-'.length, 'qemu-w64-setup-'.length + 4);
    const qurl = 'https://qemu.weilnetz.de/w64/' + year + '/' + file;
    const qcode = await head(qurl);
    out.push('QEMU   discovered: ' + file);
    out.push('QEMU   url       : ' + qurl);
    out.push('QEMU   HEAD      : HTTP ' + qcode + (qcode === 200 ? '  OK - downloadable' : '  BROKEN'));
  } catch (e) { out.push('QEMU   FAILED: ' + e.message); }

  try {
    // --- Alpine: exactly what pickAlpineUrl does ---
    let found = null;
    for (const branch of ['v3.21', 'v3.20', 'v3.22']) {
      try {
        const list = await fetchText('https://dl-cdn.alpinelinux.org/alpine/' + branch + '/releases/cloud/');
        const hits = list.match(/nocloud_alpine-[\d.]+-x86_64-bios-cloudinit-r0\.qcow2/g) || [];
        if (hits.length) {
          const pick = hits.sort((a, b) => {
            const pa = a.match(/alpine-([\d.]+)-/)[1].split('.').map(Number);
            const pb = b.match(/alpine-([\d.]+)-/)[1].split('.').map(Number);
            for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
            return 0;
          }).pop();
          found = 'https://dl-cdn.alpinelinux.org/alpine/' + branch + '/releases/cloud/' + pick;
          break;
        }
      } catch (e) { /* next branch */ }
    }
    if (!found) throw new Error('no nocloud bios-cloudinit image found');
    const acode = await head(found);
    out.push('ALPINE discovered: ' + found.split('/').pop());
    out.push('ALPINE url       : ' + found);
    out.push('ALPINE HEAD      : HTTP ' + acode + (acode === 200 ? '  OK - downloadable' : '  BROKEN'));
  } catch (e) { out.push('ALPINE FAILED: ' + e.message); }

  require('fs').writeFileSync(process.argv[2] || 'source-check.txt', out.join('\n') + '\n');
  console.log(out.join('\n'));
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });