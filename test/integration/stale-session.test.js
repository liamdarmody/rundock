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
const { REFUSAL, startingFresh } = require('../../lib/runtime/missing-session.js');

/** The name the team uses for an agent, which is what a person is told. */
function nameOf(agentId) {
  const a = h.internal.discoverAgents().find(x => x.id === agentId);
  return (a && (a.displayName || a.name)) || agentId;
}

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
 * and the real stored-session rules. The two effect executors mirror
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
      } else if (ef.type === 'forget-session') {
        if (forgetSession(convo, ef.sessionId)) save();
      }
    }
  };
  return {
    convo,
    get activeAgentId() { return state.activeAgentId || convo.agentId; },
    /** Read the messages that have arrived for this conversation, in order, up to `until`. */
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
    assert.strictEqual(info.content, startingFresh(nameOf('content-lead')), 'the person is told, in words, whose');
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
    assert.match(prompts[0], /ASK-Q please/, 'holding the conversation as it stood when the delegation began');
    assert.ok(!prompts[0].includes('FOLLOW-Q'),
      'and not the follow-up, which arrives on its own: in the brief as well, the delegate read it twice');
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
    // The orchestrator spoke before the lead took over. A resume would have
    // been told what it missed since then; a fresh session has no "since", and
    // is given the conversation as an arrival instead.
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
    assert.match(prompt, /routing-request/, 'the fresh orchestrator is given the handback');
    assert.match(prompt, /FLIGHT-D/, 'the pending request reaches the fresh orchestrator');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'), 'with no claim about a last turn it never had');
    assert.match(prompt, /BEFORE YOU JOINED/, 'and the conversation as an arrival');
    assert.match(prompt, /plan the trip/, 'the original request, which the handback alone does not carry');
    assert.match(prompt, /ORCH-EARLIER-D/, 'and what it had said itself, which a fresh session cannot remember');
    assert.ok(!prompt.includes('LEAD-BETWEEN-D'), 'without the returning specialist, whose message the handback carries');
    const info = messagesFor(convoId, since).find(m => m.subtype === 'info');
    assert.strictEqual(info && info.expiredSessionId, 'dead-orch-d');
    assert.strictEqual(info.content, startingFresh(nameOf('chief-of-staff')));
    assertNoRawRefusal(convoId, since);
    assertNotTold(convoId, since);
    assert.ok(!idsIn(stored(convoId)).includes('dead-orch-d'), 'the dead id is gone from what is stored');
    h.reapConvo(convoId);
  });

  test('in continue mode too, the fresh orchestrator is told the request it never saw', async () => {
    // A CONTINUE handback carries the specialist's output and no pending
    // request, so without the conversation a fresh orchestrator had nothing to
    // say what the work was for.
    const convoId = h.freshConvoId('stale-continue');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-r',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-r' }, { agentId: 'content-lead', sessionId: 'live-lead-r' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ORIGINAL-ASK-R' }, turn: [{ text: 'Draft done; it needs a picture next. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'work-continues' }, turn: [{ text: 'ORCH-CONTINUES-R' }] },
    ], ['dead-orch-r']);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('write the ORIGINAL-ASK-R post');
    await waitForResult(convoId, 'ORCH-CONTINUES-R', since, 'the fresh orchestrator carries on');
    assert.deepStrictEqual(spawnsFor(convoId).filter(i => i.agent === 'chief-of-staff').map(i => i.resume), ['dead-orch-r', null]);
    const prompt = h.promptsFor('chief-of-staff').pop();
    assert.match(prompt, /work-continues/);
    assert.match(prompt, /BEFORE YOU JOINED/);
    assert.match(prompt, /ORIGINAL-ASK-R/, 'the request the work was for');
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'));
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
    const prompts = h.promptsFor('chief-of-staff');
    assert.strictEqual(prompts.length, 1,
      'the follow-up superseded the routing prompt, as it does on a resume, and arrived exactly once');
    assert.ok(prompts[0].endsWith('FOLLOW-O and also this'), 'the person\'s own words, as sent, last');
    // A FRESH SESSION THAT KNOWS NOTHING is not left to answer it blind: with
    // no handback prompt of its own, the follow-up carries the catch-up.
    assert.match(prompts[0], /BEFORE YOU JOINED/, 'the conversation, as an arrival');
    assert.match(prompts[0], /do TASK-O/, 'with the request the specialist was working on');
    assert.match(prompts[0], /Not my lane\./, 'and what the specialist handed back');
    assert.ok(!prompts[0].includes('routing-request'), 'and still no routing prompt');
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
    assert.ok(!prompts[0].includes('FOLLOW-P'), 'holding the conversation as it stood at the handback, not the follow-up');
    assert.strictEqual(prompts[1], 'FOLLOW-P meanwhile', 'then what the person sent while it was starting');
    assertNoRawRefusal(convoId, since);
    h.reapConvo(convoId);
  });

  test('a handback paused by the circuit breaker gives the next message the catch-up instead', async () => {
    // Paused, the handback writes no prompt, so the fresh orchestrator has
    // nothing to start from. The person's next message, sent after the pause
    // and after the fresh start, is what it is first told, so it carries the
    // conversation and the specialist's output in front of it.
    const convoId = h.freshConvoId('stale-breaker');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-y',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-y' }, { agentId: 'content-lead', sessionId: 'live-lead-y' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TASK-Y' }, turn: [{ text: 'Not mine, handing back. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-Y' }, turn: [{ text: 'ORCH-NEXT-Y' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'AFTER-Y' }, turn: [{ text: 'ORCH-AFTER-Y' }] },
    ], ['dead-orch-y']);
    h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    win.send('do TASK-Y');
    await client.waitFor(m => m.type === 'assistant' && m._conversationId === convoId && /Auto-paused/.test(JSON.stringify(m)),
      { since, label: 'the circuit breaker pauses the handback', timeout: 15000 });
    await client.waitFor(m => m.subtype === 'info' && m._conversationId === convoId && m.expiredSessionId === 'dead-orch-y',
      { since, label: 'the fresh start', timeout: 15000 });

    since = client.messages.length;
    win.send('NEXT-Y please');
    await waitForResult(convoId, 'ORCH-NEXT-Y', since, 'the next message is answered');
    let prompts = h.promptsFor('chief-of-staff');
    assert.strictEqual(prompts.length, 1);
    assert.match(prompts[0], /BEFORE YOU JOINED/, 'the conversation, as an arrival');
    assert.match(prompts[0], /do TASK-Y/, 'with the request the specialist was working on');
    assert.match(prompts[0], /Not mine, handing back\./, 'and what the specialist handed back');
    assert.ok(prompts[0].endsWith('NEXT-Y please'), 'then the person\'s own words, as sent');

    since = client.messages.length;
    win.send('AFTER-Y too');
    await waitForResult(convoId, 'ORCH-AFTER-Y', since, 'the message after it');
    prompts = h.promptsFor('chief-of-staff');
    assert.strictEqual(prompts[1], 'AFTER-Y too', 'the catch-up is given once, not with every message');
    h.reapConvo(convoId);
  });
});

