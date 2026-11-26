'use strict';
// THE PERSON IS TOLD WHEN AN ARRIVING AGENT IS HANDED A SHORTENED COPY.
//
// An agent brought into a conversation is handed the conversation so far, and
// that catch-up is capped (lib/store/transcripts.js). When the cap cuts it,
// the agent is told in its own prompt, and the person who brought it in used
// to be told nothing: they watched it start work and could not know it had
// only the recent end of the conversation.
//
// Driven, not read. Each test sends what a window sends, or calls the engine
// where the client would, and reads back two things: the messages the window
// receives, and the literal prompt the agent's process was given. The notice
// is never waited for, only counted, so a missing notice fails on a count and
// never on a timeout.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

const ROOT = path.join(__dirname, '..', '..');
const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));
const { CATCH_UP_HEADINGS } = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));
const { startingFresh } = require(path.join(ROOT, 'lib', 'runtime', 'missing-session.js'));

const MARKER = 'EXAMPLE-ALPHA-MARKER';
const LINE = '[If you need something from earlier, ask the person to paste it again or save it as a workspace file.]';
const NOTICE_WORDS = 'was given a shortened copy of this conversation';
const FOR_WREN = 'Wren was given a shortened copy of this conversation, because it is longer than an agent is handed at once. '
  + 'If Wren needs something from earlier, paste it again or save it as a file in the workspace and say where it is.';

/** The notice for an agent with this display name, spelled out here rather than built by the code under test. */
function noticeText(name) {
  return `${name} was given a shortened copy of this conversation, because it is longer than an agent is handed at once. `
    + `If ${name} needs something from earlier, paste it again or save it as a file in the workspace and say where it is.`;
}

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

let client;
before(async () => { await h.boot({ agents: team() }); client = await h.connect(); });
after(async () => h.shutdown());

// ── fixtures ────────────────────────────────────────────────────────────

/** Many ordinary turns, each carrying the marker: older ones are dropped whole and none is cut short. */
function longTalk() {
  const entries = [{ role: 'user', agent: 'user', text: `plan the alpha launch ${MARKER}` }];
  for (let i = 0; i < 40; i++) {
    entries.push({ role: 'agent', agent: i % 2 ? 'content-analyst' : 'lead-designer', text: `alpha note ${i} ${MARKER} ` + 'a'.repeat(900) });
  }
  return entries;
}

/** Forty more turns from the other two agents, for a delta that starts after an agent's own turn. */
function fortyMore(label) {
  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({ role: 'agent', agent: i % 2 ? 'content-analyst' : 'lead-designer', text: `${label} ${i} ${MARKER} ` + 'b'.repeat(900) });
  }
  return entries;
}

/** One pasted turn longer than the cap: it is cut short and nothing is dropped. */
function oneLongPaste() {
  return [{ role: 'user', agent: 'user', text: `${MARKER} ` + 'p'.repeat(DELTA_CAP_CHARS + 1000) }];
}

/** A conversation well inside the cap. */
function shortTalk() {
  return [
    { role: 'user', agent: 'user', text: 'plan the alpha launch' },
    { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Wren.' },
  ];
}

function arrivingDelta(entries, agentId = 'content-lead', exclude = []) {
  return deltaSince(entries, agentId, undefined, exclude, null, true);
}

function returningDelta(entries, agentId = 'content-lead', exclude = []) {
  return deltaSince(entries, agentId, undefined, exclude, null, false);
}

function assertCutBy(d, kind) {
  if (kind === 'truncated') {
    assert.ok(d.text && d.truncated > 0 && d.clipped === 0, `the fixture is cut by dropped turns only: ${JSON.stringify({ truncated: d.truncated, clipped: d.clipped })}`);
  } else if (kind === 'clipped') {
    assert.ok(d.text && d.clipped === 1 && d.truncated === 0, `the fixture is cut by one clipped turn only: ${JSON.stringify({ truncated: d.truncated, clipped: d.clipped })}`);
  } else {
    assert.ok(d.text && (d.truncated > 0 || d.clipped === 1), 'the fixture is cut');
  }
}

function assertUncut(d) {
  assert.ok(d.text && d.truncated === 0 && d.clipped === 0, `the fixture is inside the cap: ${JSON.stringify({ truncated: d.truncated, clipped: d.clipped })}`);
}

// ── helpers ─────────────────────────────────────────────────────────────

/** The name the team uses for an agent, which is what a person is told. */
function nameOf(agentId) {
  const a = h.internal.discoverAgents().find(x => x.id === agentId);
  return (a && (a.displayName || a.name)) || agentId;
}

/** The stub's script, with the sessions Claude Code no longer has. */
function scenario(rules, deadSessions = [], extra = {}) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ ...extra, rules, deadSessions }, null, 2));
}

