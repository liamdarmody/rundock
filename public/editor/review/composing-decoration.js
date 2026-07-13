// Composing-range decoration: keeps the text a comment or suggestion is
// being written about visibly marked while focus is in the review composer
// (the editor blurs, so the native selection highlight disappears).
//
// The range lives in plugin state and is MAPPED through document changes,
// which also makes it the source of truth for where the construct lands on
// submit: if the user edits the document while the composer is open, the
// decoration and the eventual anchor move with the text instead of going
// stale.

import { Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

export const composingKey = new PluginKey('rundockReviewComposing');

export function createComposingPlugin() {
  return new Plugin({
    key: composingKey,
    state: {
      init: () => null, // { from, to } | null
      apply(tr, value) {
        const meta = tr.getMeta(composingKey);
        if (meta !== undefined) return meta;
        if (value && tr.docChanged) {
          const from = tr.mapping.map(value.from, -1);
          const to = tr.mapping.map(value.to, 1);
          return from < to ? { from, to } : null;
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const range = composingKey.getState(state);
        if (!range || range.from >= range.to) return null;
        return DecorationSet.create(state.doc, [
          Decoration.inline(range.from, range.to, { class: 'review-composing' }),
        ]);
      },
    },
  });
}

export function setComposingRange(editor, range) {
  editor.view.dispatch(editor.state.tr.setMeta(composingKey, range));
}

export function getComposingRange(editor) {
  return composingKey.getState(editor.state);
}
