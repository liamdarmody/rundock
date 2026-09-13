'use strict';
// A HANDOFF THE PERSON CAN SEE WHILE IT HAPPENS, asserted on the DOM.
//
// The defect these pin was invisible to every test in the release that shipped
// it, because every one of those tests asserted on the stored transcript. The
// transcript was correct. `appendTranscript` writes to memory and disk and
// tells no connected client, and the live path could only show a delegating
// agent's words by promoting a streaming bubble that an agent emitting a bare
// tool_use block never creates. So the line was right on reload and absent at
// the moment it happened, which is the only moment the person was watching.
//
// So these drive the real reducer and the real effect executor against a real
// document and assert on the nodes that end up in it. A transcript assertion
// discharges none of them, by construction: there is no transcript here.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');

// The executor lifted out of app.js and run, rather than reimplemented here.
// Reimplementing it would have passed before the fix: the bug was that the real
// one did nothing to the DOM when there was no bubble to promote.
function extractExecutor(name) {
  const key = `'${name}': (convoId, ef) => {`;
  const at = APP_SRC.indexOf(key);
  assert.ok(at > -1, `app.js still defines the ${name} executor; if this fails the wiring moved`);
  let i = at + key.length - 1, depth = 0;
  for (; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = APP_SRC.slice(at + key.length, i);
  // eslint-disable-next-line no-new-func
  return new Function('convoId', 'ef', body);
}

let dom, chat, reduce, promote;

before(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  // The roster addAgentMsg resolves the speaker against, as index.html supplies it.
  global.agents = [{ id: 'default', displayName: 'Roo', type: 'orchestrator' }, { id: 'vox', displayName: 'Vox', type: 'specialist' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
  reduce = cs.reduce || cs.reduceMessage || cs;
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  promote = extractExecutor('promote-handoff-message');
});

function freshDom() {
  document.getElementById('messages').innerHTML = '';
}
function renderedAgentTurns() {
  return [...document.getElementById('messages').children]
    .filter((el) => el.className.includes('msg-agent'))
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
}

describe('the handoff line is on screen while the handoff happens', () => {
  test('an agent that delegates without speaking still gets a visible turn', () => {
    // THE REPORTED DEFECT. Before the fix this rendered nothing at all: the
    // executor updated the in-memory conversation and returned, so the person
    // watched the conversation jump to a new agent with no explanation.
    freshDom();
    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    promote('c1', { text: 'Handing to Vox to write the X.com thread.', agentId: 'default' });

    const turns = renderedAgentTurns();
    assert.strictEqual(turns.length, 1,
      'the delegating agent produced exactly one visible turn on screen');
    assert.match(turns[0], /Handing to Vox to write the X\.com thread\./,
      'carrying the line it wrote, in the document the person is looking at');
  });

  test('an agent that did speak has its own bubble promoted, never a second one', () => {
    // The other direction, so the fix cannot be satisfied by always appending:
    // a turn that streamed is already on screen and must not be duplicated.
    freshDom();
    const messages = document.getElementById('messages');
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent';
    bubble.innerHTML = '<div class="streaming-text">partial</div>';
    messages.appendChild(bubble);

    global.conversations = [{ id: 'c1', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: bubble });

    promote('c1', { text: 'I will take this to Vox.', agentId: 'default' });

    const turns = renderedAgentTurns();
    assert.strictEqual(turns.length, 1, 'one turn, not the streamed one plus an appended copy');
    assert.match(turns[0], /I will take this to Vox\./);
    assert.strictEqual(bubble.querySelector('.streaming-text'), null,
      'and the bubble stopped being a streaming one rather than being left mid-flight');
  });

  test('a conversation the person is not looking at renders nothing into this one', () => {
    freshDom();
    global.conversations = [{ id: 'c2', agentId: 'default', messages: [] }];
    global.activeConversation = { id: 'c1' };
    global.getConvoState = () => ({ currentStreamingMsg: null });

    promote('c2', { text: 'Handing to Ren.', agentId: 'default' });

    assert.deepStrictEqual(renderedAgentTurns(), [],
      'a handoff in a background conversation must not appear in the open one');
  });
});
