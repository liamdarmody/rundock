// Suggests notes while a wikilink is being typed. Typing [[ in the note body
// opens a list of the workspace's notes, filtered by what is typed after it;
// choosing one replaces the typed [[query with a finished link to that note.
//
// The editor reads and writes no files here. The host passes
// listWikilinkTargets, which returns (or resolves to) the notes as
// { path, name, target }. It is called once each time the list opens, never
// per keystroke. A list that throws, rejects or never answers leaves the list
// empty, and Enter still finishes the link with the typed text.
//
// Names reach the page only as text (textContent), never as markup.

import { Suggestion, PluginKey, exitSuggestion } from '../../vendor/tiptap-bundle.mjs';

export const wikilinkSuggestKey = new PluginKey('rundockWikilinkSuggest');
export const MAX_SUGGESTIONS = 20;
export const NO_NOTES_TEXT = 'No notes found';

// Characters that end the target part of a link: [ and ] nest or close it,
// | starts an alias, # a heading, ^ a block. Once one is typed the list
// closes and the rest is ordinary typing; the input rule still turns a typed
// [[...]] into a link. A target holding one could not be written back as
// [[target]] intact, so a note listed with one is dropped.
const STOP_RE = /[[\]|#^]/;
const UNSAFE_TARGET_RE = /[[\]|#^\u0000-\u001f\u007f-\u009f]/;

// prosemirror-history starts a new undo group for a transaction carrying this
// meta. The vendor bundle does not export closeHistory, so the key is named
// as the bundle registers it (PluginKey("closeHistory")).
const CLOSE_HISTORY_META = 'closeHistory$';
// An undo or redo carries this meta (PluginKey("history") in the bundle).
const HISTORY_META = 'history$';

const GAP = 4;

// The open [[query just before the cursor, or null. Only the text node
// before the cursor is read, so a link never spans other nodes.
export function findWikilinkQuery($position) {
  const node = $position.nodeBefore;
  if (!node || !node.isText) return null;
  const at = node.text.lastIndexOf('[[');
  if (at === -1) return null;
  const query = node.text.slice(at + 2);
  if (STOP_RE.test(query)) return null;
  const from = $position.pos - node.text.length + at;
  return { range: { from, to: $position.pos }, query, text: node.text.slice(at) };
}

function inCode(state, range) {
  const $to = state.doc.resolve(range.to);
  if ($to.parent.type.spec.code) return true;
  const before = $to.nodeBefore;
  return !!before && before.marks.some((mark) => mark.type.spec.code);
}

// Whether this transaction put the character at pos (a position in the new
// doc) there. Typing often lands one key per transaction, but the browser can
// hand over several keys at once (typing straight after a link is one case),
// so "[[" may arrive together with what follows it. An undo or redo only puts
// old text back, so it never counts.
function wroteAt(transaction, pos) {
  if (!transaction.docChanged || transaction.getMeta(HISTORY_META)) return false;
  const { mapping } = transaction;
  let inserted = false;
  mapping.maps.forEach((map, i) => {
    const later = mapping.slice(i + 1);
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (pos >= later.map(newStart, -1) && pos < later.map(newEnd, 1)) inserted = true;
    });
  });
  return inserted;
}

function defaultScore(needle, haystack) {
  const fuzzy = globalThis.RundockFuzzy;
  if (fuzzy && typeof fuzzy.fuzzyScore === 'function') return fuzzy.fuzzyScore(needle, haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase()) ? 1 : null;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The notes to show for a query: every note by name when nothing is typed,
// otherwise those the fuzzy scorer matches (against the path when the query
// names a folder), best first, at most MAX_SUGGESTIONS.
export function rankTargets(list, query, score = defaultScore) {
  const q = String(query || '').trim();
  const rows = [];
  for (const c of list) {
    const s = q ? score(q, q.includes('/') ? c.path.replace(/\.md$/i, '') : c.name) : 0;
    if (s !== null && s !== undefined) rows.push({ c, s });
  }
  rows.sort((a, b) => b.s - a.s || byText(a.c.name, b.c.name) || byText(a.c.path, b.c.path));
  return rows.slice(0, MAX_SUGGESTIONS).map((r) => r.c);
}

function usable(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && typeof c.path === 'string' && typeof c.name === 'string'
    && typeof c.target === 'string' && c.target && !UNSAFE_TARGET_RE.test(c.target));
}

