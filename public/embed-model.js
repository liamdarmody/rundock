'use strict';
// Embeds, shape A: a note that embeds files shows each one where it sits,
// rendered by whatever claims it, side by side.
//
// PROVISIONAL SURFACE. The decisions this carries, and the place each is
// made, so reversing one is a change here:
//   - A line holding only embeds (`![[a]] ![[b]] ![[c]]`) becomes a row of
//     panels. An embed inside a sentence stays the link it has always been.
//   - At most three panels sit side by side; a fourth starts a new row.
//   - `|400` on an embed is the panel's height in pixels, within bounds.
//   - Depth one: an embedded file's own embeds are shown as links, never
//     mounted, so a cycle cannot form.
//
// Pure, so every rule above is testable without a browser. The DOM wiring
// lives in views/files.js and the editor's decoration in
// editor/plugins/embeds.js; both ask this module the same questions.
//
// UMD so it loads as a browser global (RundockEmbedModel) and is requireable
// in node tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockEmbedModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const MAX_PER_ROW = 3;
  const MIN_HEIGHT = 80;
  const MAX_HEIGHT = 800;
  const DEFAULT_HEIGHT = 240;
  const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|mp3|mp4|mov|wav|woff2?|ttf|otf|sqlite|db)$/i;

  // A paragraph's inline pieces, in order: { text } or { target, alias }.
  // Returns the embeds when the paragraph is nothing but embeds, else null.
  function embedsIn(pieces) {
    const out = [];
    let bang = false;
    for (const piece of Array.isArray(pieces) ? pieces : []) {
      if (piece && typeof piece.text === 'string') {
        const t = piece.text.replace(/\s+/g, '');
        if (t === '') continue;
        if (t === '!' && !bang) { bang = true; continue; }
        return null;
      }
      if (piece && typeof piece.target === 'string') {
        if (!bang) return null;
        bang = false;
        out.push(spec(piece.target, piece.alias));
        continue;
      }
      return null;
    }
    if (bang || !out.length) return null;
    return out;
  }

  // One embed as written: the file name, any heading, and the height.
  function spec(target, alias) {
    const raw = String(target || '').trim();
    const hash = raw.indexOf('#');
    const name = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const heading = hash === -1 ? null : raw.slice(hash + 1).trim() || null;
    return { target: raw, name, heading, height: heightOf(alias) };
  }

  function heightOf(alias) {
    const n = /^\s*(\d{1,4})\s*$/.exec(String(alias == null ? '' : alias));
    if (!n) return DEFAULT_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Number(n[1])));
  }

  // The name to look for in the tree. A name with an extension is looked up
  // as written, whatever the extension (a `.csv` embed is a csv file, never
  // `holdings.csv.md`); a bare name is a note.
  function searchName(name) {
    const base = String(name || '').trim();
    return /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.md`;
  }

  function rows(embeds) {
    const out = [];
    for (let i = 0; i < embeds.length; i += MAX_PER_ROW) out.push(embeds.slice(i, i + MAX_PER_ROW));
    return out;
  }

  function isBinaryPath(path) { return BINARY.test(String(path || '')); }

  function baseName(path) { return String(path || '').split('/').pop(); }

  // What a panel shows for a target, decided from facts the caller gathered.
  // `path` is the resolved file or null; `owner` is the note doing the
  // embedding; `hidden` whether the path is one extensions may never see;
  // `claimed` whether an installed, enabled extension claims it.
  function panelFor({ path, owner, hidden, claimed }) {
    if (!path) return { kind: 'missing', note: 'Not found in this workspace.' };
    if (path === owner) return { kind: 'link', note: 'This note embeds itself, so it is shown as a link.' };
    if (hidden) return { kind: 'link', note: 'Files in hidden folders are never shown in an embed.' };
    if (claimed) return { kind: 'extension', note: 'read-only' };
    if (isBinaryPath(path)) return { kind: 'link', note: 'No installed extension shows this file here.' };
    if (/\.(md|mdx)$/i.test(path)) return { kind: 'markdown', note: 'not claimed: shown as a note' };
    return { kind: 'text', note: 'not claimed: shown as text' };
  }

  return { MAX_PER_ROW, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT, embedsIn, spec, heightOf, searchName, rows, isBinaryPath, baseName, panelFor };
}));