function stored(convoId) {
  return h.internal.readConversations().find(c => c.id === convoId) || null;
}

function seed(convoId, record) {
  const all = h.internal.readConversations().filter(c => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', ...record }, ...all]);
  return stored(convoId);
}

// A COPY, ALWAYS: the live transcript is the array the server appends to.
function seedTalk(convoId, entries) {
  h.internal.convoTranscripts.set(convoId, entries.map(e => ({ ...e })));
  h.internal.saveTranscript(convoId);
}

/** A live parent for the socket route to delegate away from. */
function parkParent(convoId, processId) {
  h.internal.chatProcesses.set(convoId, { agentId: 'chief-of-staff', processId, exited: false, toolCalls: [] });
}

/** Every process started for this conversation, in order. */
function spawnsFor(convoId) {
  return h.readInvocations().filter(i => i.env && i.env.RUNDOCK_CONVO_ID === convoId);
}

function messagesFor(convoId, since = 0) {
  return client.messages.slice(since).filter(m => m._conversationId === convoId);
}

/** Every shortened-copy notice the window was sent for this conversation. */
function noticesFor(convoId, since = 0) {
  return messagesFor(convoId, since).filter(m => m.type === 'system' && m.subtype === 'notice'
    && String(m.content || '').includes(NOTICE_WORDS));
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor(m => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label: label || `result ${text}`, timeout: 15000 });
}

function count(haystack, needle) { return haystack.split(needle).length - 1; }

/** The notice is the plain line and nothing else: no conversation text, no extra field. */
function assertShape(notice, convoId, content) {
  assert.deepStrictEqual(Object.keys(notice).sort(), ['_conversationId', '_processId', 'content', 'subtype', 'type'],
    'the notice carries no field beyond its kind, its text and where it belongs');
  assert.strictEqual(notice.type, 'system');
  assert.strictEqual(notice.subtype, 'notice');
  assert.strictEqual(notice._conversationId, convoId);
  assert.strictEqual(notice.content, content);
  assert.ok(!JSON.stringify(notice).includes(MARKER), 'no conversation text reaches the notice');
}

/**
 * The notice sits between the arrival's start and its first reply, tied to
 * the same process, and after the expired line where there is one.
 */
function assertPlaced(convoId, since, notice, { agent, autoContinue = false, afterLine = null }) {
  const msgs = messagesFor(convoId, since);
  const at = msgs.indexOf(notice);
  const startedAt = msgs.findIndex(m => m.type === 'system' && m.subtype === 'process_started' && m._agent === agent
    && (!autoContinue || m.autoContinue === true));
  assert.ok(startedAt >= 0, `${agent} was started`);
  assert.ok(at > startedAt, 'the notice follows the arrival\'s start');
  assert.strictEqual(notice._processId, msgs[startedAt]._processId, 'and belongs to the arrival\'s process');
  if (afterLine) {
    const lineAt = msgs.findIndex(afterLine);
    assert.ok(lineAt >= 0, 'the expired line was sent');
    assert.ok(at > lineAt, 'the notice follows the line that says the session expired');
  }
  const replyAt = msgs.findIndex(m => ['stream_event', 'assistant', 'result'].includes(m.type) && m._processId === notice._processId);
  assert.ok(replyAt >= 0, 'the arrival replied');
  assert.ok(at < replyAt, 'the notice comes before the agent\'s first reply');
}

/** The cut catch-up's line, once, directly under the heading. */
function assertLineUnder(prompt, heading) {
  assert.strictEqual(count(prompt, LINE), 1, 'the agent is told once how to get what is missing');
  assert.strictEqual(count(prompt, `${heading}\n${LINE}\n`), 1, 'on its own line directly under the heading');
}

// ── arrivals that raise the notice ───────────────────────────────────────

