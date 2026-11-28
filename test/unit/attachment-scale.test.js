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
  assert.ok(mod && typeof mod.animated === 'function',
    'public/attachment-scale.js loads and exports animated');
  return mod;
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
