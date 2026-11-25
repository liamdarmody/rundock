'use strict';
// A SAVED CONVERSATION LEFT BEFORE ITS HISTORY ARRIVES.
//
// A conversation saved from an earlier run holds no messages until it is
// opened, when the page asks the server for its history. Two things went wrong
// in the gap between the asking and the reply. Opening marked the conversation
// as unsaved at once, so switching to another one before the reply ran the
// empty-conversation cleanup on it and it vanished from the sidebar, and
// opening it by id (search, a link) then found nothing. And the reply, when it
// came, was drawn into whichever conversation was on screen, so one
// conversation's messages read as part of another's.
//
// Driven through the real view functions under jsdom: openConversation and the
// cleanup it runs on a switch, renderSessionHistory for the reply, the real
// sidebar for what a person sees in the list, and the real send path for a
// message typed while a history loads. Each reply is held by the test and
// handed in at the moment the test says it arrives.
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const load = (...parts) => require(path.join(ROOT, 'public', ...parts));

let dom, chat, convos, sent, navigations, anchorLooks;
before(() => {
  dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="convo-list"></div>'
    + '<input id="chat-title-input"><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>'
    + '<div id="chat-status"></div><div id="messages"></div>'
    + '<textarea id="msg-input"></textarea><button id="send-btn"></button>'
    + '</body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.stripMd = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  global.agents = [{ id: 'helper', displayName: 'Helper', colour: '#336699', icon: 'H', type: 'specialist' }];
  global.RundockChatMarkup = load('chat-markup.js');
  global.RundockMarkers = load('markers.js');
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = load('delegation-restore.js').restoredActiveAgentId;
  global.RundockConvoList = load('conversation-list.js');
  global.RundockPermissions = load('permissions.js');
  global.RundockConversationState = load('conversation-state.js');
  global.WebSocket = { OPEN: 1 };
  global.activeSidebarPill = 'all';
  global.conversationsLoaded = true;
  global.currentView = 'chat';
  global.pendingMessageAnchor = null;
  global.persistLastActiveConversation = () => {};
  global.updateUnreadBadge = () => {};
  global.updateWorkingBadge = () => {};
  global.closeFindBar = () => {};
  global.showView = () => {};
  chat = load('views', 'chat.js');
  convos = load('views', 'conversations.js');
  // The views reach each other, and the sidebar, through the global scope.
  Object.assign(global, chat, convos);
  Object.assign(global, require(path.join(ROOT, 'public', 'views', 'composer.js')));
});
after(() => { if (dom) dom.window.close(); });

// The page's connection to the server. Every request sent is written down
// with the connection it went out on, so a test can tell a request repeated
// on the same connection from one asked again after a reconnect.
function connection(name) {
  return { readyState: 1, send: (raw) => sent.push({ on: name, ...JSON.parse(raw) }) };
}

beforeEach(() => {
  sent = [];
  navigations = [];
  anchorLooks = [];
  global.ws = connection('first');
  global.switchNav = (nav) => navigations.push(nav);
  // The search palette's look for a matched message (palette.js), which
  // searches whatever view is on screen. Written down, not run.
  global.tryMessageAnchor = (id) => anchorLooks.push(id);
  global.pendingMessageAnchor = null;
  global.unread = load('unread-state.js').createUnreadState();
  global.convoState = {};
  global.getConvoState = (id) => (global.convoState[id] = global.convoState[id] || { currentStreamingMsg: null, isProcessing: false });
  global.workingConvos = new Set();
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.conversations = [];
  global.activeConversation = null;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('convo-list').innerHTML = '';
});

// ── Conversations and replies ─────────────────────────────────────────────

