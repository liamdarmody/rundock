// YAML endmatter contract (FV1 Build 2a).
//
// Review metadata lives in a final YAML block introduced by a `---` line at
// the end of the file (Roughdraft wire format): comments/suggestions keyed by
// anchor id with by/at (+ re for replies), plus FV1's review block (status +
// verdict summary). The block is opaque to the markdown editor: stripped
// before parse, re-emitted verbatim on save unless review data changed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEndmatter, buildEndmatter, hasReviewData,
} from '../../public/editor/review/endmatter.js';

const DOC = `# Draft

Review {==this==}{>>needs a source<<}{#c1}.

---
comments:
  c1:
    by: liam
    at: "2026-07-12T10:00:00.000Z"
suggestions:
  s1:
    by: penn
    at: "2026-07-12T10:05:00.000Z"`;

describe('extractEndmatter', () => {
  test('splits body and endmatter, parsing the YAML', () => {
    const { body, raw, data } = extractEndmatter(DOC);
    assert.equal(body, '# Draft\n\nReview {==this==}{>>needs a source<<}{#c1}.\n\n');
    assert.ok(raw.startsWith('---\ncomments:'));
    assert.equal(data.comments.c1.by, 'liam');
    assert.equal(data.suggestions.s1.by, 'penn');
  });

  test('body + raw reassemble to the exact original', () => {
    const { body, raw } = extractEndmatter(DOC);
    assert.equal(body + raw, DOC);
  });

  test('a document with no endmatter returns it all as body', () => {
    const src = '# Plain\n\nNothing here.\n\n---\n\nJust a thematic break.';
    const { body, raw, data } = extractEndmatter(src);
    assert.equal(body, src);
    assert.equal(raw, '');
    assert.equal(data, null);
  });

  test('a final --- whose YAML is not review data stays body', () => {
    const src = '# Doc\n\n---\ntitle: not review data\nweight: 3';
    const { body, raw, data } = extractEndmatter(src);
    assert.equal(body, src);
    assert.equal(raw, '');
    assert.equal(data, null);
  });

  test('review-status-only endmatter is recognised', () => {
    const src = '# Doc\n\n---\nreview:\n  status: done\n  at: "2026-07-12T11:00:00.000Z"';
    const { data } = extractEndmatter(src);
    assert.equal(data.review.status, 'done');
  });
});

describe('buildEndmatter', () => {
  test('serializes review data as a --- introduced YAML block', () => {
    const data = {
      comments: { c1: { body: 'needs a source', by: 'liam', at: '2026-07-12T10:00:00.000Z' } },
    };
    const raw = buildEndmatter(data);
    assert.ok(raw.startsWith('---\n'));
    const back = extractEndmatter('Body.\n\n' + raw);
    assert.deepEqual(back.data, data);
  });

  test('round-trips bodies with tricky YAML characters', () => {
    const data = {
      comments: { c1: { body: 'colons: quotes " and\nnewlines', by: 'liam', at: 'x' } },
    };
    const back = extractEndmatter('B.\n\n' + buildEndmatter(data));
    assert.equal(back.data.comments.c1.body, 'colons: quotes " and\nnewlines');
  });

  test('empty data returns an empty string', () => {
    assert.equal(buildEndmatter(null), '');
    assert.equal(buildEndmatter({}), '');
    assert.equal(buildEndmatter({ comments: {}, suggestions: {} }), '');
  });
});

describe('hasReviewData', () => {
  test('true only when comments, suggestions, or review carry entries', () => {
    assert.equal(hasReviewData({ comments: { c1: {} } }), true);
    assert.equal(hasReviewData({ suggestions: { s1: {} } }), true);
    assert.equal(hasReviewData({ review: { status: 'done' } }), true);
    assert.equal(hasReviewData({ comments: {} }), false);
    assert.equal(hasReviewData(null), false);
  });
});
