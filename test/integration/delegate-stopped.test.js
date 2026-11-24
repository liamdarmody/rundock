'use strict';
// A DELEGATE THAT STOPS BEFORE FINISHING IS SAID TO HAVE STOPPED.
//
// When a teammate's process ends, the server decides whether its last turn
// finished: a successful result since that turn began, or a handoff marker.
// Without either, and unless the person stopped it, the delegate failed, and
// the return switch carries `failed: { code, signal, reason }` naming exactly
// one reason. These tests drive each way a delegate can stop through the real
// server against the stub runtime, and read the switch the window received.
//
// The server then stores one line saying so and sends it once, with no process
// id, so a line a delegate prints for itself can never pass for it. Each test
// waits for the delegate's own closing `done`, which every release sends, and
// only then counts the lines, so a missing line fails on the count.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const h = require(path.join(ROOT, 'test', 'helpers', 'harness.js'));
const { standardTeam } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));
const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

/**
 * Cos hands `<tag> brief` to Wren through the Agent tool; Wren's turns are the
 * rules given, first match first; and Cos, respawned with whatever the server
 * tells it, stays quiet. A resumed Cos is started without --agent, so with
 * `cosResumed` its rule matches on the resume instead.
 */
function routeToWren(tag, wrenRules, { cosResumed = false, ...extra } = {}) {
  const cos = cosResumed ? { resume: true } : { agent: 'chief-of-staff' };
  h.writeScenario([
    { match: { ...cos, promptIncludes: `${tag} request`, promptExcludes: '[SYSTEM:' },
      turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to Wren.', prompt: `${tag} brief` } }] },
    ...wrenRules.map((r) => ({ ...r, match: { agent: 'content-lead', ...r.match } })),
    { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
  ], extra);
}

function startConversation(tag, extra = {}) {
  const convoId = h.freshConvoId(tag);
  client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: tag } });
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${tag} request`, ...extra });
  return { convoId, since };
}

function waitForReturn(convoId, since) {
  return client.waitFor((m) => m.type === 'system' && m.subtype === 'agent_switch'
    && m._conversationId === convoId && m.fromAgent === 'content-lead' && m.toAgent === 'chief-of-staff',
  { since, label: 'control came back to Cos', timeout: 20000 }).then(({ msg }) => msg);
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label, timeout: 20000 });
}

function assertStopped(sw, reason) {
  assert.strictEqual((sw.failed || {}).reason, reason, `the return names one reason: ${JSON.stringify(sw.failed)}`);
}

describe('the reason a delegate stopped', () => {
  test('a crash with exit code 1 and no result is exit code 1', async () => {
    h.clearInvocations();
    routeToWren('ds-crash1', [{ match: { promptIncludes: 'ds-crash1 brief' }, crash: 1 }]);
    const { convoId, since } = startConversation('ds-crash1');
    const sw = await waitForReturn(convoId, since);
    assertStopped(sw, 'exit code 1');
    assert.strictEqual((sw.failed || {}).code, 1, 'the code is carried as it came');
    assert.strictEqual((sw.failed || {}).signal, null, 'and no signal is invented');
    h.reapConvo(convoId);
  });

  test('exit code 0 with no result is still a stop, named exit code 0', async () => {
    h.clearInvocations();
    routeToWren('ds-crash0', [{ match: { promptIncludes: 'ds-crash0 brief' }, crash: 0 }]);
    const { convoId, since } = startConversation('ds-crash0');
    assertStopped(await waitForReturn(convoId, since), 'exit code 0');
    h.reapConvo(convoId);
  });

  test('a turn that ended on an error result is Claude Code reported an error, never its exit code', async () => {
    h.clearInvocations();
    routeToWren('ds-iserr', [{ match: { promptIncludes: 'ds-iserr brief' }, isError: true, exitAfterTurn: 1,
      turn: [{ text: 'The tool run hit a snag halfway through.' }] }]);
    const { convoId, since } = startConversation('ds-iserr');
    assertStopped(await waitForReturn(convoId, since), 'Claude Code reported an error');
    h.reapConvo(convoId);
  });

  test('a delegate killed mid-turn is stopped by the system, and the switch names the signal', async () => {
    h.clearInvocations();
    const never = path.join(h.workspaceDir, `never-${Date.now()}`);
    routeToWren('ds-kill', [{ match: { promptIncludes: 'ds-kill brief' }, holdAfterText: never,
      turn: [{ text: 'DS-KILL-PARTIAL work so far' }] }]);
    const { convoId, since } = startConversation('ds-kill');
    await client.waitFor((m) => m._conversationId === convoId && m.type === 'stream_event' && m._agent === 'content-lead'
      && m.event && m.event.type === 'content_block_stop', { since, label: 'Wren is part way through', timeout: 20000 });
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry && entry.agentId, 'content-lead', 'sanity: Wren is the process on screen');
    entry.process.kill('SIGKILL');
    const sw = await waitForReturn(convoId, since);
    assertStopped(sw, 'stopped by the system');
    assert.strictEqual((sw.failed || {}).signal, 'SIGKILL', 'the switch names the signal');
    h.reapConvo(convoId);
  });

  test('a follow-up that crashes after a first turn that succeeded is exit code 1', async () => {
    h.clearInvocations();
    routeToWren('ds-fucrash', [
      { match: { promptIncludes: 'ds-fucrash again' }, crash: 1 },
      { match: { promptIncludes: 'ds-fucrash brief' }, turn: [{ text: 'DS-FUCRASH-FIRST done' }] },
    ]);
    const { convoId, since } = startConversation('ds-fucrash');
    await waitForResult(convoId, 'DS-FUCRASH-FIRST', since, 'Wren finished the first turn');
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-fucrash again' });
    assertStopped(await waitForReturn(convoId, next), 'exit code 1');
    h.reapConvo(convoId);
  });

  test('a follow-up that ends on an error result is Claude Code reported an error', async () => {
    h.clearInvocations();
    routeToWren('ds-fuerr', [
      { match: { promptIncludes: 'ds-fuerr again' }, isError: true, exitAfterTurn: 1,
        turn: [{ text: 'The second pass hit a snag.' }] },
      { match: { promptIncludes: 'ds-fuerr brief' }, turn: [{ text: 'DS-FUERR-FIRST done' }] },
    ]);
    const { convoId, since } = startConversation('ds-fuerr');
    await waitForResult(convoId, 'DS-FUERR-FIRST', since, 'Wren finished the first turn');
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-fuerr again' });
    assertStopped(await waitForReturn(convoId, next), 'Claude Code reported an error');
    h.reapConvo(convoId);
  });

  test('a fresh start after an expired session that then crashes is exit code 1', async () => {
    h.clearInvocations();
    const convoId = h.freshConvoId('ds-fresh');
    const others = h.internal.readConversations().filter((c) => c.id !== convoId);
    h.internal.writeConversations([{ id: convoId, title: 'ds-fresh', status: 'active', agentId: 'chief-of-staff',
      sessionId: 'ds-live-cos', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'ds-live-cos' },
        { agentId: 'content-lead', sessionId: 'ds-dead-wren' }] }, ...others]);
    // The refused resume is held open, so what the refused attempt left on the
    // entry can be seen to be cleared when the fresh start begins.
    routeToWren('ds-fresh', [{ match: { promptIncludes: 'ds-fresh brief' }, crash: 1 }],
      { cosResumed: true, deadSessions: ['ds-dead-wren'], refusalExitMs: 1500 });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ds-fresh request', sessionId: 'ds-live-cos' });
    await h.waitUntil(() => (h.internal.chatProcesses.get(convoId) || {}).agentId === 'content-lead');
    const refused = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(refused && refused.agentId, 'content-lead', 'sanity: Wren\'s refused resume is the process on screen');
    refused.lastTurnOutcome = 'success';
    const sw = await waitForReturn(convoId, since);
    const wren = h.readInvocations().filter((i) => i.agent === 'content-lead' && i.env && i.env.RUNDOCK_CONVO_ID === convoId);
    assert.deepStrictEqual(wren.map((i) => i.resume), ['ds-dead-wren', null], 'sanity: the dead id was refused and Wren started fresh');
    assertStopped(sw, 'exit code 1');
    h.reapConvo(convoId);
  });
});

const CRASH1_TEXT = "Wren stopped before finishing\nWren's session ended before a final answer (exit code 1). "
  + 'Cos has the conversation again. Anything Wren changed before stopping is still in your workspace.';
const NO_PARENT_TEXT = "Wren stopped before finishing\nWren's session ended before a final answer (stopped by the system). "
  + 'Anything Wren changed before stopping is still in your workspace.';

const isReturnTo = (convoId) => (m) => m.type === 'system' && m.subtype === 'agent_switch'
  && m._conversationId === convoId && m.fromAgent === 'content-lead' && m.toAgent === 'chief-of-staff';
const isLine = (convoId) => (m) => m.type === 'system' && m.subtype === 'delegate_stopped' && m._conversationId === convoId;

/**
 * Everything the window received from `since` up to Wren's closing `done`,
 * which the server sends last when Wren's process closes. Where control comes
 * back to Cos the wait starts at that switch, so a `done` from Wren's own
 * result is never taken for the close.
 */
async function untilClosed(convoId, since, { returns = true } = {}) {
  const from = returns
    ? (await client.waitFor(isReturnTo(convoId), { since, label: 'control came back to Cos', timeout: 20000 })).index
    : since;
  const { index } = await client.waitFor((m) => m.type === 'system' && m.subtype === 'done'
    && m._conversationId === convoId && m._agent === 'content-lead', { since: from, label: 'Wren\'s close finished', timeout: 20000 });
  return client.messages.slice(since, index + 1);
}

function waitForWrenPartWay(convoId, since) {
  return client.waitFor((m) => m._conversationId === convoId && m.type === 'stream_event' && m._agent === 'content-lead'
    && m.event && m.event.type === 'content_block_stop', { since, label: 'Wren is part way through', timeout: 20000 });
}

/** Wren holds after its first words, until the test ends it. */
function heldWren(tag) {
  return { holdAfterText: path.join(h.workspaceDir, `never-${tag}-${Date.now()}`), turn: [{ text: `${tag} partial work` }] };
}

/**
 * Cos answers once and stays live; then a `delegate` request hands Wren the
 * brief. `laterWrenRules` answer Wren's later turns, matched by their own words.
 */
async function delegateFromLiveCos(tag, wrenRule, laterWrenRules = []) {
  const convoId = h.freshConvoId(tag);
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: `${tag} open` }, turn: [{ text: 'ready' }] },
    ...laterWrenRules.map((r) => ({ ...r, match: { agent: 'content-lead', ...r.match } })),
    { ...wrenRule, match: { agent: 'content-lead', promptIncludes: `${tag} brief` } },
    { match: { agent: 'chief-of-staff' }, turn: [{ text: 'noted' }] },
  ]);
  client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: tag } });
  const opened = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${tag} open` });
  await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { since: opened, label: 'Cos is live', timeout: 20000 });
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: `${tag} brief` });
  return { convoId, since };
}

