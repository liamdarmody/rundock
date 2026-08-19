// Round-trip cover for the document shape that broke the review layout:
// leading frontmatter, a body carrying several thematic breaks, and a review
// endmatter block. The layout fault was in the stylesheet, but the shape had
// no round-trip test of its own, so nothing would have caught a parse-order
// change made while chasing it. This closes that gap.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrip } from '../helpers/editor-harness.js';
import { parseFile } from '../../public/editor/markdown/pipeline.js';

const SECTIONED = [
  '---',
  'title: Reviewed Sections',
  'related:',
  '  - "[[Roadmap-2026]]"',
  'tags:',
  '  - product',
  '---',
  '',
  '# Reviewed Sections',
  '',
  'The {==first paragraph==}{>>does this still read as the opening?<<}{#c1}, above the first break.',
  '',
  'The second paragraph, still above the first break.',
  '',
  '---',
  '',
  '## Section one',
  '',
  'Body text under the first thematic break.',
  '',
  '---',
  '',
  '## Section two',
  '',
  'Body text under the second thematic break.',
  '',
  '---',
  'comments:',
  '  c1:',
  '    by: liam',
  '    at: "2026-08-18T10:00:00Z"',
  'review:',
  '  status: in-review',
  '  at: "2026-08-18T10:00:00Z"',
  '',
].join('\n');

describe('a sectioned document under review', () => {
  test('round-trips byte-for-byte', async () => {
    assert.equal(await roundTrip(SECTIONED), SECTIONED);
  });

  test('splits into frontmatter, body and endmatter, with the breaks in the body', () => {
    const parts = parseFile(SECTIONED);

    assert.ok(parts.raw.startsWith('---\ntitle: Reviewed Sections'));
    assert.equal(parts.parsed.title, 'Reviewed Sections');

    // The endmatter is the review block at the end, not a body thematic break.
    assert.ok(parts.endmatter.raw.startsWith('---\ncomments:'));
    assert.equal(parts.endmatter.data.comments.c1.by, 'liam');

    // Both body thematic breaks stay in the body. The document authors three
    // `---` lines after the frontmatter; the last one opens the endmatter, and
    // the other two are content that must not be mistaken for it.
    const breaks = parts.body.split('\n').filter((line) => line === '---');
    assert.equal(breaks.length, 2);
    assert.ok(parts.body.startsWith('# Reviewed Sections'));
    assert.ok(parts.body.includes('## Section two'));
  });

  test('reassembles to the original bytes', () => {
    const parts = parseFile(SECTIONED);
    const rebuilt = parts.raw + parts.body + parts.trailingBody + parts.endmatter.raw + parts.trailing;
    assert.equal(rebuilt, SECTIONED);
  });

  test('the same body without review data round-trips too', async () => {
    const plain = SECTIONED.slice(0, SECTIONED.indexOf('\n---\ncomments:'))
      .replace('{==first paragraph==}{>>does this still read as the opening?<<}{#c1}', 'first paragraph') + '\n';
    assert.equal(await roundTrip(plain), plain);
  });
});