describe('a Claude Code delegate brought into a long conversation', () => {
  test('through the Agent tool: the person is told once, by name, before it replies', async () => {
    assert.strictEqual(nameOf('content-lead'), 'Wren', 'sanity: the lead is called Wren');
    const convoId = h.freshConvoId('short-agent-tool');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'ALPHA-ASK-A' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Handing this to Wren.', prompt: 'ALPHA-BRIEF-A' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'ALPHA-BRIEF-A' }, turn: [{ text: 'LEAD-REPLY-A' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ALPHA-ASK-A please' });
    await waitForResult(convoId, 'LEAD-REPLY-A', since, 'the delegate answers');

    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for one arrival');
    assertShape(notices[0], convoId, FOR_WREN);
    assertPlaced(convoId, since, notices[0], { agent: 'content-lead' });

    const prompt = h.promptsFor('content-lead').pop();
    assert.match(prompt, /ALPHA-BRIEF-A/, 'the brief still arrives');
    assertLineUnder(prompt, CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });

  test('over the socket, cut by one long paste: told once, and pasting again raises no second notice', async () => {
    const convoId = h.freshConvoId('short-socket-clip');
    const talk = oneLongPaste();
    assertCutBy(arrivingDelta(talk), 'clipped');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-clip');
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'PASTED-AGAIN' }, turn: [{ text: 'LEAD-GOT-IT' }] },
      { match: { agent: 'content-lead', promptIncludes: 'ALPHA-BRIEF-B' }, turn: [{ text: 'LEAD-REPLY-B' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'ALPHA-BRIEF-B' });
    await waitForResult(convoId, 'LEAD-REPLY-B', since, 'the delegate answers');

    let notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for one arrival cut by a clipped turn only');
    assertShape(notices[0], convoId, FOR_WREN);
    assertPlaced(convoId, since, notices[0], { agent: 'content-lead' });
    assertLineUnder(h.promptsFor('content-lead')[0], CATCH_UP_HEADINGS.arriving);

    // The most common next step: the person hands over what was cut.
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: `PASTED-AGAIN ${MARKER} the part from earlier` });
    await waitForResult(convoId, 'LEAD-GOT-IT', next, 'the agent takes the pasted material');
    notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'the person\'s next message raises no second notice');
    h.reapConvo(convoId);
  });

  test('a later delegation that resumes raises none, and one with no session to resume is a new arrival', async () => {
    const convoId = h.freshConvoId('short-again');
    seedTalk(convoId, longTalk());
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-again-1');
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-AGAIN-1' }, turn: [{ text: 'LEAD-AGAIN-1' }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-AGAIN-2' }, turn: [{ text: 'LEAD-AGAIN-2' }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-AGAIN-3' }, turn: [{ text: 'LEAD-AGAIN-3' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-AGAIN-1' });
    await waitForResult(convoId, 'LEAD-AGAIN-1', since, 'the first arrival answers');
    assert.strictEqual(noticesFor(convoId, since).length, 1, 'the first arrival is told');
    h.reapConvo(convoId);

    // The lead has spoken and has a session; forty turns pass while it is away.
    const talk = h.internal.convoTranscripts.get(convoId);
    talk.push({ role: 'agent', agent: 'content-lead', text: 'LEAD-OWN-TURN: the draft is in' }, ...fortyMore('away'));
    assertCutBy(returningDelta(talk), 'truncated');
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'content-lead', sessionId: 'sess-lead-again' }] });
    parkParent(convoId, 'p-again-2');
    const second = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-AGAIN-2' });
    await waitForResult(convoId, 'LEAD-AGAIN-2', second, 'the returning lead answers');
    const resumed = spawnsFor(convoId).filter(i => i.agent === 'content-lead');
    assert.strictEqual(resumed[resumed.length - 1].resume, 'sess-lead-again', 'the lead resumed its own session');
    assert.strictEqual(noticesFor(convoId, second).length, 0, 'a resume with a cut returning delta raises no notice');
    const returning = h.promptsFor('content-lead').pop();
    assert.match(returning, /SINCE YOUR LAST TURN/, 'it was briefed as returning');
    h.reapConvo(convoId);

    // Its session ids removed, the next delegation starts it with nothing carried over.
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    assertCutBy(arrivingDelta(h.internal.convoTranscripts.get(convoId)));
    parkParent(convoId, 'p-again-3');
    const third = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-AGAIN-3' });
    await waitForResult(convoId, 'LEAD-AGAIN-3', third, 'the new arrival answers');
    const notices = noticesFor(convoId, third);
    assert.strictEqual(notices.length, 1, 'a new arrival raises one notice of its own');
    assertPlaced(convoId, third, notices[0], { agent: 'content-lead' });
    h.reapConvo(convoId);
  });

  test('whose stored session is gone: told once, after the line that says it is starting fresh', async () => {
    const convoId = h.freshConvoId('short-stale-delegate');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, {
      agentId: 'chief-of-staff', sessionId: 'live-orch-c',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'live-orch-c' }, { agentId: 'content-lead', sessionId: 'dead-lead-c' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'DRAFT-REQUEST-C' },
        turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Handing this to Wren.', prompt: 'BRIEF-C write it' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-C' }, turn: [{ text: 'LEAD-FRESH-REPLY-C' }] },
    ], ['dead-lead-c']);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'DRAFT-REQUEST-C please', sessionId: 'live-orch-c' });
    await waitForResult(convoId, 'LEAD-FRESH-REPLY-C', since, 'the delegate answers from a fresh session');

    const lead = spawnsFor(convoId).filter(i => i.agent === 'content-lead');
    assert.deepStrictEqual(lead.map(i => i.resume), ['dead-lead-c', null], 'the resume was refused and the lead started fresh');
    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for the fresh start');
    assertShape(notices[0], convoId, FOR_WREN);
    const expired = m => m.type === 'system' && m.subtype === 'info' && m.content === startingFresh(nameOf('content-lead'));
    assertPlaced(convoId, since, notices[0], { agent: 'content-lead', afterLine: expired });
    assertLineUnder(h.promptsFor('content-lead').pop(), CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });
});

