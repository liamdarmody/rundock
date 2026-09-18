'use strict';
// READING A CONVERSATION BACK IS NOT THE MOMENT SOMEBODY ARRIVED.
//
// A divider is a notification, not content. It tells the person, as it is
// happening, that somebody new has taken the work. Replay is not that moment,
// and every bubble already carries the avatar and the name of whoever is
// speaking, so a reopened conversation reads as what it is: several agents and
// a person talking.
//
// This also removes a class of defect rather than fixing one. Replay used to
// infer where a handover had been by comparing each message's agent to the
// last, and the other replay path inferred nothing, so the two disagreed: a
// conversation showed five handover markers live and none after a reload,
// reported from real use. Inferring in neither place is why that cannot
// come back.
//
// What survives replay is the session boundary, which is a different thing: it
// says what is being resumed when a conversation is reopened, and it is about
// the conversation rather than about who is in it.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

let chat, dom;
before(() => {
  dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span>'
    + '<span id="chat-agent-avatar"></span><input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div><div id="thinking-indicator"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  global.getConvoState = () => ({ currentStreamingMsg: null, isProcessing: false });
  global.renderConvoList = () => {};
  global.tryMessageAnchor = () => {};
  global.persistLastActiveConversation = () => {};
  global.pendingMessageAnchor = null;
  global.RundockConvoList = { render: () => {}, preview: () => '' };
  global.switchNav = () => {};
  global.unread = { clear() {}, clearConvo() {}, markPermission() {}, ids: () => new Set(), has: () => false };
  global.activeSidebarPill = null;
  global.setActiveAgentPill = () => {};
  global.renderConvoList = () => {};
  global.updateUnreadBadge = () => {};
  global.renderPendingPermissionCards = () => {};
  global.createHistoryDivider = chatMod => null;
  global.agents = [
    { id: 'default', displayName: 'Roo', type: 'orchestrator' },
    { id: 'research-lead', displayName: 'Ren', type: 'specialist' },
    { id: 'fact-checker', displayName: 'Sage', type: 'specialist' },
    { id: 'vox', displayName: 'Vox', type: 'specialist' },
  ];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
});

// The chain from the reported conversation, shortened: the work goes down two
// levels and comes back up the same way, so six changes of agent.
const CHAIN = [
  { role: 'user', content: 'do the thing', timestamp: '2026-09-14T09:16:00Z' },
  { role: 'assistant', agentId: 'default', content: 'Handing to Vox.', timestamp: '2026-09-14T09:16:01Z' },
  { role: 'assistant', agentId: 'vox', content: 'Not mine, handing back.', timestamp: '2026-09-14T09:16:02Z' },
  { role: 'assistant', agentId: 'default', content: 'I will do it then.', timestamp: '2026-09-14T09:16:03Z' },
  { role: 'assistant', agentId: 'research-lead', content: 'Handing to Sage.', timestamp: '2026-09-14T09:17:00Z' },
  { role: 'assistant', agentId: 'fact-checker', content: 'Verified.', timestamp: '2026-09-14T09:19:00Z' },
  { role: 'assistant', agentId: 'research-lead', content: 'Sage signed off.', timestamp: '2026-09-14T09:22:00Z' },
  { role: 'assistant', agentId: 'default', content: 'Here it is.', timestamp: '2026-09-14T09:22:30Z' },
];

function replay(messages, opts = {}) {
  document.getElementById('messages').innerHTML = '';
  const convo = { id: 'c1', agentId: 'default', agent: global.agents[0], messages: [] };
  global.conversations = [convo];
  global.activeConversation = convo;
  chat.renderSessionHistory({
    conversationId: 'c1', messages, hasMore: false, totalCount: messages.length, ...opts,
  });
  return convo;
}
const rows = () => [...document.getElementById('messages').children];

