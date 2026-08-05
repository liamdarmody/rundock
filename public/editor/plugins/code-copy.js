// Copy button for code blocks in the file view editor.
//
// Chat messages have had a copy control on fenced code since 0.10.0
// (copyCode in app.js); the file view editor did not, so the only way to get a
// snippet out of a note was to select it by hand inside a contentEditable,
// which is exactly where selection is most awkward.
//
// Built as a ProseMirror widget decoration rather than a NodeView. This editor
// round-trips markdown byte-exactly and the serialiser is documented as
// fragile, so the safe move is the one find.js already takes: decorations never
// become document content, so save and round-trip cannot be affected by them.
// A NodeView would have to reimplement code-block rendering and would sit
// directly in the path this editor is most careful about.
//
// The copied text is the code block's own text content, which is the fence
// contents WITHOUT the backtick markers, because the markers are markdown
// syntax and never enter the document as text.
import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

const codeCopyPluginKey = new PluginKey('rundock-code-copy');

const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/**
 * Write text to the clipboard, falling back to a hidden textarea.
 *
 * navigator.clipboard is undefined in non-secure contexts, which includes
 * Rundock served over plain http from a VPS. app.js carries the same fallback
 * for the chat button; it is repeated rather than shared because this module
 * must not reach into a global defined by a classic script.
 */
function writeClipboard(text, onDone) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onDone).catch(() => {});
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    onDone();
  } catch {
    // Copy unavailable: leave the button as it was rather than claim success.
  }
}

function buildButton(getText) {
  const btn = document.createElement('button');
  btn.className = 'editor-copy-code-btn';
  btn.type = 'button';
  btn.title = 'Copy code';
  btn.setAttribute('aria-label', 'Copy code');
  // The editor is contentEditable; without this the button becomes editable
  // content and the caret can be placed inside it.
  btn.contentEditable = 'false';
  btn.innerHTML = COPY_ICON;

  // mousedown, not click: ProseMirror acts on mousedown to place the caret, so
  // preventing the default here stops the click stealing focus into the block.
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    writeClipboard(getText(), () => {
      btn.innerHTML = CHECK_ICON;
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 2000);
    });
  });
  return btn;
}

function buildDecorations(doc) {
  const decorations = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    // Captured lazily so the text read on click is the CURRENT content of the
    // block, not whatever it held when the decoration was built.
    const getText = () => node.textContent;
    decorations.push(
      Decoration.widget(pos + 1, () => buildButton(getText), {
        // Render before the block's text so the button is the first child and
        // the caret at position 0 still lands on the code, not after it.
        side: -1,
        // The widget is chrome, not content: it must never be treated as part
        // of a selection or copied along with the code.
        ignoreSelection: true,
        // Keep every event on the button out of ProseMirror's handlers.
        stopEvent: () => true,
      })
    );
    // Code blocks hold only text, so there is nothing to walk into.
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function codeCopyPlugin() {
  return new Plugin({
    key: codeCopyPluginKey,
    state: {
      init(_, { doc }) { return buildDecorations(doc); },
      apply(tr, old) {
        // Only rebuild when the document actually changed. Selection-only
        // transactions fire constantly while typing and moving the caret.
        return tr.docChanged ? buildDecorations(tr.doc) : old;
      },
    },
    props: {
      decorations(state) { return codeCopyPluginKey.getState(state); },
    },
  });
}

export const CodeCopyExtension = Extension.create({
  name: 'rundockCodeCopy',
  addProseMirrorPlugins() {
    return [codeCopyPlugin()];
  },
});
