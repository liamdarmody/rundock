// Callout: atomic block node carrying Obsidian's > [!type] title / > body
// blocks. Body content is preserved verbatim as a node attribute so the
// round-trip reconstruction is byte-exact. Body is not user-editable in v1
// (sealed). Editable body content is tracked separately as a future spec.
//
// Recognised types render with type-coloured styling: note/info/abstract
// (blue), tip/success/todo (green), warning/question/example (amber),
// danger/failure/bug (red), quote (purple). Unknown types fall back to the
// default note style.
//
// Production-side markdown parsing is a markdown-it block rule rather than
// the prototype's regex pre-processor. The block rule runs before the
// built-in blockquote so > [!type] is captured as a callout, not as a
// blockquote with a [!type] text node inside.

import { Node } from '../../vendor/tiptap-bundle.mjs';

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const CALLOUT_HEAD_RE = /^> \[!([a-zA-Z]+)\][ \t]*([^\n]*)$/;

// markdown-it block rule. Matches `> [!type] title` on the start line,
// then consumes contiguous `> body` lines (including bare `>` as blank body
// lines). Inserts before the built-in blockquote rule.
function calloutTokenize(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const firstLine = state.src.slice(startPos, startMax);
  const headMatch = firstLine.match(CALLOUT_HEAD_RE);
  if (!headMatch) return false;
  if (silent) return true;

  const type  = headMatch[1].toLowerCase();
  const title = (headMatch[2] || '').trim();

  // Walk subsequent lines while they begin with '>'. Strip the leading
  // marker plus one optional space to recover the body line. A bare '>' is
  // treated as a blank body line.
  const bodyLines = [];
  let nextLine = startLine + 1;
  while (nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax   = state.eMarks[nextLine];
    const lineText  = state.src.slice(lineStart, lineMax);
    if (lineText.length === 0) break;
    if (lineText.charCodeAt(0) !== 0x3E /* > */) break;
    let bodyLine = lineText.slice(1);
    if (bodyLine.charCodeAt(0) === 0x20 /* space */ || bodyLine.charCodeAt(0) === 0x09 /* tab */) {
      bodyLine = bodyLine.slice(1);
    }
    bodyLines.push(bodyLine);
    nextLine += 1;
  }

  const body = bodyLines.join('\n');
  const token = state.push('callout', '', 0);
  token.block = true;
  token.attrSet('type', type);
  token.attrSet('title', title);
  token.attrSet('body', body);
  token.map = [startLine, nextLine];
  token.markup = '> [!type]';
  state.line = nextLine;
  return true;
}

function calloutRender(tokens, idx) {
  const token = tokens[idx];
  const type  = token.attrGet('type')  || 'note';
  const title = token.attrGet('title') || '';
  const body  = token.attrGet('body')  || '';
  const titleAttr = title ? ` data-callout-title="${escapeHtmlAttr(title)}"` : '';
  const bodyAttr  = body  ? ` data-callout-body="${encodeURIComponent(body)}"` : '';
  // The Tiptap Callout node owns the visible rendering (header + body line
  // children) via renderHTML. The bare div here exists so the parseHTML rule
  // on the Tiptap node can match the attributes and reconstruct the node.
  return `<div class="callout" data-callout-type="${escapeHtmlAttr(type)}"${titleAttr}${bodyAttr}></div>\n`;
}

export function registerCalloutMarkdownIt(md) {
  md.block.ruler.before('blockquote', 'callout', calloutTokenize, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.callout = calloutRender;
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,

  addAttributes() {
    return {
      type:  { default: 'note' },
      title: { default: '' },
      body:  { default: '' },
    };
  },

  parseHTML() {
    return [{
      tag: 'div.callout',
      priority: 1000,
      getAttrs: (el) => {
        if (!(el instanceof HTMLElement) || !el.classList.contains('callout')) return false;
        const rawBody = el.getAttribute('data-callout-body') || '';
        let body = '';
        try { body = decodeURIComponent(rawBody); } catch { body = rawBody; }
        return {
          type:  el.getAttribute('data-callout-type')  || 'note',
          title: el.getAttribute('data-callout-title') || '',
          body,
        };
      },
    }];
  },

  renderHTML({ node }) {
    const type  = node.attrs.type || 'note';
    const title = node.attrs.title || '';
    const body  = node.attrs.body  || '';

    const headerChildren = [['span', { class: 'callout-tag' }, type]];
    if (title) headerChildren.push(['span', { class: 'callout-title' }, title]);

    const bodyLineSpecs = body
      ? body.split('\n').map(line =>
          line.length === 0
            ? ['div', { class: 'callout-line empty' }, ' ']
            : ['div', { class: 'callout-line' }, line]
        )
      : null;

    const children = [['div', { class: 'callout-header' }, ...headerChildren]];
    if (bodyLineSpecs) children.push(['div', { class: 'callout-body' }, ...bodyLineSpecs]);

    return [
      'div',
      {
        class: `callout callout-${type}`,
        'data-callout-type':  type,
        'data-callout-title': title,
        'data-callout-body':  encodeURIComponent(body),
      },
      ...children,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const type  = node.attrs.type || 'note';
          const title = node.attrs.title || '';
          const body  = node.attrs.body  || '';
          const titlePart = title ? ` ${title}` : '';
          state.write(`> [!${type}]${titlePart}\n`);
          if (body) {
            const bodyLines = body.split('\n').map(l => l.length ? `> ${l}` : '>');
            for (const line of bodyLines) {
              state.write(line);
              state.write('\n');
            }
          }
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit) {
            registerCalloutMarkdownIt(markdownit);
          },
        },
      },
    };
  },
});
