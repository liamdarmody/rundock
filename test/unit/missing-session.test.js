'use strict';
// The one place that recognizes Claude Code refusing a resume, and the one
// place that remembers which sessions are gone.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  REFUSAL, refusedResume, resumedSessionOf, noteExpired, isExpired, withoutResume, notResumedNotice,
} = require('../../lib/runtime/missing-session.js');

const resumed = (id) => ({ spawnargs: ['claude', '--model', 'm', '--resume', id, '--agent', 'writer'] });
const fresh = { spawnargs: ['claude', '--model', 'm', '--agent', 'writer'] };

describe('a refused resume', () => {
  test('is the refusal from a process that was resuming, and names the id it was started with', () => {
    assert.strictEqual(refusedResume(resumed('sess-gone-1'), `${REFUSAL}: sess-gone-1\n`), 'sess-gone-1');
  });

  test('the id comes from the arguments, not from the text, which a process cannot misreport', () => {
    assert.strictEqual(refusedResume(resumed('sess-real-2'), `${REFUSAL}: something-else.`), 'sess-real-2');
  });

  test('the same words from a process that was not resuming are not a refusal', () => {
    assert.strictEqual(refusedResume(fresh, `${REFUSAL}: sess-x`), null);
  });

  test('any other line from a resuming process is not a refusal', () => {
    assert.strictEqual(refusedResume(resumed('sess-3'), 'API Error: Connection error.'), null);
    assert.strictEqual(refusedResume(resumed('sess-3'), ''), null);
  });

  test('a process with no recorded arguments has nothing to name', () => {
    assert.strictEqual(resumedSessionOf({}), null);
    assert.strictEqual(resumedSessionOf(null), null);
    assert.strictEqual(resumedSessionOf({ spawnargs: ['claude', '--resume'] }), null);
  });
});

describe('starting again without the session', () => {
  test('drops the resume and its id, and keeps every other argument in order', () => {
    assert.deepStrictEqual(withoutResume(['--model', 'm', '--resume', 'sess-4', '--agent', 'writer']),
      ['--model', 'm', '--agent', 'writer']);
  });

  test('arguments with no resume come back unchanged, as a copy', () => {
    const args = ['--agent', 'writer'];
    const out = withoutResume(args);
    assert.deepStrictEqual(out, args);
    assert.notStrictEqual(out, args);
  });
});

describe('the sessions known to be gone', () => {
  test('a noted id is known, an unnoted one is not, and nothing is noted for no id', () => {
    assert.strictEqual(isExpired('sess-noted-5'), false);
    noteExpired('sess-noted-5');
    assert.strictEqual(isExpired('sess-noted-5'), true);
    assert.strictEqual(isExpired('sess-other-6'), false);
    noteExpired(null);
    assert.strictEqual(isExpired(null), false);
  });
});

test('what a person is told names the agent and what to do, and never the raw refusal', () => {
  const said = notResumedNotice('Quill');
  assert.match(said, /^Quill's earlier session is no longer available/);
  assert.match(said, /Send your message again to carry on in a fresh session\.$/);
  assert.ok(!said.includes(REFUSAL));
  assert.doesNotMatch(said, /sign[\s-]*in/i, 'the copy never says sign in');
  // Built from code points so this file carries no dash character of its own.
  const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  assert.doesNotMatch(said, dashes, 'and uses no en or em dash');
});
