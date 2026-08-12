'use strict';
// Characterization: two delegate-close edges that had never been driven.
// 1. CANCELLED DELEGATE: a cancel that lands while a delegate is active
//    skips parent restoration entirely. The conversation's process entry is
//    dropped and no agent_switch back to the parent ever fires: the user
//    said stop, so nothing resumes on their behalf.
// 2. DELEGATE TAIL FLUSH: a JSON fragment still sitting in the delegate's
//    line buffer when the process dies is flushed to the client stamped
//    with the delegate and the conversation, mirroring the main close
//    handler's flush. (Unlike the main handler, an unparseable delegate
//    tail is dropped, so the pin uses a parseable one.)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

async function startOrchestrator(convoId, keyword) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: keyword }, turn: [{ text: `Orchestrator ready (${keyword}).` }] },
  ]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: keyword });
  await client.waitForEvent('system', 'done', convoId);
}

test('a cancelled delegate skips parent restoration: entry dropped, no switch back', async () => {
  const convoId = h.freshConvoId('delcancel');
  await startOrchestrator(convoId, 'cancel-edge-setup');
  // The turn is delayed so the delegate is still MID-TURN when the cancel
  // lands: an idle process refuses cancellation by design.
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'cancel-edge task' }, delayMs: 5000, turn: [{ text: 'Working on it, no markers.' }] },
  ]);
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'cancel-edge task' });
  // process_started is emitted synchronously by the delegation handler, so
  // the delegate is registered and mid-delay when the cancel goes out. (The
  // stub's init arrives with the TURN, which the delay is holding back.)
  await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate spawned' });

  const since = client.messages.length;
  client.send({ type: 'cancel', conversationId: convoId });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'cancelled' && m._conversationId === convoId, { since, label: 'cancelled event' });
  // The close handler runs after the kill; the cancelled branch drops the
  // entry instead of restoring the parked parent.
  await h.waitUntil(() => !h.internal.chatProcesses.has(convoId));
  const switchBack = client.messages.slice(since).find(
    m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId);
  assert.ok(!switchBack, 'no agent_switch fired: parent restoration was skipped');
});

test('a JSON tail in the delegate buffer at close is flushed, stamped with the delegate', async () => {
  const convoId = h.freshConvoId('deltail');
  await startOrchestrator(convoId, 'tail-edge-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'tail-edge task' },
      crash: 0, crashTail: '{"type":"system","subtype":"delegate_stub_tail"}' },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'tail-edge task' });

  const tail = (await client.waitFor(
    m => m.type === 'system' && m.subtype === 'delegate_stub_tail',
    { since, label: 'flushed delegate tail' })).msg;
  assert.strictEqual(tail._conversationId, convoId);
  assert.strictEqual(tail._agent, 'content-lead', 'the flush stamps the DELEGATE, not the parent');

  // The markerless dead delegate still restores the parked parent.
  await h.waitUntil(() => {
    const entry = h.internal.chatProcesses.get(convoId);
    return entry && entry.agentId === 'chief-of-staff';
  });
  h.reapConvo(convoId);
});
