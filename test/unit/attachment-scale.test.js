'use strict';
// An attached image fitted to what the server takes, in the window
// (public/attachment-scale.js): which images are animated, read from their
// bytes, and how an image too large is scaled, re-encoded or refused.
//
// Pixels are never touched here. The module's codec, which decodes and
// encodes through a canvas, is reached only in the browser; each test hands
// prepareImage a stand-in codec that answers from numbers the test gives and
// records every call, so a test can say what was encoded, and in what order.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ascii, gifOf, pngOf, acTL, IDAT, webpOf, vp8x } = require('../helpers/attachment-bytes.js');

const ROOT = path.join(__dirname, '..', '..');

// The page's module, asserted to load and export what these tests use.
function scale() {
  let mod = null;
  try {
    mod = require(path.join(ROOT, 'public', 'attachment-scale.js'));
  } catch {
    mod = null;
  }
  assert.ok(mod && typeof mod.animated === 'function' && typeof mod.prepareImage === 'function'
    && mod.codec && typeof mod.codec.decode === 'function' && typeof mod.codec.encode === 'function',
  'public/attachment-scale.js loads and exports animated, prepareImage and codec');
  return mod;
}

const PNG = 'image/png';
const JPEG = 'image/jpeg';

// A file of `size` bytes, as the composer holds it, and the kind its header
// gave: its type, width and height.
const image = (name, size, type, width, height) => ({ file: new File([new Uint8Array(size)], name), kind: { type, width, height } });

// A stand-in codec. Decoding answers `width` by `height`, `opaque` or not, or
// rejects when `rejects` is set; an encode of width by height as `type` at
// `quality` answers a Blob of the size `sizes` gives it: a JPEG by its
// quality, a PNG by its longest edge. Every call is recorded in order.
function codec({ width, height, opaque = true, rejects = false, sizes = {} }) {
  const calls = [];
  const source = { decoded: `${width} by ${height}` };
  return {
    calls,
    source,
    decode(file) {
      calls.push(['decode', file]);
      return rejects ? Promise.reject(new Error('not an image')) : Promise.resolve({ source, width, height, opaque });
    },
    encode(from, w, h, type, quality) {
      calls.push(['encode', from, w, h, type, quality]);
      const size = type === JPEG ? sizes[quality] : sizes[Math.max(w, h)];
      assert.ok(Number.isInteger(size), `the test gives a size for ${type} at ${w} by ${h}, quality ${quality}`);
      return Promise.resolve(new Blob([new Uint8Array(size)], { type }));
    },
  };
}
// Each encode as [width, height, type, quality].
const encodes = (c) => c.calls.filter(([what]) => what === 'encode').map(([, , ...rest]) => rest);
const qualities = (c) => encodes(c).filter(([, , type]) => type === JPEG).map(([, , , quality]) => quality);

async function prepared({ name = 'shot.png', size, type = 'png', header, decodes = header, opaque, rejects, sizes }) {
  const { file, kind } = image(name, size, type, header[0], header[1]);
  const c = codec({ width: decodes[0], height: decodes[1], opaque, rejects, sizes });
  const answer = await scale().prepareImage(file, kind, c);
  return { file, c, answer };
}

const animated = (bytes, type) => scale().animated(Uint8Array.from(bytes), type);

// Every prefix of `bytes` shorter than `until` reads as still, and the one
// `until` long as animated: a header cut short is never taken as animated.
function cutShort(bytes, type, until) {
  const read = [];
  for (let end = 0; end <= until; end++) read.push(animated(bytes.slice(0, end), type));
  assert.deepStrictEqual(read, [...Array(until).fill(false), true]);
}

