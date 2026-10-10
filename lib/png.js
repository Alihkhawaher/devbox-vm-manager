'use strict';
/*
 * Screenshots: binary PPM (what QEMU's monitor `screendump` writes) to PNG,
 * with the Node standard library only.
 *
 * parsePpm() reads a 'P6' file: header tokens (magic, width, height, maxval)
 * separated by whitespace, '#' comments allowed anywhere in the header, one
 * whitespace byte after maxval, then width*height*3 raw RGB bytes. Only
 * maxval 255 is accepted (QEMU never writes 16-bit samples) and the body
 * must hold exactly the expected byte count - a truncated dump (VM reset
 * mid-write) is an error, never a half image.
 *
 * encodePng() writes the simplest valid PNG: 8-bit RGB (colour type 2), no
 * interlace, filter type 0 on every scanline, one IDAT holding the whole
 * zlib stream (zlib.deflateSync). The CRC-32 of each chunk is computed by
 * the table-based routine below because zlib.crc32 only exists in Node 22+
 * and the manager supports Node 18.17.
 *
 * Exports: parsePpm(buffer), encodePng(width, height, rgb, opts),
 * ppmToPng(buffer), crc32(buffer).
 */
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIM = 16384;

// Standard CRC-32 (polynomial 0xEDB88320), as PNG requires. Table built once.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isSpace(b) { return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x0b; }

// Reads the next header token starting at `pos`, skipping whitespace and
// '#' comments (which run to end of line). Returns { token, next }.
function readToken(buf, pos) {
  for (;;) {
    while (pos < buf.length && isSpace(buf[pos])) pos++;
    if (pos < buf.length && buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a && buf[pos] !== 0x0d) pos++;
      continue;
    }
    break;
  }
  const start = pos;
  while (pos < buf.length && !isSpace(buf[pos]) && buf[pos] !== 0x23) pos++;
  if (pos === start) throw new Error('PPM: truncated header');
  return { token: buf.toString('latin1', start, pos), next: pos };
}

function parsePpm(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('parsePpm: buffer expected');
  let t = readToken(buffer, 0);
  if (t.token !== 'P6') throw new Error(`PPM: not a binary PPM (magic ${JSON.stringify(t.token)}, expected "P6")`);
  const nums = [];
  for (const name of ['width', 'height', 'maxval']) {
    t = readToken(buffer, t.next);
    if (!/^[0-9]+$/.test(t.token)) throw new Error(`PPM: bad ${name} ${JSON.stringify(t.token)}`);
    nums.push(Number(t.token));
  }
  const [width, height, maxval] = nums;
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) throw new Error(`PPM: unsupported size ${width}x${height}`);
  if (maxval !== 255) throw new Error(`PPM: maxval ${maxval} not supported (only 255, 8-bit samples)`);
  // Exactly one whitespace byte separates the header from the raster.
  let pos = t.next;
  if (pos >= buffer.length || !isSpace(buffer[pos])) throw new Error('PPM: missing whitespace after maxval');
  pos++;
  const expected = width * height * 3;
  const got = buffer.length - pos;
  if (got !== expected) throw new Error(`PPM: body is ${got} bytes, expected ${expected} for ${width}x${height} RGB`);
  return { width, height, maxval, pixels: buffer.subarray(pos, pos + expected) };
}

function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

// A chunk is: length (4, big-endian), type (4 ASCII), data, CRC over type+data.
function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([be32(data.length), typeAndData, be32(crc32(typeAndData))]);
}

function encodePng(width, height, rgb, opts) {
  const level = (opts && opts.level !== undefined) ? opts.level : 6;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`encodePng: bad size ${width}x${height}`);
  if (!Buffer.isBuffer(rgb) || rgb.length !== width * height * 3) throw new Error(`encodePng: expected ${width * height * 3} RGB bytes, got ${rgb ? rgb.length : 'none'}`);
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive (per-scanline filter byte)
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ppmToPng(buffer, opts) {
  const p = parsePpm(buffer);
  return encodePng(p.width, p.height, p.pixels, opts);
}

module.exports = { parsePpm, encodePng, ppmToPng, crc32, SIGNATURE };
