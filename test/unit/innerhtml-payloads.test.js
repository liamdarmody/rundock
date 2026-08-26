'use strict';
// Hostile agent identity, driven through the real chat thread.
//
// WHY THESE ARE NOT UNIT TESTS OF AN ESCAPER
//
// An escaper tested on its own proves the escaper works. It says nothing about
// whether the escaper is CALLED, which is the entire defect this branch fixes:
// `esc` and `escAttr` both existed and both worked, and the agent's colour,
// icon and display name went into the page past both of them. So every test
// below builds the payload an agent file can actually carry, hands it to the
// function the app really calls, and reads what came out of the DOM.
//
// The assertion is structural rather than behavioural, matching the renderer's
// own hardening suite: an `onerror` does not fire in jsdom because jsdom loads
// no images, so a test that waited for it would pass against unescaped markup.
// What is asserted instead is that the ELEMENT WAS NOT CREATED and that NO
// ATTRIBUTE BEGINNING `on` EXISTS anywhere in what was rendered. Both are true
// of a safe render and false of the code before this change.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');

// What a RUNDOCK:SAVE_AGENT block can put in `.claude/agents/helper.md`.
// Nothing here is exotic: `parseAgentFrontmatter` takes the rest of the line
// after `key:`, strips one wrapping pair of quotes, and validates nothing.
//
//   icon:        <img src=x onerror=...>      element content, no quote needed
//   displayName: <svg onload=...>             element content, no quote needed
//   colour:      red" onmouseover="...        ends the style attribute
//   role:        <img src=y onerror=...>      element content
const HOSTILE_AGENT = {
  id: 'helper',
  type: 'specialist',
  status: 'onTeam',
  displayName: '<svg onload="window.__xss=1"></svg>',
  icon: '<img src=x onerror="window.__xss=1">',
  colour: 'red" onmouseover="window.__xss=1',
  role: '<img src=y onerror="window.__xss=1">',
  description: '<img src=z onerror="window.__xss=1">',
};

// Elements a payload in this file would have to create to do anything. None of
// them is produced by the markup under test when it behaves, so finding one is
// finding the payload rather than finding a false positive.
const INJECTED = ['IMG', 'SCRIPT', 'IFRAME', 'SVG', 'OBJECT', 'EMBED', 'STYLE', 'LINK'];

/**
 * Nothing in `root` can run.
 *
 * Two separate claims, reported separately, because they fail for different
 * reasons: an attribute means a value ended its attribute, an element means a
 * value was never escaped for element content at all.
 */
function assertInert(root, label, allowHandlers = []) {
  const handlers = [];
  const created = [];
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      // AN INLINE HANDLER IS NOT AUTOMATICALLY A FINDING, and this is the one
      // place that distinction has to be made carefully.
      //
      // This branch does not remove the client's inline handlers: there are 75
      // of them, they are what makes a Content-Security-Policy impossible
      // today, and removing them is a different card. What it removes is every
      // INTERPOLATION of external data into one. So a handler whose value is a
      // fixed literal the caller names here is the fixed shape, and anything
      // else is a value that reached JavaScript position.
      //
      // The allowlist is exact strings rather than a pattern, so a handler that
      // grows an interpolation fails this even if it still looks familiar.
      if (/^on/i.test(attr.name) && !allowHandlers.includes(attr.value)) {
        handlers.push(`<${el.tagName.toLowerCase()} ${attr.name}="${attr.value}">`);
      }
    }
    if (INJECTED.includes(el.tagName)) created.push(el.tagName.toLowerCase());
  }
  assert.deepStrictEqual(handlers, [],
    `${label}: an event-handler attribute carries something other than a fixed literal`);
  assert.deepStrictEqual(created, [],
    `${label}: the payload created an element`);
  assert.notStrictEqual(root.ownerDocument.defaultView.__xss, 1,
    `${label}: the payload ran`);
}

/** The payload is still legible to the reader, as its own characters. */
function assertLegible(root, label) {
  const shown = root.textContent;
  assert.ok(shown.includes('<img src=x onerror='),
    `${label}: the icon was dropped rather than shown as text, so the reader `
    + 'cannot see what the agent file actually says');
}

// ── the chat thread, through views/chat.js ──────────────────────────────────

let dom, chat;