describe('an animated image is known by its bytes', () => {
  // A frame whose image data is three bytes of 0x2c, the byte that starts an
  // image descriptor.
  const COMMA_DATA = [0x02, 0x03, 0x2c, 0x2c, 0x2c, 0x00];
  const ANMF = ['ANMF', Array(16).fill(0)];

  test('a two-frame GIF is animated', () => {
    assert.strictEqual(animated(gifOf(2), 'gif'), true);
  });

  test('a one-frame GIF is not', () => {
    assert.strictEqual(animated(gifOf(1), 'gif'), false);
  });

  test('a one-frame GIF whose image data holds 0x2c is not', () => {
    const bytes = gifOf(1, { data: COMMA_DATA });
    assert.ok(bytes.filter((b) => b === 0x2c).length > 1, 'the bytes hold 0x2c beyond the image descriptor');
    assert.strictEqual(animated(bytes, 'gif'), false);
  });

  test('a WebP with the animation bit set in VP8X is animated', () => {
    assert.strictEqual(animated(webpOf([vp8x(0x02, 1, 1)]), 'webp'), true);
  });

  test('a WebP with an ANMF chunk and the animation bit clear is animated', () => {
    assert.strictEqual(animated(webpOf([vp8x(0, 1, 1), ANMF]), 'webp'), true);
  });

  test('a still VP8X WebP is not', () => {
    assert.strictEqual(animated(webpOf([vp8x(0x10, 1, 1), ['ALPH', [0, 0]], ['VP8 ', Array(10).fill(0)]]), 'webp'), false);
  });

  test('a PNG with an acTL of 2 frames before its IDAT is animated', () => {
    assert.strictEqual(animated(pngOf(1, 1, [acTL(2), IDAT]), 'png'), true);
  });

  test('a PNG with an acTL of 1 frame is not', () => {
    assert.strictEqual(animated(pngOf(1, 1, [acTL(1), IDAT]), 'png'), false);
  });

  test('a PNG with an acTL after its IDAT is not', () => {
    assert.strictEqual(animated(pngOf(1, 1, [IDAT, acTL(2)]), 'png'), false);
  });

  test('a PNG with no acTL is not', () => {
    assert.strictEqual(animated(pngOf(1, 1, [IDAT]), 'png'), false);
  });

  test('a JPEG is not', () => {
    assert.strictEqual(animated([0xff, 0xd8, 0xff, ...ascii('GIF89a'), 0x2c, 0x2c], 'jpg'), false);
  });

  // Each animated image above, cut anywhere before what makes it animated
  // ends: the second image descriptor, the VP8X chunk, the ANMF chunk and the
  // acTL chunk.
  test('a two-frame GIF cut short is not', () => {
    const bytes = gifOf(2);
    cutShort(bytes, 'gif', bytes.length - 1 - 5);
  });

  test('a WebP with the animation bit, cut short, is not', () => {
    cutShort(webpOf([vp8x(0x02, 1, 1)]), 'webp', 30);
  });

  test('a WebP with an ANMF chunk, cut short, is not', () => {
    cutShort(webpOf([vp8x(0, 1, 1), ANMF]), 'webp', 30 + 8 + 16);
  });

  test('a PNG with an acTL of 2 frames, cut short, is not', () => {
    cutShort(pngOf(1, 1, [acTL(2), IDAT]), 'png', 8 + 25 + 20);
  });
});

describe('an image over 2,576 px is scaled to 2,576 px', () => {
  test('a 4,000 by 3,000 PNG is encoded as PNG at 2,576 by 1,932', async () => {
    const { c, answer } = await prepared({ size: 3000000, header: [4000, 3000], sizes: { 2576: 2000000 } });
    assert.deepStrictEqual(encodes(c), [[2576, 1932, PNG, undefined]]);
    assert.strictEqual(c.calls[1][1], c.source, 'the decoded image is what is encoded');
    assert.deepStrictEqual([answer.scaledTo, answer.refusal, answer.file.size, answer.file.type], [2576, null, 2000000, PNG]);
  });

  test('a 3,000 by 4,000 JPEG is encoded at 1,932 by 2,576', async () => {
    const { c, answer } = await prepared({ name: 'photo.jpg', type: 'jpg', size: 3000000, header: [3000, 4000], sizes: { 2576: 2000000 } });
    assert.deepStrictEqual(encodes(c), [[1932, 2576, PNG, undefined]]);
    assert.strictEqual(answer.scaledTo, 2576);
  });

  test('a 2,577 px image is scaled', async () => {
    const { c, answer } = await prepared({ size: 1000, header: [2577, 1000], sizes: { 2576: 1000 } });
    assert.deepStrictEqual(encodes(c), [[2576, 1000, PNG, undefined]]);
    assert.strictEqual(answer.scaledTo, 2576);
  });

  test('a header giving 2,000 px over an image of 3,600,000 bytes that decodes at 3,000 px is scaled to 2,576 from the decoded edge', async () => {
    const { c, answer } = await prepared({ size: 3600000, header: [2000, 1500], decodes: [3000, 2250], sizes: { 2576: 3000000 } });
    assert.deepStrictEqual(encodes(c), [[2576, 1932, PNG, undefined]]);
    assert.deepStrictEqual([answer.scaledTo, answer.file.size], [2576, 3000000]);
  });

  test('a scaled image keeps the name it came with', async () => {
    const { answer } = await prepared({ name: 'Screenshot 2026-11-24 at 09.12.40.png', size: 3000000, header: [4000, 3000], sizes: { 2576: 2000000 } });
    assert.strictEqual(answer.file.name, 'Screenshot 2026-11-24 at 09.12.40.png');
  });
});

