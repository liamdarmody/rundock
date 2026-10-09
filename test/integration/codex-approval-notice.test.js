'use strict';
// Integration: a Codex agent whose approval a person gave on a card is told,
// in the turn it was approved in, that a card was shown and approved.
//
// The same route the stop-and-ask line uses (turn/steer), so the agent never
// reads an approval as a question nobody asked. An approval the window gives
// by a rule, with no card, is told nothing. A Codex with no turn/steer is told
// nothing either: "this" means nothing at the start of a later turn.
// Driven end to end against the stub app-server, through the real card.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { approvalNotice } = require('../../scripts/refusal-notice.js');

const SHELL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
let client;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      researcher: agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida, the researcher.',
      }),
    },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '5000' },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

const steers = () => h.readInvocations().filter((e) => e.mode === 'app-server' && e.method === 'turn/steer');
const turnStarts = () => h.readInvocations().filter((e) => e.mode === 'app-server' && e.method === 'turn/start');
const rule = (prompt) => ({
  match: { promptIncludes: prompt },
  approval: {
    kind: 'command', command: 'cp -R ~/Downloads/notes ./notes', awaitSteerOnAcceptMs: 2000,
    afterDecision: { accept: { text: 'Copied.' }, decline: { text: 'Not copied.' } },
  },
});

async function ask(convoId, content) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'approval card' });
  return { since, card };
}
async function resultOf(convoId, since) {
  const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { since, label: 'result' });
  await client.waitForEvent('system', 'done', convoId, { since });
  return msg.result;
}

describe('an approved Codex card tells the agent in the same turn', () => {
  test('approved on a card: the line is steered into the turn that asked, once, in its own thread', async () => {
    const convoId = h.freshConvoId('can');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy my notes')]);
    const { since, card } = await ask(convoId, 'copy my notes please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true, card: true });
    assert.strictEqual(await resultOf(convoId, since), 'Copied.');
    const s = steers();
    assert.strictEqual(s.length, 1, 'said once');
    assert.deepStrictEqual(s[0].params.input, [{ type: 'text', text: approvalNotice(SHELL) }]);
    assert.ok(s[0].params.expectedTurnId, 'bound to the turn that was approved');
    assert.strictEqual(s[0].params.threadId, turnStarts()[0].params.threadId, 'in its own conversation\'s thread');
  });

  test('allowed by the window with no card: nothing is steered', async () => {
    const convoId = h.freshConvoId('can');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy it')]);
    const { since, card } = await ask(convoId, 'copy it please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true });
    assert.strictEqual(await resultOf(convoId, since), 'Copied.');
    assert.deepStrictEqual(steers(), []);
  });

  test('a Codex with no turn/steer is not told in a later turn', async () => {
    const convoId = h.freshConvoId('can');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy old style'), { match: { promptIncludes: 'next' }, text: 'ok' }], { noSteer: true });
    const { since, card } = await ask(convoId, 'copy old style please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true, card: true });
    assert.strictEqual(await resultOf(convoId, since), 'Copied.');
    const at = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'next, own' });
    await resultOf(convoId, at);
    const prompts = h.codexTurnPrompts();
    assert.ok(!prompts.at(-1).includes(approvalNotice(SHELL)), 'never carried into a later turn');
  });
});
