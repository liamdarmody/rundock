// Embeds in the editor: a line of `![[file]]` embeds shows each file where
// it sits, side by side, rendered by whatever claims it.
//
// A WIDGET DECORATION, for the reason regions.js gives: decorations never
// become document content, so nothing here can change what is written back.
// The line stays in the document exactly as written; while the caret is on
// it (and the editor has focus) the source shows, and moving away brings the
// panels back.
//
// PROVISIONAL SURFACE. What a row is, how many sit side by side and what a
// panel shows are decided in public/embed-model.js; how a panel is mounted
// (read-only, one file per view) in views/files.js, reached here through
// window.rundockMountEmbeds so this file holds no rule of its own about
// either. With no mounter on the page (a test, or a page that has not
// loaded one) nothing is drawn and the line reads as it always did.

import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

const embedsPluginKey = new PluginKey('rundock-embeds');
// Each holder's own identity, carried in its widget's key, so a holder that
// was released is never the one the view keeps on screen.
let holderSeq = 0;

function embedModel() {
  return typeof window !== 'undefined' ? window.RundockEmbedModel : null;
}

// A paragraph's inline pieces in the model's shape, or null when it holds
// anything but text and wikilinks.
function piecesOf(node) {
  const pieces = [];
  let ok = true;
  node.forEach((child) => {
    if (!ok) return;
    if (child.isText) pieces.push({ text: child.text });
    else if (child.type.name === 'wikilink') pieces.push({ target: child.attrs.target, alias: child.attrs.alias });
    else ok = false;
  });
  return ok ? pieces : null;
}

function buildHolder() {
  const holder = document.createElement('div');
  holder.className = 'embed-holder';
  holder.contentEditable = 'false';
  return holder;
}

function buildDecorations(doc, selection, holders, editor) {
  const model = embedModel();
  const mount = typeof window !== 'undefined' ? window.rundockMountEmbeds : null;
  const decorations = [];
  if (!model || typeof mount !== 'function') return DecorationSet.create(doc, decorations);
  const focused = !!(editor && editor.isFocused);
  const seen = new Set();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    const pieces = piecesOf(node);
    const embeds = pieces && model.embedsIn(pieces);
    if (!embeds) return false;
    const editing = focused && selection && selection.from >= pos && selection.to <= pos + node.nodeSize;
    const signature = JSON.stringify(embeds);
    let entry = holders.get(pos);
    if (!entry) { entry = { holder: buildHolder(), signature: null, id: ++holderSeq }; holders.set(pos, entry); }
    seen.add(pos);
    if (entry.signature !== signature) {
      entry.signature = signature;
      const owner = typeof currentFilePath === 'string' ? currentFilePath : null; // eslint-disable-line no-undef
      try { mount(entry.holder, embeds, owner); } catch (e) { /* a panel that cannot mount degrades inside the mounter */ }
    }
    if (!editing) {
      decorations.push(Decoration.widget(pos + node.nodeSize, () => entry.holder, {
        side: 1, ignoreSelection: true, stopEvent: () => true,
        key: `embed-${entry.id}`,
      }));
    }
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      class: editing ? 'embed-source-open' : 'embed-source-hidden',
    }));
    return false;
  });
  // A line that stopped being an embed row releases what it mounted.
  for (const [pos, entry] of [...holders]) {
    if (seen.has(pos)) continue;
    if (entry.holder && typeof entry.holder.rundockRelease === 'function') entry.holder.rundockRelease();
    holders.delete(pos);
  }
  return DecorationSet.create(doc, decorations);
}

function embedsPlugin(editor) {
  const holders = new Map();
  // Released when the EDITOR goes, not when a plugin view does: an editor
  // rebuilds its plugin views on a reconfigure while the same holders stay on
  // screen, and releasing them then left panels whose views had been ended.
  const releaseAll = () => {
    for (const entry of holders.values()) {
      if (entry.holder && typeof entry.holder.rundockRelease === 'function') entry.holder.rundockRelease();
    }
    holders.clear();
  };
  if (editor && typeof editor.on === 'function') editor.on('destroy', releaseAll);
  return new Plugin({
    key: embedsPluginKey,
    state: {
      init(_, { doc, selection }) { return buildDecorations(doc, selection, holders, editor); },
      apply(tr, old, oldState, newState) {
        const refocused = tr.getMeta(embedsPluginKey) === 'focus-changed';
        if (!refocused && !tr.docChanged && tr.selection.eq(oldState.selection)) return old;
        if (tr.docChanged) {
          const moved = new Map();
          for (const [pos, entry] of holders) moved.set(tr.mapping.map(pos), entry);
          holders.clear();
          for (const [pos, entry] of moved) holders.set(pos, entry);
        }
        return buildDecorations(newState.doc, newState.selection, holders, editor);
      },
    },
    props: {
      decorations(state) { return this.getState(state); },
    },
    view(view) {
      const refresh = () => {
        try { view.dispatch(view.state.tr.setMeta(embedsPluginKey, 'focus-changed')); } catch (e) { /* view is going */ }
      };
      if (editor && typeof editor.on === 'function') { editor.on('focus', refresh); editor.on('blur', refresh); }
      return {
        destroy() {
          if (editor && typeof editor.off === 'function') { editor.off('focus', refresh); editor.off('blur', refresh); }
        },
      };
    },
  });
}

const EmbedsExtension = Extension.create({
  name: 'rundockEmbeds',
  addProseMirrorPlugins() { return [embedsPlugin(this.editor)]; },
});

export { embedsPluginKey, piecesOf, buildDecorations, embedsPlugin, EmbedsExtension };