describe('an opaque image still over 3,500,000 bytes is encoded as JPEG in steps', () => {
  const OVER = 3600000;

  test('a 2,000 px opaque PNG of 3,600,000 bytes is answered as JPEG at 0.9', async () => {
    const { c, answer } = await prepared({ size: OVER, header: [2000, 1000], sizes: { 0.9: 2900000 } });
    assert.deepStrictEqual(encodes(c), [[2000, 1000, JPEG, 0.9]], 'at the same width and height');
    assert.deepStrictEqual([answer.file.type, answer.file.size, answer.scaledTo, answer.refusal], [JPEG, 2900000, null, null]);
  });

  test('it is answered at 0.8 when 0.9 is over', async () => {
    const { c, answer } = await prepared({ size: OVER, header: [2000, 1000], sizes: { 0.9: 3500001, 0.8: 3500000 } });
    assert.deepStrictEqual(qualities(c), [0.9, 0.8]);
    assert.strictEqual(answer.file.size, 3500000);
  });

  test('it is answered at 0.6 when 0.7 is over', async () => {
    const { c, answer } = await prepared({ size: OVER, header: [2000, 1000], sizes: { 0.9: 5000000, 0.8: 4500000, 0.7: 4000000, 0.6: 3000000 } });
    assert.deepStrictEqual(qualities(c), [0.9, 0.8, 0.7, 0.6]);
    assert.deepStrictEqual([answer.file.size, answer.refusal], [3000000, null]);
  });

  test('the qualities are tried in that order and no further once one fits', async () => {
    const { c } = await prepared({ size: OVER, header: [2000, 1000], sizes: { 0.9: 5000000, 0.8: 4000000, 0.7: 3000000, 0.6: 2000000 } });
    assert.deepStrictEqual(qualities(c), [0.9, 0.8, 0.7]);
    assert.deepStrictEqual(encodes(c).map(([w, h]) => [w, h]), [[2000, 1000], [2000, 1000], [2000, 1000]]);
  });

  test('an opaque image scaled to 2,576 px whose PNG is over is answered as JPEG', async () => {
    const { c, answer } = await prepared({ size: 9000000, header: [4000, 3000], sizes: { 2576: 6000000, 0.9: 2500000 } });
    assert.deepStrictEqual(encodes(c), [[2576, 1932, PNG, undefined], [2576, 1932, JPEG, 0.9]]);
    assert.deepStrictEqual([answer.file.type, answer.file.size, answer.scaledTo], [JPEG, 2500000, 2576]);
  });

  test('an image re-encoded without scaling keeps the name it came with', async () => {
    const { answer } = await prepared({ name: 'Screenshot 2026-11-24 at 09.12.40.png', size: OVER, header: [2000, 1000], sizes: { 0.9: 2900000 } });
    assert.deepStrictEqual([answer.file.name, answer.file.type], ['Screenshot 2026-11-24 at 09.12.40.png', JPEG]);
  });
});

describe('an image with see-through pixels stays PNG and steps down in size', () => {
  const steps = [
    ['a 4,000 px image with see-through pixels, over at 2,576 px, is answered at 2,048',
      { size: 9000000, header: [4000, 3000], sizes: { 2576: 5000000, 2048: 3400000 } }, [[2576, 1932], [2048, 1536]], 2048],
    ['over at 2,048, it is answered at 1,568',
      { size: 9000000, header: [4000, 3000], sizes: { 2576: 5000000, 2048: 3600000, 1568: 2100000 } }, [[2576, 1932], [2048, 1536], [1568, 1176]], 1568],
    ['a 2,000 px image over 3,500,000 bytes skips 2,048 and is answered at 1,568',
      { size: 3600000, header: [2000, 1000], sizes: { 1568: 2200000 } }, [[1568, 784]], 1568],
  ];
  for (const [name, given, edges, scaledTo] of steps) {
    test(name, async () => {
      const { c, answer } = await prepared({ ...given, opaque: false });
      assert.deepStrictEqual(encodes(c), edges.map(([w, h]) => [w, h, PNG, undefined]));
      assert.deepStrictEqual([answer.scaledTo, answer.file.type, answer.refusal], [scaledTo, PNG, null]);
      assert.strictEqual(answer.file.size, given.sizes[scaledTo]);
    });
  }

  test('no JPEG is encoded for any of them', async () => {
    const types = [];
    for (const [, given] of steps) {
      const { c } = await prepared({ ...given, opaque: false });
      types.push(...encodes(c).map(([, , type]) => type));
    }
    assert.ok(types.length >= 6, 'each was encoded');
    assert.deepStrictEqual([...new Set(types)], [PNG]);
  });
});

