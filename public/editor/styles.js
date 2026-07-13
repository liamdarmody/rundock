// Editor-module styles, injected at runtime. The base editor styles live in
// index.html's stylesheet; styles for editor features owned entirely by this
// module (tables, review mode) are injected here instead so the module stays
// self-contained and app-level files stay untouched. Injected once per page.

const STYLE_ID = 'rundock-editor-module-styles';

const CSS = `
/* --- Tables ------------------------------------------------------------ */
/* Tables cannot shrink below their cells' intrinsic width, so each one
   scrolls horizontally inside its own wrapper instead of overflowing the
   text column (or sliding under the review sidebar) on narrow panes. */
.tiptap-editor .ProseMirror .tableWrapper {
  overflow-x: auto;
  margin: 12px 0 16px;
  max-width: 100%;
}
.tiptap-editor .ProseMirror table {
  border-collapse: collapse;
  table-layout: auto;
  width: 100%;
  margin: 0;
  font-size: 13px;
}
.tiptap-editor .ProseMirror table th,
.tiptap-editor .ProseMirror table td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  vertical-align: top;
  text-align: left;
  min-width: 32px;
  position: relative;
}
.tiptap-editor .ProseMirror table th {
  background: var(--card);
  font-weight: 600;
}
.tiptap-editor .ProseMirror table p {
  margin: 0;
  line-height: 1.5;
}
.tiptap-editor .ProseMirror table .selectedCell::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--accent-glow, rgba(232, 122, 90, 0.12));
  pointer-events: none;
}
.tiptap-editor .ProseMirror table .column-resize-handle {
  position: absolute;
  right: -1px;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent, #E87A5A);
  pointer-events: none;
}
.tiptap-editor .ProseMirror.resize-cursor {
  cursor: col-resize;
}

/* --- Review: inline constructs ------------------------------------------ */
.tiptap-editor .critic {
  border-radius: 3px;
  padding: 0 2px;
}
.tiptap-editor .critic-insert {
  background: rgba(107, 198, 126, 0.16);
  color: var(--success);
  text-decoration: underline;
  text-decoration-color: rgba(107, 198, 126, 0.6);
}
.tiptap-editor .critic-delete {
  background: rgba(224, 108, 108, 0.14);
  color: var(--danger, #E06C6C);
  text-decoration: line-through;
}
.tiptap-editor .critic-highlight {
  background: rgba(232, 176, 90, 0.22);
}
/* Comment chips: numbered top-to-bottom via a CSS counter. The number is
   presentation (position), not identity: cross-party references quote the
   comment text, and anchor ids never render. Sized to sit inside the line
   box so chips do not disturb line height. */
.tiptap-editor .ProseMirror {
  counter-reset: critic-comment;
}
.tiptap-editor .critic-comment {
  counter-increment: critic-comment;
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  height: 14px;
  min-width: 14px;
  text-align: center;
  vertical-align: 0.35em;
  padding: 0 4px;
  margin-left: 2px;
  border-radius: 100px;
  background: var(--accent-glow, rgba(232, 122, 90, 0.15));
  color: var(--accent, #E87A5A);
  cursor: default;
}
.tiptap-editor .critic-comment::after {
  content: counter(critic-comment);
}
.tiptap-editor .critic-substitution .critic-sub-from {
  color: var(--danger, #E06C6C);
  text-decoration: line-through;
  background: rgba(224, 108, 108, 0.10);
  border-radius: 3px;
  padding: 0 2px;
}
.tiptap-editor .critic-substitution .critic-sub-arrow {
  margin: 0 4px;
  color: var(--text-2);
  font-size: 12px;
}
.tiptap-editor .critic-substitution .critic-sub-to {
  color: var(--success);
  background: rgba(107, 198, 126, 0.14);
  border-radius: 3px;
  padding: 0 2px;
}
@keyframes critic-flash-pulse {
  0%, 60% { outline-color: var(--accent, #E87A5A); background-color: var(--accent-glow, rgba(232, 122, 90, 0.25)); }
  100% { outline-color: transparent; }
}
.tiptap-editor .critic-flash {
  outline: 2px solid var(--accent, #E87A5A);
  outline-offset: 2px;
  border-radius: 3px;
  animation: critic-flash-pulse 1.2s ease-out;
}
/* Range-precise settle flash: marks exactly the text a verdict changed. */
@keyframes critic-flash-range-pulse {
  0%, 55% { background-color: var(--accent-glow, rgba(232, 122, 90, 0.35)); }
  100% { background-color: transparent; }
}
.tiptap-editor .critic-flash-range {
  border-radius: 2px;
  animation: critic-flash-range-pulse 1.2s ease-out;
}

/* --- Review: pane layout ------------------------------------------------- */
.tiptap-editor-pane.review-active {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--review-sidebar-width, 260px);
  column-gap: 20px;
  align-items: start;
}
.tiptap-editor-pane.review-active > :not(.review-sidebar):not(.review-pill) {
  grid-column: 1;
}
/* Minimised state. In the editor header (preferred host) the pill sits in
   the flex row next to the save status; the pane-corner fallback pins it
   absolutely. */
.review-pill {
  display: none;
  position: absolute;
  top: 22px;
  right: 24px;
  z-index: 5;
  padding: 4px 12px;
  border-radius: 100px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
}
.review-pill.in-header {
  position: static;
  flex-shrink: 0;
}
.review-pill.visible { display: inline-block; }
/* Open items are pending work: the minimised state stays loud. */
.review-pill.has-items {
  border-color: var(--accent, #E87A5A);
  color: var(--accent, #E87A5A);
  background: var(--accent-glow, rgba(232, 122, 90, 0.15));
}
.review-pill:hover { color: var(--accent, #E87A5A); border-color: var(--accent, #E87A5A); }
.review-pill:focus-visible { outline: 2px solid var(--accent, #E87A5A); outline-offset: 2px; }

/* --- Review: sidebar ------------------------------------------------------ */
/* The review panel is the same component grammar as the properties box:
   identical border, radius, background, and header metrics, so the REVIEW
   and PROPERTIES labels align pixel-for-pixel and the two boxes read as
   siblings. Card gutters are symmetric by construction (.review-body). */
.review-sidebar {
  display: none;
  grid-column: 2;
  grid-row: 1 / span 99;
  position: sticky;
  /* 0, not the pane padding: Chrome anchors the sticky offset to the
     content box, so any positive value displaces the panel downward at
     rest and breaks the top/bottom gap symmetry. The pane's padding gives
     the resting top gap; the derived max-height gives the bottom gap. */
  top: 0;
  /* Fallback only: the panel computes its real max-height from the pane's
     viewport so the bottom gap equals the top and right gaps (24px). */
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  /* The pane's right padding is 32px but the header's Saved indicator sits
     at 24px; pulling the sidebar 8px right aligns their right edges. */
  margin-right: -8px;
  z-index: 4;
}
.review-sidebar.visible { display: block; }
/* Resize affordance hierarchy: the col-resize cursor is the primary,
   instant signal. Hovering the handle (after a 300ms intent delay, the
   sash convention) brightens the panel's OWN edge border to a neutral
   (--text-2): the edge wakes up rather than a second line appearing, so
   nothing can double or clip. Dragging turns the same edge accent —
   orange means action-in-progress, and it only ever appears under a
   held mouse button. Leaving un-highlights immediately. */
.review-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
}
.review-sidebar.visible {
  transition: border-left-color 120ms ease 0s;
}
.review-sidebar:has(.review-resize-handle:hover) {
  border-left-color: var(--text-2);
  transition-delay: 300ms;
}
.review-sidebar:has(.review-resize-handle.dragging) {
  border-left-color: var(--accent, #E87A5A);
  transition: none;
}
.review-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.review-title { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-2); }
.review-close { background: none; border: none; color: var(--text-2); font-size: 14px; line-height: 1; cursor: pointer; padding: 0 2px; }
.review-close:hover { color: var(--text-1); }
.review-body { padding: 12px; }
.review-empty { font-size: 12px; color: var(--text-2); line-height: 1.5; }
.review-empty.completed { color: var(--success); font-weight: 600; }
.review-empty.completed::before { content: '✓'; margin-right: 6px; }

/* The range a comment is being written about stays marked while the
   composer is open (the editor blurs, so the native selection vanishes). */
.tiptap-editor .review-composing {
  background: var(--accent-glow, rgba(232, 122, 90, 0.2));
  border-radius: 2px;
  box-shadow: 0 1px 0 var(--accent, #E87A5A);
}

.review-card {
  background: var(--base, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.review-card:last-child { margin-bottom: 0; }
/* Departing card: a brief exit so the action visibly causes the removal. */
.review-card.leaving {
  opacity: 0;
  transform: translateX(8px);
  transition: opacity 160ms ease, transform 160ms ease;
}
/* Card called out by clicking its inline construct. */
@keyframes review-card-attention {
  0%, 55% { border-color: var(--accent, #E87A5A); box-shadow: 0 0 0 1px var(--accent, #E87A5A); }
  100% { border-color: var(--border); box-shadow: none; }
}
.review-card.attention { animation: review-card-attention 1.2s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .review-card.leaving { transition: none; }
  .review-card.attention, .tiptap-editor .critic-flash, .tiptap-editor .critic-flash-range { animation: none; }
}
.review-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.review-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 100px;
  background: rgba(107, 198, 126, 0.14);
  color: var(--success);
}
.review-card.comment .review-badge {
  background: var(--accent-glow, rgba(232, 122, 90, 0.15));
  color: var(--accent, #E87A5A);
}
/* One treatment for every author name: identity is information, not
   decoration (the accent already means "action" elsewhere in the panel). */
.review-by { font-size: 11px; font-weight: 500; color: var(--text-2); margin-left: auto; }
.review-by.unattributed { opacity: 0.6; }
.review-quote {
  font-size: 12px;
  color: var(--text-2);
  border-left: 2px solid var(--border);
  padding: 2px 8px;
  margin: 4px 0 6px;
}
.review-card-body { line-height: 1.5; overflow-wrap: anywhere; }
.review-sub-from { color: var(--danger, #E06C6C); text-decoration: line-through; }
.review-sub-arrow { margin: 0 6px; color: var(--text-2); }
.review-sub-to { color: var(--success); }
.review-reply {
  font-size: 12px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
  padding-top: 6px;
  display: flex;
  gap: 8px;
}
.review-reply .review-by { margin-left: 0; flex-shrink: 0; }
.review-reply .review-by::after { content: ':'; }
/* Review text entry: the conversations-input grammar at card scale — a
   growing textarea with an embedded circular send button that activates
   when there is text. No button row, so narrow panels keep full input
   width; an empty reply input dismisses itself on blur. */
.review-input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  padding: 5px 5px 5px 10px;
  margin-top: 8px;
}
.review-input:focus-within { border-color: var(--accent, #E87A5A); }
.review-input textarea {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  resize: none;
  min-height: 22px;
  max-height: 120px;
  padding: 3px 0;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-1);
  outline: none;
}
.review-send {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition: all 0.25s ease;
}
.review-send svg { width: 14px; height: 14px; }
.review-send:disabled { opacity: 0.3; cursor: default; }
.review-send.active {
  background: var(--accent, #E87A5A);
  color: #fff;
  box-shadow: 0 2px 8px rgba(232, 122, 90, 0.3);
}
.review-send.active:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(232, 122, 90, 0.4); }
.review-send:focus-visible { outline: 2px solid var(--accent, #E87A5A); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .review-send, .review-send.active:hover { transition: none; transform: none; }
}
.review-actions { display: flex; gap: 8px; margin-top: 10px; }
.review-btn {
  padding: 3px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}
.review-btn:hover { color: var(--text-1); border-color: var(--text-2); }
.review-btn:focus-visible, .review-close:focus-visible { outline: 2px solid var(--accent, #E87A5A); outline-offset: 1px; }
.review-card:focus-within { border-color: var(--text-2); }
.review-btn.accept:hover { background: rgba(107, 198, 126, 0.16); color: var(--success); border-color: var(--success); }
.review-btn.reject:hover { background: rgba(224, 108, 108, 0.14); color: var(--danger, #E06C6C); border-color: var(--danger, #E06C6C); }
.review-btn.resolve:hover { background: var(--accent-glow, rgba(232, 122, 90, 0.15)); color: var(--accent, #E87A5A); border-color: var(--accent, #E87A5A); }
.review-btn.primary { background: var(--accent, #E87A5A); border-color: var(--accent, #E87A5A); color: #1A1A1A; }
.review-btn.primary:hover { opacity: 0.9; }
.review-composer {
  background: var(--card);
  border: 1px solid var(--accent, #E87A5A);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.review-composer:last-child { margin-bottom: 0; }
.review-composer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.review-composer-title { font-size: 12px; font-weight: 600; }
.review-composer-close { background: none; border: none; color: var(--text-2); font-size: 15px; line-height: 1; cursor: pointer; padding: 0 2px; }
.review-composer-close:hover { color: var(--text-1); }
.review-composer-close:focus-visible { outline: 2px solid var(--accent, #E87A5A); outline-offset: 1px; }
.review-composer .review-input { margin-top: 2px; background: var(--base, transparent); }

/* Narrow panes: the sidebar becomes a pinned overlay instead of a column,
   so wide content keeps the full pane width underneath. */
@media (max-width: 1000px) {
  .tiptap-editor-pane.review-active { display: block; }
  .review-sidebar.visible {
    position: fixed;
    right: 12px;
    top: 70px;
    bottom: 12px;
    width: var(--review-sidebar-width, 260px);
    max-height: none;
    margin-right: 0;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    z-index: 40;
  }
}

/* --- Review: floating toolbar additions ---------------------------------- */
.floating-toolbar.visible { flex-direction: column; }
.floating-toolbar .tb-row { display: flex; gap: 2px; }
.floating-toolbar .tb-comment {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
  padding: 5px 10px;
  border-top: 1px solid var(--border);
  border-radius: 0 0 4px 4px;
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.floating-toolbar .tb-comment:hover {
  background: var(--accent-glow, rgba(232, 122, 90, 0.15));
  color: var(--accent, #E87A5A);
}
.floating-toolbar .tb-comment:focus-visible { outline: 2px solid var(--accent, #E87A5A); outline-offset: -2px; }
`;

export function injectEditorStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
