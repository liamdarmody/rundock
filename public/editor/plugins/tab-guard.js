// Tab must never take focus out of the document.
//
// Tab was bound only where it had something to do: `sinkListItem` on a list
// item with a previous sibling to nest under. Everywhere else, a heading, a
// plain paragraph, the FIRST item of a list, nothing consumed the key, so the
// browser did what a browser does with an unhandled Tab and moved focus to the
// next thing in the tab order. From the editor that means out of the document
// entirely, and in Chrome the caret lands in the address bar mid-sentence.
//
// This was first reported as a callout problem, and it is not one: two notes
// identical but for a callout behave the same. Callouts only made it visible
// sooner, because a callout's controls are focusable and sit in the tab order,
// so focus appeared to jump INTO the callout rather than simply vanishing. The
// callout was the nearest place for focus to land, not the cause.
//
// What this does NOT do is insert indentation. Obsidian's Tab inserts
// whitespace because Obsidian edits markdown as text; this editor edits a
// document model and serialises it, and there is no indented-paragraph node to
// serialise. Measured in this pipeline: a paragraph indented by a tab or four
// spaces parses as a CODE BLOCK, at two spaces the indentation is dropped
// silently, and a first list item indented by a tab becomes a code block and
// splits the list. Indentation semantics need a markdown-safe representation
// designed first, so this guard deliberately changes nothing about the
// document. It only refuses to let the key escape.
//
// PRIORITY IS THE MECHANISM. Keyboard shortcuts run in extension priority
// order, highest first, and the first handler returning true wins. At a
// priority below the default this runs LAST, so every real binding (list
// indent, table cell navigation) is offered the key first and this only sees
// the presses nobody wanted. Raising its priority would swallow those bindings
// instead of backing them up.
import { Extension } from '../../vendor/tiptap-bundle.mjs';

export const TabGuardExtension = Extension.create({
  name: 'tabGuard',

  // Below the default of 100, so this is the last handler consulted.
  priority: 10,

  addKeyboardShortcuts() {
    // Returning true means handled, which is what stops the browser acting on
    // it. The document is untouched: this is a refusal, not an edit.
    const consume = () => true;
    return {
      Tab: consume,
      'Shift-Tab': consume,
    };
  },
});
