'use strict';
// The composer's attached files: the + button, its picker, a chip per file in
// a row above the field, and one inline message under it.
//
// The page here is the shipped composer markup cut out of public/index.html,
// styled by the shipped public/styles/views/chat.css, running the shipped
// public/views/composer.js and public/attachment-wording.js with the cut
// setupChat and switchComposerTo from public/views/conversations.js. Files
// reach the picker as the browser hands them over: on the input's `files`,
// with a `change` event its inline handler takes. A renamed or missing piece
// fails here by name.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

// A stretch of shipped source from one anchor to another, the second
// included when `through` is set.
function between(src, from, to, label, through = false) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the page no longer carries ${label}`);
  return src.slice(start, through ? end + to.length : end);
}

const COMPOSER = path.join(ROOT, 'public', 'views', 'composer.js');
const INDEX = read('public', 'index.html');
const CONVERSATIONS = read('public', 'views', 'conversations.js');
const APP = read('public', 'app.js');
const CSS = read('public', 'styles', 'views', 'chat.css');

const AGENTS = [
  { id: 'lead', displayName: 'Lead', colour: '#000', icon: 'L', runtime: 'claude' },
  { id: 'helper', displayName: 'Helper', colour: '#000', icon: 'H' },
  { id: 'coder', displayName: 'Coder', colour: '#000', icon: 'C', runtime: 'codex' },
];

// A window holding the composer, with conversation `c1` on screen.
function page({ agentId = 'lead', activeAgentId = null } = {}) {
  assert.ok(fs.existsSync(COMPOSER), 'the page no longer carries public/views/composer.js');
  const markup = between(INDEX, '<div class="chat-input">', '\n      </div>', 'the composer markup');
  assert.ok(markup.includes('id="attach-btn"'), 'the composer no longer carries the + button');
  const dom = new JSDOM(`<!doctype html><html><head><style>${CSS}</style></head><body>
    <input id="chat-title-input"><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>
    <div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>
    ${markup}</div></body></html>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`var agents = ${JSON.stringify(AGENTS)}; var activeConversation = null; var convoState = {};
    function getConvoState(id) { return convoState[id] || (convoState[id] = { isProcessing: false, activeAgentId: null }); }
    function sendMessage() {} function cancelProcessing() {}
    function makeConvo(id, agentId) { return { id, agentId, agent: agents.find(a => a.id === agentId), title: id, status: 'active', messages: [] }; }`);
  w.eval(read('public', 'attachment-wording.js'));
  w.eval(fs.readFileSync(COMPOSER, 'utf-8'));
  w.eval(`${between(CONVERSATIONS, 'const composerDrafts = new Map();', '\nfunction renameConversation(', 'setupChat')}
    window.__open = (c) => { activeConversation = c; setupChat(c); };`);
  const header = between(APP, "'update-chat-header': (convoId, ef) => {", '\n  },', 'the delegation header effect', true);
  w.eval(`window.__header = ${header.slice(header.indexOf('(convoId'), -1)};`);
  const convos = {};
  const open = (id, agent = agentId, active = null) => {
    convos[id] = convos[id] || w.makeConvo(id, agent);
    if (active) w.getConvoState(id).activeAgentId = active;
    w.__open(convos[id]);
  };
  open('c1', agentId, activeAgentId);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const chips = () => [...doc.querySelectorAll('#composer-chips .composer-chip')];
  const removeButtons = () => [...doc.querySelectorAll('#composer-chips .composer-chip-remove')];
  const notice = () => {
    const box = $('composer-notice');
    const title = box.querySelector('strong');
    return title ? { title: title.textContent, text: title.nextElementSibling.textContent } : null;
  };
  return { w, doc, $, open, chips, removeButtons, notice, file: (name, size = 10) => new w.File([new Uint8Array(size)], name) };
}

