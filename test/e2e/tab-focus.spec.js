'use strict';
// E2E: Tab never takes focus out of the editor.
//
// Tab was bound only where it had something to do, `sinkListItem` on a list
// item with a previous sibling. Everywhere else nothing consumed the key, the
// browser performed its default focus traversal, and focus left the document:
// in Chrome the caret lands in the address bar mid-sentence.
//
// It was first reported as a callout problem. It is not one, and the pair of
// fixtures here exists to keep it from being re-diagnosed that way: the two
// notes are identical but for a callout, and every assertion runs over both.
// Callouts only made the fault visible sooner, because a callout's controls
// are focusable and sit in the tab order, so focus appeared to jump into the
// callout rather than simply vanishing.
//
// The caret is placed through the editor rather than by clicking. A click is
// how a person does it, but it resolves to whatever glyph is under a
// coordinate, and these tests need to name a heading or the FIRST item of a
// list exactly. The key itself is a real press, which is the part that has to
// be real: an unhandled Tab only escapes because the browser acts on it, and a
// synthesised event would not reproduce that at all.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { tabSites } = require('./fixture.js');

const NOTES = [
  { file: 'tab-sites-callout.md', label: 'with a callout', withCallout: true },
  { file: 'tab-sites-plain.md', label: 'without a callout', withCallout: false },
];

// Several of these tests INDENT a list, which saves. Run in sequence against
// one server they would otherwise judge the previous test's leftovers, and the
// symptom is bizarre: a test asserting "Tab indents" fails because the item was
// already indented, and the failures land on whichever file happens to run
// first. Each test starts from the fixture definition instead, so there is one
// source for the content and nothing to drift.
async function openNote(page, file, withCallout) {
  await page.goto('/');
  const workspace = await page.evaluate(() => currentWorkspacePath);
  expect(workspace).toBeTruthy();
  fs.writeFileSync(path.join(workspace, file), tabSites({ withCallout }));
  await page.goto('/');
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator(`#file-tree .file-item[data-path="${file}"]`).click();
  await expect(page.locator('.ProseMirror h1')).toBeVisible();
}

// Puts the caret inside the first text node containing `needle` and reports
// where it actually landed, so a test cannot pass while aimed at the wrong
// block. Returns the node path and the document's markdown at that moment.
async function caretAt(page, needle) {
  const state = await page.evaluate((text) => {
    const ed = document.querySelector('.ProseMirror').editor;
    let pos = null;
    ed.state.doc.descendants((node, p) => {
      if (pos === null && node.isText && node.text.includes(text)) pos = p + 1;
    });
    if (pos === null) throw new Error(`no text node containing ${text}`);
    ed.chain().focus().setTextSelection(pos).run();
    const { $from } = ed.state.selection;
    const names = [];
    for (let d = $from.depth; d > 0; d -= 1) names.push($from.node(d).type.name);
    return {
      path: names.join('>'),
      block: $from.parent.textContent,
      canSink: ed.can().sinkListItem('listItem'),
      canLift: ed.can().liftListItem('listItem'),
      markdown: ed.storage.markdown.getMarkdown(),
    };
  }, needle);
  // Focus lands asynchronously. Pressing the key before it does sends the
  // press to the body, where Tab means "move focus" and nothing else, and the
  // test then reports a product failure that is entirely its own. This raced
  // both ways and cost a wrong conclusion before it was pinned down.
  await expect.poll(async () => page.evaluate(
    () => document.activeElement.classList.contains('ProseMirror'),
  )).toBe(true);
  return state;
}

async function afterKey(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('.ProseMirror').editor;
    const active = document.activeElement;
    return {
      // The whole point: is focus still inside the document being edited.
      focusInEditor: active.classList.contains('ProseMirror')
        || !!active.closest('.ProseMirror'),
      activeTag: active.tagName,
      markdown: ed.storage.markdown.getMarkdown(),
    };
  });
}

for (const { file, label, withCallout } of NOTES) {
  // The sites where Tab has nothing to do. Each one used to lose focus.
  for (const [site, needle] of [
    ['a heading', 'Tab Sites'],
    ['a paragraph', 'standard paragraph'],
    ['the first list item', 'First item'],
  ]) {
    for (const key of ['Tab', 'Shift+Tab']) {
      test(`${key} in ${site} keeps focus in the editor, ${label}`, async ({ page }) => {
        await openNote(page, file, withCallout);
        const before = await caretAt(page, needle);
        // Precondition: no list INDENT is available here, which is what used
        // to make the key fall through to the browser.
        expect(before.canSink).toBe(false);
        expect(before.block).toContain(needle);

        await page.keyboard.press(key);
        const after = await afterKey(page);

        // The defect, and the whole point of the card.
        expect(after.focusInEditor).toBe(true);

        // Whether the document may change is not the same question, and it is
        // derived rather than assumed. Shift-Tab on a top-level list item is a
        // legal OUTDENT: it lifts the item out of the list, which is existing
        // behaviour and must survive. Everywhere else nothing legitimately
        // acts, so the guard consuming the key must leave the bytes alone.
        const somethingCanAct = key === 'Shift+Tab' && before.canLift;
        if (somethingCanAct) expect(after.markdown).not.toBe(before.markdown);
        else expect(after.markdown).toBe(before.markdown);
      });
    }
  }

  test(`Tab still indents a list item that can be indented, and Shift+Tab outdents it, ${label}`, async ({ page }) => {
    await openNote(page, file, withCallout);
    const before = await caretAt(page, 'Third item');
    // This one CAN nest: it has a previous sibling to nest under. Without this
    // the test below would pass against an editor that had simply stopped
    // indenting anything, which is the obvious way to "fix" a focus escape.
    expect(before.canSink).toBe(true);

    await page.keyboard.press('Tab');
    const indented = await afterKey(page);
    expect(indented.focusInEditor).toBe(true);
    expect(indented.markdown).not.toBe(before.markdown);
    await expect(page.locator('.ProseMirror li ul, .ProseMirror li ol')).toHaveCount(1);

    await page.keyboard.press('Shift+Tab');
    const outdented = await afterKey(page);
    expect(outdented.focusInEditor).toBe(true);
    // Back where it started, which also proves Shift+Tab is still reaching
    // liftListItem rather than being swallowed by the guard.
    expect(outdented.markdown).toBe(before.markdown);
  });

  test(`Tab still moves between table cells, ${label}`, async ({ page }) => {
    await openNote(page, file, withCallout);
    const before = await caretAt(page, '1');
    expect(before.path).toContain('tableCell');

    await page.keyboard.press('Tab');
    const moved = await page.evaluate(() => {
      const ed = document.querySelector('.ProseMirror').editor;
      const { $from } = ed.state.selection;
      return { cellText: $from.parent.textContent,
               markdown: ed.storage.markdown.getMarkdown() };
    });

    // The guard runs at a priority below every real binding, so the table's own
    // Tab is offered the key first and still gets it. A catch-all placed above
    // these bindings would strand the caret in the first cell.
    expect(moved.cellText).not.toBe(before.block);
    expect(moved.markdown).toBe(before.markdown);
  });
}
