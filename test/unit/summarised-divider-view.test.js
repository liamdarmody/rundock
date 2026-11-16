'use strict';
// The divider drawn where a long conversation was summarised to make room, on
// the page: its words, its glyph, the "Why?" button and the explanation it
// opens in place, where a reopened conversation draws it, and what it never
// is (a bubble, a separator, a message counted, anything drawn from text).
//
// Measured on the document through the real view functions, the pattern of
// team-line-view.test.js. Keys on a real button (Enter, Space) are proven in
// the browser by test/e2e/summarised-divider.spec.js, since a document
// without a browser does not turn a key into a click.
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const CHAT_CSS = read('public', 'styles', 'views', 'chat.css');

const WORDS = 'Earlier messages were summarised to make room';
const EXPLANATION = 'Long conversations are summarised so the agent can carry on. It keeps a summary of everything above, and may not recall every detail. For a new topic, start a new conversation.';

let chat;
let convos;
before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  global.getConvoState = () => ({ currentStreamingMsg: null, isProcessing: false });
  global.renderConvoList = () => {};
  global.tryMessageAnchor = () => {};
  global.setActiveAgentPill = () => {};
  global.renderPendingPermissionCards = () => {};
  global.agents = [{ id: 'example-writer', displayName: 'Alpha', type: 'specialist' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  convos = require(path.join(ROOT, 'public', 'views', 'conversations.js'));
});

