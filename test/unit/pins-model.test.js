'use strict';
// What a pin is, and what the list of them does.
//
// EVERY RULE THE PINS LIST IS JUDGED ON LIVES IN THE MODEL, not in the render,
// for the reason the routines list and the skills pane give: a rule written
// inline in a DOM function is reachable only by a browser, and a rule only a
// browser can reach is one nobody keeps. Pulled out into public/pins-model.js,
// the ordering, the idempotent add, the order-preserving remove and the
// reconciliation against the tree can each be asserted on a plain array.
//
// THE ORDER IS THE ORDER THEY WERE PINNED, earliest first. A pinned list is a
// short list of working surfaces, and the position a reader learned for one
// has to stay where it was when they pin another. Nothing here sorts.
//
// RECONCILE NAMES WHAT IS MISSING AND REMOVES NOTHING. A pinned file deleted
// or renamed outside Rundock is still a decision the reader made, so the model
// marks the row rather than dropping it; the view decides what a marked row
// looks like (a struck name and an explicit Remove, per the mock) and the
// store is only ever written by a message the reader sent.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const m = require(path.join(__dirname, '..', '..', 'public', 'pins-model.js'));

const TREE = [
  { type: 'folder', name: 'notes', path: 'notes', children: [
    { type: 'file', name: 'backlog.md', kind: 'note', path: 'notes/backlog.md' },
    { type: 'folder', name: 'deep', path: 'notes/deep', children: [
      { type: 'file', name: 'board.md', kind: 'board', path: 'notes/deep/board.md' },
    ] },
  ] },
  { type: 'file', name: 'Roadmap.md', kind: 'note', path: 'Roadmap.md' },
  { type: 'file', name: 'dash.html', kind: 'artifact', path: 'dash.html' },
];

describe('the list is a list of paths in the order they were pinned', () => {
  test('add appends at the end, so earlier pins keep their place', () => {
    let pins = [];
    pins = m.add(pins, 'Roadmap.md');
    pins = m.add(pins, 'notes/backlog.md');
    pins = m.add(pins, 'dash.html');
    assert.deepStrictEqual(pins, ['Roadmap.md', 'notes/backlog.md', 'dash.html']);
  });

  test('add is idempotent for a path already pinned, and moves nothing', () => {
    const pins = ['Roadmap.md', 'notes/backlog.md'];
    assert.deepStrictEqual(m.add(pins, 'Roadmap.md'), ['Roadmap.md', 'notes/backlog.md']);
    assert.deepStrictEqual(m.add(pins, 'notes/backlog.md'), ['Roadmap.md', 'notes/backlog.md']);
  });

  test('add never mutates the list it was given', () => {
    const pins = ['Roadmap.md'];
    const next = m.add(pins, 'dash.html');
    assert.deepStrictEqual(pins, ['Roadmap.md']);
    assert.notStrictEqual(next, pins);
  });

  test('remove drops the one path and keeps the order of the rest', () => {
    const pins = ['Roadmap.md', 'notes/backlog.md', 'dash.html'];
    assert.deepStrictEqual(m.remove(pins, 'notes/backlog.md'), ['Roadmap.md', 'dash.html']);
    assert.deepStrictEqual(m.remove(pins, 'nowhere.md'), pins, 'removing an unpinned path changes nothing');
    assert.deepStrictEqual(pins, ['Roadmap.md', 'notes/backlog.md', 'dash.html'], 'the input is untouched');
  });

  test('has answers by exact path', () => {
    const pins = ['Roadmap.md', 'notes/backlog.md'];
    assert.strictEqual(m.has(pins, 'Roadmap.md'), true);
    assert.strictEqual(m.has(pins, 'roadmap.md'), false, 'paths are compared as the tree names them');
    assert.strictEqual(m.has(pins, ''), false);
    assert.strictEqual(m.has(null, 'Roadmap.md'), false);
  });

  // The store reads a file a person may have edited by hand, and the wire
  // carries whatever a client sent. Junk in yields a list of strings out, in
  // the order the first occurrence of each arrived.
  test('normalize keeps strings, drops empties and duplicates, and keeps first-seen order', () => {
    assert.deepStrictEqual(
      m.normalize(['b.md', '', 'a.md', null, 'b.md', 7, ' ', 'c.md']),
      ['b.md', 'a.md', 'c.md']);
    assert.deepStrictEqual(m.normalize(undefined), []);
    assert.deepStrictEqual(m.normalize('a.md'), [], 'a bare string is not a list');
  });

  test('add and remove refuse a path that is not a non-empty string', () => {
    assert.deepStrictEqual(m.add(['a.md'], ''), ['a.md']);
    assert.deepStrictEqual(m.add(['a.md'], null), ['a.md']);
    assert.deepStrictEqual(m.remove(['a.md'], undefined), ['a.md']);
  });
});

