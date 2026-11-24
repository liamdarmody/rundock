'use strict';
// Characterization: codex delegate turn edges that had never been driven,
// pinned ahead of the codex glue's own extraction. Covers the delegate
// event stream (live deltas), the three error routings (transient willRetry,
// busy-turn notice, terminal error), the done-status-failed surface, and
// the turn-start failure path (thread/start retries exhausted). Every test
// asserts BOTH the user-facing surface and that the parked parent is
// restored: a dead delegate must never strand the conversation.
//
// A delegate's card waits for its turn to end. When the turn stopped before
// finishing, the one line saying so carries what the card would have said,
// and no card is sent. When it ended any other way (stopped by the person,
// or finished after all), the card goes out as a direct chat sends it.
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

const BUSY_NOTICE = 'The runtime is still wrapping up the previous turn. Resend your message in a moment.';
const CARD_KINDS = new Set(['codex_error', 'codex_quota', 'codex_guidance', 'notice']);
const isCard = (convoId) => (m) => m.type === 'system' && CARD_KINDS.has(m.subtype) && m._conversationId === convoId;
const isLine = (convoId) => (m) => m.type === 'system' && m.subtype === 'delegate_stopped' && m._conversationId === convoId;
const isReturn = (convoId) => (m) => m.type === 'system' && m.subtype === 'agent_switch'
  && m._conversationId === convoId && m.fromAgent === 'researcher' && m.toAgent === 'chief-of-staff';

/** Hand Ida the brief, the way the browser does. */
function delegateToIda(convoId, context) {
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context });
  return since;
}

/** Waits for control to come back to Cos, then for Ida's own closing `done`. */
async function untilHandedBack(convoId, since, timeout = 10000) {
  const { index: back } = await client.waitFor(isReturn(convoId), { since, label: 'control came back to Cos', timeout });
  await client.waitFor((m) => m.type === 'system' && m.subtype === 'done'
    && m._conversationId === convoId && m._agent === 'researcher', { since: back, label: 'Ida\'s close finished', timeout });
}

/**
 * Everything the window received from `since`, read once the server has
 * answered a later request: whatever the close sent arrived before that.
 */
async function settled(convoId, since) {
  const asked = client.messages.length;
  client.send({ type: 'get_session_history', conversationId: convoId, sessionIds: [], limit: 200 });
  await client.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId,
    { since: asked, label: 'session_history' });
  return client.messages.slice(since);
}

/** The rows the conversation's transcript stored for Ida's card and for the line. */
function storedRows(convoId) {
  const rows = h.internal.loadTranscript(convoId) || [];
  return {
    cards: rows.filter((r) => r.role === 'agent' && r.agent === 'researcher' && /^This turn stopped: /.test(r.text)),
    lines: rows.filter((r) => r.type === 'delegation'),
  };
}

/**
 * Ida's turn stopped before finishing: exactly one line, naming Codex, with
 * `detail` as its third line; no card of any kind, sent or stored.
 */
function assertOneLine(seen, convoId, detail) {
  const lines = seen.filter(isLine(convoId));
  assert.strictEqual(lines.length, 1, 'exactly one line says Ida stopped');
  const [title, body, ...rest] = lines[0].content.split('\n');
  assert.strictEqual(title, 'Ida stopped before finishing');
  assert.ok(body.includes('(Codex reported an error)'), `the line names Codex: ${body}`);
  if (typeof detail === 'string') assert.strictEqual(rest.join('\n'), detail, 'the line carries what the card would have said');
  else assert.ok(rest.join('\n').trim().length > 0, 'the line carries what Codex said');
  assert.deepStrictEqual(seen.filter(isCard(convoId)).map((m) => m.subtype), [], 'the line is the only notice');
  const stored = storedRows(convoId);
  assert.deepStrictEqual(stored.cards, [], 'the card\'s transcript row was dropped with it');
  assert.deepStrictEqual(stored.lines.map((r) => r.text), [lines[0].content], 'the line is stored once');
  const back = seen.find(isReturn(convoId));
  assert.ok(back.failed, 'the return switch says Ida stopped, so no handback is drawn');
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

test('a transient (willRetry) error draws nothing; the failed turn end draws the one line', async () => {
  const convoId = h.freshConvoId('cretry');
  await startOrchestrator(convoId, 'cretry-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cretry task' },
      error: { message: 'stream disconnected, retrying', willRetry: true } },
  ]);

  const since = delegateToIda(convoId, 'cretry task');
  await untilHandedBack(convoId, since);
  // The turn ends failed with no card held before it, so the line carries
  // the message the turn ended with.
  assertOneLine(await settled(convoId, since), convoId, 'stream disconnected, retrying');
  await waitForParentRestored(convoId);
});

test('a busy-turn error is folded into the one line, with the resend notice as its detail', async () => {
  const convoId = h.freshConvoId('cbusy');
  await startOrchestrator(convoId, 'cbusy-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cbusy task' },
      error: { message: 'a turn is already active on thread t_1' } },
  ]);

  const since = delegateToIda(convoId, 'cbusy task');
  await untilHandedBack(convoId, since);
  assertOneLine(await settled(convoId, since), convoId, BUSY_NOTICE);
  await waitForParentRestored(convoId);
});