describe('who is announced, on the document, through the real executor', () => {
  // AA-1 and AA-2 at the surface. The reducer decides and the executor draws,
  // and only running both says what a person sees.
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
  function executor(name) {
    const key = `'${name}': (convoId, ef) => {`;
    const at = APP.indexOf(key);
    assert.ok(at > -1, `app.js still defines the ${name} executor`);
    let i = at + key.length - 1, depth = 0;
    for (; i < APP.length; i++) {
      if (APP[i] === '{') depth++;
      else if (APP[i] === '}') { depth--; if (depth === 0) break; }
    }
    // eslint-disable-next-line no-new-func
    return new Function('convoId', 'ef', APP.slice(at + key.length, i));
  }
  const CTX = { isActive: true, convoAgentId: 'default', toAgentExists: true, fromAgentExists: true, toAgentType: 'specialist' };

  function run(message) {
    document.getElementById('messages').innerHTML = '';
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1', agentId: 'default' };
    const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
    const draw = executor('show-delegation-divider');
    const r = cs.reduce(cs.createState(), message, CTX);
    for (const ef of r.effects) if (ef.type === 'show-delegation-divider') draw('c1', ef);
    return rows().filter((el) => el.className.includes('msg-delegation'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
  }

  test('somebody arriving to take the work is announced by name', () => {
    const drawn = run({ type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'default', toAgent: 'vox' });
    assert.strictEqual(drawn.length, 1, 'one announcement');
    assert.match(drawn[0], /Vox joined/, 'naming who now has the work');
  });

  test('a handback to a mid-level lead announces nothing', () => {
    // THE REPORTED CASE. Ren is a specialist, so a rule keyed on the
    // destination being the orchestrator called this an arrival and announced
    // an agent that had the work all along.
    const drawn = run({ type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'fact-checker', toAgent: 'research-lead', returning: true });
    assert.deepStrictEqual(drawn, [],
      'Ren already had the work; announcing her arrival is announcing something that did not happen');
  });

  test('a handback to the orchestrator announces nothing either', () => {
    const drawn = run({ type: 'system', subtype: 'agent_switch', _conversationId: 'c1', _processId: 'p1',
      fromAgent: 'vox', toAgent: 'default', returning: true, });
    assert.deepStrictEqual(drawn, [], 'the same rule, and one rule rather than two');
  });
});

describe('coming back to a conversation draws what a reload draws', () => {
  // AA-3 ON THE DOCUMENT, through the loop a navigation actually uses.
  // replayConversationInto is what openConversation calls to rebuild the thread
  // from the conversation's own messages, which is the path taken when you
  // click away and click back.
  const convos = require(path.join(ROOT, 'public', 'views', 'conversations.js'));

  function openWith(messages, historyCount = 0) {
    document.getElementById('messages').innerHTML = '';
    const convo = { id: 'c1', agentId: 'default', agent: global.agents[0], messages, _historyCount: historyCount };
    global.conversations = [convo];
    global.activeConversation = convo;
    convos.replayConversationInto(document.getElementById('messages'), convo);
    return convo;
  }

  const STORED = CHAIN.map((m) => ({
    role: m.role === 'user' ? 'user' : 'agent',
    content: m.content, agentId: m.agentId || 'default', timestamp: m.timestamp,
  }));

  test('no handover markers appear when the conversation is reopened', () => {
    openWith(STORED.map((m) => ({ ...m })));
    const drawn = rows().filter((el) => el.className.includes('msg-delegation'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    assert.deepStrictEqual(drawn, [],
      'reopening is re-reading, and re-reading is not the moment anyone arrived');
  });

  test('and every turn is still drawn, in order, attributed', () => {
    openWith(STORED.map((m) => ({ ...m })));
    const drawn = rows().filter((el) => el.className.includes('msg-agent') || el.className.includes('msg-user'));
    assert.strictEqual(drawn.length, STORED.length,
      'nothing is lost by dropping the markers, which is the whole basis for dropping them');
  });

  test('a stored marker left from the old behaviour draws nothing', () => {
    // Anyone upgrading may still hold divider records in memory. There is no
    // branch that would draw one, so they cannot reappear on this path and not
    // on a reload.
    const withLegacy = [
      ...STORED.slice(0, 2).map((m) => ({ ...m })),
      { role: 'divider', agentId: 'vox', fromAgentId: 'default', isReturn: false },
      ...STORED.slice(2).map((m) => ({ ...m })),
    ];
    openWith(withLegacy);
    assert.deepStrictEqual(rows().filter((el) => el.className.includes('msg-delegation')).map((el) => el.textContent), [],
      'a record from the old behaviour is not a reason to draw');
  });

  test('the session boundary still appears here too', () => {
    // AA-6 on this path as well as the reload one: the two renders agree about
    // what survives, not just about what does not.
    openWith(STORED.map((m) => ({ ...m })), 3);
    const boundary = rows().filter((el) => /previous session/i.test(el.textContent || ''));
    assert.strictEqual(boundary.length, 1, 'reopening says where the earlier part ends');
  });
});

describe('an arrival is drawn once, as it happens, and is not kept', () => {
  // THE SAME RULE AT THE OTHER END. Navigating to another conversation and back
  // is the same intent as reloading, re-reading, and neither is the moment the
  // arrival happened. Recording the marker so it survived a navigation made the
  // two behave differently for no reason a person could predict: markers after
  // a navigation, none after a reload, on the same conversation.
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
  const CONV_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'conversations.js'), 'utf-8');

  test('drawing an arrival records nothing in the conversation', () => {
    const at = APP_SRC.indexOf("'show-delegation-divider': (convoId, ef) => {");
    assert.ok(at > -1, 'sanity: the executor is still the thing that draws an arrival');
    const body = APP_SRC.slice(at, APP_SRC.indexOf('\n  },', at));
    assert.ok(!/convo\.messages\.push/.test(body),
      'a drawn arrival that is also stored comes back on a navigation and not on a reload, '
      + 'which is the inconsistency this rule removes');
  });

  test('and the replay used when a conversation is opened draws none', () => {
    assert.ok(!/role===.divider.|role === .divider./.test(CONV_SRC),
      'nothing replays a handover marker, because nothing records one');
  });
});

describe('a reopened conversation reads as a thread, not as a log of handovers', () => {
  test('no handover markers are drawn, however many times the agent changed', () => {
    replay(CHAIN);
    const handovers = rows().filter((el) => el.className.includes('msg-delegation'));
    assert.deepStrictEqual(handovers.map((el) => (el.textContent || '').trim()), [],
      'six changes of agent and not one announcement: the avatars carry it');
  });

  test('and none are recorded, so nothing can draw them on a later render', () => {
    // The defect was markers that existed for exactly one render. Storing none
    // is what makes every render agree, rather than two paths agreeing today.
    const convo = replay(CHAIN);
    assert.deepStrictEqual(convo.messages.filter((m) => m.role === 'divider'), [],
      'the stored conversation carries turns, and turns are all it carries');
  });

  test('every turn is still there, attributed to whoever said it', () => {
    // The point of dropping the markers is that nothing is lost by it.
    const convo = replay(CHAIN);
    const turns = convo.messages.filter((m) => m.role === 'agent' || m.role === 'user');
    assert.strictEqual(turns.length, CHAIN.length, 'no turn dropped and none duplicated');
    assert.deepStrictEqual(turns.slice(1).map((m) => m.agentId),
      ['default', 'vox', 'default', 'research-lead', 'fact-checker', 'research-lead', 'default'],
      'and each one still says who is speaking, which is what replaces the markers');
    const drawn = rows().filter((el) => el.className.includes('msg-agent') || el.className.includes('msg-user'));
    assert.strictEqual(drawn.length, CHAIN.length, 'and all of them are on screen');
  });

  test('the session boundary survives, because it is about the conversation', () => {
    // Not a handover marker: it says what is being resumed when a conversation
    // is reopened, which is exactly the thing replay IS the moment for.
    replay(CHAIN, { hasMore: false });
    const boundary = rows().filter((el) => /previous session/i.test(el.textContent || ''));
    assert.strictEqual(boundary.length, 1,
      `the reopened conversation still says where the earlier part ends: ${JSON.stringify(rows().map((el) => el.className))}`);
  });
});
