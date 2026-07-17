'use strict';
// Server-side store for conversation Lists: .rundock/lists.json registry plus
// listIds membership on conversation entries. Pins the card's safety property:
// deleting a list strips membership everywhere but never touches the
// conversations themselves.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');

let tmpDir, prevWorkspace;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-lists-'));
  prevWorkspace = srv.getWorkspace();
  srv.setWorkspace(tmpDir);
});
afterEach(() => {
  srv.setWorkspace(prevWorkspace);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('lists registry (.rundock/lists.json)', () => {
  test('read/write round-trip', () => {
    const lists = [{ id: 'l1', name: 'Client work', createdAt: '2026-07-17T00:00:00.000Z' }];
    srv.writeLists(lists);
    assert.deepStrictEqual(srv.readLists(), lists);
  });

  test('missing file reads as empty', () => {
    assert.deepStrictEqual(srv.readLists(), []);
  });

  test('corrupted or non-array files read as empty; malformed entries are dropped', () => {
    fs.mkdirSync(path.join(tmpDir, '.rundock'), { recursive: true });
    const file = path.join(tmpDir, '.rundock', 'lists.json');
    fs.writeFileSync(file, 'nope {{{');
    assert.deepStrictEqual(srv.readLists(), []);
    fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
    assert.deepStrictEqual(srv.readLists(), []);
    fs.writeFileSync(file, JSON.stringify([{ id: 'ok', name: 'Fine' }, { id: 42 }, null, { name: 'no id' }]));
    assert.deepStrictEqual(srv.readLists().map(l => l.id), ['ok']);
  });
});

describe('deleteListEverywhere (the card\'s safety property)', () => {
  test('removes the registry entry and strips membership; conversations survive untouched', () => {
    srv.writeLists([
      { id: 'l1', name: 'Client work', createdAt: 'x' },
      { id: 'l2', name: 'Research', createdAt: 'x' },
    ]);
    srv.writeConversations([
      { id: 'c1', title: 'One', status: 'active', listIds: ['l1', 'l2'], pinned: true },
      { id: 'c2', title: 'Two', status: 'active', listIds: ['l1'] },
      { id: 'c3', title: 'Three', status: 'archived', listIds: ['l2'] },
      { id: 'c4', title: 'Legacy', status: 'active' },
    ]);

    srv.deleteListEverywhere('l1');

    assert.deepStrictEqual(srv.readLists().map(l => l.id), ['l2']);
    const convos = srv.readConversations();
    // Every conversation still exists with its other fields intact.
    assert.deepStrictEqual(convos.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);
    assert.strictEqual(convos.find(c => c.id === 'c1').pinned, true);
    // l1 stripped everywhere; l2 memberships untouched.
    assert.deepStrictEqual(convos.find(c => c.id === 'c1').listIds, ['l2']);
    assert.deepStrictEqual(convos.find(c => c.id === 'c2').listIds, []);
    assert.deepStrictEqual(convos.find(c => c.id === 'c3').listIds, ['l2']);
    assert.strictEqual(convos.find(c => c.id === 'c4').listIds, undefined);
  });

  test('deleting an unknown list id is a safe no-op', () => {
    srv.writeLists([{ id: 'l1', name: 'Keep', createdAt: 'x' }]);
    srv.writeConversations([{ id: 'c1', title: 'One', status: 'active', listIds: ['l1'] }]);
    srv.deleteListEverywhere('ghost');
    assert.deepStrictEqual(srv.readLists().map(l => l.id), ['l1']);
    assert.deepStrictEqual(srv.readConversations()[0].listIds, ['l1']);
  });
});
