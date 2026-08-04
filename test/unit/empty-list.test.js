'use strict';
// A reply that is only a number renders outside its message bubble.
//
// The cause is markdown behaving correctly. `4471.` is valid ordered-list
// syntax, so it parses to a list whose single item has no content. The whole
// reply then exists only as the list marker, and because the bubble sets a
// fixed `padding-left` for lists, a five-character marker is drawn to the left
// of the bubble entirely. Reported from a manual pass: a stray `4471.`
// floating outside an otherwise empty bubble.
//
// The decision is tested here against REAL marked tokens rather than
// hand-built ones, following code-language.test.js: the whole point is what
// this specific parser produces, so a fabricated token would test nothing.
//
// The dangerous direction is the false positive. Turning a genuine list into a
// paragraph would silently destroy formatting, so the cases that must be left
// alone are tested at least as hard as the case being fixed.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { marked } = require('marked');
const emptyOrderedListText = require('../../public/empty-list.js');

// The first token of a source string, which for every case here is the list
// or paragraph the whole reply consists of.
const tok = (src) => marked.lexer(src)[0];

describe('emptyOrderedListText', () => {
  describe('the reported bug: a reply that is only a number', () => {
    test('recovers the original text from a bare number and full stop', () => {
      assert.strictEqual(emptyOrderedListText(tok('4471.')), '4471.');
    });

    test('handles the close-paren list delimiter markdown also accepts', () => {
      assert.strictEqual(emptyOrderedListText(tok('4471)')), '4471)');
    });

    test('handles a single digit, not just long numbers', () => {
      assert.strictEqual(emptyOrderedListText(tok('1.')), '1.');
    });

    test('collapses a run of bare numbers onto one line rather than dropping them', () => {
      // Degenerate input, but it must not silently lose the text. Newlines
      // become spaces because the result is a paragraph, not a list.
      assert.strictEqual(emptyOrderedListText(tok('1.\n2.\n3.')), '1. 2. 3.');
    });
  });

  describe('genuine lists must be left completely alone', () => {
    test('a list with content is not touched', () => {
      assert.strictEqual(emptyOrderedListText(tok('1. real item')), null);
    });

    test('a list is kept when only SOME items are empty', () => {
      // The empty middle item is a real, if odd, list item. Rewriting the whole
      // list to a paragraph here would destroy the two items that have content.
      assert.strictEqual(emptyOrderedListText(tok('1. real\n2.\n3. also real')), null);
    });

    test('a high-numbered genuine list is kept, since that is the padding guard\'s job', () => {
      assert.strictEqual(emptyOrderedListText(tok('4471. real item')), null);
    });

    test('an unordered list is never rewritten', () => {
      // Scoped deliberately to ordered lists. A bullet marker is narrow enough
      // that it never escapes the bubble, so there is no bug to fix, and a lone
      // `-` is more plausibly deliberate than a lone number.
      assert.strictEqual(emptyOrderedListText(tok('-')), null);
    });
  });

  describe('inputs markdown already treats as prose are unreachable, and stay that way', () => {
    // These are the false positives that would matter most. They never reach
    // the list renderer at all, and this pins that.
    for (const src of ['Q3 was 4471.', 'v1.', '4471. ']) {
      test(`${JSON.stringify(src)} parses as a paragraph, not a list`, () => {
        assert.notStrictEqual(tok(src).type, 'list');
      });
    }
  });

  describe('total: it runs on every list the renderer sees', () => {
    test('returns null rather than throwing on a malformed or foreign token', () => {
      for (const junk of [null, undefined, {}, { type: 'list' }, { type: 'list', items: null }, 'nonsense', 42]) {
        assert.strictEqual(emptyOrderedListText(junk), null);
      }
    });
  });
});
