'use strict';
// A CARD FOR EACH AGENT OR SKILL CHANGE DOC MAKES WHILE ANOTHER AGENT BROUGHT
// IT IN, through the real server.
//
// THE DEFECT. Only Doc's markers change agents and skills, but Doc takes a
// delegating agent's "go ahead" as the person's consent, and any agent can
// bring Doc in, with an Agent call the server intercepts or a DELEGATE marker,
// and a brief it wrote. So an agent steered by text it read could have Doc
// create, replace or delete an agent or skill with no person involved.
//
// WHAT IS ASSERTED, AND WHERE. On the cards the server raises (the
// control_request a window is sent, and the server's own pending requests), on
// the files in the workspace's .claude/agents/ and .claude/skills/, byte for
// byte, before and after each answer, and on the prompts the stub runtime is
// sent. Each turn runs on the stub Claude runtime against the real server, and
// each card is answered the way a window answers one, over an authenticated
// socket.
//
// The card timeout is shortened in this process, before the server is loaded,
// so "nobody answered" is reached in seconds.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

const PERM_TIMEOUT = 3000;
before(async () => {
  await h.boot({ agents: standardTeam(), env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(PERM_TIMEOUT) } });
});
after(async () => h.shutdown());

const CARD_NAMES = ['SaveAgent', 'DeleteAgent', 'SaveSkill', 'DeleteSkill'];
const agentPath = (name) => path.join(h.workspaceDir, '.claude', 'agents', `${name}.md`);
const skillPath = (name) => path.join(h.workspaceDir, '.claude', 'skills', name, 'SKILL.md');
const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const snapshot = (files) => files.map(readOrNull);
const openWindows = () => [...h.internal.connectedClients].filter((c) => c.readyState === 1).length;

