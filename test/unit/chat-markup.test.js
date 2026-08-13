'use strict';
// Unit tests for public/chat-markup.js: the single source of chat message
// markup.
//
// Every expected string in this file was produced by evaluating the template
// literals that existed at seven call sites across app.js, views/chat.js and
// views/conversations.js before they were replaced by these helpers, using
// the same inputs. They are the extraction contract: a failure means the
// rendered chat markup changed, which is a visible defect, not a refactor.
//
// The agent fixture uses a plain colour and a single-character icon so the
// expected strings stay readable; the fallback cases below cover the
// `a?.colour || 'var(--accent)'` branches that the call sites relied on.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  msgTimeHtml,
  agentSenderHtml,
  agentMessageHtml,
  agentStreamingMessageHtml,
  thinkingIndicatorHtml,
  userBubbleHtml,
} = require('../../public/chat-markup.js');

const AGENT = { colour: '#f00', icon: 'D', displayName: 'Dev' };
const SENDER = '<div class="msg-sender" style="color:#f00"><div class="avatar xs" style="background:#f00">D</div> Dev';
const TIME = '<span class="msg-time">09:41</span>';

// ── agentSenderHtml ─────────────────────────────────────────────────────────

test('agentSenderHtml renders avatar, name and no time when none is given', () => {
  assert.strictEqual(agentSenderHtml(AGENT, ''), SENDER + '</div>');
});

test('agentSenderHtml appends the time span it is handed', () => {
  assert.strictEqual(agentSenderHtml(AGENT, TIME), SENDER + TIME + '</div>');
});

test('agentSenderHtml treats a missing time argument as no time', () => {
  assert.strictEqual(agentSenderHtml(AGENT), SENDER + '</div>');
});

test('agentSenderHtml falls back to the accent colour, ? and Agent', () => {
  // The call sites all used `a?.colour || 'var(--accent)'`, which fires both
  // for a null agent and for an agent whose colour is an empty string.
  const expected = '<div class="msg-sender" style="color:var(--accent)"><div class="avatar xs" style="background:var(--accent)">?</div> Agent</div>';
  assert.strictEqual(agentSenderHtml(null, ''), expected);
  assert.strictEqual(agentSenderHtml(undefined, ''), expected);
  assert.strictEqual(agentSenderHtml({ colour: '', icon: '', displayName: '' }, ''), expected);
});

// ── msgTimeHtml ─────────────────────────────────────────────────────────────

test('msgTimeHtml wraps a valid date in a msg-time span', () => {
  const html = msgTimeHtml(new Date(2026, 0, 2, 9, 41));
  assert.match(html, /^<span class="msg-time">.+<\/span>$/);
  // Locale formatting varies by environment, so pin the 2-digit shape rather
  // than one locale's separator.
  assert.match(html, /09|9/);
});

test('msgTimeHtml returns empty string for a missing date', () => {
  assert.strictEqual(msgTimeHtml(null), '');
  assert.strictEqual(msgTimeHtml(undefined), '');
});

test('msgTimeHtml returns empty string for an unparseable date', () => {
  // views/chat.js guarded with isNaN(t.getTime()) because a conversation
  // saved with a malformed timestamp otherwise rendered "Invalid Date".
  assert.strictEqual(msgTimeHtml(new Date('not-a-date')), '');
});

// ── thinkingIndicatorHtml ───────────────────────────────────────────────────

test('thinkingIndicatorHtml matches the markup the three call sites shared', () => {
  assert.strictEqual(
    thinkingIndicatorHtml(AGENT),
    SENDER + '</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:#f00"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>'
  );
});

test('thinkingIndicatorHtml carries the thinking-status id the tool-status updates target', () => {
  // ensure-tool-status and update-tool-status both reach this node by id.
  assert.ok(thinkingIndicatorHtml(AGENT).includes('id="thinking-status"'));
});

test('thinkingIndicatorHtml shows no timestamp', () => {
  assert.ok(!thinkingIndicatorHtml(AGENT).includes('msg-time'));
});

// ── agentMessageHtml ────────────────────────────────────────────────────────

test('agentMessageHtml matches the addAgentMsg markup', () => {
  assert.strictEqual(
    agentMessageHtml(AGENT, 'MD(BODY)', TIME),
    SENDER + TIME + '</div><div class="msg-bubble">MD(BODY)</div>'
  );
});

test('agentMessageHtml renders without a time span when none is given', () => {
  assert.strictEqual(
    agentMessageHtml(AGENT, 'MD(HIST)', ''),
    SENDER + '</div><div class="msg-bubble">MD(HIST)</div>'
  );
});

