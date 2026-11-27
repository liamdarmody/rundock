'use strict';
// Adding files to the composer: a pick, a paste and a drop, each file checked
// on its own as it is added, and the messages that say why one wasn't.
//
// The page here is the shipped conversation view cut out of public/index.html,
// styled by the shipped public/styles/views/chat.css, beside a sidebar and a
// board standing in for the rest of the window. It runs the shipped
// public/views/chat.js, conversations.js and composer.js whole, with the
// shipped attachment modules and, cut out of public/app.js, the escaping
// helpers and the message field's listeners. A file holds bytes the detector
// takes as the type its name says (test/helpers/attachment-bytes.js) unless a
// test gives its bytes, and an add is awaited until it has settled. A renamed
// or missing piece fails here by name.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { typed, png, ftyp, pdf, ascii } = require('../helpers/attachment-bytes.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { receiveAttachments } = require('../../lib/attachments/receive.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const SNIFF = path.join(ROOT, 'public', 'attachment-sniff.js');

// A stretch of shipped source from one anchor to another, the second
// included when `through` is set.
function between(src, from, to, label, through = false) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the page no longer carries ${label}`);
  return src.slice(start, through ? end + to.length : end);
}

const INDEX = read('public', 'index.html');
const APP = read('public', 'app.js');
const CSS = read('public', 'styles', 'views', 'chat.css');

const UNSUPPORTED = 'Rundock can attach images (PNG, JPEG, GIF, WebP), PDF, text, Markdown and CSV files';
const HEIC = 'Rundock can\'t attach HEIC photos. Save it as JPEG or PNG first.';
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'mif1'];

const AGENTS = [
  { id: 'lead', displayName: 'Lead', colour: '#000', icon: 'L', runtime: 'claude', status: 'onTeam', type: 'specialist' },
  { id: 'helper', displayName: 'Helper', colour: '#000', icon: 'H', status: 'onTeam', type: 'specialist' },
  { id: 'coder', displayName: 'Coder', colour: '#000', icon: 'C', runtime: 'codex', status: 'onTeam', type: 'specialist' },
];

const opened = [];
afterEach(() => { while (opened.length) opened.pop().w.close(); });

// A window holding the conversation view, with conversation `c1` on screen.
function page({ agentId = 'lead' } = {}) {
  const view = between(INDEX, '<div id="view-chat"', '\n    <!-- Skills -->', 'the conversation view');
  assert.ok(view.includes('id="attach-btn"'), 'the composer no longer carries the + button');
  const dom = new JSDOM(`<!doctype html><html><head><style>${CSS}</style></head><body>
    <aside class="sidebar" id="sidebar"><div id="convo-list"></div></aside>
    <main>${view}<div id="board"></div></main></body></html>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`var agents = ${JSON.stringify(AGENTS)}; var conversations = []; var activeConversation = null; var convoState = {};
    function getConvoState(id) { return convoState[id] || (convoState[id] = { isProcessing: false, activeAgentId: null }); }
    var workingConvos = new Set(); var userScrolledUp = false; var activeSidebarPill = 'all'; var conversationsLoaded = true;
    var currentView = 'chat'; var agentLastActivity = {};
    var unread = { ids: () => [], isUnread: () => false, markMessage() {} };
    function updateWorkingBadge() {} function updateUnreadBadge() {} function formatTimeAgo() { return 'now'; }
    function renderPendingPermissionCards() {} function switchNav() {} function showView() {}
    function renameConversation() {} function toggleConvoStatus() {}
    var ws = { readyState: 1, sent: [], send(raw) { this.sent.push(raw); } };
    ${between(APP, 'function esc(t){', '\nfunction stripRundockMarkers', 'the escaping helpers')}`);
  for (const lib of ['markers.js', 'chat-markup.js', 'conversation-state.js', 'conversation-list.js', 'attachment-wording.js']) w.eval(read('public', lib));
  // Guarded, so a tree without the detector fails on needs() below.
  if (fs.existsSync(SNIFF)) w.eval(fs.readFileSync(SNIFF, 'utf-8'));
  for (const v of ['chat.js', 'conversations.js', 'composer.js']) w.eval(read('public', 'views', v));
  // The last pick's add, for `pick` to wait on.
  let lastAdd = Promise.resolve();
  const pickFiles = w.pickFiles;
  w.pickFiles = (input) => (lastAdd = Promise.resolve(pickFiles(input)));
  w.renderPendingPermissionCards = () => {};
  w.eval(between(APP, "const msgInput = document.getElementById('msg-input');", '\n// Enter submits', 'the message field\'s listeners'));
  w.eval(`function __open(id, agentId) {
      let c = conversations.find(x => x.id === id);
      if (!c) {
        c = { id, agentId, agent: agents.find(a => a.id === agentId), title: id, messages: [], status: 'active', createdAt: '2026-01-01T00:00:00.000Z' };
        conversations.push(c);
      }
      activeConversation = c; setupChat(c); return c;
    }`);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const p = {
    w, doc, $,
    open: (id, agent = agentId) => w.__open(id, agent),
    chips: () => [...doc.querySelectorAll('#composer-chips .composer-chip')].map((c) => c.querySelector('.composer-chip-name').textContent),
    notices: () => [...$('composer-notice').querySelectorAll('strong.composer-notice-title')]
      .map((t) => ({ title: t.textContent, text: t.nextElementSibling.textContent })),
    // A file of `size` bytes the detector takes as its name's type, or
    // holding exactly `bytes` when an array is given.
    file: (name, sizeOrBytes = 10) => new w.File([Array.isArray(sizeOrBytes) ? Uint8Array.from(sizeOrBytes) : typed(name, sizeOrBytes)], name),
    added: () => lastAdd,
  };
  p.open('c1');
  opened.push(p);
  return p;
}

