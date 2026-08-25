// Reviewing a page that contains a fenced block.
//
// The document that broke was the ordinary one: a page explaining markdown,
// with a page of markdown inside a fence. Two separate faults corrupted it.
//
//  - A review construct is an inline atom, and a fenced block holds text and
//    nothing else. Inserting one there does not fail: the editor closes the
//    block to make room and sweeps the rest of it into a paragraph, where the
//    serialiser then escapes the asterisks and backticks that were code a
//    moment earlier.
//  - The fence marker itself was not carried through the round trip, so a
//    four-backtick fence came back as three backticks and the NEXT read closed
//    it at the inner fence.
//
// The fixture is a real file read from disk rather than a string built here. A
// string is written by someone who already knows where the fence is; a file
// carries the shapes nobody thought to write down, which is how this reached a
// user. It is driven through the real editor by the same harness that enforces
// the byte-for-byte round trip everywhere else.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundTrip, bootEditorEnv } from '../helpers/editor-harness.js';
import { parseFile } from '../../public/editor/markdown/pipeline.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'review', 'fenced-page.md');
const PAGE = fs.readFileSync(FIXTURE, 'utf-8');

const NOW = '2026-08-25T09:00:00.000Z';

// A phrase in ordinary prose, chosen so it carries no markdown punctuation: a
// released anchor goes back into the document as markdown source, so a phrase
// containing an asterisk or a bracket would change meaning on release for
// reasons that have nothing to do with fences.
const PROSE_ANCHOR = 'markdown';

// The document without its review block: frontmatter, body, and the file's
// trailing newline run. Review data has to be stored somewhere, so a test that
// demanded the whole file be unchanged after a review operation would be
// demanding the operation not happen. What must not move is everything else.
function documentBytes(file) {
  const parts = parseFile(file);
  return (parts.raw || '') + parts.body + parts.trailing;
}

function reviewBlock(file) {
  return parseFile(file).endmatter.raw;
}

async function withReview(fn) {
  const env = await bootEditorEnv();
  const { createReviewController } = await import('../../public/editor/review/controller.js');
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const parts = parseFile(PAGE);
  const { editor } = env.createEditor({ element, rawMarkdown: parts.body });
  const review = createReviewController({
    editor, endmatter: parts.endmatter, author: 'sam', now: () => NOW,
  });
  const save = () => env.pipeline.serialiseFile(
    editor, { ...parts, endmatterRaw: review.getEndmatterRaw() });
  // Positions of a phrase in the editor's own coordinates, so a test says
  // which words it is commenting on rather than counting characters.
  const rangeOf = (phrase, inCode) => {
    let found = null;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      const isCode = node.type.name === 'codeBlock';
      if (!node.isTextblock || isCode !== inCode) return true;
      const at = node.textContent.indexOf(phrase);
      if (at === -1) return true;
      found = { from: pos + 1 + at, to: pos + 1 + at + phrase.length };
      return false;
    });
    assert.ok(found, `phrase ${JSON.stringify(phrase)} not found ${inCode ? 'in a fenced block' : 'in prose'}`);
    return found;
  };
  try {
    await fn({ editor, review, save, rangeOf });
  } finally {
    env.destroyEditor(editor);
    element.remove();
  }
}

describe('a page of fences, opened and saved', () => {
  test('the fixture round-trips byte-for-byte', async () => {
    assert.equal(await roundTrip(PAGE), PAGE,
      'the editor changed bytes in a file it was only asked to open');
  });

  test('the four-backtick fence keeps four backticks, so its inner fence stays inside it', async () => {
    const out = await roundTrip(PAGE);
    assert.ok(out.includes('````markdown\n'), 'the outer opening marker lost a backtick');
    assert.ok(out.includes('\n````\n'), 'the outer closing marker lost a backtick');
    assert.ok(out.includes('```js\nconst rate = 0.42;\n```'),
      'the nested fence did not survive inside the outer block');
  });

  test('the tilde fence is still a tilde fence', async () => {
    const out = await roundTrip(PAGE);
    assert.ok(out.includes('~~~text\n'), 'the tilde opening marker was rewritten');
    assert.ok(out.includes('\n~~~\n'), 'the tilde closing marker was rewritten');
  });

  test('a second and third cycle change nothing further', async () => {
    let out = PAGE;
    for (let i = 0; i < 3; i++) out = await roundTrip(out);
    assert.equal(out, PAGE, 'the file drifted over repeated open-and-save cycles');
  });
});