function teamFile(name, label, type = 'specialist') {
  return agentFile({
    name, displayName: label, role: 'Example Role', description: 'An example agent',
    type, order: 30, reportsTo: 'chief-of-staff', body: `You are ${label}.`,
  }).trim();
}
const skillFile = (name, words = 'Do the example.') => `---\nname: ${name}\ndescription: An example skill.\n---\n\n${words}`;
const saveAgent = (name, body) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${body}\n<!-- /RUNDOCK:SAVE_AGENT -->`;
const createAgent = (name, body) => `<!-- RUNDOCK:CREATE_AGENT name=${name} -->\n${body}\n<!-- /RUNDOCK:CREATE_AGENT -->`;
const saveSkill = (name, body) => `<!-- RUNDOCK:SAVE_SKILL name=${name} -->\n${body}\n<!-- /RUNDOCK:SAVE_SKILL -->`;
const deleteAgent = (name) => `<!-- RUNDOCK:DELETE_AGENT name=${name} -->`;
const deleteSkill = (name) => `<!-- RUNDOCK:DELETE_SKILL name=${name} -->`;

function seedAgent(name, label = 'Before', type = 'specialist') {
  fs.writeFileSync(agentPath(name), teamFile(name, label, type));
  h.internal.invalidateAgentCache();
}
function seedSkill(name) {
  fs.mkdirSync(path.dirname(skillPath(name)), { recursive: true });
  fs.writeFileSync(skillPath(name), skillFile(name));
}
function removeAll(agents = [], skills = []) {
  for (const name of agents) fs.rmSync(agentPath(name), { force: true });
  for (const name of skills) fs.rmSync(path.dirname(skillPath(name)), { recursive: true, force: true });
  h.internal.invalidateAgentCache();
}

// The five changes in one reply, against files seeded for it: an agent saved
// over, a new agent made with the legacy CREATE marker, an agent deleted, a
// new skill, and a skill deleted.
function fiveChanges(p) {
  return [
    saveAgent(`${p}-saved`, teamFile(`${p}-saved`, 'After')),
    createAgent(`${p}-made`, teamFile(`${p}-made`, 'Made')),
    deleteAgent(`${p}-gone`),
    saveSkill(`${p}-skill`, skillFile(`${p}-skill`)),
    deleteSkill(`${p}-gone-skill`),
  ].join('\n');
}
const fiveFiles = (p) => [agentPath(`${p}-saved`), agentPath(`${p}-made`), agentPath(`${p}-gone`), skillPath(`${p}-skill`), skillPath(`${p}-gone-skill`)];
function seedFive(p) {
  seedAgent(`${p}-saved`, 'Before');
  seedAgent(`${p}-gone`, 'Gone');
  seedSkill(`${p}-gone-skill`);
  return snapshot(fiveFiles(p));
}
const removeFive = (p) => removeAll([`${p}-saved`, `${p}-made`, `${p}-gone`], [`${p}-skill`, `${p}-gone-skill`]);

// The cards a window was sent for one conversation, and the server's own
// pending requests behind them.
const isCard = (convoId) => (m) => m.type === 'control_request' && m._conversationId === convoId
  && m.request && CARD_NAMES.includes(m.request.tool_name);
async function cardsFor(client, convoId, n, since = 0) {
  assert.ok(await h.waitUntil(() => client.messages.slice(since).filter(isCard(convoId)).length >= n, { timeout: 15000 }),
    `${n} card(s) raised (got ${client.messages.slice(since).filter(isCard(convoId)).length})`);
  return client.messages.slice(since).filter(isCard(convoId));
}
const pendingFor = (convoId) => [...h.internal.pendingPermissionRequests.values()]
  .filter((p) => p.conversationId === convoId && CARD_NAMES.includes(p.toolName));
function answer(client, card, allow, extra = { card: true }) {
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId, allow, ...extra });
}

// The line a window is sent for one outcome that wrote nothing.
const lineFor = (client, convoId, text, since = 0) => client.waitFor((m) => (m.type === 'agent_error' || m.type === 'skill_error')
  && m.conversationId === convoId && typeof m.message === 'string' && m.message.includes(text), { since, timeout: 15000, label: `the line "${text}"` });

// Doc brought in by the orchestrator's Agent call: the orchestrator's turn
// carrying `${token}-ASK` calls Doc with a brief carrying `${token}-BRIEF`, and
// Doc's reply is `reply`. Handed the conversation back, the orchestrator says
// nothing.
function agentCall(token, reply, { brief = 'change the team', more = [] } = {}) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: `${token}-ASK` },
      turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: `${token}-BRIEF ${brief}` } }] },
    { match: { agent: 'rundock-guide', promptIncludes: `${token}-BRIEF` }, turn: [{ text: reply }] },
    ...more,
    { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
  ]);
}
// The orchestrator's prompts once it was handed the conversation back after
// Doc's reply carrying `${token}-DONE`.
const handBacks = (token) => h.readPrompts().filter((p) => p.agent === 'chief-of-staff'
  && p.prompt.includes('[SYSTEM: pipeline-complete]') && p.prompt.includes(`${token}-DONE`)).map((p) => p.prompt);
async function handBack(token, timeout = 15000) {
  assert.ok(await h.waitUntil(() => handBacks(token).length > 0, { timeout }), 'the orchestrator was handed the conversation back');
  return handBacks(token)[0];
}
const HEADING = 'WHAT RUNDOCK DID WITH THE LAST REPLY:';
const note = (...lines) => `${HEADING}\n${lines.join('\n')}\n\n`;

// Doc brought in by a DELEGATE marker: the orchestrator answers once and is
// parked, then its reply's DELEGATE marker reaches the server as the window
// sends it.
async function delegateMarker(client, convoId, token, reply) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: `${token}-SETUP` },
      turn: [{ text: `Bringing in Doc.\n<!-- RUNDOCK:DELEGATE agent=rundock-guide -->\n${token}-BRIEF change the team\n<!-- /RUNDOCK:DELEGATE -->` }] },
    { match: { agent: 'rundock-guide', promptIncludes: `${token}-BRIEF` }, turn: [{ text: reply }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${token}-SETUP` });
  await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'the orchestrator parked' });
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'rundock-guide', context: `${token}-BRIEF change the team` });
}

