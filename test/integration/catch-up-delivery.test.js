'use strict';
// WHAT AN AGENT ACTUALLY RECEIVES, driven rather than read.
//
// The unit tests prove the pure functions compute the right text, and the
// engine tests pinned the call sites by regex. Neither proves the value is
// threaded correctly at runtime: a fault that leaves the matched substrings
// intact (loadTranscript returning a shape deltaSince cannot use, a throw
// inside the call, a reference bug) would pass every one of them while the
// feature stays broken. Review round 4 called that out for the two paths the
// evidence describes as the more damaging ones, and it was right: the same
// weakness had already been removed from the delegate path and then
// reintroduced here.
//
// These drive the real handleScopeReturn against the stub runtime and read
// back the literal prompt the agent was sent. The stub spends no tokens.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

/** Seed a conversation the orchestrator has already spoken in, then left. */
function seedTranscript(convoId, entries) {
  h.internal.convoTranscripts.set(convoId, entries);
  h.internal.saveTranscript(convoId);
}

describe('the orchestrator is told what happened while it was away', () => {
  test('a resumed orchestrator receives the turns it missed', async () => {
    const convoId = h.freshConvoId('catchup-orch');
    // Cos delegated, two specialists worked, and Penn is handing back.
    seedTranscript(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-INTERVENING-TURN: the numbers check out' },
      { role: 'agent', agent: 'content-lead', text: 'PENN-HANDBACK: the post is written' }
    ]);
    // The orchestrator has a session on record, so it is resumed rather than
    // cold-spawned. That gating is the whole point: told "since your last
    // turn" while cold, it hears about a turn it cannot remember.
    h.internal.writeConversations([{
      id: convoId, title: 'catch-up', messages: [],
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'sess-cos-1' }]
    }]);

    const entry = {
      agentId: 'content-lead', processId: 'p-catchup', lastUserMessage: 'write me a short blog post',
      toolCalls: [], finalResponseText: 'PENN-HANDBACK: the post is written'
    };
    h.internal.chatProcesses.set(convoId, entry);
    h.clearPrompts();
    h.internal.handleScopeReturn(entry, convoId, 'return');

    const prompt = await waitForPrompt('chief-of-staff');
    assert.match(prompt, /ANALYST-INTERVENING-TURN/,
      "the other agent's work reaches the orchestrator, which is the whole defect: "
      + 'it came back knowing only what the last specialist said');
    assert.match(prompt, /SINCE YOUR LAST TURN IN THIS CONVERSATION/,
      'and it is labelled as catch-up rather than presented as new');
    h.reapConvo(convoId);
  });

  test('and is not handed the same handback twice', async () => {
    const convoId = h.freshConvoId('catchup-dup');
    seedTranscript(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-TURN: checked' },
      { role: 'agent', agent: 'content-lead', text: 'UNIQUE-HANDBACK-MARKER-42' }
    ]);
    h.internal.writeConversations([{
      id: convoId, title: 'dup', messages: [],
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'sess-cos-2' }]
    }]);
    const entry = {
      agentId: 'content-lead', processId: 'p-dup', lastUserMessage: 'write me a short blog post',
      toolCalls: [], finalResponseText: 'UNIQUE-HANDBACK-MARKER-42'
    };
    h.internal.chatProcesses.set(convoId, entry);
    h.clearPrompts();
    h.internal.handleScopeReturn(entry, convoId, 'return');

    const prompt = await waitForPrompt('chief-of-staff');
    const hits = prompt.split('UNIQUE-HANDBACK-MARKER-42').length - 1;
    assert.strictEqual(hits, 1,
      `the handback appeared ${hits} times; the output block already carries it, `
      + 'so the delta must exclude the specialist handing back');
    h.reapConvo(convoId);
  });

  test('a cold orchestrator is told nothing about turns it cannot remember', async () => {
    const convoId = h.freshConvoId('catchup-cold');
    seedTranscript(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-TURN: checked' },
      { role: 'agent', agent: 'content-lead', text: 'done' }
    ]);
    // No sessionIds: nothing to resume, so it is cold-spawned as before.
    h.internal.writeConversations([{ id: convoId, title: 'cold', messages: [], sessionIds: [] }]);
    const entry = {
      agentId: 'content-lead', processId: 'p-cold', lastUserMessage: 'write me a short blog post',
      toolCalls: [], finalResponseText: 'done'
    };
    h.internal.chatProcesses.set(convoId, entry);
    h.clearPrompts();
    h.internal.handleScopeReturn(entry, convoId, 'return');

    const prompt = await waitForPrompt('chief-of-staff');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'),
      'a cold spawn has no "last turn" to be since, and claiming one is worse '
      + 'than the old behaviour, which claimed nothing');
    h.reapConvo(convoId);
  });
});

