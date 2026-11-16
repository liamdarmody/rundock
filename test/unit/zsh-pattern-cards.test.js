'use strict';
// WHAT A PERSON SEES, in Notes mode with "Always allow ls" saved, for a line
// that hides code in a zsh file pattern, through the real card code under
// jsdom: the view's own request handlers, the card they draw, and the buttons
// on it.
//
// zsh runs the code of a glob qualifier as it expands the word, so
// `ls 'a'*(e:'cp x f':)` copies over f. The saved answer is keyed on `ls`, and
// it used to run the line with no card. Now the line is carded every time,
// with Allow and Deny only and a sentence saying why, and what the person
// answers there does not change how the next command is judged.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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
  global.serverPlatform = 'darwin';
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
  chat.setStandingToolAllows(['Bash:ls']);
});

let seq = 0;
const ROUTINE_RUN = { id: 'run-1', routine: 'Tidy notes', agent: 'assistant' };
// The envelope the server sends: a conversation's request names it, a
// routine's names none and carries its run.
function bash(command, where) {
  const id = `zsh-pattern-card-${++seq}`;
  const d = { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } };
  if (where === 'routine') chat.handleOwnerlessPermissionRequest({ ...d, _conversationId: '', _run: ROUTINE_RUN });
  else chat.handlePermissionRequest({ ...d, _conversationId: 'c1' }, 'c1');
  return id;
}
const cardOf = (id) => document.getElementById(`perm-${id}`);
const press = (id, action) => cardOf(id).querySelector(`[data-perm-action="${action}"]`).click();
const buttonsOf = (id) => [...cardOf(id).querySelectorAll('[data-perm-action]')].map(b => b.dataset.permAction);
const wordsOf = (id) => cardOf(id).querySelector('.permission-card').textContent.replace(/\s+/g, ' ').trim();
const ranWithNoCard = (id) => !cardOf(id) && sent.some(m => m.type === 'permission_response' && m.requestId === id && m.allow === true);
const contextOf = (id) => cardOf(id).querySelector('.permission-context').textContent;
const show = (cmd) => JSON.stringify(cmd);
const WHY = {
  pattern: 'This line has a parenthesis inside a word, which the shell can use to run hidden code, so Rundock asks every time and there is no Always allow.',
  unread: 'Rundock could not read this line all the way through, so it asks every time and there is no Always allow.',
};

const T = '~/.claude/settings.json';
const LINES = [`ls *(e:'cp x ${T}':)`, `ls 'a'*(e:'cp x ${T}':)`, `ls \\a*(e:'cp x ${T}':)`, `ls "$PWD"/*(e:'cp x ${T}':)`];
const LINE = LINES[1];
const WHERE = ['conversation', 'routine'];

function assertCardedAllowOrDeny(id, where, command) {
  assert.ok(cardOf(id), `not carded in a ${where}: ${show(command)}`);
  assert.deepStrictEqual(buttonsOf(id), ['allow', 'deny'], `Allow and Deny only, no Always allow: ${show(command)}`);
  assert.ok(!sent.some(m => m.requestId === id), `answered on the person's behalf: ${show(command)}`);
}

describe('with "Always allow ls" saved, a line that hides code in a zsh file pattern is carded', () => {
  for (const where of WHERE) {
    test(`in a ${where}, however the word starts, with Allow and Deny only`, () => {
      for (const command of LINES) assertCardedAllowOrDeny(bash(command, where), where, command);
    });

    test(`in a ${where}, the card says why it asks, and that there is no Always allow`, () => {
      for (const command of [...LINES, 'f() { echo hi; }; f']) {
        assert.strictEqual(contextOf(bash(command, where)), WHY.pattern, show(command));
      }
      // A line the view could not read all the way through says so instead.
      for (const command of [`ls x(+f) 'it`, `echo ${'$('.repeat(40)}x${')'.repeat(40)}`]) {
        assert.strictEqual(contextOf(bash(command, where)), WHY.unread, show(command));
      }
      // A line graded high as destructive first keeps the sentence its command gives.
      assert.strictEqual(contextOf(bash(`rm *(e:'cp x ${T}':)`, where)), 'This will permanently delete files');
    });

    test(`in a ${where}, the card never calls the line destructive or says it deletes`, () => {
      for (const command of LINES) {
        const words = wordsOf(bash(command, where));
        assert.doesNotMatch(words, /delet|destructi/i, words);
      }
    });
  }
});

describe('the sequences around it', () => {
  for (const where of WHERE) {
    test(`in a ${where}: ls -la is still answered, and the qualifier line right after it is carded`, () => {
      assert.ok(ranWithNoCard(bash('ls -la', where)), 'the listing runs with no card');
      assertCardedAllowOrDeny(bash(LINE, where), where, LINE);
    });

    test(`in a ${where}: the card is denied, and the next listing still reads`, () => {
      const id = bash(LINE, where);
      press(id, 'deny');
      assert.ok(sent.some(m => m.requestId === id && m.allow === false), 'the deny is sent');
      assert.ok(ranWithNoCard(bash('ls notes', where)), 'and the listing after it runs with no card');
    });

    test(`in a ${where}: the same line sent twice is carded both times, with no Always allow either time`, () => {
      const first = bash(LINE, where);
      assertCardedAllowOrDeny(first, where, LINE);
      press(first, 'allow');
      const again = bash(LINE, where);
      assertCardedAllowOrDeny(again, where, LINE);
      assert.strictEqual(wordsOf(again), wordsOf(bash(LINE, where)), 'the retry reads the same as a first asking');
    });

    test(`in a ${where}: a wildcard listing and a search still read, and a saved Bash:npm still covers npm test`, () => {
      for (const command of ['ls *.md', 'rg TODO notes/*.md']) assert.ok(ranWithNoCard(bash(command, where)), command);
      chat.setStandingToolAllows(['Bash:ls', 'Bash:npm']);
      assert.ok(ranWithNoCard(bash('npm test', where)), 'npm test runs under its saved answer');
    });
  }
});
