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