// Replaces the typed [[query with a link to target, as one transaction that
// also starts a new undo step, so one undo puts the typed text back.
export function insertWikilink(editor, range, target) {
  const { state, view } = editor;
  const type = state.schema.nodes.wikilink;
  if (!type || !target) return false;
  const tr = state.tr.replaceWith(range.from, range.to, type.create({ target, alias: null }));
  tr.setMeta(CLOSE_HISTORY_META, true);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function createRenderer(editor, listWikilinkTargets) {
  let session = null;
  let last = null;
  let popup = null;
  let rows = [];
  let selected = 0;

  const current = () => wikilinkSuggestKey.getState(editor.state) || { active: false };

  function open() {
    const mine = { list: [], settled: false };
    session = mine;
    const settle = (value) => {
      if (session !== mine) return;
      mine.list = usable(value);
      mine.settled = true;
      if (popup) render();
    };
    try {
      const answer = listWikilinkTargets();
      if (answer && typeof answer.then === 'function') Promise.resolve(answer).then(settle, () => settle([]));
      else settle(answer);
    } catch {
      settle([]);
    }
  }

  function close() {
    if (popup) popup.remove();
    popup = null;
    session = null;
    last = null;
    rows = [];
    selected = 0;
  }

  function choose(index) {
    const state = current();
    const row = rows[index];
    if (!state.active || !row) return false;
    return insertWikilink(editor, state.range, row.target);
  }

  function paintSelection() {
    if (!popup) return;
    [...popup.querySelectorAll('.wikilink-suggest-item')].forEach((item, i) => {
      item.classList.toggle('selected', i === selected);
      item.setAttribute('aria-selected', String(i === selected));
      if (i === selected) item.scrollIntoView({ block: 'nearest' });
    });
  }

  function place() {
    if (!popup || popup.hidden || !last) return;
    let rect = null;
    try { rect = last.clientRect && last.clientRect(); } catch {}
    if (!rect) return;
    const win = popup.ownerDocument.defaultView;
    const height = popup.offsetHeight;
    const flip = rect.bottom + GAP + height > win.innerHeight && rect.top - GAP - height > 0;
    popup.style.top = `${Math.round(flip ? rect.top - GAP - height : rect.bottom + GAP)}px`;
    popup.style.left = `${Math.round(Math.max(GAP, Math.min(rect.left, win.innerWidth - popup.offsetWidth - GAP)))}px`;
  }

  function render() {
    if (!session || !last) return;
    const doc = editor.view.dom.ownerDocument;
    if (!popup) {
      popup = doc.createElement('div');
      popup.className = 'wikilink-suggest';
      popup.setAttribute('role', 'listbox');
      // Keeps focus (and the cursor) in the editor when a row is clicked.
      popup.addEventListener('mousedown', (event) => event.preventDefault());
      doc.body.appendChild(popup);
    }
    rows = session.settled ? rankTargets(session.list, last.query) : [];
    if (selected >= rows.length) selected = 0;
    popup.replaceChildren();
    rows.forEach((row, i) => {
      const item = doc.createElement('div');
      item.className = 'wikilink-suggest-item';
      item.setAttribute('role', 'option');
      const title = doc.createElement('div');
      title.className = 'wikilink-suggest-title';
      title.textContent = row.name;
      item.appendChild(title);
      const slash = row.path.lastIndexOf('/');
      if (slash > 0) {
        const folder = doc.createElement('div');
        folder.className = 'wikilink-suggest-meta';
        folder.textContent = row.path.slice(0, slash);
        item.appendChild(folder);
      }
      item.addEventListener('click', () => { if (choose(i)) editor.view.focus(); });
      popup.appendChild(item);
    });
    if (session.settled && !rows.length) {
      const empty = doc.createElement('div');
      empty.className = 'wikilink-suggest-empty';
      empty.textContent = NO_NOTES_TEXT;
      popup.appendChild(empty);
    }
    popup.hidden = !session.settled;
    paintSelection();
    place();
  }

  return {
    // Suggestion calls these after an await, so a call can arrive after the
    // list has already closed; each checks the live state first. Only onStart
    // asks the host for the list: when the open list moves to another [[,
    // Suggestion calls onExit, onUpdate and then onStart, and an update with
    // no open list is left for the onStart that follows it.
    onStart(props) {
      if (!current().active) return;
      close();
      last = props;
      open();
      render();
    },
    onUpdate(props) {
      if (!session || !current().active) return;
      last = props;
      selected = 0;
      render();
    },
    onKeyDown({ event }) {
      if (!session || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!rows.length) return false;
        selected = (selected + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
        paintSelection();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (rows.length) return choose(selected);
        const state = current();
        // Nothing listed and nothing typed: the key does what it always does.
        if (!state.active || !state.query.trim()) return false;
        // Otherwise the link holds exactly what was typed, spaces included.
        return insertWikilink(editor, state.range, state.query);
      }
      return false;
    },
    // Called twice on Escape (once directly, once by the closing update).
    onExit() {
      close();
    },
  };
}

export function createWikilinkSuggestPlugin(editor, { listWikilinkTargets }) {
  let wasActive = false;
  editor.on('blur', () => {
    if (wikilinkSuggestKey.getState(editor.state)?.active) exitSuggestion(editor.view, wikilinkSuggestKey);
  });
  return Suggestion({
    editor,
    pluginKey: wikilinkSuggestKey,
    char: '[[',
    allowSpaces: true,
    decorationClass: 'wikilink-suggest-query',
    findSuggestionMatch: ({ $position }) => findWikilinkQuery($position),
    allow: ({ state, range, isActive }) => {
      wasActive = isActive;
      return !inCode(state, range);
    },
    // Opens only in the change that writes the second [ (typed, or pasted
    // as an unclosed [[); once open it follows the cursor and the query.
    // Moving the cursor into an old unclosed [[, typing after one, or an
    // undo that puts one back does not open it.
    shouldShow: ({ range, transaction }) => wasActive || wroteAt(transaction, range.from + 1),
    render: () => createRenderer(editor, listWikilinkTargets),
  });
}