before(() => {
  dom = new JSDOM(
    '<div id="messages"></div><div id="chat-status"></div><button id="send-btn"></button>',
    { runScripts: 'dangerously' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.agents = [HOSTILE_AGENT];
  global.conversations = [{ id: 'c1', agentId: 'helper', agent: HOSTILE_AGENT, messages: [] }];
  global.activeConversation = global.conversations[0];
  global.convoState = {};
  global.workingConvos = new Set();
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.unread = {};
  global.agentLastActivity = {};
  global.ws = null;
  global.userScrolledUp = false;
  global.currentView = 'chat';
  // The real escapers, character for character as app.js declares them. A
  // weaker stub here would let a fix that relies on the caller's escaper pass
  // against escaping this suite invented.
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.stripRundockMarkers = (t) => t;
  global.formatMd = (t) => global.esc(t);
  global.formatTimeAgo = () => 'a while ago';
  global.renderConvoList = () => {};
  global.updateWorkingBadge = () => {};
  global.updateUnreadBadge = () => {};
  global.persistConversation = () => {};
  global.tryMessageAnchor = () => false;
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockConversationState = require('../../public/conversation-state.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.getConvoState = (id) => (global.convoState[id] = global.convoState[id] || {});
  chat = require('../../public/views/chat.js');

  // The app.js executors below are evaluated INSIDE the jsdom window, because
  // that is the only way to run a fragment of a file that cannot be required.
  // Code eval'd there resolves its free names against that window, not against
  // node's `global`, so the shared client state has to exist on both. Mirrored
  // by name rather than copied wholesale so a name the executor needs and this
  // list forgets fails loudly as a ReferenceError, which is how this was found.
  for (const name of [
    'agents', 'conversations', 'activeConversation', 'convoState', 'workingConvos',
    'getConvoState', 'formatMd', 'esc', 'escAttr', 'scrollBottom', 'formatToolName',
    'RundockChatMarkup', 'RundockConversationState', 'RundockPermissions',
  ]) {
    dom.window[name] = global[name] !== undefined ? global[name] : chat[name];
  }
  // Two the executors call that belong to the chat view rather than to shared
  // state, and one the thinking indicator writes its tool name through.
  dom.window.scrollBottom = chat.scrollBottom;
  dom.window.formatToolName = chat.formatToolName;
});

after(() => {
  // startProcessing installs a watchdog interval; leaving it running holds the
  // test runner open, which is a hang rather than a failure and is worse.
  for (const state of Object.values(global.convoState || {})) {
    if (state && state.processingTimeout) clearInterval(state.processingTimeout);
  }
  if (dom) dom.window.close();
});

function messages() {
  const m = document.getElementById('messages');
  m.innerHTML = '';
  dom.window.__xss = 0;
  return m;
}

describe('an agent cannot write script into the chat thread through its own file', () => {
  test('a settled message from a hostile agent renders its identity as text', () => {
    const m = messages();
    chat.addAgentMsg('an ordinary reply', 'helper');
    assertInert(m, 'addAgentMsg');
    assertLegible(m, 'addAgentMsg');
  });

  test('the thinking indicator renders it as text, and it is the earliest one', () => {
    // This is the site that fires first: it is drawn before a single token of
    // the response has arrived, so it is the payload's best trigger and the
    // one a person is least likely to be watching for.
    const m = messages();
    chat.startProcessing('c1');
    const state = global.getConvoState('c1');
    if (state.processingTimeout) { clearInterval(state.processingTimeout); state.processingTimeout = null; }
    assert.ok(document.getElementById('thinking-indicator'), 'sanity: the indicator was drawn');
    assertInert(m, 'startProcessing');
    assertLegible(m, 'startProcessing');
  });

  test('the delegation divider renders it as text', () => {
    const m = messages();
    m.appendChild(chat.buildDelegationDivider(HOSTILE_AGENT, false));
    assertInert(m, 'buildDelegationDivider');
    assertLegible(m, 'buildDelegationDivider');
    assert.ok(m.textContent.includes('joined'), 'sanity: the divider still says what it says');
  });

  test('replayed history renders it as text, on every open of the conversation', () => {
    // The persisted path matters on its own: a payload that only fires live is
    // gone after a reload, and this one is not. It is re-rendered from the
    // transcript every time the conversation is opened.
    const m = messages();
    const frag = document.createElement('div');
    frag.appendChild(chat.buildDelegationDivider(HOSTILE_AGENT, false, { historyClass: true }));
    m.appendChild(frag);
    m.appendChild(chat.addAgentMsg('a stored reply', 'helper', false, '2026-08-25T09:41:00Z'));
    assertInert(m, 'history replay');
  });

  test('the colour is refused rather than escaped, so no CSS reaches the attribute', () => {
    // Escaping the colour would stop the attribute breakout and leave the
    // other half: a value that stays inside the attribute and is still CSS.
    // The rule refuses it, so what lands is the fallback.
    const m = messages();
    chat.addAgentMsg('x', 'helper');
    const avatar = m.querySelector('.avatar');
    assert.ok(avatar, 'sanity: the avatar was drawn');
    const style = avatar.getAttribute('style') || '';
    assert.ok(!style.includes('onmouseover'), 'the payload survived inside the style attribute');
    assert.match(style, /background:var\(--accent\)/,
      'a refused colour should become the same fallback a missing one already got');
  });

  test('an ordinary agent still renders exactly as it did', () => {
    // The fix is worthless if it greys out every real agent. This is one of
    // the eight colours lib/agents/discovery.js assigns.
    const m = messages();
    global.agents = [{ id: 'p', displayName: 'Piper', icon: 'P', colour: '#E87A5A' }];
    chat.addAgentMsg('hello', 'p');
    global.agents = [HOSTILE_AGENT];
    const html = m.innerHTML;
    assert.ok(html.includes('style="color:#E87A5A"'), 'the sender line keeps its colour');
    assert.ok(html.includes('style="background:#E87A5A"'), 'the avatar keeps its colour');
    assert.ok(html.includes('>P</div>'), 'the icon renders as itself');
    assert.ok(html.includes('Piper'), 'the name renders as itself');
  });
});

// ── the two assignments in app.js ───────────────────────────────────────────
//
// app.js cannot be required: it touches `document` at top level. Both of its
// agent-identity sites live in the effect-executor map, so each is cut out of
// the source by name and run, which is the technique test/unit/team-sidebar.
// test.js uses for the same reason. A copy of the executor written here would
// keep passing after app.js stopped carrying it.

function appEffect(name) {
  const re = new RegExp(`'${name}': \\(([^)]*)\\) => \\{([\\s\\S]*?)\\n  \\},\\n`);
  const m = APP_SRC.match(re);
  assert.ok(m && m[2] && m[2].trim(), `app.js no longer carries the '${name}' effect`);
  return dom.window.eval(`(function (${m[1]}) {${m[2]}\n})`);
}

describe('the streaming and thinking bubbles app.js draws', () => {
  test('the streaming bubble renders a hostile identity as text', () => {
    const m = messages();
    global.getConvoState('c1').currentStreamingMsg = null;
    appEffect('start-streaming-bubble')('c1', { agentId: 'helper' });
    assert.ok(m.querySelector('.streaming-text'), 'sanity: the bubble was drawn');
    assertInert(m, 'start-streaming-bubble');
    assertLegible(m, 'start-streaming-bubble');
  });

  test('the re-added thinking indicator renders a hostile identity as text', () => {
    const m = messages();
    appEffect('ensure-tool-status')('c1', { agentId: 'helper', toolName: 'Read' });
    assert.ok(document.getElementById('thinking-status'), 'sanity: the indicator was drawn');
    assertInert(m, 'ensure-tool-status');
    assertLegible(m, 'ensure-tool-status');
  });
});

// ── the roster, through views/team.js ───────────────────────────────────────
//
// The team panel is the home screen, so this is the site a payload reaches
// soonest after a workspace is opened. It carries BOTH causes at once: the
// agent's colour, icon, display name and description go into markup, and the
// agent's id went into `onclick="showProfile('...')"`, which no escaper fixes.

const TEAM_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'team.js'), 'utf-8');

// An agent file called `evil');alert(1);//.md` gives an id of exactly this.
const HANDLER_BREAKER = "evil');alert(1);//";

function teamShell(roster) {
  const d = new JSDOM('<div id="agent-list"></div><div id="sidebar-team-header"></div>',
    { runScripts: 'dangerously' });
  const w = d.window;
  w.eval(TEAM_SRC);
  w.agents = roster;
  w.convoState = {};
  w.conversations = [];
  w.agentLastActivity = {};
  w.esc = (s) => { const e = w.document.createElement('div'); e.textContent = s == null ? '' : s; return e.innerHTML; };
  w.escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // The REAL colour rule, not a stub. A stub here would assert that this test
  // escapes correctly rather than that the app does.
  w.RundockAgentColour = require('../../public/agent-colour.js');
  w.formatTimeAgo = () => 'a while ago';
  w.getTeamAgents = () => w.agents.filter(a => a.status === 'onTeam');
  w.getPlatformAgents = () => [];
  w.getGuide = () => null;
  w.renderOrgChart = () => {};
  w.renderRoutinesPanel = () => {};
  return { w, doc: w.document, dom: d };
}

describe('the agent roster cannot be made to run code by an agent file', () => {
  test('a hostile identity renders as text on the home screen', () => {
    const { w, doc, dom } = teamShell([{ ...HOSTILE_AGENT, status: 'onTeam' }]);
    w.renderAgentList();
    const list = doc.getElementById('agent-list');
    assert.ok(list.textContent.includes('<img src=x onerror='), 'sanity: the roster drew the agent');
    // The roster keeps its inline handler and it is a fixed literal. Naming it
    // exactly is the assertion: if the id ever goes back into the handler, the
    // value stops matching and this fails.
    assertInert(list, 'renderAgentList', ['showProfile(this.dataset.agent)']);
    dom.window.close();
  });

  test('an id that would close the handler travels as data, not as code', () => {
    const { w, doc, dom } = teamShell([
      { id: HANDLER_BREAKER, status: 'onTeam', displayName: 'Evil', icon: 'E', colour: '#f00' },
    ]);
    w.renderAgentList();
    const row = doc.querySelector('.agent-status-item');
    // The handler is a fixed literal with nothing interpolated into it, which
    // is the only shape that cannot be broken: escaping cannot help here,
    // because the parser decodes character references before any of the
    // attribute is JavaScript.
    assert.strictEqual(row.getAttribute('onclick'), 'showProfile(this.dataset.agent)',
      'the roster row still splices a value into its handler');
    // And the value still travels, so the row is not merely inert but correct.
    assert.strictEqual(row.dataset.agent, HANDLER_BREAKER,
      'the row does not carry the agent it opens');
    assert.ok(!(row.getAttribute('onclick') || '').includes('alert'),
      'the payload reached the handler');
    dom.window.close();
  });

  test('a colour that is still CSS is refused, not escaped into the attribute', () => {
    const { w, doc, dom } = teamShell([{
      id: 'a', status: 'onTeam', displayName: 'A', icon: 'A',
      colour: 'red;background-image:url(https://example.invalid/beacon)',
    }]);
    w.renderAgentList();
    const style = doc.querySelector('.avatar').getAttribute('style') || '';
    assert.ok(!/url\(/i.test(style), 'a url() reached the style attribute');
    assert.ok(!style.includes(';background-image'), 'a second declaration reached the style attribute');
    dom.window.close();
  });

  test('an ordinary roster is unchanged', () => {
    const { w, doc, dom } = teamShell([
      { id: 'piper', status: 'onTeam', displayName: 'Piper', icon: 'P', colour: '#E87A5A', role: 'Ops' },
    ]);
    w.renderAgentList();
    const row = doc.querySelector('.agent-status-item');
    assert.strictEqual(row.dataset.agent, 'piper');
    assert.match(doc.querySelector('.avatar').getAttribute('style'), /background:#E87A5A/);
    assert.strictEqual(doc.querySelector('.agent-status-name').textContent, 'Piper');
    dom.window.close();
  });
});

// ── kanban card titles, through viewers/board-markdown.js ───────────────────

const boardMarkdown = require('../../public/viewers/board-markdown.js');

describe('a kanban card title cannot break out of the attribute it is written into', () => {
  function render(src) {
    const d = new JSDOM('<div id="card"></div>');
    const host = d.window.document.getElementById('card');
    host.innerHTML = boardMarkdown.renderCardHtml(src);
    return { host, anchor: host.querySelector('a'), dom: d };
  }

  test('a tag inside a wikilink target no longer truncates the target', () => {
    // Before: data-target="note <span class="  and the rest became text.
    const { host, anchor, dom } = render('[[note #tag onmouseover=alert(1) x]]');
    assert.strictEqual(anchor.getAttribute('data-target'), 'note #tag onmouseover=alert(1) x',
      'the wikilink target is not the text the card was written with');
    assertInert(host, 'board wikilink');
    dom.window.close();
  });

  test('a date inside a link destination no longer costs the link its rel', () => {
    // The one that mattered: target and rel were written AFTER the attribute
    // that got cut, so both were lost and the anchor navigated the top frame.
    const { host, anchor, dom } = render('[link](https://x/2024-01-01/y)');
    assert.strictEqual(anchor.getAttribute('href'), 'https://x/2024-01-01/y');
    assert.strictEqual(anchor.getAttribute('rel'), 'noreferrer noopener',
      'the link lost the rel that keeps it out of the opener');
    assert.strictEqual(anchor.getAttribute('target'), '_blank');
    dom.window.close();
  });

  test('emphasis and code inside a target stay out of the attribute', () => {
    const { anchor, dom } = render('[[a *b* c]]');
    assert.strictEqual(anchor.getAttribute('data-target'), 'a *b* c');
    assert.ok(!anchor.getAttribute('data-target').includes('<em>'), 'an element reached the attribute');
    dom.window.close();
  });

  test('the display text still renders its tags, dates and emphasis', () => {
    // The fix holds the ATTRIBUTE out of reach, not the display text. A fix
    // that quietly stopped rendering chips would pass every test above.
    const { host, dom } = render('[[note #tag]] and **bold** on 2024-01-01');
    assert.ok(host.querySelector('.board-tag'), 'the tag chip stopped rendering');
    assert.ok(host.querySelector('.board-date'), 'the date span stopped rendering');
    assert.ok(host.querySelector('strong'), 'emphasis stopped rendering');
    dom.window.close();
  });

  test('a javascript scheme is still refused', () => {
    const { host, dom } = render('[click](javascript:alert(1))');
    assert.strictEqual(host.querySelector('a'), null, 'a script scheme became a link');
    dom.window.close();
  });
});