describe('commenting on a page of fences', () => {
  test('adding a comment in prose changes only the comment markers', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      const range = rangeOf(PROSE_ANCHOR, false);
      editor.commands.setTextSelection(range);
      const id = review.addComment('Is this the right word here?');
      assert.equal(id, 'c1');
      const out = save();
      const marked = `{==${PROSE_ANCHOR}==}{>>Is this the right word here?<<}{#c1}`;
      assert.ok(out.includes(marked), `the comment was not written as one construct:\n${out}`);
      // Put the construct back to the words it wraps, drop the review block,
      // and what is left has to be the file that was opened. Nothing outside
      // the markers may have moved.
      const withoutMarkers = documentBytes(out).replace(marked, PROSE_ANCHOR);
      assert.equal(withoutMarkers, PAGE, 'bytes outside the comment markers changed');
      assert.ok(!out.includes('\\'), `the save escaped something:\n${out}`);
    });
  });

  test('replying to a comment leaves the document bytes alone', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      editor.commands.setTextSelection(rangeOf(PROSE_ANCHOR, false));
      review.addComment('Is this the right word here?');
      const before = save();
      review.reply('c1', 'Yes, it is the file format.');
      const after = save();
      assert.equal(documentBytes(after), documentBytes(before),
        'a reply moved bytes in the document it was about');
      assert.notEqual(reviewBlock(after), reviewBlock(before),
        'the reply was not recorded anywhere, so this proves nothing');
    });
  });

  test('resolving a comment gives the document back its original bytes', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      editor.commands.setTextSelection(rangeOf(PROSE_ANCHOR, false));
      review.addComment('Is this the right word here?');
      assert.notEqual(documentBytes(save()), PAGE, 'the comment never went in');
      review.resolve('c1');
      const out = save();
      assert.equal(documentBytes(out), PAGE,
        'the document did not come back to what it was before the comment');
      assert.match(reviewBlock(out), /resolved: true/,
        'the resolution left no record, so this proves nothing');
    });
  });
});

describe('anchoring inside a fenced block', () => {
  const CODE_ANCHOR = 'const rate';

  test('a comment anchored inside a fence is refused, with a reason', async () => {
    await withReview(async ({ editor, review, rangeOf }) => {
      const range = rangeOf(CODE_ANCHOR, true);
      editor.commands.setTextSelection(range);
      const result = review.addComment('Should this be a constant?');
      assert.equal(result.refused, true, 'the comment was applied inside a fenced block');
      assert.match(result.reason, /code block/i, 'the refusal carried no usable reason');
    });
  });

  test('a refused comment changes nothing, so it cannot half-apply', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      const before = save();
      editor.commands.setTextSelection(rangeOf(CODE_ANCHOR, true));
      review.addComment('Should this be a constant?');
      assert.equal(save(), before, 'a refused comment still changed the file');
      assert.equal(save(), PAGE, 'a refused comment still changed the file');
      assert.equal(review.isDirty(), false, 'a refused comment left review data to save');
      assert.equal(review.listItems().length, 0, 'a refused comment left a construct behind');
    });
  });

  test('a suggested replacement inside a fence is refused the same way', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      editor.commands.setTextSelection(rangeOf(CODE_ANCHOR, true));
      const result = review.suggestReplace('const RATE');
      assert.equal(result.refused, true, 'the suggestion was applied inside a fenced block');
      assert.equal(save(), PAGE, 'a refused suggestion still changed the file');
    });
  });

  test('a suggested insertion at a cursor inside a fence is refused the same way', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      const range = rangeOf(CODE_ANCHOR, true);
      editor.commands.setTextSelection({ from: range.from, to: range.from });
      const result = review.suggestInsert(' // rounded');
      assert.equal(result.refused, true, 'the insertion was applied inside a fenced block');
      assert.equal(save(), PAGE, 'a refused insertion still changed the file');
    });
  });

  test('the block survives the refusal intact, fence markers and all', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      editor.commands.setTextSelection(rangeOf(CODE_ANCHOR, true));
      review.addComment('Should this be a constant?');
      const out = save();
      assert.ok(out.includes('````markdown\n'), 'the outer fence was cut short');
      assert.ok(out.includes('```js\nconst rate = 0.42;\n```'), 'the inner fence was cut short');
      assert.ok(!out.includes('\\'), `the save escaped something:\n${out}`);
    });
  });
});

// The controller returns the refusal; the sidebar is what a person actually
// sees, so the reason is followed all the way to the composer rather than
// assumed to arrive there.
describe('the review sidebar, told no', () => {
  test('the composer stays open, shows the reason, and keeps what was typed', async () => {
    await withReview(async ({ editor, review, save, rangeOf }) => {
      const env = await bootEditorEnv();
      const { attachReviewPanel } = await import('../../public/editor/panels/review.js');
      const pane = env.window.document.createElement('div');
      env.window.document.body.appendChild(pane);
      let saves = 0;
      const panel = attachReviewPanel({
        paneElement: pane, editor, controller: review, onRequestSave: () => { saves += 1; },
      });
      try {
        editor.commands.setTextSelection(rangeOf('const rate', true));
        panel.openComposer('comment');
        const box = pane.querySelector('.review-composer textarea');
        assert.ok(box, 'the composer did not open');
        box.value = 'Should this be a constant?';
        box.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter' }));

        const refusal = pane.querySelector('.review-composer-refusal');
        assert.ok(refusal, 'the sidebar closed the composer without saying anything');
        assert.match(refusal.textContent, /code block/i, 'the reason shown says nothing usable');
        const reopened = pane.querySelector('.review-composer textarea');
        assert.equal(reopened.value, 'Should this be a constant?', 'the typed comment was thrown away');
        assert.equal(saves, 0, 'a refused comment asked for a save');
        assert.equal(save(), PAGE, 'a refused comment changed the file');
      } finally {
        panel.detach();
        pane.remove();
      }
    });
  });
});
