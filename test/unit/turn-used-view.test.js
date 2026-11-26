'use strict';
// THE LINE UNDER A REPLY: HOW LONG THE AGENT WORKED, AND DETAILS.
//
// Each reply that arrives while its conversation is open says how long the
// agent worked on it, as its runtime reported it ("6 steps · Worked 4 min
// 05 s"), and a Details button opens the steps it took and the tokens the
// runtime reported for it. Nothing is drawn from the page's own clock, no
// money is shown, and nothing here is kept with the message.
//
// Measured on the document through the real reducer, the real effect
// executors cut from app.js and the real view functions, the pattern of
// delegate-stopped-view.test.js. Keys on a real button (Enter, Space) are
// proven in the browser by test/e2e/turn-used.spec.js, since a document
// without a browser does not turn a key into a click.
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sj = require('../fixtures/stream-json.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const APP = read('public', 'app.js');
const CHAT_CSS = read('public', 'styles', 'views', 'chat.css');

const CONVO = 'convo-1';
const START = 1700000000000;
const LIVE = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
const OFF_SCREEN = { isActive: false, viewingChat: false, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
const CONTINUATION_RULE = '.msg-agent.summarised-continuation:has(.streaming-text:empty):not(:has(.activity-summary)) { display: none; }';

const cut = (start, end, label) => {
  const at = APP.indexOf(start);
  assert.ok(at > -1, `${label} found in app.js`);
  const stop = APP.indexOf(end, at);
  assert.ok(stop > -1, `${label} ends in app.js`);
  return APP.slice(at, stop + end.length);
};

let chat;
let cs;
let executeEffects;
let states = {};
let convo;
let finished = [];

before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.formatMd = (t) => global.esc(t);
  global.userScrolledUp = false;
  global.renderConvoList = () => {};
  global.tryMessageAnchor = () => {};
  global.setActiveAgentPill = () => {};
  global.renderPendingPermissionCards = () => {};
  global.agents = [{ id: 'example-writer', displayName: 'Alpha', type: 'specialist' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.RundockPermissions = require(path.join(ROOT, 'public', 'permissions.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.unread = { markMessage() {}, markPermission() {} };
  global.updateUnreadBadge = () => {};
  global.stripMd = (t) => String(t);
  global.addSystemMsgToConvo = () => {};
  cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
  global.RundockConversationState = cs;
  global.getConvoState = (id) => states[id] || (states[id] = Object.assign(cs.createState(), { currentStreamingMsg: null }));
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  // Guarded: a tree without the composer has a history redraw that never calls it.
  try { Object.assign(global, require(path.join(ROOT, 'public', 'views', 'composer.js'))); } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND' && /composer\.js/.test(String(e.message)))) throw e;
  }
  // The turn ends as the page ends it, without the sidebar and the save.
  global.finishProcessing = (id) => {
    finished.push(id);
    const s = global.getConvoState(id);
    s.isProcessing = false;
    s.currentStreamingMsg = null;
  };
  chat.cardArming.ms = 0;
  const table = new Function(`${cut('const EFFECT_EXECUTORS = {', '\n};', 'EFFECT_EXECUTORS')} return EFFECT_EXECUTORS;`)();
  executeEffects = new Function('EFFECT_EXECUTORS', `${cut('function executeEffects(convoId, effects) {', '\n}', 'executeEffects()')} return executeEffects;`)(table);
});

beforeEach(() => {
  document.getElementById('messages').replaceChildren();
  states = {};
  finished = [];
  convo = { id: CONVO, agentId: 'example-writer', agent: global.agents[0], title: 'Alpha', messages: [] };
  global.conversations = [convo];
  global.activeConversation = convo;
  global.pendingPermissions.clear();
});

// One message through the reducer and the executors, as app.js does it.
function feed(message, ctx = LIVE) {
  const r = cs.reduce(global.getConvoState(CONVO), { _conversationId: CONVO, ...message }, ctx);
  states[CONVO] = r.state;
  executeEffects(CONVO, r.effects);
  return r.effects;
}
function streamed(text, ctx = LIVE) {
  feed(sj.contentBlockStartText(), ctx);
  feed(sj.textDelta(text), ctx);
}
// A turn's result. Only the fields a test names are sent: no duration unless
// it gives one.
function resultWith(fields, { text = 'Done.', isError = false } = {}) {
  const msg = sj.result({ text, isError, extra: { _turnStartTime: START, ...fields } });
  if (!Object.prototype.hasOwnProperty.call(fields, 'duration_ms')) delete msg.duration_ms;
  return msg;
}
function reply(fields = {}, { text = 'Done.', stream = true, isError = false, ctx = LIVE } = {}) {
  if (stream) streamed(text, ctx);
  return feed(resultWith(fields, { text, isError }), ctx);
}
const steps = (n) => Array.from({ length: n }, (_, i) => ({ tool: 'Read', time: START + 1000 * (i + 1), arg: '' }));
const agentMsgs = () => [...document.querySelectorAll('#messages > .msg.msg-agent')];
const last = () => agentMsgs()[agentMsgs().length - 1];
const words = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const press = (el, key) => {
  const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

function partsOf(used) {
  return {
    used,
    row: used.querySelector(':scope > div.turn-used-row'),
    line: used.querySelector(':scope > div.turn-used-row > span.turn-used-line'),
    details: used.querySelector(':scope > div.turn-used-row > button.turn-details'),
    panel: used.querySelector(':scope > div.turn-tokens'),
    sentence: used.querySelector('div.turn-tokens-line'),
  };
}
// The line under a drawn reply; fails, on an assertion, where there is none.
function lineOf(msg = last()) {
  assert.strictEqual(typeof chat.buildActivitySummary, 'function', 'the view builds the line');
  assert.ok(msg, 'a reply is drawn');
  const used = msg.querySelector(':scope > div.turn-used');
  assert.ok(used, 'the reply carries a div.turn-used line');
  return partsOf(used);
}
// The line as the view builds it from a turn's fields.
function drawn(toolCalls, turnStartTime, durationMs, usage, runtime) {
  assert.strictEqual(typeof chat.buildActivitySummary, 'function', 'the view builds the line');
  const el = chat.buildActivitySummary(toolCalls, turnStartTime, durationMs, usage, runtime);
  assert.ok(el && typeof el.matches === 'function' && el.matches('div.turn-used'), 'a div.turn-used line is drawn');
  return partsOf(el);
}
function finishedOnce() {
  assert.deepStrictEqual(finished, [CONVO], 'the turn still finishes');
}

describe('the words: how long the agent worked, as its runtime reported it', () => {
  const TABLE = [
    [0, 'Worked under 1 s'], [999, 'Worked under 1 s'],
    [1000, 'Worked 1 s'], [1999, 'Worked 1 s'], [45000, 'Worked 45 s'], [59999, 'Worked 59 s'],
    [60000, 'Worked 1 min 00 s'], [245000, 'Worked 4 min 05 s'], [245999, 'Worked 4 min 05 s'], [3599999, 'Worked 59 min 59 s'],
    [3600000, 'Worked 1 h 00 min'], [3659999, 'Worked 1 h 00 min'], [3720000, 'Worked 1 h 02 min'], [90000000, 'Worked 25 h 00 min'],
  ];
  for (const [ms, want] of TABLE) {
    test(`${ms} ms reads "${want}"`, () => {
      assert.strictEqual(words(drawn([], null, ms).line), want);
    });
  }

  test('6 steps and 245000 ms read "6 steps · Worked 4 min 05 s"', () => {
    assert.strictEqual(words(drawn(steps(6), START, 245000).line), '6 steps · Worked 4 min 05 s');
  });

  test('1 step and 48000 ms read "1 step · Worked 48 s"', () => {
    assert.strictEqual(words(drawn(steps(1), START, 48000).line), '1 step · Worked 48 s');
  });

  test('steps with no valid duration read the steps alone', () => {
    assert.strictEqual(words(drawn(steps(6), START, undefined).line), '6 steps');
  });

  // Pins main's behavior (nothing drawn); its sibling "steps with no valid
  // duration read the steps alone" shares the setup and fails on main.
  test('neither steps nor a time draws nothing, whatever the usage', () => {
    assert.strictEqual(typeof chat.buildActivitySummary, 'function');
    assert.strictEqual(chat.buildActivitySummary([], START, undefined, { input_tokens: 18240, output_tokens: 3905 }, 'claude'), null);
    assert.strictEqual(chat.buildActivitySummary(undefined, null, null, { inputTokens: 900 }, 'codex'), null);
  });

  test('a reply shows one time: the runtime\'s, never a second one of the page\'s', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000 });
    const { used, line, panel } = lineOf();
    assert.strictEqual(words(line), '3 steps · Worked 4 min 05 s');
    const outside = words(used).replace(words(panel), '');
    assert.strictEqual(outside.split('Worked').length - 1, 1, 'one time on the page');
    assert.doesNotMatch(outside, /\d+(\.\d+)?s\b|\d+m\b/, 'no old-style elapsed time beside it');
  });
});

describe('where the line goes', () => {
  test('a streamed reply: one div.turn-used right after the bubble, and no details element', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000 });
    const { used } = lineOf();
    assert.ok(used.previousElementSibling && used.previousElementSibling.classList.contains('msg-bubble'), 'after .msg-bubble');
    assert.strictEqual(last().querySelectorAll('.turn-used').length, 1);
    assert.strictEqual(last().querySelector('details'), null);
    assert.strictEqual(words(last().querySelector('.msg-bubble')), 'Done.', 'the reply\'s own words are untouched');
  });

  test('a short reply drawn at the end carries the same line after its bubble', () => {
    reply({ _toolCalls: steps(1), duration_ms: 48000 }, { stream: false });
    const { used, line } = lineOf();
    assert.strictEqual(words(line), '1 step · Worked 48 s');
    assert.ok(used.previousElementSibling.classList.contains('msg-bubble'));
    assert.strictEqual(last().querySelector('details'), null);
  });

  test('the time is the runtime\'s, never the page clock', () => {
    const realNow = Date.now;
    Date.now = () => START + 999999;
    try {
      reply({ duration_ms: 245000 });
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(words(lineOf().line), 'Worked 4 min 05 s');
  });

  test('the line keeps the activity-summary class, so the clones that strip it strip the line', () => {
    reply({ duration_ms: 45000 });
    assert.ok(lineOf().used.classList.contains('activity-summary'));
  });
});

