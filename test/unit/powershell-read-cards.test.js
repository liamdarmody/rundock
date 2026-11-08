'use strict';
// WHAT A PERSON SEES for an agent's PowerShell command, through the real card
// code under jsdom: the view's own request handlers, the card they draw, and
// the buttons on it.
//
// A plain read runs with no card, in a conversation and in a routine. A chain
// that reads and then writes is carded, and what the person answers on that
// card does not change how the next command is judged, except for Always
// allow, whose key is recorded below as it stands today.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const F = require('../fixtures/powershell-reads.js');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');

let chat, dom, sent;
before(() => {
  const dock = new JSDOM(INDEX_SRC).window.document.getElementById('approvals-dock').outerHTML;
  dom = new JSDOM(`<div id="messages"></div>${dock}`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'win32';
  global.workspaceMode = 'knowledge';
  global.agents = [{ id: 'assistant', displayName: 'Ada' }];
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });
beforeEach(() => {
  document.getElementById('messages').innerHTML = '';
  document.querySelector('.approvals-dock-list').innerHTML = '';
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  global.activeConversation = { id: 'c1' };
  global.unread = { markPermission() {}, resolvePermission() {} };
  sent = [];
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
  chat.setStandingToolAllows([]);
});

let seq = 0;
const ROUTINE_RUN = { id: 'run-1', routine: 'Morning Briefing', agent: 'assistant' };
// The envelope the server sends: a conversation's request names it, a
// routine's names none and carries its run.
function ask(command, where) {
  const id = `ps-card-${++seq}`;
  const d = { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'PowerShell', input: { command } } };
  if (where === 'routine') chat.handleOwnerlessPermissionRequest({ ...d, _conversationId: '', _run: ROUTINE_RUN });
  else chat.handlePermissionRequest({ ...d, _conversationId: 'c1' }, 'c1');
  return id;
}
const cardOf = (id) => document.getElementById(`perm-${id}`);
const press = (id, action) => cardOf(id).querySelector(`[data-perm-action="${action}"]`).click();
// The words a person reads on a card, without its request id.
const wordsOf = (id) => cardOf(id).querySelector('.permission-card').textContent.replace(/\s+/g, ' ').trim();
const ranWithNoCard = (id) => !cardOf(id) && sent.some(m => m.type === 'permission_response' && m.requestId === id && m.allow === true);

const WHERE = ['conversation', 'routine'];

describe('a plain PowerShell read runs with no card', () => {
  for (const where of WHERE) {
    test(`in a ${where}`, () => {
      for (const command of [...F.READS, ...F.ALIASES]) {
        const id = ask(command, where);
        assert.ok(ranWithNoCard(id), `carded in a ${where}: ${command}`);
      }
    });
  }
});

describe('a chain that reads and then writes is carded, and the answer does not carry over', () => {
  for (const where of WHERE) {
    test(`in a ${where}: after a deny, the next plain read runs with no card`, () => {
      const chain = ask(F.CARDED_CHAIN, where);
      assert.ok(cardOf(chain), 'the chain is carded');
      press(chain, 'deny');
      assert.ok(sent.some(m => m.requestId === chain && m.allow === false), 'the deny is sent');
      const read = ask('Get-Date', where);
      assert.ok(ranWithNoCard(read), 'and the plain read after it runs with no card');
    });

    test(`in a ${where}: the same chain sent again is carded again, in the same words`, () => {
      const first = ask(F.CARDED_CHAIN, where);
      press(first, 'deny');
      const again = ask(F.CARDED_CHAIN, where);
      assert.ok(cardOf(again) && cardOf(again).querySelector('[data-perm-action="allow"]'), 'carded again, and answerable');
      const fresh = ask(F.CARDED_CHAIN, where);
      assert.strictEqual(wordsOf(again), wordsOf(fresh), 'the retry reads the same as a first asking');
    });

    test(`in a ${where}: Allow once runs it once, and the identical command is carded the next time`, () => {
      const once = ask(F.CARDED_CHAIN, where);
      press(once, 'allow');
      assert.ok(sent.some(m => m.requestId === once && m.allow === true && m.card === true), 'allowed once, from the card');
      assert.ok(!sent.some(m => m.type === 'add_tool_allow'), 'and nothing is remembered');
      const next = ask(F.CARDED_CHAIN, where);
      assert.ok(cardOf(next), 'the identical command is carded again');
    });
  }

  // RECORDED AS IT STANDS, so a change to what Always allow keeps shows here
  // as a diff. The key is the command's first word, so it answers the same
  // chain again with no card, and any other command that starts with it.
  test('Always allow on the chain keeps its first word, which answers the chain again', () => {
    const always = ask(F.CARDED_CHAIN, 'conversation');
    press(always, 'always');
    assert.deepStrictEqual(sent.filter(m => m.type === 'add_tool_allow'), [{ type: 'add_tool_allow', key: 'PowerShell:Get-Content' }]);
    const again = ask(F.CARDED_CHAIN, 'conversation');
    assert.ok(ranWithNoCard(again), 'the saved key answers the same chain with no card');
    const other = ask('Get-Content notes.md; Add-Content notes.md y', 'conversation');
    assert.ok(ranWithNoCard(other), 'and another chain that starts with the same word');
    const removal = ask('Get-Content notes.md; Remove-Item notes.md', 'conversation');
    assert.ok(cardOf(removal), 'a removal is carded whatever was saved');
  });
});

describe('a failure forced inside the shared definition cards, and never allows', () => {
  const seam = require('../../public/read-only-shell.js').powerShellReadingSeam;
  for (const where of WHERE) {
    test(`in a ${where}`, () => {
      const kept = seam.beforeReading;
      seam.beforeReading = () => { throw new Error('forced failure'); };
      let id;
      try { id = ask('Get-Date', where); } finally { seam.beforeReading = kept; }
      assert.ok(cardOf(id), `a plain read is carded while the reading fails, in a ${where}`);
      assert.ok(!sent.some(m => m.requestId === id), 'and nothing is answered on the person\'s behalf');
      assert.ok(ranWithNoCard(ask('Get-Date', where)), 'with the reading back, it runs with no card again');
    });
  }
});
