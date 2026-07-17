'use strict';
// Integration: conversations with agents that run on the Codex runtime.
// Real server.js, real WebSocket, one real long-lived child process (the
// stub codex binary in app-server mode); no real Codex CLI and no network.
//
// The contract under test: a `runtime: codex` agent behaves like any other
// agent in the conversation UI (process_started, session id, live streaming,
// result, done, transcript), while the server multiplexes every Codex
// conversation as a thread over ONE shared `codex app-server` process and
// resumes threads on follow-ups.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { QUOTA_MESSAGE } = require('../fixtures/codex-appserver-protocol.js');

let client;

// App-server thread ids are UUIDv7.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function appServerSpawns() {
  return h.readInvocations().filter(i => i.mode === 'app-server' && i.event === 'spawn');
}

function methodEntries(method) {
  return h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);
}

describe('codex agent conversation', () => {
  test('first turn: one shared app-server spawn, thread id surfaced, deltas stream BEFORE the result, done delivered, transcript persisted', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      {
        match: { promptIncludes: 'first codex question' },
        deltas: ['Answer ', 'from ', 'Ida.'],
        text: 'Answer from Ida.',
        usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340 },
      },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'first codex question' });

    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId);
    assert.strictEqual(started._agent, 'researcher');

    // Thread id rides the same rails as Claude session ids
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    assert.match(init._sessionId, UUID_RE, `thread id surfaced (got ${init._sessionId})`);

    const { msg: result, index: resultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'codex result' });
    assert.strictEqual(result.result, 'Answer from Ida.');
    assert.strictEqual(result.is_error, false);
    assert.strictEqual(result._agent, 'researcher');
    // Usage is recorded as normalised token counts (subscription usage; no dollar costs)
    assert.deepStrictEqual(result.usage, { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340, reasoningOutputTokens: 0 });

    // Replies stream LIVE: text deltas arrive as Claude-shaped stream events
    // before the result (the A1 checkpoint's automated twin).
    const streamed = client.messages.slice(since, resultIdx)
      .filter(m => m.type === 'stream_event' && m._conversationId === convoId)
      .map(m => m.event && m.event.delta && m.event.delta.text);
    assert.deepStrictEqual(streamed, ['Answer ', 'from ', 'Ida.'], 'deltas streamed before the result');

    await client.waitForEvent('system', 'done', convoId);

    // Spawn contract: ONE shared app-server process, bare subcommand argv,
    // sandboxed on-request thread with approvals routed to the user.
    const spawns = appServerSpawns();
    assert.strictEqual(spawns.length, 1, 'exactly one app-server spawn');
    assert.deepStrictEqual(spawns[0].argv, ['app-server']);
    const starts = methodEntries('thread/start');
    assert.strictEqual(starts.length, 1, 'one thread for the conversation');
    assert.strictEqual(starts[0].params.cwd, h.workspaceDir);
    assert.strictEqual(starts[0].params.sandbox, 'workspace-write');
    assert.strictEqual(starts[0].params.approvalPolicy, 'on-request');
    assert.strictEqual(starts[0].params.approvalsReviewer, 'user');
    // First turn carries the agent's identity followed by the user message
    const prompts = h.codexTurnPrompts();
    assert.strictEqual(prompts.length, 1, 'exactly one turn');
    assert.ok(prompts[0].includes('You are Ida'), 'system prompt prepended on first turn');
    assert.ok(prompts[0].includes('first codex question'), 'user content present');

    // Transcript persisted both sides
    const t = transcript(convoId);
    assert.deepStrictEqual(t.map(e => [e.role, e.agent]), [['user', 'user'], ['agent', 'researcher']]);
    assert.ok(t[1].text.includes('Answer from Ida.'));
  });

  test('follow-up turn resumes the thread without re-sending instructions', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'question one' }, text: 'First.' },
      { match: { promptIncludes: 'question two' }, text: 'Second.' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'question one' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const threadId = init._sessionId;
    await client.waitForEvent('system', 'done', convoId);

    // The client sends the stored session id back on the next turn
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'question two', sessionId: threadId });
    const { msg: result2 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'resumed result' });
    assert.strictEqual(result2.result, 'Second.');

    const resumes = methodEntries('thread/resume');
    assert.strictEqual(resumes.length, 1, 'follow-up resumed the stored thread');
    assert.strictEqual(resumes[0].params.threadId, threadId);
    // Resumed turns send only the new message: instructions are not re-injected
    const prompts = h.codexTurnPrompts();
    assert.strictEqual(prompts.length, 2, 'one turn per message');
    assert.ok(!prompts[1].includes('You are Ida'), 'no instruction re-injection on resume');
    assert.ok(prompts[1].includes('question two'));
  });

  test('agent with an explicit model passes the model on the thread', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'summarise this' }, text: 'Summary.' }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'summariser', content: 'summarise this' });
    await client.waitForEvent('system', 'done', convoId);

    const starts = methodEntries('thread/start');
    assert.strictEqual(starts[0].params.model, 'gpt-5.3-codex');
  });

  test('unknown notifications and malformed lines are skipped without breaking the turn', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'noisy' }, text: 'Still fine.', noise: true }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'noisy output please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'noisy result' });
    assert.strictEqual(result.result, 'Still fine.');
    await client.waitForEvent('system', 'done', convoId);
  });

  test('write-marker-shaped text passes through as literal text: the marker mechanism is gone', async () => {
    // The exec-era WRITE_FILE marker machinery is retired in favour of
    // per-action approvals (codex-approvals.test.js). Marker-shaped output
    // must be fully inert: displayed verbatim, no card raised.
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    const markerText = '<!-- RUNDOCK:WRITE_FILE path="x.md" -->\nhello\n<!-- /RUNDOCK:WRITE_FILE -->';
    h.writeCodexScenario([{ match: { promptIncludes: 'marker passthrough' }, text: markerText }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'marker passthrough please' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result' });
    assert.strictEqual(result.result, markerText, 'marker text untouched');
    await client.waitForEvent('system', 'done', convoId);

    const prompts = h.codexTurnPrompts();
    assert.ok(!prompts[0].includes('WINDOWS FILE WRITES'), 'no marker instruction in the prompt');
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request' && m._conversationId === convoId);
    assert.deepStrictEqual(cards, [], 'no permission card for marker text');
  });

  test('quota exhaustion surfaces as a structured quota message, not a raw error', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'over quota' },
      error: { codexErrorInfo: 'usageLimitExceeded', message: QUOTA_MESSAGE },
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'over quota question' });

    const { msg: quota } = await client.waitForEvent('system', 'codex_quota', convoId);
    assert.strictEqual(quota._agent, 'researcher');
    // Verbatim CLI text travels with the structured message for the UI card
    assert.strictEqual(quota.detail, QUOTA_MESSAGE);

    await client.waitForEvent('system', 'done', convoId);
    // No raw error message alongside the structured one
    const raw = client.messages.filter(m => m.type === 'error' && m._conversationId === convoId);
    assert.deepStrictEqual(raw, []);
  });

  test('an unavailable-model 400 surfaces as guidance naming the model and the fix', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    // Real message captured live from a ChatGPT account with an unavailable model configured.
    const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';
    h.writeCodexScenario([{
      match: { promptIncludes: 'bad model' },
      error: { codexErrorInfo: 'badRequest', message: raw },
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'bad model please' });

    const { msg: err } = await client.waitForEvent('system', 'codex_guidance', convoId);
    assert.strictEqual(err._agent, 'researcher');
    assert.strictEqual(err.detail, raw, 'verbatim CLI text travels with the guidance');
    assert.match(err.title, /model/i);
    assert.match(err.body, /gpt-5\.3-codex/, 'guidance names the configured model');
    assert.match(err.body, /remove the model field/i, 'guidance states the fix');
    await client.waitForEvent('system', 'done', convoId);
  });

  test('a signed-out turn surfaces as guidance pointing at codex login, not transport noise', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    // The protocol types signed-out failures (codexErrorInfo: unauthorized)
    // even when the message is transport noise.
    const raw = 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a1ab5b883bdb63c9-LHR)';
    h.writeCodexScenario([{
      match: { promptIncludes: 'signed out' },
      error: { codexErrorInfo: 'unauthorized', message: raw },
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'signed out please' });

    const { msg: err } = await client.waitForEvent('system', 'codex_guidance', convoId);
    assert.strictEqual(err._agent, 'researcher');
    assert.match(err.title, /signed in/i);
    assert.match(err.body, /codex login/, 'guidance names the command');
    await client.waitForEvent('system', 'done', convoId);
  });

  test('a classified runtime failure surfaces as a friendly pill with the verbatim detail', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'blocked write' },
      error: { codexErrorInfo: 'sandboxError', message: 'sandbox denied write to /etc/hosts' },
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'blocked write please' });

    const { msg: err } = await client.waitForEvent('system', 'codex_error', convoId);
    assert.strictEqual(err._agent, 'researcher');
    assert.strictEqual(err.detail, 'sandbox denied write to /etc/hosts');

    await client.waitForEvent('system', 'done', convoId);
  });

  test('an app-server crash mid-turn fails the turn visibly, and the follow-up resumes the SAME thread on the restarted server', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'remember me' }, text: 'Noted.' },
      { match: { promptIncludes: 'crash now' }, deltas: ['about to die'], crashMidTurn: true },
      { match: { promptIncludes: 'after the crash' }, text: 'Back and resumed.' },
    ]);

    // Turn 1 establishes the thread id.
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'remember me please' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const threadId = init._sessionId;
    await client.waitForEvent('system', 'done', convoId);

    // Turn 2 dies with the process: surfaced as an error + done, never a hang.
    let since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'crash now please', sessionId: threadId });
    const { msg: err } = await client.waitForEvent('system', 'codex_error', convoId, { since });
    assert.strictEqual(err._agent, 'researcher');
    await client.waitForEvent('system', 'done', convoId, { since });

    // Turn 3: the singleton auto-restarted; the conversation resumes with
    // the STORED thread id (state lives on disk, not in server memory).
    since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'after the crash, are you there?', sessionId: threadId });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, timeout: 15000, label: 'post-restart result' });
    assert.strictEqual(result.result, 'Back and resumed.');

    const resumes = methodEntries('thread/resume').filter(r => r.params.threadId === threadId);
    assert.ok(resumes.length >= 1, 'thread/resume with the stored id after the crash');
    // The singleton was already up when this test cleared the invocation
    // log, so any spawn event recorded during it is the auto-restart.
    assert.ok(appServerSpawns().length >= 1, 'the app-server was respawned after the crash');
  });

  test('an invalid session id produces a full fresh turn: no resume AND instructions in the prompt', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'suspicious resume' }, text: 'Fresh anyway.' }]);

    // A flag-shaped session id must neither reach the wire nor leave the
    // prompt resume-shaped.
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'suspicious resume question', sessionId: '--dangerously-bypass-approvals-and-sandbox' });
    await client.waitForEvent('system', 'done', convoId);

    assert.strictEqual(methodEntries('thread/resume').length, 0, 'no resume attempted');
    const prompts = h.codexTurnPrompts();
    assert.ok(prompts[0].includes('You are Ida'), 'fresh turn carries the agent identity');
    for (const e of h.readInvocations()) {
      assert.ok(!JSON.stringify(e.params || {}).includes('--dangerously'), 'hostile id never reached the wire');
    }
  });

  test('routines on a codex agent run on Codex, sandboxed, never on the Claude plan', async () => {
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'routine work now' }, text: 'routine done.' }]);
    const agent = h.internal.discoverAgents().find(a => a.id === 'researcher');
    h.internal.executeRoutine(agent, { name: 'nightly-check', schedule: 'daily 09:00', prompt: 'routine work now' }, 'codex-routine-key');

    let prompts = [];
    for (let i = 0; i < 40 && prompts.length === 0; i++) {
      await h.delay(100);
      prompts = h.codexTurnPrompts().filter(p => p.includes('routine work now'));
    }
    assert.strictEqual(prompts.length, 1, 'one routine turn on the app-server');
    assert.ok(prompts[0].includes('You are Ida'), 'agent identity delivered');
    assert.strictEqual(h.readInvocations().find(i => i.bin === 'claude'), undefined, 'routine never ran on the Claude plan');
    // Unattended: nobody can approve, so the routine thread explicitly opts
    // into approvalPolicy never (blocked actions fail instead of hanging).
    const start = methodEntries('thread/start').pop();
    assert.strictEqual(start.params.approvalPolicy, 'never');
    assert.strictEqual(start.params.sandbox, 'workspace-write');
  });

  test('a failed turn is persisted to the transcript so an unwatched conversation still learns of it', async () => {
    const convoId = h.freshConvoId('cdx');
    h.writeCodexScenario([{
      match: { promptIncludes: 'persist failure' },
      error: { codexErrorInfo: 'usageLimitExceeded', message: QUOTA_MESSAGE },
    }]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'persist failure please' });
    await client.waitForEvent('system', 'codex_quota', convoId);
    await client.waitForEvent('system', 'done', convoId);

    const t = transcript(convoId);
    const failureRow = t.find(e => e.agent === 'researcher' && e.text.includes('plan limit'));
    assert.ok(failureRow, 'failure persisted');
    assert.ok(failureRow.text.includes(QUOTA_MESSAGE), 'verbatim CLI text persisted');
  });

  test('a new user message while a codex turn is running supersedes it (turn interrupted, SAME thread continues)', async () => {
    const convoId = h.freshConvoId('cdx');
    h.clearInvocations();
    h.writeCodexScenario([
      { match: { promptIncludes: 'slow question' }, deltas: ['thinking...'], hangAfterDeltas: true },
      { match: { promptIncludes: 'impatient follow-up' }, text: 'Quick answer.' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'slow question' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const threadId = init._sessionId;
    // The first turn is demonstrably mid-flight (a delta reached the client).
    await client.waitFor(m => m.type === 'stream_event' && m._conversationId === convoId, { label: 'first-turn delta' });

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'impatient follow-up', sessionId: threadId });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, timeout: 12000, label: 'superseding result' });
    assert.strictEqual(result.result, 'Quick answer.');

    // Both turns ran on the SAME thread: the superseded one was interrupted
    // (turn/interrupt on the shared server), never a process kill.
    const turnStarts = methodEntries('turn/start');
    assert.strictEqual(turnStarts.length, 2, 'two turns: superseded + superseding');
    assert.strictEqual(turnStarts[0].params.threadId, threadId);
    assert.strictEqual(turnStarts[1].params.threadId, threadId);
    assert.ok(methodEntries('turn/interrupt').length >= 1, 'the superseded turn was interrupted');
    assert.strictEqual(appServerSpawns().length, 0, 'no new process for the superseding turn (singleton already up)');
  });
});
