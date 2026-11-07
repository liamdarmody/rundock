'use strict';
// A CATCH-UP HELD FOR THE NEXT MESSAGE OUTLIVES THE PROCESS HOLDING IT, AND A
// MESSAGE SENT BETWEEN AN INIT AND A REFUSAL IS NOT LOST.
//
// When a handback reaches an orchestrator whose stored session Claude Code no
// longer has, the orchestrator starts again fresh. Paused by the circuit
// breaker, that fresh start has no prompt of its own, so it holds the
// conversation's catch-up for the person's next message instead. Held only on
// the process's entry, it was gone when the idle reaper ended that process, or
// the server restarted, before the next message: and the breaker's own notice
// asks the person to review and send their next message, which is exactly that
// wait. The next message then reached a session that knew nothing.
//
// Driven through the real server against the stub runtime. The window is
// played by the real reducer and the real stored-session rules, as in
// stale-session.test.js, so what it saves and what it resumes are its own.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { createState, reduce, forgetSession, resumeSessionFor } = require('../../public/conversation-state.js');
const { CATCH_UP_HEADINGS } = require('../../lib/delegation/catch-up.js');

const ARRIVING = CATCH_UP_HEADINGS.arriving;

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }, null, 2));
}

function stored(convoId) {
  return h.internal.readConversations().find((c) => c.id === convoId) || null;
}

function seed(convoId, record) {
  const all = h.internal.readConversations().filter((c) => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', ...record }, ...all]);
  return stored(convoId);
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label: label || `result ${text}`, timeout: 15000 });
}

/** Wait until the server has read every save sent so far: the socket is ordered. */
async function settled() {
  const since = client.messages.length;
  client.send({ type: 'get_lists' });
  await client.waitFor((m) => m.type === 'lists', { since, label: 'saves read' });
}

/** Every prompt Claude Code was sent since the scenario began, in order. */
function prompts() {
  return h.readPrompts().map((p) => p.prompt);
}

/** How many prompts carried the conversation's catch-up. */
function catchUps() {
  return prompts().filter((p) => p.includes(ARRIVING)).length;
}

/**
 * What the open window holds for one conversation, driven by the real reducer
 * and the real stored-session rules, as stale-session.test.js plays it. Each
 * effect ends in the save the window sends.
 */
function windowFor(record) {
  const convo = JSON.parse(JSON.stringify(record));
  let state = Object.assign(createState(), { activeAgentId: record.activeAgentId || null });
  let seen = client.messages.length;
  const save = () => client.send({ type: 'save_conversation', conversation: {
    id: convo.id, agentId: convo.agentId, activeAgentId: state.activeAgentId || null,
    sessionId: convo.sessionId || null, sessionIds: convo.sessionIds || [], title: convo.title, status: 'active',
  } });
  const ctxFor = (m) => (m.subtype === 'init'
    ? { convoExists: true, convoAgentId: convo.agentId, hasPrimarySession: !!convo.sessionId,
      knownSessionIds: (convo.sessionIds || []).map((s) => s.sessionId) }
    : { hasPrimarySession: !!convo.sessionId, convoAgentId: convo.agentId, toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true });
  const run = (effects) => {
    for (const ef of effects) {
      if (ef.type === 'set-session') {
        if (ef.setPrimary) convo.sessionId = ef.sessionId;
        if (!convo.sessionIds) convo.sessionIds = [];
        if (ef.addToChain) convo.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
        save();
      } else if (ef.type === 'forget-session') {
        if (forgetSession(convo, ef.sessionId)) save();
      }
    }
  };
  return {
    convo,
    get activeAgentId() { return state.activeAgentId || convo.agentId; },
    sync(until = client.messages.length) {
      for (; seen < until; seen++) {
        const m = client.messages[seen];
        if (m._conversationId !== convo.id || m.type !== 'system') continue;
        if (!['init', 'info', 'session_expired', 'agent_switch'].includes(m.subtype)) continue;
        if (m.subtype === 'init' && !m._sessionId) continue;
        const r = reduce(state, m, ctxFor(m));
        state = r.state;
        run(r.effects);
      }
    },
    send(content) {
      this.sync();
      const agent = this.activeAgentId;
      const sessionId = resumeSessionFor(convo, agent);
      client.send({ type: 'chat', conversationId: convo.id, agent, content, ...(sessionId ? { sessionId } : {}) });
      return { agent, sessionId };
    },
  };
}

