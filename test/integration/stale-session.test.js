'use strict';
// A CONVERSATION WHOSE STORED SESSION CLAUDE CODE NO LONGER HAS.
//
// Claude Code removes old session files on its own schedule. A conversation
// stores the ids it resumes, so one can outlive its file, and every resume of
// it then fails with "No conversation found with session ID". The direct chat
// recovered from that already. A delegation did not: it read the agent's last
// stored id, resumed it, was refused, took the refusal for an ordinary exit,
// parked the orchestrator in silence, and left the id where it was for the
// next delegation to resume. Three attempts, three identical raw errors, and a
// conversation nothing could get past. A handback to the orchestrator failed
// the same way.
//
// Driven through the real server against the stub runtime, which refuses a
// resume of any id a scenario names in `deadSessions` exactly as Claude Code
// does: one line on stderr, exit 1, before it reads anything. The window is
// played by the real reducer and the real stored-session rules from
// public/conversation-state.js, so what it saves back and what it resumes next
// are the window's own decisions, not the test's.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { createState, reduce, forgetSession, resumeSessionFor } = require('../../public/conversation-state.js');
const { REFUSAL, STARTING_FRESH } = require('../../lib/runtime/missing-session.js');

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

/** The stub's script, with the sessions Claude Code no longer has. */
function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }, null, 2));
}

function stored(convoId) {
  return h.internal.readConversations().find(c => c.id === convoId) || null;
}

/** Every session id a stored record still holds, primary and chain. */
function idsIn(record) {
  if (!record) return [];
  return [record.sessionId, ...(record.sessionIds || []).map(s => s.sessionId)].filter(Boolean);
}

function spawnsFor(convoId) {
  return h.readInvocations().filter(i => i.env && i.env.RUNDOCK_CONVO_ID === convoId);
}

function messagesFor(convoId, since = 0) {
  return client.messages.slice(since).filter(m => m._conversationId === convoId);
}

/** Nothing a person was shown carries Claude Code's raw refusal. */
function assertNoRawRefusal(convoId, since = 0) {
  const raw = messagesFor(convoId, since).filter(m => JSON.stringify(m).includes(REFUSAL) && m.type !== 'stream_event');
  assert.deepStrictEqual(raw.map(m => `${m.type}/${m.subtype || ''}`), [],
    'the raw refusal reached the window, which a person reads as an error with no way forward');
}

/** A turn that WAS started again is never also reported as one that was not. */
function assertNotTold(convoId, since = 0) {
  const said = messagesFor(convoId, since).filter(m => m.subtype === 'notice' && /no longer available/.test(m.content || ''));
  assert.deepStrictEqual(said.map(m => m.content), [], 'a fresh start reported as a failure contradicts the pill beside it');
}

/**
 * What the open window holds for one conversation, driven by the real reducer
 * and the real stored-session rules. The three effect executors mirror
 * public/app.js line for line; each ends in the save the window sends.
 */
