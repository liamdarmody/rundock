'use strict';
// Integration: turn-activity keepalives for silent Codex turns (re-gate R2).
//
// The app-server protocol client forwards ONLY agentMessage deltas to the
// browser, so a turn that thinks silently or runs a long tool (npm install,
// a test suite) produces zero watchdog-resetting messages. The client's 90s
// stream-inactivity watchdog would conclude the turn is dead mid-task and
// auto-finish the UI: status flips to idle, the input unlocks, and the user
// is invited to send a message that supersedes the still-working turn.
//
// The contract under test: while a Codex turn is live on the shared
// app-server, the server sends `{type:'system', subtype:'keepalive'}` with
// the turn's routing envelope every RUNDOCK_CODEX_KEEPALIVE_MS (25s in
// production; shrunk here), on the direct path AND the delegated path, and
// the heartbeat stops once the turn is done. The client half (the reducer
// treating keepalive as stream activity) is pinned in
// test/unit/conversation-state.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

const KEEPALIVE_MS = 120;

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team(), env: { RUNDOCK_CODEX_KEEPALIVE_MS: String(KEEPALIVE_MS) } });
  client = await h.connect();
});
after(async () => h.shutdown());

function keepalives(convoId, from = 0) {
  return client.messages.slice(from)
    .filter(m => m.type === 'system' && m.subtype === 'keepalive' && m._conversationId === convoId);
}

describe('codex turn keepalive heartbeat', () => {
  test('a silent direct turn emits keepalives carrying the turn envelope, and they stop after done', async () => {
    const convoId = h.freshConvoId('cka');
    // Silent for many keepalive intervals: no deltas, just a long pause
    // before the final text (the stub equivalent of a long quiet tool run).
    h.writeCodexScenario([{
      match: { promptIncludes: 'long silent task' },
      delayMs: KEEPALIVE_MS * 8,
      text: 'Finally done.',
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'long silent task please' });
    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId, { since });

    const { index: resultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'silent-turn result' });
    const { index: doneIdx } = await client.waitForEvent('system', 'done', convoId, { since });

    // Multiple heartbeats arrived DURING the silence (before the result),
    // each carrying the exact envelope the client's stale gating needs.
    const beats = client.messages.slice(since, resultIdx)
      .filter(m => m.type === 'system' && m.subtype === 'keepalive' && m._conversationId === convoId);
    assert.ok(beats.length >= 2, `expected at least 2 keepalives during the silent stretch, got ${beats.length}`);
    for (const beat of beats) {
      assert.strictEqual(beat._agent, 'researcher', 'keepalive names the agent');
      assert.strictEqual(beat._processId, started._processId, 'keepalive carries the turn process id (stale gating)');
    }

    // The heartbeat stops with the turn: no keepalives after done.
    await h.delay(KEEPALIVE_MS * 4);
    assert.strictEqual(keepalives(convoId, doneIdx + 1).length, 0, 'no keepalives after the turn ended');
  });

  test('a silent delegated turn heartbeats too (the delegate path has no per-turn process)', async () => {
    const convoId = h.freshConvoId('cka');
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'quiet delegate please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'quiet delegate brief' } }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario([{
      match: { promptIncludes: 'quiet delegate brief' },
      delayMs: KEEPALIVE_MS * 8,
      text: 'Delegate finished. <!-- RUNDOCK:COMPLETE -->',
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'quiet delegate please' });

    const { msg: delegateStarted } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'researcher',
      { since, label: 'delegate process_started' });
    const { index: resultIdx } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher',
      { since, label: 'delegate result' });

    const beats = client.messages.slice(since, resultIdx)
      .filter(m => m.type === 'system' && m.subtype === 'keepalive' && m._conversationId === convoId && m._agent === 'researcher');
    assert.ok(beats.length >= 2, `expected at least 2 delegate keepalives, got ${beats.length}`);
    for (const beat of beats) {
      assert.strictEqual(beat._processId, delegateStarted._processId, 'delegate keepalive carries the delegate process id');
    }
    h.reapConvo(convoId);
  });
});
