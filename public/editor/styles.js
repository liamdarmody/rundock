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
/* Comment chips: numbered in document order via a CSS counter (wire-format
   anchor ids never render). Sized to sit inside the line box so chips do
   not disturb line height. */
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
.review-pill {
  display: none;
  position: sticky;
  top: 0;
  grid-column: 2;
  justify-self: end;
  float: right;
  z-index: 5;
  padding: 4px 12px;
  border-radius: 100px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
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
.review-sidebar {
  display: none;
  grid-column: 2;
  grid-row: 1 / span 99;
  position: sticky;
  top: 0;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
  padding: 2px 2px 2px 10px;
  background: var(--base, #1A1A1A);
  z-index: 4;
  position: sticky;
}
.review-sidebar.visible { display: block; }
.review-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  border-left: 1px solid var(--border);
}
.review-resize-handle:hover, .review-resize-handle:active {
  border-left: 2px solid var(--accent, #E87A5A);
}
.review-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.review-title { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-2); }
.review-close { background: none; border: none; color: var(--text-2); font-size: 16px; cursor: pointer; padding: 0 4px; }
.review-close:hover { color: var(--text-1); }
.review-progress { font-size: 12px; color: var(--text-2); margin-bottom: 12px; }
.review-empty { font-size: 12px; color: var(--text-2); line-height: 1.5; padding: 8px 0; }

.review-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  font-size: 13px;
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
.review-by { font-size: 11px; color: var(--text-2); margin-left: auto; }
.review-by.me { color: var(--text-1); font-weight: 600; }
.review-by.agent { color: var(--accent, #E87A5A); font-weight: 600; }
.review-by.unattributed { font-style: normal; opacity: 0.6; }
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
.review-reply-box { margin-top: 8px; display: flex; gap: 6px; align-items: flex-end; }
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
.review-btn.done { width: 100%; padding: 7px 12px; }
.review-btn.done:hover { background: var(--accent-glow, rgba(232, 122, 90, 0.15)); color: var(--accent, #E87A5A); border-color: var(--accent, #E87A5A); }
.review-footer { margin-top: 4px; padding-bottom: 8px; }
.review-done-note { font-size: 12px; color: var(--success); padding: 8px 0; }
.review-composer {
  background: var(--card);
  border: 1px solid var(--accent, #E87A5A);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.review-composer-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.review-composer textarea, .review-reply-box textarea {
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-1);
  font-size: 13px;
  font-family: inherit;
  padding: 6px 8px;
  resize: vertical;
}
.review-composer textarea:focus, .review-reply-box textarea:focus {
  outline: none;
  border-color: var(--accent, #E87A5A);
}

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
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 10px 10px 14px;
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
