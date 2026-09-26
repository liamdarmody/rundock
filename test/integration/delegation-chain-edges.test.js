'use strict';
// Characterization: where a sub-delegate's handback goes, and the
// roster-refresh flag on live delegations.
//
// The deterministic construction: a WS-message delegation PARKS the parent
// alive (only interception kills), so cos stays alive for the whole chain
// by design, never by timing:
//   cos --(WS delegate, parked alive)--> content-lead
//       --(intercepted Agent call, lead killed)--> content-analyst
// The sub-delegate's handback then always finds the living orchestrator.
//
// WHO A HANDBACK GOES TO. Work handed back (COMPLETE, CONTINUE) returns to
// the agent that delegated it, the lead, so a three-level team keeps its own
// pipeline. Only an out-of-scope RETURN skips the lead and goes straight to
// the living orchestrator, because routing a request nobody in the chain can
// take is the orchestrator's job. That RETURN pin is the one this file was
// written for: it keeps the skip-level branch covered deterministically, so
// the coverage floor never depends on a timing race again.
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

// The orchestrator parked alive behind the lead is retired when the lead is
// resumed in its place: two processes on one orchestrator session would be a
// leak at best, and the lead's own later handback resumes the orchestrator by
// session, exactly as it does when interception started the chain.
async function assertRetired(orchestratorEntry) {
  const gone = await h.waitUntil(() => orchestratorEntry.exited === true
    && (orchestratorEntry.process.killed || orchestratorEntry.process.exitCode !== null
      || orchestratorEntry.process.signalCode !== null));
  assert.ok(gone, 'the orchestrator parked behind the lead is retired, never left running unreferenced');
}

test('COMPLETE from a sub-delegate returns to the lead that delegated, not the orchestrator', async () => {
  const convoId = h.freshConvoId('skipc');
  await startOrchestrator(convoId, 'skipc-setup');
  // Captured now, because the point of the test is that it is never restored.
  const orchestratorEntry = h.internal.chatProcesses.get(convoId);
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'skipc task' },
      turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skipc sub brief' } }] },
    { match: { agent: 'content-analyst', promptIncludes: 'skipc sub brief' },
      turn: [{ text: 'SUB-COMPLETE-OUT delivered. <!-- RUNDOCK:COMPLETE -->' }] },
    // The resumed lead is given the pipeline-complete prompt carrying the
    // analyst's output, and parks.
    { match: { agent: 'content-lead', promptIncludes: ['[SYSTEM: pipeline-complete]', 'SUB-COMPLETE-OUT'], promptExcludes: 'RUNDOCK:COMPLETE' },
      turn: [{ text: '<silent>' }] },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skipc task' });

  // Chain down: cos -> lead (parked), lead -> analyst (intercepted).
  await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'content-analyst', { since, label: 'switch to sub-delegate' });
  const { index: subResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-analyst', { since, label: 'sub-delegate result' });

  const { msg: swBack } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'content-lead', { since: subResultIdx, label: 'switch back to the lead' });
  assert.strictEqual(swBack.fromAgent, 'content-analyst');
  assert.strictEqual(swBack.silent, true, 'a lead restored only to park is not announced as arriving');

  const { msg: started, index: startedIdx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'content-lead' && m.autoContinue, { since: subResultIdx, label: 'lead restart' });
  assert.strictEqual(started.silent, true, 'the pipeline-complete restart of the lead is silent');
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since: startedIdx + 1, label: 'resumed lead result' });

  const toOrchestrator = client.messages.slice(subResultIdx).find(
    m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff');
  assert.ok(!toOrchestrator, 'the orchestrator is never surfaced when the work was handed back to the lead');

  const entry = h.internal.chatProcesses.get(convoId);
  assert.strictEqual(entry.agentId, 'content-lead', 'the lead holds the conversation');
  assert.strictEqual(entry.idle, true, 'and waits for the next message');
  await assertRetired(orchestratorEntry);
  h.reapConvo(convoId);
});

