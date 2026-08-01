'use strict';
// Integration: agent process lifecycle across a long session.
//
// Rundock keeps one live agent process per conversation you touch, plus every
// parked ancestor in a delegation chain. There is currently no reaping of any
// kind: no idle timeout, no cap on live processes, no eviction. A process
// lives until it exits on its own, is cancelled, or the app quits. Each one
// also holds its own set of MCP servers, so memory grows with session length
// and conversation count until the machine starts swapping.
//
// Reported by a beta user as the app getting progressively slower over days
// with no change on their side, and quitting it being the only reliable fix.
//
// Reaping is safe to do because it is not destructive: conversations.json
// persists sessionIds per agent and the delegation path already restores
// agents with --resume, so a reaped process comes back with its context.
//
// This test asserts the OBSERVABLE INVARIANT rather than any particular
// policy: idle processes must not accumulate one-per-conversation for the
// life of the session. An idle timeout, a cap with eviction, or reaping on
// conversation close would all satisfy it. It deliberately does not encode
// which of those we choose.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

// Any real reaping interval is minutes, which a test cannot wait for. The fix
// therefore has to expose a configurable interval, the way the restore delay
// already does for the kill-window tests. Setting it here states that
// requirement up front: without a seam like this the behaviour is untestable.
const REAP_MS = 400;

let client;

before(async () => {
  await h.boot({ env: { RUNDOCK_IDLE_REAP_MS: String(REAP_MS) } });
  client = await h.connect();
});
after(async () => h.shutdown());

function liveEntries() {
  return [...h.internal.chatProcesses.values()].filter(e => !e.exited);
}

describe('agent process lifecycle', () => {
  test('idle agent processes are reaped instead of living for the whole session', async () => {
    const CONVOS = 6;
    const ids = [];

    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'reap-probe' },
        turn: [{ text: 'Answered, nothing further.' }] },
    ]);

    try {
      // Simulate a working session: several conversations, each with one
      // completed turn. Every one of these leaves a live process behind.
      for (let i = 0; i < CONVOS; i++) {
        const convoId = h.freshConvoId('reap');
        ids.push(convoId);
        client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `reap-probe ${i}` });
        await client.waitFor(
          m => m.type === 'result' && m._conversationId === convoId,
          { label: `turn ${i} result` }
        );
      }

      // Precondition: this is the accumulation itself. If this ever stops
      // holding, the shape of the bug has changed and the rest of this test
      // needs rereading before it is trusted.
      assert.strictEqual(liveEntries().length, CONVOS,
        'precondition: every completed conversation leaves a live process');

      // All six turns are finished. Nothing is working. Give any reaping
      // mechanism several intervals to act.
      await h.delay(REAP_MS * 3);

      const after = liveEntries();
      assert.ok(after.length < CONVOS,
        `idle agent processes must not accumulate one per conversation for the life of the `
        + `session. After ${CONVOS} completed turns and ${REAP_MS * 3}ms idle, expected fewer `
        + `than ${CONVOS} live processes, found ${after.length} `
        + `(agents: ${after.map(e => e.agentId).join(', ')}).`);
    } finally {
      for (const id of ids) h.reapConvo(id);
    }
  });
});