// What the base lacks, asserted before a test relies on it: the detector in
// the window and the composer's own exports.
function needs(p, ...exports) {
  let sniff = null;
  try { sniff = require(SNIFF); } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;
  }
  assert.ok(sniff && typeof sniff.detectBytes === 'function' && typeof sniff.checkFile === 'function' && sniff.LIMITS,
    'public/attachment-sniff.js loads and exports detectBytes, checkFile and LIMITS');
  for (const name of ['addFiles', ...exports]) assert.strictEqual(typeof p.w[name], 'function', `the composer exports ${name}`);
}

// The browser handing the picker its chosen files.
async function pick(p, ...files) {
  const input = p.$('attach-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new p.w.Event('change'));
  await p.added();
}

function type(p, text) {
  p.$('msg-input').value = text;
  p.$('msg-input').dispatchEvent(new p.w.Event('input'));
}

// A file whose read waits until `release` is called.
function heldRead(p, name) {
  const file = p.file(name);
  const read = file.arrayBuffer.bind(file);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  file.arrayBuffer = () => gate.then(read);
  return { file, release };
}

function pressEnter(p) {
  p.$('msg-input').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

async function until(check, label) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const ZIP = [0x50, 0x4b, 3, 4, 20, 0, 0, 0];

describe('one add, checked in order', () => {
  test('4 files held and an add of 2, one a zip, is refused whole on the count', async () => {
    const p = page();
    needs(p);
    await pick(p, ...['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((n) => p.file(n)));
    await pick(p, p.file('e.txt'), p.file('f.zip', [0x50, 0x4b, 3, 4, 0, 0]));
    assert.deepStrictEqual(p.chips(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    assert.deepStrictEqual(p.notices(), [{ title: '2 files not added', text: 'That would make 6 files; the limit is 5 per message' }]);
  });

  test('5 files held and an add of one is refused under that file\'s name', async () => {
    const p = page();
    needs(p);
    await pick(p, ...['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((n) => p.file(n)));
    await pick(p, p.file('a.txt'));
    assert.strictEqual(p.chips().length, 5);
    assert.deepStrictEqual(p.notices(), [{ title: 'a.txt', text: 'That would make 6 files; the limit is 5 per message' }]);
  });

  test('19,000,000 bytes held and two 600,000-byte PDFs are refused whole on the total', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.pdf', 9500000), p.file('b.pdf', 9500000));
    await pick(p, p.file('c.pdf', 600000), p.file('d.pdf', 600000));
    assert.deepStrictEqual(p.chips(), ['a.pdf', 'b.pdf']);
    assert.deepStrictEqual(p.notices(), [{ title: '2 files not added', text: 'That would make 21 MB; the limit is 20 MB per message' }]);
  });

  test('the same add with a HEIC photo among them gives its own message, then the total\'s', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.pdf', 9500000), p.file('b.pdf', 9500000));
    await pick(p, p.file('c.pdf', 600000), p.file('photo.heic', ftyp('heic')), p.file('d.pdf', 600000));
    assert.deepStrictEqual(p.chips(), ['a.pdf', 'b.pdf']);
    assert.deepStrictEqual(p.notices(), [
      { title: 'photo.heic', text: HEIC },
      { title: '2 files not added', text: 'That would make 21 MB; the limit is 20 MB per message' },
    ]);
  });

  test('exactly 5 files of exactly 20,000,000 bytes are added', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.pdf', 10000000), p.file('b.pdf', 9999997), p.file('c.txt', 1), p.file('d.txt', 1), p.file('e.txt', 1));
    assert.deepStrictEqual(p.chips(), ['a.pdf', 'b.pdf', 'c.txt', 'd.txt', 'e.txt']);
    assert.deepStrictEqual(p.notices(), []);
  });

  test('a PDF of 10,000,000 bytes and a text file of 1,000,000 bytes, each at its limit, are added with no message', async () => {
    const p = page();
    await pick(p, p.file('a.pdf', 10000000), p.file('b.txt', 1000000));
    assert.deepStrictEqual(p.chips(), ['a.pdf', 'b.txt']);
    assert.deepStrictEqual(p.notices(), []);
  });

  test('an add refused on the count is taken once a file is removed to make room', async () => {
    const p = page();
    needs(p);
    await pick(p, ...['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((n) => p.file(n)));
    const extra = p.file('f.txt');
    await pick(p, extra);
    assert.strictEqual(p.notices().length, 1, 'refused on the count');
    p.doc.querySelector('#composer-chips .composer-chip-remove').click();
    await pick(p, extra);
    assert.deepStrictEqual(p.chips(), ['b.md', 'c.md', 'd.md', 'e.md', 'f.txt']);
    assert.deepStrictEqual(p.notices(), []);
  });
});

describe('an add belongs to the conversation it began in', () => {
  test('an add begun in c1 that settles after c2 is shown adds to c1 only', async () => {
    const p = page();
    needs(p);
    const { file, release } = heldRead(p, 'a.txt');
    const input = p.$('attach-input');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
    const adding = p.added();
    p.open('c2');
    release();
    await adding;
    assert.deepStrictEqual(p.chips(), [], 'nothing lands in c2');
    p.open('c1');
    assert.deepStrictEqual(p.chips(), ['a.txt']);
  });

  test('an add that settles after the workspace changed adds nothing', async () => {
    const p = page();
    needs(p);
    const { file, release } = heldRead(p, 'a.txt');
    const input = p.$('attach-input');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
    const adding = p.added();
    p.w.composersWorkspaceChanged();
    release();
    await adding;
    p.open('c1');
    assert.deepStrictEqual(p.chips(), []);
    assert.deepStrictEqual(p.notices(), []);
  });

  test('Send is not ready while an add runs', async () => {
    const p = page();
    needs(p);
    type(p, 'see this');
    assert.ok(p.$('send-btn').classList.contains('active'), 'text alone lights Send');
    const { file, release } = heldRead(p, 'a.txt');
    const input = p.$('attach-input');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
    const adding = p.added();
    assert.strictEqual(p.w.sendReady('see this'), false);
    assert.ok(!p.$('send-btn').classList.contains('active'), 'Send is off while the file is read');
    release();
    await adding;
    assert.strictEqual(p.w.sendReady('see this'), true);
    assert.ok(p.$('send-btn').classList.contains('active'));
  });

  test('the picker\'s value is cleared before the add reads a file', async () => {
    const p = page();
    const file = p.file('a.txt');
    const seen = [];
    const readBytes = file.arrayBuffer.bind(file);
    // A browser empties the picker's files when its value is cleared.
    let files = [file];
    const input = { get files() { return files; }, get value() { return files.length ? 'a.txt' : ''; }, set value(v) { if (v === '') files = []; } };
    file.arrayBuffer = () => { seen.push(input.value); return readBytes(); };
    await Promise.resolve(p.w.pickFiles(input));
    assert.strictEqual(input.value, '');
    assert.deepStrictEqual(p.chips(), ['a.txt'], 'the files are taken before the value is cleared');
    assert.ok(seen.every((v) => v === ''), `the value at each read: ${JSON.stringify(seen)}`);
  });
});

describe('a file Rundock can\'t take is refused on its own', () => {
  // One add of one file, which is refused under its name and makes no chip.
  async function refused(p, file) {
    needs(p);
    await pick(p, file);
    assert.deepStrictEqual(p.chips(), [], 'a refused file makes no chip');
    const shown = p.notices();
    assert.strictEqual(shown.length, 1, 'one message');
    assert.strictEqual(shown[0].title, file.name);
    return shown[0].text;
  }

  test('a PDF of 14,000,000 bytes', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('big.pdf', 14000000)), 'This file is 14 MB; the limit is 10 MB per file');
  });

  test('a PDF one byte over 10,000,000', async () => {
    const p = page();
    // Sizes from 10 MB up are worded in whole megabytes, rounded up.
    assert.strictEqual(await refused(p, p.file('big.pdf', 10000001)), 'This file is 11 MB; the limit is 10 MB per file');
  });

  test('a Markdown file of 1,400,000 bytes', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('notes.md', 1400000)), 'This file is 1.4 MB; the limit is 1 MB per text file');
  });

  test('a CSV file one byte over 1,000,000', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('table.csv', 1000001)), 'This file is 1.1 MB; the limit is 1 MB per text file');
  });

  test('a QuickTime file', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('clip.mov', ftyp('qt  '))), UNSUPPORTED);
  });

  test('a text file holding a NUL', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('notes.txt', [...ascii('ab'), 0, ...ascii('cd')])), UNSUPPORTED);
  });

  test('a text file that isn\'t UTF-8', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('notes.txt', [...ascii('caf'), 0xe9, ...ascii(' au lait')])), UNSUPPORTED);
  });

  test('a zip file', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('bundle.zip', [0x50, 0x4b, 3, 4, 20, 0, 0, 0])), UNSUPPORTED);
  });

  test('a PNG cut short in its header', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('cut.png', png(2, 2).slice(0, 14))), UNSUPPORTED);
  });

  test('a file whose read fails is refused as unsupported', async () => {
    const p = page();
    const file = p.file('a.png');
    file.arrayBuffer = () => Promise.reject(new Error('the read failed'));
    assert.strictEqual(await refused(p, file), UNSUPPORTED);
  });

  for (const brand of HEIC_BRANDS) {
    test(`a HEIC photo whose ftyp box names ${brand}`, async () => {
      const p = page();
      assert.strictEqual(await refused(p, p.file('photo.heic', ftyp(brand))), HEIC);
    });
  }

  test('photo.png holding HEIC bytes is refused as HEIC', async () => {
    const p = page();
    assert.strictEqual(await refused(p, p.file('photo.png', ftyp('heic'))), HEIC);
  });

  test('an add of a PNG, a HEIC photo and a PDF adds the PNG and the PDF with one message', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.png'), p.file('b.heic', ftyp('mif1')), p.file('c.pdf', pdf()));
    assert.deepStrictEqual(p.chips(), ['a.png', 'c.pdf']);
    assert.deepStrictEqual(p.notices(), [{ title: 'b.heic', text: HEIC }]);
  });

  test('the same refused file added again is refused again in the same words', async () => {
    const p = page();
    needs(p);
    const file = p.file('photo.heic', ftyp('hevc'));
    await pick(p, file);
    await pick(p, file);
    assert.deepStrictEqual(p.notices(), [{ title: 'photo.heic', text: HEIC }, { title: 'photo.heic', text: HEIC }]);
    assert.deepStrictEqual(p.chips(), []);
  });
});

