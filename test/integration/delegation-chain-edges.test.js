'use strict';
// Characterization: the SKIP-LEVEL handback and the roster-refresh flag on
// live delegations. Before this file, the skip-level restore (a sub-delegate
// hands back while the top orchestrator's process is still alive: the
// mid-level parent is skipped and the orchestrator restored directly) had NO
// deterministic pin. It was covered only when unrelated tests happened to
// win a timing race, so the coverage floor held or failed with runner load
// (the post-merge floor failure that motivated this file).
//
// The deterministic construction: a WS-message delegation PARKS the parent
// alive (only interception kills), so cos stays alive for the whole chain
// by design, never by timing:
//   cos --(WS delegate, parked alive)--> content-lead
//       --(intercepted Agent call, lead killed)--> content-analyst
// The sub-delegate's handback then always finds the living orchestrator.
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

test('COMPLETE from a sub-delegate skips the mid-level parent and parks the living orchestrator', async () => {
  const convoId = h.freshConvoId('skipc');
  await startOrchestrator(convoId, 'skipc-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'skipc task' },
      turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skipc sub brief' } }] },
    { match: { agent: 'content-analyst', promptIncludes: 'skipc sub brief' },
      turn: [{ text: 'SUB-COMPLETE-OUT delivered. <!-- RUNDOCK:COMPLETE -->' }] },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skipc task' });

  // Chain down: cos -> lead (parked), lead -> analyst (intercepted).
  await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'content-analyst', { since, label: 'switch to sub-delegate' });
  const { index: subResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-analyst', { since, label: 'sub-delegate result' });

  // Skip-level restore: the switch goes STRAIGHT from the sub-delegate to
  // the orchestrator; the mid-level lead is never restored.
  const { msg: swBack } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since: subResultIdx, label: 'skip-level switch back' });
  assert.strictEqual(swBack.fromAgent, 'content-analyst', 'handback skips the mid-level parent');
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since: subResultIdx, label: 'done after skip-level handback' });

  const leadRestart = client.messages.slice(subResultIdx).find(
    m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'content-lead');
  assert.ok(!leadRestart, 'the mid-level lead is skipped, never respawned');

  // COMPLETE gate: the orchestrator entry is the parked ORIGINAL (alive the
  // whole time by construction), left idle with no auto-resume.
  const entry = h.internal.chatProcesses.get(convoId);
  assert.strictEqual(entry.agentId, 'chief-of-staff');
  assert.strictEqual(entry.exited, false, 'the orchestrator was alive throughout: parked, never killed');
  assert.strictEqual(entry.idle, true, 'COMPLETE leaves the orchestrator idle for the user');
  assert.strictEqual(entry.delegation, null, 'delegation state cleared');
  h.reapConvo(convoId);
});

test('RETURN from a sub-delegate auto-continues the living orchestrator with the routing prompt', async () => {
  const convoId = h.freshConvoId('skipr');
  await startOrchestrator(convoId, 'skipr-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'skipr task' },
      turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skipr sub brief' } }] },
    { match: { agent: 'content-analyst', promptIncludes: 'skipr sub brief' },
      turn: [{ text: 'Outside my scope. <!-- RUNDOCK:RETURN -->' }] },
    // The routing prompt is written to the LIVING orchestrator's stdin (no
    // respawn): the same parked process answers it.
    { match: { agent: 'chief-of-staff', promptIncludes: 'A specialist just returned' },
      turn: [{ text: 'Routing the pending request onward.' }] },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skipr task' });

  const { index: subResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-analyst', { since, label: 'sub-delegate result' });
  const { msg: swBack } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since: subResultIdx, label: 'skip-level switch back' });
  assert.strictEqual(swBack.fromAgent, 'content-analyst');

  // RETURN auto-continue: process_started with autoContinue on the SAME
  // process, then the orchestrator's routing answer.
  const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { since: subResultIdx, label: 'auto-continue started' });
  assert.ok(started, 'the living orchestrator is driven, not respawned');
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff' && /Routing the pending request onward/.test(m.result || ''), { since: subResultIdx, label: 'routing answer' });
  h.reapConvo(convoId);
});

test('agent CRUD while a delegation is live flags the delegate AND the parked parent', async () => {
  const convoId = h.freshConvoId('crudflag');
  await startOrchestrator(convoId, 'crudflag-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'crudflag task' }, turn: [{ text: 'Working, staying in the conversation.' }] },
  ]);
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'crudflag task' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate result' });

  client.send({ type: 'save_agent', name: 'crudflag-agent', content: '---\nname: crudflag-agent\ndisplayName: Cf\nrole: Temp\ndescription: Temporary test agent\ntype: specialist\norder: 9\nreportsTo: chief-of-staff\n---\nTemp.\n' });
  await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'crudflag-agent', { label: 'agent_saved' });

  const delegateEntry = h.internal.chatProcesses.get(convoId);
  assert.strictEqual(delegateEntry.agentId, 'content-lead');
  assert.strictEqual(delegateEntry.crudHappened, true, 'the live delegate knows CRUD happened');
  assert.strictEqual(delegateEntry.delegation.originalEntry.needsRosterRefresh, true,
    'the parked parent is flagged for roster refresh on resume');
  h.reapConvo(convoId);
});