describe('In a hand-off, each change raises its own card before anything is written', () => {
  test('Doc brought in by an orchestrator\'s Agent call: one card per change, five in one reply, and nothing written while they wait', async () => {
    const p = 'cardcall';
    const convoId = h.freshConvoId(p);
    const before = seedFive(p);
    agentCall('CARDCALL', `CARDCALL-DONE working on it.\n${fiveChanges(p)}`);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'CARDCALL-ASK change the team' });
      const cards = await cardsFor(client, convoId, 5);
      assert.deepStrictEqual(cards.map((c) => [c.request.tool_name, c.request.input.name]), [
        ['SaveAgent', `${p}-saved`], ['SaveAgent', `${p}-made`], ['DeleteAgent', `${p}-gone`], ['SaveSkill', `${p}-skill`], ['DeleteSkill', `${p}-gone-skill`],
      ], 'one card per marker, in the reply\'s order');
      assert.strictEqual(new Set(cards.map((c) => c.request_id)).size, 5, 'each its own card');
      assert.strictEqual(pendingFor(convoId).length, 5, 'raised through the server\'s own permission request');
      await h.delay(300);
      assert.deepStrictEqual(snapshot(fiveFiles(p)), before, 'nothing is written while the cards wait');
      const since = client.messages.length;
      for (const card of cards) answer(client, card, false);
      for (const name of [`${p}-saved`, `${p}-made`, `${p}-gone`, `${p}-skill`, `${p}-gone-skill`]) await lineFor(client, convoId, `"${name}"`, since);
      assert.deepStrictEqual(snapshot(fiveFiles(p)), before, 'and nothing after five Denies');
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeFive(p);
    }
  });

  test('Doc brought in by a DELEGATE marker: one card per change, and nothing written while they wait', async () => {
    const convoId = h.freshConvoId('cardmarker');
    seedAgent('cardmarker-old');
    seedSkill('cardmarker-skill');
    const files = [agentPath('cardmarker-new'), agentPath('cardmarker-old'), skillPath('cardmarker-skill')];
    const before = snapshot(files);
    const client = await h.connect();
    try {
      await delegateMarker(client, convoId, 'CARDMARKER',
        `On it.\n${saveAgent('cardmarker-new', teamFile('cardmarker-new', 'New'))}\n${deleteAgent('cardmarker-old')}\n${deleteSkill('cardmarker-skill')}`);
      const cards = await cardsFor(client, convoId, 3);
      assert.deepStrictEqual(cards.map((c) => c.request.tool_name), ['SaveAgent', 'DeleteAgent', 'DeleteSkill']);
      await h.delay(300);
      assert.deepStrictEqual(snapshot(files), before, 'nothing is written while the cards wait');
      const since = client.messages.length;
      for (const card of cards) answer(client, card, false);
      await lineFor(client, convoId, '"cardmarker-skill"', since);
      assert.deepStrictEqual(snapshot(files), before, 'and nothing after the Denies');
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeAll(['cardmarker-new', 'cardmarker-old'], ['cardmarker-skill']);
    }
  });
});