/**
 * A handback to an orchestrator whose stored session is gone, paused by the
 * circuit breaker: the orchestrator starts fresh with no prompt of its own and
 * holds the catch-up for the person's next message. `rules` answer what comes
 * after. Returns the window, synced to the fresh start.
 */
async function pausedFreshStart(tag, rules = []) {
  const convoId = h.freshConvoId(`held-${tag.toLowerCase()}`);
  const record = seed(convoId, {
    agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: `dead-orch-${tag}`,
    sessionIds: [{ agentId: 'chief-of-staff', sessionId: `dead-orch-${tag}` }, { agentId: 'content-lead', sessionId: `live-lead-${tag}` }],
  });
  scenario([
    { match: { resume: true, promptIncludes: `TASK-${tag}` }, turn: [{ text: `Not mine, handing back ${tag}. <!-- RUNDOCK:RETURN -->` }] },
    ...rules,
  ], [`dead-orch-${tag}`]);
  h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);
  h.clearInvocations();
  const win = windowFor(record);
  const since = client.messages.length;
  win.send(`do TASK-${tag}`);
  await client.waitFor((m) => m.type === 'assistant' && m._conversationId === convoId && /Auto-paused/.test(JSON.stringify(m)),
    { since, label: 'the circuit breaker pauses the handback', timeout: 15000 });
  await client.waitFor((m) => m.subtype === 'info' && m._conversationId === convoId && m.expiredSessionId === `dead-orch-${tag}`,
    { since, label: 'the fresh start', timeout: 15000 });
  const entry = h.internal.chatProcesses.get(convoId);
  assert.ok(entry && entry.idle && !entry.exited, 'the fresh orchestrator is idle, holding the catch-up');
  win.sync();
  await settled();
  // What follows is counted from here: the specialist's own turn is not.
  h.clearPrompts();
  return { convoId, win };
}

/** The idle reaper's sweep, at a time past every idle limit. */
async function reap(convoId) {
  await h.waitUntil(() => { const e = h.internal.chatProcesses.get(convoId); return Boolean(e && e.idle); });
  const entry = h.internal.chatProcesses.get(convoId);
  assert.ok(entry && entry.idle, 'the orchestrator is idle when the reaper sweeps');
  h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
  assert.ok(!h.internal.chatProcesses.has(convoId), 'the reaper released it');
  await h.waitUntil(() => entry.process.exitCode !== null || entry.process.signalCode !== null);
}

/**
 * A restart, as this conversation sees one. The harness runs the server in
 * this process and boots it once, so a second boot is not open to it; this is
 * the state a second boot finds: nothing the server held in memory for the
 * conversation (its process, ended, and its entry; its cached transcript; the
 * circuit breaker's count), only what is on disk. The window that comes back
 * is built from the stored record, as one reloading is.
 */
async function restart(convoId, win) {
  win.sync();
  await settled();
  const entry = h.internal.chatProcesses.get(convoId);
  if (entry && entry.process) {
    entry.cancelled = true;
    try { entry.process.kill('SIGKILL'); } catch (e) { /* already gone */ }
    await h.waitUntil(() => entry.process.exitCode !== null || entry.process.signalCode !== null);
  }
  h.internal.chatProcesses.delete(convoId);
  h.internal.convoTranscripts.delete(convoId);
  h.internal.agentAutoResumeCount.delete(convoId);
  return windowFor(stored(convoId));
}

/** The catch-up the conversation holds, read from what a fresh start is told. */
function assertCarriesCatchUp(prompt, tag, own) {
  assert.ok(prompt.includes(ARRIVING), 'the conversation, as an arrival');
  assert.match(prompt, new RegExp(`do TASK-${tag}`), 'with the request the specialist was working on');
  assert.match(prompt, new RegExp(`Not mine, handing back ${tag}\\.`), 'and what the specialist handed back');
  assert.ok(prompt.endsWith(own), 'then the person\'s own words, as sent');
}