test('CONTINUE from a sub-delegate wakes the lead to carry on its own pipeline', async () => {
  const convoId = h.freshConvoId('skipn');
  await startOrchestrator(convoId, 'skipn-setup');
  const orchestratorEntry = h.internal.chatProcesses.get(convoId);
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'skipn task' },
      turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skipn sub brief' } }] },
    { match: { agent: 'content-analyst', promptIncludes: 'skipn sub brief' },
      turn: [{ text: 'SUB-PART-DONE, the rest is yours. <!-- RUNDOCK:CONTINUE -->' }] },
    { match: { agent: 'content-lead', promptIncludes: 'SUB-PART-DONE' },
      turn: [{ text: 'LEAD-CARRIES-ON with the next step.' }] },
  ]);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skipn task' });

  const { index: subResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-analyst', { since, label: 'sub-delegate result' });
  const { msg: swBack } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'content-lead', { since: subResultIdx, label: 'switch back to the lead' });
  assert.strictEqual(swBack.fromAgent, 'content-analyst');
  assert.notStrictEqual(swBack.silent, true, 'a lead that is about to act is drawn arriving');

  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead' && /LEAD-CARRIES-ON/.test(m.result || ''), { since: subResultIdx, label: 'the lead acts on the handback' });
  const leadPrompt = h.promptsFor('content-lead').filter(p => /SUB-PART-DONE/.test(p)).pop();
  assert.match(leadPrompt, /needs more work/, 'the lead is told the work continues, in the continue wording');

  const toOrchestrator = client.messages.slice(subResultIdx).find(
    m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff');
  assert.ok(!toOrchestrator, 'the orchestrator is not asked to carry on work its lead owns');
  await assertRetired(orchestratorEntry);
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

// ---------------------------------------------------------------------------
// Deterministic pins for the delegate-close arms that flipped with the CI
// schedule (the two identical main-run floor trips at 95.4/93.2). Each arm
// below was covered only when unrelated tests won a timing race; these
// constructions drive them by design. The circuit breaker is armed by
// pre-setting the per-conversation resume count through the identity-exported
// map, so ONE close crosses the threshold: no multi-hop timing chain.
// ---------------------------------------------------------------------------

test('skip-level RETURN with the resume budget spent trips the breaker: auto-pause, no auto-continue', async () => {
  const convoId = h.freshConvoId('skipbrk');
  await startOrchestrator(convoId, 'skipbrk-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'skipbrk task' },
      turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skipbrk sub brief' } }] },
    { match: { agent: 'content-analyst', promptIncludes: 'skipbrk sub brief' },
      turn: [{ text: 'Outside my scope. <!-- RUNDOCK:RETURN -->' }] },
  ]);

  // Two resumes already spent: the skip-level restore's increment is the third.
  h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);

  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skipbrk task' });

  const { index: subResultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-analyst', { since, label: 'sub-delegate result' });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since: subResultIdx, label: 'skip-level switch back' });
  const { msg: paused, index: pausedIdx } = await client.waitFor(
    m => m.type === 'assistant' && m._conversationId === convoId && /Auto-paused: \d+ consecutive agent handoffs/.test(m.message?.content || ''),
    { since: subResultIdx, label: 'auto-pause card' });
  assert.match(paused.message.content, /Agents involved: content-analyst/, 'the skip-level breaker wording names the chain');
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since: subResultIdx, label: 'done after pause' });

  const started = client.messages.slice(pausedIdx).find(
    m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m.autoContinue);
  assert.ok(!started, 'a tripped breaker never auto-continues');
  const entry = h.internal.chatProcesses.get(convoId);
  assert.strictEqual(entry.idle, true, 'the orchestrator is parked idle for the user');
  assert.strictEqual(h.internal.agentAutoResumeCount.get(convoId), 0, 'the breaker resets the budget');
  h.reapConvo(convoId);
});