describe('an orchestrator whose stored session is gone, handed a conversation back', () => {
  test('with the handback prompt sent: told once, after the line that says it is starting fresh', async () => {
    const convoId = h.freshConvoId('short-stale-handback');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk, 'chief-of-staff', ['content-lead']), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-e',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-e' }, { agentId: 'content-lead', sessionId: 'live-lead-e' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'FLIGHT-E' }, turn: [{ text: 'Not mine to do. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'routing-request' }, turn: [{ text: 'ORCH-ROUTED-E' }] },
    ], ['dead-orch-e']);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'book me a FLIGHT-E', sessionId: 'live-lead-e' });
    await waitForResult(convoId, 'ORCH-ROUTED-E', since, 'the fresh orchestrator routes the request');

    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for the fresh orchestrator');
    assertShape(notices[0], convoId, noticeText(nameOf('chief-of-staff')));
    const expired = m => m.type === 'system' && m.subtype === 'info' && m.expiredSessionId === 'dead-orch-e';
    assertPlaced(convoId, since, notices[0], { agent: 'chief-of-staff', autoContinue: true, afterLine: expired });
    const prompt = h.promptsFor('chief-of-staff').pop();
    assert.match(prompt, /routing-request/, 'the fresh orchestrator is given the handback');
    assertLineUnder(prompt, CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });

  test('paused by the circuit breaker: told at the fresh start, and not again when the held catch-up is delivered', async () => {
    const convoId = h.freshConvoId('short-stale-breaker');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk, 'chief-of-staff', ['content-lead']), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, {
      agentId: 'chief-of-staff', activeAgentId: 'content-lead', sessionId: 'dead-orch-z',
      sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'dead-orch-z' }, { agentId: 'content-lead', sessionId: 'live-lead-z' }],
    });
    scenario([
      { match: { resume: true, promptIncludes: 'TASK-Z' }, turn: [{ text: 'Not mine, handing back. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-Z' }, turn: [{ text: 'ORCH-NEXT-Z' }] },
    ], ['dead-orch-z']);
    h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'do TASK-Z', sessionId: 'live-lead-z' });
    await client.waitFor(m => m.type === 'assistant' && m._conversationId === convoId && /Auto-paused/.test(JSON.stringify(m)),
      { since, label: 'the circuit breaker pauses the handback', timeout: 15000 });
    await client.waitFor(m => m.subtype === 'info' && m._conversationId === convoId && m.expiredSessionId === 'dead-orch-z',
      { since, label: 'the fresh start', timeout: 15000 });

    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NEXT-Z please' });
    await waitForResult(convoId, 'ORCH-NEXT-Z', next, 'the next message is answered');

    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice, raised once for the fresh start');
    assert.strictEqual(noticesFor(convoId, next).length, 0, 'none when the held catch-up is delivered');
    assertShape(notices[0], convoId, noticeText(nameOf('chief-of-staff')));
    const expired = m => m.type === 'system' && m.subtype === 'info' && m.expiredSessionId === 'dead-orch-z';
    assertPlaced(convoId, since, notices[0], { agent: 'chief-of-staff', autoContinue: true, afterLine: expired });
    const prompts = h.promptsFor('chief-of-staff');
    assert.strictEqual(prompts.length, 1, 'the held catch-up went with the next message');
    assertLineUnder(prompts[0], CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });
});

