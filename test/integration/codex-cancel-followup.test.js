'use strict';
// Integration: the post-cancel follow-up window on the Codex runtime
// (Windows VM Finding 6, both failure modes).
//
// Live repro (Windows 11, codex-cli 0.144.4): start a Codex turn, cancel ~2s
// in, send a follow-up ~3s later with the stored session id. Two failure
// modes were observed:
//
// Mode 1: thread/resume fails transiently with "rollout at ... is empty"
// (the interrupted thread's rollout had not been flushed yet; it appeared
// moments later). This wording fell through the resume-failure classifier,
// so the user got a raw codex_error card and an immediate retry repeated the
// identical failure. The thread becomes resumable once codex flushes, so a
// fresh-thread fallback would permanently discard it: the right behaviour is
// retry once, then a "resend in a moment" notice with the session PRESERVED.
//
// Mode 2: the interrupt's response and turn/completed were lost (periodic
// network stream disconnects), the client-side active-turn slot stayed
// occupied for tens of seconds, and every follow-up errored with "a turn is
// already active". The failsafe releases the slot after a bounded window,
// and any turn-start rejected as busy (client-thrown or server-rejected)
// surfaces as the same retryable notice, never an error card.
//
// The permanent resume-failure class (-32600 / "no rollout") keeps its
// fresh-thread recovery unchanged: pinned by codex-session-recovery.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

const BUSY_NOTICE = 'The runtime is still wrapping up the previous turn. Resend your message in a moment.';
const FAILSAFE_MS = 1000;
const RETRY_MS = 100;

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
  await h.boot({
    agents: team(),
    env: {
      // Injectable timings so the failsafe and retry paths run in test time.
      RUNDOCK_CODEX_INTERRUPT_FAILSAFE_MS: String(FAILSAFE_MS),
      RUNDOCK_CODEX_RESUME_RETRY_MS: String(RETRY_MS),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

function methodEntries(method) {
  return h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);
}

function errorCards(since, convoId) {
  return client.messages.slice(since).filter(m => m.type === 'system'
    && ['codex_error', 'codex_quota', 'codex_guidance'].includes(m.subtype)
    && m._conversationId === convoId);
}

function infoPills(since, convoId) {
  // subtype 'info' is the stale-session signal that CLEARS the stored
  // session id client-side; the transient paths must never emit it.
  return client.messages.slice(since).filter(m => m.type === 'system'
    && m.subtype === 'info' && m._conversationId === convoId);
}

async function establishThread(convoId, content, reply) {
  h.writeCodexScenario([{ match: { promptIncludes: content }, text: reply }]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content });
  const { msg: init } = await client.waitForEvent('system', 'init', convoId);
  await client.waitForEvent('system', 'done', convoId);
  return init._sessionId;
}

describe('mode 1: transient resume failure (rollout not flushed yet)', () => {
  test('one transient failure: the resume is retried after the injectable delay and the message is answered on the SAME thread', async () => {
    const convoId = h.freshConvoId('ccf');
    const threadId = await establishThread(convoId, 'establish one', 'Established.');

    h.clearInvocations();
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'try again' }, text: 'Answered after the flush.' }],
      { resumeTransientFails: 1 }
    );

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'try again please', sessionId: threadId });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, timeout: 12000, label: 'retried result' });
    assert.strictEqual(result.result, 'Answered after the flush.');
    await client.waitForEvent('system', 'done', convoId, { since });

    const resumes = methodEntries('thread/resume').filter(r => r.params.threadId === threadId);
    assert.strictEqual(resumes.length, 2, 'failed resume plus one retry');
    assert.strictEqual(methodEntries('thread/start').length, 0, 'the thread is never abandoned for a fresh one');
    assert.deepStrictEqual(errorCards(since, convoId), [], 'no error card on a recovered transient failure');
    assert.deepStrictEqual(infoPills(since, convoId), [], 'the stored session id is never cleared');
  });

  test('persistent transient failure: retry once, then the resend notice + a normal done, session PRESERVED and usable once the rollout flushes', async () => {
    const convoId = h.freshConvoId('ccf');
    const threadId = await establishThread(convoId, 'establish two', 'Established.');

    h.clearInvocations();
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'still settling' }, text: 'unreachable' }],
      { resumeTransientFails: 99 }
    );

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'still settling please', sessionId: threadId });

    const { msg: notice } = await client.waitFor(
      m => m.type === 'system' && (m.subtype === 'notice' || m.subtype === 'info') && m._conversationId === convoId && /wrapping up/.test(m.content || ''),
      { since, timeout: 12000, label: 'resend notice' });
    assert.strictEqual(notice.subtype, 'notice', "must be the neutral 'notice', never the session-clearing 'info'");
    assert.strictEqual(notice.content, BUSY_NOTICE);
    await client.waitForEvent('system', 'done', convoId, { since });

    const resumes = methodEntries('thread/resume').filter(r => r.params.threadId === threadId);
    assert.strictEqual(resumes.length, 2, 'exactly one bounded retry, not a retry storm');
    assert.strictEqual(methodEntries('thread/start').length, 0, 'NO fresh-thread fallback: the thread becomes resumable once codex flushes');
    assert.deepStrictEqual(errorCards(since, convoId), [], 'no error card: this is a retryable state');
    assert.deepStrictEqual(infoPills(since, convoId), [], 'the stored session id is never cleared');

    // The rollout "flushes" (the stub knob is removed): resending with the
    // SAME session id now works, proving the session survived intact.
    h.writeCodexScenario([{ match: { promptIncludes: 'resend now' }, text: 'Resumed after the flush.' }]);
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'resend now please', sessionId: threadId });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: since2, timeout: 12000, label: 'post-flush result' });
    assert.strictEqual(result.result, 'Resumed after the flush.');
    const okResumes = methodEntries('thread/resume').filter(r => r.params.threadId === threadId);
    assert.strictEqual(okResumes.length, 3, 'the preserved id resumed successfully');
  });
});

