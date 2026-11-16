'use strict';
// WHAT A PERSON SEES for an agent's `sort` or `date`, through the real card
// code under jsdom: the view's own request handlers, the card they draw, and
// the buttons on it.
//
// A reading form runs with no card, in a conversation and in a routine, and
// the writing form beside it is carded. What the person answers on that card
// does not change how the next command is judged.
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
  chat.setStandingToolAllows([]);
});

let seq = 0;
const ROUTINE_RUN = { id: 'run-1', routine: 'Tidy notes', agent: 'assistant' };
// The envelope the server sends: a conversation's request names it, a
// routine's names none and carries its run.
function ask(toolName, input, where) {
  const id = `sort-date-card-${++seq}`;
  const d = { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: toolName, input } };
  if (where === 'routine') chat.handleOwnerlessPermissionRequest({ ...d, _conversationId: '', _run: ROUTINE_RUN });
  else chat.handlePermissionRequest({ ...d, _conversationId: 'c1' }, 'c1');
  return id;
}
const bash = (command, where) => ask('Bash', { command }, where);
const cardOf = (id) => document.getElementById(`perm-${id}`);
const press = (id, action) => cardOf(id).querySelector(`[data-perm-action="${action}"]`).click();
// The words a person reads on a card, without its request id.
const wordsOf = (id) => cardOf(id).querySelector('.permission-card').textContent.replace(/\s+/g, ' ').trim();
const ranWithNoCard = (id) => !cardOf(id) && sent.some(m => m.type === 'permission_response' && m.requestId === id && m.allow === true);

const WHERE = ['conversation', 'routine'];

// A NOTES-MODE WRITE OF A NOTE, as the card code has always judged one, and as
// it judges one on main: a card that offers Allow, Always allow and Deny, with
// nothing answered on the person's behalf.
const NOTE_WRITE = { file_path: 'notes/yesterday.md', content: '- one\n- two\n' };
function assertNoteWriteCarded(id, where) {
  const card = cardOf(id);
  assert.ok(card, `the Write of a note is carded in a ${where}`);
  assert.deepStrictEqual([...card.querySelectorAll('[data-perm-action]')].map(b => b.dataset.permAction), ['allow', 'always', 'deny'],
    'with Allow, Always allow and Deny');
  assert.match(wordsOf(id), /Create a file notes\/yesterday\.md/, 'naming the file');
  assert.ok(!sent.some(m => m.requestId === id), 'and nothing is answered on the person\'s behalf');
}

// Each writing form beside the reading twin that differs from it only by the
// option that writes, runs a program or sets the clock.
const PAIRS = [
  ['sort -o notes.md notes.md', 'sort notes.md'],
  ['sort --output=x y', 'sort --unique y'],
  ['sort -uo out in', 'sort -u in'],
  ['sort -rno out in', 'sort -rn in'],
  ['sort -T /tmp x', 'sort -t , x'],
  ['sort --compress-program=sh x', 'sort --debug x'],
  ['ls notes | sort -o listing.txt', 'ls notes | sort'],
  ['date -s "2026-01-01"', 'date -u'],
  ['date --set=2026-01-01', 'date --date=2026-01-01'],
  ['date 010112002026', 'date +%Y-%m-%d'],
  ['date -f %Y%m%d 20260101', 'date -j -f %Y%m%d 20260101'],
  ['date -n', 'date -R'],
];
const WRITING = 'sort -o notes.md notes.md';
// The listing the routines that stalled ran: a pipe into sort, then the date.
const LISTING = "ls -la && echo \"---\" && find . -type f -not -path './.git/*' | sort && echo \"---\" && date";

describe('a reading sort or date runs with no card, and its writing twin is carded', () => {
  for (const where of WHERE) {
    test(`in a ${where}`, () => {
      for (const [writes, reads] of PAIRS) {
        const w = bash(writes, where);
        assert.ok(cardOf(w) && cardOf(w).querySelector('[data-perm-action="allow"]'), `not carded in a ${where}: ${writes}`);
        assert.ok(!sent.some(m => m.requestId === w), `answered on the person's behalf: ${writes}`);
        const r = bash(reads, where);
        assert.ok(ranWithNoCard(r), `carded in a ${where}: ${reads}`);
      }
    });
  }
});

describe('what the person answers does not carry over', () => {
  for (const where of WHERE) {
    test(`in a ${where}: after a deny on a writing sort, the next listing piped to sort runs with no card`, () => {
      const w = bash(WRITING, where);
      assert.ok(cardOf(w), 'the writing sort is carded');
      press(w, 'deny');
      assert.ok(sent.some(m => m.requestId === w && m.allow === false), 'the deny is sent');
      const listing = bash('ls notes | sort', where);
      assert.ok(ranWithNoCard(listing), 'and the listing after it runs with no card');
    });

    test(`in a ${where}: the same writing form sent again is carded again, in the same words`, () => {
      const first = bash(WRITING, where);
      press(first, 'deny');
      const again = bash(WRITING, where);
      assert.ok(cardOf(again) && cardOf(again).querySelector('[data-perm-action="allow"]'), 'carded again, and answerable');
      const fresh = bash(WRITING, where);
      assert.strictEqual(wordsOf(again), wordsOf(fresh), 'the retry reads the same as a first asking');
    });

    test(`in a ${where}: the listing, then cat of the note it found, then a Write of the cleaned note`, () => {
      assert.ok(ranWithNoCard(bash(LISTING, where)), 'the listing runs with no card');
      assert.ok(ranWithNoCard(bash('cat notes/yesterday.md', where)), 'and so does the cat');
      // The Write is judged as any Notes-mode write of a note is.
      assertNoteWriteCarded(ask('Write', NOTE_WRITE, where), where);
    });

    test(`in a ${where}: a Write of a note on its own gets that verdict`, () => {
      assertNoteWriteCarded(ask('Write', NOTE_WRITE, where), where);
    });
  }
});

describe('a failure forced inside the reading of sort and date cards, and never allows', () => {
  const seam = require('../../public/read-only-shell.js').optionReadingSeam;
  for (const where of WHERE) {
    test(`in a ${where}`, () => {
      const kept = seam.beforeReading;
      seam.beforeReading = () => { throw new Error('forced failure'); };
      let id;
      try { id = bash('ls notes | sort', where); } finally { seam.beforeReading = kept; }
      assert.ok(cardOf(id), `a reading sort is carded while the reading fails, in a ${where}`);
      assert.ok(!sent.some(m => m.requestId === id), 'and nothing is answered on the person\'s behalf');
      assert.ok(ranWithNoCard(bash('ls notes | sort', where)), 'with the reading back, it runs with no card again');
    });
  }
});