describe('reconcile reads the list against the tree', () => {
  test('rows come back in pin order, flat, with the tree\'s own name and kind', () => {
    const rows = m.reconcile(['dash.html', 'notes/deep/board.md', 'Roadmap.md'], TREE);
    assert.deepStrictEqual(rows.map(r => r.path), ['dash.html', 'notes/deep/board.md', 'Roadmap.md'],
      'pin order, never tree order');
    assert.deepStrictEqual(rows.map(r => r.kind), ['artifact', 'board', 'note']);
    assert.deepStrictEqual(rows.map(r => r.name), ['dash.html', 'board.md', 'Roadmap.md']);
    assert.deepStrictEqual(rows.map(r => r.folder), ['', 'notes/deep', '']);
    assert.ok(rows.every(r => r.missing === false));
  });

  test('a pin the tree no longer carries is marked missing, and stays', () => {
    const rows = m.reconcile(['Roadmap.md', 'notes/gone.md'], TREE);
    assert.strictEqual(rows.length, 2, 'reconcile removes nothing');
    assert.deepStrictEqual(rows[1], { path: 'notes/gone.md', name: 'gone.md', folder: 'notes', kind: 'file', missing: true });
    assert.strictEqual(rows[0].missing, false);
  });

  test('a folder is never a pin row, even if its path is in the list', () => {
    const rows = m.reconcile(['notes'], TREE);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].missing, true, 'a folder path resolves to no file, so it reads as missing');
  });

  // Before the first tree arrives nothing is known about the workspace, so
  // nothing is claimed to be missing: a list drawn as all-missing for the
  // half second before the tree lands would teach the reader that Rundock
  // loses pins.
  test('with no tree yet, every pin is present by default', () => {
    const rows = m.reconcile(['Roadmap.md', 'notes/gone.md'], null);
    assert.deepStrictEqual(rows.map(r => r.missing), [false, false]);
    assert.deepStrictEqual(rows.map(r => r.name), ['Roadmap.md', 'gone.md']);
  });

  test('an empty tree that has arrived marks every pin missing', () => {
    const rows = m.reconcile(['Roadmap.md'], []);
    assert.deepStrictEqual(rows.map(r => r.missing), [true]);
  });

  test('firstOpenable is the first row that is not missing, or null', () => {
    const rows = m.reconcile(['notes/gone.md', 'Roadmap.md', 'dash.html'], TREE);
    assert.strictEqual(m.firstOpenable(rows).path, 'Roadmap.md');
    assert.strictEqual(m.firstOpenable(m.reconcile(['notes/gone.md'], TREE)), null);
    assert.strictEqual(m.firstOpenable([]), null);
  });
});

describe('the words the empty state ships', () => {
  // The four-slot pattern of the empty-states card: what is true, what the
  // thing is for, what to do next, and an optional aside. The next step has
  // to name BOTH ways to pin, because the header control is the one a
  // non-technical reader will find and right-click is the one they will not.
  test('the state line says what is true', () => {
    assert.strictEqual(m.EMPTY.lead, 'Nothing pinned yet.');
  });

  test('the next step names the header control and the right-click row', () => {
    assert.match(m.EMPTY.nextStep, /header/);
    assert.match(m.EMPTY.nextStep, /right-click/);
  });

  test('the empty state is mechanism then next step, with an aside about where pins live', () => {
    const state = m.emptyState();
    assert.strictEqual(state.lead, m.EMPTY.lead);
    assert.strictEqual(state.body, `${m.EMPTY.mechanism} ${m.EMPTY.nextStep}`);
    assert.strictEqual(state.aside, m.EMPTY.aside);
    assert.match(state.aside, /this machine/);
  });

  test('no dash of either width reaches any shipped string', () => {
    for (const s of [m.EMPTY.lead, m.EMPTY.mechanism, m.EMPTY.nextStep, m.EMPTY.aside, m.MISSING_NOTE, m.ALL_MISSING]) {
      assert.doesNotMatch(s, /[\u2013\u2014]/, `${s}: an en or em dash`);
    }
  });

  test('the missing note says the file could not be found and why that might be', () => {
    assert.match(m.MISSING_NOTE, /not found/i);
    assert.match(m.MISSING_NOTE, /moved|deleted/i);
  });
});

describe('the glyph is the one the conversation list already draws', () => {
  // ONE PIN SHAPE EVERYWHERE IT APPEARS. The rail, the sidebar rows, the
  // header control and the context menu all draw this path, and it is the
  // pushpin the conversation list has drawn for its own pins since before
  // this feature existed. A second pin-shaped glyph would be a second thing
  // to learn for one meaning.
  test('the glyph paths are the conversation pin indicator\'s paths', () => {
    const fs = require('node:fs');
    const conversations = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'conversations.js'), 'utf-8');
    assert.ok(conversations.includes(m.GLYPH),
      'conversations.js no longer draws the pin glyph pins-model.js carries; the two must be one shape');
  });

  test('the glyph is drawn outline or filled from one path', () => {
    assert.ok(m.glyphSvg(false).includes('fill="none"'));
    assert.ok(m.glyphSvg(true).includes('fill="currentColor"'));
    assert.ok(m.glyphSvg(true).includes(m.GLYPH) && m.glyphSvg(false).includes(m.GLYPH));
    assert.ok(m.glyphSvg(false, 'pin-static').includes('class="pin-static"'));
  });
});
