'use strict';
// The window's copy of the server's file detector, held to the server's.
//
// public/attachment-sniff.js reads an attached file's type from its bytes as
// lib/attachments/detect.js does, so a file the page lets through is one the
// server stores and a file the page refuses is one the server would refuse
// with the same code. Each test hands both detectors the same bytes, the page
// a Uint8Array and the server a Buffer, and asserts the same answer, and that
// answer is also pinned, so the two can't agree on something wrong.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const detect = require(path.join(ROOT, 'lib', 'attachments', 'detect.js'));

// The page's module, or null when there is none to load.
function sniff() {
  let mod = null;
  try {
    mod = require(path.join(ROOT, 'public', 'attachment-sniff.js'));
  } catch {
    mod = null;
  }
  assert.ok(mod && typeof mod.detectBytes === 'function' && typeof mod.checkFile === 'function' && mod.LIMITS,
    'public/attachment-sniff.js loads and exports detectBytes, checkFile and LIMITS');
  return mod;
}

// What the server answers: the result, or the refusal's code and name.
function server(bytes, name) {
  try {
    return detect.detectFile(Buffer.from(bytes), name);
  } catch (e) {
    return { code: e.code, name: e.name };
  }
}

function same(bytes, name, expected) {
  const page = sniff().detectBytes(new Uint8Array(bytes), name);
  assert.deepStrictEqual(page, server(bytes, name), 'the page and the server answer the same');
  assert.deepStrictEqual(page, expected);
}

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
const utf8 = (s) => [...Buffer.from(s, 'utf-8')];

describe('images are known by their signatures, with their width and height', () => {
  test('a PNG', () => same(png(640, 480), 'photo.png', { type: 'png', width: 640, height: 480 }));
  test('a JPEG', () => same(jpeg(1024, 768), 'photo.jpg', { type: 'jpg', width: 1024, height: 768 }));
  test('a GIF87a', () => same(gif('GIF87a', 32, 16), 'loop.gif', { type: 'gif', width: 32, height: 16 }));
  test('a GIF89a', () => same(gif('GIF89a', 48, 24), 'loop.gif', { type: 'gif', width: 48, height: 24 }));
  test('a lossy WebP', () => same(webpLossy(300, 200), 'photo.webp', { type: 'webp', width: 300, height: 200 }));
  test('a lossless WebP', () => same(webpLossless(301, 199), 'photo.webp', { type: 'webp', width: 301, height: 199 }));
  test('an extended WebP', () => same(webpExtended(4000, 3000), 'photo.webp', { type: 'webp', width: 4000, height: 3000 }));
});

describe('a PDF and the ftyp box', () => {
  test('%PDF- is a PDF', () => same(ascii('%PDF-1.7\n%\xe2\xe3\n'), 'report.pdf', { type: 'pdf' }));
  for (const brand of ['heic', 'heix', 'hevc', 'mif1']) {
    test(`an ftyp box with ${brand} is a HEIC photo`, () => same(ftyp(brand), 'photo.heic', { code: 'heic', name: 'photo.heic' }));
  }
  test('an ftyp box with qt is unsupported', () => same(ftyp('qt  '), 'clip.mov', { code: 'unsupported', name: 'clip.mov' }));
});

describe('an image cut short inside its header is unsupported', () => {
  test('a PNG', () => same(png(640, 480).slice(0, 20), 'photo.png', { code: 'unsupported', name: 'photo.png' }));
  test('a JPEG', () => same(jpeg(640, 480).slice(0, 26), 'photo.jpg', { code: 'unsupported', name: 'photo.jpg' }));
  test('a GIF', () => same(gif('GIF89a', 32, 16).slice(0, 8), 'loop.gif', { code: 'unsupported', name: 'loop.gif' }));
  test('a WebP', () => same(webpLossy(300, 200).slice(0, 28), 'photo.webp', { code: 'unsupported', name: 'photo.webp' }));
});

describe('text is known by its name and a clean UTF-8 body', () => {
  test('a .txt of UTF-8', () => same(utf8('a line, café\n'), 'notes.txt', { type: 'txt' }));
  test('a .md of UTF-8', () => same(utf8('# Notes\n\n- one\n'), 'notes.md', { type: 'md' }));
  test('a .csv of UTF-8', () => same(utf8('name,count\nalpha,1\n'), 'table.csv', { type: 'csv' }));
  test('notes.TXT, the suffix read with case ignored', () => same(utf8('a line\n'), 'notes.TXT', { type: 'txt' }));
  test('a UTF-8 byte order mark', () => same([0xef, 0xbb, 0xbf, ...utf8('a line\n')], 'notes.txt', { type: 'txt' }));
  test('a lone 0xff', () => same([...utf8('a '), 0xff, ...utf8(' line')], 'notes.txt', { code: 'unsupported', name: 'notes.txt' }));
  test('an overlong 0xc0 0xaf', () => same([...utf8('a '), 0xc0, 0xaf], 'notes.txt', { code: 'unsupported', name: 'notes.txt' }));
  test('a surrogate 0xed 0xa0 0x80', () => same([...utf8('a '), 0xed, 0xa0, 0x80], 'notes.md', { code: 'unsupported', name: 'notes.md' }));
  test('a NUL', () => same([...utf8('a'), 0, ...utf8('b')], 'notes.csv', { code: 'unsupported', name: 'notes.csv' }));
  test('an empty .txt', () => same([], 'empty.txt', { type: 'txt' }));
  test('a name with no suffix', () => same(utf8('a line\n'), 'README', { code: 'unsupported', name: 'README' }));
});

describe('the limits are the server\'s', () => {
  test('LIMITS is deep-equal to the server\'s', () => {
    assert.deepStrictEqual({ ...sniff().LIMITS }, { ...detect.LIMITS });
  });

  test('checkFile refuses a PDF and a text file over their own limits as checkFiles does', () => {
    const { checkFile } = sniff();
    const pdf = new Uint8Array(10000001);
    pdf.set(ascii('%PDF-'));
    const text = new Uint8Array(1000001).fill(0x61);
    for (const [bytes, name] of [[pdf, 'big.pdf'], [text, 'big.md']]) {
      let theirs = null;
      try { detect.checkFiles([{ name, bytes: Buffer.from(bytes) }]); } catch (e) { theirs = { code: e.code, name: e.name, bytes: e.bytes, limit: e.limit }; }
      assert.deepStrictEqual(checkFile(bytes, name), theirs);
    }
    assert.deepStrictEqual(checkFile(pdf.subarray(0, 10000000), 'fits.pdf'), { type: 'pdf' });
  });
});
