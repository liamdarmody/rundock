// Review annotations in the file index. CriticMarkup constructs flatten to
// their text (so comment/suggestion content IS searchable) and the YAML
// endmatter is dropped (metadata is not content), so palette snippets never
// show raw review syntax. Order matters: endmatter goes before the
// frontmatter strip, or a body starting with a lone --- line loses
// everything up to the endmatter's introducing ---.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normaliseReviewContent } = require('../../search.js');

describe('normaliseReviewContent', () => {
  test('constructs flatten to their text', () => {
    const src = 'The page {~~is confusing~>buries the plan~~}{#s1} and we {++add a table++}{#s2} and drop {--the carousel--}.';
    const out = normaliseReviewContent(src);
    assert.equal(out, 'The page is confusing buries the plan and we add a table and drop the carousel.');
  });

  test('comment text stays searchable; anchors and markers do not', () => {
    const src = 'Review {==the intro==}{>>needs a source before we publish<<}{#c1} carefully.';
    const out = normaliseReviewContent(src);
    assert.equal(out, 'Review the intro needs a source before we publish carefully.');
    assert.ok(!out.includes('{'), 'no construct syntax survives');
  });

  test('endmatter is dropped entirely', () => {
    const src = 'Body text here.\n\n---\ncomments:\n  c1:\n    by: penn\n    at: "2026-07-12T10:00:00.000Z"\nsuggestions:\n  s1:\n    by: penn\n';
    const out = normaliseReviewContent(src);
    assert.ok(out.includes('Body text here.'));
    assert.ok(!out.includes('penn'), 'metadata is not content');
    assert.ok(!out.includes('comments:'));
  });

  test('a body starting with a lone --- keeps its content once endmatter is stripped', () => {
    // Regression (merge-gate finding): the frontmatter strip regex would
    // otherwise span from the leading --- to the endmatter delimiter and
    // eat the whole body.
    const src = '---\nNot frontmatter, just a rule below nothing.\n\nSearchable body.\n\n---\ncomments:\n  c1:\n    by: a\n';
    const out = normaliseReviewContent(src);
    assert.ok(out.includes('Searchable body.'));
    assert.ok(!out.includes('comments:'));
  });

  test('a first frontmatter key of comments/review/suggestions is not read as endmatter', () => {
    // The review endmatter is always preceded by body, so the opening
    // frontmatter delimiter at offset 0 must never be mistaken for it. A note
    // whose first property is comments/review/suggestions keeps its whole body.
    for (const key of ['comments', 'review', 'suggestions']) {
      const src = `---\n${key}: draft notes\nstatus: active\n---\n\nThe searchable body.`;
      const out = normaliseReviewContent(src);
      assert.ok(out.includes('The searchable body.'), `${key}: body retained`);
    }
  });

  test('a thematic break followed by prose is not endmatter', () => {
    const src = 'Intro.\n\n---\n\nMore prose after a horizontal rule.';
    assert.equal(normaliseReviewContent(src), src);
  });

  test('plain documents pass through untouched', () => {
    const src = '# Title\n\nOrdinary content with {braces} that are not constructs.';
    assert.equal(normaliseReviewContent(src), src);
  });
});