describe('stopping the agent after the notice', () => {
  test('raises no second notice, and the notice is not saved with the conversation', async () => {
    const convoId = h.freshConvoId('short-undo');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-undo');
    scenario([
      { match: { agent: 'content-lead', promptIncludes: 'BRIEF-UNDO' }, untilFile: path.join(h.workspaceDir, 'never-released'), turn: [{ text: 'never sent' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-UNDO' });
    assert.ok(await h.waitUntil(() => h.promptsFor('content-lead').length === 1), 'the delegate was handed its brief');
    await h.waitUntil(() => noticesFor(convoId, since).length > 0, { timeout: 3000 });
    assert.strictEqual(noticesFor(convoId, since).length, 1, 'the person was told');

    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.strictEqual(noticesFor(convoId, since).length, 1, 'stopping raises no second notice');
    assert.ok(!JSON.stringify(h.internal.loadTranscript(convoId)).includes(NOTICE_WORDS), 'the notice is not in the transcript');
    assert.ok(!JSON.stringify(stored(convoId)).includes(NOTICE_WORDS), 'nor in the stored conversation');
    h.reapConvo(convoId);
  });
});

// ── Codex delegates ─────────────────────────────────────────────────────

// Valid-shaped thread ids: they pass the shape check, so a resume is tried.
const STALE_THREAD = '99999999-8888-4777-8666-555555555555';
const LIVE_THREAD = '22222222-3333-4444-8555-666666666666';

function codexCalls(method) {
  return h.readInvocations().filter(i => i.mode === 'app-server' && i.method === method);
}

const EXPIRED_LINE = m => m.type === 'system' && m.subtype === 'notice' && m.content === 'Previous session expired. Starting fresh.';

describe('a Codex delegate brought into a long conversation', () => {
  test('on a new thread: the person is told once, by name, before it replies', async () => {
    assert.strictEqual(nameOf('researcher'), 'Ida', 'sanity: the researcher is called Ida');
    const convoId = h.freshConvoId('short-codex-new');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk, 'researcher'), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'ALPHA-ASK-CODEX' },
        turn: [{ agentTool: { subagent_type: 'researcher', description: 'Handing this to Ida.', prompt: 'ALPHA-BRIEF-CODEX' } }] },
    ]);
    h.writeCodexScenario([{ match: { promptIncludes: 'ALPHA-BRIEF-CODEX' }, text: 'IDA-REPLY-NEW' }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ALPHA-ASK-CODEX please' });
    await waitForResult(convoId, 'IDA-REPLY-NEW', since, 'the Codex delegate answers');

    assert.strictEqual(codexCalls('thread/start').length, 1, 'a new thread was opened');
    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for one arrival');
    assertShape(notices[0], convoId, noticeText('Ida'));
    assertPlaced(convoId, since, notices[0], { agent: 'researcher' });
    const prompt = h.codexTurnPrompts().pop();
    assert.match(prompt, /ALPHA-BRIEF-CODEX/, 'the brief still arrives');
    assertLineUnder(prompt, CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });

  test('on an expired thread: told once, after the line that says the session expired', async () => {
    const convoId = h.freshConvoId('short-codex-expired');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk, 'researcher'), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'researcher', sessionId: STALE_THREAD }] });
    parkParent(convoId, 'p-short-codex-expired');
    h.writeCodexScenario([{ match: { promptIncludes: 'BRIEF-EXPIRED' }, text: 'IDA-REPLY-EXPIRED' }], { resumeFails: true });
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'BRIEF-EXPIRED' });
    await waitForResult(convoId, 'IDA-REPLY-EXPIRED', since, 'the Codex delegate answers on a fresh thread');

    assert.strictEqual(codexCalls('thread/resume').length, 1, 'the stored thread was tried');
    assert.strictEqual(codexCalls('thread/start').length, 1, 'and a fresh one opened when it was gone');
    const notices = noticesFor(convoId, since);
    assert.strictEqual(notices.length, 1, 'one notice for the fresh start');
    assertShape(notices[0], convoId, noticeText('Ida'));
    assertPlaced(convoId, since, notices[0], { agent: 'researcher', afterLine: EXPIRED_LINE });
    assertLineUnder(h.codexTurnPrompts().pop(), CATCH_UP_HEADINGS.arriving);
    h.reapConvo(convoId);
  });
});

// ── no notice where nothing arrived cut ─────────────────────────────────