function windowFor(record) {
  const convo = JSON.parse(JSON.stringify(record));
  let state = Object.assign(createState(), { activeAgentId: record.activeAgentId || null });
  let seen = 0;
  const save = () => client.send({ type: 'save_conversation', conversation: {
    id: convo.id, agentId: convo.agentId, activeAgentId: state.activeAgentId || null,
    sessionId: convo.sessionId || null, sessionIds: convo.sessionIds || [], title: convo.title, status: 'active',
  } });
  const ctxFor = (m) => (m.subtype === 'init'
    ? { convoExists: true, convoAgentId: convo.agentId, hasPrimarySession: !!convo.sessionId,
      knownSessionIds: (convo.sessionIds || []).map(s => s.sessionId) }
    : { hasPrimarySession: !!convo.sessionId, convoAgentId: convo.agentId, toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true });
  const run = (effects) => {
    for (const ef of effects) {
      if (ef.type === 'set-session') {
        if (ef.setPrimary) convo.sessionId = ef.sessionId;
        if (!convo.sessionIds) convo.sessionIds = [];
        if (ef.addToChain) convo.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
        save();
      } else if (ef.type === 'clear-session') {
        convo.sessionId = null;
        save();
      } else if (ef.type === 'forget-session') {
        if (forgetSession(convo, ef.sessionId)) save();
      }
    }
  };
  return {
    convo,
    get activeAgentId() { return state.activeAgentId || convo.agentId; },
    /** Read every message that has arrived for this conversation, in order. */
    sync() {
      for (; seen < client.messages.length; seen++) {
        const m = client.messages[seen];
        if (m._conversationId !== convo.id || m.type !== 'system') continue;
        if (!['init', 'info', 'session_expired', 'agent_switch'].includes(m.subtype)) continue;
        if (m.subtype === 'init' && !m._sessionId) continue;
        const r = reduce(state, m, ctxFor(m));
        state = r.state;
        run(r.effects);
      }
    },
    /** A message the person sends, resumed exactly as the window would resume it. */
    send(content) {
      this.sync();
      const agent = this.activeAgentId;
      const sessionId = resumeSessionFor(convo, agent);
      client.send({ type: 'chat', conversationId: convo.id, agent, content, ...(sessionId ? { sessionId } : {}) });
      return { agent, sessionId };
    },
  };
}

/** Wait until the server has read every save sent so far: the socket is ordered. */
async function settled() {
  const since = client.messages.length;
  client.send({ type: 'get_lists' });
  await client.waitFor(m => m.type === 'lists', { since, label: 'saves read' });
}

function seed(convoId, record) {
  const all = h.internal.readConversations().filter(c => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', ...record }, ...all]);
  return stored(convoId);
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor(m => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label: label || `result ${text}`, timeout: 15000 });
}

