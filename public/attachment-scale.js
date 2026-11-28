'use strict';
// AN ATTACHED IMAGE FITTED TO WHAT THE SERVER TAKES, IN THE WINDOW. The
// composer reads each image through this module as it is added. Same UMD
// pattern as attachment-wording.js.
//
// AN ANIMATED IMAGE IS SEEN AS ITS FIRST FRAME. `animated` says whether an
// image holds more than one frame, read from its own bytes by walking its
// blocks or chunks from the header, so a byte inside image data is never
// taken for a frame. Bytes cut short are read as still.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAttachmentScale = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const u32BE = (b, at) => b[at] * 0x1000000 + b[at + 1] * 0x10000 + b[at + 2] * 0x100 + b[at + 3];
  const u32LE = (b, at) => b[at] + b[at + 1] * 0x100 + b[at + 2] * 0x10000 + b[at + 3] * 0x1000000;
  const tag = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  // Known by its tag, so bytes made in another window still count.
  const isBytes = (b) => Object.prototype.toString.call(b) === '[object Uint8Array]';

  // A GIF color table's length, from the packed byte that flags it.
  const colorTable = (packed) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);

  // Where a run of GIF sub-blocks from `at` ends, past the empty one that
  // closes it. Every step moves forward, so the walk ends on any input.
  function pastSubBlocks(b, at) {
    let i = at;
    while (i < b.length && b[i] !== 0) i += b[i] + 1;
    return i + 1;
  }

  // A GIF's blocks from its screen descriptor: an image descriptor counts once
  // its ten bytes are there, and its image data is stepped over whole.
  function gifAnimated(b) {
    if (b.length < 13) return false;
    let at = 13 + colorTable(b[10]);
    let images = 0;
    while (at < b.length) {
      if (b[at] === 0x2c) {
        if (at + 10 > b.length) return false;
        images += 1;
        if (images > 1) return true;
        at = pastSubBlocks(b, at + 10 + colorTable(b[at + 9]) + 1);
      } else if (b[at] === 0x21) {
        at = pastSubBlocks(b, at + 2);
      } else {
        return false;
      }
    }
    return false;
  }

  // A PNG's chunks up to its first IDAT, for a whole acTL counting more than
  // one frame.
  function pngAnimated(b) {
    let at = 8;
    while (at + 8 <= b.length) {
      const type = tag(b, at + 4);
      if (type === 'IDAT') return false;
      const end = at + 12 + u32BE(b, at);
      if (end > b.length) return false;
      if (type === 'acTL') return end - at >= 20 && u32BE(b, at + 8) > 1;
      at = end;
    }
    return false;
  }

  // A WebP's chunks, for the animation flag of a whole VP8X, or an ANIM or
  // ANMF chunk, which only an animation holds.
  function webpAnimated(b) {
    let at = 12;
    while (at + 8 <= b.length) {
      const type = tag(b, at);
      const size = u32LE(b, at + 4);
      if (at + 8 + size > b.length) return false;
      if (type === 'VP8X' && size > 0 && (b[at + 8] & 0x02)) return true;
      if (type === 'ANIM' || type === 'ANMF') return true;
      at += 8 + size + (size % 2);
    }
    return false;
  }

  const WALKS = new Map([['gif', gifAnimated], ['png', pngAnimated], ['webp', webpAnimated]]);

  // `type` is what detectBytes found for the same bytes.
  function animated(bytes, type) {
    const walk = WALKS.get(type);
    return !!walk && isBytes(bytes) && walk(bytes);
  }

  return { animated };
}));