// Saved from an earlier run, in the shape the page builds from the saved list
// (handlePersistedConversations): no messages in memory, a session to ask
// for, and marked as saved.
function saved(id, title) {
  return {
    id, title, agentId: 'helper', agent: global.agents[0], messages: [], status: 'active',
    sessionId: `session-${id}`, sessionIds: [], pinned: false, listIds: [],
    lastActiveAt: '2026-03-02T10:00:00.000Z', lastMessagePreview: `Earlier in ${title}`,
    persisted: true,
  };
}
// Started in this run and already written in.
function current(id, title) {
  return {
    id, title, agentId: 'helper', agent: global.agents[0], status: 'active',
    lastActiveAt: '2026-03-03T10:00:00.000Z',
    messages: [
      { role: 'user', content: `Hello from ${id}` },
      { role: 'agent', content: `Reply in ${id}`, agentId: 'helper' },
    ],
  };
}
// Started in this run and never written in.
function fresh(id) {
  return { id, title: 'New conversation', agentId: 'helper', agent: global.agents[0], status: 'active', messages: [], lastActiveAt: '2026-03-04T10:00:00.000Z' };
}

// The server's reply to a history request, as it sends it.
function historyOf(id, extra) {
  return {
    conversationId: id, totalCount: 2, hasMore: false,
    messages: [
      { role: 'user', content: `Question asked in ${id}`, timestamp: '2026-03-01T09:00:00.000Z' },
      { role: 'assistant', agentId: 'helper', content: `Answer given in ${id}`, timestamp: '2026-03-01T09:00:05.000Z' },
    ],
    ...extra,
  };
}
const arrives = (reply) => chat.renderSessionHistory(reply);

// ── What a person sees, and does ──────────────────────────────────────────

const view = () => document.getElementById('messages');
const loadingLine = () => document.getElementById('history-loading');
const onScreen = () => global.activeConversation && global.activeConversation.id;
// How many message bubbles on screen carry this text.
const drawn = (text) => [...view().querySelectorAll('.msg')].filter((el) => el.textContent.includes(text)).length;
const historyAsks = (id) => sent.filter((m) => m.type === 'get_session_history' && m.conversationId === id);
const row = (id) => document.querySelector(`#convo-list .convo-item[data-convo-id="${id}"]`);
const inList = (id) => global.conversations.some((c) => c.id === id);
const convo = (id) => global.conversations.find((c) => c.id === id);

function world(...list) {
  global.conversations = list;
  convos.renderConvoList();
}
// What a click on a sidebar row does: the row carries the id, and its handler
// opens the conversation with it.
function openFromSidebar(id) {
  const r = row(id);
  assert.ok(r, `${id} has a row in the sidebar to open it from`);
  convos.openConversation(r.dataset.convoId);
}
// A message typed and sent in the conversation on screen, through the real
// send path. The turn it starts is ended at once: its reply plays no part
// here, and no watchdog timer is left running.
function sendOnScreen(text) {
  const id = onScreen();
  document.getElementById('msg-input').value = text;
  chat.sendMessage();
  const s = global.getConvoState(id);
  clearInterval(s.processingTimeout);
  s.processingTimeout = null;
  s.isProcessing = false;
  global.workingConvos.delete(id);
  const indicator = document.getElementById('thinking-indicator');
  if (indicator) indicator.remove();
}
function assertShowsHistoryOnce(id) {
  assert.strictEqual(onScreen(), id, `${id} is on screen`);
  assert.strictEqual(loadingLine(), null, 'no loading line is left');
  assert.strictEqual(drawn(`Question asked in ${id}`), 1, 'the question is drawn once');
  assert.strictEqual(drawn(`Answer given in ${id}`), 1, 'the answer is drawn once');
}

// ── The switch, cell by cell ──────────────────────────────────────────────