test('agentMessageHtml does not escape its body, which arrives pre-rendered', () => {
  // Callers pass formatMd() or esc() output. Escaping here would double-encode
  // every message in the thread.
  assert.ok(agentMessageHtml(AGENT, '<em>hi</em>', '').includes('<em>hi</em>'));
});

// ── agentStreamingMessageHtml ───────────────────────────────────────────────

test('agentStreamingMessageHtml renders an empty streaming span for a fresh bubble', () => {
  assert.strictEqual(
    agentStreamingMessageHtml(AGENT, '', TIME),
    SENDER + TIME + '</div><div class="msg-bubble"><span class="streaming-text"></span></div>'
  );
});

test('agentStreamingMessageHtml renders prefilled text for a reconnect snapshot', () => {
  assert.strictEqual(
    agentStreamingMessageHtml(AGENT, 'MD(RAW)', TIME),
    SENDER + TIME + '</div><div class="msg-bubble"><span class="streaming-text">MD(RAW)</span></div>'
  );
});

test('agentStreamingMessageHtml keeps the streaming-text class the stream updates target', () => {
  // render-stream-text and promote-handoff-message both querySelector
  // '.streaming-text' on the element this markup produces.
  assert.ok(agentStreamingMessageHtml(AGENT, '', '').includes('class="streaming-text"'));
});

// ── userBubbleHtml ──────────────────────────────────────────────────────────

test('userBubbleHtml renders a bare bubble with no sender line', () => {
  assert.strictEqual(userBubbleHtml('ESC(BODY)'), '<div class="msg-bubble">ESC(BODY)</div>');
  assert.ok(!userBubbleHtml('x').includes('msg-sender'));
});

// ── module shape ────────────────────────────────────────────────────────────

test('module exports exactly its six helpers and nothing else', () => {
  // The surface is enumerated so adding a public helper is a deliberate edit
  // to this test rather than a side effect.
  assert.deepStrictEqual(Object.keys(require('../../public/chat-markup.js')).sort(), [
    'agentMessageHtml',
    'agentSenderHtml',
    'agentStreamingMessageHtml',
    'msgTimeHtml',
    'thinkingIndicatorHtml',
    'userBubbleHtml',
  ]);
});

// ── the invariant that keeps this module the only source ────────────────────

// Walk the hand-written client scripts. The vendored trees are third-party
// and the editor bundle is generated, so neither is ours to hold to this rule.
function clientScripts(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['vendor', 'editor'].includes(entry.name)) continue;
      clientScripts(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('no chat message markup is written outside chat-markup.js', () => {
  // The failure this prevents: someone adds a chat surface, copies a bubble
  // literal to get going, and the client is back to rendering the same agent
  // two different ways with nothing to catch it. That is exactly how the
  // three byte-identical thinking bubbles came to exist, one per extraction
  // slice.
  //
  // These are markup tokens, spelt with `class="`, so selector reads like
  // querySelector('.msg-bubble') and classList.remove('streaming-text') are
  // untouched: finding a node is not authoring one.
  const TOKENS = ['class="msg-sender"', 'class="msg-bubble', 'class="streaming-text"'];
  const publicDir = path.join(__dirname, '..', '..', 'public');
  const owner = path.join(publicDir, 'chat-markup.js');

  const files = clientScripts(publicDir);
  assert.ok(files.length >= 15, `sanity: scanned ${files.length} client scripts`);
  assert.ok(files.includes(owner), 'sanity: the owning module is in scope');

  const offenders = [];
  for (const file of files) {
    if (file === owner) continue;
    const src = fs.readFileSync(file, 'utf-8');
    for (const token of TOKENS) {
      if (src.includes(token)) offenders.push(`${path.relative(publicDir, file)} writes ${token}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'chat markup belongs in chat-markup.js only');

  // And the owner really does hold all three, so the assertion above cannot
  // pass by the tokens having been renamed out of existence.
  const ownerSrc = fs.readFileSync(owner, 'utf-8');
  for (const token of TOKENS) {
    assert.ok(ownerSrc.includes(token), `chat-markup.js should still write ${token}`);
  }
});

test('the helpers are pure: no DOM, no globals, no clock read', () => {
  // Called with no document and no window in scope under node --test. If any
  // helper reached for either, or read the clock itself, this throws or
  // returns something unstable.
  assert.strictEqual(typeof document, 'undefined');
  const first = thinkingIndicatorHtml(AGENT) + agentMessageHtml(AGENT, 'b', '') + userBubbleHtml('u');
  const second = thinkingIndicatorHtml(AGENT) + agentMessageHtml(AGENT, 'b', '') + userBubbleHtml('u');
  assert.strictEqual(first, second);
});
