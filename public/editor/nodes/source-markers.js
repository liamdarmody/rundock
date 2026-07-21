// Source-marker preservation for the markdown serializer.
//
// The editor round-trips a file by parsing it into ProseMirror and serializing
// it back. ProseMirror's document model does not record which source marker a
// construct used, so tiptap-markdown's default serializer normalises them:
// `_italic_` becomes `*italic*`, `+ bullet` becomes `- bullet`, `***` becomes
// `---`. Autosave writes the serialized body, so every such note was silently
// reformatted on the first save.
//
// The fix records the original marker as a node/mark attribute at parse time
// and emits it at serialize time. markdown-it exposes the marker on each token
// (`token.markup`); a single core rule copies it onto a `data-src-marker`
// attribute that survives markdown-it's default HTML renderer, and each
// extension below reads it back through addAttributes. New content created in
// the editor carries no marker attribute and serializes with the conventional
// default (`*`, `**`, `-`, `---`), matching prior behaviour.

import { BulletList, HorizontalRule, TaskList, Text } from '../../vendor/tiptap-bundle.mjs';

// Emphasis and strong markers are deliberately NOT preserved here. Doing it
// through the mark serializer required function-valued open/close delimiters,
// and tiptap-markdown's inline-trim path treats the delimiter as a string and
// reads its length from the function arity, which silently deleted a
// single-character emphasis span flanked by other text (`a _b_ c` -> `a c`).
// The em/strong marks therefore use tiptap-markdown's default string
// serializers (a `_`/`__` source normalises to `*`/`**` on save, a cosmetic
// change that never loses content). Bullet, thematic-break, and task-list
// markers are node-level and do not go through that path, so they are safe to
// preserve below.
const SRC_ATTR = 'data-src-marker';
const TOKEN_TYPES = new Set(['bullet_list_open', 'hr']);

// Registers a markdown-it core rule (once per instance) that stamps each
// marker-bearing token with its source marker. The default renderer emits
// token attributes, so the marker reaches the parsed HTML unchanged.
function installMarkerRule(md) {
  if (!md || !md.core || md.core.__rundockSrcMarker) return;
  md.core.__rundockSrcMarker = true;
  md.core.ruler.push('rundock_src_marker', (state) => {
    const walk = (tokens) => {
      for (const token of tokens) {
        if (TOKEN_TYPES.has(token.type) && token.markup) {
          token.attrSet(SRC_ATTR, token.markup);
        }
        if (token.children) walk(token.children);
      }
    };
    walk(state.tokens);
  });
}

// A non-rendered attribute that carries the source marker from parsed HTML into
// the ProseMirror node/mark and never leaks back into the editor DOM.
function markerAttribute() {
  return {
    default: null,
    parseHTML: (element) => element.getAttribute(SRC_ATTR) || null,
    renderHTML: () => ({}),
  };
}

const setupParse = { setup(md) { installMarkerRule(md); } };

// tiptap-markdown mirrors prosemirror-markdown's Text serializer, which escapes
// `<` and `>` to HTML entities before writing. That silently rewrote inline and
// block HTML in a note (`<sup>` -> `&lt;sup&gt;`) on save. A ProseMirror text
// node is inert (always rendered as text, never parsed as HTML), so the angle
// brackets are safe to write literally; with the markdown extension's
// html:false they re-parse as text, so the note round-trips byte-for-byte.

// A text node needs its square brackets escaped only when the text could form a
// markdown link, image, or reference on re-parse. Those all contain `](`
// (inline link/image) or `][` (reference link). Prose like "see item [3]" or
// "arr[i]" contains neither, so its brackets are left literal instead of being
// backslash-escaped on every save. When a real link exists in the source it is
// a Link mark, not text, so a text node only ever holds brackets markdown-it
// declined to linkify; re-emitting them unescaped keeps that same reading.
function textCanFormLink(text) {
  return text.includes('](') || text.includes('][');
}

// Text: same as tiptap-markdown's default, except square brackets are only
// escaped when the text could form a link on re-parse (see textCanFormLink).
// This stops "[3]"-style prose from collecting backslashes on every save while
// never leaving a real link-forming sequence unescaped.
export const SourceText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const value = node.text;
          if (textCanFormLink(node.text)) {
            state.text(value);
            return;
          }
          const originalEsc = state.esc;
          // Reuse the serializer's own escaping, then drop the bracket escapes
          // it added. Only reached when the text cannot form a link, so this
          // never unescapes a link-forming sequence.
          state.esc = function patchedEsc(str, startOfLine) {
            return originalEsc.call(this, str, startOfLine).replace(/\\([[\]])/g, '$1');
          };
          try {
            state.text(value);
          } finally {
            state.esc = originalEsc;
          }
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});

// Bullet lists: `*`, `+`, or `-`. Preserve the source marker; new lists use the
// configured default (`-`). Continuation indent stays at two spaces, matching
// tiptap-markdown's default bullet serializer.
export const SourceBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), srcMarker: markerAttribute() };
  },
  addStorage() {
    const options = this.editor?.storage?.markdown?.options;
    return {
      markdown: {
        serialize(state, node) {
          const fallback = (options && options.bulletListMarker) || '-';
          const marker = node.attrs.srcMarker || fallback;
          return state.renderList(node, '  ', () => marker + ' ');
        },
        parse: setupParse,
      },
    };
  },
});

// Task lists: tiptap-markdown's tight-list attribute is only wired to
// bulletList/orderedList, so task lists always serialized loose (a blank line
// injected between items). Give taskList the same `tight` attribute so a tight
// source checklist stays tight on save. Detection mirrors tiptap-markdown: a
// list item wrapped in a paragraph is loose, otherwise tight.
export const SourceTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: (element) =>
          element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
        renderHTML: (attributes) => ({
          class: attributes.tight ? 'tight' : null,
          'data-tight': attributes.tight ? 'true' : null,
        }),
      },
    };
  },
});

// Thematic breaks: `***`, `___`, `---`, etc. The default serializer already
// honours node.attrs.markup; this only adds the source-marker attribute and
// the parse rule so the marker is captured and re-emitted.
export const SourceHorizontalRule = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), markup: markerAttribute() };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(node.attrs.markup || '---');
          state.closeBlock(node);
        },
        parse: setupParse,
      },
    };
  },
});