describe('no notice where nothing arrived cut', () => {
  test('a Claude Code delegate arriving into a short conversation', async () => {
    const convoId = h.freshConvoId('short-uncut');
    const talk = shortTalk();
    assertUncut(arrivingDelta(talk));
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-uncut');
    scenario([{ match: { agent: 'content-lead', promptIncludes: 'BRIEF-UNCUT' }, turn: [{ text: 'LEAD-UNCUT' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-UNCUT' });
    await waitForResult(convoId, 'LEAD-UNCUT', since, 'the delegate answers');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'nothing was cut, so nothing is said');
    const prompt = h.promptsFor('content-lead').pop();
    assert.match(prompt, /BEFORE YOU JOINED/, 'it was handed the conversation');
    assert.ok(!prompt.includes(LINE), 'and is not told anything was left out');
    h.reapConvo(convoId);
  });

  test('a delegate arriving into a conversation with nothing to catch up on', async () => {
    const convoId = h.freshConvoId('short-empty');
    assert.strictEqual(arrivingDelta([]).text, null, 'the fixture has nothing to catch up on');
    seedTalk(convoId, []);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-empty');
    scenario([{ match: { agent: 'content-lead', promptIncludes: 'BRIEF-EMPTY' }, turn: [{ text: 'LEAD-EMPTY' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-EMPTY' });
    await waitForResult(convoId, 'LEAD-EMPTY', since, 'the delegate answers');
    assert.strictEqual(noticesFor(convoId, since).length, 0);
    h.reapConvo(convoId);
  });

  test('an orchestrator resumed at a handback with a cut delta', async () => {
    const convoId = h.freshConvoId('short-return-orch');
    const talk = [
      { role: 'user', agent: 'user', text: `write the alpha post ${MARKER}` },
      { role: 'agent', agent: 'chief-of-staff', text: 'ORCH-EARLIER: handing this to Wren' },
      ...fortyMore('meanwhile'),
      { role: 'agent', agent: 'content-lead', text: 'LEAD-HANDBACK: the post is written' },
    ];
    assertCutBy(returningDelta(talk, 'chief-of-staff', ['content-lead']), 'truncated');
    seedTalk(convoId, talk);
    h.internal.writeConversations([{ id: convoId, title: 'return', messages: [], sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'sess-cos-return' }] },
      ...h.internal.readConversations().filter(c => c.id !== convoId)]);
    scenario([{ match: { agent: 'chief-of-staff' }, turn: [{ text: 'ORCH-BACK' }] }]);
    const entry = {
      agentId: 'content-lead', processId: 'p-short-return', lastUserMessage: 'write the alpha post',
      toolCalls: [], finalResponseText: 'LEAD-HANDBACK: the post is written',
    };
    h.internal.chatProcesses.set(convoId, entry);
    h.clearInvocations();
    const since = client.messages.length;
    h.internal.handleScopeReturn(entry, convoId, 'return');
    await waitForResult(convoId, 'ORCH-BACK', since, 'the resumed orchestrator answers');
    assert.strictEqual(spawnsFor(convoId).filter(i => i.resume === 'sess-cos-return').length, 1, 'the orchestrator resumed its session');
    assert.match(h.promptsFor('chief-of-staff').pop(), /SINCE YOUR LAST TURN/, 'and was briefed as returning');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'a returning agent raises no notice');
    h.reapConvo(convoId);
  });

  test('a delegate resumed with a cut delta', async () => {
    const convoId = h.freshConvoId('short-return-delegate');
    const talk = [
      { role: 'user', agent: 'user', text: `write the alpha post ${MARKER}` },
      { role: 'agent', agent: 'content-lead', text: 'LEAD-EARLIER: first draft' },
      ...fortyMore('meanwhile'),
    ];
    assertCutBy(returningDelta(talk), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'content-lead', sessionId: 'sess-lead-return' }] });
    parkParent(convoId, 'p-short-return-delegate');
    scenario([{ match: { agent: 'content-lead', promptIncludes: 'BRIEF-RETURN' }, turn: [{ text: 'LEAD-RETURN' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-RETURN' });
    await waitForResult(convoId, 'LEAD-RETURN', since, 'the returning delegate answers');
    assert.strictEqual(spawnsFor(convoId).filter(i => i.resume === 'sess-lead-return').length, 1, 'the delegate resumed its session');
    assert.match(h.promptsFor('content-lead').pop(), /SINCE YOUR LAST TURN/, 'and was briefed as returning');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'a returning agent raises no notice');
    h.reapConvo(convoId);
  });

  test('a mid-level parent resumed at its delegate\'s close with a cut delta', async () => {
    const convoId = h.freshConvoId('short-return-parent');
    const release = path.join(h.workspaceDir, `release-${convoId}`);
    // Intercepted all the way down, so the lead is stopped while its own
    // report works and is resumed by session when the report hands back.
    scenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'midlevel alpha task' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'midlevel alpha lead brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'midlevel alpha lead brief' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'midlevel alpha sub brief' } }] },
      { match: { agent: 'content-analyst', promptIncludes: 'midlevel alpha sub brief' }, untilFile: release,
        turn: [{ text: 'ANALYST-SAID-THIS. Outside my scope. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'LEAD-PICKED-UP' }] },
      { match: { agent: 'chief-of-staff' }, turn: [{ text: 'Noted.' }] },
    ]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'midlevel alpha task' });
    assert.ok(await h.waitUntil(() => h.promptsFor('content-analyst').length === 1, { timeout: 15000 }), 'the report was handed its brief');

    // While the report works, the lead's own turn is on record and forty
    // more turns pass, so the lead's delta at its resume is cut.
    const talk = h.internal.convoTranscripts.get(convoId);
    talk.push({ role: 'agent', agent: 'content-lead', text: 'LEAD-OWN-TURN: asked the analyst' }, ...fortyMore('while-waiting'));
    assertCutBy(returningDelta(talk, 'content-lead', ['content-analyst']), 'truncated');
    fs.writeFileSync(release, '');

    await waitForResult(convoId, 'LEAD-PICKED-UP', since, 'the mid-level parent answers after its resume');
    const resumedPrompt = h.promptsFor('content-lead').pop();
    assert.match(resumedPrompt, /ANALYST-SAID-THIS/, 'the parent was resumed with its report\'s output');
    assert.match(resumedPrompt, /SINCE YOUR LAST TURN/, 'and briefed as returning, with the cut delta');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'a returning parent raises no notice');
    h.reapConvo(convoId);
  });

  test('a Claude Code resume that is not refused, though its unused fallback is cut', async () => {
    const convoId = h.freshConvoId('short-unused-fallback');
    const talk = [
      ...longTalk(),
      { role: 'agent', agent: 'content-lead', text: 'LEAD-EARLIER: first draft' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-AFTER: the numbers check out' },
    ];
    assertUncut(returningDelta(talk));
    assertCutBy(arrivingDelta(talk), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'content-lead', sessionId: 'sess-lead-unused' }] });
    parkParent(convoId, 'p-short-unused');
    scenario([{ match: { agent: 'content-lead', promptIncludes: 'BRIEF-UNUSED' }, turn: [{ text: 'LEAD-UNUSED' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'BRIEF-UNUSED' });
    await waitForResult(convoId, 'LEAD-UNUSED', since, 'the resumed delegate answers');
    assert.strictEqual(spawnsFor(convoId).filter(i => i.resume === 'sess-lead-unused').length, 1, 'the resume was not refused');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'a fallback never used raises no notice');
    assert.ok(!h.promptsFor('content-lead').pop().includes(LINE), 'and the delta it was handed was not cut');
    h.reapConvo(convoId);
  });
});

describe('no notice from a Codex delegate where nothing arrived cut', () => {
  test('a Codex delegate arriving into a short conversation', async () => {
    const convoId = h.freshConvoId('short-codex-uncut');
    const talk = shortTalk();
    assertUncut(arrivingDelta(talk, 'researcher'));
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-codex-uncut');
    h.writeCodexScenario([{ match: { promptIncludes: 'BRIEF-CODEX-UNCUT' }, text: 'IDA-UNCUT' }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'BRIEF-CODEX-UNCUT' });
    await waitForResult(convoId, 'IDA-UNCUT', since, 'the Codex delegate answers');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'nothing was cut, so nothing is said');
    const prompt = h.codexTurnPrompts().pop();
    assert.match(prompt, /BEFORE YOU JOINED/, 'it was handed the conversation');
    assert.ok(!prompt.includes(LINE), 'and is not told anything was left out');
    h.reapConvo(convoId);
  });

  test('a Codex resume that succeeds, though its unused fallback is cut', async () => {
    const convoId = h.freshConvoId('short-codex-resumed');
    const talk = [
      ...longTalk(),
      { role: 'agent', agent: 'researcher', text: 'IDA-EARLIER: three suppliers found' },
      { role: 'agent', agent: 'content-analyst', text: 'ANALYST-AFTER: the numbers check out' },
    ];
    assertUncut(returningDelta(talk, 'researcher'));
    assertCutBy(arrivingDelta(talk, 'researcher'), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [{ agentId: 'researcher', sessionId: LIVE_THREAD }] });
    parkParent(convoId, 'p-short-codex-resumed');
    h.writeCodexScenario([{ match: { promptIncludes: 'BRIEF-CODEX-RESUMED' }, text: 'IDA-RESUMED' }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'BRIEF-CODEX-RESUMED' });
    await waitForResult(convoId, 'IDA-RESUMED', since, 'the resumed Codex delegate answers');
    assert.strictEqual(codexCalls('thread/resume').length, 1, 'the stored thread was resumed');
    assert.strictEqual(codexCalls('thread/start').length, 0, 'and the fallback was never opened');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'a fallback never used raises no notice');
    const prompt = h.codexTurnPrompts().pop();
    assert.match(prompt, /SINCE YOUR LAST TURN/, 'it was briefed as returning');
    assert.ok(!prompt.includes(LINE), 'with a delta that was not cut');
    h.reapConvo(convoId);
  });

  test('a Codex delegate whose thread never opens', async () => {
    const convoId = h.freshConvoId('short-codex-no-open');
    const talk = longTalk();
    assertCutBy(arrivingDelta(talk, 'researcher'), 'truncated');
    seedTalk(convoId, talk);
    seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
    parkParent(convoId, 'p-short-codex-no-open');
    // Enough overloads to exhaust the protocol client's retries, so thread/start rejects.
    h.writeCodexScenario([{ match: { promptIncludes: 'BRIEF-NO-OPEN' }, text: 'unreachable' }],
      { overload: { method: 'thread/start', times: 10 } });
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'researcher', context: 'BRIEF-NO-OPEN' });
    await client.waitForEvent('system', 'delegate_stopped', convoId, { since, timeout: 15000, label: 'the delegate stopped visibly' });
    await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId
      && m._agent === 'researcher', { since, timeout: 15000, label: 'the delegate closed' });
    assert.ok(codexCalls('thread/start').length >= 1, 'a thread was asked for');
    assert.strictEqual(h.codexTurnPrompts().length, 0, 'no turn started, so the agent was handed nothing');
    assert.strictEqual(noticesFor(convoId, since).length, 0, 'an agent that never started raises no notice');
    h.writeCodexScenario([]);
    h.reapConvo(convoId);
  });
});