describe('a live process that fails some other way', () => {
  // Nothing about a crash or a reap after the session has started is a resume
  // that failed. Treated as one, the turn was replayed fresh with the message
  // the process was started with and everything kept for it, so a request that
  // had already run ran again.
  test('a crash after answering re-sends nothing', async () => {
    const convoId = h.freshConvoId('live-crash');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-aa', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-aa' }] });
    scenario([
      { match: { promptIncludes: 'ONE-AA' }, turn: [{ text: 'ANSWER-ONE-AA' }] },
      { match: { promptIncludes: 'TWO-AA' }, turn: [{ text: 'ANSWER-TWO-AA' }] },
      { match: { promptIncludes: 'THREE-AA' }, crash: 1, stderr: 'MCP server "notes" not found\n' },
    ], []);
    h.clearInvocations();
    const since = client.messages.length;
    // The same tick, so TWO is written before the session has started.
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ONE-AA first', sessionId: 'live-orch-aa' });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'TWO-AA second', sessionId: 'live-orch-aa' });
    await waitForResult(convoId, 'ANSWER-TWO-AA', since, 'both are answered');
    const beforeThree = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'THREE-AA third', sessionId: 'live-orch-aa' });
    await client.waitFor(m => m.type === 'error' && m._conversationId === convoId && /not found/.test(m.content || ''),
      { since: beforeThree, label: 'the crash, said as itself', timeout: 15000 });
    await h.waitUntil(() => !h.internal.chatProcesses.has(convoId));
    await h.delay(1500);

    assert.deepStrictEqual(h.readPrompts().map(p => p.prompt), ['ONE-AA first', 'TWO-AA second', 'THREE-AA third'],
      'each message reached Claude Code once');
    assert.strictEqual(spawnsFor(convoId).length, 1, 'nothing was started again');
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'info'), 'and no fresh start was announced');
    h.reapConvo(convoId);
  });

  test('a reap after answering re-sends nothing', async () => {
    const convoId = h.freshConvoId('live-reap');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-bb', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-bb' }] });
    scenario([
      // A warning that happens to say "session", which the wide match reads.
      { match: { promptIncludes: 'ONE-BB' }, stderr: 'note: session cache warmed\n', turn: [{ text: 'ANSWER-ONE-BB' }] },
    ], []);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ONE-BB only', sessionId: 'live-orch-bb' });
    await waitForResult(convoId, 'ANSWER-ONE-BB', since, 'answered');
    await h.waitUntil(() => { const e = h.internal.chatProcesses.get(convoId); return Boolean(e && e.idle); });
    const entry = h.internal.chatProcesses.get(convoId);
    h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
    await h.waitUntil(() => entry.process.exitCode !== null || entry.process.signalCode !== null);
    await h.delay(1500);

    assert.deepStrictEqual(h.readPrompts().map(p => p.prompt), ['ONE-BB only'], 'the answered message is not sent again');
    assert.strictEqual(spawnsFor(convoId).length, 1, 'nothing was started again');
    h.reapConvo(convoId);
  });

  test('the legacy spawn does not replay a turn that answered and then failed', async () => {
    const convoId = h.freshConvoId('live-legacy');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-cc', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-cc' }] });
    scenario([
      { match: { promptIncludes: 'ONE-CC' }, stderr: 'MCP server "notes" not found\n', exitAfterTurn: 1, turn: [{ text: 'ANSWER-ONE-CC' }] },
    ], []);
    h.clearInvocations();
    process.env.RUNDOCK_LEGACY_SPAWN = '1';
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ONE-CC only', sessionId: 'live-orch-cc' });
      await waitForResult(convoId, 'ANSWER-ONE-CC', since, 'answered');
      await h.delay(1500);
      assert.strictEqual(spawnsFor(convoId).length, 1, 'nothing was started again');
      assert.deepStrictEqual(h.readPrompts().map(p => p.prompt), ['ONE-CC only']);
    } finally {
      delete process.env.RUNDOCK_LEGACY_SPAWN;
    }
  });

  test('a resume that failed for another reason does not hand on what the failed process may have read', async () => {
    const convoId = h.freshConvoId('other-failure');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'odd-orch-dd', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'odd-orch-dd' }] });
    scenario([
      // Both messages are read, and the process dies before its session starts.
      { match: { resume: true, promptIncludes: 'ASK-DD' }, crash: 1, delayMs: 700, stderr: 'the session store is busy\n' },
      { match: { agent: 'chief-of-staff', promptIncludes: 'ASK-DD' }, turn: [{ text: 'FRESH-DD' }] },
    ], []);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-DD first', sessionId: 'odd-orch-dd' });
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-DD second', sessionId: 'odd-orch-dd' });
    await waitForResult(convoId, 'FRESH-DD', since, 'the retry answers');
    await h.delay(800);
    const fresh = h.readPrompts().filter(p => p.resume == null).map(p => p.prompt);
    assert.deepStrictEqual(fresh, ['ASK-DD first'],
      'only a refusal for a missing session hands on what was kept, because a process refused that way read nothing');
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
    assert.strictEqual(info.content, startingFresh(nameOf('content-lead')));
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
      assert.strictEqual(info.content, startingFresh(nameOf('chief-of-staff')));
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

