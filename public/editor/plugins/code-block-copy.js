// Copying from inside a code block copies the code, not a fenced block.
//
// The markdown extension serialises every copied slice to markdown
// (transformCopiedText), which is right for prose and wrong here: a selection
// that starts and ends inside one code block is a codeBlock slice, and it
// serialises with its ``` fences and language tag. Pasting that into a
// terminal, a chat or another code block means deleting the fences by hand.
//
// So when the selection starts and ends inside the same code block, the
// plain-text clipboard carries exactly the selected text. Anything else
// returns nothing here, and ProseMirror moves on to the markdown serialiser,
// so a selection reaching outside the block keeps its fences, where they
// carry meaning. Paste is untouched. The code block's copy button already
// copies its raw text (code-copy.js); this makes keyboard and menu copy agree.
import { Extension, Plugin, PluginKey } from '../../vendor/tiptap-bundle.mjs';

const codeBlockCopyKey = new PluginKey('rundock-code-block-copy');

export function textInsideOneCodeBlock(state) {
  const { $from, $to, empty } = state.selection;
  if (empty || !$from.sameParent($to) || $from.parent.type.name !== 'codeBlock') return null;
  return state.doc.textBetween($from.pos, $to.pos, '\n');
}

export const CodeBlockCopyExtension = Extension.create({
  name: 'codeBlockCopy',
  // Ahead of the markdown extension, whose serialiser answers every copy:
  // ProseMirror takes the first clipboardTextSerializer that returns text.
  priority: 1000,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: codeBlockCopyKey,
      props: {
        clipboardTextSerializer: (slice, view) => textInsideOneCodeBlock(view.state) || undefined,
      },
    })];
  },
});
