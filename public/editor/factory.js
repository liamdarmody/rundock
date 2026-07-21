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

import { Editor, StarterKit, Markdown, TaskItem } from '../vendor/tiptap-bundle.mjs';
import { Wikilink } from './nodes/wikilink.js';
import { Image } from './nodes/image.js';
import { Callout } from './nodes/callout.js';
import { SoftHardBreak } from './nodes/soft-hard-break.js';
import { SoftOrderedList } from './nodes/soft-ordered-list.js';
import { SourceBulletList, SourceHorizontalRule, SourceTaskList, SourceText } from './nodes/source-markers.js';
import { tableExtensions, tableDirtyKey } from './nodes/table.js';
import { criticExtensions } from './nodes/critic-marks.js';
import { mathExtensions } from './nodes/math.js';
import { FindExtension } from './plugins/find.js';

export function createEditorInstance({ element, initialBody, onUpdate, onSelectionChange }) {
  if (!element) throw new Error('createEditorInstance: element is required');

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        // All six levels: #### and deeper previously fell out of the schema
        // and flattened to plain paragraphs on save (OFM parity corpus).
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        // Disable StarterKit's HardBreak; SoftHardBreak below replaces it with
        // a `\n` serialiser so breaks:true round-trips byte-for-byte.
        hardBreak: false,
        // Disable StarterKit's OrderedList; SoftOrderedList below replaces it
        // with an unpadded-number serialiser (Obsidian parity for 10+ items).
        orderedList: false,
        // Disable StarterKit's BulletList/HorizontalRule; the Source* nodes
        // below replace them with serialisers that preserve the source marker
        // (+ vs -, *** vs ---) instead of normalising it, so notes are not
        // silently reformatted on save. Bold and Italic keep StarterKit's
        // default serializers on purpose (see source-markers.js: a dynamic
        // emphasis delimiter broke tiptap-markdown's inline trim and deleted
        // single-character emphasis).
        bulletList: false,
        horizontalRule: false,
        // Disable StarterKit's Text; SourceText below escapes square brackets
        // only when they could form a link, so literal brackets in prose are
        // not backslash-escaped on save.
        text: false,
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
      SoftOrderedList,
      SourceText,
      SourceBulletList,
      SourceHorizontalRule,
      // TaskList/TaskItem give "- [ ]"/"- [x]" real checkbox nodes. Without
      // them a checkbox line parses as a bullet whose literal "[ ]" text the
      // serialiser then escapes to "- \[ \]", silently corrupting the file on
      // save. tiptap-markdown supplies the parse (markdown-it-task-lists) and
      // serialize for the taskList/taskItem node names automatically. nested
      // lets a task item hold a child task list so nested checkboxes survive.
      // KNOWN LIMITATION: a single list block that MIXES a checkbox item and a
      // plain bullet ("- [ ] a" then "- b") reflows on save (the plain item
      // renumbers; a plain-then-task order reorders), because markdown-it
      // splits the mixed list. Pure checklists round-trip exactly; keep
      // checkboxes and plain bullets in separate list blocks.
      SourceTaskList,
      TaskItem.configure({ nested: true }),
      Wikilink,
      Image,
      Callout,
      ...tableExtensions,
      ...criticExtensions,
      ...mathExtensions,
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

  // Arm the table dirty-tracker only after the initial content is in, so the
  // load itself never marks cells as edited. Source-preserving table
  // serialization depends on load-time cells being clean.
  editor.view.dispatch(editor.state.tr.setMeta(tableDirtyKey, 'arm'));

  return editor;
}