/** Runs `fn` with an agent's file moved aside, so the team has no name for that agent. */
async function withoutAgentFile(slug, fn) {
  const file = path.join(h.workspaceDir, '.claude', 'agents', `${slug}.md`);
  fs.renameSync(file, `${file}.off`);
  h.internal.invalidateAgentCache();
  try {
    return await fn();
  } finally {
    fs.renameSync(`${file}.off`, file);
    h.internal.invalidateAgentCache();
  }
}

// The page's own chat view on a document, set up when a test first needs it,
// after the server has booted, so nothing the server loads sees it.
let page = null;
function pageView() {
  if (page) return page;
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div></body></html>');
  dom.window.Element.prototype.scrollIntoView = function () {};
  const markers = require(path.join(ROOT, 'public', 'markers.js'));
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    esc: (t) => String(t),
    formatMd: (t) => String(t),
    userScrolledUp: false,
    getConvoState: () => ({ currentStreamingMsg: null, isProcessing: false }),
    renderConvoList: () => {},
    createHistoryDivider: () => dom.window.document.createElement('hr'),
    tryMessageAnchor: () => {},
    setActiveAgentPill: () => {},
    renderPendingPermissionCards: () => {},
    agents: h.internal.discoverAgents(),
    RundockChatMarkup: require(path.join(ROOT, 'public', 'chat-markup.js')),
    RundockMarkers: markers,
    stripRundockMarkers: (t) => markers.stripMarkers(String(t || '')),
    restoredActiveAgentId: require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId,
    conversations: [],
    activeConversation: null,
  });
  page = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, page);
  return page;
}