test('end_delegation after a delegate follow-up auto-continues the parked parent with the pending request', async () => {
  const convoId = h.freshConvoId('wsret');
  await startOrchestrator(convoId, 'wsret-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'wsret task' }, turn: [{ text: 'Delegate here, staying in the conversation.' }] },
    { match: { agent: 'content-lead', promptIncludes: 'wsret-followup' }, turn: [{ text: 'Follow-up handled by the delegate.' }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'The specialist just returned because the user asked' },
      turn: [{ text: 'Routing wsret onward.' }] },
  ]);

  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'wsret task' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate first result' });

  // A user follow-up to the LIVE delegate sets receivedFollowUp on its entry
  // (the arm's gate) and becomes the pending request the parent must route.
  const since1 = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'wsret-followup please' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead' && /Follow-up handled/.test(m.result || ''), { since: since1, label: 'follow-up result' });
  assert.strictEqual(h.internal.chatProcesses.get(convoId).receivedFollowUp, true, 'the follow-up armed the auto-continue gate');

  const since2 = client.messages.length;
  client.send({ type: 'end_delegation', conversationId: convoId });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since: since2, label: 'restore switch' });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { since: since2, label: 'auto-continue on the parked parent' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff' && /Routing wsret onward/.test(m.result || ''), { since: since2, label: 'routing answer' });
  h.reapConvo(convoId);
});

test('end_delegation after a follow-up with the resume budget spent trips the OTHER breaker wording', async () => {
  const convoId = h.freshConvoId('wsbrk');
  await startOrchestrator(convoId, 'wsbrk-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'wsbrk task' }, turn: [{ text: 'Delegate here.' }] },
    { match: { agent: 'content-lead', promptIncludes: 'wsbrk-followup' }, turn: [{ text: 'Follow-up done.' }] },
  ]);

  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'wsbrk task' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate first result' });
  const since1 = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'wsbrk-followup please' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead' && /Follow-up done/.test(m.result || ''), { since: since1, label: 'follow-up result' });

  // The chat follow-up RESET the budget, so spend it now, after the reset.
  h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);

  const since2 = client.messages.length;
  client.send({ type: 'end_delegation', conversationId: convoId });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since: since2, label: 'restore switch' });
  const { msg: paused, index: pausedIdx } = await client.waitFor(
    m => m.type === 'assistant' && m._conversationId === convoId && /Auto-paused: \d+ consecutive agent handoffs/.test(m.message?.content || ''),
    { since: since2, label: 'auto-pause card' });
  assert.match(paused.message.content, /Last specialist: content-lead/, 'the delegate-return breaker wording names the specialist');
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since: since2, label: 'done after pause' });
  const started = client.messages.slice(pausedIdx).find(
    m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m.autoContinue);
  assert.ok(!started, 'a tripped breaker never auto-continues');
  h.reapConvo(convoId);
});

test('a delegate closing after its original is gone cleans up and unblocks, restoring nothing', async () => {
  const convoId = h.freshConvoId('wsgone');
  await startOrchestrator(convoId, 'wsgone-setup');
  h.writeScenario([
    { match: { agent: 'content-lead', promptIncludes: 'wsgone task' }, turn: [{ text: 'Delegate here.' }] },
  ]);
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'wsgone task' });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate result' });

  // The parked original dies out from under the delegation (identity access
  // through the live map: this is the exact state a crashed parent leaves).
  // Kill the real process too: once the entry leaves the map at close time,
  // reapConvo can no longer reach it, and a leaked stub child would hold the
  // test process's event loop open past the suite.
  const delegateEntry = h.internal.chatProcesses.get(convoId);
  assert.ok(delegateEntry.delegation && delegateEntry.delegation.originalEntry, 'delegation carries the parked original');
  const goneOriginal = delegateEntry.delegation.originalEntry;
  try { goneOriginal.process.kill('SIGKILL'); } catch (e) {}
  goneOriginal.exited = true;

  const since = client.messages.length;
  client.send({ type: 'end_delegation', conversationId: convoId });
  await client.waitFor(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'done after orphan close' });
  const switched = client.messages.slice(since).find(
    m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId);
  assert.ok(!switched, 'nothing to restore: no agent_switch is announced');
  assert.ok(!h.internal.chatProcesses.has(convoId), 'the conversation entry is removed');
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
