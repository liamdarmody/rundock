// Artifact review: sidecar-backed comments on the sandboxed HTML preview.
// Wires the file-type-agnostic review panel (public/editor/panels/review.js)
// to a sidecar controller over the artifact iframe: selection inside the
// frame is read by the host (the frame carries allow-same-origin and NO
// allow-scripts, so the document cannot run code but the host can read it),
// anchored comments render as <mark> wraps in the frame (render-only; the
// artifact file on disk is never touched), and every mutation persists to
// .rundock/reviews/ through the host's save callback.

import { attachReviewPanel } from '../editor/panels/review.js';
import { injectEditorStyles } from '../editor/styles.js';
import { buildTextIndex, captureSelector, rangeToOffsets, locateSelector } from './text-anchor.js';
import { createSidecarController } from './sidecar-controller.js';

export { sidecarPathFor } from './sidecar-controller.js';

const MARK_ATTR = 'data-rundock-review';

// Geometry-neutral by construction: decoration only (background/outline),
// never padding, margins, borders, or line-height on the wrapper. Padding
// would shift text within lines AND give wrapped inter-block whitespace
// nodes a full line box (an inline with non-zero padding stops an empty
// line box collapsing to zero height), visibly inflating paragraph gaps.
const FRAME_STYLES = `
  mark.rundock-review-mark { background: rgba(232, 122, 90, 0.28); color: inherit; border-radius: 2px; cursor: pointer; }
  mark.rundock-review-mark.rundock-flash { outline: 2px solid rgba(232, 122, 90, 0.85); }
  ::highlight(rundock-composing) { background: rgba(232, 122, 90, 0.35); }
`;