describe('delegating to an agent whose stored session is gone', () => {
  test('starts that agent fresh, briefed as an arrival, says so in plain words, and forgets the dead id', async () => {
    const convoId = h.freshConvoId('stale-delegate');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-a',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-a' }, { agentId: 'content-lead', sessionId: 'dead-lead-a' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'DRAFT-REQUEST-A' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Handing this to the lead.', prompt: 'BRIEF-ONE write it' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' }, turn: [{ text: 'LEAD-FRESH-REPLY-A' }] },
    ], ['dead-lead-a']);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('DRAFT-REQUEST-A please');

    await waitForResult(convoId, 'LEAD-FRESH-REPLY-A', since, 'the delegate answers from a fresh session');

    const lead = spawnsFor(convoId).filter(i => i.agent === 'content-lead');
    assert.deepStrictEqual(lead.map(i => i.resume), ['dead-lead-a', null],
      'the dead id is tried once and the delegate starts again without it');
    assert.ok(lead[1].argv.includes('--agent'), 'started fresh as that agent, not as a bare session');

    const prompt = h.promptsFor('content-lead').pop();
    assert.match(prompt, /BRIEF-ONE/, 'the brief still arrives');
    assert.match(prompt, /BEFORE YOU JOINED/, 'and it is briefed as an arrival, with the conversation so far');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'), 'a fresh session has no last turn to be since');

    const info = messagesFor(convoId, since).find(m => m.type === 'system' && m.subtype === 'info');
    assert.strictEqual(info.content, STARTING_FRESH, 'the person is told, in words');
    assert.strictEqual(info.expiredSessionId, 'dead-lead-a', 'naming the session the window must forget');
    assertNoRawRefusal(convoId, since);
    assertNotTold(convoId, since);

    assert.ok(!idsIn(stored(convoId)).includes('dead-lead-a'), 'the dead id is gone from what the conversation stores');
    assert.ok(messagesFor(convoId, since).some(m => m.subtype === 'session_expired' && m.sessionId === 'dead-lead-a'),
      'and every open window is told to forget it');
    h.reapConvo(convoId);
  });

  test('the next delegation resumes the fresh session, after a handback from it, and nothing is refused again', async () => {
    const convoId = h.freshConvoId('stale-next');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-b',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-b' }, { agentId: 'content-lead', sessionId: 'dead-lead-b' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'FIRST-REQUEST-B', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to the lead.', prompt: 'BRIEF-ONE draft' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' },
        turn: [{ text: 'LEAD-DRAFT-B is done. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'pipeline-complete' }, turn: [{ text: '<silent>' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'SECOND-REQUEST-B' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Back to the lead.', prompt: 'BRIEF-TWO tighten it' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-TWO' }, turn: [{ text: 'LEAD-RESUMED-B' }] },
    ], ['dead-lead-b']);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    win.send('FIRST-REQUEST-B please');
    await waitForResult(convoId, 'LEAD-DRAFT-B', since, 'the recovered delegate answers');

    // THE HANDBACK FROM THE RECOVERED AGENT: its COMPLETE restores the
    // orchestrator by its own live session, carrying what the lead delivered.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId
      && m.toAgent === 'chief-of-staff', { since, label: 'handback to the orchestrator', timeout: 15000 });
    await h.waitUntil(() => h.promptsFor('chief-of-staff').some(p => p.includes('pipeline-complete')));
    const handback = h.promptsFor('chief-of-staff').find(p => p.includes('pipeline-complete'));
    assert.match(handback, /LEAD-DRAFT-B/, 'the handback carries the recovered delegate\'s work');
    const orch = spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff');
    assert.strictEqual(orch[orch.length - 1].resume, 'live-orch-b', 'and the orchestrator keeps its own session');

    // The window has recorded the lead's fresh session, as the real one does.
    win.sync();
    await settled();
    const freshLead = resumeSessionFor(win.convo, 'content-lead');
    assert.ok(freshLead && freshLead !== 'dead-lead-b', 'the window holds the lead\'s fresh session');
    assert.ok(!idsIn(stored(convoId)).includes('dead-lead-b'), 'and the saves it sent did not put the dead id back');

    // THE MOST COMMON NEXT STEP: delegating to the recovered agent again.
    since = client.messages.length;
    win.send('SECOND-REQUEST-B now');
    await waitForResult(convoId, 'LEAD-RESUMED-B', since, 'the second delegation answers');
    const lead = spawnsFor(convoId).filter(i => i.agent === 'content-lead');
    assert.deepStrictEqual(lead.map(i => i.resume), ['dead-lead-b', null, freshLead],
      'the second delegation resumes the fresh session, never the dead one');
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info' || m.subtype === 'session_expired'),
      'and nothing is refused, so nothing needs saying');
    assertNoRawRefusal(convoId);
    h.reapConvo(convoId);
  });

  test('a fresh start that also fails leaves the next delegation starting cold, not resuming the dead id', async () => {
    const convoId = h.freshConvoId('stale-twice');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-c',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-c' }, { agentId: 'content-lead', sessionId: 'dead-lead-c' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TRY-ONE-C', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to the lead.', prompt: 'BRIEF-ONE go' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' }, crash: 1, stderr: 'Something else went wrong\n' },
      { match: { agent: 'chief-of-staff', promptIncludes: 'pipeline-complete' }, turn: [{ text: '<silent>' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'TRY-TWO-C' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to the lead again.', prompt: 'BRIEF-TWO go' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-TWO' }, turn: [{ text: 'LEAD-COLD-C' }] },
    ], ['dead-lead-c']);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    win.send('TRY-ONE-C please');
    await client.waitFor(m => m.type === 'error' && m._conversationId === convoId && /Something else went wrong/.test(m.content),
      { since, label: 'the fresh start fails for another reason, which is said as itself', timeout: 15000 });
    await h.waitUntil(() => h.promptsFor('chief-of-staff').some(p => p.includes('pipeline-complete')));
    win.sync();
    await settled();

    since = client.messages.length;
    win.send('TRY-TWO-C again');
    await waitForResult(convoId, 'LEAD-COLD-C', since, 'the retry answers');
    const lead = spawnsFor(convoId).filter(i => i.agent === 'content-lead');
    assert.deepStrictEqual(lead.map(i => i.resume), ['dead-lead-c', null, null],
      'after a failed recovery the next delegation starts cold; the dead id is never tried again');
    assertNoRawRefusal(convoId);
    h.reapConvo(convoId);
  });
});

