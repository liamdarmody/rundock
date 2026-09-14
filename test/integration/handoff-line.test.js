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

    // ON THE WIRE, not only in the file. The transcript being right is what
    // this feature looked like when it was broken: the line was recorded and
    // sent to nobody, so it appeared only after a reload. The switch is the
    // one thing that carries it to a client while the handoff happens.
    const sw = client.messages.find(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead');
    assert.ok(sw, 'the delegation announced itself to the client');
    assert.strictEqual(sw.handoffLine, 'Handing to Penn to draft the supplier brief before it goes out.',
      'and carried the line, because nothing else will: this branch suppresses the envelope and kills the process');
    assert.ok(!JSON.stringify(sw).includes('PRIVATE-BRIEF'),
      'while the brief stays off the wire the person can see');

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

  test('whitespace in either place is not content, and the turn is still recorded', async () => {
    // TWO NEAR-MISSES IN ONE. A stray newline before the tool_use block makes
    // responseText a non-empty string carrying nothing; an empty or blank
    // description is a field that exists and says nothing. Either, treated as
    // content, renders a blank turn, which is worse than the routing entry it
    // would replace. Both must fall through to the existing behaviour.
    const convoId = h.freshConvoId('handoff-blank');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'fourth task' },
        turn: [
          { text: '\n  ' },
          { agentTool: { subagent_type: 'content-lead', description: '   ', prompt: 'a brief' } },
        ] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Working.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Handoff blank' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'fourth task' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'still delegated' });
    await h.waitUntil(() => transcriptFor(convoId).some(t => t.agent === 'chief-of-staff'),
      'the delegating turn was recorded');

    const turn = transcriptFor(convoId).find(t => t.agent === 'chief-of-staff');
    assert.strictEqual(turn.type, 'routing',
      'neither blank counts as content, so the turn stays the invisible routing entry it was before');
    h.reapConvo(convoId);
  });
});

describe('an agent with nobody reporting to it is untouched by any of this', () => {
  // THE CRITERIA CLAIM THIS, AND CODE-PATH INSPECTION IS NOT EVIDENCE FOR IT.
  //
  // findDirectReportMatch returns null when an agent has no direct reports, so
  // the interception in wireProcessHandlers never sets a target and the whole
  // handoff-line branch is unreachable. That is a true statement about the
  // source and it is exactly the kind of statement that stops being true when
  // somebody moves the guard. Des reports to the orchestrator and nobody
  // reports to Des, so Des is the agent the claim is about; these drive Des
  // through the real runtime rather than reading prompt.js and agreeing with it.
  test('its ordinary turn is recorded exactly as it was before', async () => {
    const convoId = h.freshConvoId('no-reports-plain');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'make the cover' },
        turn: [{ text: 'Cover drafted, three variants attached.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'lead-designer', title: 'No reports plain' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'make the cover' });
    await h.waitUntil(() => transcriptFor(convoId).some(t => t.agent === 'lead-designer'),
      'the specialist turn was recorded');

    const turns = transcriptFor(convoId).filter(t => t.agent === 'lead-designer');
    assert.strictEqual(turns.length, 1, 'one turn, not a turn plus a handoff line');
    assert.strictEqual(turns[0].type, undefined,
      'a visible turn, typed exactly as a specialist turn has always been');
    assert.match(turns[0].text, /Cover drafted, three variants attached\./,
      'carrying its own words and nothing added to them');
    h.reapConvo(convoId);
  });

  test('even an Agent tool call from it changes nothing, because there is nobody to hand to', async () => {
    // The interception path itself, driven for an agent with no direct
    // reports. A description here must not become a visible handoff line,
    // because there is no delegation for it to describe: the guard that makes
    // that true is the thing under test.
    const convoId = h.freshConvoId('no-reports-tool');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'second cover' },
        turn: [
          { text: 'Looking at it now.' },
          { agentTool: {
            subagent_type: 'content-lead',
            description: 'THIS-MUST-NOT-BECOME-A-HANDOFF-LINE',
            prompt: 'a brief nobody asked for',
          } },
        ] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'lead-designer', title: 'No reports tool' } });
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'second cover' });
    await h.waitUntil(() => transcriptFor(convoId).some(t => t.agent === 'lead-designer'),
      'the specialist turn was recorded');

    const turns = transcriptFor(convoId).filter(t => t.agent === 'lead-designer');
    for (const t of turns) {
      assert.doesNotMatch(t.text || '', /THIS-MUST-NOT-BECOME-A-HANDOFF-LINE/,
        'the description field of an agent that cannot delegate must never reach the conversation');
    }
    assert.match(turns.map(t => t.text || '').join('\n'), /Looking at it now\./,
      'while its own words are recorded exactly as they always were');
    // And nothing was handed anywhere.
    assert.deepStrictEqual(transcriptFor(convoId).filter(t => t.agent === 'content-lead'), [],
      'no delegation happened, so no other agent has a turn in this conversation');
    h.reapConvo(convoId);
  });
});

describe('a delegation blocked as off-roster does not draw the turn twice', () => {
  // THE SECOND SUPPRESSING BRANCH, driven end to end. Ana reports to Penn, not
  // to Cos, so Cos naming her is blocked: that branch kills the process and
  // continues, so no result arrives for the turn.
  //
  // WHAT THIS CAN AND CANNOT REACH. The runtime streams assistant text as
  // deltas, and the stub does the same, so the agent's words are already on
  // screen by the time the block fires and the server correctly sends nothing
  // more. That is the case this asserts, and it is the one that matters in
  // practice: it is the duplicate-turn guard.
  //
  // The case the fix exists for, text arriving with no deltas at all, cannot be
  // produced through this stub: every text block it emits comes as deltas. It
  // is covered where it can be, on the reducer and the document, in
  // test/unit/live-handoff-render.test.js. Saying so here is better than a test
  // that looks like it covers it and does not.
  test('words the agent already streamed are not sent again', async () => {
    const convoId = h.freshConvoId('off-roster');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'off roster please' },
        turn: [
          { text: 'Ana is the right person for this, let me pull her in.' },
          { agentTool: { subagent_type: 'content-analyst', description: 'Over to Ana.', prompt: 'brief' } },
        ] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'delegation-blocked' },
        turn: [{ text: 'Understood, I will route through Penn instead.' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Off roster' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'off roster please' });

    await client.waitFor(m => m.type === 'system' && m.subtype === 'info'
      && m._conversationId === convoId && /Blocked a handoff/.test(m.content || ''),
    { since, label: 'the block was announced' });

    const turns = client.messages.slice(since).filter(m => m.type === 'system'
      && m.subtype === 'agent_turn' && m._conversationId === convoId);
    assert.deepStrictEqual(turns, [],
      'the words streamed, so they are already drawn; sending them again would show the turn twice');

    // And the words did reach the client, by the route that was always there.
    // Reassembled from the deltas, because that is how it arrives: no single
    // message holds the sentence, which is the whole reason it is already drawn.
    const streamed = client.messages.slice(since)
      .filter(m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta')
      .map(m => m.event.delta.text).join('');
    assert.match(streamed, /Ana is the right person for this/,
      'sanity: the turn reached the client by streaming, or this proves nothing');
    h.reapConvo(convoId);
  });
});
