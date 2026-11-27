'use strict';
// THE FILES A SENT MESSAGE SHOWS. A person's bubble draws each attached-file
// line in its text as the file: a thumbnail for an image, a chip for a
// document, and "File not available" for a file that isn't there as it was
// sent. What the page knows of each file comes only from the server's
// replies (the history's files and the answer to a message sent with files),
// held per conversation in memory and never saved. Same UMD pattern as
// attachment-wording.js.
//
// A LINE IS LOOKED UP ONLY FOR ITS OWN CONVERSATION. A line naming another
// conversation's folder, and the forms a turn writes in place of a line, are
// drawn as not available without asking the map, so a message can never load
// a file from outside its own conversation.
//
// Every name reaches the page through textContent or setAttribute.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockSentFiles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // A copy of the composer's types (views/composer.js), which a test holds
  // equal.
  const CHIP_TYPES = new Map([['png', 'PNG'], ['jpg', 'JPEG'], ['jpeg', 'JPEG'], ['gif', 'GIF'], ['webp', 'WebP'],
    ['pdf', 'PDF'], ['txt', 'Text'], ['md', 'Markdown'], ['csv', 'CSV']]);
  const IMAGE_TYPES = new Set(['png', 'jpg', 'gif', 'webp']);
  const NOT_AVAILABLE = 'File not available';
  const THUMB_WIDTH = 224;
  const THUMB_HEIGHT = 168;
  const SVG = 'http://www.w3.org/2000/svg';
  const DOC = ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'];
  const ICONS = {
    file: [...DOC, 'M10 9H8', 'M16 13H8', 'M16 17H8'],
    sheet: [...DOC, 'M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'],
    goneFile: [...DOC, 'm14.5 12.5-5 5', 'm9.5 12.5 5 5'],
    goneImage: ['M2 2 22 22', 'M10.41 10.41a2 2 0 1 1-2.83-2.83', 'M13.5 13.5 6 21', 'M18 12 21 15',
      'M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59', 'M21 15V5a2 2 0 0 0-2-2H9'],
  };

  const lines = () => (typeof RundockAttachmentLines !== 'undefined' ? RundockAttachmentLines : require('./attachment-lines.js'));
  const wording = () => (typeof RundockAttachmentWording !== 'undefined' ? RundockAttachmentWording : require('./attachment-wording.js'));

  // Conversation id to a Map of stored name to what the server last said of
  // that file: { name, type, bytes, state, width?, height? }.
  const known = new Map();
  function filesOf(conversationId) {
    if (!known.has(conversationId)) known.set(conversationId, new Map());
    return known.get(conversationId);
  }

  // A history reply's files, keyed by stored name. A later value replaces an
  // earlier one.
  function mergeSentFiles(conversationId, files) {
    if (typeof conversationId !== 'string' || !files || typeof files !== 'object') return;
    const map = filesOf(conversationId);
    for (const [file, entry] of Object.entries(files)) {
      if (entry && typeof entry === 'object') map.set(file, entry);
    }
  }

  // The record entry the answer to a message sent with files carries: each of
  // its files is there as it was just sent.
  function mergeStoredFiles(conversationId, entry) {
    if (typeof conversationId !== 'string' || !entry || !Array.isArray(entry.files)) return;
    const files = {};
    for (const f of entry.files) {
      if (!f || typeof f.file !== 'string') continue;
      const value = { name: f.name, type: f.type, bytes: f.bytes, state: 'present' };
      if (f.width !== undefined) Object.assign(value, { width: f.width, height: f.height });
      files[f.file] = value;
    }
    mergeSentFiles(conversationId, files);
  }

  function entryFor(conversationId, file) {
    const map = known.get(conversationId);
    return (map && map.get(file)) || null;
  }

  const extOf = (file) => file.slice(file.lastIndexOf('.') + 1);
  const pixels = (n) => Number.isInteger(n) && n > 0;

  // Inside 224 by 168 at the image's own shape, never larger than it is.
  function fitThumb(width, height) {
    const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height, 1);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    for (const [key, value] of [['class', 'ic'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) {
      svg.setAttribute(key, value);
    }
    for (const d of ICONS[name]) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  // A chip: its tile and icon, then its name and a line under it.
  function chip(tag, className, name, meta, iconName) {
    const node = el(tag, className);
    node.setAttribute('title', name);
    const tile = el('span', 'att-tile');
    tile.appendChild(icon(iconName));
    const txt = el('span', 'att-txt');
    const n = el('span', 'att-name');
    n.textContent = name;
    const m = el('span', 'att-meta');
    m.textContent = meta;
    txt.append(n, m);
    node.append(tile, txt);
    return node;
  }

  function goneChip(name, ext) {
    const node = chip('div', 'att-chip gone', name, NOT_AVAILABLE, IMAGE_TYPES.has(ext) ? 'goneImage' : 'goneFile');
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', name);
    return node;
  }

  function thumb(conversationId, file, entry, name) {
    const node = el('button', 'msg-thumb');
    node.setAttribute('type', 'button');
    node.setAttribute('aria-label', `Open ${name}`);
    node.setAttribute('title', name);
    const size = fitThumb(entry.width, entry.height);
    const img = el('img');
    img.setAttribute('alt', name);
    img.setAttribute('src', '/workspace-file?path=' + encodeURIComponent(`.rundock/attachments/${conversationId}/${file}`));
    img.setAttribute('width', String(size.width));
    img.setAttribute('height', String(size.height));
    node.appendChild(img);
    return node;
  }

  // What one line draws as.
  function fileChip(line, conversationId) {
    const entry = line.kind === 'attached' && line.id === conversationId ? api.entryFor(conversationId, line.file) : null;
    const name = entry && typeof entry.name === 'string' && entry.name ? entry.name : line.file;
    const ext = extOf(line.file);
    if (!entry || entry.state !== 'present' || entry.type !== ext) return goneChip(name, ext);
    if (IMAGE_TYPES.has(ext)) {
      return pixels(entry.width) && pixels(entry.height) ? thumb(conversationId, line.file, entry, name) : goneChip(name, ext);
    }
    const meta = `${CHIP_TYPES.get(ext)} · ${wording().formatSize(entry.bytes)}`;
    if (ext === 'pdf') {
      const node = chip('button', 'att-chip', name, meta, 'file');
      node.setAttribute('type', 'button');
      node.setAttribute('aria-label', `Open ${name}`);
      return node;
    }
    const node = chip('div', 'att-chip plain', name, meta, ext === 'csv' ? 'sheet' : 'file');
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', name);
    return node;
  }

  // Redraws a person's bubble, already drawn from its whole text, as its
  // files first and then the rest of its text. A text with no attached-file
  // line is left as drawn.
  function drawSentFiles(messageDiv, text, conversationId) {
    const { text: rest, files } = lines().splitAttachmentLines(text);
    if (files.length === 0) return;
    const bubble = messageDiv.querySelector('.msg-bubble');
    if (!bubble) return;
    const row = el('div', 'msg-files');
    for (const line of files) row.appendChild(fileChip(line, conversationId));
    bubble.replaceChildren(row);
    if (rest) bubble.appendChild(document.createTextNode(rest));
  }

  const api = { mergeSentFiles, mergeStoredFiles, entryFor, drawSentFiles };
  return api;
}));
