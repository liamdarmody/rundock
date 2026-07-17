'use strict';
// Integration: the kill-window state machine (convoTransitions) that stops a
// chat message from being written into a dying process's stdin and lost.
//
// The race: a delegate emits RETURN/COMPLETE, the 500ms auto-return kill
// FIRES, and a user message lands in the gap between that kill and the
// parent's restoration spawn. Pre-fix the message passed the follow-up stdin
// gate (the dying process still looked live), cleared the committed
// handback, and vanished: the worst chat failure mode. Post-fix the
// conversation is in an explicit killing/restoring transition, the message
// is buffered, and it replays against the restored parent.
//
// Determinism: the file boots with RUNDOCK_TEST_RESTORE_DELAY_MS (a
// test-only env seam in server.js, default 0 in production) so the
// restoring window is wide enough to hit reliably, and the tests poll the
// exported convoTransitions map to fire the message exactly inside the
// window (the harness runs the server in-process, so the map is visible).
//
// The Codex direct-chat supersede path needs no buffer (the new message is
// held in the superseding turn's closure behind the bounded _turnEnd wait);
// that is pinned separately in codex-chat.test.js ("a new user message
// while a codex turn is running supersedes it").
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { MARKERS } = require('../fixtures/stream-json.js');

let client;

before(async () => {
  // Widen the restoring window (delegate close -> parent respawn) to 700ms
  // so the buffered message deterministically lands inside it.
  await h.boot({ env: { RUNDOCK_TEST_RESTORE_DELAY_MS: '700' } });
  client = await h.connect();
});
after(async () => h.shutdown());

function transcript(convoId) {
  const file = path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Poll until the conversation enters a kill-window transition (the moment
// the auto-return kill fires) so the racing message can be sent inside it.
async function waitForTransition(convoId, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = h.internal.convoTransitions.get(convoId);
    if (t) return t;
    await h.delay(5);
  }
  throw new Error(`timed out waiting for kill-window transition on ${convoId}`);
}

// Poll until the transition has buffered at least one message (proves the
// racing chat was queued, not written to the dying stdin).
async function waitForBuffered(convoId, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = h.internal.convoTransitions.get(convoId);
    if (t && t.queued.length > 0) return t;
    await h.delay(5);
  }
  throw new Error(`timed out waiting for a buffered chat on ${convoId}`);
}

function noErrorCards(convoId, since) {
  const bad = client.messages.slice(since).filter(m =>
    m._conversationId === convoId &&
    (m.type === 'error' || (m.type === 'system' && (m.subtype === 'delegation_error' || m.subtype === 'auth_error'))));
  assert.deepStrictEqual(bad, [], 'no error card for the raced message');
}