describe('a saved conversation left for another before its history arrives', () => {
  test('stays in the sidebar, and opening it from there shows its history', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'opening it asks for its history');
    openFromSidebar('live-b');
    arrives(historyOf('saved-a'));
    assert.ok(inList('saved-a'), 'still in the list');
    assert.ok(row('saved-a'), 'still has its row in the sidebar');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(drawn('live-b'), 0, 'nothing of the other conversation');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'the history it holds is shown, not asked for again');
  });

  for (const [how, withAnchor] of [['a link', undefined], ['a search result', true]]) {
    test(`opened by its id, as ${how} opens it, lands on it and shows its history`, () => {
      world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
      openFromSidebar('saved-a');
      openFromSidebar('live-b');
      arrives(historyOf('saved-a'));
      convos.openConversation('saved-a', withAnchor);
      assert.deepStrictEqual(navigations, [], 'it does not fall back to the Conversations section');
      assertShowsHistoryOnce('saved-a');
    });
  }

  test('its history arriving draws nothing into the conversation on screen, whose own loading line stays until its own history arrives', () => {
    world(saved('saved-a', 'Planning notes'), saved('saved-b', 'Budget'));
    openFromSidebar('saved-a');
    openFromSidebar('saved-b');
    assert.ok(loadingLine(), 'the conversation on screen shows it is loading');
    const before = view().innerHTML;
    arrives(historyOf('saved-a', { hasMore: true, totalCount: 40 }));
    assert.strictEqual(view().innerHTML, before, 'the view on screen is exactly as it was');
    assert.ok(loadingLine(), 'its loading line is still there');
    assert.strictEqual(drawn('saved-a'), 0, 'no message from the other conversation');
    assert.strictEqual(document.getElementById('history-load-more'), null, 'no "Load earlier messages" line');
    assert.strictEqual(document.getElementById('history-divider'), null, 'no divider');

    arrives(historyOf('saved-b'));
    assertShowsHistoryOnce('saved-b');
    assert.strictEqual(drawn('saved-a'), 0, 'still nothing from the other conversation');

    assert.deepStrictEqual(convo('saved-a').messages.map((m) => m.content),
      ['Question asked in saved-a', 'Answer given in saved-a'], 'the history that arrived is kept with its own conversation');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(drawn('saved-b'), 0, 'and nothing of the one it was left for');
  });

  test('switching back before its history arrives shows its loading line, asks once, and draws each message once when it lands', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('live-b');
    openFromSidebar('saved-a');
    assert.strictEqual(onScreen(), 'saved-a', 'it opens');
    assert.ok(loadingLine(), 'its loading line is shown');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'its history is asked for once');
    arrives(historyOf('saved-a'));
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(view().querySelectorAll('#history-divider').length, 1, 'one divider');
    assert.strictEqual(convo('saved-a').messages.length, 2, 'each message is kept once');
    openFromSidebar('live-b');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'still asked for once');
  });

  test('opened again while it is on screen and loading, it keeps its loading line and does not ask a second time', () => {
    world(saved('saved-a', 'Planning notes'));
    openFromSidebar('saved-a');
    openFromSidebar('saved-a');
    assert.ok(loadingLine(), 'its loading line is shown');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'its history is asked for once');
    arrives(historyOf('saved-a'));
    assertShowsHistoryOnce('saved-a');
  });

  test('opened from a search result while its history is on its way, it looks for the matched message once the history lands on screen', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('live-b');
    global.pendingMessageAnchor = { convoId: 'saved-a', text: 'Answer given' };
    convos.openConversation('saved-a', true);
    assert.ok(loadingLine(), 'its loading line is shown');
    assert.deepStrictEqual(anchorLooks, [], 'nothing to look in yet');
    arrives(historyOf('saved-a'));
    assertShowsHistoryOnce('saved-a');
    assert.deepStrictEqual(anchorLooks, ['saved-a'], 'looked for once it is drawn');
  });

  test('a search match left waiting for it is not looked for in the view on screen when its history arrives', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('live-b');
    // Left set by a search open of it; starting a new conversation does not clear it.
    global.pendingMessageAnchor = { convoId: 'saved-a', text: 'Answer given' };
    arrives(historyOf('saved-a'));
    assert.deepStrictEqual(anchorLooks, [], 'the view on screen is not searched for it');
  });

  test('two left loading for a third each keep their own history, and none of it is drawn in the third', () => {
    world(saved('saved-a', 'Planning notes'), saved('saved-b', 'Budget'), current('live-c', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('saved-b');
    openFromSidebar('live-c');
    const before = view().innerHTML;
    arrives(historyOf('saved-b'));
    arrives(historyOf('saved-a'));
    assert.strictEqual(view().innerHTML, before, 'the third is exactly as it was');
    assert.ok(row('saved-a') && row('saved-b'), 'both are still in the sidebar');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(drawn('saved-b'), 0);
    openFromSidebar('saved-b');
    assertShowsHistoryOnce('saved-b');
    assert.strictEqual(drawn('saved-a'), 0);
    assert.deepStrictEqual([historyAsks('saved-a').length, historyAsks('saved-b').length], [1, 1], 'each asked for once');
  });

  test('a message sent in the conversation switched to, before the left one\'s history arrives, is all that conversation shows', () => {
    world(saved('saved-a', 'Planning notes'), fresh('new-b'));
    openFromSidebar('saved-a');
    openFromSidebar('new-b');
    sendOnScreen('A first question here');
    arrives(historyOf('saved-a'));
    assert.strictEqual(drawn('A first question here'), 1, 'the message sent is drawn once');
    assert.strictEqual(drawn('saved-a'), 0, 'nothing of the other conversation');
    assert.ok(inList('new-b'), 'the conversation written in is kept');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
    assert.strictEqual(drawn('A first question here'), 0);
  });

  test('a message sent in it while its history loads is not drawn over when the history arrives after a switch, and the conversation on screen keeps its own loading line', () => {
    world(saved('saved-a', 'Planning notes'), saved('saved-b', 'Budget'));
    openFromSidebar('saved-a');
    sendOnScreen('A follow-up');
    openFromSidebar('saved-b');
    const before = view().innerHTML;
    arrives(historyOf('saved-a'));
    assert.strictEqual(view().innerHTML, before, 'the conversation on screen is exactly as it was');
    assert.ok(loadingLine(), 'its loading line is still there');
    openFromSidebar('saved-a');
    assert.strictEqual(drawn('A follow-up'), 1, 'the message sent is drawn once');
    assert.strictEqual(drawn('Question asked in saved-a') + drawn('Answer given in saved-a'), 0, 'the history is not drawn over it');
    assert.strictEqual(loadingLine(), null, 'no loading line is left');
  });

  test('a reply lost with its connection does not stop a later open from asking again on the new connection, once', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('live-b');
    // The connection drops before the reply comes, and the page reconnects.
    global.ws = connection('second');
    assert.ok(row('saved-a'), 'still in the sidebar while its reply is outstanding');
    openFromSidebar('saved-a');
    assert.ok(loadingLine(), 'its loading line is shown');
    assert.deepStrictEqual(historyAsks('saved-a').map((m) => m.on), ['first', 'second'], 'asked again on the new connection');
    openFromSidebar('live-b');
    openFromSidebar('saved-a');
    assert.deepStrictEqual(historyAsks('saved-a').map((m) => m.on), ['first', 'second'], 'and only once there');
    arrives(historyOf('saved-a'));
    assertShowsHistoryOnce('saved-a');
  });

  test('an empty reply, what the server sends when it cannot read a history, ends the wait: a later open shows no loading line and asks nothing more', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    openFromSidebar('live-b');
    arrives({ conversationId: 'saved-a', messages: [], totalCount: 0, hasMore: false });
    assert.ok(row('saved-a'), 'still in the sidebar');
    openFromSidebar('saved-a');
    assert.strictEqual(onScreen(), 'saved-a', 'it opens');
    assert.strictEqual(loadingLine(), null, 'no loading line waits on a reply that has come');
    assert.strictEqual(historyAsks('saved-a').length, 1, 'nothing more is asked');
  });
});

