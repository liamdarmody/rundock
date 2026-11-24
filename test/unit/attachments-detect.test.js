'use strict';
// What an attached file is, read from its bytes, and whether a message's files
// are within the limits. The headers are built here byte by byte: the page
// sends the bytes, so a header that lies (a size of 0, a cut-off header, a
// JPEG segment that loops) must be refused, never trusted or waited on.

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Loaded so that a missing module fails each test on its first assertion,
// never on the require.
const detect = (() => {
  try { return require('../../lib/attachments/detect.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]detect/.test(String(e.message))) return null;
    throw e;
  }
})();
const detectFile = (...args) => detect.detectFile(...args);
const ready = (name) => assert.strictEqual(typeof (detect && detect[name]), 'function');

// An assert.throws check for a refusal: an Error with this code and fields.
function refused(code, fields = {}) {
  return (e) => {
    assert.ok(e instanceof Error, 'a refusal is an Error');
    assert.strictEqual(e.code, code);
    for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(e[key], value, key);
    return true;
  };
}

function pngBytes(width, height, size = 33) {
  const b = Buffer.alloc(Math.max(size, 24));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// A JPEG with an APP0 segment, a restart marker and fill bytes before the
// frame header, so the walk has to step over each.
function jpegBytes(width, height, sof = 0xc0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = sof;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xd0, 0xff, 0xff]), frame, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

function gifBytes(width, height, signature = 'GIF89a') {
  const b = Buffer.alloc(13);
  b.write(signature, 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function riff(tag, size) {
  const b = Buffer.alloc(size);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(size - 8, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(tag, 12, 'latin1');
  b.writeUInt32LE(size - 20, 16);
  return b;
}

function webpLossy(width, height) {
  const b = riff('VP8 ', 40);
  b[20] = 0x10; b[21] = 0x02; b[22] = 0x00;
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpLossless(width, height) {
  const b = riff('VP8L', 32);
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  return b;
}

function webpExtended(width, height) {
  const b = riff('VP8X', 32);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function ftyp(brand) {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  b.write('mif1miaf', 16, 'latin1');
  return b;
}

const pdfBytes = (size = 64) => { const b = Buffer.alloc(size, 0x20); b.write('%PDF-1.7\n', 0, 'latin1'); return b; };

describe('detectFile: types from the bytes', () => {
  test('a PNG gives its width and height from IHDR', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(pngBytes(640, 480), 'shot.png'), { type: 'png', width: 640, height: 480 });
  });

  test('a JPEG gives its width and height from the first frame header', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(jpegBytes(1024, 768), 'photo.jpg'), { type: 'jpg', width: 1024, height: 768 });
    assert.deepStrictEqual(detectFile(jpegBytes(300, 200, 0xc2), 'progressive.jpeg'), { type: 'jpg', width: 300, height: 200 });
  });

  test('a GIF89a gives its width and height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(gifBytes(320, 240), 'anim.gif'), { type: 'gif', width: 320, height: 240 });
  });

  test('a GIF87a gives its width and height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(gifBytes(16, 9, 'GIF87a'), 'old.gif'), { type: 'gif', width: 16, height: 9 });
  });

  test('a lossy WebP (VP8) gives its width and height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(webpLossy(800, 600), 'a.webp'), { type: 'webp', width: 800, height: 600 });
  });

  test('a lossless WebP (VP8L) gives its width and height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(webpLossless(1920, 1080), 'a.webp'), { type: 'webp', width: 1920, height: 1080 });
  });

  test('an extended WebP (VP8X) gives its width and height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(webpExtended(4000, 3000), 'a.webp'), { type: 'webp', width: 4000, height: 3000 });
  });

  test('a PDF is pdf, with no width or height', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(pdfBytes(), 'Incident-Report.pdf'), { type: 'pdf' });
  });

  test('a HEIC photo, by any of its four major brands, is refused heic with its name', () => {
    ready('detectFile');
    for (const brand of ['heic', 'heix', 'hevc', 'mif1']) {
      assert.throws(() => detectFile(ftyp(brand), 'IMG_0001.HEIC'), refused('heic', { name: 'IMG_0001.HEIC' }), brand);
    }
  });

  test('an ftyp with another major brand, such as avif, is unsupported', () => {
    ready('detectFile');
    assert.throws(() => detectFile(ftyp('avif'), 'a.avif'), refused('unsupported', { name: 'a.avif' }));
  });

  test('text named .txt, .md or .csv in any case is that suffix, lowercased', () => {
    ready('detectFile');
    const body = Buffer.from('café, naïve, \u{1F600}\nsecond line\n');
    assert.deepStrictEqual(detectFile(body, 'notes.txt'), { type: 'txt' });
    assert.deepStrictEqual(detectFile(body, 'README.MD'), { type: 'md' });
    assert.deepStrictEqual(detectFile(body, 'table.Csv'), { type: 'csv' });
    assert.deepStrictEqual(detectFile(Buffer.alloc(0), 'empty.txt'), { type: 'txt' });
  });

  test('the signature wins over the name: a PNG named notes.txt is png', () => {
    ready('detectFile');
    assert.deepStrictEqual(detectFile(pngBytes(2, 3), 'notes.txt'), { type: 'png', width: 2, height: 3 });
  });

  test('UTF-8 text named a.png is unsupported', () => {
    ready('detectFile');
    assert.throws(() => detectFile(Buffer.from('just some words'), 'a.png'), refused('unsupported', { name: 'a.png' }));
  });

  test('a .txt holding a NUL byte is unsupported', () => {
    ready('detectFile');
    assert.throws(() => detectFile(Buffer.from('before\0after'), 'notes.txt'), refused('unsupported', { name: 'notes.txt' }));
  });

  test('a .csv that is not valid UTF-8 is unsupported', () => {
    ready('detectFile');
    assert.throws(() => detectFile(Buffer.from([0x61, 0x2c, 0xe9, 0x2c, 0x62, 0x0a]), 'table.csv'), refused('unsupported', { name: 'table.csv' }));
  });

  test('a file with no known signature and no text suffix is unsupported, a name that is not text read as empty', () => {
    ready('detectFile');
    assert.throws(() => detectFile(Buffer.from('PK\x03\x04zip'), 'archive.zip'), refused('unsupported', { name: 'archive.zip' }));
    assert.throws(() => detectFile(Buffer.from('words'), ['notes.txt']), refused('unsupported', { name: '' }));
  });

  test('an image whose header gives a width or height of 0 is unsupported', () => {
    ready('detectFile');
    const zero = [
      ['png width', pngBytes(0, 10)], ['png height', pngBytes(10, 0)],
      ['jpeg width', jpegBytes(0, 10)], ['jpeg height', jpegBytes(10, 0)],
      ['gif width', gifBytes(0, 10)], ['gif height', gifBytes(10, 0)],
      ['webp width', webpLossy(0, 10)], ['webp height', webpLossy(10, 0)],
    ];
    for (const [label, bytes] of zero) assert.throws(() => detectFile(bytes, 'zero.png'), refused('unsupported'), label);
  });

  test('a truncated header is unsupported', () => {
    ready('detectFile');
    const cut = [
      ['png', pngBytes(640, 480).subarray(0, 20)],
      ['png without IHDR', Buffer.concat([pngBytes(640, 480).subarray(0, 12), Buffer.from('JUNKJUNKJUNKJUNK')])],
      ['jpeg frame', jpegBytes(640, 480).subarray(0, 30)],
      ['gif', gifBytes(640, 480).subarray(0, 8)],
      ['webp lossy', webpLossy(640, 480).subarray(0, 27)],
      ['webp lossy start code', Buffer.concat([webpLossy(640, 480).subarray(0, 23), Buffer.alloc(17)])],
      ['webp lossless', webpLossless(640, 480).subarray(0, 22)],
      ['webp extended', webpExtended(640, 480).subarray(0, 28)],
      ['webp unknown chunk', riff('ABCD', 40)],
    ];
    for (const [label, bytes] of cut) assert.throws(() => detectFile(bytes, 'cut.png'), refused('unsupported'), label);
  });

  test('a JPEG with no frame header is unsupported', () => {
    ready('detectFile');
    const scanFirst = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00, 0xff, 0xd9]);
    const endsEarly = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00]);
    assert.throws(() => detectFile(scanFirst, 'a.jpg'), refused('unsupported', { name: 'a.jpg' }));
    assert.throws(() => detectFile(endsEarly, 'a.jpg'), refused('unsupported'));
  });

  test('a JPEG segment length under 2 is unsupported', () => {
    ready('detectFile');
    for (const length of [0, 1]) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, length]), jpegBytes(10, 10).subarray(2)]);
      assert.throws(() => detectFile(bytes, 'a.jpg'), refused('unsupported'), `length ${length}`);
    }
  });

  test('the JPEG walk ends on every input', () => {
    ready('detectFile');
    const inputs = [
      Buffer.alloc(4096, 0xff),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4096, 0xff)]),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4000).fill(Buffer.from([0xff, 0xd0]))]),
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    ];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
    for (let n = 0; n < 2000; n++) {
      const body = Buffer.alloc(3 + (n % 200));
      for (let i = 0; i < body.length; i++) body[i] = next() < 96 ? 0xff : next();
      inputs.push(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), body]));
    }
    for (const bytes of inputs) {
      try {
        const found = detectFile(bytes, 'a.jpg');
        assert.strictEqual(found.type, 'jpg');
        assert.ok(found.width > 0 && found.height > 0);
      } catch (e) {
        assert.strictEqual(e.code, 'unsupported');
      }
    }
  });

  test('bytes that are not a Buffer are a TypeError', () => {
    ready('detectFile');
    assert.throws(() => detectFile('%PDF-1.7', 'a.pdf'), TypeError);
    assert.throws(() => detectFile(undefined, 'a.txt'), TypeError);
  });
});

describe('LIMITS', () => {
  test('are the per-file and per-message limits', () => {
    assert.strictEqual(typeof (detect && detect.LIMITS && detect.LIMITS.files), 'number');
    assert.deepStrictEqual({ ...detect.LIMITS }, { imageBytes: 3500000, imagePixels: 8000, pdfBytes: 10000000, textBytes: 1000000, files: 5, messageBytes: 20000000 });
  });
});
