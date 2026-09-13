'use strict';
// THE HANDOFF LINE, WHERE A PERSON WOULD SEE IT.
//
// A lead is meant to say who it is handing to and why. Asked for as prose
// alongside the tool call, that is a second optional act, and models drop it
// under load: measured as a coin flip across three hand tests of the same
// scenario, with a contract that already said the line "is not optional".
//
// It now travels in the Agent tool's `description` field, which is part of the
// call the agent is already making. These tests assert on the conversation the
// user would read, not on the contract text, because the contract has been
// right and ignored before.
//
// NOT ENFORCEMENT. Nothing here refuses a delegation whose description is a
// three-word label or absent entirely; that is the delegation object's job.
// This turns silence into a sentence.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const h = require(path.join(ROOT, 'test', 'helpers', 'harness.js'));

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => { await h.shutdown(); });

function transcriptFor(convoId) {
  return h.internal.loadTranscript(convoId) || [];
}

describe('a lead that says nothing still has its handoff shown', () => {
  test('the description becomes the delegating agent\'s visible turn', async () => {
    const convoId = h.freshConvoId('handoff-line');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'research the suppliers' },
        turn: [{ agentTool: {
          subagent_type: 'content-lead',
          description: 'Handing to Penn to draft the supplier brief before it goes out.',
          prompt: 'PRIVATE-BRIEF: twelve claims to check, none of which the user should see here',
        } }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'On it.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Handoff line' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'research the suppliers' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'delegated' });
    await h.waitUntil(() => transcriptFor(convoId).some(t => t.agent === 'chief-of-staff' && t.type !== 'routing'),
      'the delegating turn was recorded as visible');

    const turn = transcriptFor(convoId).find(t => t.agent === 'chief-of-staff' && t.type !== 'routing');
    assert.ok(turn, 'the delegating agent has a visible turn rather than an invisible routing entry');
    assert.match(turn.text, /Handing to Penn to draft the supplier brief/,
      'and it carries the line the agent wrote, word for word');
    // THE BRIEF STAYS PRIVATE. The whole reason the line is a separate field is
    // that the brief must not reach the conversation.
    assert.doesNotMatch(turn.text, /PRIVATE-BRIEF/,
      'while the brief it sent is not shown to the user');
    h.reapConvo(convoId);
  });

  test('an agent that speaks for itself is never overwritten', async () => {
    // A floor, not a replacement: the agent's own words win whenever it has
    // any. Without this the change would silently replace richer prose with a
    // one-line summary of the same handoff.
    const convoId = h.freshConvoId('handoff-line-prose');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'second task' },
        turn: [
          { text: 'PROSE-THE-AGENT-WROTE: this needs Penn, here is why.' },
          { agentTool: {
            subagent_type: 'content-lead',
            description: 'FIELD-LINE-THAT-MUST-NOT-WIN',
            prompt: 'another brief',
          } },
        ] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Understood.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Handoff prose' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'second task' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'delegated' });
    await h.waitUntil(() => transcriptFor(convoId).some(t => t.agent === 'chief-of-staff' && t.type !== 'routing'),
      'the delegating turn was recorded');

    const turn = transcriptFor(convoId).find(t => t.agent === 'chief-of-staff' && t.type !== 'routing');
    assert.match(turn.text, /PROSE-THE-AGENT-WROTE/, 'the agent\'s own words are what the user reads');
    assert.doesNotMatch(turn.text, /FIELD-LINE-THAT-MUST-NOT-WIN/,
      'and the field is not appended on top of them');
    h.reapConvo(convoId);
  });

  test('a delegation with neither prose nor a line still delegates', async () => {
    // The failure direction that matters: this is a floor under the
    // conversation, never a gate on the work. An agent that supplies nothing
    // is no worse off than it is today.
    const convoId = h.freshConvoId('handoff-line-neither');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'third task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'brief with no description' } }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Working.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Handoff neither' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'third task' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'still delegated' });
    h.reapConvo(convoId);
  });
});
