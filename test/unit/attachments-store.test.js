'use strict';
// The attachments store: the files a person attaches to a conversation, kept
// under .rundock/attachments/<id>/ exactly as sent, with a record of each
// message's files. An agent can write anything in the workspace, so every
// test here plants what an agent could (a link, a file at the next name, a
// junk record) and checks that the store neither follows it nor trusts it.

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Loaded so that a missing module fails each test on its first assertion,
// never on the require.
const store = (() => {
  try { return require('../../lib/attachments/store.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]store/.test(String(e.message))) return null;
    throw e;
  }
})();
const ready = (name) => assert.strictEqual(typeof (store && store[name]), 'function');

const BAD_IDS = ['../..', 'a/b', 'a.b', '', 'abc\n', ['alpha'], null, 'a'.repeat(65)];
const LONGEST_ID = 'a'.repeat(64);

// A promise and the function that settles it, for holding a lock open.
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('ID_PATTERN', () => {
  test('accepts letters, digits, - and _ up to 64 characters', () => {
    assert.ok(store && store.ID_PATTERN instanceof RegExp, 'ID_PATTERN is a regular expression');
    for (const id of ['alpha', 'Beta_2', 'x-y', '0', LONGEST_ID]) assert.ok(store.ID_PATTERN.test(id), id);
  });

  test('refuses a 65-character ID and every string with anything else in it', () => {
    assert.ok(store && store.ID_PATTERN instanceof RegExp, 'ID_PATTERN is a regular expression');
    for (const id of BAD_IDS.filter((x) => typeof x === 'string')) assert.ok(!store.ID_PATTERN.test(id), JSON.stringify(id));
  });
});

describe('storedBase: the original name made safe for a stored name', () => {
  test('a composed and a decomposed name give the same base', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('café.png'), 'caf_');
    assert.strictEqual(store.storedBase('café.png'), 'caf_');
  });

  test('spaces and inner dots become _, and only the last dot and after it go', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('Screen Shot 2026-11-24 at 10.15.32.png'), 'Screen_Shot_2026-11-24_at_10_15_32');
    assert.strictEqual(store.storedBase('a.tar.gz'), 'a_tar');
  });

  test('a path in the name is flattened, its leading dots stripped and its separators collapsed', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('../../etc/passwd.png'), '_etc_passwd');
    assert.strictEqual(store.storedBase('..\\..\\notes.txt'), '_notes');
    assert.strictEqual(store.storedBase('.hidden.md'), 'hidden');
  });

  test('a name with nothing left, or one that is not text, becomes file', () => {
    ready('storedBase');
    for (const name of ['..', '', 42, null, undefined, ['notes.txt']]) assert.strictEqual(store.storedBase(name), 'file', String(name));
  });

  test('a reserved device name, in any case, is prefixed with _', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('CON.txt'), '_CON');
    assert.strictEqual(store.storedBase('lpt9.md'), '_lpt9');
    for (const name of ['prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1']) assert.strictEqual(store.storedBase(`${name}.pdf`), `_${name}`);
  });

  test('a name that only starts like a device name is left as it is', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('COM10.txt'), 'COM10');
    assert.strictEqual(store.storedBase('LPT0.txt'), 'LPT0');
    assert.strictEqual(store.storedBase('CONSOLE.txt'), 'CONSOLE');
  });

  test('a stem of 60 characters is kept whole', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase(`${'a'.repeat(60)}.png`), 'a'.repeat(60));
  });

  test('a stem of 61 characters is cut to 60', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase(`${'a'.repeat(61)}.png`), 'a'.repeat(60));
  });
});

describe('withConversationLock', () => {
  test('runs the calls for one ID one at a time, in the order they were made', async () => {
    ready('withConversationLock');
    const seen = [];
    const first = deferred();
    const a = store.withConversationLock('alpha', async () => { seen.push('a starts'); await first.promise; seen.push('a ends'); });
    const b = store.withConversationLock('alpha', () => { seen.push('b'); });
    const c = store.withConversationLock('alpha', async () => { seen.push('c'); });
    await turns();
    assert.deepStrictEqual(seen, ['a starts']);
    first.settle();
    await Promise.all([a, b, c]);
    assert.deepStrictEqual(seen, ['a starts', 'a ends', 'b', 'c']);
  });

  test('resolves to what the function returns or resolves to', async () => {
    ready('withConversationLock');
    assert.strictEqual(await store.withConversationLock('alpha', () => 7), 7);
    assert.deepStrictEqual(await store.withConversationLock('alpha', async () => ({ n: 8 })), { n: 8 });
  });

  test('releases when the function throws or rejects, and passes the error on', async () => {
    ready('withConversationLock');
    await assert.rejects(store.withConversationLock('alpha', () => { throw new Error('thrown'); }), /thrown/);
    await assert.rejects(store.withConversationLock('alpha', async () => { throw new Error('rejected'); }), /rejected/);
    assert.strictEqual(await store.withConversationLock('alpha', () => 'after'), 'after');
  });

  test('never makes one ID wait on another', async () => {
    ready('withConversationLock');
    const held = deferred();
    const alpha = store.withConversationLock('alpha', () => held.promise);
    assert.strictEqual(await store.withConversationLock('beta', () => 'beta ran'), 'beta ran');
    held.settle('alpha ran');
    assert.strictEqual(await alpha, 'alpha ran');
  });
});
