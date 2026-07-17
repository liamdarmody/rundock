'use strict';
// Integration half of the background-approvals fix. The client-side story
// (a control_request for a conversation that is not on screen is queued,
// the sidebar carries the unread signal, and the card renders when the
// conversation opens) lives in pure functions pinned at unit level in
// test/unit/permissions.test.js (routePermissionRequest and the pending
// store), because this harness drives the server over a bare WebSocket and
// has no DOM in which to "switch conversations".
//
// What CAN be pinned here is the server's half of the contract the queued
// card relies on: an approval raised by a background codex turn stays
// pending while the server keeps serving OTHER conversations, and a LATE
// (but pre-timeout) permission_response, sent exactly as the client does
// when the user opens the conversation and clicks Allow on the queued
// card, is accepted and drives the turn to completion. No drop, no
// auto-deny.
const { test, describe, before, after } = require('node:test');
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
  // Timeout long enough for a deliberately late answer to still be
  // pre-timeout, short enough to keep the suite honest if the request were
  // wrongly auto-denied.
  await h.boot({ agents: team(), env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '6000' } });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('approvals for background conversations', () => {
  test('an approval raised while another conversation is served stays pending and a late (pre-timeout) response is accepted', async () => {
    const bgConvo = h.freshConvoId('bga');   // conversation the user is NOT looking at
    const fgConvo = h.freshConvoId('bgf');   // conversation the user is chatting in
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'bga fetch the data' },
      approval: {
        kind: 'command', command: 'curl https://example.com/data', reason: 'needs network access',
        afterDecision: {
          accept: { text: 'Fetched the data.' },
          decline: { text: 'Could not fetch it.' },
        },
      },
    }]);
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'bgf foreground question' },
        turn: [{ text: 'FOREGROUND-ANSWER' }] },
    ]);

    // The background codex turn raises its approval card.
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: bgConvo, agent: 'researcher', content: 'bga fetch the data please' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === bgConvo, { since, timeout: 15000, label: 'background approval card' });
    assert.strictEqual(card.request.input.command, 'curl https://example.com/data');

    // The user is busy elsewhere: a whole other conversation is served over
    // the same socket while the approval waits.
    client.send({ type: 'chat', conversationId: fgConvo, agent: 'content-lead', content: 'bgf foreground question' });
    const { msg: fgResult } = await client.waitFor(m => m.type === 'result' && m._conversationId === fgConvo, { since, timeout: 15000, label: 'foreground result' });
    assert.strictEqual(fgResult.result, 'FOREGROUND-ANSWER');

    // The request is still pending server-side: not dropped, not denied.
    assert.ok(h.internal.pendingPermissionRequests.has(card.request_id), 'approval still pending after serving another conversation');

    // The user "switches back" some time later and answers the queued card:
    // the same permission_response the client sends from a rendered card.
    await h.delay(800);
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: bgConvo, allow: true });

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === bgConvo, { since, timeout: 15000, label: 'background result after late allow' });
    assert.strictEqual(result.result, 'Fetched the data.', 'the late allow drove the turn');
    await client.waitForEvent('system', 'done', bgConvo, { since });

    const decisions = h.readInvocations().filter(e => e.approvalDecision !== undefined).map(e => e.approvalDecision);
    assert.deepStrictEqual(decisions, ['accept'], 'the protocol decision was accept, not a timeout decline');
    assert.ok(!client.messages.slice(since).some(m => m.type === 'permission_timeout' && m.requestId === card.request_id),
      'the request never timed out');

    h.reapConvo(bgConvo); h.reapConvo(fgConvo);
  });
});