/** The stub records every prompt; wait for the one this agent was sent. */
async function waitForPrompt(agentId, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const prompts = h.promptsFor(agentId);
    if (prompts.length) return prompts[prompts.length - 1];
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no prompt reached ${agentId} within ${timeoutMs}ms`);
}

describe('a resumed delegate is told what it missed', () => {
  // THE ORIGINAL DEFECT, driven at last. This is the path that produced the
  // report: a specialist came back to her own draft after two other agents had
  // worked, and rebuilt it from scratch because nothing told her any of it had
  // happened. Until now it was covered by calling the pure builder with a
  // hand-made object, plus a regex proving two identifiers sit near each other
  // in engine.js. Neither proves handleDelegation computes the delta from a
  // real transcript and threads it into the bytes the delegate receives.

  test('the delegate prompt carries the other agents, not its own prior turn', async () => {
    const convoId = h.freshConvoId('catchup-delegate');
    seedTranscript(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-lead', text: 'PENN-OWN-FIRST-DRAFT: here is the draft' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-INTERVENING: the numbers check out' }
    ]);
    // Penn has a session on record, so she is resumed rather than cold-spawned.
    h.internal.writeConversations([{
      id: convoId, title: 'delegate catch-up', messages: [],
      sessionIds: [{ agentId: 'content-lead', sessionId: 'sess-penn-1' }]
    }]);
    // A live parent to delegate from, as the non-intercepted path requires.
    h.internal.chatProcesses.set(convoId, {
      agentId: 'chief-of-staff', processId: 'p-parent', exited: false, toolCalls: []
    });
    h.clearPrompts();
    h.internal.handleDelegation({
      conversationId: convoId, targetAgent: 'content-lead',
      context: 'now tighten the opening', _intercepted: true
    }, h.internal.chatProcesses);

    const prompt = await waitForPrompt('content-lead');
    assert.match(prompt, /ANALYST-INTERVENING/,
      'what the other agent did while she was away, which is the whole point');
    assert.ok(!prompt.includes('PENN-OWN-FIRST-DRAFT'),
      'her own earlier turn is already in her session; re-sending it is pure '
      + 'cost and invites her to redo work she has already done');
    assert.match(prompt, /now tighten the opening/, 'and the brief still arrives');
    h.reapConvo(convoId);
  });

  test('a first-time delegate is not told it missed anything', async () => {
    const convoId = h.freshConvoId('catchup-firsttime');
    seedTranscript(convoId, [
      { role: 'user', text: 'write me a short blog post' },
      { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Penn.' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-TURN: checked' }
    ]);
    // No session for Penn: she has never spoken here, so she has missed
    // nothing, and the cold-spawn path gives her the history instead.
    h.internal.writeConversations([{ id: convoId, title: 'first', messages: [], sessionIds: [] }]);
    h.internal.chatProcesses.set(convoId, {
      agentId: 'chief-of-staff', processId: 'p-parent2', exited: false, toolCalls: []
    });
    h.clearPrompts();
    h.internal.handleDelegation({
      conversationId: convoId, targetAgent: 'content-lead',
      context: 'draft it', _intercepted: true
    }, h.internal.chatProcesses);

    const prompt = await waitForPrompt('content-lead');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'),
      'told it missed turns it was never present for, a first-time delegate is '
      + 'being lied to about its own history');
    h.reapConvo(convoId);
  });
});

describe('a resumed mid-level parent is told too', () => {
  // THE THIRD RESUME PATH, driven. A specialist that has its own direct
  // reports is resumed when its sub-delegate hands back, and it was given the
  // sub-delegate's output and nothing else. This is the shape from the report:
  // the orchestrator delegates to a research lead, she delegates to a fact
  // checker, he returns, and she comes back knowing nothing about the rest of
  // the conversation.
  //
  // Driven rather than matched: a regex proving parentCatchUp appears beside a
  // write would pass even if the value were computed for the wrong agent or
  // thrown away at runtime.

  test("the parent's resumed prompt carries what happened while it waited", async () => {
    const convoId = h.freshConvoId('catchup-midlevel');
    // THE CHAIN MUST BE INTERCEPTED ALL THE WAY DOWN. A WS delegation parks
    // the orchestrator alive, and a sub-delegate's handback then skips the
    // mid-level parent and restores the orchestrator directly. Only an
    // intercepted Agent call kills the parent, which is what makes the
    // mid-level resume happen at all. That is the shape in the real log:
    //   cos --(Agent tool, cos killed)--> lead --(Agent tool, lead killed)--> analyst
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'midlevel task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'midlevel lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'midlevel lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'midlevel sub brief' } }] },
      { match: { agent: 'content-analyst', promptIncludes: 'midlevel sub brief' },
        turn: [{ text: 'ANALYST-SAID-THIS. Outside my scope. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Picking it back up.' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Noted.' }] },
    ]);

    h.clearPrompts();
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'midlevel task' });

    const started = Date.now();
    let second = null;
    while (Date.now() - started < 20000) {
      const prompts = h.promptsFor('content-lead');
      if (prompts.length >= 2) { second = prompts[prompts.length - 1]; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(second, 'the mid-level parent was resumed and given a prompt');
    assert.match(second, /ANALYST-SAID-THIS/,
      "the returning sub-delegate's output reaches the parent");
    // WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the mid-level resume
    // path runs, that the parent is driven a second time, and that the prompt
    // assembled with parentCatchUp reaches it: a runtime fault in that
    // assembly fails here rather than passing a regex.
    //
    // It does not drive a NON-EMPTY mid-level delta. In a three-deep chain the
    // only agent speaking between the parent's own last turn and its resume is
    // the returning sub-delegate, which is deliberately excluded because the
    // output block already carries it. So the delta is legitimately empty
    // here, and it was empty in the reported conversation for the same reason.
    // Producing a non-empty one needs a fourth agent speaking in between, and
    // the roster rules block the constructions that would arrange it.
    //
    // The delta's content for this path is covered by the deltaSince unit
    // tests and by the pinned call site. Stated rather than papered over: an
    // assertion contrived to look stronger than the evidence is the thing this
    // whole change set out to remove.
    assert.ok(!second.includes('SINCE YOUR LAST TURN'),
      'with only the returning delegate to report, the catch-up is correctly '
      + 'absent rather than an empty heading');
    h.reapConvo(convoId);
  });
});