describe('Written only on an Allow a person gave on that card', () => {
  test('Allow on each card: each change is written once, exactly, and its outcome is saved, updated or deleted', async () => {
    const p = 'allowall';
    const convoId = h.freshConvoId(p);
    seedFive(p);
    agentCall('ALLOWALL', `ALLOWALL-DONE working on it.\n${fiveChanges(p)}`);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ALLOWALL-ASK change the team' });
      const cards = await cardsFor(client, convoId, 5);
      const since = client.messages.length;
      for (const card of cards) answer(client, card, true);
      const prompt = await handBack('ALLOWALL');
      assert.strictEqual(fs.readFileSync(agentPath(`${p}-saved`), 'utf-8'), teamFile(`${p}-saved`, 'After'), 'the agent saved over holds the marker\'s content');
      assert.strictEqual(fs.readFileSync(agentPath(`${p}-made`), 'utf-8'), teamFile(`${p}-made`, 'Made'), 'the new agent was made');
      assert.strictEqual(fs.existsSync(agentPath(`${p}-gone`)), false, 'the agent was deleted');
      assert.strictEqual(fs.readFileSync(skillPath(`${p}-skill`), 'utf-8'), skillFile(`${p}-skill`), 'the skill was made');
      assert.strictEqual(fs.existsSync(path.dirname(skillPath(`${p}-gone-skill`))), false, 'the skill was deleted');
      const mine = (type, key, name) => client.messages.slice(since).filter((m) => m.type === type && m[key] === name && m.conversationId === convoId);
      assert.deepStrictEqual(mine('agent_saved', 'agentId', `${p}-saved`).map((m) => m.updated), [true], 'one confirmation, updated');
      assert.deepStrictEqual(mine('agent_saved', 'agentId', `${p}-made`).map((m) => m.updated), [false], 'one confirmation, created');
      assert.strictEqual(mine('agent_deleted', 'agentId', `${p}-gone`).length, 1);
      assert.strictEqual(mine('skill_saved', 'skillId', `${p}-skill`).length, 1);
      assert.strictEqual(mine('skill_deleted', 'skillId', `${p}-gone-skill`).length, 1);
      for (const line of [`- Saved (updated): agent "${p}-saved", asked by Doc.`, `- Saved (new): agent "${p}-made", asked by Doc.`,
        `- Deleted: agent "${p}-gone", asked by Doc.`, `- Saved (new): skill "${p}-skill", asked by Doc.`, `- Deleted: skill "${p}-gone-skill", asked by Doc.`]) {
        assert.ok(prompt.startsWith(HEADING) && prompt.split('\n\n')[0].includes(line), `the hand-back says: ${line} (got ${JSON.stringify(prompt.slice(0, 600))})`);
      }
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeFive(p);
    }
  });

  test('Deny: nothing is written, and the outcome is refused, saying it was not allowed', async () => {
    const convoId = h.freshConvoId('deny');
    seedAgent('deny-helper', 'Before');
    const before = snapshot([agentPath('deny-helper')]);
    agentCall('DENY', `DENY-DONE replaced it.\n${saveAgent('deny-helper', teamFile('deny-helper', 'After'))}`);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'DENY-ASK replace the helper' });
      const [card] = await cardsFor(client, convoId, 1);
      const since = client.messages.length;
      answer(client, card, false);
      const refusal = 'Doc asked to save the agent "deny-helper", but it was not allowed on the card, so nothing was saved.';
      const { msg } = await lineFor(client, convoId, refusal, since);
      assert.strictEqual(msg.refused, true);
      assert.strictEqual(await handBack('DENY').then((p) => p.startsWith(note(`- Refused: save agent "deny-helper", asked by Doc. ${refusal}`))), true,
        'the orchestrator is told it was refused');
      assert.deepStrictEqual(snapshot([agentPath('deny-helper')]), before, 'the file is as it was, byte for byte');
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeAll(['deny-helper']);
    }
  });

  test('No answer before the timeout, with every window closed: nothing is written, and the outcome is refused, saying nobody answered', async () => {
    const convoId = h.freshConvoId('noanswer');
    seedSkill('noanswer-skill');
    const files = [agentPath('noanswer-helper'), skillPath('noanswer-skill')];
    const before = snapshot(files);
    agentCall('NOANSWER', `NOANSWER-DONE done.\n${saveAgent('noanswer-helper', teamFile('noanswer-helper', 'Helper'))}\n${deleteSkill('noanswer-skill')}`);
    const temp = await h.connect();
    temp.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NOANSWER-ASK add a helper' });
    await cardsFor(temp, convoId, 2);
    temp.close();
    try {
      assert.ok(await h.waitUntil(() => openWindows() === 0), 'no window is open while the cards wait');
      const prompt = await handBack('NOANSWER', PERM_TIMEOUT + 10000);
      const saved = 'Doc asked to save the agent "noanswer-helper", but nobody answered the card in time, so nothing was saved.';
      const deleted = 'Doc asked to delete the skill "noanswer-skill", but nobody answered the card in time, so nothing was deleted.';
      assert.ok(prompt.startsWith(HEADING) && prompt.includes(`- Refused: save agent "noanswer-helper", asked by Doc. ${saved}`)
        && prompt.includes(`- Refused: delete skill "noanswer-skill", asked by Doc. ${deleted}`), `both refused (got ${JSON.stringify(prompt.slice(0, 500))})`);
      assert.deepStrictEqual(snapshot(files), before, 'nothing is written, byte for byte');
      const next = await h.connect();
      next.send({ type: 'flush_buffer' });
      await lineFor(next, convoId, saved);
      await lineFor(next, convoId, deleted);
      next.close();
    } finally {
      h.reapConvo(convoId);
      removeAll(['noanswer-helper'], ['noanswer-skill']);
    }
  });

  test('An allow that did not come from a card writes nothing', async () => {
    const convoId = h.freshConvoId('nocard');
    seedAgent('nocard-one', 'Before');
    seedAgent('nocard-two', 'Before');
    const files = [agentPath('nocard-one'), agentPath('nocard-two')];
    const before = snapshot(files);
    agentCall('NOCARD', `NOCARD-DONE replaced both.\n${saveAgent('nocard-one', teamFile('nocard-one', 'After'))}\n${deleteAgent('nocard-two')}`);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NOCARD-ASK replace them' });
      const [one, two] = await cardsFor(client, convoId, 2);
      const since = client.messages.length;
      answer(client, one, true, {});
      answer(client, two, true, { card: 'true' });
      await lineFor(client, convoId, 'Doc asked to save the agent "nocard-one", but', since);
      await lineFor(client, convoId, 'Doc asked to delete the agent "nocard-two", but', since);
      await handBack('NOCARD');
      assert.deepStrictEqual(snapshot(files), before, 'nothing is written, byte for byte');
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeAll(['nocard-one', 'nocard-two']);
    }
  });
});