describe('a catch-up held by a paused fresh start', () => {
  test('reaches the next message once after the idle reaper ends the fresh start', async () => {
    const tag = 'R1';
    const { convoId, win } = await pausedFreshStart(tag, [
      { match: { promptIncludes: 'NEXT-R1' }, turn: [{ text: 'ORCH-NEXT-R1' }] },
      { match: { promptIncludes: 'AFTER-R1' }, turn: [{ text: 'ORCH-AFTER-R1' }] },
    ]);
    await reap(convoId);

    let since = client.messages.length;
    win.send('NEXT-R1 please');
    await waitForResult(convoId, 'ORCH-NEXT-R1', since, 'the next message is answered');
    assert.strictEqual(prompts().length, 1);
    assertCarriesCatchUp(prompts()[0], tag, 'NEXT-R1 please');
    assert.deepStrictEqual(h.readPrompts().map((p) => p.agent), ['chief-of-staff'], 'by the orchestrator');

    // THE UNDO: given once, it is not given again after a later reap.
    await reap(convoId);
    since = client.messages.length;
    win.send('AFTER-R1 too');
    await waitForResult(convoId, 'ORCH-AFTER-R1', since, 'the message after it');
    assert.strictEqual(prompts()[1], 'AFTER-R1 too', 'the catch-up is given once, not again after the next reap');
    assert.strictEqual(catchUps(), 1);
    h.reapConvo(convoId);
  });

  test('reaches the next message once after a restart', async () => {
    const tag = 'S1';
    const { convoId, win } = await pausedFreshStart(tag, [
      { match: { promptIncludes: 'NEXT-S1' }, turn: [{ text: 'ORCH-NEXT-S1' }] },
      { match: { promptIncludes: 'AFTER-S1' }, turn: [{ text: 'ORCH-AFTER-S1' }] },
    ]);
    let back = await restart(convoId, win);

    let since = client.messages.length;
    back.send('NEXT-S1 please');
    await waitForResult(convoId, 'ORCH-NEXT-S1', since, 'the next message is answered');
    assert.strictEqual(prompts().length, 1);
    assertCarriesCatchUp(prompts()[0], tag, 'NEXT-S1 please');

    // THE UNDO: given once, it is not given again after a later restart.
    back = await restart(convoId, back);
    since = client.messages.length;
    back.send('AFTER-S1 too');
    await waitForResult(convoId, 'ORCH-AFTER-S1', since, 'the message after it');
    assert.strictEqual(prompts()[1], 'AFTER-S1 too', 'the catch-up is given once, not again after the next restart');
    assert.strictEqual(catchUps(), 1);
    h.reapConvo(convoId);
  });

  test('given by the live process, it is not given again after a reap or a restart', async () => {
    const tag = 'U1';
    const { convoId, win } = await pausedFreshStart(tag, [
      { match: { promptIncludes: 'NEXT-U1' }, turn: [{ text: 'ORCH-NEXT-U1' }] },
      { match: { promptIncludes: 'AFTER-U1' }, turn: [{ text: 'ORCH-AFTER-U1' }] },
      { match: { promptIncludes: 'LAST-U1' }, turn: [{ text: 'ORCH-LAST-U1' }] },
    ]);
    let since = client.messages.length;
    win.send('NEXT-U1 please');
    await waitForResult(convoId, 'ORCH-NEXT-U1', since, 'the fresh orchestrator answers');
    assertCarriesCatchUp(prompts()[0], tag, 'NEXT-U1 please');

    await reap(convoId);
    since = client.messages.length;
    win.send('AFTER-U1 too');
    await waitForResult(convoId, 'ORCH-AFTER-U1', since, 'after a reap');
    const back = await restart(convoId, win);
    since = client.messages.length;
    back.send('LAST-U1 then');
    await waitForResult(convoId, 'ORCH-LAST-U1', since, 'after a restart');
    assert.deepStrictEqual(prompts().slice(1), ['AFTER-U1 too', 'LAST-U1 then'], 'each as sent');
    assert.strictEqual(catchUps(), 1, 'the catch-up was given once, by the process that held it');
    h.reapConvo(convoId);
  });

  test('two messages sent quickly after the reap give one catch-up, in front of the first', async () => {
    const tag = 'Q1';
    const { convoId, win } = await pausedFreshStart(tag, [
      { match: { promptIncludes: 'FIRST-Q1' }, turn: [{ text: 'ORCH-FIRST-Q1' }] },
      { match: { promptIncludes: 'SECOND-Q1' }, turn: [{ text: 'ORCH-SECOND-Q1' }] },
    ]);
    await reap(convoId);

    const since = client.messages.length;
    win.send('FIRST-Q1 one');
    win.send('SECOND-Q1 two');
    await waitForResult(convoId, 'ORCH-SECOND-Q1', since, 'both are answered');
    assert.strictEqual(prompts().length, 2);
    assertCarriesCatchUp(prompts()[0], tag, 'FIRST-Q1 one');
    assert.strictEqual(prompts()[1], 'SECOND-Q1 two', 'the second as sent');
    assert.strictEqual(catchUps(), 1);
    h.reapConvo(convoId);
  });

  test('a stored catch-up the resume it was given to never read goes to the fresh start, once', async () => {
    // Given to a process whose resume Claude Code then refuses, it was never
    // read, so it goes with the message into the session started in its place.
    const convoId = h.freshConvoId('held-refused');
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionId: 'dead-orch-v1',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-v1' }],
      freshCatchUp: { agentId: 'chief-of-staff', text: `${ARRIVING}\nHELD-V1 what happened while it was away\n\n` },
    });
    scenario([{ match: { promptIncludes: 'ASK-V1' }, turn: [{ text: 'FRESH-V1' }] }], ['dead-orch-v1']);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-V1 hello', sessionId: 'dead-orch-v1' });
    await waitForResult(convoId, 'FRESH-V1', since, 'the fresh start answers');
    assert.deepStrictEqual(h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === convoId).map((i) => i.resume),
      ['dead-orch-v1', null], 'refused once, then started fresh');
    assert.strictEqual(prompts().length, 1);
    assert.ok(prompts()[0].includes('HELD-V1'), 'the catch-up reaches the session that reads it');
    assert.ok(prompts()[0].endsWith('ASK-V1 hello'));
    assert.ok(!('freshCatchUp' in stored(convoId)), 'and is spent');
    h.reapConvo(convoId);
  });
});