describe('the messages stack, each until it is dealt with', () => {
  // Adds in turn, each refused: a HEIC photo, a zip, then a QuickTime file.
  async function refusedInTurn(p, n) {
    const files = [p.file('photo.heic', ftyp('heic')), p.file('bundle.zip', ZIP), p.file('clip.mov', ftyp('qt  '))];
    for (const file of files.slice(0, n)) await pick(p, file);
  }
  const dismissals = (p) => [...p.doc.querySelectorAll('#composer-notice .composer-notice-dismiss')];
  const titles = (p) => p.notices().map((n) => n.title);
  // Five held and two adds of one more, each refused on the count, which the
  // base words as it is worded here.
  async function fullThenRefused(p) {
    await pick(p, ...['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((n) => p.file(n)));
    await pick(p, p.file('f.txt'));
    await pick(p, p.file('g.txt'));
    assert.ok(p.notices().length >= 1, 'a message shows');
  }

  test('two refused adds in turn give two messages, oldest first', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 2);
    assert.deepStrictEqual(p.notices(), [{ title: 'photo.heic', text: HEIC }, { title: 'bundle.zip', text: UNSUPPORTED }]);
    const box = p.$('composer-notice');
    assert.strictEqual(box.getAttribute('aria-live'), 'polite');
    assert.strictEqual(box.children.length, 2);
    for (const item of box.children) {
      assert.ok(item.matches('div.composer-notice-item'), item.className);
      assert.strictEqual(item.children.length, 3);
      const [icon, body, dismiss] = item.children;
      assert.ok(icon.matches('span.composer-notice-icon'), icon.className);
      assert.strictEqual(icon.getAttribute('aria-hidden'), 'true');
      assert.ok(body.matches('div.composer-notice-body'), body.className);
      assert.deepStrictEqual([...body.children].map((c) => `${c.tagName}.${c.className}`), ['STRONG.composer-notice-title', 'DIV.composer-notice-text']);
      assert.ok(dismiss.matches('button.composer-notice-dismiss'), dismiss.className);
      assert.strictEqual(dismiss.getAttribute('type'), 'button');
      assert.strictEqual(dismiss.getAttribute('aria-label'), 'Dismiss');
      const style = p.w.getComputedStyle(dismiss);
      assert.deepStrictEqual([style.width, style.height], ['22px', '22px']);
    }
  });

  test('an add that attaches clears both and shows its own', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 2);
    await pick(p, p.file('a.png'), p.file('clip.mov', ftyp('qt  ')));
    assert.deepStrictEqual(p.chips(), ['a.png']);
    assert.deepStrictEqual(p.notices(), [{ title: 'clip.mov', text: UNSUPPORTED }]);
  });

  test('a remove clears them', async () => {
    const p = page();
    await fullThenRefused(p);
    p.doc.querySelector('#composer-chips .composer-chip-remove').click();
    assert.strictEqual(p.$('composer-notice').children.length, 0);
  });

  test('a send clears them', async () => {
    const p = page();
    await fullThenRefused(p);
    type(p, 'these five');
    pressEnter(p);
    assert.strictEqual(p.$('composer-notice').children.length, 0);
  });

  test('a server refusal after two messages leaves only its own', async () => {
    const p = page();
    needs(p);
    await pick(p, p.file('a.png'));
    await refusedInTurn(p, 2);
    assert.strictEqual(p.notices().length, 2);
    type(p, 'see this');
    pressEnter(p);
    await until(() => p.w.ws.sent.some((raw) => raw.startsWith('{"type":"chat"')), 'the chat frame');
    p.w.fileSendAnswered({ type: 'chat_refused', conversationId: 'c1', code: 'disk-full', title: 'Not sent', text: 'The disk is full' });
    assert.deepStrictEqual(p.notices(), [{ title: 'Not sent', text: 'The disk is full' }]);
    assert.deepStrictEqual(p.chips(), ['a.png'], 'the files stay');
  });

  test('Dismiss on the first of three leaves two and puts focus on the next Dismiss', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 3);
    dismissals(p)[0].click();
    assert.deepStrictEqual(titles(p), ['bundle.zip', 'clip.mov']);
    assert.strictEqual(p.doc.activeElement, dismissals(p)[0]);
  });

  test('Dismiss on the middle of three puts focus on the next Dismiss', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 3);
    dismissals(p)[1].click();
    assert.deepStrictEqual(titles(p), ['photo.heic', 'clip.mov']);
    assert.strictEqual(p.doc.activeElement, dismissals(p)[1]);
  });

  test('Dismiss on the last puts focus on the one before', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 3);
    dismissals(p)[2].click();
    assert.deepStrictEqual(titles(p), ['photo.heic', 'bundle.zip']);
    assert.strictEqual(p.doc.activeElement, dismissals(p)[1]);
  });

  test('Dismiss on the only one puts focus on the field', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 1);
    dismissals(p)[0].click();
    assert.deepStrictEqual(p.notices(), []);
    assert.strictEqual(p.doc.activeElement, p.$('msg-input'));
  });

  test('an add with the field focused leaves focus there', async () => {
    const p = page();
    p.$('msg-input').focus();
    await pick(p, p.file('a.txt'), p.file('photo.heic', ftyp('heic')));
    assert.strictEqual(p.doc.activeElement, p.$('msg-input'), 'after an add that attaches');
    await pick(p, ...['b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'].map((n) => p.file(n)));
    assert.ok(p.notices().length >= 1, 'a message shows');
    assert.strictEqual(p.doc.activeElement, p.$('msg-input'), 'after an add refused');
  });

  test('a message that stays keeps its element across a draw', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 1);
    const box = p.$('composer-notice');
    const first = box.firstElementChild;
    const removed = [];
    const watch = new p.w.MutationObserver((records) => records.forEach((r) => removed.push(...r.removedNodes)));
    watch.observe(box, { childList: true });
    await pick(p, p.file('bundle.zip', ZIP));
    await pick(p, p.file('clip.mov', ftyp('qt  ')));
    dismissals(p)[1].click();
    removed.push(...watch.takeRecords().flatMap((r) => [...r.removedNodes]));
    watch.disconnect();
    assert.deepStrictEqual(titles(p), ['photo.heic', 'clip.mov']);
    assert.strictEqual(box.firstElementChild, first, 'the same element');
    assert.ok(!removed.includes(first), 'its element was never taken out, so it is announced once');
  });

  test('messages kept in c1 while c2 is shown', async () => {
    const p = page();
    needs(p);
    await refusedInTurn(p, 2);
    p.open('c2');
    assert.deepStrictEqual(p.notices(), [], 'c2 shows none of c1\'s');
    await pick(p, p.file('clip.mov', ftyp('qt  ')));
    p.open('c1');
    assert.deepStrictEqual(titles(p), ['photo.heic', 'bundle.zip']);
    p.open('c2');
    assert.deepStrictEqual(titles(p), ['clip.mov']);
  });
});