describe('mode 2: cancelled turn whose interrupt response is lost', () => {
  test('follow-up INSIDE the failsafe window gets the resend notice (no error card); AFTER the window the slot is free and the follow-up works', async () => {
    const convoId = h.freshConvoId('ccf');
    h.clearInvocations();
    h.writeCodexScenario(
      [
        { match: { promptIncludes: 'slow work' }, deltas: ['working...'], hangAfterDeltas: true },
        { match: { promptIncludes: 'quick follow-up' }, text: 'Quick answer.' },
      ],
      { dropInterrupt: true }
    );

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'slow work please' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const threadId = init._sessionId;
    await client.waitFor(m => m.type === 'stream_event' && m._conversationId === convoId, { label: 'mid-flight delta' });

    // Cancel: acknowledged cleanly (cancelled + done), but the stub drops
    // the interrupt response AND turn/completed, the live lost-stream shape.
    let since = client.messages.length;
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await client.waitForEvent('system', 'done', convoId, { since });

    // Immediate follow-up, inside the failsafe window: the client-side slot
    // is still occupied. Pre-fix this produced a codex_error card ("a turn
    // is already active on thread ...") for tens of seconds.
    since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'quick follow-up', sessionId: threadId });
    const { msg: notice } = await client.waitFor(
      m => m.type === 'system' && (m.subtype === 'notice' || m.subtype === 'info') && m._conversationId === convoId && /wrapping up/.test(m.content || ''),
      { since, label: 'busy notice' });
    assert.strictEqual(notice.subtype, 'notice');
    assert.strictEqual(notice.content, BUSY_NOTICE);
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(errorCards(since, convoId), [], 'never an error card in the post-cancel window');
    assert.deepStrictEqual(infoPills(since, convoId), [], 'session id preserved');

    // Past the failsafe window the slot has been released locally: the same
    // follow-up now runs to completion on the SAME thread.
    await h.delay(FAILSAFE_MS + 500);
    since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'quick follow-up', sessionId: threadId });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, timeout: 12000, label: 'post-failsafe result' });
    assert.strictEqual(result.result, 'Quick answer.');
    const turnStarts = methodEntries('turn/start').filter(t => t.params.threadId === threadId);
    assert.ok(turnStarts.length >= 2, 'the recovered follow-up ran on the same thread');
  });

  test('a turn/start the SERVER rejects as busy (turn genuinely still active) surfaces as the retryable notice, not an error card', async () => {
    const convoId = h.freshConvoId('ccf');
    h.clearInvocations();
    // dropMethods swallows the interrupt entirely: the server-side turn
    // stays active, so after the client failsafe frees the local slot the
    // SERVER is the one rejecting the next turn/start. Server-side protocol
    // state is authoritative; the rejection must still be retryable.
    h.writeCodexScenario(
      [{ match: { promptIncludes: 'wedged work' }, deltas: ['working...'], hangAfterDeltas: true }],
      { dropMethods: ['turn/interrupt'] }
    );

    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'wedged work please' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId);
    const threadId = init._sessionId;
    await client.waitFor(m => m.type === 'stream_event' && m._conversationId === convoId, { label: 'wedged delta' });

    let since = client.messages.length;
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'done', convoId, { since });

    // Wait out the client failsafe so the LOCAL slot is free.
    await h.delay(FAILSAFE_MS + 500);

    since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'follow-up into the wedge', sessionId: threadId });
    const { msg: notice } = await client.waitFor(
      m => m.type === 'system' && (m.subtype === 'notice' || m.subtype === 'info') && m._conversationId === convoId && /wrapping up/.test(m.content || ''),
      { since, timeout: 12000, label: 'server-busy notice' });
    assert.strictEqual(notice.subtype, 'notice');
    assert.strictEqual(notice.content, BUSY_NOTICE);
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(errorCards(since, convoId), [], 'server-rejected busy is retryable, not an error card');

    // The rejection really came from the server: turn/start reached it.
    const followUpStarts = methodEntries('turn/start').filter(t => t.params.threadId === threadId);
    assert.ok(followUpStarts.length >= 2, 'the follow-up turn/start reached the server and was rejected there');
  });
});