describe('the line a person reads when a delegate stopped', () => {
  test('after a crash, one line names Wren, the reason and Cos, with no process id, between the switch and the close', async () => {
    h.clearInvocations();
    routeToWren('ds-line', [{ match: { promptIncludes: 'ds-line brief' }, crash: 1 }]);
    const { convoId, since } = startConversation('ds-line');
    const seen = await untilClosed(convoId, since);
    const lines = seen.filter(isLine(convoId));
    assert.strictEqual(lines.length, 1, `exactly one line: ${JSON.stringify(lines)}`);
    assert.strictEqual(lines[0].content, CRASH1_TEXT);
    assert.ok(!('_processId' in lines[0]), 'the server\'s line carries no process id');
    const switchAt = seen.findIndex(isReturnTo(convoId));
    const lineAt = seen.indexOf(lines[0]);
    assert.ok(switchAt > -1 && switchAt < lineAt && lineAt < seen.length - 1,
      `after the switch (${switchAt}) and before the close (${seen.length - 1}): ${lineAt}`);
    h.reapConvo(convoId);
  });

  test('the line is stored once, as Rundock\'s own row with the same words', async () => {
    h.clearInvocations();
    routeToWren('ds-row', [{ match: { promptIncludes: 'ds-row brief' }, crash: 1 }]);
    const { convoId, since } = startConversation('ds-row');
    await untilClosed(convoId, since);
    const rows = (h.internal.loadTranscript(convoId) || []).filter((t) => t.type === 'delegation');
    assert.deepStrictEqual(rows.map(({ role, agent, text }) => ({ role, agent, text })),
      [{ role: 'system', agent: null, text: CRASH1_TEXT }]);
    h.reapConvo(convoId);
  });

  test('with no parent left to take it back, the line leaves out who has the conversation', async () => {
    h.clearInvocations();
    const { convoId, since } = await delegateFromLiveCos('ds-orphan', heldWren('ds-orphan'));
    await waitForWrenPartWay(convoId, since);
    const entry = h.internal.chatProcesses.get(convoId);
    const orig = entry && entry.delegation && entry.delegation.originalEntry;
    assert.ok(orig, 'sanity: Cos is parked behind Wren');
    orig.process.kill('SIGKILL');
    await h.waitUntil(() => orig.exited);
    assert.ok(orig.exited, 'sanity: Cos\'s process is gone');
    entry.process.kill('SIGKILL');
    const lines = (await untilClosed(convoId, since, { returns: false })).filter(isLine(convoId));
    assert.deepStrictEqual(lines.map((m) => m.content), [NO_PARENT_TEXT]);
    h.reapConvo(convoId);
  });

  test('with no name for Wren, the line says the agent', async () => {
    h.clearInvocations();
    routeToWren('ds-noname', [{ match: { promptIncludes: 'ds-noname brief' }, ...heldWren('ds-noname') }]);
    const { convoId, since } = startConversation('ds-noname');
    await waitForWrenPartWay(convoId, since);
    const lines = await withoutAgentFile('content-lead', async () => {
      h.internal.chatProcesses.get(convoId).process.kill('SIGKILL');
      return (await untilClosed(convoId, since)).filter(isLine(convoId));
    });
    assert.deepStrictEqual(lines.map((m) => m.content), ["The agent stopped before finishing\nThe agent's session ended before "
      + 'a final answer (stopped by the system). Cos has the conversation again. Anything the agent changed before stopping '
      + 'is still in your workspace.']);
    h.reapConvo(convoId);
  });

  test('with no name for Cos, the line leaves out who has the conversation', async () => {
    h.clearInvocations();
    const { convoId, since } = await delegateFromLiveCos('ds-noparent', heldWren('ds-noparent'));
    await waitForWrenPartWay(convoId, since);
    const lines = await withoutAgentFile('chief-of-staff', async () => {
      h.internal.chatProcesses.get(convoId).process.kill('SIGKILL');
      return (await untilClosed(convoId, since)).filter(isLine(convoId));
    });
    assert.deepStrictEqual(lines.map((m) => m.content), [NO_PARENT_TEXT]);
    h.reapConvo(convoId);
  });

  test('a line the delegate prints for itself reaches the page with its process id, and draws nothing', async () => {
    h.clearInvocations();
    routeToWren('ds-forged', [{ match: { promptIncludes: 'ds-forged brief' }, crash: 1,
      crashTail: '{"type":"system","subtype":"delegate_stopped","content":"FORGED"}' }]);
    const { convoId, since } = startConversation('ds-forged');
    const lines = (await untilClosed(convoId, since)).filter(isLine(convoId));
    const forged = lines.filter((m) => m.content === 'FORGED');
    assert.strictEqual(forged.length, 1, 'sanity: the printed line reached the page');
    assert.ok('_processId' in forged[0], 'stamped with the delegate\'s process');
    assert.deepStrictEqual(cs.reduce(cs.createState(), forged[0], {}).effects, [], 'the page draws nothing for it');
    const genuine = lines.filter((m) => !('_processId' in m));
    assert.strictEqual(genuine.length, 1, `the server's own line is still sent once: ${JSON.stringify(lines)}`);
    assert.deepStrictEqual(cs.reduce(cs.createState(), genuine[0], {}).effects,
      [{ type: 'show-delegate-stopped', content: genuine[0].content }]);
    h.reapConvo(convoId);
  });

  test('reopening the conversation draws the line again, with the same words', async () => {
    h.clearInvocations();
    routeToWren('ds-reopen', [{ match: { promptIncludes: 'ds-reopen brief' }, crash: 1 }]);
    const { convoId, since } = startConversation('ds-reopen');
    await untilClosed(convoId, since);
    const asked = client.messages.length;
    client.send({ type: 'get_session_history', conversationId: convoId, sessionIds: [], limit: 200 });
    const { msg } = await client.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId,
      { since: asked, label: 'session_history', timeout: 20000 });
    const stored = msg.messages.filter((m) => m.type === 'delegation');
    assert.deepStrictEqual(stored.map(({ role, content }) => ({ role, content })), [{ role: 'system', content: CRASH1_TEXT }],
      'the history names the stored line as Rundock\'s own');

    const view = pageView();
    const convo = { id: convoId, agentId: 'chief-of-staff', agent: global.agents.find((a) => a.id === 'chief-of-staff'), messages: [] };
    global.conversations = [convo];
    global.activeConversation = convo;
    view.renderSessionHistory(msg);
    const notices = [...global.document.querySelectorAll('#messages .msg-stopped')];
    assert.strictEqual(notices.length, 1, 'drawn once');
    const drawn = `${notices[0].querySelector('.stopped-title').textContent}\n${notices[0].querySelector('.stopped-reason').textContent}`;
    assert.strictEqual(drawn, CRASH1_TEXT, 'with the words the line had live');
    h.reapConvo(convoId);
  });
});

