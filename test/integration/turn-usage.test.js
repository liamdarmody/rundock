'use strict';
// Integration: what each reply used reaches the page, and never the agent.
// Real server.js, real WebSocket, the stub claude and stub codex binaries; no
// real runtime and no network.
//
// A finished turn's result carries how long the turn ran (duration_ms) and
// the tokens its runtime reported, so the page can say "Worked 4 min 05 s"
// under the reply. Those figures are for the person reading: the next turn's
// prompt never carries them, on either runtime. A turn that crashed, failed,
// could not start or found the agent busy sends no result, so no line is drawn
// for it, and the card or notice it sent before is unchanged.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

// Words that would mean a turn's figures were fed back to the agent.
const FIGURE_WORDS = ['Worked', 'Tokens as', 'duration_ms', 'input_tokens', 'inputTokens'];

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.\n\nYou research suppliers.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team() });
  client = await h.connect();
});
after(async () => h.shutdown());

function messagesFor(convoId, since) {
  return client.messages.slice(since).filter(m => m._conversationId === convoId);
}

function assertNoFigures(prompt, label) {
  assert.ok(typeof prompt === 'string' && prompt.length > 0, `${label}: the prompt was sent`);
  for (const word of FIGURE_WORDS) {
    assert.ok(!prompt.includes(word), `${label}: the prompt carries no "${word}"`);
  }
}

describe('a Claude Code turn', () => {
  // Pins what main already does (the server passes Claude Code's result on
  // as it came); its sibling "the chat result carries the time Codex
  // reported and names its runtime" fails on main.
  test('the result reaches the page with the time and tokens Claude Code reported, and the next prompt carries neither', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'lead-designer', promptIncludes: 'usage-first ask' },
        turn: [{ text: 'First answer.' }],
        resultExtra: { duration_ms: 245000, usage: { input_tokens: 18240, cache_read_input_tokens: 2048, output_tokens: 3905 } },
      },
      { match: { agent: 'lead-designer', promptIncludes: 'usage-second ask' }, turn: [{ text: 'Second answer.' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'usage-first ask' });
    const { msg: first } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'first result' });
    assert.strictEqual(first.duration_ms, 245000, 'the time Claude Code reported reaches the page');
    assert.deepStrictEqual(first.usage, { input_tokens: 18240, cache_read_input_tokens: 2048, output_tokens: 3905 },
      'the tokens Claude Code reported reach the page unchanged');
    await client.waitForEvent('system', 'done', convoId);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'usage-second ask' });
    const { msg: second } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'second result' });
    assert.strictEqual(second.result, 'Second answer.');

    const prompts = h.promptsFor('lead-designer');
    assert.strictEqual(prompts.length, 2, 'one prompt per message');
    assertNoFigures(prompts[1], 'second Claude Code turn');
    h.reapConvo(convoId);
  });

  // Pins what main already does (a crash sends no result); its sibling
  // "the chat result carries the time Codex reported and names its runtime"
  // fails on main.
  test('a crashed turn sends no result, so no line is drawn', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'usage-crash ask' }, crash: 1, stderr: 'Something else went wrong\n' },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'usage-crash ask' });
    await client.waitForEvent('system', 'done', convoId, { since, label: 'the crashed turn ends', timeout: 15000 });
    const results = messagesFor(convoId, since).filter(m => m.type === 'result');
    assert.deepStrictEqual(results, [], 'no result for a crashed turn');
    h.reapConvo(convoId);
  });

  test('a stopped turn\'s cancelled message carries the time the server measured from the turn\'s start', async () => {
    const convoId = h.freshConvoId('use');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'usage-stop ask' }, delayMs: 5000, turn: [{ text: 'Too late.' }] },
    ]);
    const since = client.messages.length;
    const sentAt = Date.now();
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'usage-stop ask' });
    await client.waitForEvent('system', 'process_started', convoId, { since });
    client.send({ type: 'cancel', conversationId: convoId });
    const { msg: cancelled } = await client.waitForEvent('system', 'cancelled', convoId, { since });
    const waited = Date.now() - sentAt;
    assert.ok(Number.isSafeInteger(cancelled.duration_ms) && cancelled.duration_ms >= 0,
      `the cancelled message carries a whole number of milliseconds, got ${cancelled.duration_ms}`);
    assert.ok(cancelled.duration_ms <= waited, 'no longer than the turn could have run');
    await client.waitForEvent('system', 'done', convoId, { since });
    h.reapConvo(convoId);
  });
});

