// CriticMarkup parser/serializer contract.
//
// Wire format (CriticMarkup-based, live-proven): five constructs
//   {>>comment<<}  {++insert++}  {--delete--}  {~~old~>new~~}  {==highlight==}
// each optionally anchored with an id suffix {#c1} / {#s1}.
//
// Hard bar: serializeInline(parseInline(text)) === text for ANY input.
// Constructs do not nest; unterminated or malformed constructs stay literal.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, serializeInline, groupAnnotations } from '../../public/editor/review/criticmarkup.js';

function types(segments) { return segments.map((s) => s.type); }

describe('parseInline: the five constructs', () => {
  test('comment with id', () => {
    const segs = parseInline('Add {>>one concrete example here<<}{#c1} before the end.');
    assert.deepEqual(types(segs), ['text', 'comment', 'text']);
    assert.equal(segs[1].content, 'one concrete example here');
    assert.equal(segs[1].id, 'c1');
  });

  test('insertion and deletion', () => {
    const segs = parseInline('Add {++new text++}{#s1} and drop {--old text--}.');
    assert.deepEqual(types(segs), ['text', 'insert', 'text', 'delete', 'text']);
    assert.equal(segs[1].content, 'new text');
    assert.equal(segs[1].id, 's1');
    assert.equal(segs[3].content, 'old text');
    assert.equal(segs[3].id, null);
  });

  test('substitution splits on the first ~>', () => {
    const segs = parseInline('The intro {~~is vague~>needs a tighter claim~~}{#s2}.');
    assert.deepEqual(types(segs), ['text', 'substitution', 'text']);
    assert.equal(segs[1].from, 'is vague');
    assert.equal(segs[1].to, 'needs a tighter claim');
    assert.equal(segs[1].id, 's2');
  });

  test('highlight', () => {
    const segs = parseInline('Review {==this sentence==}{>>Needs a source<<}{#c1}.');
    assert.deepEqual(types(segs), ['text', 'highlight', 'comment', 'text']);
    assert.equal(segs[1].content, 'this sentence');
    assert.equal(segs[2].id, 'c1');
  });

  test('plain text yields a single text segment', () => {
    const segs = parseInline('No review marks here at all.');
    assert.deepEqual(types(segs), ['text']);
  });
});

describe('parseInline: malformed input stays literal', () => {
  test('unterminated construct is literal text', () => {
    const segs = parseInline('An {++unterminated insert.');
    assert.deepEqual(types(segs), ['text']);
    assert.equal(segs[0].text, 'An {++unterminated insert.');
  });

  test('substitution without ~> is literal text', () => {
    const segs = parseInline('Not a real {~~substitution~~} without arrow.');
    assert.deepEqual(types(segs), ['text']);
  });

  test('constructs do not nest: inner markers are content', () => {
    const segs = parseInline('{>>outer {++inner++} still outer<<}');
    assert.deepEqual(types(segs), ['comment']);
    assert.equal(segs[0].content, 'outer {++inner++} still outer');
  });

  test('stray braces and half-markers stay literal', () => {
    const src = 'Braces { } and {+ half + } and {>not a comment<}.';
    const segs = parseInline(src);
    assert.deepEqual(types(segs), ['text']);
    assert.equal(segs[0].text, src);
  });

  test('id without a preceding construct is literal', () => {
    const segs = parseInline('A bare {#c1} anchor.');
    assert.deepEqual(types(segs), ['text']);
  });
});

describe('serializeInline: byte-exact inverse', () => {
  const cases = [
    'Add {>>a comment<<}{#c1} here.',
    '{++start insert++} and {--end delete--}{#s9}',
    'The {~~old~>new~~} swap, {==mark==}{>>why<<}{#c2} pair.',
    'Multi\nline {>>comment\nacross lines<<} test.',
    'Literal { braces } and {+half+} markers.',
    'An {++unterminated tail',
    'Adjacent {++a++}{--b--}{~~c~>d~~} constructs.',
    '',
  ];
  for (const src of cases) {
    test(`round-trips ${JSON.stringify(src.slice(0, 40))}`, () => {
      assert.equal(serializeInline(parseInline(src)), src);
    });
  }
});

describe('groupAnnotations', () => {
  test('a highlight followed by a comment forms one anchored annotation', () => {
    const segs = parseInline('Review {==this sentence==}{>>Needs a source<<}{#c1}. More.');
    const groups = groupAnnotations(segs);
    const anchored = groups.find((g) => g.type === 'anchored-comment');
    assert.ok(anchored, 'expected an anchored-comment group');
    assert.equal(anchored.highlight.content, 'this sentence');
    assert.equal(anchored.comment.id, 'c1');
  });

  test('a standalone comment groups alone', () => {
    const segs = parseInline('Add {>>example<<}{#c3} here.');
    const groups = groupAnnotations(segs);
    assert.ok(groups.some((g) => g.type === 'comment' && g.comment.id === 'c3'));
  });
});