// What Cos is told when Wren stopped. Cos is either started again with a
// prompt (Wren was handed the work through Cos's Agent tool) or still live and
// woken after a moment (Wren was handed it directly). Started again, it is
// told Wren stopped, with what Wren wrote, and stays quiet; still live, it is
// not woken with a prompt that would say Wren just returned.
const SILENT = "\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, "
  + "summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.";

describe('what Cos is told when Wren stopped', () => {
  test('Cos, started again, is told Wren stopped, is given what Wren wrote, and stays quiet', async () => {
    h.clearPrompts();
    routeToWren('ds-told', [
      { match: { promptIncludes: 'ds-told brief' }, turn: [{ text: 'DS-TOLD-PARTIAL the first half of the post' }], isError: true, exitAfterTurn: 1 },
    ]);
    const { convoId, since } = startConversation('ds-told');
    await untilClosed(convoId, since);
    assert.ok(await h.waitUntil(() => h.promptsFor('chief-of-staff').some((p) => p.includes('[SYSTEM:'))),
      'Cos, started again, was written to');
    const prompt = h.promptsFor('chief-of-staff').find((p) => p.includes('[SYSTEM:'));
    const opening = '[SYSTEM: delegate-failed] content-lead stopped before finishing (Claude Code reported an error).';
    const at = prompt.indexOf(opening);
    assert.ok(at > -1, `the prompt says Wren stopped and why: ${prompt}`);
    const told = prompt.slice(at);
    assert.ok(told.includes('DS-TOLD-PARTIAL the first half of the post'), `with what Wren wrote before stopping: ${told}`);
    assert.ok(told.includes("Do not describe content-lead's part as done."), told);
    assert.ok(told.endsWith(SILENT), `and the same instruction to stay quiet: ${told}`);
    assert.ok(!told.includes('completed their work') && !told.includes('has finished the delegated work'), told);
    assert.ok(await h.waitUntil(() => {
      const e = h.internal.chatProcesses.get(convoId);
      return Boolean(e && e.agentId === 'chief-of-staff' && e.idle === true);
    }), 'Cos is parked, waiting for the person');
    h.reapConvo(convoId);
  });

  test('Cos, still live, is not woken to carry on when Wren stopped after a follow-up', async () => {
    const { convoId, since } = await delegateFromLiveCos('ds-nowake', { turn: [{ text: 'DS-NOWAKE-FIRST done' }] }, [
      { match: { promptIncludes: 'ds-nowake again' }, crash: 1 },
    ]);
    await waitForResult(convoId, 'DS-NOWAKE-FIRST', since, 'Wren finished the first turn');
    h.clearPrompts();
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-nowake again' });
    const seen = await untilClosed(convoId, next);
    assert.strictEqual(seen.filter(isLine(convoId)).length, 1, 'sanity: Wren stopped');
    const cos = h.internal.chatProcesses.get(convoId);
    assert.ok(cos && cos.agentId === 'chief-of-staff' && cos.process && cos.process.stdin.writable,
      'sanity: Cos is live and could be written to');
    // Twice the 300 ms the wake waits: the one deliberate wait in this file.
    await h.delay(600);
    const woken = h.promptsFor('chief-of-staff').filter((p) => p.includes('[SYSTEM: The specialist just returned'));
    assert.deepStrictEqual(woken, [], 'Cos is not told Wren just returned');
    h.reapConvo(convoId);
  });
});

