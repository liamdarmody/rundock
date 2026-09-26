'use strict';
// The app's half of asking an agent (public/views/conversations.js), cut from
// the shipped source so the code under test is the code that runs.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'conversations.js'), 'utf8');
const cut = (re, name) => { const m = SRC.match(re); assert.ok(m, `conversations.js no longer carries ${name}`); return m[0]; };

const AGENTS = [
  { id: 'cos', status: 'onTeam', type: 'orchestrator', displayName: 'Cos' },
  { id: 'wren', status: 'onTeam', type: 'specialist', displayName: 'Wren' },
  { id: 'doc', status: 'onTeam', type: 'platform', displayName: 'Doc' },
  { id: 'drifter', status: 'available', type: 'specialist', displayName: 'Drifter' },
];

function scope() {
  const dom = new JSDOM('<div id="messages"></div><textarea id="msg-input"></textarea><button id="send-btn"></button>');
  const created = [];
  const askFromView = new Function('agents', 'document', 'window', 'Event', 'startConversation', 'createConversation',
    `${cut(/function askFromView\(\{ agentId, message, extension, path \}\) \{[\s\S]*?\n\}/, 'askFromView')}; return askFromView;`)(
    AGENTS, dom.window.document, dom.window, dom.window.Event,
    (id) => { created.push(id); dom.window.document.getElementById('messages').innerHTML = ''; },
    () => { throw new Error('createConversation was reached directly'); });
  return { dom, created, askFromView };
}

describe('askFromView', () => {
  test('an agent not on the team is refused before any conversation is created', () => {
    for (const agentId of ['ghost', 'drifter', 'doc', 'constructor', '__proto__']) {
      const { created, askFromView } = scope();
      assert.strictEqual(askFromView({ agentId, message: 'hi', extension: 'dash', path: 'dash.md' }), `there is no agent called ${agentId} on this team`);
      assert.deepStrictEqual(created, [], agentId);
    }
  });

  test('a team agent gets a new conversation, the message in the box unsent, and the line naming who drafted it', () => {
    const { dom, created, askFromView } = scope();
    assert.strictEqual(askFromView({ agentId: 'wren', message: 'Summarise the risk', extension: 'dash', path: 'Investments/dash.md' }), null);
    assert.deepStrictEqual(created, ['wren']);
    const doc = dom.window.document;
    assert.strictEqual(doc.getElementById('msg-input').value, 'Summarise the risk');
    const line = doc.querySelector('#messages .msg-system');
    assert.strictEqual(line.textContent, 'Drafted by the dash extension from Investments/dash.md. Nothing has been sent.');
    assert.ok(!doc.getElementById('msg-input').value.includes('Drafted by'), 'the line is not part of the message');
  });
});

// The composer is one field shared by every conversation, so each conversation
// keeps its own unsent text: switching away takes the text with the
// conversation it was typed in, and switching back restores it. An ask opens a
// new conversation like any other switch, so the person's unsent text is never
// discarded by one.
describe('each conversation keeps its own unsent text', () => {
  const setupChatSrc = cut(/function setupChat\(convo\) \{[\s\S]*?\n\}/, 'setupChat');
  const createSrc = cut(/function createConversation\(agentId, title\) \{[\s\S]*?\n\}/, 'createConversation');
  const draftsSrc = cut(/const composerDrafts = [\s\S]*?\nfunction switchComposerTo[\s\S]*?\n\}\n/, 'the composer drafts');

  function app() {
    const dom = new JSDOM(`<div id="messages"></div><textarea id="msg-input"></textarea><button id="send-btn"></button>
      <input id="chat-title-input"><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>
      <div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>`);
    const agents = AGENTS.map((a) => ({ ...a, colour: '#000', icon: 'x' }));
    const api = new Function('agents', 'document', 'window', 'Event',
      `let conversations = []; let activeConversation = null;
       const state = { isProcessing: false };
       const getConvoState = () => ({ isProcessing: false }); const renderConvoList = () => {}; const switchNav = () => {}; const showView = () => {};
       const sendMessage = () => {}; const cancelProcessing = () => {};
       ${draftsSrc}
       ${setupChatSrc}
       ${createSrc}
       function startConversation(agentId) { createConversation(agentId); }
       ${cut(/function askFromView\(\{ agentId, message, extension, path \}\) \{[\s\S]*?\n\}/, 'askFromView')}
       return {
         open: (c) => { activeConversation = c; setupChat(c); },
         create: (id) => createConversation(id),
         ask: askFromView,
       };`)(agents, dom.window.document, dom.window, dom.window.Event);
    return { dom, api, input: dom.window.document.getElementById('msg-input') };
  }

  test('type in A, an ask opens B with the draft, and A still has what was typed when the person returns', () => {
    const { api, input } = app();
    const a = api.create('cos');
    input.value = 'half a thought, not sent';
    assert.strictEqual(api.ask({ agentId: 'wren', message: 'Summarise the risk', extension: 'dash', path: 'dash.md' }), null);
    assert.strictEqual(input.value, 'Summarise the risk', 'the new conversation holds the draft');
    api.open(a);
    assert.strictEqual(input.value, 'half a thought, not sent', 'the unsent text came back with its conversation');
  });

  test('ordinary switching keeps each conversation\'s text too, and a new conversation starts empty', () => {
    const { api, input } = app();
    const a = api.create('cos');
    input.value = 'for cos';
    const b = api.create('wren');
    assert.strictEqual(input.value, '');
    input.value = 'for wren';
    api.open(a);
    assert.strictEqual(input.value, 'for cos');
    api.open(b);
    assert.strictEqual(input.value, 'for wren');
    api.open(b);
    assert.strictEqual(input.value, 'for wren', 'reopening the same conversation leaves its text alone');
  });
});
