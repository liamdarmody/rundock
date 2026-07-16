// Sidecar review controller: interface parity with the markdown review
// controller, quote anchoring with orphan handling, the c1 handback
// contract (same { review, comments, suggestions } shape as the shipped
// file-level loop), and byte-stable serialization.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSidecarController, parseSidecar, sidecarNameFor, sidecarPathFor, SIDECAR_FORMAT,
} from '../../public/viewers/sidecar-controller.js';

const DOC = 'Quarterly Proposal. Three workstreams. Budget: 42% up. Risks: 42% flagged.';
const index = { text: DOC };
const fixedNow = () => '2026-07-16T12:00:00Z';

function fresh(content = null, opts = {}) {
  return createSidecarController({ path: 'proposal.html', content, index, author: 'liam', now: fixedNow, ...opts });
}

describe('sidecar naming', () => {
  test('deterministic, readable, collision-hashed', () => {
    const name = sidecarNameFor('docs/proposal.html');
    assert.match(name, /^docs__proposal\.html-[0-9a-f]{8}\.json$/);
    assert.equal(sidecarNameFor('docs/proposal.html'), name);
    assert.notEqual(sidecarNameFor('docs_proposal.html'), name, 'slug twins differ by hash');
    assert.equal(sidecarPathFor('a.html'), `.rundock/reviews/${sidecarNameFor('a.html')}`);
  });
});

describe('parseSidecar', () => {
  test('missing/empty content is a fresh store, not corrupt', () => {
    assert.equal(parseSidecar(null, 'a.html').corrupt, false);
    assert.equal(parseSidecar('  ', 'a.html').data.format, SIDECAR_FORMAT);
  });

  test('unparseable content flags corrupt instead of silently overwriting', () => {
    const res = parseSidecar('not json {', 'a.html');
    assert.equal(res.corrupt, true);
    assert.deepEqual(res.data.comments, {});
  });
});

describe('comments: add, reply, resolve', () => {
  test('anchored comment stores selector and lists in document order', () => {
    const c = fresh();
    const id1 = c.addComment('tighten this', { quote: 'Budget: 42% up', prefix: 'workstreams. ', suffix: '. Risks' });
    const id2 = c.addComment('rename the headline', { quote: 'Quarterly Proposal', prefix: '', suffix: '. Three' });
    assert.ok(id1 && id2);
    const items = c.listItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].anchor, 'Quarterly Proposal', 'sorted by located position, not insertion order');
    assert.equal(items[1].text, 'tighten this');
    assert.equal(items[0].meta.by, 'liam');
    assert.equal(items[0].orphaned, false);
  });

  test('document-level comment (no selection) pins to the top and never orphans', () => {
    const c = fresh();
    c.addComment('overall: strong draft');
    c.addComment('anchored', { quote: 'Three workstreams' });
    const items = c.listItems();
    assert.equal(items[0].text, 'overall: strong draft');
    assert.equal(items[0].anchor, null);
    assert.equal(items[0].orphaned, false);
  });

  test('replies attach to root comments only and render inside the parent', () => {
    const c = fresh();
    const parent = c.addComment('anchored', { quote: 'Three workstreams' });
    const rid = c.reply(parent, 'agree, will fix');
    assert.ok(rid);
    assert.equal(c.reply(rid, 'reply to a reply'), false, 'one level of threading');
    assert.equal(c.reply('c99', 'phantom parent'), false);
    const items = c.listItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].replies.length, 1);
    assert.equal(items[0].replies[0].body, 'agree, will fix');
  });

  test('resolve removes the card, keeps the audit trail, refuses double-resolve', () => {
    const c = fresh();
    const id = c.addComment('fix me', { quote: 'Three workstreams' });
    assert.equal(c.resolve(id), true);
    assert.equal(c.listItems().length, 0);
    assert.equal(c.getData().comments[id].resolved, true);
    assert.equal(c.getData().comments[id].body, 'fix me', 'body preserved for audit');
    assert.equal(c.resolve(id), false);
    assert.equal(c.resolve('nope'), false);
  });

  test('duplicate quotes anchor to the context-matching occurrence', () => {
    const c = fresh();
    c.addComment('the risk one', { quote: '42%', prefix: 'Risks: ', suffix: ' flagged' });
    const item = c.listItems()[0];
    assert.equal(DOC.slice(item.pos - 7, item.pos), 'Risks: ');
  });
});

describe('orphans', () => {
  test('an anchor missing from the document lists as orphaned at the end, never dropped', () => {
    const stored = JSON.stringify({
      format: SIDECAR_FORMAT, path: 'proposal.html',
      comments: {
        c1: { quote: 'PASSAGE THE AGENT DELETED', prefix: '', suffix: '', body: 'still matters', by: 'penn', at: '2026-07-15T09:00:00Z' },
        c2: { quote: 'Three workstreams', prefix: '', suffix: '', body: 'live one', by: 'liam', at: '2026-07-15T09:01:00Z' },
      },
      suggestions: {}, review: {},
    });
    const c = fresh(stored);
    const items = c.listItems();
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'live one');
    assert.equal(items[1].orphaned, true);
    assert.equal(items[1].text, 'still matters');
  });
});

describe('suggestion operations refuse (comment-only surface)', () => {
  test('accept/reject/release/suggest all return false and change nothing', () => {
    const c = fresh();
    assert.equal(c.accept('s1'), false);
    assert.equal(c.reject('s1'), false);
    assert.equal(c.release('s1'), false);
    assert.equal(c.suggestReplace('x'), false);
    assert.equal(c.suggestInsert('x'), false);
    assert.equal(c.isDirty(), false);
  });
});

describe('the c1 handback contract', () => {
  test('doneReviewing returns the same payload shape as the markdown loop', () => {
    const c = fresh();
    const a = c.addComment('fix the budget line', { quote: 'Budget: 42% up' });
    c.reply(a, 'noted');
    c.resolve(a);
    c.addComment('open question', { quote: 'Three workstreams' });
    const payload = c.doneReviewing();
    // Exact top-level shape: review { status, at, summary }, comments, suggestions.
    assert.deepEqual(Object.keys(payload).sort(), ['comments', 'review', 'suggestions']);
    assert.equal(payload.review.status, 'done');
    assert.equal(payload.review.at, fixedNow());
    assert.deepEqual(payload.review.summary, {
      suggestions: { accepted: 0, rejected: 0, open: 0 },
      comments: { resolved: 1, open: 1, replies: 1 },
    });
    assert.deepEqual(payload.suggestions, {}, 'empty map, same key as markdown handback');
  });

  test('review stamp persists into the serialized sidecar', () => {
    const c = fresh();
    c.addComment('x', { quote: 'Three workstreams' });
    c.doneReviewing();
    const reparsed = JSON.parse(c.serialize());
    assert.equal(reparsed.review.status, 'done');
    assert.equal(reparsed.format, SIDECAR_FORMAT);
    assert.equal(reparsed.path, 'proposal.html');
  });
});

describe('serialization stability', () => {
  test('load -> serialize round-trips stable bytes for untouched data', () => {
    const c1 = fresh();
    c1.addComment('one', { quote: 'Three workstreams' });
    const bytes = c1.serialize();
    const c2 = fresh(bytes);
    assert.equal(c2.isDirty(), false);
    assert.equal(c2.serialize(), bytes, 'no churn on an untouched reload');
  });

  test('ids continue existing numbering across sessions', () => {
    const c1 = fresh();
    c1.addComment('one');
    c1.addComment('two');
    const c2 = fresh(c1.serialize());
    const id = c2.addComment('three');
    assert.equal(id, 'c3');
  });
});