export function attachArtifactReview({
  iframe, paneElement, path, sidecarContent = null,
  author = 'me', agents = [], onSaveSidecar = null, pillHostElement = null,
  allowSave = true,
}) {
  const doc = iframe && iframe.contentDocument;
  if (!doc || !doc.body) return { detach: () => {}, refresh: () => {}, controller: null };
  const frameWin = doc.defaultView;
  const hostDoc = paneElement.ownerDocument;

  injectEditorStyles(); // panel styles in the host document

  const frameStyle = doc.createElement('style');
  frameStyle.textContent = FRAME_STYLES;
  doc.head.appendChild(frameStyle);

  // The text index over the frame's body. Rebuilt whenever mark wrapping
  // changes the text-node structure (the TEXT never changes; only nodes
  // split and merge), so offsets stay valid against the live DOM.
  let index = buildTextIndex(doc.body);
  const freshIndex = () => { index = buildTextIndex(doc.body); return index; };

  const controller = createSidecarController({
    path,
    content: sidecarContent,
    index,
    author,
    onChange: () => renderMarks(),
  });

  // Data-safety gate: a sidecar that parsed as corrupt, or that the host
  // could not read cleanly (allowSave false), must NEVER be written back:
  // saving would overwrite existing comments with a fresh/partial store.
  // Existing (parsed) comments still render; new mutations just don't persist.
  const saveEnabled = allowSave && !controller.wasCorrupt();

  // ----- marks (render-only wraps inside the frame) -----

  function clearMarks() {
    for (const m of Array.from(doc.querySelectorAll(`mark[${MARK_ATTR}]`))) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
  }

  // A text-node piece whose characters are all collapsible whitespace (the
  // formatting newlines/indentation between block elements) must never be
  // wrapped: the wrap would paint nothing yet plant an inline element
  // between blocks. Preserved whitespace (pre / pre-wrap / pre-line /
  // break-spaces) IS visible content and still gets its mark.
  function isCollapsibleWhitespacePiece(node, from, to) {
    if (/\S/.test(node.nodeValue.slice(from, to))) return false;
    const parent = node.parentElement;
    if (!parent) return true;
    const cs = frameWin.getComputedStyle(parent);
    const collapse = cs.whiteSpaceCollapse || cs.whiteSpace || 'normal';
    return collapse === 'collapse' || collapse === 'normal' || collapse === 'nowrap';
  }

  // Wrap [start, end) of the index in mark elements, one per intersected
  // text node. Tuples are collected first and applied in reverse so the
  // splits never invalidate positions still to be processed.
  function wrapOffsets(start, end, id) {
    const idx = freshIndex();
    const targets = [];
    for (const entry of idx.nodes) {
      const nodeEnd = entry.start + entry.node.nodeValue.length;
      const s = Math.max(start, entry.start);
      const e = Math.min(end, nodeEnd);
      if (s < e && !isCollapsibleWhitespacePiece(entry.node, s - entry.start, e - entry.start)) {
        targets.push({ node: entry.node, from: s - entry.start, to: e - entry.start });
      }
    }
    for (const t of targets.reverse()) {
      let piece = t.node;
      if (t.from > 0) piece = piece.splitText(t.from);
      if (t.to - t.from < piece.nodeValue.length) piece.splitText(t.to - t.from);
      const mark = doc.createElement('mark');
      mark.className = 'rundock-review-mark';
      mark.setAttribute(MARK_ATTR, id);
      piece.parentNode.insertBefore(mark, piece);
      mark.appendChild(piece);
    }
  }

  function renderMarks() {
    clearMarks();
    const data = controller.getData();
    const anchored = controller.listItems().filter((i) => i.anchor && !i.orphaned);
    // Descending by position: earlier offsets stay valid while later spans wrap.
    for (const item of anchored.sort((a, b) => b.pos - a.pos)) {
      const entry = data.comments[item.id];
      if (!entry) continue;
      const hit = locateSelector(freshIndex(), { quote: entry.quote, prefix: entry.prefix || '', suffix: entry.suffix || '' });
      if (hit) wrapOffsets(hit.start, hit.end, item.id);
    }
    freshIndex();
  }

  // ----- composing decoration (CSS Highlight API; decoration only) -----

  function setComposingHighlight(token) {
    if (!frameWin.CSS || !frameWin.CSS.highlights || typeof frameWin.Highlight !== 'function') return;
    if (!token) { frameWin.CSS.highlights.delete('rundock-composing'); return; }
    const idx = freshIndex();
    const targets = [];
    for (const entry of idx.nodes) {
      const nodeEnd = entry.start + entry.node.nodeValue.length;
      const s = Math.max(token.start, entry.start);
      const e = Math.min(token.end, nodeEnd);
      if (s < e) {
        const r = doc.createRange();
        r.setStart(entry.node, s - entry.start);
        r.setEnd(entry.node, e - entry.start);
        targets.push(r);
      }
    }
    if (targets.length) frameWin.CSS.highlights.set('rundock-composing', new frameWin.Highlight(...targets));
  }

  // ----- the surface contract -----

  let activateCardCb = null;
  let composingToken = null;

  const surface = {
    supportsSuggest: false, // artifacts are read-only: comment, agent applies
    editable: false,

    setup() {},
    teardown() {},

    captureSelection() {
      const sel = doc.getSelection && doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      return rangeToOffsets(freshIndex(), sel.getRangeAt(0));
    },

    setComposing(token) {
      composingToken = token || null;
      setComposingHighlight(composingToken);
    },

    liveComposingRange() {
      return composingToken; // the artifact document is static while open
    },

    quoteFor(token) {
      if (!token) return null;
      return index.text.slice(token.start, token.end);
    },

    // The sidecar controller consumes TextQuoteSelectors.
    selectorFor(token) {
      return token ? captureSelector(index, token.start, token.end) : null;
    },

    flashApplied() { /* cards depart visibly; the document does not change */ },

    scrollToItem(item) {
      const mark = doc.querySelector(`mark[${MARK_ATTR}="${item.id}"]`);
      if (!mark) return;
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      mark.classList.add('rundock-flash');
      setTimeout(() => mark.classList.remove('rundock-flash'), 1200);
    },

    itemAtEventTarget() { return null; }, // frame clicks route via onItemActivate below

    onItemActivate(cb) { activateCardCb = cb; },

    onDocChange() { return () => {}; }, // static document
  };

  // ----- panel -----

  const panel = attachReviewPanel({
    paneElement,
    surface,
    controller,
    author,
    agents,
    pillHostElement,
    onRequestSave: () => { if (saveEnabled && typeof onSaveSidecar === 'function') onSaveSidecar(controller.serialize()); },
  });

  // ----- in-frame interactions -----

  const onFrameClick = (event) => {
    const mark = event.target && event.target.closest && event.target.closest(`mark[${MARK_ATTR}]`);
    if (!mark || !activateCardCb) return;
    const item = controller.listItems().find((i) => i.id === mark.getAttribute(MARK_ATTR));
    if (item) activateCardCb(item);
  };
  doc.addEventListener('click', onFrameClick);

  // When saving is disabled (the sidecar could not be read cleanly or parsed
  // as corrupt), authoring is suppressed entirely and a read-only notice is
  // shown, so a user never leaves comments that would silently vanish. Any
  // comments that DID parse still render (read-only).
  if (!saveEnabled) {
    const notice = hostDoc.createElement('div');
    notice.className = 'artifact-review-readonly';
    notice.textContent = 'Review is read-only: this file’s saved comments could not be read safely, so new comments are disabled to avoid overwriting them.';
    paneElement.appendChild(notice);
    renderMarks();
    return {
      controller,
      refresh: () => { renderMarks(); panel.refresh(); },
      detach: () => {
        doc.removeEventListener('click', onFrameClick);
        notice.remove();
        clearMarks();
        panel.detach();
      },
    };
  }

  // Floating Comment button: host-positioned over the iframe, shown while a
  // selection exists in the frame. mousedown (not click) so the selection
  // survives the press.
  const commentBtn = hostDoc.createElement('button');
  commentBtn.type = 'button';
  commentBtn.className = 'artifact-comment-btn';
  commentBtn.textContent = 'Comment';
  paneElement.appendChild(commentBtn);

  function positionButton() {
    const sel = doc.getSelection && doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      commentBtn.classList.remove('visible');
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      commentBtn.classList.remove('visible');
      return;
    }
    const frameRect = iframe.getBoundingClientRect();
    const paneRect = paneElement.getBoundingClientRect();
    const top = frameRect.top - paneRect.top + rect.top - 34;
    const left = frameRect.left - paneRect.left + rect.left + rect.width / 2;
    commentBtn.style.top = `${Math.max(4, top)}px`;
    commentBtn.style.left = `${Math.max(4, left)}px`;
    commentBtn.classList.add('visible');
  }

  const onSelectionChange = () => positionButton();
  doc.addEventListener('selectionchange', onSelectionChange);
  frameWin.addEventListener('scroll', onSelectionChange, true);

  commentBtn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep the frame selection alive
    commentBtn.classList.remove('visible');
    panel.openComposer('comment');
  });

  renderMarks();

  return {
    controller,
    refresh: () => { renderMarks(); panel.refresh(); },
    detach: () => {
      doc.removeEventListener('click', onFrameClick);
      doc.removeEventListener('selectionchange', onSelectionChange);
      frameWin.removeEventListener('scroll', onSelectionChange, true);
      commentBtn.remove();
      clearMarks();
      panel.detach();
    },
  };
}