describe('a message sent while a refused delegate is still starting', () => {
  test('follows the brief into the fresh delegate, in order, each once', async () => {
    const convoId = h.freshConvoId('stale-delegate-follow');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-q',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-q' }, { agentId: 'content-lead', sessionId: 'dead-lead-q' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-Q', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'To the lead.', prompt: 'BRIEF-ONE q' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' }, turn: [{ text: 'LEAD-BRIEFED-Q' }] },
      { match: { agent: 'content-lead', promptIncludes: 'FOLLOW-Q' }, turn: [{ text: 'LEAD-FOLLOWED-Q' }] },
    ], ['dead-lead-q'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-Q please');
    await client.waitFor(m => m.subtype === 'session_expired' && m._conversationId === convoId,
      { since, label: 'the delegate is refused and still lingering', timeout: 15000 });
    const sent = win.send('FOLLOW-Q one more thing');
    assert.strictEqual(sent.agent, 'content-lead', 'addressed to the delegate the window now shows');

    await waitForResult(convoId, 'LEAD-FOLLOWED-Q', since, 'the follow-up is answered');
    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'content-lead').map(i => i.resume), ['dead-lead-q', null]);
    const prompts = h.promptsFor('content-lead');
    assert.strictEqual(prompts.length, 2, 'the brief and the follow-up, each once');
    assert.match(prompts[0], /BRIEF-ONE q/, 'the brief first');
    assert.strictEqual(prompts[1], 'FOLLOW-Q one more thing', 'then what the person sent');
    assertNoRawRefusal(convoId, since);
    h.reapConvo(convoId);
  });
});