const messages = () => document.getElementById('messages');
const parts = (divider) => ({
  row: divider.querySelector('.summarised-row'),
  label: divider.querySelector('.summarised-label'),
  why: divider.querySelector('button.summarised-why'),
  explain: divider.querySelector('.summarised-explain'),
  glyph: divider.querySelector('svg.summarised-glyph'),
});
const press = (el, key) => {
  const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('the divider, as drawn', () => {
  test('says the earlier messages were summarised to make room, with "Why?" after the words', () => {
    const { label, why } = parts(chat.createSummarisedDivider({ key: 'k1' }));
    assert.strictEqual(label.textContent, `${WORDS}Why?`);
    assert.strictEqual(why.textContent, 'Why?');
    assert.strictEqual(why.parentElement.textContent, 'roomWhy?', 'the last word and the button wrap together');
  });

  test('the fold glyph is chevrons, 12px, the app\'s 1.8 stroke, and hidden from screen readers', () => {
    const { glyph } = parts(chat.createSummarisedDivider({ key: 'k1' }));
    const attrs = Object.fromEntries(['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'aria-hidden', 'focusable'].map((n) => [n, glyph.getAttribute(n)]));
    assert.deepStrictEqual(attrs, { viewBox: '0 0 24 24', width: '12', height: '12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    assert.deepStrictEqual([...glyph.querySelectorAll('path')].map((p) => p.getAttribute('d')), ['m7 20 5-5 5 5', 'm7 4 5 5 5-5']);
    assert.strictEqual(glyph.parentElement.textContent, 'Earlier', 'the glyph and the first word wrap together');
  });

  test('"Why?" is a real button, starts shut, and names the explanation it opens', () => {
    const { why, explain } = parts(chat.createSummarisedDivider({ key: 'k1' }));
    assert.strictEqual(why.tagName, 'BUTTON');
    assert.strictEqual(why.getAttribute('type'), 'button');
    assert.strictEqual(why.getAttribute('aria-expanded'), 'false');
    assert.ok(explain.id, 'the explanation has an id');
    assert.strictEqual(why.getAttribute('aria-controls'), explain.id);
    assert.strictEqual(explain.hidden, true);
    assert.strictEqual(explain.textContent, EXPLANATION);
  });

  test('the row is not marked as a separator, since it holds a button', () => {
    const divider = chat.createSummarisedDivider({ key: 'k1' });
    assert.strictEqual(divider.querySelector('[role="separator"], hr'), null);
    assert.strictEqual(divider.getAttribute('role'), null);
    assert.strictEqual(parts(divider).row.getAttribute('role'), null);
  });

  test('two dividers each open their own explanation', () => {
    const one = chat.createSummarisedDivider({ key: 'k1' });
    const two = chat.createSummarisedDivider({ key: 'k2' });
    assert.notStrictEqual(parts(one).explain.id, parts(two).explain.id);
    parts(one).why.click();
    assert.strictEqual(parts(one).explain.hidden, false);
    assert.strictEqual(parts(two).explain.hidden, true);
    assert.strictEqual(parts(two).why.getAttribute('aria-expanded'), 'false');
  });
});

describe('"Why?" opens and closes in place', () => {
  let divider;
  beforeEach(() => {
    messages().replaceChildren();
    divider = chat.createSummarisedDivider({ key: 'k1' });
    messages().appendChild(divider);
  });

  test('a click opens the explanation beneath, a second shuts it, and the row and focus are as they were', () => {
    const { row, why, explain } = parts(divider);
    const before = divider.outerHTML;
    why.focus();
    why.click();
    assert.strictEqual(why.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(explain.hidden, false);
    assert.strictEqual(explain.previousElementSibling, row, 'opened beneath the row, in place');
    why.click();
    assert.strictEqual(why.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(explain.hidden, true);
    assert.strictEqual(divider.outerHTML, before);
    assert.strictEqual(document.activeElement, why);
  });

  test('Escape shuts it while it has focus, and goes no further', () => {
    const { why, explain } = parts(divider);
    const before = divider.outerHTML;
    why.focus();
    why.click();
    let reached = 0;
    const onDoc = () => { reached++; };
    document.addEventListener('keydown', onDoc);
    try {
      const e = press(why, 'Escape');
      assert.strictEqual(why.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(explain.hidden, true);
      assert.strictEqual(e.defaultPrevented, true);
      assert.strictEqual(reached, 0, 'the find bar and the rest of the page never see this Escape');
    } finally { document.removeEventListener('keydown', onDoc); }
    assert.strictEqual(divider.outerHTML, before);
    assert.strictEqual(document.activeElement, why);
  });

  test('Escape with the explanation already shut is left to the page', () => {
    const { why } = parts(divider);
    let reached = 0;
    const onDoc = () => { reached++; };
    document.addEventListener('keydown', onDoc);
    try {
      const e = press(why, 'Escape');
      assert.strictEqual(e.defaultPrevented, false);
      assert.strictEqual(reached, 1);
    } finally { document.removeEventListener('keydown', onDoc); }
    assert.strictEqual(why.getAttribute('aria-expanded'), 'false');
  });

  test('other keys are left to the button\'s own activation', () => {
    const { why } = parts(divider);
    for (const key of ['Enter', ' ', 'Tab']) assert.strictEqual(press(why, key).defaultPrevented, false, key);
    assert.strictEqual(why.getAttribute('aria-expanded'), 'false');
  });
});

describe('the colour each text takes, and the target\'s height', () => {
  // Every declaration of a rule whose selector list is exactly this.
  const rule = (selector) => {
    const at = CHAT_CSS.indexOf(`${selector} {`);
    assert.ok(at > -1, `chat.css has a rule for ${selector}`);
    const body = CHAT_CSS.slice(CHAT_CSS.indexOf('{', at) + 1, CHAT_CSS.indexOf('}', at));
    return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
  };

  test('the words, the button and the explanation are --text-2; the button is --text-1 on hover and when open', () => {
    assert.strictEqual(rule('.summarised-row').color, 'var(--text-2)');
    assert.strictEqual(rule('.summarised-why').color, 'var(--text-2)');
    assert.strictEqual(rule('.summarised-why:hover, .summarised-why[aria-expanded="true"]').color, 'var(--text-1)');
    assert.strictEqual(rule('.summarised-explain').color, 'var(--text-2)');
  });

  test('"Why?" is 26px tall: an 18px line (12px caption at 1.5) and 4px above and below', () => {
    assert.strictEqual(rule('.summarised-row')['font-size'], 'var(--caption)');
    assert.strictEqual(rule('.summarised-row')['line-height'], '1.5');
    assert.match(read('public', 'styles', 'tokens.css'), /--caption: 12px;/);
    assert.strictEqual(rule('.summarised-why')['line-height'], 'inherit');
    assert.strictEqual(rule('.summarised-why').padding, '4px');
  });

  test('the "Previous session" divider\'s words move from --text-3 to --text-2', () => {
    const divider = chat.createHistoryDivider();
    assert.strictEqual(divider.style.color, 'var(--text-2)');
    assert.strictEqual(divider.textContent, 'Previous session');
  });

  // That each var() it names is declared is token-references.test.js's job.
  test('no colour of its own: no literal colour in its rules', () => {
    const at = CHAT_CSS.indexOf('.msg-summarised {');
    assert.ok(at > -1);
    assert.doesNotMatch(CHAT_CSS.slice(at), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe('a reopened conversation', () => {
  const kinds = () => [...messages().children].map((el) => (el.classList.contains('msg-summarised') ? `divider:${el.dataset.compactionKey}` : el.id === 'history-divider' ? 'previous-session' : el.className.split(' ').slice(0, 2).join(' ')));
  let convo;
  beforeEach(() => {
    messages().replaceChildren();
    convo = { id: 'convo-s', agentId: 'example-writer', agent: global.agents[0], messages: [] };
    global.conversations = [convo];
    global.activeConversation = convo;
  });
  const history = (msgs) => chat.renderSessionHistory({ conversationId: convo.id, hasMore: false, totalCount: msgs.length, messages: msgs });

  test('draws the divider between the two messages it fell between, never as a bubble', () => {
    history([
      { role: 'user', content: 'A question' },
      { role: 'system', type: 'compaction', key: 'k1', content: '' },
      { role: 'assistant', content: 'An answer', agentId: 'example-writer' },
    ]);
    assert.deepStrictEqual(kinds(), ['msg msg-user', 'divider:k1', 'msg msg-agent', 'previous-session']);
    assert.strictEqual(messages().querySelectorAll('.msg-system').length, 0, 'no empty system line');
    assert.ok(!messages().querySelector('.msg-summarised').classList.contains('history-msg'), 'drawn at full strength');
  });

  test('keeps it for coming back, and draws it in the same place again', () => {
    history([
      { role: 'user', content: 'A question' },
      { role: 'system', type: 'compaction', key: 'k1', content: '' },
      { role: 'assistant', content: 'An answer', agentId: 'example-writer' },
    ]);
    assert.deepStrictEqual(convo.messages.map((m) => [m.role, m.type || null, m.key || null, m.content]),
      [['user', null, null, 'A question'], ['system', 'compaction', 'k1', ''], ['agent', null, null, 'An answer']]);
    for (let i = 0; i < 2; i++) {
      messages().replaceChildren();
      convos.replayConversationInto(messages(), convo);
      assert.deepStrictEqual(kinds(), ['msg msg-user', 'divider:k1', 'msg msg-agent', 'previous-session']);
      assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 1, 'switched away and back: still one');
      assert.ok(!messages().querySelector('.msg-summarised').classList.contains('history-msg'));
    }
  });

  test('two summaries are two dividers, in order', () => {
    history([
      { role: 'user', content: 'One' }, { role: 'system', type: 'compaction', key: 'k1', content: '' }, { role: 'assistant', content: 'A', agentId: 'example-writer' },
      { role: 'user', content: 'Two' }, { role: 'system', type: 'compaction', key: 'k2', content: '' }, { role: 'assistant', content: 'B', agentId: 'example-writer' },
    ]);
    assert.deepStrictEqual(kinds().filter((k) => k.startsWith('divider')), ['divider:k1', 'divider:k2']);
  });

  test('an entry with no key, or a key that is not text, draws nothing and the rest is drawn as before', () => {
    history([
      { role: 'user', content: 'A question' },
      { role: 'system', type: 'compaction', content: '' },
      { role: 'system', type: 'compaction', key: 42, content: '' },
      { role: 'assistant', content: 'An answer', agentId: 'example-writer' },
    ]);
    assert.deepStrictEqual(kinds(), ['msg msg-user', 'msg msg-agent', 'previous-session']);
    messages().replaceChildren();
    convos.replayConversationInto(messages(), convo);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised, .msg-system').length, 0);
  });

  test('an entry\'s own words are never shown', () => {
    history([{ role: 'user', content: 'A question' }, { role: 'system', type: 'compaction', key: 'k1', content: 'SUMMARY-TEXT' }]);
    assert.ok(!messages().textContent.includes('SUMMARY-TEXT'));
    messages().replaceChildren();
    convos.replayConversationInto(messages(), convo);
    assert.ok(!messages().textContent.includes('SUMMARY-TEXT'));
  });

  test('the divider\'s words in a reply, a tool result or the person\'s own message draw no divider', () => {
    history([
      { role: 'user', content: `${WORDS}. Why?` },
      { role: 'assistant', content: `${WORDS}\n\n<!-- compact_boundary -->`, agentId: 'example-writer' },
      { role: 'system', type: 'team', content: `${WORDS} (a tool result)` },
      { role: 'system', content: '{"type":"system","subtype":"compact_boundary"}' },
    ]);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
    messages().replaceChildren();
    convos.replayConversationInto(messages(), convo);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
  });

  test('a conversation never summarised has no divider', () => {
    history([{ role: 'user', content: 'A question' }, { role: 'assistant', content: 'An answer', agentId: 'example-writer' }]);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
  });
});

// A summary finishing while its conversation is on screen. The bubble and the
// thinking indicator are built as the app's own executors build them; the
// text that streams afterwards is put in the bubble the state names, after
// the cut, as the stream executor puts it. The wiring from the runtime's event
// to this function is proven in the browser by the e2e spec.
describe('a summary finishing while the conversation is on screen', () => {
  const CONVO = 'convo-live';
  let state;
  const bubble = (text) => {
    const el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.innerHTML = global.RundockChatMarkup.agentStreamingMessageHtml(global.agents[0], text, '');
    messages().appendChild(el);
    return el;
  };
  const thinking = () => {
    const el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.id = 'thinking-indicator';
    el.innerHTML = global.RundockChatMarkup.thinkingIndicatorHtml(global.agents[0]);
    messages().appendChild(el);
    return el;
  };
  const stream = (full) => {
    state.streamedText = full;
    state.currentStreamingMsg.querySelector('.streaming-text').textContent = chat.streamTextAfterCut(state, full);
  };
  const kinds = () => [...messages().children].map((el) => {
    if (el.classList.contains('msg-summarised')) return `divider:${el.dataset.compactionKey}`;
    if (el.id === 'thinking-indicator') return 'thinking';
    const text = el.querySelector('.streaming-text, .msg-bubble');
    return `${el.className.split(' ').slice(0, 2).join(' ')}:${text ? text.textContent.trim() : ''}`;
  });
  beforeEach(() => {
    messages().replaceChildren();
    state = { currentStreamingMsg: null, isProcessing: true, streamedText: '', streamPrefix: '' };
    global.getConvoState = () => state;
    global.activeConversation = { id: CONVO, agent: global.agents[0] };
  });

  test('in the middle of a reply: the bubble ends at the divider, and the rest of the reply starts a new bubble below with its own sender line', () => {
    chat.addUserMsg('A long question');
    state.currentStreamingMsg = bubble('');
    thinking();
    stream('The first part of the answer.');
    const divider = chat.drawCompactionDivider(CONVO, 'k1');
    assert.ok(divider);
    const next = state.currentStreamingMsg;
    assert.notStrictEqual(next, messages().children[1], 'the reply goes on in a new bubble');
    assert.strictEqual(next.previousElementSibling, divider, 'the new bubble sits right under the divider');
    assert.strictEqual(next.querySelectorAll('.msg-sender').length, 1, 'with its own sender line');
    assert.strictEqual(next.querySelector('.streaming-text').textContent, '', 'starting empty');
    assert.ok(next.classList.contains('summarised-continuation'));
    assert.strictEqual(state.streamPrefix, 'The first part of the answer.');

    stream('The first part of the answer.\n\nThe rest of it, after the summary.');
    assert.deepStrictEqual(kinds(), [
      'msg msg-user:A long question',
      'msg msg-agent:The first part of the answer.',
      'divider:k1',
      'msg msg-agent:The rest of it, after the summary.',
      'thinking',
    ]);
  });

  test('the new bubble keeps none of the first one\'s activity, and is hidden by the stylesheet until it has words', () => {
    state.currentStreamingMsg = bubble('Before.');
    state.streamedText = 'Before.';
    const summary = document.createElement('details');
    summary.className = 'activity-summary';
    state.currentStreamingMsg.appendChild(summary);
    chat.drawCompactionDivider(CONVO, 'k1');
    assert.strictEqual(state.currentStreamingMsg.querySelectorAll('.activity-summary').length, 0);
    assert.ok(CHAT_CSS.includes('.msg-agent.summarised-continuation:has(.streaming-text:empty):not(:has(.activity-summary)) { display: none; }'));
  });

  test('between replies: the divider follows the last message, before the thinking indicator, and nothing is split', () => {
    chat.addUserMsg('A question');
    thinking();
    chat.drawCompactionDivider(CONVO, 'k1');
    assert.deepStrictEqual(kinds(), ['msg msg-user:A question', 'divider:k1', 'thinking']);
    assert.strictEqual(state.currentStreamingMsg, null);
    assert.strictEqual(state.streamPrefix, '');
  });

  test('the next message, and the reply to it, come below the divider', () => {
    chat.addUserMsg('A question');
    chat.addAgentMsg('An answer', 'example-writer');
    chat.drawCompactionDivider(CONVO, 'k1');
    chat.addUserMsg('The next question');
    chat.addAgentMsg('The next answer', 'example-writer');
    assert.deepStrictEqual(kinds(), [
      'msg msg-user:A question', 'msg msg-agent:An answer', 'divider:k1',
      'msg msg-user:The next question', 'msg msg-agent:The next answer',
    ]);
  });

  test('the same summary twice is one divider, and one split', () => {
    state.currentStreamingMsg = bubble('');
    stream('Before.');
    assert.ok(chat.drawCompactionDivider(CONVO, 'k1'));
    const next = state.currentStreamingMsg;
    assert.strictEqual(chat.drawCompactionDivider(CONVO, 'k1'), null);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 1);
    assert.strictEqual(state.currentStreamingMsg, next);
    assert.strictEqual(messages().querySelectorAll('.msg-agent').length, 2);
  });

  test('two summaries in one reply are two dividers, each with the reply going on below it', () => {
    state.currentStreamingMsg = bubble('');
    stream('One.');
    chat.drawCompactionDivider(CONVO, 'k1');
    stream('One.\n\nTwo.');
    chat.drawCompactionDivider(CONVO, 'k2');
    stream('One.\n\nTwo.\n\nThree.');
    assert.deepStrictEqual(kinds(), ['msg msg-agent:One.', 'divider:k1', 'msg msg-agent:Two.', 'divider:k2', 'msg msg-agent:Three.']);
  });

  test('a conversation not on screen draws nothing here, and its reply is left alone', () => {
    const live = bubble('');
    state.currentStreamingMsg = live;
    stream('Before.');
    global.activeConversation = { id: 'another-convo' };
    assert.strictEqual(chat.drawCompactionDivider(CONVO, 'k1'), null);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
    assert.strictEqual(state.currentStreamingMsg, live);
    assert.strictEqual(state.streamPrefix, '');
  });

  test('a key that is missing or not text draws nothing', () => {
    for (const key of [undefined, null, '', 42]) assert.strictEqual(chat.drawCompactionDivider(CONVO, key), null);
    assert.strictEqual(messages().children.length, 0);
  });
});

// The live state, from the runtime's own announcement that a summary started
// (which events announce it, and which end it short, is the reducer's, proven
// in compaction-state.test.js). The turn ending is the app's finishProcessing,
// which every end goes through: a result, an error, and a stop, which the
// server follows with done.
describe('while the runtime summarises', () => {
  const CONVO = 'convo-live';
  const LIVE = 'Summarising earlier messages…';
  let state;
  const live = () => messages().querySelectorAll('.msg-summarised.summarising');
  const thinking = () => {
    const el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.id = 'thinking-indicator';
    el.innerHTML = global.RundockChatMarkup.thinkingIndicatorHtml(global.agents[0]);
    messages().appendChild(el);
    return el;
  };
  before(() => {
    Object.assign(global, {
      workingConvos: new Set(), currentView: 'chat', unread: { markMessage() {} }, updateUnreadBadge() {},
      persistConversation() {}, agentLastActivity: {}, formatTimeAgo: () => 'just now', updateWorkingBadge() {}, ws: null,
    });
  });
  beforeEach(() => {
    messages().replaceChildren();
    state = { currentStreamingMsg: null, isProcessing: true, streamedText: '', streamPrefix: '' };
    global.getConvoState = () => state;
    global.activeConversation = { id: CONVO, agent: global.agents[0] };
    global.conversations = [{ id: CONVO, agentId: 'example-writer', title: 'Live', messages: [] }];
  });

  test('from the announcement: the words in a status region, with the reconnect card\'s dot hidden from screen readers, above the thinking indicator', () => {
    chat.addUserMsg('A question');
    const t = thinking();
    const row = chat.showSummarising(CONVO);
    const label = row.querySelector('.summarised-label');
    assert.strictEqual(label.getAttribute('role'), 'status');
    assert.strictEqual(label.textContent, LIVE);
    const dot = label.querySelector('span.auth-pulse');
    assert.ok(dot, 'the reconnect card\'s dot');
    assert.strictEqual(dot.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(row.querySelector('button'), null, 'nothing to open yet');
    assert.strictEqual(row.nextElementSibling, t);
    assert.strictEqual(row.getAttribute('role'), null, 'not a separator');
  });

  test('the dot is the app\'s own, held still under reduced motion: no new motion', () => {
    assert.ok(CHAT_CSS.includes('.auth-pulse { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: var(--radius-circle); background: currentColor; animation: agentPulse 1.8s ease-in-out infinite; }'));
    assert.ok(CHAT_CSS.includes('@media (prefers-reduced-motion: reduce) { .auth-pulse { animation: none; } }'));
    assert.strictEqual(CHAT_CSS.indexOf('.summarising'), -1, 'no rule of its own');
  });

  test('announced twice is still one row', () => {
    chat.showSummarising(CONVO);
    chat.showSummarising(CONVO);
    assert.strictEqual(live().length, 1);
  });

  test('start, then finish: the same row settles into the divider, and its status region announces the finish', () => {
    chat.addUserMsg('A question');
    thinking();
    const row = chat.showSummarising(CONVO);
    const label = row.querySelector('.summarised-label');
    const divider = chat.drawCompactionDivider(CONVO, 'k1');
    assert.strictEqual(divider, row, 'settled in place');
    assert.strictEqual(row.querySelector('.summarised-label'), label);
    assert.strictEqual(label.getAttribute('role'), 'status');
    assert.strictEqual(label.textContent, `${WORDS}Why?`);
    assert.strictEqual(row.querySelector('.auth-pulse'), null);
    assert.strictEqual(live().length, 0);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 1);
    assert.strictEqual(row.dataset.compactionKey, 'k1');
    const why = row.querySelector('button.summarised-why');
    const explain = row.querySelector('.summarised-explain');
    assert.strictEqual(why.getAttribute('aria-controls'), explain.id);
    why.click();
    assert.strictEqual(explain.hidden, false);
    assert.strictEqual(explain.textContent, EXPLANATION);
    why.click();
    assert.strictEqual(explain.hidden, true);
  });

  test('start in the middle of a reply, then finish: the reply is split at the row', () => {
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent';
    bubble.innerHTML = global.RundockChatMarkup.agentStreamingMessageHtml(global.agents[0], 'Before.', '');
    messages().appendChild(bubble);
    state.currentStreamingMsg = bubble;
    state.streamedText = 'Before.';
    thinking();
    const row = chat.showSummarising(CONVO);
    chat.drawCompactionDivider(CONVO, 'k1');
    assert.strictEqual(row.previousElementSibling, bubble);
    assert.strictEqual(row.nextElementSibling, state.currentStreamingMsg);
    assert.ok(state.currentStreamingMsg.classList.contains('summarised-continuation'));
    assert.strictEqual(state.currentStreamingMsg.nextElementSibling.id, 'thinking-indicator');
  });

  test('start, then the turn ends with no finish: the live state goes and no divider is drawn', () => {
    chat.addUserMsg('A question');
    thinking();
    chat.showSummarising(CONVO);
    chat.finishProcessing(CONVO);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
    assert.strictEqual(document.getElementById('thinking-indicator'), null);
    assert.strictEqual(messages().children.length, 1, 'the conversation is otherwise as it was');
  });

  test('start, then the runtime says it stopped short: the live state goes and no divider is drawn', () => {
    chat.showSummarising(CONVO);
    chat.clearSummarising(CONVO);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 0);
  });

  test('a finish for a summary already drawn clears the live state and draws nothing more', () => {
    chat.drawCompactionDivider(CONVO, 'k1');
    chat.showSummarising(CONVO);
    assert.strictEqual(chat.drawCompactionDivider(CONVO, 'k1'), null);
    assert.strictEqual(live().length, 0);
    assert.strictEqual(messages().querySelectorAll('.msg-summarised').length, 1);
  });

  test('another conversation\'s start draws nothing here, and its end leaves this one\'s live state alone', () => {
    chat.showSummarising(CONVO);
    assert.strictEqual(chat.showSummarising('another-convo'), null);
    chat.clearSummarising('another-convo');
    assert.strictEqual(live().length, 1);
    assert.strictEqual(chat.drawCompactionDivider('another-convo', 'k9'), null);
    assert.strictEqual(live().length, 1);
  });
});

describe('the message count', () => {
  test('a conversation\'s count on the agent profile leaves the divider out', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="view-profile"><div id="profile-content"></div></div></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    try {
      for (const f of [['schedule-days.js'], ['routine-editor-model.js'], ['skills-model.js'], ['routines-model.js'], ['views', 'routines.js'], ['views', 'profile.js']]) w.eval(read('public', ...f));
      w.agents = [{ id: 'example-writer', displayName: 'Alpha', role: 'Writer', colour: '#888888', icon: 'A', status: 'onTeam', runtime: 'claude', model: 'sonnet', routines: [] }];
      w.skills = [];
      w.conversations = [{ id: 'c1', agentId: 'example-writer', title: 'Summarised', messages: [
        { role: 'user', content: 'A question' }, { role: 'system', type: 'compaction', key: 'k1', content: '' }, { role: 'agent', content: 'An answer' },
      ] }];
      w.esc = (s) => String(s == null ? '' : s);
      w.formatTimeAgo = () => 'a while ago';
      w.getGuide = () => ({ id: 'doc', displayName: 'Guide' });
      w.ws = { send: () => {} };
      w.setNavState = () => {};
      w.showView = () => {};
      w.closeFindBar = () => {};
      w.showProfile('example-writer');
      assert.strictEqual(w.document.querySelector('.profile-existing-meta').textContent, '2 messages');
    } finally { dom.window.close(); }
  });
});
