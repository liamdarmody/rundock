// Find plugin for the Tiptap editor.
//
// In-view text search using a ProseMirror plugin. Matches are stored as
// document positions and rendered as inline decorations with class
// 'find-match' (plus '.current' on the active match). Decorations never
// modify the document, so save / round-trip are untouched.
//
// Public flow (consumed from public/editor/index.js, which re-exports the
// helpers below):
//
//   setFindQuery(editor, query)   computes matches, resets to first
//   findNext(editor)              advances current index (wraps)
//   findPrev(editor)              retreats current index (wraps)
//   setFindIndex(editor, idx)     jumps to a specific match
//   clearFind(editor)             removes all matches and decorations
//   getFindState(editor)          returns { query, matches, currentIndex }
//
// app.js dispatches into these helpers and reads getFindState after each
// operation to drive the shared find-bar UI's count display and scroll.

import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

const findPluginKey = new PluginKey('rundock-find');

function collectMatches(doc, query) {
  if (!query) return [];
  const lower = query.toLowerCase();
  const queryLen = query.length;
  const matches = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let from = 0;
    while (true) {
      const idx = text.indexOf(lower, from);
      if (idx === -1) break;
      matches.push({ from: pos + idx, to: pos + idx + queryLen });
      from = idx + queryLen;
    }
  });
  return matches;
}

function buildDecorations(state, pluginState) {
  if (!pluginState.matches.length) return DecorationSet.empty;
  const decos = pluginState.matches.map((m, i) => Decoration.inline(m.from, m.to, {
    class: i === pluginState.currentIndex ? 'find-match current' : 'find-match',
  }));
  return DecorationSet.create(state.doc, decos);
}

function findPlugin() {
  return new Plugin({
    key: findPluginKey,
    state: {
      init() {
        return { query: '', matches: [], currentIndex: 0 };
      },
      apply(tr, value) {
        const meta = tr.getMeta(findPluginKey);
        if (meta) {
          if (meta.type === 'setQuery') {
            const matches = collectMatches(tr.doc, meta.query);
            return { query: meta.query, matches, currentIndex: 0 };
          }
          if (meta.type === 'next') {
            if (!value.matches.length) return value;
            return { ...value, currentIndex: (value.currentIndex + 1) % value.matches.length };
          }
          if (meta.type === 'prev') {
            if (!value.matches.length) return value;
            return { ...value, currentIndex: (value.currentIndex - 1 + value.matches.length) % value.matches.length };
          }
          if (meta.type === 'setIndex') {
            if (!value.matches.length) return value;
            const idx = Math.max(0, Math.min(value.matches.length - 1, meta.index | 0));
            return { ...value, currentIndex: idx };
          }
          if (meta.type === 'clear') {
            return { query: '', matches: [], currentIndex: 0 };
          }
        }
        // Document changed mid-find: recompute against the new doc so the
        // count stays accurate as the user edits.
        if (tr.docChanged && value.query) {
          const matches = collectMatches(tr.doc, value.query);
          const currentIndex = matches.length
            ? Math.min(value.currentIndex, matches.length - 1)
            : 0;
          return { ...value, matches, currentIndex };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const pluginState = findPluginKey.getState(state);
        if (!pluginState) return null;
        return buildDecorations(state, pluginState);
      },
    },
  });
}

export const FindExtension = Extension.create({
  name: 'rundockFind',
  addProseMirrorPlugins() {
    return [findPlugin()];
  },
});

function getState(editor) {
  if (!editor || !editor.view) return { query: '', matches: [], currentIndex: 0 };
  return findPluginKey.getState(editor.view.state) || { query: '', matches: [], currentIndex: 0 };
}

function scrollToCurrentMatch(editor) {
  if (!editor || !editor.view) return;
  const pluginState = getState(editor);
  const match = pluginState.matches[pluginState.currentIndex];
  if (!match) return;
  try {
    const coords = editor.view.coordsAtPos(match.from);
    const dom = editor.view.dom;
    const container = dom.closest('.tiptap-editor-pane') || dom.parentElement;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const matchOffsetInContainer = coords.top - containerRect.top + container.scrollTop;
    const targetTop = matchOffsetInContainer - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  } catch {
    // coordsAtPos can throw if the position is no longer valid; ignore.
  }
}

export function setFindQuery(editor, query) {
  if (!editor || !editor.view) return;
  const { state, dispatch } = editor.view;
  dispatch(state.tr.setMeta(findPluginKey, { type: 'setQuery', query: query || '' }));
}

export function findNext(editor) {
  if (!editor || !editor.view) return;
  const { state, dispatch } = editor.view;
  dispatch(state.tr.setMeta(findPluginKey, { type: 'next' }));
  scrollToCurrentMatch(editor);
}

export function findPrev(editor) {
  if (!editor || !editor.view) return;
  const { state, dispatch } = editor.view;
  dispatch(state.tr.setMeta(findPluginKey, { type: 'prev' }));
  scrollToCurrentMatch(editor);
}

export function setFindIndex(editor, index) {
  if (!editor || !editor.view) return;
  const { state, dispatch } = editor.view;
  dispatch(state.tr.setMeta(findPluginKey, { type: 'setIndex', index }));
  scrollToCurrentMatch(editor);
}

export function clearFind(editor) {
  if (!editor || !editor.view) return;
  const { state, dispatch } = editor.view;
  dispatch(state.tr.setMeta(findPluginKey, { type: 'clear' }));
}

export function getFindState(editor) {
  return getState(editor);
}
