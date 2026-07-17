// Math: verbatim-preserving atoms for Obsidian's $inline$ and $$block$$
// maths. The OFM parity corpus found LaTeX backslashes DOUBLING through the
// serializer's escaping on every save (the compounding class of corruption:
// \pi -> \\pi -> \\\\pi). These atoms carry the exact source bytes through
// ProseMirror untouched, the same pattern as wikilinks and CriticMarkup
// constructs.
//
// Rendering is deliberately literal (the source in a styled span/block):
// math TYPESETTING is a separate, carded feature; byte-safety is not.

import { Node } from '../../vendor/tiptap-bundle.mjs';

// ---------- markdown-it rules ----------

// Inline $...$: opener not followed by whitespace, closer not preceded by
// whitespace, single line, nonempty (Obsidian's effective rules; a bare
// currency "$5 and $6" does not match because " and " ends with a space
// before the closing $... it would match "$5 and $6" only when both edges
// are non-space, which "5 and 6" satisfies: acceptable, Obsidian treats it
// the same way).
function mathInlineTokenize(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
  if (src.charCodeAt(start + 1) === 0x24) return false; // $$ is block territory
  const after = src.charCodeAt(start + 1);
  if (after === 0x20 || after === 0x09 || Number.isNaN(after)) return false;
  let end = -1;
  for (let i = start + 1; i < state.posMax; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x0A) return false; // single line only
    if (c === 0x24) { end = i; break; }
  }
  if (end === -1 || end === start + 1) return false;
  const before = src.charCodeAt(end - 1);
  if (before === 0x20 || before === 0x09) return false;
  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.attrSet('src', src.slice(start + 1, end));
    token.markup = '$';
  }
  state.pos = end + 1;
  return true;
}

// Block $$...$$: a line starting with $$ (optionally closing on the same
// line), else consuming lines until one ENDS with $$. The whole span,
// delimiters included, is preserved verbatim.
function mathBlockTokenize(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const firstLine = state.src.slice(startPos, startMax);
  if (!firstLine.startsWith('$$')) return false;
  let lastLine = startLine;
  if (!(firstLine.length > 2 && firstLine.endsWith('$$'))) {
    let found = false;
    for (let l = startLine + 1; l < endLine; l++) {
      const text = state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
      if (text.endsWith('$$')) { lastLine = l; found = true; break; }
    }
    if (!found) return false;
  }
  if (silent) return true;
  const lines = [];
  for (let l = startLine; l <= lastLine; l++) {
    lines.push(state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]));
  }
  const token = state.push('math_block', '', 0);
  token.block = true;
  token.attrSet('src', lines.join('\n'));
  token.map = [startLine, lastLine + 1];
  token.markup = '$$';
  state.line = lastLine + 1;
  return true;
}

function mathInlineRender(tokens, idx) {
  const src = tokens[idx].attrGet('src') || '';
  return `<span class="math-inline" data-math-src="${encodeURIComponent(src)}"></span>`;
}

function mathBlockRender(tokens, idx) {
  const src = tokens[idx].attrGet('src') || '';
  return `<div class="math-block" data-math-src="${encodeURIComponent(src)}"></div>\n`;
}

export function registerMathMarkdownIt(md) {
  md.inline.ruler.after('emphasis', 'math_inline', mathInlineTokenize);
  md.block.ruler.before('paragraph', 'math_block', mathBlockTokenize, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.math_inline = mathInlineRender;
  md.renderer.rules.math_block = mathBlockRender;
}

function decodeAttr(el, name) {
  const raw = el.getAttribute(name) || '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { src: { default: '' } };
  },

  parseHTML() {
    return [{
      tag: 'span.math-inline',
      priority: 1000,
      getAttrs: (el) => (el instanceof HTMLElement && el.classList.contains('math-inline'))
        ? { src: decodeAttr(el, 'data-math-src') } : false,
    }];
  },

  renderHTML({ node }) {
    return ['span', {
      class: 'math-inline',
      'data-math-src': encodeURIComponent(node.attrs.src),
    }, `$${node.attrs.src}$`];
  },

  renderText({ node }) {
    return `$${node.attrs.src}$`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$${node.attrs.src}$`);
        },
        parse: { setup(markdownit) { registerMathMarkdownIt(markdownit); } },
      },
    };
  },
});

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return { src: { default: '' } };
  },

  parseHTML() {
    return [{
      tag: 'div.math-block',
      priority: 1000,
      getAttrs: (el) => (el instanceof HTMLElement && el.classList.contains('math-block'))
        ? { src: decodeAttr(el, 'data-math-src') } : false,
    }];
  },

  renderHTML({ node }) {
    return ['div', {
      class: 'math-block',
      'data-math-src': encodeURIComponent(node.attrs.src),
    }, node.attrs.src];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const lines = String(node.attrs.src).split('\n');
          for (let i = 0; i < lines.length; i++) {
            state.write(lines[i]);
            if (i < lines.length - 1) state.ensureNewLine();
          }
          state.closeBlock(node);
        },
        // registerMathMarkdownIt already ran via MathInline's setup; running
        // it twice would double-register the rules.
        parse: {},
      },
    };
  },
});

export const mathExtensions = [MathInline, MathBlock];
