'use strict';
// A HANDOFF LINE THAT NAMES A TEAMMATE IS A HANDOFF TO THEM, driven end to end.
//
// The reported shape, measured from a real conversation before this was
// written: a lead made an Agent call with no subagent_type, a description
// reading "Handing to Sage to fact-check the Rundock.ai research", and a long
// prompt that never said "Sage" or "fact-checker". The matcher scanned the
// prompt alone, matched nothing, and no delegation happened. The lead handed
// back, the orchestrator picked up, tried the fact-checker directly and was
// correctly blocked because that agent is not its report.
//
// This release caused it: making `description` the sentence the person reads
// taught agents to name the target there, the one field the scan did not read.
//
// Driven here rather than in the engine harness because the effect of a
// delegation is a delegate being started and a switch being sent, and that
// needs a runtime to start.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const h = require(path.join(ROOT, 'test', 'helpers', 'harness.js'));

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(async () => { await h.shutdown(); });

describe('a lead hands to its own report by naming them in the handoff line', () => {
  test('the delegation happens, and the line travels with it', async () => {
    // Penn leads Ana. Penn names Ana only in the description, exactly as the
    // reported call did, and the prompt is a brief that never says her name.
    const convoId = h.freshConvoId('target');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'target please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to Penn.', prompt: 'the brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'the brief' },
        turn: [{ agentTool: {
          description: 'Handing to Ana to check the numbers before this goes back.',
          prompt: 'Verify each figure against the source and say which hold up. '
            + 'This needs doing before the work goes any further.',
        } }] },
      { match: { agent: 'content-analyst' }, turn: [{ text: 'ANA-CHECKED-IT' }] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Target' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'target please' });

    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
      && m.result === 'ANA-CHECKED-IT',
    { since, label: 'the report picked the work up', timeout: 20000 });

    const switches = client.messages.slice(since).filter(m => m.type === 'system'
      && m.subtype === 'agent_switch' && m._conversationId === convoId);
    const toAna = switches.find(m => m.fromAgent === 'content-lead' && m.toAgent === 'content-analyst');
    assert.ok(toAna,
      'the lead handed to her own report, named only in the sentence the person reads: '
      + JSON.stringify(switches.map(m => `${m.fromAgent}->${m.toAgent}`)));
    assert.strictEqual(toAna.handoffLine, 'Handing to Ana to check the numbers before this goes back.',
      'and her line travels with it, because this is the handover she described');

    h.reapConvo(convoId);
  });

  test('a lead naming nobody on its roster delegates to nobody, and says so', async () => {
    // The other side of the same rule. Nothing matched, so nothing is
    // delegated, and the engine no longer lets that pass without a word.
    const convoId = h.freshConvoId('target-miss');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'miss please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to Penn.', prompt: 'the brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'the brief' },
        turn: [
          { agentTool: { description: 'Looking into the pricing page.', prompt: 'have a look at this' } },
          { text: 'PENN-CARRIED-ON' },
        ] },
    ]);

    client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Target miss' } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'miss please' });

    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead',
    { since, label: 'the lead took the work' });

    // Give the lead's turn time to end without a second delegation.
    await h.waitUntil(() => client.messages.slice(since).some(m => m.type === 'result'
      && m._conversationId === convoId), 'the lead finished its turn', { timeout: 20000 });

    const onwards = client.messages.slice(since).filter(m => m.type === 'system'
      && m.subtype === 'agent_switch' && m.fromAgent === 'content-lead');
    assert.deepStrictEqual(onwards.map(m => m.toAgent), [],
      'naming nobody on the roster delegates to nobody, which is correct; what was wrong was doing it silently');

    h.reapConvo(convoId);
  });
});
