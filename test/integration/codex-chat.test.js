'use strict';
// Integration: conversations with agents that run on the Codex runtime.
// Real server.js, real WebSocket, real child processes against the stub
// codex binary; no real Codex CLI and no network.
//
// The contract under test: a `runtime: codex` agent behaves like any other
// agent in the conversation UI (process_started, session id, result, done,
// transcript), while the server spawns one sandboxed `codex exec --json`
// process per turn and resumes the thread on follow-ups.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const fx = require('../fixtures/codex-jsonl.js');

let client;

function teamWithCodexAgents() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.\n\nYou research suppliers.',
    }),
    'summariser': agentFile({
      name: 'summariser', displayName: 'Sam', role: 'Summariser',
      description: 'Summarises documents', type: 'specialist', order: 6,
      reportsTo: 'chief-of-staff', runtime: 'codex', model: 'gpt-5.3-codex',
      body: 'You are Sam, the summariser.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: teamWithCodexAgents() });
  client = await h.connect();
});
after(async () => h.shutdown());

function transcript(convoId) {
  return JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
}

describe('codex agent conversation', () => {
  test('first turn: sandboxed exec spawn, session id surfaced, result and done delivered, transcript persisted', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'first codex question' }, text: 'Answer from Ida.', usage: { input: 1200, cached: 800, output: 340 } },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'first codex question' });

    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId);
    assert.strictEqual(started._agent, 'researcher');

    // Thread id rides the same rails as Claude session ids
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    assert.ok(init._sessionId && init._sessionId.startsWith('cthr_'), `thread id surfaced (got ${init._sessionId})`);

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'codex result' });
    assert.strictEqual(result.result, 'Answer from Ida.');
    assert.strictEqual(result.is_error, false);
    assert.strictEqual(result._agent, 'researcher');
    // Usage is recorded as normalised token counts (subscription usage; no dollar costs)
    assert.deepStrictEqual(result.usage, { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340 });

    await client.waitForEvent('system', 'done', convoId);

    // Spawn contract: sandboxed, no bypass flags, no model unless set, prompt on stdin
    const inv = h.readInvocations();
    assert.strictEqual(inv.length, 1, 'exactly one codex spawn');
    assert.strictEqual(inv[0].bin, 'codex');
    assert.deepStrictEqual(inv[0].argv, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
    assert.strictEqual(inv[0].env.RUNDOCK, '1');
    assert.strictEqual(inv[0].env.RUNDOCK_CONVO_ID, convoId);
    // First turn carries the agent's identity followed by the user message
    assert.ok(inv[0].prompt.includes('You are Ida'), 'system prompt prepended on first turn');
    assert.ok(inv[0].prompt.includes('first codex question'), 'user content present');

    // Transcript persisted both sides
    const t = transcript(convoId);
    assert.deepStrictEqual(t.map(e => [e.role, e.agent]), [['user', 'user'], ['agent', 'researcher']]);
    assert.ok(t[1].text.includes('Answer from Ida.'));
  });

  test('follow-up turn resumes the thread without re-sending instructions', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'question one' }, threadId: 'cthr_resume_me', text: 'First.' },
      { match: { promptIncludes: 'question two' }, text: 'Second.' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'question one' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    assert.strictEqual(init._sessionId, 'cthr_resume_me');
    await client.waitForEvent('system', 'done', convoId);

    // The client sends the stored session id back on the next turn
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'question two', sessionId: 'cthr_resume_me' });
    const { msg: result2 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'resumed result' });
    assert.strictEqual(result2.result, 'Second.');

    const inv = h.readInvocations();
    assert.strictEqual(inv.length, 2, 'one spawn per turn');
    assert.deepStrictEqual(inv[1].argv, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', 'resume', 'cthr_resume_me', '-']);
    // Resumed turns send only the new message: instructions are not re-injected
    assert.ok(!inv[1].prompt.includes('You are Ida'), 'no instruction re-injection on resume');
    assert.ok(inv[1].prompt.includes('question two'));
  });

  test('agent with an explicit model passes the model flag', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'summarise this' }, text: 'Summary.' }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'summariser', content: 'summarise this' });
    await client.waitForEvent('system', 'done', convoId);

    const inv = h.readInvocations();
    assert.deepStrictEqual(inv[0].argv, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--model', 'gpt-5.3-codex', '-']);
  });

  test('unknown and malformed output lines are skipped without breaking the turn', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'noisy' }, text: 'Still fine.', noise: true }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'noisy output please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'noisy result' });
    assert.strictEqual(result.result, 'Still fine.');
    await client.waitForEvent('system', 'done', convoId);
  });

  test('quota exhaustion surfaces as a structured quota message, not a raw error', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'over quota' }, failMessage: fx.QUOTA_MESSAGE }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'over quota question' });

    const { msg: quota } = await client.waitForEvent('system', 'codex_quota', convoId);
    assert.strictEqual(quota._agent, 'researcher');
    // Verbatim CLI text travels with the structured message for the UI card
    assert.strictEqual(quota.detail, fx.QUOTA_MESSAGE);

    await client.waitForEvent('system', 'done', convoId);
    // No raw error message alongside the structured one
    const raw = client.messages.filter(m => m.type === 'error' && m._conversationId === convoId);
    assert.deepStrictEqual(raw, []);
  });

  test('a classified runtime failure surfaces as a friendly pill with the verbatim detail', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'blocked write' }, failMessage: 'sandbox denied write to /etc/hosts' }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'blocked write please' });

    const { msg: err } = await client.waitForEvent('system', 'codex_error', convoId);
    assert.strictEqual(err._agent, 'researcher');
    assert.strictEqual(err.detail, 'sandbox denied write to /etc/hosts');

    await client.waitForEvent('system', 'done', convoId);
  });

  test('an abnormal exit with no events still completes the turn with a friendly error', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'crash now' }, crash: 1 }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'crash now please' });

    const { msg: err } = await client.waitForEvent('system', 'codex_error', convoId);
    assert.strictEqual(err._agent, 'researcher');
    await client.waitForEvent('system', 'done', convoId);
  });

  test('a new user message while a codex turn is running supersedes it (old process killed, thread resumed)', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'slow question' }, threadId: 'cthr_slow', text: 'Too late.', delayMs: 4000 },
      { match: { promptIncludes: 'impatient follow-up' }, text: 'Quick answer.' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'slow question' });
    await client.waitForEvent('system', 'init', convoId);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'impatient follow-up', sessionId: 'cthr_slow' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'superseding result' });
    assert.strictEqual(result.result, 'Quick answer.');

    const inv = h.readInvocations();
    assert.strictEqual(inv.length, 2, 'two spawns: superseded + superseding');
    assert.deepStrictEqual(inv[1].argv.slice(-3), ['resume', 'cthr_slow', '-']);
  });
});