// ── with no page connected ──────────────────────────────────────────────

describe('a notice sent with no page connected', () => {
  test('changes nothing the agent is handed, and is there when a page connects', async () => {
    const brief = 'BRIEF-PARITY';
    scenario([{ match: { agent: 'content-lead', promptIncludes: brief }, turn: [{ text: 'LEAD-PARITY' }] }]);
    const run = async (convoId) => {
      seedTalk(convoId, longTalk());
      seed(convoId, { agentId: 'chief-of-staff', sessionIds: [] });
      parkParent(convoId, `p-${convoId}`);
      h.clearInvocations();
      h.internal.handleDelegation({
        conversationId: convoId, targetAgent: 'content-lead', context: brief,
        _intercepted: true, _parentAgentId: 'chief-of-staff',
      }, h.internal.chatProcesses);
      assert.ok(await h.waitUntil(() => h.promptsFor('content-lead').length === 1), 'the delegate was handed its brief');
      return h.promptsFor('content-lead')[0];
    };

    const withPage = h.freshConvoId('short-page');
    const connectedPrompt = await run(withPage);
    h.reapConvo(withPage);

    client.close();
    assert.ok(await h.waitUntil(() => ![...h.internal.connectedClients].some(c => c.readyState === 1)), 'no page is connected');
    const noPage = h.freshConvoId('short-no-page');
    const unconnectedPrompt = await run(noPage);
    assert.strictEqual(unconnectedPrompt, connectedPrompt, 'the agent is handed the same prompt with or without a page');
    assertLineUnder(unconnectedPrompt, CATCH_UP_HEADINGS.arriving);
    const held = h.internal.disconnectBuffer.map(p => JSON.parse(p))
      .filter(m => m._conversationId === noPage && m.subtype === 'notice' && String(m.content || '').includes(NOTICE_WORDS));
    assert.strictEqual(held.length, 1, 'the notice waits for a page');
    h.reapConvo(noPage);

    client = await h.connect();
    const since = client.messages.length;
    client.send({ type: 'flush_buffer' });
    const { msg } = await client.waitFor(m => m._conversationId === noPage && m.subtype === 'notice', { since, label: 'the held notice' });
    assertShape(msg, noPage, FOR_WREN);
  });
});