// ── What was dropped is still dropped, what was kept is still kept ────────

describe('leaving a conversation, as before', () => {
  test('a new conversation never written in is dropped when you switch away', () => {
    world(fresh('new-a'), current('live-b', 'Draft review'));
    openFromSidebar('new-a');
    openFromSidebar('live-b');
    assert.ok(!inList('new-a'), 'dropped from the list');
    assert.strictEqual(row('new-a'), null, 'and from the sidebar');
  });

  test('a new conversation holding an open card is kept', () => {
    world(fresh('new-a'), current('live-b', 'Draft review'));
    openFromSidebar('new-a');
    global.pendingPermissionsByConvo.set('new-a', new Map([['req-1', { request_id: 'req-1' }]]));
    openFromSidebar('live-b');
    assert.ok(inList('new-a'), 'kept in the list');
    assert.ok(row('new-a'), 'and in the sidebar');
  });

  test('a saved conversation whose history arrived while open, holding a message from the person, is kept', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    arrives(historyOf('saved-a'));
    openFromSidebar('live-b');
    assert.ok(inList('saved-a'), 'kept in the list');
    openFromSidebar('saved-a');
    assertShowsHistoryOnce('saved-a');
  });

  test('a message sent while its history loads stops the history being drawn over it', () => {
    world(saved('saved-a', 'Planning notes'));
    openFromSidebar('saved-a');
    sendOnScreen('A follow-up');
    arrives(historyOf('saved-a', { hasMore: true, totalCount: 40 }));
    assert.strictEqual(drawn('A follow-up'), 1, 'the message sent is drawn once');
    assert.strictEqual(drawn('Question asked in saved-a') + drawn('Answer given in saved-a'), 0, 'the history is not drawn over it');
    assert.strictEqual(document.getElementById('history-load-more'), null, 'no "Load earlier messages" line');
    assert.strictEqual(document.getElementById('history-divider'), null, 'no divider');
    assert.strictEqual(loadingLine(), null, 'the loading line is gone');
  });

  test('"Load earlier messages" loads into the conversation on screen', () => {
    world(saved('saved-a', 'Planning notes'));
    openFromSidebar('saved-a');
    arrives(historyOf('saved-a', { hasMore: true, totalCount: 3 }));
    const more = document.getElementById('history-load-more');
    assert.ok(more, 'the line is drawn');
    more.click();
    const ask = historyAsks('saved-a').pop();
    assert.deepStrictEqual([ask.limit, ask.offset], [20, 2], 'it asks for the page before the messages shown');
    arrives({
      conversationId: 'saved-a', totalCount: 3, hasMore: false,
      messages: [{ role: 'user', content: 'An earlier question in saved-a', timestamp: '2026-02-28T09:00:00.000Z' }],
    });
    const bubbles = [...view().querySelectorAll('.msg')].map((el) => el.textContent);
    assert.ok(bubbles[0].includes('An earlier question in saved-a'), 'the earlier message is drawn first');
    assert.strictEqual(drawn('An earlier question in saved-a'), 1, 'once');
    assert.strictEqual(document.getElementById('history-load-more'), null, 'the line goes once nothing more is left');
    assert.strictEqual(convo('saved-a').messages[0].content, 'An earlier question in saved-a', 'and it is kept first');
  });

  test('a plain open asks for up to 200 messages, and an open from a search result for up to 999', () => {
    world(saved('saved-a', 'Planning notes'), saved('saved-b', 'Budget'));
    convos.openConversation('saved-a');
    convos.openConversation('saved-b', true);
    assert.deepStrictEqual(sent.filter((m) => m.type === 'get_session_history').map((m) => [m.conversationId, m.limit]),
      [['saved-a', 200], ['saved-b', 999]]);
  });
});