test('a terminal delegate error is folded into the one line and the parent still comes back', async () => {
  const convoId = h.freshConvoId('cfail');
  await startOrchestrator(convoId, 'cfail-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cfail task' },
      error: { message: 'model exploded', codexErrorInfo: 'other' } },
  ]);

  const since = delegateToIda(convoId, 'cfail task');
  await untilHandedBack(convoId, since);
  assertOneLine(await settled(convoId, since), convoId, 'model exploded');
  await waitForParentRestored(convoId);
});

test('a plan-limit error gives the line the quota card\'s own sentence, which names the fix', async () => {
  const convoId = h.freshConvoId('cquota');
  await startOrchestrator(convoId, 'cquota-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cquota task' },
      error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } },
  ]);

  const since = delegateToIda(convoId, 'cquota task');
  await untilHandedBack(convoId, since);
  assertOneLine(await settled(convoId, since), convoId,
    'This turn stopped: the ChatGPT plan limit was reached. It can be retried once the limit resets.');
  await waitForParentRestored(convoId);
});

test('a card held for Ida goes out as before when the person stops her', async () => {
  const convoId = h.freshConvoId('cstop');
  await startOrchestrator(convoId, 'cstop-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cstop task' },
      error: { message: 'model exploded', codexErrorInfo: 'other', thenContinue: true },
      deltas: ['part one ', 'part two'], holdForInterrupt: true },
  ]);

  const since = delegateToIda(convoId, 'cstop task');
  // The delta follows the error on the same stream, so the card is held by now.
  const { msg: delta } = await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId
    && m._agent === 'researcher', { since, label: 'Ida is part way through' });
  assert.deepStrictEqual(client.messages.slice(since).filter(isCard(convoId)).map((m) => m.subtype), [],
    'the card waits for the turn to end');

  const stopAt = client.messages.length;
  client.send({ type: 'cancel', conversationId: convoId });
  const { msg: card } = await client.waitFor(isCard(convoId), { since: stopAt, label: 'the held card went out' });
  assert.deepStrictEqual(card, {
    type: 'system', subtype: 'codex_error', detail: 'model exploded',
    _agent: 'researcher', _conversationId: convoId, _processId: delta._processId,
  }, 'the card is the one a direct chat sends');
  const seen = await settled(convoId, since);
  assert.strictEqual(seen.filter(isCard(convoId)).length, 1, 'the card goes out once');
  assert.strictEqual(seen.filter(isLine(convoId)).length, 0, 'a turn the person stopped draws no line');
  const stored = storedRows(convoId);
  assert.deepStrictEqual(stored.cards.map((r) => r.text), ['This turn stopped: the runtime hit a problem.\nCodex: model exploded'],
    'the card\'s transcript row is written as before');
  assert.deepStrictEqual(stored.lines, [], 'no line is stored');
});

test('a notice held for Ida goes out as before when her turn finishes after all', async () => {
  const convoId = h.freshConvoId('cdone');
  await startOrchestrator(convoId, 'cdone-setup');
  h.writeCodexScenario([
    { match: { promptIncludes: 'cdone task' },
      error: { message: 'a turn is already active on thread t_1', thenContinue: true },
      deltas: ['found three '], text: 'found three suppliers' },
  ]);

  const since = delegateToIda(convoId, 'cdone task');
  await untilHandedBack(convoId, since);
  const seen = await settled(convoId, since);
  const resultAt = seen.findIndex((m) => m.type === 'result' && m._agent === 'researcher');
  const cards = seen.filter(isCard(convoId));
  assert.ok(resultAt >= 0, 'Ida finished her turn');
  assert.strictEqual(cards.length, 1, 'the notice goes out once');
  assert.ok(seen.indexOf(cards[0]) > resultAt, 'the notice waited for the turn to end');
  assert.deepStrictEqual(cards[0], {
    type: 'system', subtype: 'notice', content: BUSY_NOTICE,
    _agent: 'researcher', _conversationId: convoId, _processId: seen[resultAt]._processId,
  }, 'the notice is the one a direct chat sends');
  assert.strictEqual(seen.filter(isLine(convoId)).length, 0, 'a turn that finished draws no line');
  const back = seen.find(isReturn(convoId));
  assert.strictEqual(back.returning, true, 'control comes back to Cos');
  assert.strictEqual(back.failed, undefined, 'the handback is drawn');
  assert.deepStrictEqual(storedRows(convoId).lines, [], 'no line is stored');
  await waitForParentRestored(convoId);
});

test('a delegate whose thread cannot start draws the one line and restores the parent', async () => {
  const convoId = h.freshConvoId('cnostart');
  await startOrchestrator(convoId, 'cnostart-setup');
  // Exhaust the protocol client's overload retries so thread/start rejects.
  h.writeCodexScenario([], { overload: { method: 'thread/start', times: 10 } });

  const since = delegateToIda(convoId, 'cnostart task');
  await untilHandedBack(convoId, since, 15000);
  assertOneLine(await settled(convoId, since), convoId, null);
  await waitForParentRestored(convoId);
});