describe('Details', () => {
  const USAGE = { input_tokens: 18240, output_tokens: 3905 };

  test('is a real button after the words, naming a hidden panel of the steps and then the tokens', () => {
    reply({ _toolCalls: steps(2), duration_ms: 245000, usage: USAGE });
    const { used, row, line, details, panel, sentence } = lineOf();
    assert.deepStrictEqual([...row.children].map((el) => el.className), ['turn-used-line', 'turn-details']);
    assert.strictEqual(line.tagName, 'SPAN');
    assert.strictEqual(details.tagName, 'BUTTON');
    assert.strictEqual(details.textContent, 'Details');
    assert.strictEqual(details.getAttribute('type'), 'button');
    assert.strictEqual(details.getAttribute('aria-expanded'), 'false');
    assert.ok(panel.id, 'the panel has an id');
    assert.strictEqual(details.getAttribute('aria-controls'), panel.id);
    assert.strictEqual(row.nextElementSibling, panel, 'the panel follows the row');
    assert.strictEqual(panel.hidden, true, 'it starts shut');
    assert.deepStrictEqual([...used.children].map((el) => el.className), ['turn-used-row', 'turn-tokens']);
    assert.deepStrictEqual([...panel.children].map((el) => el.className), ['activity-list', 'turn-tokens-line']);
    const rows = [...panel.querySelectorAll('.activity-list > .activity-row')];
    assert.deepStrictEqual(rows.map((r) => [...r.children].map((c) => `${c.className}:${c.textContent}`)),
      [['activity-time:1.0s', 'activity-tool:Read'], ['activity-time:2.0s', 'activity-tool:Read']], 'the step rows as before');
    assert.strictEqual(sentence.textContent, 'Tokens as Claude Code reported them: 18,240 input, 3,905 output.');
  });

  test('two replies each open their own panel', () => {
    reply({ _toolCalls: steps(1), duration_ms: 1000 });
    reply({ _toolCalls: steps(1), duration_ms: 2000 });
    const [one, two] = agentMsgs().map((m) => lineOf(m));
    assert.notStrictEqual(one.panel.id, two.panel.id);
    assert.strictEqual(document.querySelectorAll(`[id="${one.panel.id}"]`).length, 1);
    one.details.click();
    assert.strictEqual(one.panel.hidden, false);
    assert.strictEqual(two.panel.hidden, true);
  });

  test('a click opens it and a second click shuts it again', () => {
    reply({ _toolCalls: steps(2), duration_ms: 45000 });
    const { details, panel } = lineOf();
    details.click();
    assert.strictEqual(panel.hidden, false);
    assert.strictEqual(details.getAttribute('aria-expanded'), 'true');
    details.click();
    assert.strictEqual(panel.hidden, true);
    assert.strictEqual(details.getAttribute('aria-expanded'), 'false');
  });

  test('Escape on the button shuts it and keeps focus on the button', () => {
    reply({ _toolCalls: steps(2), duration_ms: 45000 });
    const { details, panel } = lineOf();
    details.click();
    details.focus();
    const e = press(details, 'Escape');
    assert.strictEqual(panel.hidden, true);
    assert.strictEqual(details.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(document.activeElement, details);
    assert.ok(e.defaultPrevented);
  });

  test('Escape from inside the panel shuts it and hands focus back to the button', () => {
    reply({ _toolCalls: steps(2), duration_ms: 45000, usage: USAGE });
    const { details, panel, sentence } = lineOf();
    details.click();
    panel.focus();
    press(sentence, 'Escape');
    assert.strictEqual(panel.hidden, true);
    assert.strictEqual(details.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(document.activeElement, details);
  });

  test('Escape with it shut is left for the rest of the page', () => {
    reply({ _toolCalls: steps(2), duration_ms: 45000 });
    const { details, panel } = lineOf();
    const e = press(details, 'Escape');
    assert.strictEqual(panel.hidden, true);
    assert.strictEqual(e.defaultPrevented, false);
  });

  test('a time alone has no Details', () => {
    reply({ duration_ms: 12000 });
    const { line, details, panel } = lineOf();
    assert.strictEqual(words(line), 'Worked 12 s');
    assert.strictEqual(details, null);
    assert.strictEqual(panel, null);
  });

  test('a token sentence alone opens Details with the sentence and no step list', () => {
    reply({ duration_ms: 12000, usage: USAGE });
    const { line, details, panel, sentence } = lineOf();
    assert.strictEqual(words(line), 'Worked 12 s');
    assert.ok(details);
    assert.strictEqual(panel.querySelector('.activity-list'), null);
    assert.strictEqual(sentence.textContent, 'Tokens as Claude Code reported them: 18,240 input, 3,905 output.');
  });
});

describe('the token sentence, as the runtime reported it', () => {
  const sentenceFor = (fields) => {
    reply({ _toolCalls: steps(1), duration_ms: 45000, ...fields });
    const { sentence } = lineOf();
    return sentence ? sentence.textContent : null;
  };

  test('Claude Code with all four counts', () => {
    assert.strictEqual(sentenceFor({ usage: { input_tokens: 18240, output_tokens: 3905, cache_read_input_tokens: 412880, cache_creation_input_tokens: 22010 } }),
      'Tokens as Claude Code reported them: 18,240 input, 3,905 output, 412,880 read from cache, 22,010 written to cache.');
  });

  test('Claude Code with input and output only', () => {
    assert.strictEqual(sentenceFor({ usage: { input_tokens: 18240, output_tokens: 3905 } }),
      'Tokens as Claude Code reported them: 18,240 input, 3,905 output.');
  });

  test('Claude Code with a reported zero says zero', () => {
    assert.strictEqual(sentenceFor({ usage: { input_tokens: 0, output_tokens: 12 } }),
      'Tokens as Claude Code reported them: 0 input, 12 output.');
  });

  test('Codex with its four counts', () => {
    assert.strictEqual(sentenceFor({ _runtime: 'codex', usage: { inputTokens: 24316, cachedInputTokens: 19840, outputTokens: 1207, reasoningOutputTokens: 384 } }),
      'Tokens as Codex reported them: 24,316 input, 19,840 cached input, 1,207 output, 384 reasoning output.');
  });

  test('a Claude Code result carrying only Codex keys has no sentence', () => {
    assert.strictEqual(sentenceFor({ usage: { inputTokens: 24316, outputTokens: 1207 } }), null);
  });

  test('a Codex result carrying only Claude Code keys has no sentence', () => {
    assert.strictEqual(sentenceFor({ _runtime: 'codex', usage: { input_tokens: 18240, output_tokens: 3905 } }), null);
  });

  test('a runtime other than codex is read as Claude Code', () => {
    assert.strictEqual(sentenceFor({ _runtime: 'Codex', usage: { input_tokens: 18240, output_tokens: 3905, inputTokens: 1 } }),
      'Tokens as Claude Code reported them: 18,240 input, 3,905 output.');
  });

  for (const [n, want] of [[0, '0'], [999, '999'], [1000, '1,000'], [18240, '18,240'], [1234567, '1,234,567']]) {
    test(`${n} is grouped as ${want}, whatever the locale`, () => {
      const realLocale = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function () { return 'x'; };
      let got;
      try {
        got = sentenceFor({ usage: { input_tokens: n } });
      } finally {
        Number.prototype.toLocaleString = realLocale;
      }
      assert.strictEqual(got, `Tokens as Claude Code reported them: ${want} input.`);
    });
  }
});

describe('turns that draw less', () => {
  test('an error result with 3000 ms and nothing else reads "Worked 3 s" with no Details', () => {
    reply({ duration_ms: 3000 }, { isError: true, text: 'It stopped part way.' });
    const { line, details } = lineOf();
    assert.strictEqual(words(line), 'Worked 3 s');
    assert.strictEqual(details, null);
    finishedOnce();
  });

  test('a result with no usage key: steps and time, six rows behind Details, no token sentence', () => {
    reply({ _toolCalls: steps(6), duration_ms: 45000 });
    const { line, details, panel } = lineOf();
    assert.strictEqual(words(line), '6 steps · Worked 45 s');
    details.click();
    assert.strictEqual(panel.hidden, false);
    assert.strictEqual(panel.querySelectorAll('.activity-row').length, 6);
    assert.strictEqual(panel.querySelector('.turn-tokens-line'), null);
  });

  test('a result whose usage is null: steps and time, six rows behind Details, no token sentence', () => {
    reply({ _toolCalls: steps(6), duration_ms: 45000, usage: null });
    const { line, details, panel } = lineOf();
    assert.strictEqual(words(line), '6 steps · Worked 45 s');
    details.click();
    assert.strictEqual(panel.querySelectorAll('.activity-row').length, 6);
    assert.strictEqual(panel.querySelector('.turn-tokens-line'), null);
  });

  test('a Codex turn with no token update reads "Worked 8 s" with no Details, never zeros', () => {
    reply({ _runtime: 'codex', duration_ms: 8889 });
    const { line, details, used } = lineOf();
    assert.strictEqual(words(line), 'Worked 8 s');
    assert.strictEqual(details, null);
    assert.doesNotMatch(words(used), /Tokens|0 input/);
  });

  test('a stopped reply shows "Cancelled" in its bubble, then the line with the server\'s time and the steps, and no tokens', () => {
    streamed('Partly done');
    feed({ type: 'system', subtype: 'cancelled', _toolCalls: steps(3), _turnStartTime: START, duration_ms: 72000 });
    const { used, line, sentence } = lineOf();
    const bubble = last().querySelector('.msg-bubble');
    assert.strictEqual(words(bubble.querySelector('.cancelled-badge')), 'Cancelled');
    assert.strictEqual(used.previousElementSibling, bubble, 'the badge, then the line');
    assert.strictEqual(words(line), '3 steps · Worked 1 min 12 s');
    assert.strictEqual(sentence, null);
  });

  test('a stopped reply with no steps reads "Worked 12 s" with no Details', () => {
    streamed('Partly done');
    feed({ type: 'system', subtype: 'cancelled', _toolCalls: [], _turnStartTime: START, duration_ms: 12000 });
    const { line, details } = lineOf();
    assert.strictEqual(words(line), 'Worked 12 s');
    assert.strictEqual(details, null);
  });

  test('a stopped reply the server could not time shows its steps alone', () => {
    streamed('Partly done');
    feed({ type: 'system', subtype: 'cancelled', _toolCalls: steps(3), _turnStartTime: null });
    assert.strictEqual(words(lineOf().line), '3 steps');
  });

  // Pins main's behavior (nothing drawn); its sibling "a stopped reply shows
  // "Cancelled" in its bubble, then the line..." shares the setup and fails on main.
  test('a stopped turn with no bubble on screen draws nothing', () => {
    feed({ type: 'system', subtype: 'cancelled', _toolCalls: steps(3), _turnStartTime: START, duration_ms: 72000 });
    assert.strictEqual(document.querySelector('.turn-used, .activity-summary'), null);
  });

  // Pins main's behavior (nothing drawn); its sibling "a streamed reply: one
  // div.turn-used right after the bubble..." shares the setup and fails on main.
  test('a silent park draws nothing', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000 }, { text: '<silent>' });
    assert.strictEqual(agentMsgs().length, 0);
    assert.strictEqual(document.querySelector('.turn-used, .activity-summary'), null);
    finishedOnce();
  });

  // Pins main's behavior (nothing drawn); its sibling "a short reply drawn at
  // the end carries the same line..." shares the setup and fails on main.
  test('a result with no text and no bubble draws nothing', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000, usage: { input_tokens: 5 } }, { text: '', stream: false });
    assert.strictEqual(agentMsgs().length, 0);
    assert.strictEqual(document.querySelector('.turn-used, .activity-summary'), null);
    finishedOnce();
  });

  // Pins main's behavior (nothing drawn); its sibling "a streamed reply: one
  // div.turn-used right after the bubble..." shares the setup and fails on main.
  test('a reply in a conversation that is off screen draws nothing', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000, usage: { input_tokens: 5 } }, { ctx: OFF_SCREEN });
    assert.strictEqual(document.querySelector('.msg, .turn-used, .activity-summary'), null);
    assert.strictEqual(convo.messages.length, 1, 'the reply is still kept');
    finishedOnce();
  });

  // Pins main's behavior (nothing drawn); its sibling "a streamed reply: one
  // div.turn-used right after the bubble..." fails on main.
  test('a reopened conversation redraws its replies with no line', () => {
    chat.renderSessionHistory({ conversationId: CONVO, hasMore: false, totalCount: 2, messages: [
      { role: 'user', content: 'A question' },
      { role: 'assistant', content: 'An answer', agentId: 'example-writer', duration_ms: 245000, usage: { input_tokens: 5 } },
    ] });
    assert.ok(document.querySelector('#messages .msg-agent'), 'the reply is redrawn');
    assert.strictEqual(document.querySelector('.turn-used, .activity-summary, .turn-details'), null);
  });
});