describe('a Codex turn', () => {
  test('the chat result carries the time Codex reported and names its runtime, and the next prompt carries neither figure', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'codex-usage first' }, text: 'First from Ida.', usage: { inputTokens: 1840, outputTokens: 390 } },
      { match: { promptIncludes: 'codex-usage second' }, text: 'Second from Ida.' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex-usage first' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const { msg: first } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'first codex result' });
    assert.strictEqual(first.duration_ms, 100, 'the time on the turn Codex completed');
    assert.strictEqual(first._runtime, 'codex');
    assert.deepStrictEqual(first.usage, { inputTokens: 1840, cachedInputTokens: 0, outputTokens: 390, reasoningOutputTokens: 0 },
      'the tokens Codex reported for the turn');
    await client.waitForEvent('system', 'done', convoId);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex-usage second', sessionId: init._sessionId });
    const { msg: second } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'second codex result' });
    assert.strictEqual(second.result, 'Second from Ida.');
    assert.strictEqual(second.duration_ms, 100, 'each turn carries its own time');

    const prompts = h.codexTurnPrompts();
    assert.strictEqual(prompts.length, 2, 'one turn per message');
    assertNoFigures(prompts[1], 'second Codex turn');
    h.reapConvo(convoId);
  });

  test('a delegate\'s result carries the time Codex reported and names its runtime', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'usage-delegate please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'usage-delegate brief' } }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: pipeline-complete]', 'DELEGATE-PAYLOAD'], promptExcludes: 'RUNDOCK:COMPLETE' },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario([
      { match: { promptIncludes: 'usage-delegate brief' }, text: 'DELEGATE-PAYLOAD found. <!-- RUNDOCK:COMPLETE -->' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'usage-delegate please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher', { label: 'codex delegate result' });
    assert.strictEqual(result.duration_ms, 100, 'the time on the turn Codex completed');
    assert.strictEqual(result._runtime, 'codex');

    const handback = () => h.promptsFor('chief-of-staff').find(p => p.includes('[SYSTEM: pipeline-complete]'));
    assert.ok(await h.waitUntil(() => !!handback()), 'the parent is handed the delegate\'s output');
    assertNoFigures(handback(), 'the handback to the parent');
    h.reapConvo(convoId);
  });

  // Pins what main already does (a failed turn sends no result); its sibling
  // "the chat result carries the time Codex reported" fails on main.
  test('a failed turn sends no result, so no line is drawn', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'codex-usage fails' }, error: { message: 'The turn could not finish.', willRetry: false } },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex-usage fails' });
    await client.waitForEvent('system', 'done', convoId, { since, label: 'the failed turn ends' });
    const results = messagesFor(convoId, since).filter(m => m.type === 'result');
    assert.deepStrictEqual(results, [], 'no result for a failed turn');
    h.reapConvo(convoId);
  });

  // Pins what main already does (a turn that finds the agent busy sends its
  // notice and no result); its sibling "the chat result carries the time
  // Codex reported and names its runtime, and the next prompt carries neither
  // figure" fails on main.
  test('a turn that finds the agent busy sends its notice and no result, so no line is drawn', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'codex-usage busy' }, error: { message: 'a turn is already active on thread t_1' } },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex-usage busy' });
    const { msg: done } = await client.waitForEvent('system', 'done', convoId, { since, label: 'the busy turn ends' });
    assert.strictEqual(done.code, 0, 'the turn closes as it did before');
    const seen = messagesFor(convoId, since);
    const notices = seen.filter(m => m.type === 'system' && m.subtype === 'notice').map(m => m.content);
    assert.deepStrictEqual(notices, ['The runtime is still wrapping up the previous turn. Resend your message in a moment.'],
      'the notice is the one sent before');
    assert.deepStrictEqual(seen.filter(m => m.type === 'result'), [], 'no result for a turn that found the agent busy');
    h.reapConvo(convoId);
  });

  // Pins what main already does (a turn that cannot start sends its card and
  // no result); its sibling "the chat result carries the time Codex reported
  // and names its runtime, and the next prompt carries neither figure" fails
  // on main.
  test('a turn that cannot start sends its card and no result, so no line is drawn', async () => {
    const convoId = h.freshConvoId('use');
    h.clearInvocations();
    // More refusals than the client retries, so the thread never starts.
    h.writeCodexScenario([], { overload: { method: 'thread/start', times: 10 } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex-usage no start' });
    const { msg: done } = await client.waitForEvent('system', 'done', convoId, { since, label: 'the unstarted turn ends', timeout: 15000 });
    assert.strictEqual(done.code, -1, 'the turn closes as it did before');
    const seen = messagesFor(convoId, since);
    assert.strictEqual(seen.filter(m => m.type === 'system' && m.subtype === 'codex_error').length, 1, 'the card is sent once, as before');
    assert.deepStrictEqual(seen.filter(m => m.type === 'result'), [], 'no result for a turn that never started');
    h.writeCodexScenario([]);
    h.reapConvo(convoId);
  });
});
