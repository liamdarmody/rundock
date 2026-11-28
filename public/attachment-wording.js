'use strict';
// THE WORDS FOR AN ATTACHED FILE: its size as a person reads it, and what a
// refused attachment says. The server words its own refusals with this module
// before it answers a chat; the composer words the ones it finds before it
// sends. One module, so both sides say the same thing. Same UMD pattern as
// readable-error.js.
//
// A SIZE IS ROUNDED UP, NEVER TO NEAREST. A file 1 byte over a limit must not
// read as the limit itself, so 3,500,001 bytes reads "3.6 MB" against a limit
// of "3.5 MB". Integer arithmetic only, so no float can round a value down.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAttachmentWording = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const KB = 1000;
  const MB = 1000000;
  const unitsUp = (n, unit) => Math.floor((n + unit - 1) / unit);

  // KB below a megabyte; one decimal below 10 MB, with a trailing ".0" left
  // off; whole megabytes from there.
  function formatSize(bytes) {
    if (bytes < MB) return `${unitsUp(bytes, KB)} KB`;
    if (bytes < 10 * MB) {
      const tenths = unitsUp(bytes, MB / 10);
      const rest = tenths % 10;
      return `${(tenths - rest) / 10}${rest ? `.${rest}` : ''} MB`;
    }
    return `${unitsUp(bytes, MB)} MB`;
  }

  const UNSUPPORTED = 'Rundock can attach images (PNG, JPEG, GIF, WebP), PDF, text, Markdown and CSV files';
  const NOT_SENT = 'Message not sent';
  const FALLBACK = 'Rundock couldn\'t save the files. Your message and files are still here.';

  // A refusal is an object carrying `code`, and the fields its code uses:
  // `name` (the file's original name), `bytes`, `limit` and `count`.
  // `fileCount` is how many files the refused message or pick held; a refusal
  // of one file is titled with its name. Only an own `name` counts, since an
  // Error inherits one ("Error") that names no file.
  function refusalWording(refusal, fileCount) {
    const r = refusal || {};
    const named = Object.prototype.hasOwnProperty.call(r, 'name') ? r.name : null;
    const many = fileCount === 1 && named !== null ? named : `${fileCount} files not added`;
    switch (r.code) {
      case 'pdf-bytes': return { title: named, text: `This file is ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per file` };
      case 'text-bytes': return { title: named, text: `This file is ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per text file` };
      case 'image-bytes': return { title: named, text: `This image is still ${formatSize(r.bytes)} after scaling; the limit is ${formatSize(r.limit)} per image` };
      case 'unsupported': return { title: named, text: UNSUPPORTED };
      case 'heic': return { title: named, text: 'Rundock can\'t attach HEIC photos. Save it as JPEG or PNG first.' };
      case 'too-many-files': return { title: many, text: `That would make ${r.count} files; the limit is ${r.limit} per message` };
      case 'too-many-bytes': return { title: many, text: `That would make ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per message` };
      case 'too-large': return { title: NOT_SENT, text: `This message is too large to send (${formatSize(r.bytes)} with its files; the limit is 28 MB). Remove a file or shorten the text.` };
      case 'codex-pdf': return { title: named, text: 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.' };
      case 'codex-images': return { title: NOT_SENT, text: 'This agent runs on Codex, and Rundock sends a Codex agent at most 20 images or 10 MB of images in one conversation. Remove an image or start a new conversation.' };
      case 'deleted': return { title: NOT_SENT, text: 'This conversation was deleted in another window.' };
      case 'disk-full': return { title: NOT_SENT, text: `Rundock couldn't save ${named} because the disk is full. Your message and files are still here.` };
      default: return { title: NOT_SENT, text: FALLBACK };
    }
  }

  return { formatSize, refusalWording };
}));
