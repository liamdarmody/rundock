// Marks wikilinks in the note body whose target matches no file, so they show
// as missing (muted and dashed) the way the properties panel shows them, and
// say on hover what a click does. A decoration: it changes how a link looks,
// never the document or what is saved.
//
// The host's resolver walks the whole file tree, so each target is asked
// once for the life of the editor and remembered; the document is walked
// again only when it changes.

import { Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

export const missingLinksKey = new PluginKey('rundockMissingLinks');

export function createMissingLinksPlugin(resolve, creatable) {
  const title = creatable ? 'Does not exist yet. Click to create it' : 'No matching file in this workspace';
  const known = new Map();
  const missing = (target) => {
    if (!known.has(target)) known.set(target, !resolve(target));
    return known.get(target);
  };
  const decorate = (doc) => {
    const marks = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'wikilink' && missing(node.attrs.target)) {
        marks.push(Decoration.node(pos, pos + node.nodeSize, { class: 'dead', title }));
      }
    });
    return DecorationSet.create(doc, marks);
  };
  return new Plugin({
    key: missingLinksKey,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
    },
    props: { decorations: (state) => missingLinksKey.getState(state) },
  });
}
