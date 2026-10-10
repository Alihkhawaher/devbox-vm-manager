'use strict';
/*
 * lib/png.js: binary PPM (QEMU screendump) parsing and the minimal RGB PNG
 * encoder, including its own CRC-32 (checked here against a second,
 * independent bitwise implementation and the known IEND CRC).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const png = require('../lib/png');
const { rm } = require('./helpers');

// 3x2 image: red, green, blue / white, black, grey. Comment line in the header.
const PIXELS = Buffer.from([
  255, 0, 0, 0, 255, 0, 0, 0, 255,
  255, 255, 255, 0, 0, 0, 128, 128, 128,
]);
const PPM = Buffer.concat([Buffer.from('P6\n# made by a test\n3 2\n255\n', 'latin1'), PIXELS]);

// Independent bitwise CRC-32 (no table) to cross-check the module's.
function slowCrc(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Splits a PNG after the signature into [{type, data, crc}].
function chunks(buf) {
  const out = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len), crc: buf.readUInt32BE(pos + 8 + len), typeAndData: buf.subarray(pos + 4, pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

test('parsePpm: P6 header with comment, maxval 255, raw body', () => {
  const p = png.parsePpm(PPM);
  assert.equal(p.width, 3);
  assert.equal(p.height, 2);
  assert.equal(p.maxval, 255);
  assert.deepEqual(Buffer.from(p.pixels), PIXELS);
  // header tokens on one line, comment between tokens, CRLF
  const p2 = png.parsePpm(Buffer.concat([Buffer.from('P6 3 # x\r\n2 255 ', 'latin1'), PIXELS]));
  assert.equal(p2.width, 3);
  assert.equal(p2.height, 2);
});

test('parsePpm: rejects bad magic, maxval, short and long bodies', () => {
  assert.throws(() => png.parsePpm(Buffer.concat([Buffer.from('P3\n3 2\n255\n'), PIXELS])), /not a binary PPM/);
  assert.throws(() => png.parsePpm(Buffer.concat([Buffer.from('P6\n3 2\n65535\n'), PIXELS])), /maxval 65535/);
  assert.throws(() => png.parsePpm(PPM.subarray(0, PPM.length - 1)), /body is 17 bytes, expected 18/);
  assert.throws(() => png.parsePpm(Buffer.concat([PPM, Buffer.from([1])])), /body is 19 bytes/);
  assert.throws(() => png.parsePpm(Buffer.from('P6\n3')), /truncated header/);
  assert.throws(() => png.parsePpm(Buffer.from('P6\n0 2\n255\n')), /unsupported size/);
  assert.throws(() => png.parsePpm('P6'), TypeError);
});

test('crc32: matches an independent implementation and the known IEND CRC', () => {
  assert.equal(png.crc32(Buffer.from('IEND')), 0xae426082);
  for (const s of ['', 'a', 'abc', 'The quick brown fox jumps over the lazy dog', PPM]) {
    assert.equal(png.crc32(Buffer.from(s)), slowCrc(Buffer.from(s)));
  }
  assert.equal(png.crc32(Buffer.from('123456789')), 0xcbf43926); // the CRC-32 check value
});

test('encodePng: signature, IHDR, IDAT inflates to filtered scanlines, IEND', () => {
  const out = png.encodePng(3, 2, PIXELS);
  assert.deepEqual(out.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const cs = chunks(out);
  assert.deepEqual(cs.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = cs[0];
  assert.equal(ihdr.data.length, 13);
  assert.equal(ihdr.data.readUInt32BE(0), 3);
  assert.equal(ihdr.data.readUInt32BE(4), 2);
  assert.deepEqual([...ihdr.data.subarray(8)], [8, 2, 0, 0, 0]);
  for (const c of cs) assert.equal(c.crc, slowCrc(c.typeAndData), `CRC of ${c.type}`);
  assert.deepEqual(out.subarray(out.length - 4), Buffer.from([0xae, 0x42, 0x60, 0x82]));
  const raw = zlib.inflateSync(cs[1].data);
  assert.equal(raw.length, 2 * (1 + 3 * 3));
  assert.deepEqual(Buffer.from(raw), Buffer.concat([Buffer.from([0]), PIXELS.subarray(0, 9), Buffer.from([0]), PIXELS.subarray(9)]));
  // opts.level is passed to zlib (level 0 = stored, so the IDAT is larger)
  assert.ok(png.encodePng(3, 2, PIXELS, { level: 0 }).length >= out.length);
  assert.throws(() => png.encodePng(3, 2, PIXELS.subarray(1)), /expected 18 RGB bytes, got 17/);
  assert.throws(() => png.encodePng(0, 2, PIXELS), /bad size/);
});

test('ppmToPng: writes a file that reads back with the PNG signature', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-png-'));
  try {
    const f = path.join(d, 'shot.png');
    fs.writeFileSync(f, png.ppmToPng(PPM));
    const back = fs.readFileSync(f);
    assert.deepEqual(back.subarray(0, 8), png.SIGNATURE);
    assert.deepEqual(back, png.encodePng(3, 2, PIXELS));
    assert.equal(back.toString('latin1', 12, 16), 'IHDR');
  } finally {
    rm(d);
  }
});
