'use strict';
// The bytes of attached files for the tests: just enough of each kind's
// header for the page's detector and the server's to read it as that kind.
//
// typed(name, size) gives bytes the composer accepts for that name: an image
// or PDF header by the name's extension, with case ignored, padded to size;
// text of 'a' for .txt, .md and .csv; zeros for any other name. Given a
// Uint8Array instead of a size, it writes the header over that array's start
// and hands the same array back, so a test that asserts the exact bytes sent
// still holds them.

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const be16 = (n) => [n >> 8, n & 255];
const be32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, n >> 8];
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];

const png = (w, h) => [0x89, ...ascii('PNG\r\n\x1a\n'), ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0];
const jpeg = (w, h) => [0xff, 0xd8,
  0xff, 0xe0, ...be16(16), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const gif = (version, w, h) => [...ascii(version), ...le16(w), ...le16(h), 0, 0, 0];
const riff = (form, body) => [...ascii('RIFF'), ...le32(4 + 8 + body.length), ...ascii('WEBP'), ...ascii(form), ...le32(body.length), ...body];
const webpLossy = (w, h) => riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const webpLossless = (w, h) => riff('VP8L', [0x2f, ...le32((w - 1) | ((h - 1) << 14)), 0, 0]);
const webpExtended = (w, h) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]);
const ftyp = (brand) => [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0];
const pdf = () => ascii('%PDF-1.7\n');
const utf8 = (s) => [...Buffer.from(s, 'utf-8')];

const HEADERS = new Map([
  ['png', () => png(2, 2)], ['jpg', () => jpeg(2, 2)], ['jpeg', () => jpeg(2, 2)],
  ['gif', () => gif('GIF89a', 2, 2)], ['webp', () => webpLossy(2, 2)], ['pdf', pdf],
]);
const TEXT = new Set(['txt', 'md', 'csv']);

function suffixOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function typed(name, sizeOrBytes) {
  const suffix = suffixOf(name);
  const header = HEADERS.has(suffix) ? HEADERS.get(suffix)() : [];
  if (sizeOrBytes instanceof Uint8Array || Object.prototype.toString.call(sizeOrBytes) === '[object Uint8Array]') {
    if (sizeOrBytes.length >= header.length) {
      sizeOrBytes.set(header);
      return sizeOrBytes;
    }
    const grown = new Uint8Array(header.length);
    grown.set(header);
    return grown;
  }
  const bytes = new Uint8Array(Math.max(sizeOrBytes, header.length));
  if (TEXT.has(suffix)) bytes.fill(0x61);
  bytes.set(header);
  return bytes;
}

module.exports = {
  ascii, be16, be32, le16, le24, le32,
  png, jpeg, gif, riff, webpLossy, webpLossless, webpExtended, ftyp, pdf, utf8,
  typed,
};
