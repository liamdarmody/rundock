'use strict';
// Unit tests for public/palette-model.js: the universal-search palette model.
// Grouping, counts-as-floors, recent labelling, selection wrap, stale-reply
// guarding, highlight conversion, and anchor matching are the extraction
// contract with app.js's shipped behaviour (SR1).
const { test, describe } = require('node:test');
const assert = require('node:assert');

const P = require('../../public/palette-model.js');

const HL_OPEN = String.fromCharCode(1);
const HL_CLOSE = String.fromCharCode(2);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('flattenReply', () => {
  const reply = {
    groups: {
      files: [{ type: 'file', path: 'a.md' }, { type: 'file', path: 'b.md' }],
      agents: [{ type: 'agent', name: 'Cos' }],
      conversations: [],
    },
  };

  test('groups follow the fixed order and empty groups are skipped', () => {
    const { groups, flat } = P.flattenReply(reply, 'all');
    assert.deepStrictEqual(groups.map(g => g.key), ['files', 'agents']);
    assert.strictEqual(flat.length, 3);
    assert.deepStrictEqual(groups.map(g => g.startIdx), [0, 2]);
  });

  test('a non-all scope shows only its own group', () => {
    const { groups } = P.flattenReply(reply, 'agents');
    assert.deepStrictEqual(groups.map(g => g.key), ['agents']);
  });

  test('a full group shows its count as a floor', () => {
    const full = { groups: { files: Array.from({ length: P.GROUP_LIMIT }, (_, i) => ({ path: String(i) })) } };
    const { groups } = P.flattenReply(full, 'all');
    assert.strictEqual(groups[0].countLabel, `${P.GROUP_LIMIT}+`);
    const partial = { groups: { files: [{ path: 'x' }] } };
    assert.strictEqual(P.flattenReply(partial, 'all').groups[0].countLabel, '1');
  });

  test('recent replies relabel groups', () => {
    const recent = { recent: true, groups: { files: [{ path: 'x' }] } };
    assert.strictEqual(P.flattenReply(recent, 'all').groups[0].label, 'Recent files');
    assert.strictEqual(P.flattenReply({ groups: { files: [{ path: 'x' }] } }, 'all').groups[0].label, 'Files');
  });

  test('a null reply flattens to nothing', () => {
    assert.deepStrictEqual(P.flattenReply(null, 'all'), { groups: [], flat: [] });
  });
});

describe('emptyState', () => {
  test('server errors never masquerade as no-matches', () => {
    assert.strictEqual(P.emptyState({ error: true }, 'query'), 'error');
  });
  test('a query with no results is no-matches; no query is start-typing', () => {
    assert.strictEqual(P.emptyState({}, 'abc'), 'no-matches');
    assert.strictEqual(P.emptyState({}, '   '), 'start-typing');
    assert.strictEqual(P.emptyState({}, ''), 'start-typing');
  });
});

describe('moveSelection', () => {
  test('wraps in both directions', () => {
    assert.strictEqual(P.moveSelection(0, -1, 5), 4);
    assert.strictEqual(P.moveSelection(4, 1, 5), 0);
    assert.strictEqual(P.moveSelection(2, 1, 5), 3);
  });
  test('empty list leaves the selection unchanged', () => {
    assert.strictEqual(P.moveSelection(3, 1, 0), 3);
  });
});

describe('isStaleReply', () => {
  test('drops replies whose request id is not the latest', () => {
    assert.strictEqual(P.isStaleReply({ reqId: 4 }, 5), true);
    assert.strictEqual(P.isStaleReply({ reqId: 5 }, 5), false);
    assert.strictEqual(P.isStaleReply(null, 5), true);
  });
});

describe('highlight conversion', () => {
  test('escapes HTML first, then swaps markers for mark tags', () => {
    const s = `<b>${HL_OPEN}hit${HL_CLOSE}</b>`;
    assert.strictEqual(P.highlightToMark(s, esc), '&lt;b&gt;<mark>hit</mark>&lt;/b&gt;');
  });
  test('snippetPlain strips markers; snippetFragment extracts the first pair', () => {
    const s = `before ${HL_OPEN}frag${HL_CLOSE} after`;
    assert.strictEqual(P.snippetPlain(s), 'before frag after');
    assert.strictEqual(P.snippetFragment(s), 'frag');
    assert.strictEqual(P.snippetFragment('no markers'), '');
  });
});

describe('anchor matching', () => {
  test('normalises to letters and digits across punctuation and case', () => {
    assert.strictEqual(P.normAnchorText('Two plus two... is FOUR!'), 'two plus two is four');
  });

  test('finds the message containing the snippet text', () => {
    const messages = ['first message', 'the codeword is HELIOTROPE, remember it', 'third'];
    const idx = P.findAnchorIndex(messages, { text: 'codeword is heliotrope', fragment: '' });
    assert.strictEqual(idx, 1);
  });

  test('falls back to the highlighted fragment when the snippet misses', () => {
    const messages = ['alpha', 'bravo charlie'];
    const idx = P.findAnchorIndex(messages, { text: 'not present anywhere', fragment: 'charlie' });
    assert.strictEqual(idx, 1);
  });

  test('short needles are ignored and a miss returns -1', () => {
    assert.strictEqual(P.findAnchorIndex(['abc def'], { text: 'xy', fragment: '' }), -1);
    assert.strictEqual(P.findAnchorIndex(['abc'], { text: 'missing needle', fragment: '' }), -1);
  });
});
