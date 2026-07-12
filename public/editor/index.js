// Public API for the editor module. app.js consumes this file and nothing
// else under public/editor/. Keeping the surface narrow makes it easy to
// swap implementations or carry the module forward to a different host.
//
// createEditor builds the Tiptap instance, attaches the floating toolbar,
// wires the wikilink click delegate, and returns a handle the host (app.js)
// can use to read content back out and tear down.
//
// destroyEditor releases the instance and detaches listeners.
// getMarkdown returns the full file content (frontmatter + body) ready to
// save to disk via the host's existing save flow.

import { createEditorInstance } from './factory.js';
import { injectEditorStyles } from './styles.js';
import { parseFile, serialiseFile } from './markdown/pipeline.js';
import { attachFloatingToolbar } from './panels/floating-toolbar.js';
import { renderProperties } from './panels/properties.js';
import { setFindQuery, findNext, findPrev, setFindIndex, clearFind, getFindState } from './plugins/find.js';

export { setFindQuery, findNext, findPrev, setFindIndex, clearFind, getFindState };

const _editorHandles = new WeakMap();

// Wires a click delegate on the host element that routes wikilink clicks to
// the host's onWikilinkClick callback. Returns an unbind function.
function wireWikilinkClicks(hostElement, onWikilinkClick) {
  if (!hostElement || typeof onWikilinkClick !== 'function') return () => {};
  const handler = (event) => {
    const anchor = event.target && event.target.closest && event.target.closest('a.wikilink');
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const target = anchor.getAttribute('data-target') || '';
    const alias  = anchor.getAttribute('data-alias') || null;
    if (target) onWikilinkClick(target, alias);
  };
  hostElement.addEventListener('click', handler);
  return () => hostElement.removeEventListener('click', handler);
}

export function createEditor({
  element,
  rawMarkdown,
  propertiesElement = null,
  toolbarElement = null,
  toolbarHostElement = null,
  onUpdate = null,
  onWikilinkClick = null,
}) {
  if (!element) throw new Error('createEditor: element is required');

  injectEditorStyles();

  const parts = parseFile(rawMarkdown || '');
  const { raw, parsed, body } = parts;

  const editor = createEditorInstance({
    element,
    initialBody: body,
    onUpdate: ({ editor: ed }) => {
      if (typeof onUpdate === 'function') onUpdate({ editor: ed });
    },
  });

  // Properties panel is read-only today; making it editable is a follow-up.
  const propertiesCount = renderProperties(propertiesElement, parsed);

  // Floating toolbar. Optional: host can leave both toolbar elements null
  // and the editor stays usable without a selection menu.
  let detachToolbar = () => {};
  if (toolbarElement && toolbarHostElement) {
    detachToolbar = attachFloatingToolbar({
      toolbarElement,
      hostElement: toolbarHostElement,
      editor,
    });
  }

  const detachWikilinks = wireWikilinkClicks(element, onWikilinkClick);

  _editorHandles.set(editor, {
    parts,
    parsedFrontmatter: parsed,
    propertiesCount,
    detachToolbar,
    detachWikilinks,
  });

  return { editor, frontmatter: parsed, hasProperties: propertiesCount > 0 };
}

export function destroyEditor(editor) {
  if (!editor) return;
  const handle = _editorHandles.get(editor);
  if (handle) {
    try { handle.detachToolbar(); }   catch {}
    try { handle.detachWikilinks(); } catch {}
    _editorHandles.delete(editor);
  }
  try { editor.destroy(); } catch {}
}

export function getMarkdown(editor) {
  if (!editor) return '';
  const handle = _editorHandles.get(editor);
  if (!handle) return serialiseFile(editor, {});
  const parts = { ...handle.parts };
  // The review controller owns the live endmatter: when review data changed
  // it supplies a rebuilt block, otherwise the original bytes pass through.
  if (handle.review) parts.endmatterRaw = handle.review.getEndmatterRaw();
  return serialiseFile(editor, parts);
}
