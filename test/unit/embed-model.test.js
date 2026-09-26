'use strict';
// The rules of an embed row, pure (public/embed-model.js).
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/embed-model.js');

test('a paragraph of nothing but embeds is an embed row; anything else is not', () => {
  const three = M.embedsIn([{ text: '!' }, { target: 'a.csv' }, { text: ' !' }, { target: 'b.csv', alias: '400' }, { text: ' !' }, { target: 'Notes#Two' }]);
  assert.deepStrictEqual(three.map(e => [e.name, e.heading, e.height]), [['a.csv', null, 240], ['b.csv', null, 400], ['Notes', 'Two', 240]]);
  assert.strictEqual(M.embedsIn([{ text: 'see ' }, { text: '!' }, { target: 'a' }]), null, 'an embed inside a sentence stays a link');
  assert.strictEqual(M.embedsIn([{ target: 'a' }]), null, 'a plain link is not an embed');
  assert.strictEqual(M.embedsIn([{ text: '!' }]), null);
  assert.strictEqual(M.embedsIn([]), null);
});

test('at most three sit side by side', () => {
  const four = [1, 2, 3, 4].map(n => M.spec(`f${n}.csv`));
  assert.deepStrictEqual(M.rows(four).map(r => r.length), [3, 1]);
});

test('the height is bounded, and only a number sets it', () => {
  assert.strictEqual(M.heightOf('10'), M.MIN_HEIGHT);
  assert.strictEqual(M.heightOf('5000'), M.MAX_HEIGHT);
  assert.strictEqual(M.heightOf('wide'), M.DEFAULT_HEIGHT);
});

test('a name with an extension is looked up as written; a bare name is a note', () => {
  assert.strictEqual(M.searchName('holdings.csv'), 'holdings.csv');
  assert.strictEqual(M.searchName('Risk notes'), 'Risk notes.md');
});

test('what a panel shows: never blank, never itself, never a hidden file', () => {
  assert.strictEqual(M.panelFor({ path: null }).kind, 'missing');
  assert.strictEqual(M.panelFor({ path: 'a.md', owner: 'a.md' }).kind, 'link', 'a file embedding itself renders once, then a link');
  assert.strictEqual(M.panelFor({ path: '.claude/x.md', owner: 'a.md', hidden: true, claimed: true }).kind, 'link');
  assert.strictEqual(M.panelFor({ path: 'h.csv', owner: 'a.md', claimed: true }).kind, 'extension');
  assert.strictEqual(M.panelFor({ path: 's.pdf', owner: 'a.md' }).kind, 'link', 'an unclaimed binary target is a link');
  assert.strictEqual(M.panelFor({ path: 'n.md', owner: 'a.md' }).kind, 'markdown');
  assert.strictEqual(M.panelFor({ path: 'n.txt', owner: 'a.md' }).kind, 'text', 'an unclaimed text target shows its content');
});
