// Image: inline atom for a standard markdown image ![alt](src "title").
//
// Without an image node in the schema, markdown-it parses the image token but
// ProseMirror drops it, so a note's image is silently lost on save (OFM parity
// corpus: links-and-images). This node carries alt/src/title through the
// pipeline and serialises back to the exact ![alt](src) form, so an image
// round-trips byte-for-byte. tiptap-markdown renders the markdown-it image
// token to <img>, which parseHTML below maps to this node.

import { Node, mergeAttributes } from '../../vendor/tiptap-bundle.mjs';

function imageMarkdown(node) {
  const alt = node.attrs.alt || '';
  const src = node.attrs.src || '';
  const title = node.attrs.title ? ` "${node.attrs.title}"` : '';
  return `![${alt}](${src}${title})`;
}

export const Image = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{
      tag: 'img[src]',
      getAttrs: (el) => (el instanceof HTMLElement ? {
        src: el.getAttribute('src'),
        alt: el.getAttribute('alt'),
        title: el.getAttribute('title'),
      } : false),
    }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)];
  },

  renderText({ node }) {
    return imageMarkdown(node);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) { state.write(imageMarkdown(node)); },
      },
    };
  },
});