describe('a paste adds its files, and a pasted image is named', () => {
  // A screen capture as the clipboard holds one.
  const capture = (p) => new p.w.File([typed('image.png', 10)], 'image.png', { type: 'image/png' });
  const removes = (p) => [...p.doc.querySelectorAll('#composer-chips .composer-chip-remove')].map((b) => b.getAttribute('aria-label'));
  const removeNamed = (p, name) => p.doc.querySelector(`#composer-chips .composer-chip-remove[aria-label="Remove ${name}"]`).click();
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  // The browser pasting into the field: `files` on the clipboard, with `text`
  // beside them when given. Returns the event, to read its default.
  function paste(p, files, text = '') {
    const event = new p.w.Event('paste', { bubbles: true, cancelable: true });
    const types = (files.length ? ['Files'] : []).concat(text ? ['text/plain'] : []);
    Object.defineProperty(event, 'clipboardData', { value: { files, types, getData: (type) => (type === 'text/plain' ? text : '') } });
    p.$('msg-input').dispatchEvent(event);
    return event;
  }
  async function pasted(p, files, count) {
    paste(p, files);
    await until(() => p.chips().length === count, `${count} chips`);
  }

  test('two pastes of a PNG give "Pasted image" and "Pasted image 2"', async () => {
    const p = page();
    needs(p);
    await pasted(p, [capture(p)], 1);
    await pasted(p, [capture(p)], 2);
    assert.deepStrictEqual(p.chips(), ['Pasted image', 'Pasted image 2']);
    assert.deepStrictEqual(removes(p), ['Remove Pasted image', 'Remove Pasted image 2']);
  });

  test('one paste of two PNGs gives the same two names', async () => {
    const p = page();
    needs(p);
    await pasted(p, [capture(p), capture(p)], 2);
    assert.deepStrictEqual(p.chips(), ['Pasted image', 'Pasted image 2']);
    assert.deepStrictEqual(removes(p), ['Remove Pasted image', 'Remove Pasted image 2']);
  });

  test('after "Pasted image 2" is removed from three, the next is "Pasted image 4"', async () => {
    const p = page();
    needs(p);
    await pasted(p, [capture(p), capture(p), capture(p)], 3);
    removeNamed(p, 'Pasted image 2');
    assert.deepStrictEqual(p.chips(), ['Pasted image', 'Pasted image 3']);
    await pasted(p, [capture(p)], 3);
    assert.deepStrictEqual(p.chips(), ['Pasted image', 'Pasted image 3', 'Pasted image 4']);
  });

  test('after all are removed, the next is "Pasted image"', async () => {
    const p = page();
    needs(p);
    await pasted(p, [capture(p), capture(p)], 2);
    removeNamed(p, 'Pasted image');
    removeNamed(p, 'Pasted image 2');
    assert.deepStrictEqual(p.chips(), []);
    await pasted(p, [capture(p)], 1);
    assert.deepStrictEqual(p.chips(), ['Pasted image']);
  });

  test('a pasted PDF keeps its name', async () => {
    const p = page();
    needs(p);
    await pasted(p, [p.file('report.pdf')], 1);
    assert.deepStrictEqual(p.chips(), ['report.pdf']);
    assert.deepStrictEqual(removes(p), ['Remove report.pdf']);
  });

  test('a pasted text file and a capture: the capture is named, the text file is not', async () => {
    const p = page();
    needs(p);
    await pasted(p, [p.file('notes.txt'), capture(p)], 2);
    assert.deepStrictEqual(p.chips(), ['notes.txt', 'Pasted image']);
  });

  test('a paste of text alone adds nothing and leaves its default', async () => {
    const p = page();
    const event = paste(p, [], 'a line of text');
    assert.strictEqual(event.defaultPrevented, false);
    await settled();
    assert.deepStrictEqual(p.chips(), []);
    assert.strictEqual(p.$('composer-notice').children.length, 0);
  });

  test('a paste of a PNG with text leaves its default', async () => {
    const p = page();
    needs(p);
    const event = paste(p, [capture(p)], 'a line of text');
    assert.strictEqual(event.defaultPrevented, false);
    await until(() => p.chips().length === 1, 'the pasted image');
    assert.deepStrictEqual(p.chips(), ['Pasted image']);
  });

  test('a pasted HEIC file is refused under its own name', async () => {
    const p = page();
    needs(p);
    paste(p, [p.file('IMG_0001.heic', ftyp('heic'))]);
    await until(() => p.notices().length === 1, 'the message');
    assert.deepStrictEqual(p.notices(), [{ title: 'IMG_0001.heic', text: HEIC }]);
    assert.deepStrictEqual(p.chips(), []);
  });

  test('a capture pasted, a line typed and Enter pressed is stored as 1-Pasted_image.png', async () => {
    const p = page();
    needs(p);
    await pasted(p, [capture(p)], 1);
    type(p, 'what is wrong here?');
    pressEnter(p);
    await until(() => p.w.ws.sent.some((raw) => raw.startsWith('{"type":"chat"')), 'the chat frame');
    const frame = JSON.parse(p.w.ws.sent.find((raw) => raw.startsWith('{"type":"chat"')));
    assert.deepStrictEqual(frame.attachments.map((a) => a.name), ['Pasted image']);
    const workspace = fs.realpathSync(makeTempDir('attach-add-'));
    const { content, entry } = await receiveAttachments(workspace, frame);
    assert.deepStrictEqual(entry.files.map((f) => [f.file, f.name, f.type]), [['1-Pasted_image.png', 'Pasted image', 'png']]);
    assert.ok(fs.existsSync(path.join(workspace, '.rundock', 'attachments', 'c1', '1-Pasted_image.png')));
    assert.ok(content.startsWith('what is wrong here?\n[Attached: .rundock/attachments/c1/1-Pasted_image.png (PNG image'), content);
  });
});
