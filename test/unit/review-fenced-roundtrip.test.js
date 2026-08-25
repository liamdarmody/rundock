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