describe('a value that is not a valid number is left out, and the turn still finishes', () => {
  const BAD_DURATIONS = [['the string "245000"', '245000'], ['-1', -1], ['1e400', 1e400], ['null', null], ['true', true], ['an object', {}]];
  for (const [label, bad] of BAD_DURATIONS) {
    test(`a duration of ${label} shows no time`, () => {
      reply({ _toolCalls: steps(2), duration_ms: bad });
      assert.strictEqual(words(lineOf().line), '2 steps');
      assert.doesNotMatch(words(last()), /Worked/);
      finishedOnce();
    });
  }

  const BAD_COUNTS = [['the string "18240"', '18240'], ['-5', -5], ['1.5', 1.5], ['1e400', 1e400], ['2^53', 2 ** 53], ['null', null], ['markup', '<img src=x onerror=alert(1)>']];
  for (const [label, bad] of BAD_COUNTS) {
    test(`a count of ${label} is left out and draws nothing of its own`, () => {
      reply({ _toolCalls: steps(1), duration_ms: 45000, usage: { input_tokens: bad, output_tokens: 3905 } });
      const { sentence } = lineOf();
      assert.strictEqual(sentence.textContent, 'Tokens as Claude Code reported them: 3,905 output.');
      assert.strictEqual(last().querySelector('img'), null);
      assert.doesNotMatch(last().innerHTML, /onerror|18240|9007199254740992/);
      finishedOnce();
    });
  }

  for (const [label, bad] of [['an array', [18240, 3905]], ['a string', '18240 input'], ['a number', 18240]]) {
    test(`usage that is ${label} gives no sentence`, () => {
      reply({ _toolCalls: steps(1), duration_ms: 45000, usage: bad });
      const { line, sentence } = lineOf();
      assert.strictEqual(words(line), '1 step · Worked 45 s');
      assert.strictEqual(sentence, null);
      finishedOnce();
    });
  }
});