describe('an image still over after its steps is refused, and one that can\'t be decoded is refused', () => {
  test('an opaque image over at 0.6 is refused with 0.6\'s size', async () => {
    const { answer } = await prepared({ name: 'big.png', size: 3600000, header: [2000, 1000], sizes: { 0.9: 5000000, 0.8: 4600000, 0.7: 4300000, 0.6: 4100000 } });
    assert.deepStrictEqual(answer.refusal, { code: 'image-bytes', name: 'big.png', bytes: 4100000, limit: 3500000 });
  });

  test('an image with see-through pixels over at 1,568 is refused with that size', async () => {
    const { c, answer } = await prepared({ name: 'big.png', size: 9000000, header: [4000, 3000], opaque: false, sizes: { 2576: 6000000, 2048: 4800000, 1568: 3700000 } });
    assert.strictEqual(encodes(c).length, 3);
    assert.deepStrictEqual(answer.refusal, { code: 'image-bytes', name: 'big.png', bytes: 3700000, limit: 3500000 });
  });

  test('a 1,500 px image with see-through pixels of 3,600,000 bytes is refused with 3,600,000 and no PNG encoded', async () => {
    const { c, answer } = await prepared({ name: 'big.png', size: 3600000, header: [1500, 1000], opaque: false });
    assert.deepStrictEqual(encodes(c), []);
    assert.deepStrictEqual(answer.refusal, { code: 'image-bytes', name: 'big.png', bytes: 3600000, limit: 3500000 });
  });

  test('a decode that rejects is refused as unsupported', async () => {
    const { c, answer } = await prepared({ name: 'broken.png', size: 3600000, header: [4000, 3000], rejects: true });
    assert.deepStrictEqual(answer.refusal, { code: 'unsupported', name: 'broken.png' });
    assert.deepStrictEqual(encodes(c), []);
  });

  test('an encode that rejects is refused as unsupported', async () => {
    const { file, kind } = image('broken.png', 3600000, 'png', 4000, 3000);
    const c = codec({ width: 4000, height: 3000 });
    c.encode = () => Promise.reject(new Error('the canvas could not encode'));
    const answer = await scale().prepareImage(file, kind, c);
    assert.deepStrictEqual(answer.refusal, { code: 'unsupported', name: 'broken.png' });
  });
});

describe('an image at or under both limits is stored as it came', () => {
  const asCame = async (given) => {
    const { file, c, answer } = await prepared(given);
    assert.strictEqual(answer.file, file, 'the same File');
    assert.deepStrictEqual([answer.scaledTo, answer.refusal], [null, null]);
    return c;
  };

  test('a 2,576 px PNG of 3,500,000 bytes is answered as the same File with the codec never called', async () => {
    assert.deepStrictEqual((await asCame({ size: 3500000, header: [2576, 2576] })).calls, []);
  });

  test('a 1,000 px JPEG is answered the same way', async () => {
    assert.deepStrictEqual((await asCame({ name: 'photo.jpg', type: 'jpg', size: 900000, header: [1000, 750] })).calls, []);
  });

  test('a GIF is answered the same way', async () => {
    assert.deepStrictEqual((await asCame({ name: 'clip.gif', type: 'gif', size: 2000000, header: [800, 600] })).calls, []);
  });

  test('a header giving 3,000 px over an image of 1,000,000 bytes that decodes at 2,000 px is answered as the same File with encode never called', async () => {
    const c = await asCame({ size: 1000000, header: [3000, 2000], decodes: [2000, 1333] });
    assert.deepStrictEqual(c.calls.map(([what]) => what), ['decode']);
  });
});
