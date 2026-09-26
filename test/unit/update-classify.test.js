'use strict';
// Classifying one item of a package update (B+, decided 2026-09-24): the
// base the package last wrote, the workspace now, and the author's new
// version decide the group, and the group decides everything else. There
// are no per-item choices: whatever the person changed is kept, and the
// author's version of it is saved for review instead.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { classifyUpdate } = require('../../lib/packages/update-classify.js');

const B = 'sha256:' + 'b'.repeat(64);
const L = 'sha256:' + 'c'.repeat(64);
const N = 'sha256:' + 'd'.repeat(64);
const item = (over) => ({ kind: 'agent', inPackage: true, base: B, live: B, incoming: N, gainsUnasked: false, ...over });
const expect = (over, group, decision, saveAuthor = false) => {
  assert.deepStrictEqual(classifyUpdate(item(over)), { group, decision, saveAuthor }, `${JSON.stringify(over)}`);
};

describe('the core groups, for agents and skills alike', () => {
  for (const kind of ['agent', 'skill']) {
    test(`${kind}: changed by the author only is updated`, () => expect({ kind }, 'author-changed', 'overwrite'));
    test(`${kind}: edited by the person only is kept, with nothing to save`, () => expect({ kind, live: L, incoming: B }, 'edited', 'skip'));
    test(`${kind}: changed on both sides is kept, and the author's version saved`, () => expect({ kind, live: L }, 'both-changed', 'skip', true));
    test(`${kind}: already matching the new version is written through, so the receipt's base moves on`, () => {
      expect({ kind, live: N }, 'matches', 'overwrite');
      expect({ kind, base: B, live: B, incoming: B }, 'matches', 'overwrite');
    });
  }
});

describe('the rest of the groups', () => {
  test('new in this version is added; new where the person already has something is kept, and the author\'s saved', () => {
    expect({ inPackage: false, base: null, live: 'absent' }, 'new', 'add');
    expect({ inPackage: false, base: null, live: L }, 'path-taken', 'skip', true);
    expect({ inPackage: false, base: null, live: N }, 'matches', 'overwrite');
  });

  test('removed by the person stays removed, whatever the author did', () => {
    expect({ live: 'absent' }, 'removed-by-you', 'skip');
    expect({ live: 'absent', incoming: B }, 'removed-by-you', 'skip');
  });

  test('an item this package never wrote, now absent, arrives as new', () => {
    expect({ base: null, live: 'absent' }, 'new', 'add');
  });

  test('no base to compare with: kept, and the author\'s version saved', () => {
    expect({ base: null, live: L }, 'unknown', 'skip', true);
  });

  test('no longer in the package: kept, and marked', () => {
    expect({ incoming: null }, 'retired', null);
    expect({ incoming: null, live: 'absent' }, 'retired', null);
  });

  test('a new version that gains a key acting without asking is never written by default', () => {
    expect({ gainsUnasked: true }, 'acts-without-asking', 'skip', true);
    expect({ gainsUnasked: true, inPackage: false, base: null, live: 'absent' }, 'acts-without-asking', 'skip', true);
  });
});

describe('starter files are never replaced', () => {
  test('a starter the author changed arrives alongside, whether or not the person edited it', () => {
    expect({ kind: 'starter' }, 'starter-alongside', 'skip');
    expect({ kind: 'starter', live: L }, 'starter-alongside', 'skip');
  });
  test('an unchanged or matching starter is left alone; a new one lands where nothing is', () => {
    expect({ kind: 'starter', incoming: B }, 'matches', 'skip');
    expect({ kind: 'starter', live: N }, 'matches', 'skip');
    expect({ kind: 'starter', inPackage: false, base: null, live: 'absent' }, 'new', 'add');
    expect({ kind: 'starter', live: 'absent' }, 'removed-by-you', 'skip');
  });
  test('no starter group ever decides overwrite', () => {
    for (const over of [{}, { live: L }, { live: N }, { base: null }, { base: null, live: L }, { gainsUnasked: true }]) {
      assert.notStrictEqual(classifyUpdate(item({ kind: 'starter', ...over })).decision, 'overwrite');
    }
  });
});

describe('classifyUpdate refuses what it cannot judge', () => {
  test('an unknown kind is refused', () => {
    assert.throws(() => classifyUpdate(item({ kind: 'widget' })), TypeError);
  });
});