// The browser handing the picker its chosen files.
function pick(p, files) {
  const input = p.$('attach-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new p.w.Event('change'));
}

const chipText = (chip) => ({
  name: chip.querySelector('.composer-chip-name').textContent,
  meta: chip.querySelector('.composer-chip-meta').textContent,
});
const follows = (p, a, b) => !!(a.compareDocumentPosition(b) & p.w.Node.DOCUMENT_POSITION_FOLLOWING);

describe('the + button and its picker', () => {
  test('the + button sits before the field, is labelled Attach files and opens a hidden picker of several files', () => {
    const p = page();
    const button = p.$('attach-btn');
    const input = p.$('attach-input');
    assert.strictEqual(button.getAttribute('aria-label'), 'Attach files');
    assert.strictEqual(button.getAttribute('title'), 'Attach files');
    assert.ok(follows(p, button, p.$('msg-input')), 'the button comes before the field');
    assert.strictEqual(input.type, 'file');
    assert.ok(input.multiple && input.hidden);
    let opened = 0;
    input.click = () => { opened += 1; };
    button.click();
    assert.strictEqual(opened, 1, 'the button opens the picker');
  });

  test('the picker offers the agreed types', () => {
    assert.strictEqual(page().$('attach-input').getAttribute('accept'),
      'image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv');
  });
});

describe('a chip per picked file', () => {
  test('each file picked becomes a chip with its name, then its type and size', () => {
    const p = page();
    pick(p, [p.file('Screen Shot.png', 820000), p.file('notes.md', 1200), p.file('photo.JPEG', 2000)]);
    assert.deepStrictEqual(p.chips().map(chipText), [
      { name: 'Screen Shot.png', meta: 'PNG · 820 KB' },
      { name: 'notes.md', meta: 'Markdown · 2 KB' },
      { name: 'photo.JPEG', meta: 'JPEG · 2 KB' },
    ]);
    assert.ok(follows(p, p.$('composer-chips'), p.$('msg-input')), 'the chip row sits above the field');
  });

  test('a chip\'s type is read from its extension with case ignored, and any other extension is File', () => {
    const types = (names) => {
      const p = page();
      pick(p, names.map((n) => p.file(n)));
      return p.chips().map((c) => chipText(c).meta.split(' · ')[0]);
    };
    assert.deepStrictEqual(types(['a.jpg', 'b.GIF', 'c.webp', 'd.PDF', 'e.txt']), ['JPEG', 'GIF', 'WebP', 'PDF', 'Text']);
    assert.deepStrictEqual(types(['f.csv', 'g.zip', 'noextension']), ['CSV', 'File', 'File']);
  });

  test('each chip has a remove button named for its file, with a target of at least 24 by 24 px', () => {
    const p = page();
    pick(p, [p.file('Screen Shot.png')]);
    const [remove] = p.removeButtons();
    assert.strictEqual(remove.getAttribute('aria-label'), 'Remove Screen Shot.png');
    assert.strictEqual(remove.type, 'button');
    const style = p.w.getComputedStyle(remove);
    assert.ok(parseFloat(style.width) >= 24 && parseFloat(style.height) >= 24, `${style.width} by ${style.height}`);
    assert.notStrictEqual(style.display, 'none');
  });

  test('the chip row is at most two chip lines high and scrolls beyond that', () => {
    const p = page();
    pick(p, [p.file('a.txt')]);
    const row = p.w.getComputedStyle(p.$('composer-chips'));
    const chipHeight = parseFloat(p.w.getComputedStyle(p.chips()[0]).height);
    assert.strictEqual(row.overflowY, 'auto');
    assert.strictEqual(parseFloat(row.maxHeight), 2 * chipHeight + parseFloat(row.rowGap));
  });
});

describe('removing a chip moves focus to what is left', () => {
  const three = () => {
    const p = page();
    pick(p, [p.file('a.txt'), p.file('b.txt'), p.file('c.txt')]);
    return p;
  };
  const names = (p) => p.chips().map((c) => chipText(c).name);

  test('after a removal, focus moves to the next chip\'s remove button', () => {
    const p = three();
    p.removeButtons()[1].click();
    assert.deepStrictEqual(names(p), ['a.txt', 'c.txt']);
    assert.strictEqual(p.doc.activeElement.getAttribute('aria-label'), 'Remove c.txt');
  });

  test('after removing the last chip, focus moves to the previous chip\'s remove button', () => {
    const p = three();
    p.removeButtons()[2].click();
    assert.deepStrictEqual(names(p), ['a.txt', 'b.txt']);
    assert.strictEqual(p.doc.activeElement.getAttribute('aria-label'), 'Remove b.txt');
  });

  test('after removing the only chip, focus moves to the field', () => {
    const p = page();
    pick(p, [p.file('a.txt')]);
    p.removeButtons()[0].click();
    assert.strictEqual(p.chips().length, 0);
    assert.strictEqual(p.doc.activeElement, p.$('msg-input'));
  });
});

describe('a pick over the limits is refused whole', () => {
  test('4 chips and a pick of 2 adds nothing and says it would make 6 files', () => {
    const p = page();
    pick(p, ['a', 'b', 'c', 'd'].map((n) => p.file(`${n}.txt`)));
    pick(p, [p.file('e.txt'), p.file('f.txt')]);
    assert.deepStrictEqual(p.chips().map((c) => chipText(c).name), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    assert.deepStrictEqual(p.notice(), { title: '2 files not added', text: 'That would make 6 files; the limit is 5 per message' });
  });

  test('5 chips and one more file names that file in the title', () => {
    const p = page();
    pick(p, ['a', 'b', 'c', 'd', 'e'].map((n) => p.file(`${n}.png`)));
    pick(p, [p.file('a.txt')]);
    assert.strictEqual(p.chips().length, 5);
    assert.deepStrictEqual(p.notice(), { title: 'a.txt', text: 'That would make 6 files; the limit is 5 per message' });
  });

  test('chips of 19,000,000 bytes and a pick of two files of 600,000 adds nothing and says it would make 21 MB', () => {
    const p = page();
    pick(p, [p.file('a.pdf', 9500000), p.file('b.pdf', 9500000)]);
    pick(p, [p.file('e.pdf', 600000), p.file('f.pdf', 600000)]);
    assert.strictEqual(p.chips().length, 2);
    assert.deepStrictEqual(p.notice(), { title: '2 files not added', text: 'That would make 21 MB; the limit is 20 MB per message' });
  });

  test('exactly 5 files are added', () => {
    const p = page();
    pick(p, ['a', 'b', 'c'].map((n) => p.file(`${n}.txt`)));
    pick(p, [p.file('d.txt'), p.file('e.txt')]);
    assert.strictEqual(p.chips().length, 5);
    assert.strictEqual(p.notice(), null);
  });

  test('exactly 20,000,000 bytes are added', () => {
    const p = page();
    pick(p, [p.file('a.pdf', 10000000)]);
    pick(p, [p.file('b.pdf', 10000000)]);
    assert.strictEqual(p.chips().length, 2);
    assert.strictEqual(p.notice(), null);
  });
});

describe('the inline message', () => {
  const refused = () => {
    const p = page();
    pick(p, ['a', 'b', 'c', 'd', 'e'].map((n) => p.file(`${n}.txt`)));
    return p;
  };

  test('it sits under the field, announced politely, as a bold title above the text with a Dismiss button', () => {
    const p = refused();
    pick(p, [p.file('f.txt')]);
    const box = p.$('composer-notice');
    assert.strictEqual(box.getAttribute('aria-live'), 'polite');
    assert.ok(follows(p, p.$('msg-input'), box), 'the message sits under the field');
    const title = box.querySelector('strong');
    assert.ok(title && follows(p, title, title.nextElementSibling));
    assert.strictEqual(box.querySelectorAll('button[aria-label="Dismiss"]').length, 1);
  });

  test('it never takes focus', () => {
    const p = refused();
    p.$('msg-input').focus();
    pick(p, [p.file('f.txt')]);
    assert.ok(p.notice());
    assert.strictEqual(p.doc.activeElement, p.$('msg-input'));
  });

  test('one shows at a time, a new one replacing the last', () => {
    const p = refused();
    pick(p, [p.file('f.txt')]);
    pick(p, [p.file('g.txt'), p.file('h.txt')]);
    assert.strictEqual(p.$('composer-notice').querySelectorAll('strong').length, 1);
    assert.strictEqual(p.notice().title, '2 files not added');
  });

  test('it goes on Dismiss', () => {
    const p = refused();
    pick(p, [p.file('f.txt')]);
    p.$('composer-notice').querySelector('button[aria-label="Dismiss"]').click();
    assert.strictEqual(p.notice(), null);
    assert.strictEqual(p.chips().length, 5, 'the chips stay');
  });

  test('it goes on the next pick that adds a chip', () => {
    const p = page();
    pick(p, ['a', 'b', 'c', 'd'].map((n) => p.file(`${n}.txt`)));
    pick(p, [p.file('e.txt'), p.file('f.txt')]);
    assert.ok(p.notice());
    pick(p, [p.file('e.txt')]);
    assert.strictEqual(p.notice(), null);
    assert.strictEqual(p.chips().length, 5);
  });

  test('it goes on a remove', () => {
    const p = refused();
    pick(p, [p.file('f.txt')]);
    p.removeButtons()[0].click();
    assert.strictEqual(p.notice(), null);
  });
});

describe('each conversation keeps its own chips', () => {
  test('chips added in one conversation are gone in another and come back on returning', () => {
    const p = page();
    pick(p, [p.file('a.txt'), p.file('b.txt')]);
    p.open('c2');
    assert.strictEqual(p.chips().length, 0);
    pick(p, [p.file('c.txt')]);
    p.open('c1');
    assert.deepStrictEqual(p.chips().map((c) => chipText(c).name), ['a.txt', 'b.txt']);
    p.open('c2');
    assert.deepStrictEqual(p.chips().map((c) => chipText(c).name), ['c.txt']);
  });

  test('a conversation\'s inline message stays with it', () => {
    const p = page();
    pick(p, ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => p.file(`${n}.txt`)));
    p.open('c2');
    assert.strictEqual(p.notice(), null);
    p.open('c1');
    assert.strictEqual(p.notice().title, '6 files not added');
  });
});

describe('the + button and an agent on Codex', () => {
  const shown = (p) => !p.$('attach-btn').hidden && p.w.getComputedStyle(p.$('attach-btn')).display !== 'none';

  test('the + button is shown while the conversation\'s agent runs on Codex', () => {
    assert.strictEqual(shown(page({ agentId: 'coder' })), true);
    assert.strictEqual(shown(page({ agentId: 'lead' })), true);
    assert.strictEqual(shown(page({ agentId: 'helper' })), true, 'an agent with no runtime named');
  });

  test('the + button is shown whether the active agent or the conversation\'s own runs on Codex', () => {
    assert.strictEqual(shown(page({ agentId: 'lead', activeAgentId: 'coder' })), true);
    assert.strictEqual(shown(page({ agentId: 'coder', activeAgentId: 'lead' })), true);
  });

  test('the + button stays shown when control passes to an agent not on Codex, and when it passes to one', () => {
    const p = page({ agentId: 'lead', activeAgentId: 'coder' });
    p.w.getConvoState('c1').activeAgentId = 'lead';
    p.w.__header('c1', { toAgentId: 'lead' });
    assert.strictEqual(shown(p), true);
    p.w.getConvoState('c1').activeAgentId = 'coder';
    p.w.__header('c1', { toAgentId: 'coder' });
    assert.strictEqual(shown(p), true);
  });

  test('opening another conversation, and coming back to one whose agent runs on Codex, shows the button', () => {
    const p = page({ agentId: 'coder' });
    p.open('c2', 'lead');
    assert.strictEqual(shown(p), true);
    p.open('c1');
    assert.strictEqual(shown(p), true);
  });
});

describe('a file name is text', () => {
  test('a file named as markup creates no element and shows as its name', () => {
    const p = page();
    const name = '<img src=x onerror=alert(1)>.png';
    pick(p, ['a', 'b', 'c', 'd'].map((n) => p.file(`${n}.txt`)).concat(p.file(name)));
    pick(p, [p.file(name)]);
    assert.strictEqual(p.doc.querySelectorAll('img').length, 0);
    assert.strictEqual(chipText(p.chips()[4]).name, name);
    assert.strictEqual(p.removeButtons()[4].getAttribute('aria-label'), `Remove ${name}`);
    assert.strictEqual(p.notice().title, name);
  });
});

// After a reload the history decides which agent the conversation is pointed
// at, after setupChat has drawn it, so the button follows that decision too.
// Run on the shipped renderSessionHistory with the composer module as the
// other view tests load it.
describe('the + button after the history arrives', () => {
  let chat, convo;
  before(() => {
    assert.ok(fs.existsSync(COMPOSER), 'the page no longer carries public/views/composer.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><button id="attach-btn"></button>'
      + '<textarea id="msg-input"></textarea><button id="send-btn"></button><span id="chat-agent-label"></span>'
      + '<span id="chat-agent-avatar"></span></body></html>');
    const states = {};
    Object.assign(global, {
      window: dom.window, document: dom.window.document, agents: AGENTS, esc: (t) => String(t), formatMd: (t) => String(t),
      userScrolledUp: false, getConvoState: (id) => states[id] || (states[id] = { isProcessing: false, activeAgentId: null }),
      renderConvoList: () => {}, tryMessageAnchor: () => {}, persistLastActiveConversation: () => {}, pendingMessageAnchor: null,
      createHistoryDivider: () => null, renderPendingPermissionCards: () => {},
      RundockChatMarkup: require(path.join(ROOT, 'public', 'chat-markup.js')),
      stripRundockMarkers: (t) => require(path.join(ROOT, 'public', 'markers.js')).stripMarkers(String(t || '')),
      restoredActiveAgentId: require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId,
    });
    dom.window.Element.prototype.scrollIntoView = function () {};
    chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
    Object.assign(global, chat, require(COMPOSER));
  });
  const arrives = (fields) => {
    convo = { id: 'h1', agentId: 'lead', agent: AGENTS[0], messages: [], ...fields };
    global.conversations = [convo];
    global.activeConversation = convo;
    document.getElementById('attach-btn').hidden = !!fields.wasHidden;
    chat.renderSessionHistory({ conversationId: 'h1', messages: [], hasMore: false, totalCount: 0 });
    return document.getElementById('attach-btn').hidden;
  };

  test('a history that points the conversation at an agent on Codex shows the + button', () => {
    assert.strictEqual(arrives({ activeAgentId: 'coder' }), false);
  });

  test('a history that hands the conversation back to its own agent, on Codex, shows it again', () => {
    assert.strictEqual(arrives({ agentId: 'coder', activeAgentId: 'lead', delegationReturned: true, wasHidden: true }), false);
  });
});
