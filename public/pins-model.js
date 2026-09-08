'use strict';
/**
 * The Pins list's model: what a pin is, how the list is ordered, and how it
 * reads against the workspace tree.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW. The same reason the routines list and
 * the skills pane have one. Everything this list is judged on is either a
 * rule about an array of paths or a piece of copy, and both are reachable
 * only by a browser once written inline in a render. Pulled out here, the
 * server's store and the client's view call ONE set of rules, and neither
 * carries a second copy that can drift from the first.
 *
 * THE ORDER IS THE ORDER THEY WERE PINNED, earliest first, and nothing here
 * sorts. A pinned list is a handful of working surfaces, and the position a
 * reader has learned for one must not move when they pin another.
 *
 * RECONCILE MARKS AND REMOVES NOTHING. A pinned file that was deleted or
 * renamed outside Rundock is still a decision the reader made. The model says
 * which rows the tree no longer carries; the view draws them marked, with an
 * explicit Remove; the store is only ever written by a message the reader
 * sent. Silent removal is the opposite failure: indistinguishable from
 * Rundock losing the pin for no reason.
 *
 * NOTHING HERE TOUCHES THE DOM. Flat UMD, requireable in node, and pinned by
 * test/unit/pins-model.test.js.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockPinsModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * The pushpin, and it is the one the conversation list already draws for
   * its own pins (views/conversations.js, the pin indicator). One shape for
   * one meaning wherever it appears: the rail, the sidebar rows, the header
   * control and the context menu. Filled is the same path drawn with a fill,
   * the way the conversation list draws it, because a linear glyph has no
   * second drawing.
   */
  const GLYPH = '<path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/>';

  /**
   * @param {boolean} filled
   * @param {string} [className]
   */
  function glyphSvg(filled, className) {
    const cls = className ? ` class="${className}"` : '';
    return filled
      ? `<svg${cls} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>`
      : `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>`;
  }

  /**
   * The empty state, in the four slots of the empty-states pattern: what is
   * true, what the thing is for, what to do next, and an aside. The next step
   * names BOTH ways to pin, because the header control is the one a
   * non-technical reader will find and right-click is the one they will not.
   */
  const EMPTY = {
    lead: 'Nothing pinned yet.',
    mechanism: 'Pin the files you come back to daily, a backlog, a roadmap, a dashboard, '
      + 'and they show up here, one click away.',
    nextStep: 'Pin the file you are reading from the pin control in its header, '
      + 'or right-click any file in the tree and choose Pin.',
    aside: 'Pins are kept on this machine, for you: a shared workspace does not share them.',
  };

  /** The line under a pin whose file the tree no longer carries. */
  const MISSING_NOTE = 'Not found: moved or deleted outside Rundock.';

  /** The pane when every pin is missing, so the rail entry still opens onto something. */
  const ALL_MISSING = 'None of your pins could be found. Remove them from the list, or pin the files at their new paths.';

  /**
   * A list of paths out of whatever arrived: strings only, no empties, no
   * duplicates, first-seen order kept.
   * @param {unknown} list
   * @returns {string[]}
   */
  function normalize(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      if (typeof p !== 'string' || !p.trim()) continue;
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  /** @param {string[]|null|undefined} pins @param {string} p */
  function has(pins, p) {
    return Array.isArray(pins) && typeof p === 'string' && p !== '' && pins.includes(p);
  }

  /**
   * Pin a path: appended at the end, and a no-op for a path already there.
   * @param {string[]} pins @param {string} p
   */
  function add(pins, p) {
    const list = normalize(pins);
    if (typeof p !== 'string' || !p.trim() || list.includes(p)) return list;
    return list.concat([p]);
  }

  /**
   * Unpin a path: the rest keep their order.
   * @param {string[]} pins @param {string} p
   */
  function remove(pins, p) {
    return normalize(pins).filter(x => x !== p);
  }

  /**
   * Every file in the tree by path. Folders are walked and never indexed:
   * a folder path in the list is not a pin, so it resolves to nothing.
   * @param {any[]} tree
   */
  function indexFiles(tree) {
    const files = new Map();
    const walk = (items) => {
      for (const item of items || []) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'folder') walk(item.children);
        else if (typeof item.path === 'string') files.set(item.path, item);
      }
    };
    walk(tree);
    return files;
  }

  /** @param {string} p */
  function baseName(p) { return p.split('/').pop() || p; }
  /** @param {string} p */
  function folderOf(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }

  /**
   * The list read against the tree, in pin order, one row per pin.
   *
   * A tree that has not arrived (null or undefined) marks nothing missing:
   * nothing is known about the workspace yet, so nothing is claimed about a
   * pin. A tree that has arrived, empty included, is the truth about which
   * files exist, and a pin it does not carry is marked.
   *
   * @param {string[]} pins
   * @param {any[]|null|undefined} tree
   * @returns {{path: string, name: string, folder: string, kind: string, missing: boolean}[]}
   */
  function reconcile(pins, tree) {
    const arrived = Array.isArray(tree);
    const files = arrived ? indexFiles(tree) : new Map();
    return normalize(pins).map((p) => {
      const item = files.get(p);
      return {
        path: p,
        name: item && item.name ? item.name : baseName(p),
        folder: folderOf(p),
        kind: item && item.kind ? item.kind : 'file',
        missing: arrived && !item,
      };
    });
  }

  /**
   * The row the rail opens onto when nothing pinned is open: the first that
   * can be opened, which is the Skills precedent of picking the first item.
   * @param {{missing: boolean}[]} rows
   */
  function firstOpenable(rows) {
    for (const r of rows || []) if (r && !r.missing) return r;
    return null;
  }

  /** The empty pane: mechanism then next step, always both, in that order. */
  function emptyState() {
    return { lead: EMPTY.lead, body: `${EMPTY.mechanism} ${EMPTY.nextStep}`, aside: EMPTY.aside };
  }

  return { GLYPH, glyphSvg, EMPTY, MISSING_NOTE, ALL_MISSING, normalize, has, add, remove, reconcile, firstOpenable, emptyState };
}));