describe('handing back to an orchestrator whose stored session is gone', () => {
  test('the orchestrator starts fresh with the handback, so the request is routed instead of lost', async () => {
    const convoId = h.freshConvoId('stale-handback');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-d',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-d' }, { agentId: 'content-lead', sessionId: 'live-lead-d' }],
    });
    // The orchestrator spoke before the lead took over, so a resume would have
    // been told what it missed since then. A fresh session must not be.
    h.internal.convoTranscripts.set(convoId, [
      { role: 'user', agent: 'user', text: 'plan the trip' },
      { role: 'agent', agent: 'chief-of-staff', text: 'ORCH-EARLIER-D: the lead will take this' },
      { role: 'agent', agent: 'content-lead', text: 'LEAD-BETWEEN-D: on it' },
    ]);
    h.internal.saveTranscript(convoId);
    scenario([
      { match: { resume: true, promptIncludes: 'FLIGHT-D' }, turn: [{ text: 'Not mine to do. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'ORCH-ROUTED-D' }] },
    ], ['dead-orch-d']);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    const sent = win.send('book me a FLIGHT-D');
    assert.strictEqual(sent.sessionId, 'live-lead-d', 'the specialist itself resumes its own live session');

    await waitForResult(convoId, 'ORCH-ROUTED-D', since, 'the orchestrator routes the request');
    const orch = spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff');
    assert.deepStrictEqual(orch.map(i => i.resume), ['dead-orch-d', null]);
    const prompt = h.promptsFor('chief-of-staff').pop();
    assert.match(prompt, /FLIGHT-D/, 'the pending request reaches the fresh orchestrator');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'), 'with no claim about a last turn it never had');
    const info = messagesFor(convoId, since).find(m => m.subtype === 'info');
    assert.strictEqual(info && info.expiredSessionId, 'dead-orch-d');
    assertNoRawRefusal(convoId, since);
    assertNotTold(convoId, since);
    assert.ok(!idsIn(stored(convoId)).includes('dead-orch-d'), 'the dead id is gone from what is stored');
    h.reapConvo(convoId);
  });

  test('a follow-up held back during the handoff reaches the fresh orchestrator, not the refused one', async () => {
    // The kill window is seeded as kill-window.test.js seeds it, so the
    // follow-up is reliably held back and replayed into the orchestrator the
    // moment it is spawned, which is the process about to be refused.
    const convoId = h.freshConvoId('stale-buffered');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-o',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-o' }, { agentId: 'content-lead', sessionId: 'live-lead-o' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TASK-O' }, turn: [{ text: 'Not my lane. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'ROUTING-FIRED-O' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'FOLLOW-O' }, turn: [{ text: 'FOLLOW-ANSWER-O' }] },
    ], ['dead-orch-o']);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('do TASK-O');
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead',
      { since, label: 'the specialist hands back', timeout: 15000 });
    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && entry.scopeReturn, 'the specialist is in its auto-return window');
    h.internal.convoTransitions.set(convoId, { state: 'killing', owner: entry, queued: [], failsafe: setTimeout(() => {}, 30000) });
    win.send('FOLLOW-O and also this');

    await waitForResult(convoId, 'FOLLOW-ANSWER-O', since, 'the fresh orchestrator answers the follow-up');
    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff').map(i => i.resume), ['dead-orch-o', null]);
    assert.deepStrictEqual(h.promptsFor('chief-of-staff'), ['FOLLOW-O and also this'],
      'the follow-up superseded the routing prompt, as it does on a resume, and arrived exactly once');
    assert.ok(!messagesFor(convoId, since).some(m => m.type === 'result' && /ROUTING-FIRED-O/.test(m.result || '')));
    assertNoRawRefusal(convoId, since);
    h.reapConvo(convoId);
  });

  test('a message sent while the refused orchestrator is still starting follows the handback into the fresh one', async () => {
    const convoId = h.freshConvoId('stale-unbuffered');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-p',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-p' }, { agentId: 'content-lead', sessionId: 'live-lead-p' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TASK-P' }, turn: [{ text: 'Not my lane. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'ROUTED-P' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'FOLLOW-P' }, turn: [{ text: 'FOLLOW-ANSWER-P' }] },
    ], ['dead-orch-p'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('do TASK-P');
    await client.waitFor(m => m.subtype === 'session_expired' && m._conversationId === convoId && m.sessionId === 'dead-orch-p',
      { since, label: 'the orchestrator is refused and still lingering', timeout: 15000 });
    win.send('FOLLOW-P meanwhile');

    await waitForResult(convoId, 'FOLLOW-ANSWER-P', since, 'the follow-up is answered');
    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff').map(i => i.resume), ['dead-orch-p', null]);
    const prompts = h.promptsFor('chief-of-staff');
    assert.strictEqual(prompts.length, 2, 'the handback and the follow-up, each once');
    assert.match(prompts[0], /routing-request/, 'the handback first');
    assert.strictEqual(prompts[1], 'FOLLOW-P meanwhile', 'then what the person sent while it was starting');
    assertNoRawRefusal(convoId, since);
    h.reapConvo(convoId);
  });
});

