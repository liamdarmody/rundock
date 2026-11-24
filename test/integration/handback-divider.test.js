'use strict';
// EVERY WAY CONTROL COMES BACK READS AS A HANDBACK.
//
// There are five places the server hands the conversation back to the agent
// that had it: a specialist returning scope on its own, an intercepted
// delegate returning work outside its scope, a respawned parent, a live parent
// restored after a `delegate` request, and the parent restored when a delegate
// fails to spawn. Each sends an agent_switch, and the page decides from that
// message alone what the divider says. So each test here drives one path,
// takes the switch the client actually received, and runs it through the
// page's own reducer and markup: the words a person reads must be
// "Wren handed back to Cos" on every path, never an arrival.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..', '..');
const h = require(path.join(ROOT, 'test', 'helpers', 'harness.js'));
const { standardTeam } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));
const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
const markup = require(path.join(ROOT, 'public', 'chat-markup.js'));

// The two agents as the page knows them, named as standardTeam() names them.
const TEAM = {
  'chief-of-staff': { id: 'chief-of-staff', displayName: 'Cos', icon: 'C', colour: '#E87A5A', type: 'orchestrator' },
  'content-lead': { id: 'content-lead', displayName: 'Wren', icon: 'W', colour: '#4A90D9', type: 'specialist' },
};

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

// What the page draws for this switch, as a screen reader reads it: the
// avatars are hidden from it, so they are taken out before the words are read.
function drawnFor(sw) {
  const ctx = {
    isActive: true, convoAgentId: 'chief-of-staff',
    toAgentExists: !!TEAM[sw.toAgent], fromAgentExists: !!TEAM[sw.fromAgent],
    toAgentType: TEAM[sw.toAgent] ? TEAM[sw.toAgent].type : undefined,
  };
  const state = { ...cs.createState(), activeAgentId: sw.fromAgent, delegationActive: true };
  return cs.reduce(state, sw, ctx).effects
    .filter((ef) => ef.type === 'show-delegation-divider')
    .map((ef) => markup.delegationDividerHtml(TEAM[ef.fromAgentId], TEAM[ef.toAgentId], ef.isReturn)
      .replace(/<span class="avatar xs"[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function waitForHandback(convoId, since) {
  return client.waitFor((m) => m.type === 'system' && m.subtype === 'agent_switch'
    && m._conversationId === convoId && m.fromAgent === 'content-lead' && m.toAgent === 'chief-of-staff',
  { since, label: 'control came back to the orchestrator', timeout: 20000 }).then(({ msg }) => msg);
}

function assertHandback(sw) {
  assert.strictEqual(sw.returning, true, 'the switch says control is coming back');
  assert.deepStrictEqual(drawnFor(sw), ['Wren handed back to Cos'],
    'the person reads who handed the conversation back, never an arrival');
}

describe('each path control comes back through draws who handed it back', () => {
  test('a specialist returning scope on its own is drawn as a handback', async () => {
    const convoId = h.freshConvoId('hb-scope');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'not my area' },
        turn: [{ text: 'That is outside what I handle. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'I will take it from here.' }] },
    ]);
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', activeAgentId: 'content-lead', title: 'Scope return' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'not my area' });
    assertHandback(await waitForHandback(convoId, since));
    await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId
      && m._agent === 'chief-of-staff', { since, label: 'the orchestrator finished its turn', timeout: 20000 });
    h.reapConvo(convoId);
  });

  test('an intercepted delegate returning work outside its scope is drawn as a handback', async () => {
    const convoId = h.freshConvoId('hb-out');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'route this one' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to Wren.', prompt: 'the routed brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'the routed brief' },
        turn: [{ text: 'Not mine. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'outside their scope' }, turn: [{ text: 'COS-ROUTED-IT' }] },
    ]);
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Out of scope' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'route this one' });
    assertHandback(await waitForHandback(convoId, since));
    await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && m.result === 'COS-ROUTED-IT',
      { since, label: 'the orchestrator picked it up', timeout: 20000 });
    h.reapConvo(convoId);
  });

  test('a respawned parent after a finished delegation is drawn as a handback, though it stays silent', async () => {
    const convoId = h.freshConvoId('hb-respawn');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'hand it over' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'the finished brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'the finished brief' },
        turn: [{ text: 'DELIVERED. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Respawned parent' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'hand it over' });
    const sw = await waitForHandback(convoId, since);
    assert.strictEqual(sw.silent, true, 'sanity: a parent that will say nothing is restored silently');
    assertHandback(sw);
    await client.waitForEvent('system', 'done', convoId);
    h.reapConvo(convoId);
  });

  test('a live parent restored after a delegate request is drawn as a handback, though it stays silent', async () => {
    const convoId = h.freshConvoId('hb-live');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'open the room' }, turn: [{ text: 'ready' }] },
      { match: { agent: 'content-lead', promptIncludes: 'the live brief' },
        turn: [{ text: 'DELIVERED. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'noted' }] },
    ]);
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Live parent' } });
    const opened = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'open the room' });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId,
      { since: opened, label: 'the parent is live' });
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'the live brief' });
    const sw = await waitForHandback(convoId, since);
    assert.strictEqual(sw.silent, true, 'sanity: a parent restored to park is restored silently');
    assertHandback(sw);
    h.reapConvo(convoId);
  });

  test('the parent restored when a delegate fails to spawn is drawn as a handback', async () => {
    // The spawn failure itself is the server's own handler, called in-process
    // on a delegate whose parked parent is alive: what reaches the client is
    // the switch that handler sends.
    const convoId = h.freshConvoId('hb-spawnerr');
    const idleProcess = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = { writable: true, write: () => true };
      proc.kill = () => {};
      return proc;
    };
    const parent = { process: idleProcess(), buffer: '', processId: 'hb-parent', agentId: 'chief-of-staff',
      responseText: '', exited: false, resultSent: true, toolCalls: [], delegation: {} };
    const delegate = { process: idleProcess(), buffer: '', processId: 'hb-delegate', agentId: 'content-lead',
      responseText: '', exited: false, resultSent: false, toolCalls: [], delegation: { originalEntry: parent } };
    h.internal.chatProcesses.set(convoId, delegate);
    const since = client.messages.length;
    h.internal.handleChatSpawnError({ code: 'ENOENT', message: 'not found' }, convoId);
    const sw = await waitForHandback(convoId, since);
    assert.strictEqual(h.internal.chatProcesses.get(convoId), parent, 'sanity: the parked parent was restored');
    assertHandback(sw);
    h.internal.chatProcesses.delete(convoId);
  });
});