describe('a stored catch-up that cannot be read', () => {
  test('is logged once and dropped, and the message still goes through without it', async () => {
    const convoId = h.freshConvoId('held-unreadable');
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionId: null, sessionIds: [],
      freshCatchUp: { agentId: 'chief-of-staff', text: { not: 'text' } },
    });
    scenario([
      { match: { promptIncludes: 'ASK-W1' }, turn: [{ text: 'ANSWER-W1' }] },
      { match: { promptIncludes: 'AGAIN-W1' }, turn: [{ text: 'ANSWER-AGAIN-W1' }] },
    ]);
    h.clearInvocations();
    const said = [];
    const warn = console.warn;
    console.warn = (...args) => { said.push(args.join(' ')); warn(...args); };
    try {
      let since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-W1 hello' });
      await waitForResult(convoId, 'ANSWER-W1', since, 'the message goes through');
      h.reapConvo(convoId);
      since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'AGAIN-W1 hello' });
      await waitForResult(convoId, 'ANSWER-AGAIN-W1', since, 'and the next one');
    } finally {
      console.warn = warn;
    }
    assert.deepStrictEqual(prompts(), ['ASK-W1 hello', 'AGAIN-W1 hello'], 'each as sent, never blocked');
    const logged = said.filter((l) => l.includes(convoId) && /catch-up/.test(l));
    assert.strictEqual(logged.length, 1, `logged once: ${JSON.stringify(said)}`);
    assert.ok(!('freshCatchUp' in stored(convoId)), 'and dropped');
    h.reapConvo(convoId);
  });
});

describe('a message sent between an init and a refused resume', () => {
  test('is sent once, to the fresh start, after the first', async () => {
    // Claude Code is not known to send its init before refusing a resume, and
    // nothing promises it never will. A refused session ran no turn, so a
    // message written to it after its init was never read.
    const convoId = h.freshConvoId('init-then-refused');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'dead-orch-x1', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-x1' }] });
    scenario([
      { match: { promptIncludes: 'FIRST-X1' }, turn: [{ text: 'ANSWER-FIRST-X1' }] },
      { match: { promptIncludes: 'SECOND-X1' }, turn: [{ text: 'ANSWER-SECOND-X1' }] },
    ], ['dead-orch-x1'], { refusalAfterInit: true, refusalExitMs: 1200 });
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'FIRST-X1 hello', sessionId: 'dead-orch-x1' });
    await client.waitFor((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === convoId && m._sessionId === 'dead-orch-x1',
      { since, label: 'the init, before the refusal', timeout: 15000 });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'SECOND-X1 and this', sessionId: 'dead-orch-x1' });

    await waitForResult(convoId, 'ANSWER-FIRST-X1', since, 'the fresh start answers the first');
    await h.waitUntil(() => prompts().length >= 2, { timeout: 4000 });
    await h.delay(500);
    assert.deepStrictEqual(prompts(), ['FIRST-X1 hello', 'SECOND-X1 and this'],
      'both reach the fresh session, in the order they were sent, each once');
    assert.deepStrictEqual(h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === convoId).map((i) => i.resume),
      ['dead-orch-x1', null], 'one fresh start carries both');
    h.reapConvo(convoId);
  });
});

