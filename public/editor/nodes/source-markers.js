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

import { BulletList, HorizontalRule, StarterKit, TaskList, Text } from '../../vendor/tiptap-bundle.mjs';

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

// Records the indent used to nest a child list, so tab-indented nesting is not
// normalised to two spaces on save. For each list, finds the smallest indent
// deeper than the list's own items among the source lines in its range and
// stamps it as an attribute the bullet-list serializer reads back.
const LIST_INDENT_ATTR = 'data-list-indent';
const LIST_MARKER_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]/;
function installListIndentRule(md) {
  if (!md || !md.core || md.core.__rundockListIndent) return;
  md.core.__rundockListIndent = true;
  md.core.ruler.push('rundock_list_indent', (state) => {
    const lines = state.src.split('\n');
    for (const tok of state.tokens) {
      if ((tok.type !== 'bullet_list_open' && tok.type !== 'ordered_list_open') || !tok.map) continue;
      const [s, e] = tok.map;
      let own = null, nest = null;
      for (let i = s; i < e && i < lines.length; i++) {
        const m = lines[i].match(LIST_MARKER_RE);
        if (!m) continue;
        if (own === null) { own = m[1]; continue; }
        if (m[1].length > own.length && (nest === null || m[1].length < nest.length)) nest = m[1];
      }
      if (nest != null) tok.attrSet(LIST_INDENT_ATTR, nest);
    }
  });
}

// Records the fence a code block was written with: the marker character, how
// many of it, and the whole info string, none of which the ProseMirror node
// carries. Without them the serializer writes a fixed three-backtick fence and
// the language word, so a four-backtick fence comes back three backticks long.
// That is not cosmetic. A four-backtick fence exists because its content holds
// a three-backtick one, so shortening the marker means the NEXT read of the
// file closes the block at the inner fence and everything after it, including
// the rest of the document, falls out of the block.
const FENCE_ATTR = 'data-src-fence';
const FENCE_INFO_ATTR = 'data-src-fence-info';
function installFenceRule(md) {
  if (!md || !md.core || md.core.__rundockFenceMarker) return;
  md.core.__rundockFenceMarker = true;
  md.core.ruler.push('rundock_fence_marker', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'fence' || !token.markup) continue;
      token.attrSet(FENCE_ATTR, token.markup);
      // Only when there is one, so an absent attribute keeps meaning "this
      // block was made in the editor and has no source line to go back to".
      if (token.info) token.attrSet(FENCE_INFO_ATTR, token.info);
    }
  });
}

const setupParse = { setup(md) { installMarkerRule(md); installListIndentRule(md); installFenceRule(md); } };

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
    return {
      ...this.parent?.(),
      srcMarker: markerAttribute(),
      listIndent: {
        default: null,
        parseHTML: (element) => element.getAttribute(LIST_INDENT_ATTR),
        renderHTML: () => ({}),
      },
    };
  },
  addStorage() {
    const options = this.editor?.storage?.markdown?.options;
    return {
      markdown: {
        serialize(state, node) {
          const fallback = (options && options.bulletListMarker) || '-';
          const marker = node.attrs.srcMarker || fallback;
          const indent = node.attrs.listIndent || '  ';
          return state.renderList(node, indent, () => marker + ' ');
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

// A line closes a fence when it holds the marker character and nothing else,
// indented no more than three spaces. Anything else inside the block is
// content, however many markers it starts with.
const CLOSING_LINE = { '`': /^ {0,3}(`+)[ \t]*$/, '~': /^ {0,3}(~+)[ \t]*$/ };

// The fence to open and close a block with: the one the file used, widened
// when the block's own content would otherwise close it early. Widening is
// what makes a fence around another fence work, and it is the difference
// between a file that survives a save and one whose next read stops at its own
// example. A block made in the editor has no source fence and gets three
// backticks, which is what it got before.
function fenceFor(srcFence, text) {
  const marker = srcFence && srcFence[0] === '~' ? '~' : '`';
  let longestInside = 0;
  for (const line of String(text).split('\n')) {
    const hit = line.match(CLOSING_LINE[marker]);
    if (hit && hit[1].length > longestInside) longestInside = hit[1].length;
  }
  return marker.repeat(Math.max(3, srcFence ? srcFence.length : 3, longestInside + 1));
}

// The bundle re-exports the standalone extension packages the nodes in this
// file extend, and the code block package is not one of them. The class is
// inside the bundle all the same, as one of the nodes the starter kit
// assembles, so it is taken from there. Adding the export instead means
// rebuilding the vendor bundle, which resolves every dependency inside it
// again: a far larger change than carrying a fence marker.
function codeBlockFromStarterKit() {
  const assembled = StarterKit.config.addExtensions.call({ options: {} });
  const found = assembled.find((extension) => extension.name === 'codeBlock');
  if (!found) throw new Error('source-markers: the bundled starter kit has no code block node');
  return found;
}

// Code blocks: the fence marker, its length, and the info string. The
// serializer is a full replacement rather than an addition, so the trailing
// newline handling below has to be carried over with it (see the comment on
// updateDOM).
export const SourceCodeBlock = codeBlockFromStarterKit().extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      srcFence: {
        default: null,
        // The node's element is the `pre`; markdown-it puts the attributes on
        // the `code` inside it.
        parseHTML: (element) => element.firstElementChild?.getAttribute(FENCE_ATTR) || null,
        renderHTML: () => ({}),
      },
      srcInfo: {
        default: null,
        parseHTML: (element) => element.firstElementChild?.getAttribute(FENCE_INFO_ATTR) || null,
        renderHTML: () => ({}),
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const fence = fenceFor(node.attrs.srcFence, node.textContent);
          // The whole info string, not just the first word: a fence written
          // ```js title="x" keeps everything after the marker.
          const info = node.attrs.srcInfo != null ? node.attrs.srcInfo : (node.attrs.language || '');
          state.write(fence + info + '\n');
          // The second argument is the escape flag, and it is the whole of
          // what keeps a fenced block's contents literal. Turned on, the
          // serialiser runs the prose escaper over the block, so the
          // asterisks, backticks and brackets that are code inside a fence are
          // written to the file as a backslash before each one, and the rest of
          // the punctuation goes the same way. That is one of the two ways the
          // contents of a fenced block have been damaged on save.
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
        parse: {
          setup(md) { installMarkerRule(md); installListIndentRule(md); installFenceRule(md); },
          // markdown-it ends a fence's rendered content with a newline inside
          // the `code` element, and the code block's `preserveWhitespace: full`
          // would carry it into the node as an extra blank line on every open.
          // Repeated here because supplying a markdown spec replaces the
          // default one rather than extending it.
          updateDOM(element) {
            element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>');
          },
        },
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