describe('talking straight to an agent whose stored session is gone', () => {
  test('forgets exactly that session: the orchestrator\'s live primary survives, and the window says why', async () => {
    const convoId = h.freshConvoId('stale-direct');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'live-orch-e',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-e' }, { agentId: 'content-lead', sessionId: 'dead-lead-e' }],
    });
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'FIRST-E' }, turn: [{ text: 'LEAD-FRESH-E' }] },
      { match: { promptIncludes: 'SECOND-E' }, turn: [{ text: 'LEAD-AGAIN-E' }] },
      { match: { promptIncludes: 'THIRD-E' }, turn: [{ text: 'LEAD-RESUMED-E' }] },
    ], ['dead-lead-e']);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    assert.strictEqual(win.send('FIRST-E hello').sessionId, 'dead-lead-e', 'the window starts out holding the dead id');
    await waitForResult(convoId, 'LEAD-FRESH-E', since);

    const info = messagesFor(convoId, since).find(m => m.subtype === 'info');
    assert.strictEqual(info.content, STARTING_FRESH);
    assert.strictEqual(info.expiredSessionId, 'dead-lead-e');
    assertNoRawRefusal(convoId, since);
    assertNotTold(convoId, since);
    win.sync();
    await settled();
    assert.strictEqual(win.convo.sessionId, 'live-orch-e',
      'the orchestrator\'s session is untouched: clearing the primary for a delegate\'s expiry threw away a live one');
    const freshLead = resumeSessionFor(win.convo, 'content-lead');
    assert.ok(freshLead && freshLead !== 'dead-lead-e', 'the lead resumes its fresh session from now on');
    assert.deepStrictEqual(idsIn(stored(convoId)).sort(), ['live-orch-e', 'live-orch-e', freshLead].sort(),
      'and that is all the conversation stores');

    // THE RETRY: a second message after recovery goes to the live fresh process.
    since = client.messages.length;
    assert.strictEqual(win.send('SECOND-E more').sessionId, freshLead);
    await waitForResult(convoId, 'LEAD-AGAIN-E', since);

    // And once that process is gone, the next message resumes the fresh id.
    h.reapConvo(convoId);
    since = client.messages.length;
    win.send('THIRD-E later');
    await waitForResult(convoId, 'LEAD-RESUMED-E', since);
    const lead = spawnsFor(convoId).map(i => i.resume);
    assert.deepStrictEqual(lead, ['dead-lead-e', null, freshLead], 'the dead id was tried exactly once');
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info'), 'and nothing expired the second time');
    h.reapConvo(convoId);
  });

  test('after a fresh start that also fails, the next message starts fresh as that agent, not as another agent\'s session', async () => {
    const convoId = h.freshConvoId('stale-direct-twice');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'live-orch-f',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-f' }, { agentId: 'content-lead', sessionId: 'dead-lead-f' }],
    });
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'FIRST-F' }, crash: 1, stderr: 'Something else went wrong\n' },
      { match: { agent: 'content-lead', promptIncludes: 'SECOND-F' }, turn: [{ text: 'LEAD-FRESH-F' }] },
    ], ['dead-lead-f']);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    win.send('FIRST-F hello');
    await client.waitForEvent('system', 'done', convoId, { since, label: 'the failed fresh start ends the turn', timeout: 15000 });
    await h.waitUntil(() => spawnsFor(convoId).length === 2);
    win.sync();
    await settled();

    since = client.messages.length;
    const sent = win.send('SECOND-F again');
    assert.strictEqual(sent.sessionId, null,
      'the lead has no session of its own left, so it starts fresh rather than resuming the orchestrator\'s');
    await waitForResult(convoId, 'LEAD-FRESH-F', since);
    const last = spawnsFor(convoId).pop();
    assert.strictEqual(last.resume, null);
    assert.strictEqual(last.agent, 'content-lead', 'and it starts as the lead');
    assertNoRawRefusal(convoId);
    h.reapConvo(convoId);
  });

  test('the legacy spawn names the expired session too', async () => {
    const convoId = h.freshConvoId('stale-legacy');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'dead-orch-g', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-g' }] });
    scenario([{ match: { promptIncludes: 'LEGACY-G' }, turn: [{ text: 'LEGACY-FRESH-G' }] }], ['dead-orch-g']);
    process.env.RUNDOCK_LEGACY_SPAWN = '1';
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'LEGACY-G hi', sessionId: 'dead-orch-g' });
      await waitForResult(convoId, 'LEGACY-FRESH-G', since);
      const info = messagesFor(convoId, since).find(m => m.subtype === 'info');
      assert.strictEqual(info.expiredSessionId, 'dead-orch-g');
      assertNoRawRefusal(convoId, since);
      assertNotTold(convoId, since);
      assert.deepStrictEqual(idsIn(stored(convoId)), []);
    } finally {
      delete process.env.RUNDOCK_LEGACY_SPAWN;
    }
  });

  test('a second message sent while the refused resume is still starting is answered after the first', async () => {
    const convoId = h.freshConvoId('stale-direct-follow');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'live-orch-s',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-s' }, { agentId: 'content-lead', sessionId: 'dead-lead-s' }],
    });
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'FIRST-S' }, turn: [{ text: 'LEAD-FIRST-S' }] },
      { match: { agent: 'content-lead', promptIncludes: 'SECOND-S' }, turn: [{ text: 'LEAD-SECOND-S' }] },
    ], ['dead-lead-s'], { refusalExitMs: 1200 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('FIRST-S hello');
    await client.waitFor(m => m.subtype === 'session_expired' && m._conversationId === convoId,
      { since, label: 'the resume is refused and still lingering', timeout: 15000 });
    win.send('SECOND-S and this');

    await waitForResult(convoId, 'LEAD-SECOND-S', since, 'the second message is answered');
    assert.deepStrictEqual(h.promptsFor('content-lead'), ['FIRST-S hello', 'SECOND-S and this'],
      'both reach the fresh session, in the order they were sent, each once');
    assert.deepStrictEqual(spawnsFor(convoId).map(i => i.resume), ['dead-lead-s', null], 'one fresh start carries both');
    assertNoRawRefusal(convoId, since);
    h.reapConvo(convoId);
  });
});