describe('kill-window race: message during handoff completion', () => {
  test('a chat message fired between a delegate COMPLETE kill and the parent restoration is buffered and answered by the restored parent', async () => {
    const convoId = h.freshConvoId('kwr');
    h.clearInvocations();
    h.writeScenario([
      // 1. Orchestrator delegates via an intercepted Agent tool call.
      { match: { agent: 'chief-of-staff', promptIncludes: 'kwr-complete please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'kwr-complete brief' } }] },
      // 2. Delegate finishes with COMPLETE: arms the 500ms auto-return kill.
      { match: { agent: 'content-lead', promptIncludes: 'kwr-complete brief' },
        turn: [{ text: `Pipeline delivered. ${MARKERS.COMPLETE}` }] },
      // 3. Restored parent parks on the pipeline-complete prompt...
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
      // 4. ...then answers the replayed (previously buffered) user message.
      { match: { agent: 'chief-of-staff', promptIncludes: 'kwr follow-up question' },
        turn: [{ text: 'RESTORED-PARENT-ANSWER' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'kwr-complete please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate COMPLETE result' });

    // Fire the race: wait for the auto-return kill to actually fire (the
    // conversation enters killing/restoring), THEN send the message. This is
    // exactly the window where the message was previously lost.
    await waitForTransition(convoId);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'kwr follow-up question' });

    // The message was buffered, never written to the dying delegate.
    const t = await waitForBuffered(convoId);
    assert.strictEqual(t.queued.length, 1, 'exactly one message buffered');
    assert.ok(t.state === 'killing' || t.state === 'restoring', `transition state is explicit (got ${t.state})`);

    // The queued message is ANSWERED: a result arrives for it.
    const { msg: answer } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m.result === 'RESTORED-PARENT-ANSWER',
      { since, label: 'restored parent answers the buffered message', timeout: 15000 });
    assert.strictEqual(answer._agent, 'chief-of-staff', 'the restored parent answered it');

    // Nothing dropped, no error card, window closed.
    noErrorCards(convoId, since);
    assert.strictEqual(h.internal.convoTransitions.has(convoId), false, 'transition ended after restoration');
    const userRows = transcript(convoId).filter(e => e.role === 'user' && e.text === 'kwr follow-up question');
    assert.strictEqual(userRows.length, 1, 'the buffered message reached the transcript exactly once (not dropped, not duplicated)');
    assert.ok(transcript(convoId).some(e => e.text.includes('RESTORED-PARENT-ANSWER')), 'the answer reached the transcript');

    // No fresh delegate was spawned for the follow-up, and the parent was
    // restored via --resume (one cold spawn + one resume).
    const invs = h.readInvocations();
    assert.strictEqual(invs.filter(i => i.agent === 'content-lead').length, 1, 'no spawn-fresh for the raced message');
    assert.strictEqual(invs.filter(i => i.agent === 'chief-of-staff' && i.resume).length, 1, 'parent restored via --resume');

    // The restored parent remains the live entry for the next message.
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.exited, false, 'restored parent is alive');

    h.reapConvo(convoId);
  });

  test('RETURN variant: a message buffered in the window supersedes the routing prompt and is answered by the restored parent', async () => {
    const convoId = h.freshConvoId('kwr');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'kwr-return please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'kwr-return brief' } }] },
      // Delegate hands back out-of-scope: arms the 500ms auto-return kill.
      { match: { agent: 'content-lead', promptIncludes: 'kwr-return brief' },
        turn: [{ text: `Out of my lane. ${MARKERS.RETURN}` }] },
      // Trap rule: pre-fix (or without the supersede gate) the parent is
      // resumed with the out-of-scope routing prompt; this must NOT fire
      // when the user has already sent a newer message.
      { match: { agent: 'chief-of-staff', promptIncludes: 'returned because the request was outside their scope' },
        turn: [{ text: 'ROUTING-PROMPT-FIRED' }] },
      // Correct path: the replayed user message drives the restored parent.
      { match: { agent: 'chief-of-staff', promptIncludes: 'kwr return follow-up' },
        turn: [{ text: 'RETURN-WINDOW-ANSWER' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'kwr-return please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate RETURN result' });

    await waitForTransition(convoId);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'kwr return follow-up' });
    await waitForBuffered(convoId);

    const { msg: answer } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m.result === 'RETURN-WINDOW-ANSWER',
      { since, label: 'restored parent answers the buffered message', timeout: 15000 });
    assert.strictEqual(answer._agent, 'chief-of-staff');

    noErrorCards(convoId, since);
    // The user's newer message superseded the stale routing prompt, matching
    // the live-window rule where a follow-up cancels the auto-return.
    assert.ok(!client.messages.some(m => JSON.stringify(m).includes('ROUTING-PROMPT-FIRED')),
      'the RETURN routing prompt was skipped in favour of the buffered message');
    assert.ok(!transcript(convoId).some(e => e.text.includes('ROUTING-PROMPT-FIRED')));

    h.reapConvo(convoId);
  });
});

describe('kill-window: ordinary paths untouched', () => {
  test('a message to an idle conversation spawns and answers as before; a follow-up to a live idle process reuses stdin; no transition is ever created', async () => {
    const convoId = h.freshConvoId('kwo');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'kwo ordinary one' }, turn: [{ text: 'Ordinary answer one.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'kwo ordinary two' }, turn: [{ text: 'Ordinary answer two.' }] },
    ]);

    // First message: fresh spawn, answered.
    const since1 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'kwo ordinary one' });
    const { msg: r1 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: since1, label: 'first result' });
    assert.strictEqual(r1.result, 'Ordinary answer one.');
    assert.strictEqual(h.internal.convoTransitions.has(convoId), false, 'no transition for an ordinary message');

    // Follow-up while the process idles: served over stdin, no respawn.
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'kwo ordinary two' });
    const { msg: r2 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: since2, label: 'follow-up result' });
    assert.strictEqual(r2.result, 'Ordinary answer two.');
    assert.strictEqual(h.readInvocations().filter(i => i.agent === 'content-lead').length, 1, 'follow-up reused the live process');
    assert.strictEqual(h.internal.convoTransitions.has(convoId), false, 'still no transition');
    noErrorCards(convoId, since1);

    h.reapConvo(convoId);
  });
});
