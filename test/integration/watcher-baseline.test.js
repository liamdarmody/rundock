'use strict';
// The agents-dir watcher must not treat the server's OWN boot writes as
// external edits.
//
// The sequence that flaked CI (delegation.test.js spawn-count pin, main run
// after #94): startServer arms the watcher (baseline captured), then the
// listen callback runs scaffoldWorkspace, which writes the managed
// rundock-guide.md into .claude/agents. The first 2s tick sees the changed
// signature, flags every live orchestrator for roster refresh, and whichever
// conversation's follow-up lands next kills-and-respawns instead of reusing
// its process. The workspace-switch paths had the same arm-then-scaffold
// order. Deterministic trigger, timing-dependent victim: the worst kind.
//
// The invariant: the watcher's baseline is captured AFTER all boot-time
// writers finish, so a quiet workspace produces zero ticks and no live entry
// is ever flagged without a real external edit.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;
let convoId;
let entry;
before(async () => {
  // The default harness workspace reproduces the bug by construction: it
  // seeds the team agents but NOT the managed platform files, so the boot
  // scaffold sync writes rundock-guide.md after the watcher armed. The
  // conversation must be LIVE inside the first watcher poll (2s), which is
  // exactly the state every early test in a suite is in, so the turn starts
  // here, immediately after boot.
  await h.boot();
  client = await h.connect();
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: 'baseline idle turn' },
      turn: [{ text: 'Idling.' }] },
  ]);
  convoId = h.freshConvoId('baseline');
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'baseline idle turn' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'idle turn' });
  entry = h.internal.chatProcesses.get(convoId);
});
after(async () => h.shutdown());

describe('watcher baseline vs boot writes', () => {
  test('a quiet workspace stays quiet: no roster-refresh flag without a real external edit', async () => {
    assert.ok(entry, 'entry exists');
    assert.notStrictEqual(entry.needsRosterRefresh, true, 'not flagged at turn completion');

    // Cover two full watcher polls from boot: if the boot scaffold write is
    // being mistaken for an external edit, the tick fires in this window and
    // flags the entry.
    await h.delay(4500);
    const flagged = entry.needsRosterRefresh === true;
    h.reapConvo(convoId);
    assert.strictEqual(flagged, false,
      'the boot-time scaffold sync must not read as an external edit (it killed resumed parents mid-test on CI)');
  });
});
