// SoftHardBreak: extends Tiptap's HardBreak with a markdown serialiser that
// writes a plain `\n` instead of the GFM/CommonMark `  \n` or `\\\n` shapes.
//
// Why this exists: Markdown.configure({ breaks: true }) is required for
// Obsidian-flavoured line-break semantics (each \n in source becomes a
// hardBreak in the editor; without it, adjacent lines like "**Date:** ...\n
// **Status:** ..." would collapse into one visual line on round-trip).
// However, with breaks:true on parse, the default HardBreak serialiser
// continues to emit GFM hard-breaks on save, so every line picks up "  "
// (two trailing spaces) on every round-trip. Overriding the serialiser to
// write `\n` restores byte-for-byte fidelity.
//
// The factory disables StarterKit's built-in HardBreak via
// StarterKit.configure({ hardBreak: false }) and registers this extension in
// its place.

import { HardBreak } from '../../vendor/tiptap-bundle.mjs';

export const SoftHardBreak = HardBreak.extend({
  name: 'hardBreak',
  addStorage() {
    return {
      markdown: {
        serialize(state /*, node, parent, index */) {
          state.write('\n');
        },
      },
    };
  },
});
