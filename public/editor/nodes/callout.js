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

const CALLOUT_HEAD_RE = /^> \[!([a-zA-Z]+)\]([+-]?)[ \t]*([^\n]*)$/;

// markdown-it block rule. Matches `> [!type] title` (with Obsidian's
// optional +/- fold marker) on the start line, then consumes contiguous
// `> body` lines (including bare `>` as blank body lines). Inserts before
// the built-in blockquote rule.
function calloutTokenize(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const firstLine = state.src.slice(startPos, startMax);
  const headMatch = firstLine.match(CALLOUT_HEAD_RE);
  if (!headMatch) return false;
  if (silent) return true;

  const type  = headMatch[1].toLowerCase();
  const fold  = headMatch[2] || '';
  const title = (headMatch[3] || '').trim();

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
  token.attrSet('fold', fold);
  token.attrSet('title', title);
  token.attrSet('body', body);
  // The exact source head line: serialization re-emits it verbatim, so
  // spacing and the fold marker survive byte-for-byte (title/fold attrs are
  // for rendering only).
  token.attrSet('head', firstLine);
  token.map = [startLine, nextLine];
  token.markup = '> [!type]';
  state.line = nextLine;
  return true;
}

function calloutRender(tokens, idx) {
  const token = tokens[idx];
  const type  = token.attrGet('type')  || 'note';
  const fold  = token.attrGet('fold')  || '';
  const title = token.attrGet('title') || '';
  const body  = token.attrGet('body')  || '';
  const head  = token.attrGet('head')  || '';
  const titleAttr = title ? ` data-callout-title="${escapeHtmlAttr(title)}"` : '';
  const foldAttr  = fold  ? ` data-callout-fold="${escapeHtmlAttr(fold)}"` : '';
  const bodyAttr  = body  ? ` data-callout-body="${encodeURIComponent(body)}"` : '';
  const headAttr  = head  ? ` data-callout-head="${encodeURIComponent(head)}"` : '';
  // The Tiptap Callout node owns the visible rendering (header + body line
  // children) via renderHTML. The bare div here exists so the parseHTML rule
  // on the Tiptap node can match the attributes and reconstruct the node.
  return `<div class="callout" data-callout-type="${escapeHtmlAttr(type)}"${foldAttr}${titleAttr}${bodyAttr}${headAttr}></div>\n`;
}

export function registerCalloutMarkdownIt(md) {
  md.block.ruler.before('blockquote', 'callout', calloutTokenize, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.callout = calloutRender;
}

// Parse a callout BODY (marker already stripped once) into renderable
// segments: plain lines, and nested callouts (`> [!type]...` runs). One
// pass, recursion handles deeper nesting.
export function parseCalloutBody(body) {
  const lines = body.split('\n');
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(CALLOUT_HEAD_RE);
    if (m) {
      const inner = [];
      let j = i + 1;
      while (j < lines.length && lines[j].charCodeAt(0) === 0x3E /* > */) {
        let bodyLine = lines[j].slice(1);
        const c = bodyLine.charCodeAt(0);
        if (c === 0x20 || c === 0x09) bodyLine = bodyLine.slice(1);
        inner.push(bodyLine);
        j += 1;
      }
      segments.push({ kind: 'callout', type: m[1].toLowerCase(), fold: m[2] || '', title: (m[3] || '').trim(), body: inner.join('\n') });
      i = j;
    } else {
      segments.push({ kind: 'line', text: lines[i] });
      i += 1;
    }
  }
  return segments;
}

// Tiptap renderHTML spec for a callout's visible children. Foldable
// callouts ('+' open, '-' closed) render as native <details>/<summary>, so
// expand/collapse works with no script; plain callouts render as divs.
// Nested callouts in the body render as real nested boxes, never literal
// `> [!type]` text.
function calloutChildrenSpec({ type, fold, title, body }) {
  const headerChildren = [['span', { class: 'callout-tag' }, type]];
  if (title) headerChildren.push(['span', { class: 'callout-title' }, title]);

  const bodyChildren = [];
  for (const seg of parseCalloutBody(body)) {
    if (seg.kind === 'callout') {
      bodyChildren.push([
        'div',
        { class: `callout callout-${seg.type} callout-nested` },
        ...calloutChildrenSpec(seg),
      ]);
    } else if (seg.text.length === 0) {
      bodyChildren.push(['div', { class: 'callout-line empty' }, ' ']);
    } else {
      bodyChildren.push(['div', { class: 'callout-line' }, seg.text]);
    }
  }
  const hasBody = body.length > 0;

  if (fold) {
    const details = ['details', { class: 'callout-fold' }];
    if (fold === '+') details[1].open = 'open';
    details.push(['summary', { class: 'callout-header' }, ...headerChildren]);
    if (hasBody) details.push(['div', { class: 'callout-body' }, ...bodyChildren]);
    return [details];
  }
  const children = [['div', { class: 'callout-header' }, ...headerChildren]];
  if (hasBody) children.push(['div', { class: 'callout-body' }, ...bodyChildren]);
  return children;
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
      fold:  { default: '' },
      title: { default: '' },
      body:  { default: '' },
      head:  { default: '' },
    };
  },

  parseHTML() {
    return [{
      tag: 'div.callout',
      priority: 1000,
      getAttrs: (el) => {
        if (!(el instanceof HTMLElement) || !el.classList.contains('callout')) return false;
        const decode = (name) => {
          const raw = el.getAttribute(name) || '';
          try { return decodeURIComponent(raw); } catch { return raw; }
        };
        return {
          type:  el.getAttribute('data-callout-type')  || 'note',
          fold:  el.getAttribute('data-callout-fold')  || '',
          title: el.getAttribute('data-callout-title') || '',
          body:  decode('data-callout-body'),
          head:  decode('data-callout-head'),
        };
      },
    }];
  },

  renderHTML({ node }) {
    const type  = node.attrs.type || 'note';
    const fold  = node.attrs.fold || '';
    const title = node.attrs.title || '';
    const body  = node.attrs.body  || '';
    const head  = node.attrs.head  || '';
    return [
      'div',
      {
        class: `callout callout-${type}`,
        'data-callout-type':  type,
        'data-callout-fold':  fold,
        'data-callout-title': title,
        'data-callout-body':  encodeURIComponent(body),
        'data-callout-head':  encodeURIComponent(head),
      },
      ...calloutChildrenSpec({ type, fold, title, body }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const type  = node.attrs.type || 'note';
          const fold  = node.attrs.fold || '';
          const title = node.attrs.title || '';
          const body  = node.attrs.body  || '';
          // The captured source head line re-emits verbatim (exact spacing,
          // fold marker). Reconstruction is the fallback for nodes created
          // in-editor with no source line.
          const titlePart = title ? ` ${title}` : '';
          const headLine = node.attrs.head || `> [!${type}]${fold}${titlePart}`;
          const lines = [headLine, ...(body ? body.split('\n').map(l => l.length ? `> ${l}` : '>') : [])];
          for (let i = 0; i < lines.length; i++) {
            state.write(lines[i]);
            // No newline after the last line: closeBlock owns the separation
            // (a manual trailing newline compounds by one byte per save when
            // the callout is the document's final block; table.js precedent).
            if (i < lines.length - 1) state.ensureNewLine();
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
