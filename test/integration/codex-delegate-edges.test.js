'use strict';
// Characterization: codex delegate turn edges that had never been driven,
// pinned ahead of the codex glue's own extraction. Covers the delegate
// event stream (live deltas), the three error routings (transient willRetry,
// busy-turn notice, terminal error), the done-status-failed surface, and
// the turn-start failure path (thread/start retries exhausted). Every test
// asserts BOTH the user-facing surface and that the parked parent is
// restored: a dead delegate must never strand the conversation.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

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
  await h.boot({ agents: team() });
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

async function waitForParentRestored(convoId) {
  const ok = await h.waitUntil(() => {
    const e = h.internal.chatProcesses.get(convoId);
    return e && e.agentId === 'chief-of-staff';
  });
  assert.ok(ok, 'the parked parent was restored after the delegate turn ended');
}

test('a codex delegate streams live deltas to the browser, stamped with the delegate', async () => {
  const convoId = h.freshConvoId('cdeltas');
  await startOrchestrator(convoId, 'cdeltas-setup');
  // The version override also exercises the untested-range warning on the
  // app-server's first boot in this process.
  h.writeCodexScenario([
    { match: { promptIncludes: 'cdeltas task' }, deltas: ['chunk one ', 'chunk two'], text: 'chunk one chunk two' },
  ], { version: '0.999.0' });

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cdeltas task' });

  const { msg: delta } = await client.waitFor(
    m => m.type === 'stream_event' && m.event?.type === 'content_block_delta'
      && m._conversationId === convoId && m._agent === 'researcher',
    { since, label: 'live delegate delta' });
  assert.strictEqual(delta.event.delta.type, 'text_delta');
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher',
    { since, label: 'delegate result' });
  await waitForParentRestored(convoId);
});

test('a transient (willRetry) error is never surfaced; the failed turn end is', async () => {
  const convoId = h.freshConvoId('cretry');
  await startOrchestrator(convoId, 'cretry-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cretry task' },
      error: { message: 'stream disconnected, retrying', willRetry: true } },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cretry task' });

  // The turn ends failed WITHOUT a prior surfaced error, so the done handler
  // owns the error surface (exactly once).
  await client.waitFor(m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId,
    { since, label: 'error surfaced at turn end' });
  const errors = client.messages.slice(since).filter(
    m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId);
  assert.strictEqual(errors.length, 1, 'the transient error itself was never surfaced');
  await waitForParentRestored(convoId);
});

test('a busy-turn error becomes the retryable notice, never an error card', async () => {
  const convoId = h.freshConvoId('cbusy');
  await startOrchestrator(convoId, 'cbusy-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cbusy task' },
      error: { message: 'a turn is already active on thread t_1' } },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cbusy task' });

  const { msg: notice } = await client.waitFor(
    m => m.type === 'system' && m.subtype === 'notice' && m._conversationId === convoId,
    { since, label: 'busy notice' });
  assert.match(notice.content, /wrapping up the previous turn/);
  await waitForParentRestored(convoId);
  const errors = client.messages.slice(since).filter(
    m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId);
  assert.strictEqual(errors.length, 0, 'busy is not a failure: no error card');
});

test('a terminal delegate error is surfaced once and the parent still comes back', async () => {
  const convoId = h.freshConvoId('cfail');
  await startOrchestrator(convoId, 'cfail-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cfail task' },
      error: { message: 'model exploded', codexErrorInfo: 'other' } },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cfail task' });

  await client.waitFor(m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId,
    { since, label: 'terminal error surfaced' });
  await waitForParentRestored(convoId);
  const errors = client.messages.slice(since).filter(
    m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId);
  assert.strictEqual(errors.length, 1, 'the done-failed path never doubles the surface');
});

test('a delegate whose thread cannot start surfaces the failure and restores the parent', async () => {
  const convoId = h.freshConvoId('cnostart');
  await startOrchestrator(convoId, 'cnostart-setup');
  // Exhaust the protocol client's overload retries so thread/start rejects.
  h.writeCodexScenario([], { overload: { method: 'thread/start', times: 10 } });

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'cnostart task' });

  await client.waitFor(m => m.type === 'system' && m.subtype === 'codex_error' && m._conversationId === convoId,
    { since, label: 'turn-start failure surfaced', timeout: 15000 });
  await waitForParentRestored(convoId);
});
