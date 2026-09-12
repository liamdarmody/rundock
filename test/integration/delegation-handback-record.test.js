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
    // MATCHED BY WHERE IT CAME FROM, not only by where it goes. `toAgent ===
    // 'content-lead'` also matches the FORWARD delegation earlier in this same
    // scenario, so the original wait could be satisfied by the handoff out
    // rather than the handback in. It passed either way while it only checked
    // that control reached the lead; asserting what the message SAYS made the
    // ambiguity visible immediately.
    const backUp = (await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.fromAgent === 'content-analyst'
      && m.toAgent === 'content-lead', { label: 'back up to the lead' })).msg;
    // The analyst finished the delegated pipeline, so the lead is restored to
    // park rather than to speak. Drawn as nothing, on the mid-level path.
    assert.strictEqual(backUp.silent, true,
      'a lead restored only to park is not announced as arriving');

    const midChain = storedConversation(convoId);
    assert.ok(midChain, 'the conversation was persisted');
    assert.notStrictEqual(midChain.delegationReturned, true,
      'control reached the lead, not the base agent, so this conversation is still delegated');

    // And when the lead finishes too, control does reach the base agent.
    const homeSwitch = (await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'home to the orchestrator' })).msg;
    // Same again one level up: the lead also finished, so the orchestrator is
    // restored to park. Two of the four restoration paths asserted on the real
    // message in this one scenario.
    assert.strictEqual(homeSwitch.silent, true,
      'and neither is the orchestrator, restored to park behind it');
    await client.waitForEvent('system', 'done', convoId);

    const home = storedConversation(convoId);
    assert.strictEqual(home.delegationReturned, true,
      'the same conversation records the return once control actually reaches its base agent, '
      + 'which is what makes the mid-chain assertion above discriminating rather than vacuous');
  });
});

describe('a specialist returning scope on its own', () => {
  test('a direct specialist that returns scope records where control went', async () => {
    // THE PATH A SOURCE SCAN COULD NOT PROVE. This one does not go through the
    // Agent-tool interception at all: the person is talking to the specialist,
    // the specialist decides the request is outside its scope, emits a RETURN
    // marker, and its process closes carrying that. Control goes back to the
    // orchestrator through handleScopeReturn, which is a different branch from
    // every other test here.
    const convoId = h.freshConvoId('scopereturn');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'content-lead', promptIncludes: 'not my area' },
        turn: [{ text: 'That is outside what I handle. <!-- RUNDOCK:RETURN -->' }],
      },
      {
        match: { agent: 'chief-of-staff' },
        turn: [{ text: 'I will take it from here.' }],
      },
    ]);

    // The conversation belongs to the orchestrator; the specialist is who is
    // being spoken to right now.
    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', activeAgentId: 'content-lead', title: 'Scope return' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'not my area' });

    const scopeReturn = (await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'scope return to the orchestrator' })).msg;

    // THE FOURTH RESTORATION PATH, and the direction the other three do not
    // cover. A RETURN drives the orchestrator to act ("I will take it from
    // here"), so the arrival MUST be drawn: suppressing it here would hide a
    // real handover. The three silent cases prove nothing is drawn for an agent
    // that will not speak; this proves something is drawn for one that will,
    // which is the half a silence-only suite would happily lose.
    assert.notStrictEqual(scopeReturn.silent, true,
      'an arrival is announced when the agent restored is about to speak');

    const stored = storedConversation(convoId);
    assert.ok(stored, 'the conversation was persisted');
    assert.strictEqual(stored.delegationReturned, true,
      'a scope return that reaches the base agent is recorded, so a restart reconciles it');
  });
});

describe('a delegation whose parent stayed alive', () => {
  test('restoring a live parent records where control went', async () => {
    // THE LAST PATH A SOURCE SCAN COULD NOT PROVE. A `delegate` request is not
    // an Agent-tool interception: the parent process is parked rather than
    // replaced, so when the delegate finishes the parent is simply restored.
    // That is its own branch, and nothing here had ever executed it.
    const convoId = h.freshConvoId('liveparent');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'open the thread' }, turn: [{ text: 'ready' }] },
      {
        match: { agent: 'content-lead', promptIncludes: 'live-parent brief' },
        turn: [{ text: 'DELIVERED. <!-- RUNDOCK:COMPLETE -->' }],
      },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'noted' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Live parent' } });
    // A live parent to park: the delegation below is refused without one.
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'open the thread' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'parent is live' });

    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'live-parent brief' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'out to the delegate' });
    const restored = (await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'parent restored' })).msg;

    // AND IT IS DRAWN AS NOTHING, because this parent is restored to park.
    // The delegate emitted COMPLETE and no follow-up arrived, so nothing will
    // wake it: an arrival drawn here shows an agent joining and doing nothing,
    // which is the reported hang. Asserted on the message the client actually
    // received, for this path specifically, because the first fix for that hang
    // reached one restoration path of four and no test noticed.
    assert.strictEqual(restored.silent, true,
      'the restore of a parent that will not speak is silent');

    const stored = storedConversation(convoId);
    assert.ok(stored, 'the conversation was persisted');
    assert.strictEqual(stored.delegationReturned, true,
      'restoring the live parent recorded that control reached the base agent');
  });
});

describe('control skipping a mid-level parent to reach the orchestrator', () => {
  test('a report handing back past its lead records reaching the base agent', async () => {
    // THE FOURTH CALL SITE, and the one an earlier claim of completeness had
    // wrong. It needs a shape none of the tests above build: a non-intercepted
    // `delegate` to a lead, so the ORCHESTRATOR's process is parked alive and
    // the lead carries a live originalEntry; then the lead intercepts an
    // Agent-tool call to one of its own reports; then that report finishes.
    // Control skips the lead and goes straight back to the parked orchestrator,
    // which is its own branch.
    const convoId = h.freshConvoId('skiplevel');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'open it' }, turn: [{ text: 'ready' }] },
      {
        match: { agent: 'content-lead', promptIncludes: 'lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'analyst brief' } }],
      },
      {
        match: { agent: 'content-analyst', promptIncludes: 'analyst brief' },
        turn: [{ text: 'ANALYST-DONE. <!-- RUNDOCK:COMPLETE -->' }],
      },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: '<silent>' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: '<silent>' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Skip level' } });
    // A live orchestrator to park, which is what makes this path different.
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'open it' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'orchestrator is live' });

    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'lead brief' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-analyst', { label: 'down to the report' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'straight back to the orchestrator' });

    const stored = storedConversation(convoId);
    assert.ok(stored, 'the conversation was persisted');
    assert.strictEqual(stored.delegationReturned, true,
      'control skipped the lead and reached the base agent, so the record says so');
  });
});
