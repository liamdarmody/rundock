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

describe('kill-window race: direct (non-delegated) scope return', () => {
  // handleScopeReturn serves the direct scope-return path (a specialist the
  // user chatted with directly hands off with RETURN) and the resumed-parent
  // return. Both spawn a fresh orchestrator and write the out-of-scope
  // routing prompt; the buffered-message supersede rule that guards the
  // delegate restoration paths above must hold here too, or a follow-up
  // buffered in the kill window queues BEHIND the routing prompt and dies
  // with the orchestrator when that prompt re-delegates.
  //
  // Determinism: the killing window is seeded directly while the entry is
  // still the specialist (the real 500ms kill would open it moments later;
  // beginConvoTransition reuses the seeded record and keeps its queue), so
  // the follow-up reliably lands inside the window.
  test('a message buffered in the window supersedes the routing prompt and is answered exactly once', async () => {
    const convoId = h.freshConvoId('dsr');
    h.clearInvocations();
    h.writeScenario([
      // Direct chat to the specialist; it hands off out-of-scope.
      { match: { agent: 'content-lead', promptIncludes: 'dsr direct return please' },
        turn: [{ text: `Not my lane. ${MARKERS.RETURN}` }] },
      // Trap rule: handleScopeReturn's routing prompt must NOT fire when a
      // newer user message is buffered in the kill window.
      { match: { agent: 'chief-of-staff', promptIncludes: 'returned because the request was outside their scope' },
        turn: [{ text: 'DSR-ROUTING-PROMPT-FIRED' }] },
      // Correct path: the replayed message drives the fresh orchestrator.
      { match: { agent: 'chief-of-staff', promptIncludes: 'dsr buffered follow-up' },
        turn: [{ text: 'DSR-FOLLOWUP-ANSWER' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'dsr direct return please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'specialist RETURN result' });

    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && entry.scopeReturn, 'specialist is in the auto-return window');
    h.internal.convoTransitions.set(convoId, { state: 'killing', owner: entry, queued: [], failsafe: setTimeout(() => {}, 30000) });

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'dsr buffered follow-up' });
    await waitForBuffered(convoId);

    const { msg: answer } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m.result === 'DSR-FOLLOWUP-ANSWER',
      { since, label: 'fresh orchestrator answers the buffered message', timeout: 15000 });
    assert.strictEqual(answer._agent, 'chief-of-staff', 'the fresh orchestrator answered it');
    await h.delay(800); // window for a stray routing-prompt result to land if one were coming

    // The user's newer message superseded the routing prompt, matching the
    // delegate COMPLETE/RETURN restoration gates and the live-window rule.
    assert.ok(!client.messages.some(m => JSON.stringify(m).includes('DSR-ROUTING-PROMPT-FIRED')),
      'the routing prompt was skipped in favour of the buffered message');
    assert.ok(!transcript(convoId).some(e => e.text && e.text.includes('DSR-ROUTING-PROMPT-FIRED')));

    // Exactly once: one answer envelope, one transcript row.
    const answers = client.messages.slice(since).filter(m => m.type === 'result' && m._conversationId === convoId && m.result === 'DSR-FOLLOWUP-ANSWER');
    assert.strictEqual(answers.length, 1, 'the buffered message is answered exactly once');
    const rows = transcript(convoId).filter(e => e.role === 'user' && e.text === 'dsr buffered follow-up');
    assert.strictEqual(rows.length, 1, 'the buffered message reached the transcript exactly once');

    noErrorCards(convoId, since);
    assert.strictEqual(h.internal.convoTransitions.has(convoId), false, 'transition ended after restoration');
    h.reapConvo(convoId);
  });

  test('the buffered follow-up survives the routing prompt re-delegating (silent-loss variant)', async () => {
    // Pre-fix the ungated routing prompt does what it literally asks: the
    // orchestrator re-delegates, interception SIGKILLs it, and the replayed
    // follow-up (already written to its stdin) dies unread. The message is
    // silently lost: the exact failure class the kill-window machine closed.
    const convoId = h.freshConvoId('dsl');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'dsl direct return please' },
        turn: [{ text: `Not my lane. ${MARKERS.RETURN}` }] },
      // The routing prompt drives a re-delegation (what it literally asks for).
      { match: { agent: 'chief-of-staff', promptIncludes: 'returned because the request was outside their scope' },
        turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 'dsl re-routed brief' } }] },
      { match: { agent: 'lead-designer', promptIncludes: 'dsl re-routed brief' },
        turn: [{ text: `Re-routed work done. ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'dsl buffered follow-up' },
        turn: [{ text: 'DSL-FOLLOWUP-ANSWER' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'dsl direct return please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'specialist RETURN result' });

    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && entry.scopeReturn, 'specialist is in the auto-return window');
    h.internal.convoTransitions.set(convoId, { state: 'killing', owner: entry, queued: [], failsafe: setTimeout(() => {}, 30000) });

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'dsl buffered follow-up' });
    await waitForBuffered(convoId);

    const answered = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m.result === 'DSL-FOLLOWUP-ANSWER',
      { since, timeout: 12000, label: 'buffered follow-up answered' }
    ).then(() => true).catch(() => false);
    assert.ok(answered, 'the buffered follow-up must not be lost');
    const answers = client.messages.slice(since).filter(m => m.type === 'result' && m._conversationId === convoId && m.result === 'DSL-FOLLOWUP-ANSWER');
    assert.strictEqual(answers.length, 1, 'answered exactly once');
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
