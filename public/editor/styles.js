// Editor-module styles, injected at runtime. The base editor styles live in
// index.html's stylesheet; styles for editor features owned entirely by this
// module (tables, review mode) are injected here instead so the module stays
// self-contained and app-level files stay untouched. Injected once per page.

const STYLE_ID = 'rundock-editor-module-styles';

const CSS = `
/* --- Tables (FV1) ------------------------------------------------------ */
.tiptap-editor .ProseMirror table {
  border-collapse: collapse;
  table-layout: auto;
  width: 100%;
  margin: 12px 0 16px;
  overflow: hidden;
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
`;

export function injectEditorStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
