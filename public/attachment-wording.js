'use strict';
// THE WORDS A PERSON READS ABOUT AN ATTACHMENT.
//
// Sizes are shown in the units the limits are set in: a megabyte is
// 1,000,000 bytes and a kilobyte 1,000. Below a megabyte a size is in KB,
// from it in MB, with one decimal below 10 MB. Every size is rounded up, in
// whole numbers, so a file over a limit never shows as equal to it.
//
// Each refusal the server can give an attachment has one title and one
// sentence. A refusal about one file is titled with that file's own name; one
// about the whole message is titled with the number of files it sent. A code
// with no words of its own gets the fallback. The server words its refusals
// with this module; the page loads the same file. Same UMD pattern as
// readable-error.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAttachmentWording = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const KB = 1000;
  const MB = 1000000;

  // Whole units of `unit` in `n`, rounded up.
  const unitsUp = (n, unit) => Math.floor((n + unit - 1) / unit);

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

  function refusalWording(refusal, fileCount) {
    const r = refusal || {};
    switch (r.code) {
      case 'pdf-bytes': return { title: r.name, text: `This file is ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per file` };
      case 'text-bytes': return { title: r.name, text: `This file is ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per text file` };
      case 'image-bytes': return { title: r.name, text: `This image is still ${formatSize(r.bytes)} after scaling; the limit is ${formatSize(r.limit)} per image` };
      case 'unsupported': return { title: r.name, text: UNSUPPORTED };
      case 'heic': return { title: r.name, text: 'Rundock can\'t attach HEIC photos. Save it as JPEG or PNG first.' };
      case 'too-many-files': return { title: `${fileCount} files not added`, text: `That would make ${r.count} files; the limit is ${r.limit} per message` };
      case 'too-many-bytes': return { title: `${fileCount} files not added`, text: `That would make ${formatSize(r.bytes)}; the limit is ${formatSize(r.limit)} per message` };
      case 'deleted': return { title: NOT_SENT, text: 'This conversation was deleted in another window.' };
      case 'disk-full': return { title: NOT_SENT, text: `Rundock couldn't save ${r.name} because the disk is full. Your message and files are still here.` };
      default: return { title: NOT_SENT, text: FALLBACK };
    }
  }

  return { formatSize, refusalWording };
}));