// NO LINE WHERE WREN DID NOT STOP. A turn the person stopped, a marker, or a
// successful last turn each mean Wren did not stop before finishing, however
// the process then ended. Each test drives one of those through the server
// and finds no line sent or stored for the conversation; where control comes
// back to Cos, the page draws the handback.
const markup = require(path.join(ROOT, 'public', 'chat-markup.js'));

// The two agents as the page knows them, named as standardTeam() names them.
const TEAM = {
  'chief-of-staff': { id: 'chief-of-staff', displayName: 'Cos', icon: 'C', colour: '#E87A5A', type: 'orchestrator' },
  'content-lead': { id: 'content-lead', displayName: 'Wren', icon: 'W', colour: '#4A90D9', type: 'specialist' },
};

// What the page draws for this switch, as a screen reader reads it: the
// avatars are hidden from it, so they are taken out before the words are read.
function drawnFor(sw) {
  const ctx = {
    isActive: true, convoAgentId: 'chief-of-staff',
    toAgentExists: !!TEAM[sw.toAgent], fromAgentExists: !!TEAM[sw.fromAgent],
    toAgentType: TEAM[sw.toAgent] ? TEAM[sw.toAgent].type : undefined,
  };
  const state = { ...cs.createState(), activeAgentId: sw.fromAgent, delegationActive: true };
  return cs.reduce(state, sw, ctx).effects
    .filter((ef) => ef.type === 'show-delegation-divider')
    .map((ef) => markup.delegationDividerHtml(TEAM[ef.fromAgentId], TEAM[ef.toAgentId], ef.isReturn)
      .replace(/<span class="avatar xs"[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Everything the window received from `since`, read once the server has
 * answered a history request sent after it: that reply goes out after
 * anything a close already sent.
 */
async function settled(convoId, since) {
  const asked = client.messages.length;
  client.send({ type: 'get_session_history', conversationId: convoId, sessionIds: [], limit: 200 });
  await client.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId,
    { since: asked, label: 'the history request was answered', timeout: 20000 });
  return client.messages.slice(since);
}

function assertNoLine(seen, convoId) {
  assert.deepStrictEqual(seen.filter(isLine(convoId)).map((m) => m.content), [], 'no line is sent');
  assert.deepStrictEqual((h.internal.loadTranscript(convoId) || []).filter((t) => t.type === 'delegation').map((t) => t.text), [],
    'and none is stored');
}

function assertHandedBack(seen, convoId) {
  const back = seen.filter(isReturnTo(convoId));
  assert.strictEqual(back.length, 1, `control came back to Cos once: ${JSON.stringify(back)}`);
  assert.deepStrictEqual(drawnFor(back[0]), ['Wren handed back to Cos'], 'and the page draws the handback');
}

const COMPLETE = '<!-- RUNDOCK:COMPLETE -->';

describe('no line when Wren did not stop before finishing', () => {
  test('the person stopping Wren mid-turn sends no switch and no line', async () => {
    h.clearInvocations();
    routeToWren('ds-cancel', [{ match: { promptIncludes: 'ds-cancel brief' }, ...heldWren('ds-cancel') }]);
    const { convoId, since } = startConversation('ds-cancel');
    await waitForWrenPartWay(convoId, since);
    const wren = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(wren && wren.agentId, 'content-lead', 'sanity: Wren is the process on screen');
    let closed = false;
    wren.process.once('close', () => { closed = true; });
    client.send({ type: 'cancel', conversationId: convoId });
    assert.ok(await h.waitUntil(() => closed, { timeout: 20000 }), 'Wren\'s process closed');
    assert.strictEqual(wren.cancelled, true, 'sanity: stopping Wren marked it stopped by the person');
    const seen = await settled(convoId, since);
    assert.deepStrictEqual(seen.filter(isReturnTo(convoId)), [], 'no switch is sent, so nothing says Wren handed back');
    assertNoLine(seen, convoId);
    h.reapConvo(convoId);
  });

  test('a marker and then a non-zero exit is no stop', async () => {
    h.clearInvocations();
    routeToWren('ds-markexit', [{ match: { promptIncludes: 'ds-markexit brief' }, isError: true, exitAfterTurn: 1,
      turn: [{ text: `DS-MARKEXIT the post is drafted ${COMPLETE}` }] }]);
    const { convoId, since } = startConversation('ds-markexit');
    const seen = await untilClosed(convoId, since);
    assertNoLine(seen, convoId);
    assertHandedBack(seen, convoId);
    h.reapConvo(convoId);
  });

  test('a marker and then a kill by a signal is no stop', async () => {
    h.clearInvocations();
    routeToWren('ds-markkill', [{ match: { promptIncludes: 'ds-markkill brief' },
      holdAfterText: path.join(h.workspaceDir, `never-ds-markkill-${Date.now()}`),
      turn: [{ text: `DS-MARKKILL the post is drafted ${COMPLETE}` }] }]);
    const { convoId, since } = startConversation('ds-markkill');
    await waitForWrenPartWay(convoId, since);
    const wren = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(wren && wren.agentId, 'content-lead', 'sanity: Wren is the process on screen');
    wren.process.kill('SIGKILL');
    const seen = await untilClosed(convoId, since);
    assert.strictEqual(wren.lastTurnOutcome, null, 'sanity: Wren\'s turn never reached its result');
    assertNoLine(seen, convoId);
    assertHandedBack(seen, convoId);
    h.reapConvo(convoId);
  });

  test('a fresh start after an expired session whose turn succeeds without a marker is no stop', async () => {
    h.clearInvocations();
    const convoId = h.freshConvoId('ds-freshok');
    const others = h.internal.readConversations().filter((c) => c.id !== convoId);
    h.internal.writeConversations([{ id: convoId, title: 'ds-freshok', status: 'active', agentId: 'chief-of-staff',
      sessionId: 'ds-freshok-cos', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'ds-freshok-cos' },
        { agentId: 'content-lead', sessionId: 'ds-freshok-dead' }] }, ...others]);
    routeToWren('ds-freshok', [{ match: { promptIncludes: 'ds-freshok brief' }, exitAfterTurn: 0,
      turn: [{ text: 'DS-FRESHOK the post is drafted' }] }], { cosResumed: true, deadSessions: ['ds-freshok-dead'] });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ds-freshok request', sessionId: 'ds-freshok-cos' });
    const seen = await untilClosed(convoId, since);
    const wren = h.readInvocations().filter((i) => i.agent === 'content-lead' && i.env && i.env.RUNDOCK_CONVO_ID === convoId);
    assert.deepStrictEqual(wren.map((i) => i.resume), ['ds-freshok-dead', null], 'sanity: the dead id was refused and Wren started fresh');
    assertNoLine(seen, convoId);
    assertHandedBack(seen, convoId);
    h.reapConvo(convoId);
  });

  test('exit code 0 after a successful result and no marker is no stop, and Cos is told Wren completed their work', async () => {
    h.clearInvocations();
    h.clearPrompts();
    routeToWren('ds-clean', [{ match: { promptIncludes: 'ds-clean brief' }, exitAfterTurn: 0,
      turn: [{ text: 'DS-CLEAN the post is drafted' }] }]);
    const { convoId, since } = startConversation('ds-clean');
    const seen = await untilClosed(convoId, since);
    assertNoLine(seen, convoId);
    assertHandedBack(seen, convoId);
    assert.ok(await h.waitUntil(() => h.promptsFor('chief-of-staff').some((p) => p.includes('[SYSTEM:'))),
      'Cos, started again, was written to');
    const prompt = h.promptsFor('chief-of-staff').find((p) => p.includes('[SYSTEM:'));
    assert.ok(prompt.includes('[SYSTEM: pipeline-complete] content-lead completed their work.'), `the prompt main writes: ${prompt}`);
    assert.ok(!prompt.includes('[SYSTEM: delegate-failed]'), prompt);
    h.reapConvo(convoId);
  });

  test('an earlier turn that ended on an error result is no stop when the last turn succeeded', async () => {
    h.clearInvocations();
    routeToWren('ds-recover', [
      { match: { promptIncludes: 'ds-recover again' }, exitAfterTurn: 0, turn: [{ text: 'DS-RECOVER-SECOND the post is drafted' }] },
      { match: { promptIncludes: 'ds-recover brief' }, isError: true, turn: [{ text: 'DS-RECOVER-FIRST the tool run hit a snag' }] },
    ]);
    const { convoId, since } = startConversation('ds-recover');
    await waitForResult(convoId, 'DS-RECOVER-FIRST', since, 'Wren\'s first turn ended on an error result');
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-recover again' });
    const seen = await untilClosed(convoId, next);
    assertNoLine(seen, convoId);
    assertHandedBack(seen, convoId);
    h.reapConvo(convoId);
  });
});

// NO LINE WHERE THE CLOSE IS NOT WREN'S TO REPORT. A start that failed has
// already said so with its own notice, and a process the idle sweep released
// is no longer the conversation's. Either close returns before deciding
// anything, so it sends no line and stores none.
describe('no line when the close is not Wren\'s to report', () => {
  test('a delegate that could not be started sends no line, and the start error is its only notice', async () => {
    h.clearInvocations();
    const claude = require(path.join(ROOT, 'lib', 'runtime', 'claude.js'));
    let closed = false;
    // Wren's start in this conversation, and nothing else, names a program
    // that is not there, so it fails the way a missing install does: an
    // error, then a close.
    const prev = claude.wireClaudeRuntimeDeps({
      spawn: (program, args, opts) => {
        const at = args.indexOf('--agent');
        const convo = String((opts && opts.env && opts.env.RUNDOCK_CONVO_ID) || '');
        if (at < 0 || args[at + 1] !== 'content-lead' || !convo.startsWith('ds-nostart-')) return prev.spawn(program, args, opts);
        const proc = prev.spawn(path.join(h.workspaceDir, 'no-such-claude'), args, opts);
        proc.once('close', () => { closed = true; });
        return proc;
      },
    });
    try {
      const { convoId, since } = await delegateFromLiveCos('ds-nostart', { turn: [{ text: 'DS-NOSTART never said' }] });
      assert.ok(await h.waitUntil(() => closed, { timeout: 20000 }), 'Wren\'s process closed');
      const seen = await settled(convoId, since);
      const notices = seen.filter((m) => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId
        && /Claude Code not found/.test(m.content || ''));
      assert.strictEqual(notices.length, 1, 'sanity: the start error said Wren could not be started');
      assertNoLine(seen, convoId);
      assert.deepStrictEqual(seen.filter(isReturnTo(convoId)).filter((m) => m.failed), [], 'no switch says Wren stopped');
      h.reapConvo(convoId);
    } finally {
      claude.wireClaudeRuntimeDeps({ spawn: prev.spawn });
    }
  });

  test('a delegate the idle sweep released sends no line, though its last turn ended on an error result', async () => {
    h.clearInvocations();
    routeToWren('ds-reaped', [{ match: { promptIncludes: 'ds-reaped brief' }, isError: true,
      turn: [{ text: 'DS-REAPED-FIRST the tool run hit a snag' }] }]);
    const { convoId, since } = startConversation('ds-reaped');
    await waitForResult(convoId, 'DS-REAPED-FIRST', since, 'Wren\'s turn ended on an error result');
    assert.ok(await h.waitUntil(() => {
      const e = h.internal.chatProcesses.get(convoId);
      return Boolean(e && e.agentId === 'content-lead' && e.idle === true && e.idleSince);
    }), 'Wren is idle, waiting for the person');
    const wren = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(wren.lastTurnOutcome, 'error', 'sanity: a close read now would be a stop');
    let closed = false;
    wren.process.once('close', () => { closed = true; });
    h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
    assert.ok(await h.waitUntil(() => closed, { timeout: 20000 }), 'the sweep released Wren\'s process');
    assert.notStrictEqual(h.internal.chatProcesses.get(convoId), wren, 'sanity: Wren is no longer the conversation\'s process');
    const seen = await settled(convoId, since);
    assertNoLine(seen, convoId);
    assert.deepStrictEqual(seen.filter(isReturnTo(convoId)), [], 'and no switch');
  });
});
