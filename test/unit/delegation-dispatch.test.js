'use strict';
// The message a restored conversation actually sends.
//
// WHY THIS EXISTS SEPARATELY FROM THE RULE'S OWN TESTS. The rule module says
// which agent a restored conversation is pointed at. That is a claim about a
// pure function, and an earlier round of this work proved exactly that and
// nothing more, while the product still sent the next message to the
// orchestrator: the runtime state the send reads was never seeded from the rule.
// A helper returning the right answer is not the same as the right answer
// reaching the wire.
//
// So this drives the REAL dispatchMessage from public/views/chat.js and reads
// the payload it puts on the socket. The module is UMD and Node-requireable; it
// reaches its collaborators through the global lexical environment, which is
// what the stubs below provide.

const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { JSDOM } = require('jsdom');
const { restoredActiveAgentId } = require(path.join(ROOT, 'public', 'delegation-restore.js'));

const sent = [];
const convoState = {};

// A DOM, because chat.js defines its own startProcessing and that one paints.
// Only the elements the send path reaches are needed; the rest resolve to null
// and the code already guards for that.
const dom = new JSDOM('<!doctype html><html><body>'
  + '<div id="messages"></div><div id="chat-messages"></div><div id="chat-convo-status"></div>'
  + '<input id="msg-input"><button id="send-btn"></button>'
  + '</body></html>');
global.document = dom.window.document;
global.window = dom.window;
// jsdom does not implement scrolling, and the view scrolls.
dom.window.Element.prototype.scrollIntoView = function () {};

// The view reaches this by name, exactly as it does in the browser where
// delegation-restore.js attaches it to the window. Requiring it in the test is
// not enough: the module resolves it from the global environment at call time.
global.restoredActiveAgentId = restoredActiveAgentId;

// The collaborators chat.js reaches by name. Installed before it is required,
// because the module captures nothing at load time and resolves each at call
// time, which is what makes this drivable at all.
global.WebSocket = { OPEN: 1 };
global.workingConvos = new Set();
global.conversations = [];
global.activeConversation = null;
global.userScrolledUp = false;
global.unread = {};
global.agentLastActivity = {};
global.RundockConversationState = { watchdogVerdict: () => ({ action: 'stop' }) };
global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
global.esc = (t) => String(t);
global.formatMd = (t) => String(t);
global.formatTimeAgo = () => '';
global.stripRundockMarkers = (t) => String(t);
global.updateUnreadBadge = () => {};
global.updateWorkingBadge = () => {};
global.tryMessageAnchor = () => {};
global.scrollBottom = () => {};
global.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
global.getConvoState = (id) => (convoState[id] = convoState[id] || {});
global.addUserMsg = () => {};
global.startProcessing = () => {};
global.renderConvoList = () => {};
global.persistConversation = () => {};

const { dispatchMessage, renderSessionHistory } = require(path.join(ROOT, 'public', 'views', 'chat.js'));

function restoredConversation(extra) {
  return {
    id: 'c1',
    agentId: 'chief-of-staff',
    activeAgentId: 'lead-developer',
    sessionId: 's-orchestrator',
    sessionIds: [
      { agentId: 'chief-of-staff', sessionId: 's-orchestrator' },
      { agentId: 'lead-developer', sessionId: 's-specialist' },
    ],
    messages: [],
    ...extra,
  };
}

/**
 * Open the conversation through the REAL view code that opens one.
 *
 * An earlier version of this file hand-wrote the two lines renderSessionHistory
 * runs, and every assertion below then ran against that stand-in. It proved
 * dispatchMessage routes correctly GIVEN correct state, and proved nothing
 * about the state ever being set. The double was never checked against the
 * function it stood in for, which is the failure this whole card is about.
 */
function openWithNoLiveProcess(convo) {
  global.conversations = [convo];
  const state = global.getConvoState(convo.id);
  state.activeProcessId = null;
  // The shape the server sends for get_session_history. No messages, because
  // what is under test is the pointer, not the rendering.
  renderSessionHistory({ conversationId: convo.id, messages: [], hasMore: false });
  return state;
}

describe('a restored conversation sends to the agent that owns it', () => {
  beforeEach(() => { sent.length = 0; for (const k of Object.keys(convoState)) delete convoState[k]; });
  // The real startProcessing installs a watchdog interval. Left running it
  // holds the event loop open long after the assertion is done, and the suite
  // never exits.
  afterEach(() => {
    for (const st of Object.values(convoState)) {
      if (st && st.processingTimeout) { clearInterval(st.processingTimeout); st.processingTimeout = null; }
    }
  });
  after(() => { dom.window.close(); });

  test('in flight when the app quit: the message goes to the specialist', () => {
    // The reported bug, at the point it bites. Before this, the server kept the
    // pointer on disk and the client still addressed the orchestrator, so the
    // orchestrator re-asked for work already delivered.
    const convo = restoredConversation();
    openWithNoLiveProcess(convo);
    dispatchMessage(convo, 'carry on');
    assert.strictEqual(sent.length, 1, 'one chat message went to the socket');
    assert.strictEqual(sent[0].agent, 'lead-developer',
      `the message is addressed to the specialist (got ${sent[0].agent})`);
  });

  test('and it resumes the specialist session, not the orchestrator one', () => {
    // Addressing the right agent with the wrong session resumes the wrong
    // context, which looks the same to the user as the bug being fixed.
    const convo = restoredConversation();
    openWithNoLiveProcess(convo);
    dispatchMessage(convo, 'carry on');
    assert.strictEqual(sent[0].sessionId, 's-specialist',
      `the specialist's own session is resumed (got ${sent[0].sessionId})`);
  });

  test('after an observed handback: the message goes to the orchestrator', () => {
    const convo = restoredConversation({ delegationReturned: true });
    openWithNoLiveProcess(convo);
    dispatchMessage(convo, 'what did they say');
    assert.strictEqual(sent[0].agent, 'chief-of-staff',
      'a finished delegation hands the conversation back to its owner');
    assert.strictEqual(sent[0].sessionId, 's-orchestrator');
  });

  test('a conversation that was never delegated sends to its own agent', () => {
    const convo = restoredConversation({ activeAgentId: null });
    openWithNoLiveProcess(convo);
    dispatchMessage(convo, 'hello');
    assert.strictEqual(sent[0].agent, 'chief-of-staff');
  });
});

describe('the view seeds that state from the shared rule', () => {
  // Bound rather than driven: renderSessionHistory needs a document, and what
  // has to hold is narrower than a DOM. If the seeding is removed or replaced
  // with a local copy of the rule, the dispatch tests above keep passing,
  // because they seed the state themselves. This is the line that says the
  // product does what those tests assume.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'views', 'chat.js'), 'utf8');

  test('renderSessionHistory sets the active agent from restoredActiveAgentId', () => {
    const at = src.indexOf('function renderSessionHistory');
    assert.ok(at > -1, 'the view still has the function that opens a conversation');
    // Bounded by the function, not by a byte count: this one is long, and a
    // fixed window silently stops covering it the moment it grows.
    const next = src.indexOf('\nfunction ', at + 1);
    const body = src.slice(at, next > -1 ? next : src.length);
    assert.match(body, /state\.activeAgentId = restoredActiveAgentId\(convo\)/,
      'the runtime state a send reads is seeded from the one shared rule, not from a second copy');
  });
});