describe('a resume that cannot be started again here', () => {
  test('says what happened and what to do, in plain words, and still forgets the id', async () => {
    const convoId = h.freshConvoId('stale-unrecoverable');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'dead-orch-h', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-h' }] });
    scenario([], ['dead-orch-h']);
    // The loop guard's respawn: an orchestrator killed by an intercepted call
    // is brought back idle by its own id, with no prompt to start again with.
    h.internal.chatProcesses.set(convoId, {
      agentId: 'chief-of-staff', processId: 'p-gone', exited: true, scopeReturnSource: 'content-lead', toolCalls: [],
    });
    const since = client.messages.length;
    h.internal.handleDelegation({
      conversationId: convoId, targetAgent: 'content-lead', context: 'again', _intercepted: true,
      _parentSessionId: 'dead-orch-h', _parentAgentId: 'chief-of-staff',
    }, h.internal.chatProcesses);

    const { msg } = await client.waitFor(m => m.type === 'system' && m.subtype === 'notice' && m._conversationId === convoId
      && /no longer available/.test(m.content || ''), { since, label: 'the plain notice', timeout: 15000 });
    assert.match(msg.content, /Send your message again to carry on in a fresh session\./, 'it says what to do');
    assertNoRawRefusal(convoId, since);
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info'), 'and does not claim a fresh start it did not make');
    assert.deepStrictEqual(idsIn(stored(convoId)), [], 'the dead id is forgotten all the same');
    h.reapConvo(convoId);
  });
});

