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

// The events the signal layer appended, read from the running workspace the
// same way a person investigating afterwards would reach them.
function readEvents() {
  const fs = require('node:fs');
  const dir = path.join(h.workspaceDir, '.rundock', 'state');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* a partial final line is not a failure */ }
    }
  }
  return out;
}

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

    // And the saying, read off disk where a person would find it afterwards.
    // Asserting only the absence above would pass on the defect this card
    // exists to fix, which was precisely a miss that happened in silence.
    // recordEvent appends asynchronously, so this waits for the write rather
    // than racing it. A read that happened to be early would fail for a reason
    // that has nothing to do with the behaviour under test.
    await h.waitUntil(() => readEvents().some(e => e.e === 'delegation_error'
      && e.conv === convoId && (e.d || {}).reason === 'no_target_matched'),
    'the miss reached the record, not only the switches', { timeout: 10000 });

    const records = readEvents().filter(e => e.e === 'delegation_error' && e.conv === convoId);
    const miss = records.find(e => (e.d || {}).reason === 'no_target_matched');
    assert.ok(miss);
    assert.strictEqual(miss.agent, 'content-lead', 'naming who believed it had handed the work on');
    assert.deepStrictEqual(miss.d, {
      reason: 'no_target_matched',
      asked: 'Looking into the pricing page.',
    }, 'and what it asked for, so a person can tell which handover never happened');

    h.reapConvo(convoId);
  });
});
