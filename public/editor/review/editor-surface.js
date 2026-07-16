// Editor review surface: the ProseMirror-backed implementation of the
// review panel's surface contract. The panel (panels/review.js) renders
// controller items and calls the surface for everything document-specific:
// selection capture, composing decoration, flash, scroll-to-item, change
// events. The sidecar/artifact surface (public/viewers/) implements the
// same contract over a sandboxed iframe, which is what makes the panel
// file-type-agnostic.
//
// Surface contract:
//   setup() / teardown()
//   captureSelection() -> token | null        // opaque range token
//   setComposing(token | null)                // decorate while composer is open
//   liveComposingRange() -> token | null      // mapped through document edits
//   quoteFor(token) -> string | null          // display text for the range
//   selectorFor(token) -> value passed to controller.addComment/suggestReplace
//   flashApplied(result)                      // settle flash on an op's result
//   scrollToItem(item)
//   itemAtEventTarget(items, target) -> item | null   // inline mark -> card
//   onDocChange(cb) -> unsubscribe
//   supportsSuggest                           // suggest-replacement authoring
//   editable                                  // document mutates during review

import {
  createComposingPlugin, composingKey, setComposingRange, getComposingRange,
  createFlashPlugin, flashKey, flashRange,
} from './composing-decoration.js';

export function createEditorReviewSurface(editor) {
  let changeHandler = null;
  const onTransaction = ({ transaction }) => {
    if (transaction.docChanged && changeHandler) changeHandler();
  };

  return {
    supportsSuggest: true,
    editable: true,

    setup() {
      editor.registerPlugin(createComposingPlugin());
      editor.registerPlugin(createFlashPlugin());
    },

    teardown() {
      editor.off('transaction', onTransaction);
      try { editor.unregisterPlugin(composingKey); } catch { /* editor may be gone */ }
      try { editor.unregisterPlugin(flashKey); } catch { /* editor may be gone */ }
    },

    captureSelection() {
      const { from, to } = editor.state.selection;
      return from === to ? null : { from, to };
    },

    setComposing(token) {
      setComposingRange(editor, token);
    },

    liveComposingRange() {
      return getComposingRange(editor);
    },

    quoteFor(token) {
      if (!token) return null;
      return editor.state.doc.textBetween(token.from, token.to, ' ');
    },

    // The markdown controller consumes ProseMirror ranges directly.
    selectorFor(token) {
      return token;
    },

    flashApplied(result) {
      if (!result || typeof result !== 'object') return;
      if (result.to > result.from) {
        flashRange(editor, result);
        return;
      }
      try {
        const clamped = Math.max(1, Math.min(result.from, editor.state.doc.content.size - 1));
        const dom = editor.view.domAtPos(clamped);
        const target = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
        if (target && target.classList) {
          target.classList.add('critic-flash');
          setTimeout(() => target.classList.remove('critic-flash'), 1200);
        }
      } catch { /* position may be gone; harmless */ }
    },

    scrollToItem(item) {
      try {
        const dom = editor.view.nodeDOM(item.pos);
        if (dom && dom.scrollIntoView) {
          dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
          dom.classList.add('critic-flash');
          setTimeout(() => dom.classList.remove('critic-flash'), 1200);
        }
      } catch { /* node may have moved; harmless */ }
    },

    itemAtEventTarget(items, target) {
      return items.find((i) => {
        try {
          const dom = editor.view.nodeDOM(i.pos);
          return dom === target || (dom && dom.contains && dom.contains(target));
        } catch { return false; }
      }) || null;
    },

    onDocChange(cb) {
      changeHandler = cb;
      editor.on('transaction', onTransaction);
      return () => {
        changeHandler = null;
        editor.off('transaction', onTransaction);
      };
    },
  };
}