describe('what the line leaves alone', () => {
  test('a put-back card\'s new bubble holds no line', () => {
    streamed('Before the card');
    executeEffects(CONVO, [{ type: 'finalize-stream-bubble', text: 'Before the card', toolCalls: steps(2), turnStartTime: START, durationMs: 245000 }]);
    const live = global.getConvoState(CONVO).currentStreamingMsg;
    assert.ok(live && live.querySelector(':scope > .turn-used'), 'the live bubble carries the line');
    const PATH = '/ws/.rundock/permissions.json';
    chat.renderPermissionCard({
      request_id: 'pb1',
      request: {
        tool_name: 'WriteFile', input: { path: PATH, content: '{}', approvalKind: 'fileChange' },
        answer_file: true, resolved_path: PATH, grant_dir: null, crossings: [{ path: PATH, answerFile: true }],
        put_back: { relative: '.rundock/permissions.json', before: '{}\n', after: '{"a":1}\n', runtime: 'claude', outsideTurn: false },
      },
    }, CONVO);
    const next = global.getConvoState(CONVO).currentStreamingMsg;
    assert.notStrictEqual(next, live, 'the reply goes on in a new bubble');
    assert.strictEqual(next.querySelector('.turn-used, .activity-summary'), null);
  });

  test('the bubble after a summary divider holds no line', () => {
    streamed('Before the summary');
    executeEffects(CONVO, [{ type: 'finalize-stream-bubble', text: 'Before the summary', toolCalls: steps(2), turnStartTime: START, durationMs: 245000 }]);
    const live = global.getConvoState(CONVO).currentStreamingMsg;
    assert.ok(live && live.querySelector(':scope > .turn-used'), 'the live bubble carries the line');
    assert.ok(chat.drawCompactionDivider(CONVO, 'k1'));
    const next = global.getConvoState(CONVO).currentStreamingMsg;
    assert.notStrictEqual(next, live);
    assert.ok(next.classList.contains('summarised-continuation'));
    assert.strictEqual(next.querySelector('.turn-used, .activity-summary'), null);
  });

  // Pins main's stylesheet (the rule stays where it was); its sibling "the
  // bubble after a summary divider holds no line" fails on main.
  test('the rule that hides an empty continuation is unchanged, at line 309', () => {
    assert.strictEqual(CHAT_CSS.split('\n')[308], CONTINUATION_RULE);
  });

  test('a line drawn on an empty continuation keeps it on screen', () => {
    streamed('The first part.');
    assert.ok(chat.drawCompactionDivider(CONVO, 'k1'));
    const continuation = global.getConvoState(CONVO).currentStreamingMsg;
    const selector = CONTINUATION_RULE.slice(0, CONTINUATION_RULE.indexOf(' {'));
    assert.strictEqual(continuation.matches(selector), true, 'hidden while it has no words');
    feed(resultWith({ duration_ms: 12000 }, { text: 'The first part.' }));
    lineOf(continuation);
    assert.strictEqual(continuation.querySelector('.streaming-text').textContent, '', 'still no words of its own');
    assert.strictEqual(continuation.matches(selector), false, 'the line keeps it displayed');
  });

  // Pins main's behavior (the stored message); its sibling "a streamed reply:
  // one div.turn-used right after the bubble..." shares the setup and fails on main.
  test('the stored reply is exactly its role, words, agent and time', () => {
    reply({ _toolCalls: steps(3), duration_ms: 245000, usage: { input_tokens: 18240, output_tokens: 3905 } });
    assert.strictEqual(convo.messages.length, 1);
    assert.deepStrictEqual(Object.keys(convo.messages[0]).sort(), ['agentId', 'content', 'role', 'timestamp']);
    assert.strictEqual(convo.messages[0].content, 'Done.');
  });

  test('no money is shown, whatever the result carries', () => {
    reply({
      _toolCalls: steps(2), duration_ms: 245000, total_cost_usd: 0.0282,
      usage: { input_tokens: 18240, output_tokens: 3905 },
      modelUsage: { 'example-model': { inputTokens: 18240, outputTokens: 3905, costUSD: 0.0282 } },
    });
    const { used, details } = lineOf();
    details.click();
    for (const bad of ['$', '£', '€', 'USD', 'cost']) assert.ok(!used.textContent.includes(bad), `no "${bad}"`);
    assert.ok(!last().textContent.includes('0.0282'));
  });
});