describe('a refusal that reaches the pipe in pieces', () => {
  test('is still recognized, nothing of it is shown, and it is forgotten once', async () => {
    const convoId = h.freshConvoId('stale-split');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'live-orch-t',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-t' }, { agentId: 'content-lead', sessionId: 'dead-lead-t' }],
    });
    // Cut inside the words themselves, so no single piece holds them whole.
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'ASK-T' }, turn: [{ text: 'LEAD-FRESH-T' }] },
    ], ['dead-lead-t'], { refusalSplitAt: 12 });
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-T hello');
    await waitForResult(convoId, 'LEAD-FRESH-T', since, 'the fresh start answers');
    await h.delay(200);
    assert.deepStrictEqual(messagesFor(convoId, since).filter(m => m.type === 'error').map(m => m.content), [],
      'no piece of the refusal is shown, not even its opening words');
    assert.strictEqual(messagesFor(convoId, since).filter(m => m.subtype === 'session_expired').length, 1,
      'and it is forgotten once, however many pieces follow');
    assert.ok(!idsIn(stored(convoId)).includes('dead-lead-t'));
    h.reapConvo(convoId);
  });

  test('stderr that only began like a refusal is shown whole, once it is clearly something else', async () => {
    const convoId = h.freshConvoId('stale-lookalike');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-u', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-u' }] });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-U' }, crash: 1, stderrChunks: ['No con', 'nection to the service', '\n'] },
    ], []);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ASK-U hi', sessionId: 'live-orch-u' });
    await client.waitForEvent('system', 'done', convoId, { since, label: 'the failed turn ends', timeout: 15000 });
    await h.delay(200);
    assert.strictEqual(messagesFor(convoId, since).filter(m => m.type === 'error').map(m => m.content).join(''),
      'No connection to the service\n', 'held only while it could have been a refusal, then shown whole, once');
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'session_expired'), 'and nothing is forgotten');
    assert.ok(idsIn(stored(convoId)).includes('live-orch-u'));
    h.reapConvo(convoId);
  });

});

