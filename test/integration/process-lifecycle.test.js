'use strict';
// Integration: agent processes must not accumulate for the life of a session.
//
// Rundock keeps one live agent process per conversation touched, plus every
// parked ancestor in a delegation chain, and reaped none of them. A process
// lived until it exited on its own, was cancelled, or the app quit. Each also
// holds its own set of MCP servers, so memory grew with session length and
// conversation count until the machine started swapping.
//
// Confirmed on a beta user's machine: three agent trees, each roughly 110MB,
// alive for 17 hours 47 minutes, spawned within four minutes of launching the
// app and untouched since. Archiving conversations changed nothing, because
// archiving is a status flag and never touched a process.
//
// Reaping is safe because it is not destructive. Session ids are persisted per
// conversation and the client sends one back with the next message, so a
// reaped conversation resumes with its context intact. These tests assert that
// property directly rather than assuming it.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

// A real idle timeout is measured in minutes, which no test can wait for. The
// fix therefore has to expose a configurable interval; setting it here states
// that requirement rather than discovering it later.
const REAP_MS = 300;

let client;

before(async () => {
  await h.boot({ env: { RUNDOCK_IDLE_REAP_MS: String(REAP_MS) } });
  client = await h.connect();
});
after(async () => h.shutdown());

function liveEntries() {
  return [...h.internal.chatProcesses.values()].filter(e => !e.exited);
}

async function completeTurn(convoId, keyword, agent = 'chief-of-staff') {
  // Scan from HERE: without a starting point, a later turn on the same
  // conversation matches an EARLIER turn's result and returns immediately,
  // before the process it is waiting on has even spawned.
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent, content: keyword });
  await client.waitFor(m => m.type === 'result' && m._conversationId === convoId,
    { since, label: `turn result for ${keyword}` });
}

describe('idle agent processes', () => {
  test('a conversation that started a background task is never reaped', async () => {
    const convoId = h.freshConvoId('reap-bg');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'background-guard' },
        turn: [
          // Exactly the shape the real CLI emits for a backgrounded command:
          // the flag arrives inside the tool input, which the server already
          // parses and used to discard.
          { tool: { name: 'Bash', input: { command: 'sleep 400', description: 'Long job', run_in_background: true } } },
          { text: 'Started, running in the background now.' },
        ] },
    ]);

    await completeTurn(convoId, 'background-guard');
    assert.ok(h.internal.chatProcesses.has(convoId), 'precondition: the turn left a live process');

    // Several reap windows. The turn is finished and the conversation looks
    // idle, but work Rundock cannot see in the stream is still running.
    await h.delay(REAP_MS * 5);

    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && !entry.exited,
      'a conversation whose agent launched a background task must not be reaped. The turn '
      + 'ended, so it looks idle, but killing it takes the job with it and the user is '
      + 'usually waiting on exactly that result.');

    h.reapConvo(convoId);
  });

  test('an ordinary turn in the same run is still reaped, so the guard is not blanket', async () => {
    const convoId = h.freshConvoId('reap-plain');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'no-background-here' },
        turn: [{ text: 'Answered, nothing running.' }] },
    ]);

    await completeTurn(convoId, 'no-background-here');
    await h.delay(REAP_MS * 5);

    assert.ok(!h.internal.chatProcesses.has(convoId),
      'the background guard must apply only to conversations that actually started one');
  });

  test('an idle process is reaped instead of living for the whole session', async () => {
    const CONVOS = 4;
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'reap-idle' },
        turn: [{ text: 'Answered, nothing further.' }] },
    ]);

    const ids = [];
    for (let i = 0; i < CONVOS; i++) {
      const convoId = h.freshConvoId('reap');
      ids.push(convoId);
      await completeTurn(convoId, `reap-idle ${i}`);
    }

    assert.strictEqual(liveEntries().length, CONVOS,
      'precondition: every completed conversation leaves a live process');

    // Well past the configured idle window, with nothing working.
    await h.delay(REAP_MS * 4);

    const after = liveEntries();
    assert.ok(after.length < CONVOS,
      `idle agent processes must not accumulate one per conversation for the life of `
      + `the session. After ${CONVOS} completed turns and ${REAP_MS * 4}ms idle, `
      + `${after.length} were still alive (agents: ${after.map(e => e.agentId).join(', ')}).`);

    for (const id of ids) h.reapConvo(id);
  });

  test('a conversation used again after reaping resumes with its context', async () => {
    const convoId = h.freshConvoId('reap-resume');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'resume-after-reap' },
        turn: [{ text: 'First answer.' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'second question' },
        turn: [{ text: 'Second answer, with the thread intact.' }] },
    ]);

    await completeTurn(convoId, 'resume-after-reap');
    const sessionId = h.internal.chatProcesses.get(convoId)?.sessionId;
    assert.ok(sessionId, 'precondition: the first turn established a session');

    await h.delay(REAP_MS * 4);
    assert.ok(!h.internal.chatProcesses.has(convoId), 'precondition: it was reaped');

    // The client sends the session id back, exactly as it does after a restart.
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'second question', sessionId });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'second turn' });

    // A resume spawn omits --agent on purpose: identity already lives in the
    // session. So match on the resume flag, not the agent name.
    const spawn = h.readInvocations().find(i => i.resume);
    assert.ok(spawn, 'a new process was spawned for the second turn');
    assert.strictEqual(spawn.resume, sessionId,
      `reaping must not lose context: the replacement process has to resume the prior `
      + `session, or the user silently loses their conversation history. Spawned with `
      + `resume=${spawn.resume}, expected ${sessionId}.`);

    h.reapConvo(convoId);
  });

  test('a process that is still working is never reaped', async () => {
    const convoId = h.freshConvoId('reap-busy');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'still-working' },
        delayMs: REAP_MS * 5,
        turn: [{ text: 'Finally done.' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'still-working' });
    // Let the sweep run several times while the turn is genuinely in flight.
    await h.delay(REAP_MS * 3);

    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && !entry.exited,
      'a process mid-turn must never be reaped: the user is waiting on its answer');

    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'delayed result' });
    h.reapConvo(convoId);
  });

  test('parked ancestors are reaped too, not left behind the delegate', async () => {
    const convoId = h.freshConvoId('reap-chain');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'chain-reap setup' },
        turn: [{ text: 'Orchestrator ready.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'chain-reap brief' },
        turn: [{ text: 'Working, staying in the conversation.' }] },
    ]);

    // The explicit delegate message parks the caller alive behind the delegate.
    // An intercepted Agent-tool call does NOT: it kills the caller and resumes
    // it later from its session, so there is no parked ancestor to reap.
    await completeTurn(convoId, 'chain-reap setup');
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'chain-reap brief' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
      && m._agent === 'content-lead', { label: 'delegate result' });

    const entry = h.internal.chatProcesses.get(convoId);
    const parked = entry && entry.delegation && entry.delegation.originalEntry;
    assert.ok(parked && !parked.exited,
      'precondition: delegating parks the caller alive behind the delegate');

    await h.delay(REAP_MS * 4);

    assert.ok(parked.exited || !h.pidAlive(parked.process.pid),
      'a parked ancestor holds its own agent process and its own set of tool servers. '
      + 'Reaping the delegate while leaving the parent behind would halve the fix.');

    h.reapConvo(convoId);
  });
});
