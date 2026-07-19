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

// Strip a body line's `>` marker. One leading space/tab after `>` is the
// conventional separator and is removed, but ONLY when body content follows.
// A whitespace-only line (`>`, `> `, `>\t`) keeps its exact bytes so a blank
// line with a trailing space round-trips instead of collapsing to a bare `>`.
function stripBodyMarker(lineText) {
  let s = lineText.slice(1);
  if (/\S/.test(s)) {
    const c = s.charCodeAt(0);
    if (c === 0x20 || c === 0x09) s = s.slice(1);
  }
  return s;
}

// Re-emit a stored body line with its `>` marker. Content lines get the
// conventional `> ` separator; whitespace-only lines get a bare `>` prefix so
// their own bytes (empty, one space, a tab) are what follows the marker. This
// is the exact inverse of stripBodyMarker.
function bodyLineToRaw(line) {
  return /\S/.test(line) ? `> ${line}` : `>${line}`;
}

// Convert a ProseMirror-style render spec (['tag', {attrs}, ...children]) into
// real DOM. Used by the node view to build the same visible callout that
// renderHTML describes, so display and editing share one structure.
function specToDom(doc, spec) {
  if (typeof spec === 'string') return doc.createTextNode(spec);
  const [tag, attrs, ...children] = spec;
  const el = doc.createElement(tag);
  let rest = children;
  if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  } else if (attrs != null) {
    rest = [attrs, ...children];
  }
  for (const child of rest) if (child != null) el.appendChild(specToDom(doc, child));
  return el;
}

const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
  + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

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
    bodyLines.push(stripBodyMarker(lineText));
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

// Reconstruct a callout's raw markdown (the `> [!type] title` head line plus
// `> `-prefixed body lines) from its attributes. The captured source head line
// re-emits verbatim so an untouched callout round-trips byte-for-byte; the
// reconstruction is the fallback for callouts created in-editor. This is the
// text shown when a callout is edited in place, and the serializer's line
// source, so the two never diverge.
export function calloutAttrsToRaw({ type = 'note', fold = '', title = '', body = '', head = '' }) {
  const titlePart = title ? ` ${title}` : '';
  const headLine = head || `> [!${type}]${fold}${titlePart}`;
  const bodyLines = body ? body.split('\n').map(bodyLineToRaw) : [];
  return [headLine, ...bodyLines].join('\n');
}

// The callout-shaping attributes, compared for equality. Used to skip a no-op
// commit (an edit that opened and closed without changing anything), which
// would otherwise add an undo step and mark the document dirty.
export function calloutAttrsEqual(a, b) {
  if (!a || !b) return false;
  return ['type', 'fold', 'title', 'body', 'head'].every((k) => (a[k] || '') === (b[k] || ''));
}

// Parse edited raw callout markdown back into attributes. Returns null when the
// first line is not a valid callout head (an invalid edit is rejected, leaving
// the callout unchanged). The edited head line is captured verbatim so it
// re-emits exactly. Body lines missing their `>` marker are still accepted as
// body text, so editing stays forgiving.
export function rawToCalloutAttrs(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const head = lines[0] || '';
  const m = head.match(CALLOUT_HEAD_RE);
  if (!m) return null;
  const bodyLines = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    bodyLines.push(line.charCodeAt(0) === 0x3E /* > */ ? stripBodyMarker(line) : line);
  }
  return {
    type: m[1].toLowerCase(),
    fold: m[2] || '',
    title: (m[3] || '').trim(),
    body: bodyLines.join('\n'),
    head,
  };
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
        inner.push(stripBodyMarker(lines[j]));
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
    } else if (seg.text.trim().length === 0) {
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

  // In-place editing: the callout renders as its admonition box, with a small
  // edit control in the header. Clicking it swaps the box for a textarea of the
  // callout's raw markdown (head + `> ` body). On commit the raw is parsed back
  // to attributes and the node is updated, keeping the byte-exact round-trip;
  // an invalid head is refused and the callout is left unchanged.
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      let editing = false;
      const dom = document.createElement('div');

      function paint() {
        const { type = 'note', fold = '', title = '', body = '' } = current.attrs;
        dom.className = `callout callout-${type} callout-editable`;
        dom.setAttribute('data-callout-type', type);
        dom.innerHTML = '';
        for (const spec of calloutChildrenSpec({ type, fold, title, body })) {
          dom.appendChild(specToDom(document, spec));
        }
        const header = dom.querySelector('.callout-header');
        if (header) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'callout-edit-btn';
          btn.title = 'Edit callout';
          btn.setAttribute('contenteditable', 'false');
          btn.innerHTML = PENCIL_SVG;
          // mousedown, not click: pre-empt ProseMirror's selection and the
          // native <details> summary toggle before either acts.
          btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openEditor(); });
          header.appendChild(btn);
        }
      }

      function openEditor() {
        if (editing) return;
        editing = true;
        // Keep the type class: the textarea border uses its --callout-color.
        dom.className = `callout callout-${current.attrs.type || 'note'} callout-editable callout-editing`;
        dom.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.className = 'callout-edit';
        ta.value = calloutAttrsToRaw(current.attrs);
        dom.appendChild(ta);
        const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
        ta.addEventListener('input', grow);
        requestAnimationFrame(() => { grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
        let done = false;
        const finish = (save) => {
          if (done) return;
          done = true;
          editing = false;
          if (save) {
            const attrs = rawToCalloutAttrs(ta.value);
            const pos = typeof getPos === 'function' ? getPos() : null;
            // Only dispatch when the parse succeeded AND the attributes actually
            // changed. A no-op commit (opened and blurred without an edit) would
            // otherwise add an undo step and mark the document dirty, triggering
            // a needless save and refresh.
            if (attrs && typeof pos === 'number' && !calloutAttrsEqual(attrs, current.attrs)) {
              editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, attrs));
            }
          }
          paint(); // repaint from current (updated by update() if the edit committed)
        };
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        ta.addEventListener('blur', () => finish(true));
      }

      paint();

      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          if (!editing) paint();
          return true;
        },
        stopEvent: () => editing, // while editing, the textarea owns its events
        ignoreMutation: () => true,
        selectNode() { dom.classList.add('ProseMirror-selectednode'); },
        deselectNode() { dom.classList.remove('ProseMirror-selectednode'); },
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          // The captured source head line re-emits verbatim (exact spacing,
          // fold marker); reconstruction is the fallback for nodes created
          // in-editor. Shared with in-place editing so the two never diverge.
          const lines = calloutAttrsToRaw(node.attrs).split('\n');
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
