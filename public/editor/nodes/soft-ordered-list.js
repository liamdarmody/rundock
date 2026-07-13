// SoftOrderedList: extends Tiptap's OrderedList with a markdown serialiser
// that writes unpadded item numbers.
//
// Why this exists: tiptap-markdown's ordered-list serialiser left-pads item
// numbers so multi-digit lists align (" 1." ... "10."). Obsidian and
// hand-written markdown use unpadded numbers, so any list with ten or more
// items picked up a leading space on every item on every round-trip. This
// override writes `1. ` unpadded; continuation indentation stays at the
// widest marker's width so nested content under double-digit items still
// parses correctly.
//
// Same pattern as SoftHardBreak: the factory disables StarterKit's built-in
// OrderedList via StarterKit.configure({ orderedList: false }) and registers
// this extension in its place.
//
// Known edge (accepted): lists written with the `1)` marker style serialize
// back as `1. `. tiptap-markdown had the same behaviour except for adjacent
// sibling lists, and the vault convention is `1. ` throughout.

import { OrderedList } from '../../vendor/tiptap-bundle.mjs';

export const SoftOrderedList = OrderedList.extend({
  name: 'orderedList',
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const start = node.attrs.start || 1;
          const maxW = String(start + node.childCount - 1).length;
          const space = state.repeat(' ', maxW + 2);
          state.renderList(node, space, (i) => String(start + i) + '. ');
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});
