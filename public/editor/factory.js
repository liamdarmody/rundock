// Editor factory. Builds a Tiptap Editor instance configured for Rundock's
// file editor surface and returns it alongside teardown hooks.
//
// Extensions:
//   StarterKit (hardBreak disabled; Link configured to not openOnClick)
//   SoftHardBreak (replaces StarterKit's HardBreak; \n serialiser)
//   Wikilink   (inline atom for [[target]])
//   Callout    (block atom for > [!type] blocks)
//   Markdown   (tiptap-markdown; html:false; breaks:true; bulletMarker:'-')
//
// The returned editor is owned by the caller; call editor.destroy() through
// the destroyEditor public API to release the instance and detach listeners.

import { Editor, StarterKit, Markdown } from '../vendor/tiptap-bundle.mjs';
import { Wikilink } from './nodes/wikilink.js';
import { Callout } from './nodes/callout.js';
import { SoftHardBreak } from './nodes/soft-hard-break.js';
import { FindExtension } from './plugins/find.js';

export function createEditorInstance({ element, initialBody, onUpdate, onSelectionChange }) {
  if (!element) throw new Error('createEditorInstance: element is required');

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Disable StarterKit's HardBreak; SoftHardBreak below replaces it with
        // a `\n` serialiser so breaks:true round-trips byte-for-byte.
        hardBreak: false,
        link: {
          // Plain click opens. Matches always-editable consumer apps like
          // Notion and Apple Notes; wikilinks already open on plain click via
          // the editor module's click delegate, so this keeps the two link
          // types consistent. target=_blank ensures we don't navigate away
          // from the editor; Electron's will-navigate handler in main.js
          // intercepts non-localhost URLs and routes them through
          // shell.openExternal, so the new-tab path also works in the
          // packaged app.
          openOnClick: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      SoftHardBreak,
      Wikilink,
      Callout,
      FindExtension,
      Markdown.configure({
        // html:false closes the XSS surface that the prototype's regex
        // pre-processors required. Wikilink and Callout source-side parsing
        // is now handled by markdown-it plugins registered on each node's
        // addStorage().markdown.parse.setup hook.
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: '',
    onUpdate: ({ editor: ed, transaction }) => {
      if (typeof onUpdate === 'function') {
        // Filter out the initial setContent transaction so the first paint
        // does not trigger a spurious save. setContent is called by the
        // public API after construction; the first onUpdate after that is
        // the only one to ignore.
        onUpdate({ editor: ed, transaction });
      }
    },
    onSelectionUpdate: ({ editor: ed }) => {
      if (typeof onSelectionChange === 'function') onSelectionChange(ed);
    },
  });

  if (initialBody !== undefined && initialBody !== null) {
    // Pass through tiptap-markdown's parse pipeline; markdown-it plugins
    // registered by the Wikilink and Callout nodes participate here.
    editor.commands.setContent(initialBody, false);
  }

  return editor;
}
