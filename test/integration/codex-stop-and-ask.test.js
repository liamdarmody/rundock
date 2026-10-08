'use strict';
// Integration: a Codex agent whose approval is refused is told, in the turn it
// was refused in, that the refusal was deliberate and to stop and ask.
//
// A refusal is the protocol's `decline`, which lets the turn go on, and the
// agent used to go on by working round it. The line is steered into the
// running turn (turn/steer). A Codex with no turn/steer gets it at the start
// of the next turn instead, by the route the put-back line already uses.
// Driven end to end against the stub app-server, through the real card.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

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
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '1500' },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

const steers = () => h.readInvocations().filter((e) => e.mode === 'app-server' && e.method === 'turn/steer');
const turnStarts = () => h.readInvocations().filter((e) => e.mode === 'app-server' && e.method === 'turn/start');
const rule = (prompt) => ({
  match: { promptIncludes: prompt },
  approval: {
    kind: 'command', command: 'cp -R ~/Downloads/notes ./notes', awaitSteerMs: 2000,
    afterDecision: { accept: { text: 'Copied.' }, decline: { text: 'Trying another way.' }, steered: { text: 'That was refused. What would you like me to do?' } },
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

describe('a refused Codex approval tells the agent in the same turn', () => {
  test('denied: the line is steered into the turn that asked, once, and the agent stops', async () => {
    const convoId = h.freshConvoId('csa');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy my notes')]);
    const { since, card } = await ask(convoId, 'copy my notes please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false });
    assert.strictEqual(await resultOf(convoId, since), 'That was refused. What would you like me to do?');
    const s = steers();
    assert.strictEqual(s.length, 1, 'said once');
    assert.deepStrictEqual(s[0].params.input, [{ type: 'text', text: refusalNotice('denied', SHELL) }]);
    assert.ok(s[0].params.expectedTurnId, 'bound to the turn that was refused');
    assert.strictEqual(s[0].params.threadId, turnStarts()[0].params.threadId, 'in its own conversation\'s thread');
  });

  test('timed out: the timeout line, steered the same way', async () => {
    const convoId = h.freshConvoId('csa');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy slowly')]);
    const { since } = await ask(convoId, 'copy slowly please');
    assert.strictEqual(await resultOf(convoId, since), 'That was refused. What would you like me to do?');
    assert.deepStrictEqual(steers().map((e) => e.params.input[0].text), [refusalNotice('timeout', SHELL)]);
  });

  test('allowed: nothing is steered', async () => {
    const convoId = h.freshConvoId('csa');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy it')]);
    const { since, card } = await ask(convoId, 'copy it please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true });
    assert.strictEqual(await resultOf(convoId, since), 'Copied.');
    assert.deepStrictEqual(steers(), []);
  });

  test('a Codex with no turn/steer hears it at the start of its next turn, once, and no other conversation does', async () => {
    const convoId = h.freshConvoId('csa');
    const other = h.freshConvoId('csa');
    h.clearInvocations();
    h.writeCodexScenario([rule('copy old style'), { match: { promptIncludes: 'next' }, text: 'ok' }], { noSteer: true });
    const { since, card } = await ask(convoId, 'copy old style please');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false });
    assert.strictEqual(await resultOf(convoId, since), 'Trying another way.', 'the turn had no way to hear it');

    const prompts = () => h.codexTurnPrompts();
    for (const [c, label] of [[other, 'other'], [convoId, 'own'], [convoId, 'own again']]) {
      const at = client.messages.length;
      client.send({ type: 'chat', conversationId: c, agent: 'researcher', content: `next, ${label}` });
      await resultOf(c, at);
    }
    const [, otherPrompt, ownPrompt, ownAgain] = prompts();
    assert.ok(!otherPrompt.includes(refusalNotice('denied', SHELL)), 'never another conversation\'s');
    assert.ok(ownPrompt.startsWith(refusalNotice('denied', SHELL)), 'opens its own next turn');
    assert.ok(!ownAgain.includes(refusalNotice('denied', SHELL)), 'and only once');
  });
});
