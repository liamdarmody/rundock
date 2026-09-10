'use strict';
// Integration: the handback record is written by a REAL delegation handing back.
//
// WHY THIS EXISTS RATHER THAN A SOURCE SCAN. The claim this card rests on is
// that the engine records where control returned at the moment it observes a
// handback. That was verified by matching `recordControlReturnedTo(convoId`
// within a few lines of an agent_switch announcement, which is text proximity,
// not execution. A regex passes on a call site that is unreachable, guarded by
// a condition never true, or holding a shadowed identifier.
//
// It is not a hypothetical gap. An earlier version of this fix wired the call
// into one branch only, the ordinary single-level delegation never reached it,
// and nothing failed: the unit test passed, because the unit worked. Only
// running a delegation to a real handback and reading what landed on disk can
// tell the difference.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

function storedConversation(convoId) {
  const file = path.join(h.workspaceDir, '.rundock', 'conversations.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).find((c) => c.id === convoId) || null;
}

describe('the record a real handback leaves behind', () => {
  test('a delegation that hands back records that control reached the base agent', async () => {
    const convoId = h.freshConvoId('handback');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'delegate please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'the brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'the brief' },
        turn: [{ text: 'DELIVERED-PAYLOAD. <!-- RUNDOCK:COMPLETE -->' }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }],
      },
    ]);

    // The browser persists a conversation as soon as it is used, so the record
    // the engine writes into exists by the time a handback happens. Doing the
    // same here rather than assuming it.
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Handback' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'delegate please' });

    // Control goes out to the specialist, then comes back to the orchestrator.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'out to the specialist' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'back to the orchestrator' });
    await client.waitForEvent('system', 'done', convoId);

    const stored = storedConversation(convoId);
    assert.ok(stored, 'the conversation was persisted');
    assert.strictEqual(stored.delegationReturned, true,
      'a real handback wrote the record, so a restart will reconcile this conversation');
  });

  test('a delegation still in flight leaves no such record', async () => {
    // The other direction, and the one the reported bug is about. The delegate
    // never emits a marker and never finishes, so nothing observes a handback
    // and nothing may claim one.
    const convoId = h.freshConvoId('inflight');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'start work' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'long brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'long brief' },
        turn: [{ text: 'still working on it' }],
      },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'In flight' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'start work' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'out to the specialist' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
      && m._agent === 'content-lead', { label: 'specialist spoke' });

    const stored = storedConversation(convoId);
    if (stored) {
      assert.notStrictEqual(stored.delegationReturned, true,
        'no handback was observed, so the conversation is still delegated');
    }
  });
});

describe('the other paths control can return through', () => {
  test('a sub-delegate returning to its lead leaves the conversation delegated', async () => {
    // NESTED. The orchestrator delegates to a lead, the lead delegates to its
    // own report, and that report finishes. Control goes back to the LEAD, not
    // to the orchestrator, so the conversation has not come home and its record
    // must not say it has. A bare boolean could not express this, which is what
    // an earlier version of this fix got wrong.
    const convoId = h.freshConvoId('nested');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'nested please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'lead brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'analyst brief' } }],
      },
      {
        match: { agent: 'content-analyst', promptIncludes: 'analyst brief' },
        turn: [{ text: 'ANALYST-DONE. <!-- RUNDOCK:COMPLETE -->' }],
      },
      {
        // The lead takes the analyst's output and finishes too, so control
        // carries on up to the orchestrator. That second leg is what makes the
        // first assertion mean something: without it, "not returned" would hold
        // just as well over a conversation where nothing was ever recorded.
        match: { agent: 'content-lead', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: 'LEAD-DONE. <!-- RUNDOCK:COMPLETE -->' }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'LEAD-DONE' },
        turn: [{ text: '<silent>' }],
      },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Nested' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'nested please' });

    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-analyst', { label: 'down to the analyst' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'back up to the lead' });

    const midChain = storedConversation(convoId);
    assert.ok(midChain, 'the conversation was persisted');
    assert.notStrictEqual(midChain.delegationReturned, true,
      'control reached the lead, not the base agent, so this conversation is still delegated');

    // And when the lead finishes too, control does reach the base agent.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'home to the orchestrator' });
    await client.waitForEvent('system', 'done', convoId);

    const home = storedConversation(convoId);
    assert.strictEqual(home.delegationReturned, true,
      'the same conversation records the return once control actually reaches its base agent, '
      + 'which is what makes the mid-chain assertion above discriminating rather than vacuous');
  });
});