describe('the session file coming back', () => {
  test('a stored session Claude Code still has is resumed as it always was, and nothing is forgotten', async () => {
    const convoId = h.freshConvoId('alive');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-i',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-i' }, { agentId: 'content-lead', sessionId: 'back-lead-i' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-I', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'To the lead.', prompt: 'BRIEF-ONE i' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' }, turn: [{ text: 'LEAD-RESUMED-I done. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'pipeline-complete' }, turn: [{ text: '<silent>' }] },
    ], []);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-I please');
    await waitForResult(convoId, 'LEAD-RESUMED-I', since);
    // And it hands back as it always did: an ordinary exit is never mistaken
    // for a refusal and started again.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId
      && m.toAgent === 'chief-of-staff', { since, label: 'the ordinary handback', timeout: 15000 });
    await h.waitUntil(() => h.promptsFor('chief-of-staff').some(p => p.includes('pipeline-complete')));
    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'content-lead').map(i => i.resume), ['back-lead-i']);
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info' || m.subtype === 'session_expired'));
    assert.ok(idsIn(stored(convoId)).includes('back-lead-i'), 'a live session is never forgotten');
    h.reapConvo(convoId);
  });

  test('once recovered, a session that reappears is not taken back: a stale save cannot restore it', async () => {
    const convoId = h.freshConvoId('reappears');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-j',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-j' }, { agentId: 'content-lead', sessionId: 'dead-lead-j' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-J', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'To the lead.', prompt: 'BRIEF-ONE j' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-ONE' }, turn: [{ text: 'LEAD-FRESH-J' }] },
    ], ['dead-lead-j']);
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-J please');
    await waitForResult(convoId, 'LEAD-FRESH-J', since);

    // The file comes back, and a second window that never heard saves the
    // record it loaded before any of this happened.
    scenario([], []);
    client.send({ type: 'save_conversation', conversation: { ...record, status: 'active' } });
    await settled();
    const after = stored(convoId);
    assert.ok(!idsIn(after).includes('dead-lead-j'),
      'the id Claude Code refused is not written back, so no delegation can be handed it again');
    assert.strictEqual(after.sessionId, 'live-orch-j', 'and everything else in that save is kept');

    // Nor as the primary, which is what the conversation's own agent resumes.
    client.send({ type: 'save_conversation', conversation: { ...record, status: 'active', sessionId: 'dead-lead-j' } });
    await settled();
    assert.strictEqual(stored(convoId).sessionId, null, 'a refused id is not taken back as the primary either');
    h.reapConvo(convoId);
  });
});

describe('a refused resume the person stopped', () => {
  test('is not started again, and nothing claims it was or was not', async () => {
    const convoId = h.freshConvoId('stale-cancel');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-k',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-k' }, { agentId: 'content-lead', sessionId: 'dead-lead-k' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-K', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'To the lead.', prompt: 'BRIEF-ONE k' } }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'SHOULD-NOT-RUN-K' }] },
    ], ['dead-lead-k'], { refusalExitMs: 1500 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-K please');
    await client.waitFor(m => m.subtype === 'session_expired' && m._conversationId === convoId,
      { since, label: 'the refusal is seen while the process still lingers', timeout: 15000 });
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since, label: 'stopped' });
    // Past the refused process's own exit, and any fresh start it could have made.
    await h.delay(2500);

    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'content-lead').map(i => i.resume), ['dead-lead-k'],
      'a stopped turn is never started again behind the person\'s back');
    assert.ok(!messagesFor(convoId, since).some(m => m.type === 'result' && /SHOULD-NOT-RUN-K/.test(m.result || '')));
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info'), 'no fresh start is announced');
    assertNotTold(convoId, since);
    assertNoRawRefusal(convoId, since);
    assert.ok(!idsIn(stored(convoId)).includes('dead-lead-k'), 'the dead id is still forgotten');
    h.reapConvo(convoId);
  });

  test('a handback the person stopped does not start the orchestrator again either', async () => {
    const convoId = h.freshConvoId('stale-cancel-handback');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-l',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-l' }, { agentId: 'content-lead', sessionId: 'live-lead-l' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TRAIN-L' }, turn: [{ text: 'Not mine to do. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'SHOULD-NOT-ROUTE-L' }] },
    ], ['dead-orch-l'], { refusalExitMs: 1500 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('book me a TRAIN-L');
    await client.waitFor(m => m.subtype === 'session_expired' && m._conversationId === convoId && m.sessionId === 'dead-orch-l',
      { since, label: 'the orchestrator\'s refusal is seen while it lingers', timeout: 15000 });
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since, label: 'stopped' });
    await h.delay(2500);

    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff').map(i => i.resume), ['dead-orch-l'],
      'the stopped handback is never started again');
    assert.ok(!messagesFor(convoId, since).some(m => m.type === 'result' && /SHOULD-NOT-ROUTE-L/.test(m.result || '')));
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info'), 'no fresh start is announced');
    assertNotTold(convoId, since);
    h.reapConvo(convoId);
  });
});