// ── Its sidebar item ──────────────────────────────────────────────────────

describe('the sidebar item of a saved conversation left before its history arrives', () => {
  // The variant the list model gives it, and the one its drawn row shows: a
  // pin for a current item, archive for a previous one.
  function variantOf(id) {
    const r = row(id);
    assert.ok(r, `${id} has a row in the sidebar`);
    const drawnAs = r.querySelector('.convo-pin') ? 'current' : r.querySelector('.convo-archive') ? 'previous' : 'other';
    return [global.RundockConvoList.itemVariant(convo(id)), drawnAs];
  }

  test('changes when it is opened, not when its history arrives, and ends as one whose history arrived before it was left', () => {
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    const steps = [['saved', variantOf('saved-a')]];
    openFromSidebar('saved-a');
    steps.push(['opened', variantOf('saved-a')]);
    openFromSidebar('live-b');
    steps.push(['left', variantOf('saved-a')]);
    arrives(historyOf('saved-a'));
    steps.push(['history arrived', variantOf('saved-a')]);
    assert.deepStrictEqual(steps, [
      ['saved', ['previous', 'previous']],
      ['opened', ['current', 'current']],
      ['left', ['current', 'current']],
      ['history arrived', ['current', 'current']],
    ]);
    const leftFirst = row('saved-a').outerHTML;

    // The same conversation, its history arriving before it was left.
    world(saved('saved-a', 'Planning notes'), current('live-b', 'Draft review'));
    openFromSidebar('saved-a');
    arrives(historyOf('saved-a'));
    openFromSidebar('live-b');
    assert.strictEqual(leftFirst, row('saved-a').outerHTML, 'the two rows are the same');
  });
});
