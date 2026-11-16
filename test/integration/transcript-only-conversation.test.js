'use strict';
// A CONVERSATION KEPT BY ITS TRANSCRIPT ALONE OPENS WITH ITS TURNS.
//
// Claude Code removes old session files, and a conversation whose every stored
// session id was forgotten is still kept, for its transcript
// (lib/protocol/handlers/conversations.js). Opened, it showed its title and an
// empty body: the view asked for history only when it held a session id, and
// the history handler merged the transcript only beside session ids.
//
// Driven the way the window drives it, on a document: the conversation list the
// real server sends is handed to the conversation view
// (public/views/conversations.js), which opens it; what the view asks for goes
// over the socket to the real server and its history handler; the answer goes
// to the renderer the window's socket hands it to (public/views/chat.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');
const { createState, reduce } = require('../../public/conversation-state.js');

const ROOT = path.join(__dirname, '..', '..');

let client;
let view;
let chat;
const viewSent = [];

before(async () => {
  await h.boot();
  client = await h.connect();
  // The document, after the server has booted, so nothing it loads sees it.
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="messages"></div><div id="chat-status"></div><textarea id="msg-input"></textarea>'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div>'
    + '<div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>'
    + '</body></html>');
  const convoState = {};
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    ws: { readyState: 1, send: (s) => viewSent.push(JSON.parse(s)) },
    agents: h.internal.discoverAgents().map((a) => ({ ...a, status: 'onTeam' })),
    conversations: [],
    activeConversation: null,
    conversationsLoaded: false,
    lastActiveConversationId: null,
    pendingActiveProcesses: null,
    pendingMessageAnchor: null,
    activeSidebarPill: null,
    convoState,
    getConvoState: (id) => (convoState[id] || (convoState[id] = { activeAgentId: null, isProcessing: false })),
    unread: { clearConvo() {}, ids: () => new Set(), isUnread: () => false },
    updateUnreadBadge() {},
    persistLastActiveConversation() {},
    closeFindBar() {},
    showView() {},
    switchNav() {},
    renderConvoList() {},
    tryMessageAnchor() {},
    // The app opens the conversation it was last in; here, the only one listed.
    pickDefaultConversation: () => global.conversations.find((c) => c.status !== 'archived') || null,
    esc: (t) => String(t),
    formatMd: (t) => String(t),
    userScrolledUp: false,
    RundockConvoList: { partitionConversations: () => ({ main: [], archived: [] }), itemVariant: () => '' },
    RundockChatMarkup: require(path.join(ROOT, 'public', 'chat-markup.js')),
    restoredActiveAgentId: require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId,
  });
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.stripRundockMarkers = (t) => require(path.join(ROOT, 'public', 'markers.js')).stripMarkers(String(t || ''));
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  // Approval cards are not what this is about, and need the permissions module.
  global.renderPendingPermissionCards = () => {};
  view = require(path.join(ROOT, 'public', 'views', 'conversations.js'));
});
after(h.shutdown);

/** The conversation list as the server sends it to a window that has just loaded. */
async function listed() {
  const since = client.messages.length;
  client.send({ type: 'get_conversations' });
  const { msg } = await client.waitFor((m) => m.type === 'conversations', { since, label: 'the conversation list' });
  return msg.conversations;
}

/**
 * A window loading: the view is handed the server's list and opens the
 * conversation, every history request it makes goes to the server, and every
 * answer is drawn by the renderer the socket hands it to. Returns what the view
 * asked for.
 */
async function windowOpens(convoId) {
  global.conversations = [];
  global.activeConversation = null;
  document.getElementById('messages').innerHTML = '';
  viewSent.length = 0;
  view.handlePersistedConversations((await listed()).filter((c) => c.id === convoId), convoId);
  const asked = viewSent.filter((m) => m.type === 'get_session_history');
  for (const request of asked) {
    const since = client.messages.length;
    client.send(request);
    const { msg } = await client.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId,
      { since, label: 'the history the view asked for' });
    chat.renderSessionHistory(msg);
  }
  return asked;
}

/** What the person reads, in order: who said it, and what. */
function shown() {
  return [...document.getElementById('messages').children]
    .filter((el) => /\bmsg-(user|agent)\b/.test(el.className))
    .map((el) => (el.className.includes('msg-user') ? 'person: ' : 'agent: ')
      + el.querySelector('.msg-bubble').textContent.replace(/\s+/g, ' ').trim());
}

function seed(convoId, record, transcript) {
  const all = h.internal.readConversations().filter((c) => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(), ...record }, ...all]);
  // A copy: the server appends to the list it holds.
  h.internal.convoTranscripts.set(convoId, transcript.map((t) => ({ ...t })));
  h.internal.saveTranscript(convoId);
}

const TURNS = [
  { role: 'user', agent: 'user', text: 'PLAN-ONE plan the launch', timestamp: '2026-10-01T09:00:00.000Z' },
  { role: 'agent', agent: 'chief-of-staff', text: 'ROUTE-ONE I will pull the timeline together.', timestamp: '2026-10-01T09:00:10.000Z' },
  { role: 'user', agent: 'user', text: 'BUDGET-TWO and the budget?', timestamp: '2026-10-01T09:05:00.000Z' },
  { role: 'agent', agent: 'content-lead', text: 'ANSWER-TWO The budget is in the second tab.', timestamp: '2026-10-01T09:05:30.000Z' },
];

