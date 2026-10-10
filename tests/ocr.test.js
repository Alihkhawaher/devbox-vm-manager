'use strict';
/*
 * lib/ocr.js: the phrase matcher on the slips Windows' OCR really made on
 * 2026-10-10 (LibreELEC's installer, a UEFI boot menu, a kernel panic), the
 * enlargement, the row grouping, and - on Windows - the real engine on four
 * real screenshots of those screens (tests/fixtures/ocr), including a restart
 * of the helper after shutdown(). OCR_SKIP=1 skips the real engine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ocr = require('../lib/ocr');

const FIX = path.join(__dirname, 'fixtures', 'ocr');

// The fixtures were written by lib/png.js: 8-bit RGB, filter 0 on every row.
function decodePng(buf) {
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  assert.equal(buf[24], 8); assert.equal(buf[25], 2);
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 3 + 1)], 0, 'filter 0');
    raw.copy(pixels, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));
  }
  return { width: width, height: height, pixels: pixels };
}

test('findPhrase: the OCR slips seen on real screens still match; other text does not', () => {
  const real = {
    device: 'QUICK INSTALL MENU\nuse the up/down arrows to select the deuice\nyou wish to install to.\nPlease select a deuice:\ndeuzsda',
    complete: 'LibreELEC Install Complete\nYou may now remoue the install media and reboot .',
    menu: 'instal ler: permanently install LibreELEC to HDD/SSD\nI iue: boot LibreELEC using RAM for temporary storage',
    version: 'L i breELEC  Instal ler —  L i breELEC  (official):  IZ.z.1',
    panic: 'Kernel panic\nnot syncing: attempted to kill the idle task!',
  };
  const yes = [
    ['device', 'Please select a device'], ['device', 'select the device you wish to install to'],
    ['complete', 'Install Complete'], ['complete', 'remove the install media'],
    ['menu', 'installer: permanently install LibreELEC'], ['menu', 'boot LibreELEC using RAM'],
    ['version', 'LibreELEC Installer'], ['version', '12.2.1'],
    ['panic', 'Kernel panic - not syncing'], ['panic', 'attempted to kill the idle task'],
  ];
  for (const [k, p] of yes) assert.ok(ocr.findPhrase(real[k], p).found, JSON.stringify(p) + ' in ' + k + ': ' + JSON.stringify(ocr.findPhrase(real[k], p)));
  const no = [['complete', 'No devices were found'], ['device', 'Install Complete'], ['panic', 'Welcome to LibreELEC'], ['menu', 'Ok']];
  for (const [k, p] of no) assert.equal(ocr.findPhrase(real[k], p).found, false, JSON.stringify(p) + ' must not be in ' + k);
  // the matched part of the ORIGINAL text comes back, slips and all
  assert.equal(ocr.findPhrase(real.complete, 'remove the install media').match, 'remoue the install media');
  assert.equal(ocr.findPhrase(real.device, 'select a device').errors, 0, 'u/v are folded together, not counted');
  // short phrases must match exactly (after folding): "Ok" is not "No"
  assert.ok(ocr.findPhrase('<Ok>    <Close>', 'Ok').found);
  assert.equal(ocr.findPhrase('<No>', 'Ok').found, false);
  assert.equal(ocr.findPhrase('anything', '').found, false);
  assert.equal(ocr.findPhrase('', 'Install').found, false);
});

test('maxErrorsFor, chooseScale, splitPhrases', () => {
  assert.deepEqual([2, 3, 4, 7, 8, 10, 20].map(ocr.maxErrorsFor), [0, 0, 1, 1, 1, 2, 4]);
  assert.equal(ocr.chooseScale(720), 2);
  assert.equal(ocr.chooseScale(1280), 2);
  assert.equal(ocr.chooseScale(2560), 1);
  assert.equal(ocr.chooseScale(1280, '1'), 1);
  assert.equal(ocr.chooseScale(4000, 3), 2, 'never past the engine\'s 10000 px');
  assert.equal(ocr.chooseScale(1280, 'x'), 2);
  assert.deepEqual(ocr.splitPhrases(' Install Complete | No devices were found |'), ['Install Complete', 'No devices were found']);
  assert.deepEqual(ocr.splitPhrases(''), []);
});

test('upscale: nearest neighbour, every pixel becomes a k x k block', () => {
  const img = { width: 2, height: 1, pixels: Buffer.from([1, 2, 3, 4, 5, 6]) };
  const u = ocr.upscale(img, 2);
  assert.equal(u.width, 4); assert.equal(u.height, 2);
  assert.deepEqual(Array.from(u.pixels), [1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6, 1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6]);
  assert.equal(ocr.upscale(img, 1), img);
});

test('joinText: lines on the same row share it, left to right; rows top to bottom', () => {
  const t = ocr.joinText([
    { text: 'View installation log', x: 560, y: 418, w: 160, h: 13 },
    { text: '2', x: 544, y: 419, w: 8, h: 12 },
    { text: '1 Install LibreELEC', x: 544, y: 402, w: 150, h: 13 },
    { text: '<Close>', x: 704, y: 498, w: 50, h: 13 },
    { text: '<Ok>', x: 496, y: 498, w: 30, h: 13 },
    { text: '   ', x: 0, y: 0, w: 1, h: 1 },
  ]);
  assert.equal(t, '1 Install LibreELEC\n2  View installation log\n<Ok>  <Close>');
  assert.equal(ocr.joinText([]), '');
});

const REAL = process.platform === 'win32' && !process.env.OCR_SKIP;

test('recognize: the real Windows engine on four real screens (and again after shutdown)', { skip: !REAL && 'Windows only (or OCR_SKIP is set)' }, async () => {
  const cases = [
    ['installer-complete.png', ['Install Complete', 'remove the install media']],
    ['installer-device.png', ['Please select a device', 'QUICK INSTALL MENU']],
    ['uefi-boot-menu.png', ['UEFI Misc Device', 'boot LibreELEC using RAM for temporary storage', 'USB memory device']],
    ['kernel-panic.png', ['Kernel panic', 'attempted to kill the idle task']],
  ];
  try {
    for (const [file, phrases] of cases) {
      const img = decodePng(fs.readFileSync(path.join(FIX, file)));
      const r = await ocr.recognize(img);
      assert.equal(r.width, img.width);
      assert.equal(r.scale, 2, 'screens this size are read at 2x');
      assert.ok(r.lines.length > 0, file);
      for (const l of r.lines) {
        assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= img.width + 2 && l.y + l.h <= img.height + 2, file + ': position in the screen\'s own pixels: ' + JSON.stringify(l));
      }
      for (const p of phrases) assert.ok(ocr.findPhrase(r.text, p).found, file + ': ' + JSON.stringify(p) + ' not found in:\n' + r.text);
      assert.ok(r.ms < 10000, file + ' took ' + r.ms + ' ms');
    }
    // the helper is replaced transparently after shutdown()
    ocr.shutdown();
    const again = await ocr.recognize(decodePng(fs.readFileSync(path.join(FIX, 'installer-complete.png'))), { scale: 1 });
    assert.equal(again.scale, 1);
    assert.ok(ocr.findPhrase(again.text, 'Install Complete').found, again.text);
  } finally {
    ocr.shutdown();
  }
});

test('off Windows, recognize() refuses with 501 OCR_UNAVAILABLE and says why', { skip: process.platform === 'win32' && 'not on Windows' }, async () => {
  await assert.rejects(ocr.recognize({ width: 1, height: 1, pixels: Buffer.alloc(3) }), (e) => e.status === 501 && e.code === 'OCR_UNAVAILABLE' && /Windows/.test(e.message));
});
