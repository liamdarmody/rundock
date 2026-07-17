'use strict';
// Integration: recovery from a failed thread/resume (re-gate R3).
//
// A stored Codex thread id can stop resuming for real-world reasons: Codex
// pruning or deleting sessions under ~/.codex, a CODEX_HOME change, or a
// workspace synced to another machine. The CLI answers thread/resume with
// -32600 "no rollout found for thread id ..." (verified live against
// codex-cli 0.144.3). Without recovery the conversation is bricked: every
// message repeats the identical failure.
//
// The contract under test mirrors the Claude path's stale-session recovery
// (server.js chat close handler): the user is told "Previous session
// expired. Starting fresh.", the stored id is superseded by a fresh thread
// whose id travels on the init rails, the SAME message is answered in the
// same pass with the FULL first-turn prompt (identity + platform rules),
// and the delegated path recovers identically.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Valid-shaped but unknown ids: pass thread-id hygiene, fail resume.
const STALE_DIRECT_ID = '11111111-2222-4333-8444-555555555555';
const STALE_DELEGATE_ID = '99999999-8888-4777-8666-555555555555';

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team() });
  client = await h.connect();
});
after(async () => h.shutdown());

function methodEntries(method) {
  return h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);
}

describe('codex thread/resume failure recovery', () => {
  test('direct chat with a stale stored id: expiry notice, fresh full-prompt thread, the message is answered, the fresh id rides the init rails', async () => {
    const convoId = h.freshConvoId('crec');
    h.clearInvocations();
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'answer me anyway' }, text: 'Answered on a fresh thread.' }],
      { resumeFails: true }
    );

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'answer me anyway please', sessionId: STALE_DIRECT_ID });

    // The user is told, with the exact copy the Claude path uses; subtype
    // 'info' is the stale-session signal that clears the stored primary
    // session id client-side.
    const { msg: info } = await client.waitForEvent('system', 'info', convoId, { since, label: 'session-expired notice' });
    assert.strictEqual(info.content, 'Previous session expired. Starting fresh.');

    // The SAME message is answered in the same pass, not bricked.
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'recovered result' });
    assert.strictEqual(result.result, 'Answered on a fresh thread.');
    await client.waitForEvent('system', 'done', convoId, { since });

    // No error pill: this is recovery, not failure.
    const errors = client.messages.slice(since).filter(m => m.type === 'system' && ['codex_error', 'codex_quota', 'codex_guidance'].includes(m.subtype) && m._conversationId === convoId);
    assert.deepStrictEqual(errors, [], 'no runtime-error surface on a recovered resume');

    // The resume WAS attempted with the stored id, then a fresh thread started.
    const resumes = methodEntries('thread/resume');
    assert.strictEqual(resumes.length, 1, 'one resume attempt');
    assert.strictEqual(resumes[0].params.threadId, STALE_DIRECT_ID);
    assert.strictEqual(methodEntries('thread/start').length, 1, 'fresh thread after the failed resume');

    // The fresh thread id replaces the stale one on the init rails (the
    // client stores _sessionId from init and sends it back next turn).
    const { msg: init } = await client.waitForEvent('system', 'init', convoId, { since });
    assert.match(init._sessionId, UUID_RE);
    assert.notStrictEqual(init._sessionId, STALE_DIRECT_ID, 'the fresh id, not the dead one');

    // The fallback turn is a FULL first turn: identity + platform rules +
    // the user message (a resume-shaped prompt on a fresh thread would lose
    // the agent's identity).
    const prompts = h.codexTurnPrompts();
    assert.strictEqual(prompts.length, 1, 'exactly one turn served the message');
    assert.ok(prompts[0].includes('You are Ida'), 'agent identity in the fresh-thread prompt');
    assert.ok(prompts[0].includes('PLATFORM RULES'), 'platform rules in the fresh-thread prompt');
    assert.ok(prompts[0].includes('answer me anyway please'), 'the user message is served');

    // And the conversation continues: the follow-up resumes the FRESH id.
    h.writeCodexScenario([{ match: { promptIncludes: 'follow up' }, text: 'Still here.' }]);
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'follow up please', sessionId: init._sessionId });
    const { msg: result2 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: since2, label: 'follow-up result' });
    assert.strictEqual(result2.result, 'Still here.');
    const followUpResumes = methodEntries('thread/resume').filter(r => r.params.threadId === init._sessionId);
    assert.strictEqual(followUpResumes.length, 1, 'follow-up resumed the stored fresh id');
  });

  test('delegated turn with a stale stored delegate session recovers the same way and still answers the brief', async () => {
    const convoId = h.freshConvoId('crec');
    h.clearInvocations();

    // The delegate resume id comes from the persisted conversation's
    // sessionIds chain (agent-scoped), exactly where a real stale id lives.
    const convos = h.internal.readConversations();
    convos.push({
      id: convoId, agentId: 'chief-of-staff', sessionId: null,
      sessionIds: [{ sessionId: STALE_DELEGATE_ID, agentId: 'researcher' }],
      title: 'Recovery test', status: 'active',
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    });
    h.internal.writeConversations(convos);

    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'recovery delegate please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'recovery delegate brief' } }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'recovery delegate brief' }, text: 'RECOVERED-PAYLOAD delivered. <!-- RUNDOCK:COMPLETE -->' }],
      { resumeFails: true }
    );

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'recovery delegate please' });

    // The user is told; on the delegate path the pill is the neutral
    // 'notice' (the 'info' subtype would clear the ORCHESTRATOR's stored
    // primary session, which is alive and well).
    const { msg: notice } = await client.waitFor(
      m => m.type === 'system' && (m.subtype === 'notice' || m.subtype === 'info') && m._conversationId === convoId && /Previous session expired/.test(m.content || ''),
      { since, label: 'delegate session-expired notice' });
    assert.strictEqual(notice.subtype, 'notice', "delegate recovery must not send 'info' (it would wipe the orchestrator's session)");
    assert.strictEqual(notice.content, 'Previous session expired. Starting fresh.');

    // The brief is still answered on a fresh thread in the same pass.
    const { msg: result } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher',
      { since, label: 'recovered delegate result' });
    assert.ok(result.result.includes('RECOVERED-PAYLOAD'), 'delegate output delivered despite the dead session');

    const resumes = methodEntries('thread/resume');
    assert.strictEqual(resumes.length, 1, 'one delegate resume attempt');
    assert.strictEqual(resumes[0].params.threadId, STALE_DELEGATE_ID);
    assert.strictEqual(methodEntries('thread/start').length, 1, 'fresh delegate thread after the failed resume');

    // Fresh delegate thread means the FULL delegate prompt: identity +
    // delegation contract + brief (the resume-shaped prompt carries no
    // identity).
    const prompt = h.codexTurnPrompts().pop();
    assert.ok(prompt.includes('You are Ida'), 'delegate identity in the fresh-thread prompt');
    assert.ok(prompt.includes('DELEGATION CONTEXT'), 'delegation contract in the fresh-thread prompt');
    assert.ok(prompt.includes('recovery delegate brief'), 'the brief is served');

    // The fresh delegate id rides the init rails scoped to the delegate.
    const { msg: init } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'init' && m._conversationId === convoId && m._agent === 'researcher',
      { since, label: 'delegate init' });
    assert.match(init._sessionId, UUID_RE);
    assert.notStrictEqual(init._sessionId, STALE_DELEGATE_ID);

    await client.waitFor(
      m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff',
      { since, label: 'handback to parent' });
    h.reapConvo(convoId);
  });

  test('a NON-resume-shaped turn-start failure still fails visibly (recovery never masks real errors)', async () => {
    const convoId = h.freshConvoId('crec');
    h.clearInvocations();
    // Persistent -32001 overload on thread/resume exhausts the client's
    // bounded retries: a transport-shaped failure, not a "no rollout"
    // rejection, so it must surface as an error rather than silently
    // burning a fresh thread.
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'never recovers' }, text: 'unreachable' }],
      { overload: { method: 'thread/resume', times: 99 } }
    );

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'never recovers please', sessionId: STALE_DIRECT_ID });
    await client.waitForEvent('system', 'codex_error', convoId, { since, timeout: 20000, label: 'visible failure' });
    await client.waitForEvent('system', 'done', convoId, { since, timeout: 20000 });
    assert.strictEqual(methodEntries('thread/start').length, 0, 'no silent fresh-thread fallback for non-resume-shaped failures');
  });
});