describe('an info message that names no session', () => {
  // Info carries a blocked handoff, a failed spawn, and a resume that failed
  // for some other reason. None of them says a session is gone, and each used
  // to clear the window's primary session, a live orchestrator's included.
  // The window reads up to and including the info, and no further: a later
  // init would set a primary again and hide what the info itself did.
  async function primaryAfter(convoId, win, since, pred, label) {
    const { msg, index } = await client.waitFor(m => m._conversationId === convoId && m.type === 'system' && m.subtype === 'info' && pred(m),
      { since, label, timeout: 15000 });
    assert.strictEqual(msg.expiredSessionId, undefined, 'it names no session');
    win.sync(index + 1);
    await settled();
    return { msg, primary: win.convo.sessionId, stored: stored(convoId) };
  }

  test('a blocked handoff leaves the orchestrator\'s session alone', async () => {
    const convoId = h.freshConvoId('info-blocked');
    const record = seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-v', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-v' }] });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-V' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', description: 'To the analyst.', prompt: 'analyse it' } }] },
      { match: { promptIncludes: 'delegation-blocked' }, turn: [{ text: 'Understood, I will route it properly.' }] },
    ], []);
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-V please');
    const seen = await primaryAfter(convoId, win, since, m => /Blocked a handoff/.test(m.content || ''), 'the blocked handoff');
    assert.strictEqual(seen.primary, 'live-orch-v');
    assert.strictEqual(seen.stored.sessionId, 'live-orch-v');
    h.reapConvo(convoId);
  });

  test('a failed spawn of Claude Code leaves the stored session alone', async () => {
    const convoId = h.freshConvoId('info-spawn');
    const record = seed(convoId, { agentId: 'chief-of-staff', sessionId: 'live-orch-w', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-w' }] });
    const win = windowFor(record);
    const since = client.messages.length;
    h.internal.handleChatSpawnError(Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' }), convoId);
    const seen = await primaryAfter(convoId, win, since, m => /Couldn't start Claude Code/.test(m.content || ''), 'the spawn failure');
    assert.strictEqual(seen.primary, 'live-orch-w', 'a transient failure to start must not cost the conversation its session');
    assert.strictEqual(seen.stored.sessionId, 'live-orch-w');
  });

  test('a resume that failed for another reason leaves every session alone, the orchestrator\'s included', async () => {
    const convoId = h.freshConvoId('info-other');
    const record = seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'live-orch-x',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-x' }, { agentId: 'content-lead', sessionId: 'odd-lead-x' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'ASK-X' }, crash: 1, stderr: 'the session could not be loaded right now\n' },
      { match: { agent: 'content-lead', promptIncludes: 'ASK-X' }, turn: [{ text: 'LEAD-RETRIED-X' }] },
    ], []);
    const win = windowFor(record);
    const since = client.messages.length;
    win.send('ASK-X please');
    await waitForResult(convoId, 'LEAD-RETRIED-X', since, 'the retry still answers');
    const seen = await primaryAfter(convoId, win, since, () => true, 'the retry notice');
    assert.strictEqual(seen.primary, 'live-orch-x', 'a delegate\'s failure never clears the orchestrator\'s session');
    assert.ok(idsIn(seen.stored).includes('odd-lead-x'), 'and a session nobody said was gone is not forgotten');
    assert.ok(!messagesFor(convoId, since).some(m => m.subtype === 'session_expired'));
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
