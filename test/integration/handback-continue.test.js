'use strict';
// CONTINUE, driven end to end against the stub runtime.
//
// The unit tests prove the resolver returns 'continue' and the builder emits a
// prompt without the silent instruction. Neither proves the marker is acted on
// where it is consumed. Review round 1 found exactly that gap: the delegate's
// onResult named the two markers it knew about and rebuilt their precedence by
// hand, so a CONTINUE-only response set no flag, no handoff was seen, and the
// auto-return never fired. The marker existed everywhere except the place that
// reads it, and every unit test stayed green.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

async function startOrchestrator(convoId, keyword) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: keyword }, turn: [{ text: `Ready (${keyword}).` }] },
  ]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: keyword });
  await client.waitForEvent('system', 'done', convoId);
}

describe('a specialist that says the work continues is acted on', () => {
  test('CONTINUE hands back and the orchestrator is asked to carry on', async () => {
    const convoId = h.freshConvoId('continue-acted');
    await startOrchestrator(convoId, 'continue-setup');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'continue task' },
        turn: [{ text: 'Draft written. Passing this back to route onward. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Routing it onward.' }] },
    ]);

    const since = client.messages.length;
    h.clearPrompts();
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'continue task' });

    // The handback itself: control must come back to the orchestrator. Without
    // the marker being recognised, this never happens and the conversation
    // stops with the specialist still holding it.
    const { msg: sw } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'agent_switch'
        && m._conversationId === convoId && m.toAgent === 'chief-of-staff',
      { since, label: 'handback to the orchestrator after CONTINUE' });
    assert.strictEqual(sw.fromAgent, 'content-lead');

    // AND THAT IT WAS ACTUALLY ASKED TO DO SOMETHING. The earlier version of
    // this test stopped at the switch above, which fires on this path whether
    // or not the marker was read: the parent was restored to idle with no
    // directive at all, and the assertion passed on behaviour that was
    // identical to the bug. The test was written to avoid exactly that.
    const started = Date.now();
    let prompt = null;
    while (Date.now() - started < 15000) {
      const ps = h.promptsFor('chief-of-staff').filter(p => /needs more work|outside their scope|what they need next/.test(p));
      if (ps.length) { prompt = ps[ps.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(prompt, 'the restored orchestrator was given a directive, not parked in silence');
    assert.match(prompt, /needs more work/,
      'and it says the work continues, rather than the out-of-scope wording this '
      + 'path used for every marker');
    assert.match(prompt, /Draft written/,
      "with the specialist's own message, since the prompt tells it to read what "
      + 'they said');
    h.reapConvo(convoId);
  });

  test('and it is not silenced, the way a finished pipeline is', async () => {
    const convoId = h.freshConvoId('continue-loud');
    h.writeScenario([
      // An INTERCEPTED delegation kills the orchestrator, so its handback runs
      // through handleScopeReturn. A WS delegation parks it alive and takes the
      // skip-level path instead, which has its own prompts and is not what this
      // change touches.
      { match: { agent: 'chief-of-staff', promptIncludes: 'loud task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'loud lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'loud lead brief' },
        turn: [{ text: 'My part is done. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Carrying on.' }] },
    ]);

    h.clearPrompts();
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'loud task' });

    const started = Date.now();
    let prompt = null;
    while (Date.now() - started < 15000) {
      const ps = h.promptsFor('chief-of-staff').filter(p => /work-continues|pipeline-complete/.test(p));
      if (ps.length) { prompt = ps[ps.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(prompt, 'the orchestrator was given a handback prompt');
    assert.ok(!prompt.includes('MUST be exactly the literal string <silent>'),
      'this is the defect: ordered to say exactly <silent> while holding a '
      + 'handback that asks for the work to be routed onward, it obeyed and the '
      + "user's request died in silence");
    assert.match(prompt, /work-continues/, 'and it is told the work continues');
    assert.match(prompt, /My part is done/, 'with what the specialist actually said');
    h.reapConvo(convoId);
  });

  test('COMPLETE is still silenced, so the fix did not widen', async () => {
    const convoId = h.freshConvoId('continue-complete');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'comp task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'comp lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'comp lead brief' },
        turn: [{ text: 'All finished. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: '<silent>' }] },
    ]);

    h.clearPrompts();
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'comp task' });

    const started = Date.now();
    let prompt = null;
    while (Date.now() - started < 15000) {
      const ps = h.promptsFor('chief-of-staff').filter(p => /work-continues|pipeline-complete/.test(p));
      if (ps.length) { prompt = ps[ps.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(prompt, 'the orchestrator was given a handback prompt');
    assert.match(prompt, /pipeline-complete/, 'a finished pipeline is still a finished pipeline');
    assert.match(prompt, /MUST be exactly the literal string <silent>/,
      'and the orchestrator still stays quiet rather than parroting the output back');
    h.reapConvo(convoId);
  });
});

describe('CONTINUE two levels down', () => {
  // THE TWO BRANCHES THAT HAD NO BEHAVIOURAL TEST. Both need a three-level
  // chain, and both were previously covered only by a regex proving that a
  // marker-shaped identifier appeared somewhere near the branch. That would
  // have passed with the condition inverted, or the wrong output block
  // interpolated, which is the reported defect one level deeper.

  test('a sub-specialist CONTINUE resumes its lead, with what it said', async () => {
    const convoId = h.freshConvoId('continue-deep');
    // Intercepted the whole way down, so each parent is killed and the
    // mid-level lead is the one resumed when the sub-specialist hands back.
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'deep task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'deep lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'deep lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'deep sub brief' } }] },
      { match: { agent: 'content-analyst', promptIncludes: 'deep sub brief' },
        turn: [{ text: 'SUB-SPECIALIST-SAID-THIS, and the numbers need a rewrite. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Picking that up.' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Noted.' }] },
    ]);

    h.clearPrompts();
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'deep task' });

    const started = Date.now();
    let resumed = null;
    while (Date.now() - started < 20000) {
      const ps = h.promptsFor('content-lead');
      if (ps.length >= 2) { resumed = ps[ps.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(resumed, 'the mid-level lead was resumed after its sub-specialist handed back');
    assert.match(resumed, /work-continues/,
      'and told the work continues, not that the specialist was out of scope');
    assert.match(resumed, /SUB-SPECIALIST-SAID-THIS/,
      "carrying the sub-specialist's own message, since the prompt tells it to "
      + 'read what they said');
    assert.ok(!resumed.includes('MUST be exactly the literal string <silent>'),
      'and not silenced, which is the defect this marker exists to prevent, '
      + 'reproduced one level deeper');
    h.reapConvo(convoId);
  });

  test('and the marker itself never appears in what the lead is shown', async () => {
    const convoId = h.freshConvoId('continue-deep-strip');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'strip task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'strip lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'strip lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'strip sub brief' } }] },
      { match: { agent: 'content-analyst', promptIncludes: 'strip sub brief' },
        turn: [{ text: 'All done on my side. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Right.' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Noted.' }] },
    ]);

    h.clearPrompts();
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'strip task' });

    const started = Date.now();
    let resumed = null;
    while (Date.now() - started < 20000) {
      const ps = h.promptsFor('content-lead');
      if (ps.length >= 2) { resumed = ps[ps.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(resumed, 'the lead was resumed');
    assert.ok(!resumed.includes('RUNDOCK:CONTINUE'),
      'a marker left in the handback reaches the next agent as if the specialist '
      + 'had written it to them, and is shown to the person in the preview line');
    assert.match(resumed, /All done on my side/, 'while the words they wrote survive');
    h.reapConvo(convoId);
  });
});
