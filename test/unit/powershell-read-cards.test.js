'use strict';
// WHAT A PERSON SEES for an agent's PowerShell command, through the real card
// code under jsdom: the view's own request handlers, the card they draw, and
// the buttons on it.
//
// A plain read runs with no card, in a conversation and in a routine. A chain
// that reads and then writes is carded, and what the person answers on that
// card does not change how the next command is judged, except for Always
// allow, which saves the one command the chain runs besides reads and answers
// only what that command covers.
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

  // The key is the one command the chain runs besides its reads, so it
  // answers the same chain again with no card, and a chain whose other part
  // differs is carded.
  test('Always allow on the chain saves the command it runs besides reads, which answers the chain again', () => {
    const always = ask(F.CARDED_CHAIN, 'conversation');
    press(always, 'always');
    assert.deepStrictEqual(sent.filter(m => m.type === 'add_tool_allow'), [{ type: 'add_tool_allow', key: 'PowerShell:Set-Content' }]);
    const again = ask(F.CARDED_CHAIN, 'conversation');
    assert.ok(ranWithNoCard(again), 'the saved key answers the same chain with no card');
    const other = ask('Get-Content notes.md; Add-Content notes.md y', 'conversation');
    assert.ok(cardOf(other), 'a chain whose other part differs is carded');
    const removal = ask('Get-Content notes.md; Remove-Item notes.md', 'conversation');
    assert.ok(cardOf(removal), 'a removal is carded whatever was saved');
  });
});

describe('Always allow is offered only when there is one command to save', () => {
  const buttons = (id) => [...cardOf(id).querySelectorAll('[data-perm-action]')].map(b => b.getAttribute('data-perm-action'));
  for (const where of WHERE) {
    test(`in a ${where}: a command with no command name, or two commands besides reads, offers Allow and Deny only`, () => {
      for (const command of ['(Get-Date).ToString("HH:mm")', '$t = Get-Date', '[DateTime]::Now',
        'Get-Date; Set-Content notes.md x; npm test']) {
        const id = ask(command, where);
        assert.ok(cardOf(id), `carded: ${command}`);
        assert.deepStrictEqual(buttons(id), ['allow', 'deny'], `Allow and Deny only: ${command}`);
      }
      assert.ok(!sent.some(m => m.type === 'add_tool_allow'), 'and nothing is saved');
    });
  }

  test('Always allow on a read and one command saves that command, and the same chain then runs with no card', () => {
    const id = ask('Get-Date; npm test', 'conversation');
    assert.deepStrictEqual(buttons(id), ['allow', 'always', 'deny'], 'Always allow is offered');
    press(id, 'always');
    assert.deepStrictEqual(sent.filter(m => m.type === 'add_tool_allow'), [{ type: 'add_tool_allow', key: 'PowerShell:npm' }]);
    assert.ok(ranWithNoCard(ask('Get-Date; npm test', 'conversation')), 'the same chain runs with no card');
    assert.ok(cardOf(ask('Get-Date; git status', 'conversation')), 'a chain whose other part differs is carded');
  });
});

describe('a saved key answers what it covers, in a conversation and in a routine', () => {
  for (const where of WHERE) {
    test(`in a ${where}: a chain whose every command is saved runs with no card, every time`, () => {
      chat.setStandingToolAllows(['PowerShell:npm', 'PowerShell:git']);
      for (let i = 0; i < 3; i++) {
        assert.ok(ranWithNoCard(ask('npm test; git status', where)), `try ${i + 1}`);
        assert.ok(ranWithNoCard(ask('Get-Date; npm test', where)), `try ${i + 1}`);
      }
      assert.ok(cardOf(ask('npm test; Set-Content notes.md x', where)), 'a part no saved key names is carded');
      assert.ok(cardOf(ask('npm test $(Set-Content notes.md x)', where)), 'and so is a part the reading cannot follow');
    });
  }

  test('Settings lists a catch-all key from an earlier release with its remove control, it answers nothing, and removing a key cards what it answered', () => {
    const settings = require('../../public/views/settings.js');
    document.body.insertAdjacentHTML('beforeend', '<div id="tool-allows-block"></div>');
    global.setStandingToolAllows = chat.setStandingToolAllows;
    global.WebSocket = { OPEN: 1 };
    global.ws.readyState = 1;
    try {
      settings.toolAllowsArrived({ tools: ['PowerShell:PowerShell', 'PowerShell:npm'] });
      const rows = [...document.querySelectorAll('#tool-allows-block .tool-allow-row')];
      assert.deepStrictEqual(rows.map(r => r.querySelector('.tool-allow-key').textContent), ['PowerShell:PowerShell', 'PowerShell:npm']);
      assert.ok(rows[0].querySelector('.settings-row-remove'), 'the old key has its remove control');
      const chain = '$t = Get-Date; Add-Content time-log.md $t';
      assert.ok(cardOf(ask(chain, 'conversation')), 'the catch-all answers nothing');
      assert.ok(ranWithNoCard(ask('Get-Date; npm test', 'conversation')), 'a key naming the command answers it');

      settings.revokeToolAllowAt(0);
      assert.deepStrictEqual(sent.filter(m => m.type === 'remove_tool_allow'), [{ type: 'remove_tool_allow', key: 'PowerShell:PowerShell' }]);
      settings.toolAllowsArrived({ tools: ['PowerShell:npm'] });
      assert.ok(cardOf(ask(chain, 'conversation')), 'removing the catch-all changes nothing: the chain still cards');
      assert.ok(ranWithNoCard(ask('Get-Date; npm test', 'conversation')), 'and the chain the other key answers still runs');

      settings.revokeToolAllowAt(0);
      settings.toolAllowsArrived({ tools: [] });
      assert.ok(cardOf(ask('Get-Date; npm test', 'conversation')), 'removing the key cards the chain it answered');
    } finally {
      delete global.setStandingToolAllows;
      document.getElementById('tool-allows-block').remove();
    }
  });

  for (const where of WHERE) {
    test(`in a ${where}: saved keys that are not strings, or a reading that fails, answer nothing`, () => {
      chat.setStandingToolAllows([42, null, { key: 'PowerShell:npm' }, ['PowerShell:npm']]);
      assert.ok(cardOf(ask('Get-Date; npm test', where)), 'keys that are not strings answer nothing');
      chat.setStandingToolAllows('PowerShell:npm');
      assert.ok(cardOf(ask('Get-Date; npm test', where)), 'nor does a list that is not a list');
      chat.setStandingToolAllows(['PowerShell:npm']);
      const seam = require('../../public/read-only-shell.js').powerShellReadingSeam;
      const kept = seam.beforeReading;
      seam.beforeReading = () => { throw new Error('forced failure'); };
      let id;
      try { id = ask('npm test', where); } finally { seam.beforeReading = kept; }
      assert.ok(cardOf(id), 'a failure while the parts are matched cards');
      assert.ok(!sent.some(m => m.requestId === id), 'and nothing is answered on the person\'s behalf');
      assert.ok(ranWithNoCard(ask('npm test', where)), 'with the reading back, the saved key answers again');
    });
  }
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
