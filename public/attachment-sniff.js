'use strict';
// WHAT AN ATTACHED FILE IS, READ FROM ITS BYTES IN THE WINDOW. The composer
// checks each file as it is added, so a file Rundock can't take says why
// before anything is sent. This is the page's copy of the server's detector
// (lib/attachments/detect.js): the same signatures, the same header reads and
// the same text rule, kept the same by test/unit/attachment-sniff.test.js,
// which runs both on the same bytes. The server checks every file again
// before it stores one, so this copy spares a round trip and the server's
// stays the guard. Same UMD pattern as attachment-wording.js.
//
// The bytes are a Uint8Array, read with plain arithmetic, and nothing is
// decoded: an image's width and height come from its header alone. A
// refusal is returned, never thrown, as `{ code, name }`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAttachmentSniff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = Object.freeze({ imageBytes: 3500000, imagePixels: 8000, pdfBytes: 10000000, textBytes: 1000000, files: 5, messageBytes: 20000000 });

  const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'mif1']);
  const TEXT_SUFFIX = /\.(txt|md|csv)$/i;
  // JPEG frame headers: C0 to CF, less C4, C8 and CC.
  const FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  // The bytes from start to end as one character per byte.
  const head = (b, start, end) => String.fromCharCode.apply(null, b.subarray(start, end));
  const u16BE = (b, at) => b[at] * 0x100 + b[at + 1];
  const u16LE = (b, at) => b[at] + b[at + 1] * 0x100;
  const u24LE = (b, at) => b[at] + b[at + 1] * 0x100 + b[at + 2] * 0x10000;
  const u32BE = (b, at) => b[at] * 0x1000000 + b[at + 1] * 0x10000 + b[at + 2] * 0x100 + b[at + 3];
  const u32LE = (b, at) => u24LE(b, at) + b[at + 3] * 0x1000000;
  const nameOf = (name) => (typeof name === 'string' ? name : '');
  // Known by its tag, so bytes made in another window still count.
  const isBytes = (b) => Object.prototype.toString.call(b) === '[object Uint8Array]';

  function pngSize(b) {
    if (b.length < 24 || head(b, 12, 16) !== 'IHDR') return null;
    return { width: u32BE(b, 16), height: u32BE(b, 20) };
  }

  // Walks the segments from offset 2 to the first frame header; every step
  // moves forward, so the walk ends on any input.
  function jpegSize(b) {
    let at = 2;
    while (at + 1 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) { at += 1; continue; }
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      if (marker === 0xda || marker === 0xd9 || at + 4 > b.length) return null;
      const length = u16BE(b, at + 2);
      if (length < 2) return null;
      if (FRAME_MARKERS.has(marker)) {
        if (at + 9 > b.length) return null;
        return { width: u16BE(b, at + 7), height: u16BE(b, at + 5) };
      }
      at += 2 + length;
    }
    return null;
  }

  function gifSize(b) {
    if (b.length < 10) return null;
    return { width: u16LE(b, 6), height: u16LE(b, 8) };
  }

  function webpSize(b) {
    const form = head(b, 12, 16);
    if (form === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16LE(b, 26) & 0x3fff, height: u16LE(b, 28) & 0x3fff };
    }
    if (form === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = u32LE(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (form === 'VP8X' && b.length >= 30) return { width: u24LE(b, 24) + 1, height: u24LE(b, 27) + 1 };
    return null;
  }

  const IMAGES = [
    { type: 'png', is: (b) => head(b, 0, 8) === '\x89PNG\r\n\x1a\n', size: pngSize },
    { type: 'jpg', is: (b) => head(b, 0, 3) === '\xff\xd8\xff', size: jpegSize },
    { type: 'gif', is: (b) => head(b, 0, 6) === 'GIF87a' || head(b, 0, 6) === 'GIF89a', size: gifSize },
    { type: 'webp', is: (b) => head(b, 0, 4) === 'RIFF' && head(b, 8, 12) === 'WEBP', size: webpSize },
  ];

  function isUtf8(b) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  }

  // `{ type }`, plus `width` and `height` for an image, or a refusal.
  // Signatures come first and win over the name; text is known by its name
  // and a clean UTF-8 body.
  function detectBytes(bytes, name) {
    if (!isBytes(bytes)) throw new TypeError('the bytes of an attached file must be a Uint8Array');
    const label = nameOf(name);
    const image = IMAGES.find((kind) => kind.is(bytes));
    if (image) {
      const size = image.size(bytes);
      if (!size || !(size.width > 0) || !(size.height > 0)) return { code: 'unsupported', name: label };
      return { type: image.type, width: size.width, height: size.height };
    }
    if (head(bytes, 0, 5) === '%PDF-') return { type: 'pdf' };
    if (bytes.length >= 12 && head(bytes, 4, 8) === 'ftyp') {
      return { code: HEIC_BRANDS.has(head(bytes, 8, 12)) ? 'heic' : 'unsupported', name: label };
    }
    const suffix = TEXT_SUFFIX.exec(label);
    if (suffix && !bytes.includes(0) && isUtf8(bytes)) return { type: suffix[1].toLowerCase() };
    return { code: 'unsupported', name: label };
  }

  // One file's own checks: its type, then a PDF's or a text file's limit.
  // An image's limits are left to the server here.
  function checkFile(bytes, name) {
    const kind = detectBytes(bytes, name);
    if (kind.code) return kind;
    const size = bytes.length;
    if (kind.type === 'pdf' && size > LIMITS.pdfBytes) return { code: 'pdf-bytes', name: nameOf(name), bytes: size, limit: LIMITS.pdfBytes };
    if (['txt', 'md', 'csv'].includes(kind.type) && size > LIMITS.textBytes) {
      return { code: 'text-bytes', name: nameOf(name), bytes: size, limit: LIMITS.textBytes };
    }
    return kind;
  }

  return { LIMITS, detectBytes, checkFile };
}));