describe('No card when the person is talking to Doc', () => {
  const noCardRaised = (client, convoId) => {
    assert.deepStrictEqual(client.messages.filter(isCard(convoId)), [], 'no card was sent to the window');
    assert.deepStrictEqual(pendingFor(convoId), [], 'and the server raised no permission request');
  };

  test('a conversation started with Doc: written as before, with no card', async () => {
    const convoId = h.freshConvoId('direct');
    seedSkill('direct-skill');
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'DIRECT-ONE' },
      turn: [{ text: `Done.\n${saveAgent('direct-helper', teamFile('direct-helper', 'Helper'))}\n${deleteSkill('direct-skill')}` }] }]);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'DIRECT-ONE add a helper' });
      await client.waitFor((m) => m.type === 'skill_deleted' && m.skillId === 'direct-skill' && m.conversationId === convoId, { label: 'the delete' });
      assert.strictEqual(fs.readFileSync(agentPath('direct-helper'), 'utf-8'), teamFile('direct-helper', 'Helper'));
      assert.strictEqual(fs.existsSync(path.dirname(skillPath('direct-skill'))), false);
      noCardRaised(client, convoId);
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeAll(['direct-helper'], ['direct-skill']);
    }
  });

  test('a conversation the person switched to Doc: written as before, with no card', async () => {
    const convoId = h.freshConvoId('switched');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'SWITCHED-ONE' }, turn: [{ text: 'Ask Doc for that.' }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'SWITCHED-TWO' },
        turn: [{ text: `Done.\n${saveAgent('switched-helper', teamFile('switched-helper', 'Helper'))}` }] },
    ]);
    const client = await h.connect();
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'SWITCHED-ONE add a helper' });
      await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { label: 'the specialist\'s reply' });
      h.reapConvo(convoId);
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'SWITCHED-TWO then you do it' });
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'switched-helper' && m.conversationId === convoId, { label: 'the save' });
      assert.strictEqual(fs.readFileSync(agentPath('switched-helper'), 'utf-8'), teamFile('switched-helper', 'Helper'));
      noCardRaised(client, convoId);
    } finally {
      client.close();
      h.reapConvo(convoId);
      removeAll(['switched-helper']);
    }
  });
});
