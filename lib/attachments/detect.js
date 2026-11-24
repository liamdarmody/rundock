'use strict';
// What an attached file is, read from its bytes, and whether a message's files
// fit the limits. Pure: nothing here touches the disk, and an image is never
// decoded; its width and height come from its header alone. The bytes and the
// name are the sender's, so a header that lies or loops is refused, never
// trusted or followed.

const { isUtf8 } = require('node:buffer');

const LIMITS = Object.freeze({ imageBytes: 3500000, imagePixels: 8000, pdfBytes: 10000000, textBytes: 1000000, files: 5, messageBytes: 20000000 });

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'mif1']);
const TEXT_SUFFIX = /\.(txt|md|csv)$/i;
// JPEG frame headers: C0 to CF, less C4 (Huffman tables), C8 (reserved) and
// CC (arithmetic coding).
const FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// The bytes from start to end as one character per byte.
const head = (bytes, start, end) => bytes.toString('latin1', start, end);

// A refusal: an Error carrying a code and the figures that go with it.
function refusal(code, fields) {
  return Object.assign(new Error(code), { code }, fields);
}

const nameOf = (name) => (typeof name === 'string' ? name : '');

function pngSize(b) {
  if (b.length < 24 || head(b, 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// Walks the segments from offset 2 to the first frame header. Every step
// moves forward by at least one byte, so the walk ends on any input.
function jpegSize(b) {
  let at = 2;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    if (marker === 0xda || marker === 0xd9 || at + 4 > b.length) return null;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (FRAME_MARKERS.has(marker)) {
      if (at + 9 > b.length) return null;
      return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

function gifSize(b) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webpSize(b) {
  const form = head(b, 12, 16);
  if (form === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (form === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (form === 'VP8X' && b.length >= 30) {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

const IMAGES = [
  { type: 'png', is: (b) => head(b, 0, 8) === '\x89PNG\r\n\x1a\n', size: pngSize },
  { type: 'jpg', is: (b) => head(b, 0, 3) === '\xff\xd8\xff', size: jpegSize },
  { type: 'gif', is: (b) => head(b, 0, 6) === 'GIF87a' || head(b, 0, 6) === 'GIF89a', size: gifSize },
  { type: 'webp', is: (b) => head(b, 0, 4) === 'RIFF' && head(b, 8, 12) === 'WEBP', size: webpSize },
];

// `{ type }`, plus `width` and `height` for an image. Signatures come first
// and win over the name; text is known by its name and a clean UTF-8 body.
function detectFile(bytes, name) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('the bytes of an attached file must be a Buffer');
  const label = nameOf(name);
  const image = IMAGES.find((kind) => kind.is(bytes));
  if (image) {
    const size = image.size(bytes);
    if (!size || !(size.width > 0) || !(size.height > 0)) throw refusal('unsupported', { name: label });
    return { type: image.type, width: size.width, height: size.height };
  }
  if (head(bytes, 0, 5) === '%PDF-') return { type: 'pdf' };
  if (bytes.length >= 12 && head(bytes, 4, 8) === 'ftyp') {
    throw refusal(HEIC_BRANDS.has(head(bytes, 8, 12)) ? 'heic' : 'unsupported', { name: label });
  }
  const suffix = TEXT_SUFFIX.exec(label);
  if (suffix && !bytes.includes(0) && isUtf8(bytes)) return { type: suffix[1].toLowerCase() };
  throw refusal('unsupported', { name: label });
}

module.exports = { LIMITS, detectFile };