describe('a conversation whose sessions are all gone, kept for its transcript', () => {
  test('opens with its transcript turns, in order, attributed', async () => {
    const convoId = h.freshConvoId('transcript-only');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: null, sessionIds: [] }, TURNS);

    const asked = await windowOpens(convoId);

    assert.strictEqual(asked.length, 1, 'the view asks for the conversation\'s history');
    assert.deepStrictEqual(asked[0].sessionIds, [], 'with no session to name');
    assert.deepStrictEqual(shown(), [
      'person: PLAN-ONE plan the launch',
      'agent: ROUTE-ONE I will pull the timeline together.',
      'person: BUDGET-TWO and the budget?',
      'agent: ANSWER-TWO The budget is in the second tab.',
    ], 'the body shows the turns the transcript holds');
    const agentRows = [...document.querySelectorAll('#messages .msg-agent')];
    const nameOf = (id) => global.agents.find((a) => a.id === id).displayName;
    assert.ok(agentRows[0].textContent.includes(nameOf('chief-of-staff')), 'each reply carries whoever said it');
    assert.ok(agentRows[1].textContent.includes(nameOf('content-lead')), 'the specialist\'s reply is its own');
    h.reapConvo(convoId);
  });

  test('a message sent after opening it is answered, and the earlier turns stay in view', async () => {
    // The next step a person takes. The reply starts a session, so the
    // conversation holds a session id again; opened after that, its earlier
    // turns, which no session file holds, must still be shown before the new one.
    const convoId = h.freshConvoId('transcript-only-next');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: null, sessionIds: [] }, TURNS);
    h.writeScenario([{ match: { promptIncludes: 'FOLLOW-THREE' }, turn: [{ text: 'REPLY-THREE The launch is on the fourth.' }] }]);
    await windowOpens(convoId);
    assert.strictEqual(shown().length, 4, 'opened with its turns');

    // Sent as the window sends it: to the agent in charge, resuming nothing.
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'FOLLOW-THREE when is it?' });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && /REPLY-THREE/.test(m.result || ''),
      { since, label: 'the reply', timeout: 15000 });

    // The window records the session the reply started, with the real rules.
    let state = Object.assign(createState(), { activeAgentId: 'chief-of-staff' });
    const record = { id: convoId, agentId: 'chief-of-staff', sessionId: null, sessionIds: [], title: convoId };
    for (const m of client.messages.slice(since)) {
      if (m._conversationId !== convoId || m.type !== 'system' || m.subtype !== 'init' || !m._sessionId) continue;
      const r = reduce(state, m, { convoExists: true, convoAgentId: record.agentId, hasPrimarySession: !!record.sessionId,
        knownSessionIds: record.sessionIds.map((s) => s.sessionId) });
      state = r.state;
      for (const ef of r.effects) {
        if (ef.type !== 'set-session') continue;
        if (ef.setPrimary) record.sessionId = ef.sessionId;
        if (ef.addToChain) record.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
      }
    }
    assert.ok(record.sessionId, 'the reply started a session the window keeps');
    client.send({ type: 'save_conversation', conversation: { ...record, activeAgentId: 'chief-of-staff', status: 'active' } });

    const asked = await windowOpens(convoId);
    assert.deepStrictEqual(asked[0].sessionIds.map((s) => s.sessionId), record.sessionIds.map((s) => s.sessionId),
      'opened again, it asks by the session it now holds');
    assert.deepStrictEqual(shown(), [
      'person: PLAN-ONE plan the launch',
      'agent: ROUTE-ONE I will pull the timeline together.',
      'person: BUDGET-TWO and the budget?',
      'agent: ANSWER-TWO The budget is in the second tab.',
      'person: FOLLOW-THREE when is it?',
      'agent: REPLY-THREE The launch is on the fourth.',
    ], 'the earlier turns, then the new one');
    h.reapConvo(convoId);
  });
});

describe('a conversation with sessions opens as it always has', () => {
  test('the view asks by its sessions, exactly as before', async () => {
    const convoId = h.freshConvoId('with-sessions');
    seed(convoId, { agentId: 'chief-of-staff', sessionId: 'sess-kept-1', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'sess-kept-1' }] }, TURNS);
    const asked = await windowOpens(convoId);
    assert.deepStrictEqual(asked.map((m) => ({ ...m })), [{
      type: 'get_session_history', sessionId: 'sess-kept-1', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'sess-kept-1' }],
      conversationId: convoId, limit: 200,
    }]);
    assert.strictEqual(shown().length, 4, 'and the transcript still orders what it shows');
    h.reapConvo(convoId);
  });

  test('a conversation with neither sessions nor a transcript asks for nothing', async () => {
    const convoId = h.freshConvoId('never-used');
    const all = h.internal.readConversations().filter((c) => c.id !== convoId);
    h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', agentId: 'chief-of-staff',
      sessionId: null, sessionIds: [], createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }, ...all]);
    const asked = await windowOpens(convoId);
    assert.deepStrictEqual(asked, [], 'there is nothing to show, so nothing is asked for');
  });
});
