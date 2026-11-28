'use strict';
// AN ATTACHED IMAGE FITTED TO WHAT THE SERVER TAKES, IN THE WINDOW. The
// composer reads each image through this module as it is added. Same UMD
// pattern as attachment-wording.js.
//
// THE MODEL READS AN IMAGE AT 2,576 PX ON ITS LONGEST EDGE, and the server
// refuses one over LIMITS.imageBytes (lib/attachments/detect.js), so
// `prepareImage` scales a larger image down to that edge, as PNG, which keeps
// every pixel. One still over the byte limit is stepped down: an opaque one as
// JPEG at falling quality, one with see-through pixels as PNG at smaller
// edges, since JPEG keeps no alpha. What still can't fit is refused in the
// server's words. An image at or under both limits is sent as it came, never
// decoded. The server checks every image again before it stores one, so this
// spares a refusal and the server's check stays the guard.
//
// `codec` is the one place pixels are touched: it decodes and encodes through
// a canvas, and is reached only in the browser. Everything else here reads
// numbers, so tests replace `codec` with a stand-in.
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

  // ===== SCALING =====

  const sniff = typeof RundockAttachmentSniff !== 'undefined' ? RundockAttachmentSniff : require('./attachment-sniff.js');
  const LIMIT = sniff.LIMITS.imageBytes;
  const EDGE = 2576;
  const QUALITIES = [0.9, 0.8, 0.7, 0.6];
  const EDGES = [2048, 1568];
  const PNG = 'image/png';
  const JPEG = 'image/jpeg';

  const asCame = (file) => ({ file, scaledTo: null, refusal: null });

  // Width and height with the longest edge at `edge` and the other in
  // proportion, rounded to the nearest pixel.
  function sized(width, height, edge) {
    const longest = Math.max(width, height);
    const side = (n) => (n === longest ? edge : Math.max(1, Math.round((n * edge) / longest)));
    return [side(width), side(height)];
  }

  // The decoded image's steps, each encoded from the decoded pixels. `edge` is
  // the longest edge reached and `tried` the size of each step, so a refusal
  // gives the last; with no step tried, the size the image came at.
  async function steps(file, { source, width, height, opaque }, codec) {
    const longest = Math.max(width, height);
    if (longest <= EDGE && file.size <= LIMIT) return asCame(file);
    const encode = (to, type, quality) => codec.encode(source, ...sized(width, height, to), type, quality);
    const sent = (blob, to, type) => ({ file: new File([blob], file.name, { type }), scaledTo: to === longest ? null : to, refusal: null });
    let edge = longest;
    if (longest > EDGE) {
      edge = EDGE;
      const blob = await encode(EDGE, PNG);
      if (blob.size <= LIMIT) return sent(blob, EDGE, PNG);
    }
    const tried = [];
    if (opaque) {
      for (const quality of QUALITIES) {
        const blob = await encode(edge, JPEG, quality);
        if (blob.size <= LIMIT) return sent(blob, edge, JPEG);
        tried.push(blob.size);
      }
    } else {
      for (const to of EDGES) {
        if (to >= edge) continue;
        const blob = await encode(to, PNG);
        if (blob.size <= LIMIT) return sent(blob, to, PNG);
        tried.push(blob.size);
      }
    }
    const bytes = tried.length ? tried[tried.length - 1] : file.size;
    return { file, scaledTo: null, refusal: { code: 'image-bytes', name: file.name, bytes, limit: LIMIT } };
  }

  // `kind` is what detectBytes found for the file's bytes, whose width and
  // height come from its header. Answers `{ file, scaledTo, refusal }`: the
  // file to send, under the name it came with; the edge it was scaled to, or
  // null; and a refusal, or null. An image that can't be decoded or encoded is
  // refused as unsupported. Never rejects.
  async function prepareImage(file, kind, codec) {
    if (Math.max(kind.width, kind.height) <= EDGE && file.size <= LIMIT) return asCame(file);
    let decoded = null;
    try {
      decoded = await codec.decode(file);
      return await steps(file, decoded, codec);
    } catch {
      return { file, scaledTo: null, refusal: { code: 'unsupported', name: file.name } };
    } finally {
      // A decoded bitmap holds its pixels until it is closed.
      if (decoded && decoded.source && typeof decoded.source.close === 'function') decoded.source.close();
    }
  }

  // ===== THE CANVAS =====

  // Rows read at a time when looking for a see-through pixel, so a large
  // image is never copied whole.
  const BAND = 256;

  function context2d(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('the window could not draw the image');
    return { canvas, context };
  }

  // Whether no pixel of the decoded image has an alpha below 255.
  function opaqueAll(source, width, height) {
    const { context } = context2d(width, Math.min(BAND, height));
    for (let top = 0; top < height; top += BAND) {
      const rows = Math.min(BAND, height - top);
      context.clearRect(0, 0, width, rows);
      context.drawImage(source, 0, top, width, rows, 0, 0, width, rows);
      const { data } = context.getImageData(0, 0, width, rows);
      for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
    }
    return true;
  }

  // The browser's own decoder and encoder. A decoded animated image is its
  // first frame.
  const codec = {
    decode(file) {
      return createImageBitmap(file).then((source) => {
        const { width, height } = source;
        try {
          return { source, width, height, opaque: opaqueAll(source, width, height) };
        } catch (e) {
          source.close();
          throw e;
        }
      });
    },
    encode(source, width, height, type, quality) {
      const { canvas, context } = context2d(width, height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, width, height);
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the window could not encode the image'))), type, quality);
      });
    },
  };

  return { animated, prepareImage, codec };
}));
