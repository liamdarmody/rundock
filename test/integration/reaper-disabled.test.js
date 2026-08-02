'use strict';
// Integration: reaping must be switchable off.
//
// Reaping releases agent processes that have been idle for a while. The guards
// around it (never mid-turn, never when a background task was started) cover
// the cases we know about. This is the escape hatch for the ones we did not
// think of: a user who hits an edge should be able to turn the behaviour off
// without downgrading.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

// Short enough that a sweep would certainly have fired if one were running.
const WOULD_HAVE_REAPED_MS = 300;

let client;

before(async () => {
  await h.boot({ env: { RUNDOCK_IDLE_REAP_MS: '0' } });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('reaping disabled', () => {
  test('setting the interval to zero leaves idle processes alone', async () => {
    const convoId = h.freshConvoId('no-reap');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'disabled-reaper' },
        turn: [{ text: 'Answered.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'disabled-reaper' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId,
      { since, label: 'turn result' });

    assert.ok(h.internal.chatProcesses.has(convoId), 'precondition: the turn left a live process');

    await h.delay(WOULD_HAVE_REAPED_MS * 6);

    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && !entry.exited,
      'with reaping switched off, an idle process must be left exactly as it was. '
      + 'The escape hatch is only useful if it actually escapes.');

    h.reapConvo(convoId);
  });
});