describe('a stored catch-up stays on the server', () => {
  test('the conversation list a window is sent leaves it out, and the store keeps it', async () => {
    const convoId = h.freshConvoId('held-not-sent');
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionId: null, sessionIds: [],
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      freshCatchUp: { agentId: 'chief-of-staff', text: `${ARRIVING}\nHELD-N1 kept for the next message\n\n` },
    });
    const since = client.messages.length;
    client.send({ type: 'get_conversations' });
    const { msg } = await client.waitFor((m) => m.type === 'conversations', { since, label: 'the conversation list' });
    const listed = msg.conversations.find((c) => c.id === convoId);
    assert.ok(listed, 'the conversation is listed');
    assert.ok(!('freshCatchUp' in listed), 'without the catch-up, which is the server\'s');
    assert.ok(!JSON.stringify(msg).includes('HELD-N1'), 'nor its words anywhere in the list');
    assert.deepStrictEqual(stored(convoId).freshCatchUp,
      { agentId: 'chief-of-staff', text: `${ARRIVING}\nHELD-N1 kept for the next message\n\n` }, 'the store still holds it for the next message');
  });
});

describe('the legacy chat path, one process per message', () => {
  // Chosen by RUNDOCK_LEGACY_SPAWN=1 in the server's environment, read on
  // every chat message: with it set, every message the window sends comes
  // this way, so a stored catch-up has to be given here too.
  async function legacy(fn) {
    process.env.RUNDOCK_LEGACY_SPAWN = '1';
    try { return await fn(); } finally { delete process.env.RUNDOCK_LEGACY_SPAWN; }
  }

  test('gives a stored catch-up to its first message, once', async () => {
    const convoId = h.freshConvoId('held-legacy');
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionId: null, sessionIds: [],
      freshCatchUp: { agentId: 'chief-of-staff', text: `${ARRIVING}\nHELD-L1 what happened while it was away\n\n` },
    });
    scenario([
      { match: { promptIncludes: 'ASK-L1' }, turn: [{ text: 'ANSWER-L1' }] },
      { match: { promptIncludes: 'AGAIN-L1' }, turn: [{ text: 'ANSWER-AGAIN-L1' }] },
    ]);
    h.clearInvocations();
    await legacy(async () => {
      let since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-L1 hello' });
      await waitForResult(convoId, 'ANSWER-L1', since, 'the first message is answered');
      since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'AGAIN-L1 hello' });
      await waitForResult(convoId, 'ANSWER-AGAIN-L1', since, 'and the next');
    });
    assert.strictEqual(prompts().length, 2);
    assert.ok(prompts()[0].includes('HELD-L1') && prompts()[0].endsWith('ASK-L1 hello'), 'the catch-up, then the message');
    assert.strictEqual(prompts()[1], 'AGAIN-L1 hello', 'given once');
    assert.ok(!('freshCatchUp' in stored(convoId)), 'and spent');
    h.reapConvo(convoId);
  });

  test('hands a stored catch-up on from a refused resume to the fresh start, once', async () => {
    const convoId = h.freshConvoId('held-legacy-refused');
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionId: 'dead-orch-l2',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-l2' }],
      freshCatchUp: { agentId: 'chief-of-staff', text: `${ARRIVING}\nHELD-L2 what happened while it was away\n\n` },
    });
    scenario([{ match: { promptIncludes: 'ASK-L2' }, turn: [{ text: 'FRESH-L2' }] }], ['dead-orch-l2']);
    h.clearInvocations();
    await legacy(async () => {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-L2 hello', sessionId: 'dead-orch-l2' });
      await waitForResult(convoId, 'FRESH-L2', since, 'the fresh start answers');
    });
    assert.deepStrictEqual(h.readInvocations().filter((i) => i.env && i.env.RUNDOCK_CONVO_ID === convoId).map((i) => i.resume),
      ['dead-orch-l2', null], 'refused once, then started fresh');
    assert.strictEqual(prompts().length, 1, 'the refused process read nothing');
    assert.ok(prompts()[0].includes('HELD-L2') && prompts()[0].endsWith('ASK-L2 hello'), 'the fresh start is given it');
    assert.ok(!('freshCatchUp' in stored(convoId)), 'and it is spent');
    h.reapConvo(convoId);
  });
});
